/**
 * @license
 * Copyright 2026 zCrxticxl
 * SPDX-License-Identifier: Apache-2.0
 */

/** @fileoverview Detects stalled Twitch players and alerts the user. */
(function () {
  'use strict';

  var g = typeof globalThis !== 'undefined' ? globalThis : self;
  g.ADT = g.ADT || {};
  var api = g.ADT.api;
  var log = g.ADT.log;

  /** @const {string} */
  var RT_KEY = 'watchHealthRuntime';
  /** @const {string} */
  var NOTIFICATION_PREFIX = 'adt-watch-health:';

  /** @return {!Promise<!Object>} */
  function loadRt() {
    return Promise.resolve(api.storage.local.get(RT_KEY)).then(function (res) {
      var rt = (res && res[RT_KEY]) || {};
      rt.tabs = rt.tabs || {};
      return rt;
    });
  }

  /** @param {!Object} rt @return {!Promise<void>} */
  function saveRt(rt) {
    var out = {};
    out[RT_KEY] = rt;
    return Promise.resolve(api.storage.local.set(out));
  }

  /** @param {number} tabId @return {string} */
  function notificationId(tabId) {
    return NOTIFICATION_PREFIX + tabId;
  }

  /** @param {number} tabId */
  function clearNotification(tabId) {
    if (!api.notifications || !api.notifications.clear) return;
    try {
      Promise.resolve(api.notifications.clear(notificationId(tabId))).catch(function () {});
    } catch (e) {}
  }

  /**
   * @param {number} tabId
   * @param {string} channel
   * @param {string} reason
   */
  function notify(tabId, channel, reason) {
    if (!api.notifications || !api.notifications.create) return;
    var bodyKey = reason === 'discarded'
      ? 'notifyWatchDiscardedBody'
      : 'notifyWatchStaleBody';
    try {
      Promise.resolve(api.notifications.create(notificationId(tabId), {
        type: 'basic',
        iconUrl: api.runtime.getURL('icons/icon128.png'),
        title: g.ADT.msg('notifyWatchStaleTitle'),
        message: g.ADT.msg(bodyKey, channel || 'Twitch')
      })).catch(function (e) {
        log.warn('watch-health notification: ' + (e && e.message));
      });
    } catch (e) {
      log.warn('watch-health notification: ' + (e && e.message));
    }
  }

  /**
   * @param {!Object} report
   * @param {number} tabId
   * @return {!Promise<void>}
   */
  function handleHeartbeat(report, tabId) {
    if (tabId == null) return Promise.resolve();
    return g.ADT.settings.get().then(function (s) {
      if (!s.enabled || !s.watchHealth.enabled) return forgetTab(tabId);
      var now = Date.now();
      return loadRt().then(function (rt) {
        var key = String(tabId);
        var item = rt.tabs[key] || {
          firstSeenAt: now,
          lastProgressAt: now,
          notified: false
        };
        item.channel = String(report.channel || '').slice(0, 80);
        item.lastHeartbeatAt = now;
        item.playing = !!report.playing;
        if (report.advancing) {
          item.lastProgressAt = now;
          if (item.notified) clearNotification(tabId);
          item.notified = false;
          item.recoveryAttempted = false;
          item.reason = '';
        }
        rt.tabs[key] = item;

        var keep = Promise.resolve();
        if (s.watchHealth.keepAwake) {
          try {
            keep = Promise.resolve(api.tabs.update(tabId, { autoDiscardable: false }))
              .catch(function () {});
          } catch (e) {
            // Firefox versions without this tab flag still keep the watchdog.
          }
        }
        return keep.then(function () { return saveRt(rt); });
      });
    }).catch(function (e) {
      log.warn('watch-health heartbeat: ' + (e && e.message));
    });
  }

  /** @param {number} tabId @return {!Promise<*>} */
  function forgetTab(tabId) {
    return loadRt().then(function (rt) {
      if (!rt.tabs[String(tabId)]) return null;
      delete rt.tabs[String(tabId)];
      clearNotification(tabId);
      return saveRt(rt);
    });
  }

  /** @return {!Promise<void>} */
  function check() {
    return Promise.all([g.ADT.settings.get(), loadRt()]).then(function (values) {
      var s = values[0];
      var rt = values[1];
      if (!s.enabled || !s.watchHealth.enabled) return;

      var now = Date.now();
      var staleMs = Math.max(2, s.watchHealth.staleAfterMin || 5) * 60000;
      var chain = Promise.resolve();

      Object.keys(rt.tabs).forEach(function (key) {
        chain = chain.then(function () {
          var tabId = Number(key);
          var item = rt.tabs[key];
          return Promise.resolve(api.tabs.get(tabId)).then(function (tab) {
            var reason = '';
            if (tab.discarded || tab.frozen) reason = 'discarded';
            else if (now - Number(item.lastHeartbeatAt || 0) > staleMs) reason = 'stale';
            else if (now - Number(item.lastProgressAt || 0) > staleMs) reason = 'stalled';

            if (!reason) {
              if (item.notified) clearNotification(tabId);
              item.notified = false;
              item.recoveryAttempted = false;
              item.reason = '';
              return;
            }
            item.reason = reason;
            if (!item.notified && s.watchHealth.notifications) {
              item.notified = true;
              notify(tabId, item.channel, reason);
              log.warn('watch-health: ' + (item.channel || tabId) + ' ' + reason);
            }

            if (!item.recoveryAttempted && s.watchHealth.recoverTab && api.tabs.reload) {
              item.recoveryAttempted = true;
              return Promise.resolve(api.tabs.reload(tabId)).catch(function () {});
            }
          }).catch(function () {
            delete rt.tabs[key];
            clearNotification(tabId);
          });
        });
      });

      return chain.then(function () { return saveRt(rt); });
    }).catch(function (e) {
      log.warn('watch-health check: ' + (e && e.message));
    });
  }

  if (api.notifications && api.notifications.onClicked) {
    api.notifications.onClicked.addListener(function (id) {
      if (id.indexOf(NOTIFICATION_PREFIX) !== 0) return;
      var tabId = Number(id.slice(NOTIFICATION_PREFIX.length));
      if (!Number.isInteger(tabId)) return;
      Promise.resolve(api.tabs.update(tabId, { active: true })).catch(function () {});
    });
  }

  g.ADT.watchHealth = {
    handleHeartbeat: handleHeartbeat,
    forgetTab: forgetTab,
    check: check,
    loadRt: loadRt,
    saveRt: saveRt
  };
})();
