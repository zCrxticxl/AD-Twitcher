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

      var keep = Promise.resolve();
      if (s.watchHealth.keepAwake) {
        try {
          keep = Promise.resolve(api.tabs.update(tabId, { autoDiscardable: false }))
            .catch(function () {});
        } catch (e) {
          // Firefox versions without this tab flag still keep the watchdog.
        }
      }

      return keep.then(function () {
        return g.ADT.updateLocal(RT_KEY, function (rt) {
          rt.tabs = rt.tabs || {};
          var key = String(tabId);
          var item = rt.tabs[key] || {
            firstSeenAt: now,
            lastProgressAt: now,
            notified: false
          };
          item.channel = String(report.channel || '').slice(0, 80);
          item.lastHeartbeatAt = now;
          item.playing = !!report.playing;
          item.userPaused = !!report.userPaused;
          if (report.advancing) {
            item.lastProgressAt = now;
            if (item.notified) clearNotification(tabId);
            item.notified = false;
            item.recoveryAttempted = false;
            item.reason = '';
          }
          rt.tabs[key] = item;
          return rt;
        });
      });
    }).catch(function (e) {
      log.warn('watch-health heartbeat: ' + (e && e.message));
    });
  }

  /** @param {number} tabId @return {!Promise<*>} */
  function forgetTab(tabId) {
    return g.ADT.updateLocal(RT_KEY, function (rt) {
      rt.tabs = rt.tabs || {};
      if (!rt.tabs[String(tabId)]) return undefined;
      delete rt.tabs[String(tabId)];
      clearNotification(tabId);
      return rt;
    }).catch(function (e) {
      // Called from tab teardown, where nothing is waiting on the result.
      log.warn('watch-health forget: ' + (e && e.message));
    });
  }

  /** @return {!Promise<void>} */
  function check() {
    return g.ADT.settings.get().then(function (s) {
      if (!s.enabled || !s.watchHealth.enabled) return undefined;

      /*
       * Read, decide and write are one serialized step. Read separately, a
       * heartbeat arriving mid-pass is read by nobody and then overwritten by
       * this pass's older view of the same tab - so a stream that is playing
       * perfectly well looks stalled, gets a notification, and is reloaded
       * under the user.
       */
      return g.ADT.updateLocal(RT_KEY, function (rt) {
        rt.tabs = rt.tabs || {};
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
              /*
               * A player the user paused is idle, not broken, so it gets no
               * notification and no reload. Only the progress reason is waived:
               * a tab that stopped reporting altogether, or that the browser
               * discarded, is still a fault whatever the player was doing.
               */
              else if (!item.userPaused &&
                  now - Number(item.lastProgressAt || 0) > staleMs) reason = 'stalled';

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

        return chain.then(function () { return rt; });
      });
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

  /**
   * The watchdog already knows which tabs are alive; this exposes it so the
   * popup can show that watching is actually happening rather than leaving the
   * user to guess from a counter that only moves once an hour.
   *
   * @return {!Promise<!Array<!Object>>} Watched tabs, most recent heartbeat
   *     first.
   */
  function status() {
    return loadRt().then(function (rt) {
      return Object.keys(rt.tabs).map(function (key) {
        var item = rt.tabs[key] || {};
        return {
          tabId: Number(key),
          channel: item.channel || '',
          playing: !!item.playing,
          reason: item.reason || '',
          since: Number(item.firstSeenAt || 0),
          lastProgressAt: Number(item.lastProgressAt || 0),
          lastHeartbeatAt: Number(item.lastHeartbeatAt || 0)
        };
      }).sort(function (a, b) {
        return b.lastHeartbeatAt - a.lastHeartbeatAt;
      });
    }).catch(function () {
      return [];
    });
  }

  g.ADT.watchHealth = {
    handleHeartbeat: handleHeartbeat,
    forgetTab: forgetTab,
    check: check,
    status: status,
    loadRt: loadRt
  };
})();
