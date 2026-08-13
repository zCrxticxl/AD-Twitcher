/**
 * @license
 * Copyright 2026 zCrxticxl
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * @fileoverview Background entry point.
 *
 * Chrome MV3 runs this as a service worker and pulls its dependencies in via
 * importScripts. Firefox MV2 runs it as a persistent background page, where the
 * manifest already lists the files in the right order, so the import is skipped.
 */
(function () {
  'use strict';

  var g = typeof globalThis !== 'undefined' ? globalThis : self;

  if (typeof importScripts === 'function' && !g.ADT) {
    importScripts(
      '../lib/browser.js',
      '../lib/log.js',
      '../lib/storage.js',
      './live-watch.js');
  }

  var api = g.ADT.api;
  var log = g.ADT.log;

  /**
   * Tells storage.js that stat bumps may run here directly instead of being
   * delegated by message. Relevant on Firefox MV2, where the background page
   * also has a `window`.
   */
  g.ADT.isBackgroundPage = true;

  /** @const {string} */
  var ALARM_DROPS = 'adt-drops-check';

  /** @const {string} */
  var ALARM_HEALTH = 'adt-health';

  /** @const {string} */
  var ALARM_CLOSE_TAB_PREFIX = 'adt-close-tab:';

  /** @type {?string} */
  var lastConfigSig = null;

  /* ------------------------------------- injection into already open tabs */

  /**
   * On install, update and browser start, Twitch tabs that were already open
   * carry no content scripts: browsers only inject on navigation. Without this
   * the user would have to reload every tab by hand.
   *
   * @return {{js: !Array<string>, css: !Array<string>}}
   */
  function contentFiles() {
    var cs = (api.runtime.getManifest().content_scripts || [])[0] || {};
    return { js: cs.js || [], css: cs.css || [] };
  }

  /**
   * @param {number} tabId
   * @return {!Promise<*>}
   */
  function injectTab(tabId) {
    var f = contentFiles();

    if (api.scripting && api.scripting.executeScript) {
      // Chrome MV3. Sequential, so load order is guaranteed.
      var chain = Promise.resolve();
      if (f.css.length) {
        chain = chain.then(function () {
          return api.scripting.insertCSS({ target: { tabId: tabId }, files: f.css });
        });
      }
      f.js.forEach(function (file) {
        chain = chain.then(function () {
          return api.scripting.executeScript({ target: { tabId: tabId }, files: [file] });
        });
      });
      return chain;
    }

    // Firefox MV2.
    var mv2Chain = Promise.resolve();
    f.css.forEach(function (file) {
      mv2Chain = mv2Chain.then(function () {
        return api.tabs.insertCSS(tabId, { file: file });
      });
    });
    f.js.forEach(function (file) {
      mv2Chain = mv2Chain.then(function () {
        return api.tabs.executeScript(tabId, { file: file });
      });
    });
    return mv2Chain;
  }

  /**
   * Injects only where nothing answers the ping. Injecting twice would double
   * every listener and every interval.
   *
   * @return {!Promise<{injected: number, alive: number}>}
   */
  function injectIntoOpenTabs() {
    return Promise.resolve(api.tabs.query({ url: '*://*.twitch.tv/*' }))
      .then(function (tabs) {
        if (!tabs || !tabs.length) {
          log.debug('injection: no Twitch tabs open');
          return { injected: 0, alive: 0 };
        }
        var injected = 0;
        var alive = 0;
        var chain = Promise.resolve();

        tabs.forEach(function (t) {
          if (t.id == null) return;
          chain = chain.then(function () {
            return g.ADT.pingTab(t.id).then(function (res) {
              if (res) {
                alive++;
                return null;
              }
              return injectTab(t.id).then(function () {
                injected++;
                log.info('Content scripts injected into tab ' + t.id +
                  ' (' + (t.url || '') + ')');
              }).catch(function (e) {
                log.warn('Injection failed for tab ' + t.id + ': ' + (e && e.message));
              });
            });
          });
        });

        return chain.then(function () {
          log.info('injection: ' + injected + ' injected, ' + alive + ' already running');
          return { injected: injected, alive: alive };
        });
      })
      .catch(function (e) {
        log.error('injection: ' + (e && e.message));
        return { injected: 0, alive: 0, error: String(e && e.message) };
      });
  }

  /* ------------------------------------------ drops: inventory background tab */

  /** @return {!Promise<*>} */
  function runDropsCheck() {
    return g.ADT.settings.get().then(function (s) {
      if (!s.enabled || !s.drops.enabled || !s.drops.autoClaim) return null;
      if (!s.drops.openInventoryTab) return null;

      return Promise.resolve(api.tabs.query({
        url: ['*://*.twitch.tv/drops/inventory', '*://*.twitch.tv/drops/inventory?*']
      })).then(function (tabs) {
        if (tabs && tabs.length) {
          // Already open. Trigger a claim and leave the tab alone.
          log.debug('drops: inventory already open');
          return g.ADT.sendToTab(tabs[0].id, { type: 'adt:claim-drops-now' });
        }
        return Promise.resolve(api.tabs.create({
          url: 'https://www.twitch.tv/drops/inventory',
          active: false
        })).then(function (tab) {
          if (!tab || tab.id == null) return;
          Promise.resolve(api.tabs.update(tab.id, { muted: true })).catch(function () {});
          log.debug('drops: inventory tab opened (' + tab.id + ')');
          api.alarms.create(ALARM_CLOSE_TAB_PREFIX + tab.id, {
            when: Date.now() + Math.max(8000, s.drops.closeAfterMs)
          });
        });
      });
    }).catch(function (e) {
      log.error('drops-check: ' + (e && e.message));
    });
  }

  /**
   * @param {boolean=} force Rebuild the alarms even if the config is unchanged.
   * @return {!Promise<void>}
   */
  function syncAlarms(force) {
    return g.ADT.settings.get().then(function (s) {
      log.setLevel(s.logLevel);

      // Without the signature check every claimed bonus would rebuild the
      // alarms, which resets their interval.
      var sig = g.ADT.settings.configSig(s);
      if (!force && sig === lastConfigSig) return;
      lastConfigSig = sig;

      api.alarms.clear(ALARM_DROPS);
      if (s.enabled && s.drops.enabled && s.drops.autoClaim && s.drops.openInventoryTab) {
        // Safety net only. The real trigger is the adt:drop-unlocked message.
        api.alarms.create(ALARM_DROPS, {
          periodInMinutes: Math.max(15, s.drops.checkIntervalMin),
          delayInMinutes: 10
        });
      }

      api.alarms.create(ALARM_HEALTH, { periodInMinutes: 1 });
    });
  }

  api.alarms.onAlarm.addListener(function (alarm) {
    if (alarm.name === ALARM_DROPS) runDropsCheck();
    if (alarm.name.indexOf(ALARM_CLOSE_TAB_PREFIX) === 0) {
      var tabId = Number(alarm.name.slice(ALARM_CLOSE_TAB_PREFIX.length));
      if (Number.isInteger(tabId)) {
        Promise.resolve(api.tabs.remove(tabId)).catch(function () {});
      }
    }
    // ALARM_HEALTH exists to nudge the MV3 worker awake now and then.
  });

  /* ------------------------------------------------------------- messages */

  api.runtime.onMessage.addListener(function (msg, sender, sendResponse) {
    if (!msg || !msg.type) return;

    switch (msg.type) {
      case 'adt:live-report':
        g.ADT.liveWatch.handleReport(
          msg.live || [], msg.known || [], sender && sender.tab && sender.tab.id);
        sendResponse({ ok: true });
        return true;

      case 'adt:set-settings':
        if (!msg.patch || typeof msg.patch !== 'object' || Array.isArray(msg.patch)) {
          sendResponse({ ok: false, error: 'invalid patch' });
          return true;
        }
        g.ADT.settings.set(msg.patch).then(function (settings) {
          sendResponse({ ok: true, settings: settings });
        }).catch(function (e) {
          sendResponse({ ok: false, error: String(e && e.message) });
        });
        return true;

      case 'adt:reset-settings':
        g.ADT.settings.reset().then(function (settings) {
          sendResponse({ ok: true, settings: settings });
        }).catch(function (e) {
          sendResponse({ ok: false, error: String(e && e.message) });
        });
        return true;

      case 'adt:status':
        Promise.all([g.ADT.settings.get(), g.ADT.liveWatch.status()])
          .then(function (r) {
            sendResponse({ ok: true, settings: r[0], live: r[1] });
          });
        return true;  // Async response.

      case 'adt:drops-check-now':
        runDropsCheck().then(function () { sendResponse({ ok: true }); });
        return true;

      // Raised by the content script when Twitch shows the unlock notification.
      // This is the primary trigger; the alarm is only a fallback.
      case 'adt:drop-unlocked':
        log.info('Drop unlock reported: ' + (msg.text || ''));
        runDropsCheck();
        sendResponse({ ok: true });
        return true;

      case 'adt:settings-changed':
        syncAlarms(true).then(function () { sendResponse({ ok: true }); });
        return true;

      case 'adt:bump-stat':
        if (['pointsClaimed', 'dropsClaimed', 'adsMuted', 'streamsOpened'].indexOf(msg.key) < 0) {
          sendResponse({ ok: false, error: 'invalid counter' });
          return true;
        }
        g.ADT.settings.bumpStat(msg.key, msg.by || 1);
        sendResponse({ ok: true });
        return true;

      case 'adt:bg-log':
        sendResponse({ ok: true, lines: log.history().slice(-60) });
        return true;

      case 'adt:reinject':
        injectIntoOpenTabs().then(function (r) { sendResponse({ ok: true, result: r }); });
        return true;
    }
  });

  api.tabs.onRemoved.addListener(function (tabId) {
    g.ADT.liveWatch.forgetTab(tabId);
  });

  api.runtime.onInstalled.addListener(function (details) {
    log.info('AD-Twitcher installed or updated (' + details.reason + ')');
    syncAlarms(true).then(injectIntoOpenTabs);
  });

  if (api.runtime.onStartup) {
    api.runtime.onStartup.addListener(function () {
      syncAlarms(true).then(injectIntoOpenTabs);
    });
  }

  g.ADT.settings.onChange(function () { syncAlarms(); });

  syncAlarms(true).then(function () {
    log.info('AD-Twitcher background ready');
    // Also runs on a plain worker restart, where onInstalled does not fire.
    return injectIntoOpenTabs();
  });
})();
