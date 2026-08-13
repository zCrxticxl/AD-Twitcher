/**
 * @license
 * Copyright 2026 zCrxticxl
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * @fileoverview Background live watcher. Receives live reports scraped from the
 * sidebar by content scripts, reconciles them against the watchlist, and opens
 * or closes tabs.
 *
 * The MV3 service worker can be terminated at any moment, so all runtime state
 * lives in storage.local rather than in module variables.
 */
(function () {
  'use strict';

  var g = typeof globalThis !== 'undefined' ? globalThis : self;
  g.ADT = g.ADT || {};
  var api = g.ADT.api;
  var log = g.ADT.log;

  /** @const {string} */
  var RT_KEY = 'runtime';

  /** @const {number} A report older than this marks the watcher stale. */
  var STALE_AFTER_MS = 5 * 60000;

  /** @return {!Promise<!Object>} */
  function loadRt() {
    return Promise.resolve(api.storage.local.get(RT_KEY)).then(function (r) {
      var rt = (r && r[RT_KEY]) || {};
      rt.liveNow = rt.liveNow || [];
      rt.openedTabs = rt.openedTabs || {};   // login -> tabId
      rt.lastReportAt = rt.lastReportAt || 0;
      rt.knownCount = rt.knownCount || 0;
      rt.reports = rt.reports || {};
      return rt;
    });
  }

  /**
   * @param {!Object} rt
   * @return {!Promise<void>}
   */
  function saveRt(rt) {
    var o = {};
    o[RT_KEY] = rt;
    return Promise.resolve(api.storage.local.set(o));
  }

  /**
   * @param {string} login
   * @return {!Promise<?number>} Tab id, or null if the channel is not open.
   */
  function tabExistsForChannel(login) {
    return Promise.resolve(api.tabs.query({
      url: ['*://*.twitch.tv/' + login, '*://*.twitch.tv/' + login + '?*']
    })).then(function (tabs) {
      return tabs && tabs.length ? tabs[0].id : null;
    }).catch(function () {
      return null;
    });
  }

  /**
   * @param {string} login
   * @param {!Object} cfg settings.autoJoin
   * @return {!Promise<?number>} Tab id.
   */
  function openChannel(login, cfg) {
    return tabExistsForChannel(login).then(function (existing) {
      if (existing != null) {
        log.debug('autoJoin: ' + login + ' already open (tab ' + existing + ')');
        return existing;
      }
      return Promise.resolve(api.tabs.create({
        url: 'https://www.twitch.tv/' + login,
        active: !cfg.background
      })).then(function (tab) {
        if (cfg.muteOnOpen && tab && tab.id != null) {
          try {
            api.tabs.update(tab.id, { muted: true });
          } catch (e) {
            // Firefox rejects this on tabs that have no audio yet. Harmless.
          }
        }
        log.info('autoJoin: ' + login + ' went live, tab opened');
        g.ADT.settings.bumpStat('streamsOpened');   // Background context.
        return tab ? tab.id : null;
      });
    });
  }

  /**
   * @param {number} tabId
   * @return {!Promise<void>}
   */
  function closeTab(tabId) {
    return Promise.resolve(api.tabs.remove(tabId)).catch(function () {
      // Already closed by the user.
    });
  }

  /**
   * Core reconciliation.
   *
   * @param {!Array<string>} live Lowercase logins currently live.
   * @param {!Array<string>} known Lowercase logins visible in the sidebar.
   * @return {!Promise<void>}
   */
  function handleReport(live, known, tabId) {
    return g.ADT.settings.get().then(function (s) {
      if (!s.enabled || !s.autoJoin.enabled) return;

      var watch = (s.autoJoin.channels || []).map(function (c) {
        return String(c).trim().toLowerCase()
          .replace(/^https?:\/\/(www\.)?twitch\.tv\//, '');
      }).filter(Boolean);
      if (!watch.length) return;

      return loadRt().then(function (rt) {
        var now = Date.now();
        var reportKey = tabId == null ? 'unknown' : String(tabId);
        rt.reports[reportKey] = {
          live: live.map(String), known: known.map(String), at: now
        };
        Object.keys(rt.reports).forEach(function (key) {
          if (now - Number(rt.reports[key].at || 0) > STALE_AFTER_MS) delete rt.reports[key];
        });

        var liveSet = new Set();
        var knownSet = new Set();
        Object.keys(rt.reports).forEach(function (key) {
          (rt.reports[key].live || []).forEach(function (ch) { liveSet.add(ch); });
          (rt.reports[key].known || []).forEach(function (ch) { knownSet.add(ch); });
        });
        var prevLive = new Set(rt.liveNow);
        var chain = Promise.resolve();

        watch.forEach(function (ch) {
          var isLive = liveSet.has(ch);
          var wasLive = prevLive.has(ch);

          if (isLive && !wasLive) {
            chain = chain.then(function () {
              return openChannel(ch, s.autoJoin).then(function (tabId) {
                if (tabId != null) rt.openedTabs[ch] = tabId;
              });
            });
          }

          /*
           * Only treat absence as offline when the channel actually shows up in
           * the sidebar. Otherwise an unfollowed channel counts as permanently
           * offline.
           */
          if (!isLive && wasLive && knownSet.has(ch) &&
              s.autoJoin.closeWhenOffline && rt.openedTabs[ch] != null) {
            var id = rt.openedTabs[ch];
            delete rt.openedTabs[ch];
            chain = chain.then(function () {
              log.info('autoJoin: ' + ch + ' went offline, tab closed');
              return closeTab(id);
            });
          }
        });

        return chain.then(function () {
          rt.liveNow = Array.from(liveSet);
          rt.lastReportAt = now;
          rt.knownCount = knownSet.size;
          return saveRt(rt);
        });
      });
    }).catch(function (e) {
      log.error('live-watch: ' + (e && e.message));
    });
  }

  /**
   * Drops a tab we opened once the user closes it themselves.
   *
   * @param {number} tabId
   * @return {!Promise<*>}
   */
  function forgetTab(tabId) {
    return loadRt().then(function (rt) {
      var changed = false;
      if (rt.reports[String(tabId)]) {
        delete rt.reports[String(tabId)];
        changed = true;
      }
      Object.keys(rt.openedTabs).forEach(function (ch) {
        if (rt.openedTabs[ch] === tabId) {
          delete rt.openedTabs[ch];
          changed = true;
        }
      });
      return changed ? saveRt(rt) : null;
    });
  }

  /** @return {!Promise<!Object>} Popup-facing summary. */
  function status() {
    return loadRt().then(function (rt) {
      return {
        liveNow: rt.liveNow,
        watchedOpen: Object.keys(rt.openedTabs),
        lastReportAt: rt.lastReportAt,
        knownCount: rt.knownCount,
        stale: rt.lastReportAt ? (Date.now() - rt.lastReportAt) > STALE_AFTER_MS : true
      };
    });
  }

  g.ADT.liveWatch = {
    handleReport: handleReport,
    forgetTab: forgetTab,
    status: status,
    loadRt: loadRt,
    saveRt: saveRt
  };
})();
