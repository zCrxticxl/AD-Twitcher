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
      './live-watch.js',
      './watch-health.js');
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

  /**
   * A tab that was just reloaded is left alone this long. Comfortably above the
   * content script's notification debounce, so a toast that lingers on screen
   * cannot turn into a second reload.
   * @const {number}
   */
  var INVENTORY_RELOAD_COOLDOWN_MS = 180000;

  /** @const {number} Grid render time after a reload, before the claim nudge. */
  var INVENTORY_RENDER_MS = 4000;

  /**
   * Tab id to the last reload we triggered. In memory is enough here: this only
   * has to absorb a burst of unlock reports, which arrive minutes apart at
   * worst, and a worker restart costs one extra reload at most.
   * @type {!Object<number, number>}
   */
  var lastInventoryReload = {};

  /**
   * @param {number} tabId
   * @param {number=} timeoutMs
   * @return {!Promise<void>} Resolves when the tab finished loading, or on
   *     timeout. The content script claims on its own once it comes up, so a
   *     missed resolution costs nothing.
   */
  function waitForTabLoad(tabId, timeoutMs) {
    return new Promise(function (resolve) {
      var done = false;

      function finish() {
        if (done) return;
        done = true;
        try {
          api.tabs.onUpdated.removeListener(onUpdated);
        } catch (e) {
          // Listener was never attached.
        }
        resolve();
      }

      function onUpdated(id, changeInfo) {
        if (id === tabId && changeInfo && changeInfo.status === 'complete') finish();
      }

      try {
        api.tabs.onUpdated.addListener(onUpdated);
      } catch (e) {
        finish();
        return;
      }
      setTimeout(finish, timeoutMs || 30000);
    });
  }

  /**
   * @param {number} tabId
   * @return {!Promise<?Object>} The content script's claim report.
   */
  function claimInTab(tabId) {
    return g.ADT.sendToTab(tabId, { type: 'adt:claim-drops-now' });
  }

  /**
   * The inventory page is rendered from data Twitch fetched while it loaded and
   * is never refetched. An open tab therefore shows the drop state of its load
   * time, so a drop that finished afterwards has no claim button in that DOM.
   * Scanning harder cannot fix that; only a reload can.
   *
   * @param {number} tabId
   * @return {!Promise<string>} The activity outcome.
   */
  function refreshInventoryTab(tabId) {
    var now = Date.now();
    if (now - (lastInventoryReload[tabId] || 0) < INVENTORY_RELOAD_COOLDOWN_MS) {
      log.debug('drops: inventory reload suppressed by cooldown');
      return Promise.resolve('idle');
    }
    lastInventoryReload[tabId] = now;
    log.info('drops: inventory view predates the drop, reloading tab ' + tabId);

    return Promise.resolve(api.tabs.reload(tabId))
      .then(function () { return waitForTabLoad(tabId); })
      .then(function () { return g.ADT.sleep(INVENTORY_RENDER_MS); })
      .then(function () { return claimInTab(tabId); })
      .then(function () { return 'reloaded'; })
      .catch(function (e) {
        log.warn('drops: inventory reload failed: ' + (e && e.message));
        return 'error';
      });
  }

  /**
   * @param {!Object} tab An open /drops/inventory tab.
   * @param {!Object} s Settings.
   * @return {!Promise<string>} The activity outcome.
   */
  function claimInOpenInventory(tab, s) {
    return claimInTab(tab.id).then(function (res) {
      var report = res && res.report;
      if (report && report.pending) {
        log.info('drops: ' + report.pending + ' claim(s) running in tab ' + tab.id);
        return 'claimed';
      }
      if (!s.drops.refreshInventory) {
        log.debug('drops: nothing to claim, refresh disabled');
        return 'idle';
      }
      // A view younger than the drop has genuinely nothing to claim. Anything
      // older cannot be trusted to know about it yet.
      if (report && report.stale === false) {
        log.debug('drops: inventory is current, nothing to claim');
        return 'idle';
      }
      return refreshInventoryTab(tab.id);
    });
  }

  /**
   * @param {!Object} s Settings.
   * @return {!Promise<string>} The activity outcome.
   */
  function openInventoryTab(s) {
    return Promise.resolve(api.tabs.create({
      url: 'https://www.twitch.tv/drops/inventory',
      active: false
    })).then(function (tab) {
      if (!tab || tab.id == null) return 'error';
      Promise.resolve(api.tabs.update(tab.id, { muted: true })).catch(function () {});
      log.debug('drops: inventory tab opened (' + tab.id + ')');
      api.alarms.create(ALARM_CLOSE_TAB_PREFIX + tab.id, {
        when: Date.now() + Math.max(8000, s.drops.closeAfterMs)
      });
      return 'opened';
    });
  }

  /* ------------------------------------------------------ activity record */

  /*
   * Everything below exists for one reason: from the outside, an extension that
   * works perfectly and one that died three hours ago look exactly the same.
   * Counters only move when something is actually claimed, which can be hours
   * apart, so they prove nothing in between. The record here says when the last
   * check ran and what came of it.
   *
   * It lives in storage because the worker that ran the check is usually gone
   * by the time the popup asks.
   */

  /** @const {string} */
  var ACTIVITY_KEY = 'activityRuntime';

  /**
   * @param {string} outcome 'claimed', 'reloaded', 'opened', 'idle', 'off' or
   *     'error'. The popup maps these to localized text.
   * @param {string} trigger 'alarm', 'unlock' or 'popup'.
   * @return {!Promise<void>}
   */
  function noteDropsCheck(outcome, trigger) {
    var out = {};
    out[ACTIVITY_KEY] = {
      lastCheckAt: Date.now(),
      outcome: outcome,
      trigger: trigger
    };
    return Promise.resolve(api.storage.local.set(out)).catch(function () {});
  }

  /** @return {!Promise<!Object>} */
  function loadActivity() {
    return Promise.resolve(api.storage.local.get(ACTIVITY_KEY)).then(function (res) {
      return (res && res[ACTIVITY_KEY]) || {};
    }).catch(function () {
      return {};
    });
  }

  /** @return {!Promise<number>} When the drops alarm fires next, 0 if unknown. */
  function nextDropsCheckAt() {
    if (!api.alarms || !api.alarms.get) return Promise.resolve(0);
    return Promise.resolve(api.alarms.get(ALARM_DROPS)).then(function (alarm) {
      return (alarm && alarm.scheduledTime) || 0;
    }).catch(function () {
      return 0;
    });
  }

  /** @const {string} Latest progress snapshot scraped off the inventory page. */
  var PROGRESS_KEY = 'dropsProgress';

  /** @const {number} */
  var MAX_PROGRESS_ITEMS = 8;

  /**
   * Takes what the inventory page showed and keeps it until a newer reading
   * arrives. The page is usually closed by the time the popup is opened, so a
   * stored snapshot with a timestamp is the only way to answer "how much
   * longer" at all.
   *
   * @param {*} items Untrusted: this comes from a content script.
   * @return {!Promise<void>}
   */
  function storeProgress(items) {
    if (!Array.isArray(items)) return Promise.resolve();

    var clean = items.filter(function (item) {
      return item && typeof item.percent === 'number' &&
        isFinite(item.percent) && item.percent >= 0 && item.percent <= 100;
    }).slice(0, MAX_PROGRESS_ITEMS).map(function (item) {
      var hours = Number(item.hours);
      return {
        name: String(item.name || '').slice(0, 60),
        percent: Math.round(item.percent * 10) / 10,
        hours: isFinite(hours) && hours > 0 ? hours : 0
      };
    });
    if (!clean.length) return Promise.resolve();

    var out = {};
    out[PROGRESS_KEY] = { items: clean, updatedAt: Date.now() };
    return Promise.resolve(api.storage.local.set(out)).catch(function () {});
  }

  /** @return {!Promise<!Object>} */
  function loadProgress() {
    return Promise.resolve(api.storage.local.get(PROGRESS_KEY)).then(function (res) {
      return (res && res[PROGRESS_KEY]) || {};
    }).catch(function () {
      return {};
    });
  }

  /** @return {!Promise<!Object>} */
  function activityStatus() {
    return Promise.all([
      loadActivity(),
      g.ADT.watchHealth.status(),
      nextDropsCheckAt(),
      loadProgress()
    ]).then(function (r) {
      return { drops: r[0], watching: r[1], nextCheckAt: r[2], progress: r[3] };
    });
  }

  /**
   * @param {string=} trigger What asked for this check.
   * @return {!Promise<*>}
   */
  function runDropsCheck(trigger) {
    var how = trigger || 'alarm';
    return g.ADT.settings.get().then(function (s) {
      if (!s.enabled || !s.drops.enabled || !s.drops.autoClaim) {
        return noteDropsCheck('off', how);
      }
      if (!s.drops.openInventoryTab) return noteDropsCheck('off', how);

      return Promise.resolve(api.tabs.query({
        url: ['*://*.twitch.tv/drops/inventory', '*://*.twitch.tv/drops/inventory?*']
      })).then(function (tabs) {
        var run = (tabs && tabs.length)
          ? claimInOpenInventory(tabs[0], s)
          : openInventoryTab(s);
        return run.then(function (outcome) {
          return noteDropsCheck(outcome || 'idle', how);
        });
      });
    }).catch(function (e) {
      log.error('drops-check: ' + (e && e.message));
      return noteDropsCheck('error', how);
    });
  }

  /* ------------------------------------------------- browser-level tab mute */

  /*
   * Muting the <video> element is visible to Twitch: the player writes the new
   * state into its own store and fires volumechange, and any restore that does
   * not land leaves the stream silent for the rest of the session. Muting the
   * tab happens outside the page. The player never learns about it, so playback
   * and the viewer heartbeats that carry watch time and drop progress continue
   * untouched.
   */

  /**
   * Which tabs this extension muted for an ad, and when. In storage, not in a
   * variable: an ad break outlives the service worker without trouble, and a
   * record lost to a worker restart would leave that tab silent for good.
   * @const {string}
   */
  var MUTE_RT_KEY = 'adMuteRuntime';

  /** @const {number} No ad break comes close. Anything older is a leak. */
  var TAB_MUTE_MAX_MS = 10 * 60000;

  /** @return {!Promise<!Object>} */
  function loadMuteRt() {
    return Promise.resolve(api.storage.local.get(MUTE_RT_KEY)).then(function (res) {
      var rt = (res && res[MUTE_RT_KEY]) || {};
      rt.tabs = rt.tabs || {};      // tabId -> muted at.
      return rt;
    });
  }

  /** @param {!Object} rt @return {!Promise<void>} */
  function saveMuteRt(rt) {
    var out = {};
    out[MUTE_RT_KEY] = rt;
    return Promise.resolve(api.storage.local.set(out));
  }

  /**
   * Second opinion before unmuting: the browser itself says who muted a tab.
   * Auto-join's muteOnOpen is also an extension mute, which is why the stored
   * record above decides and this only guards against unmuting the user.
   *
   * @param {?Object} tab
   * @return {boolean}
   */
  function mutedByUs(tab) {
    var info = tab && tab.mutedInfo;
    if (!info || !info.muted) return false;
    if (info.reason && info.reason !== 'extension') return false;
    if (info.extensionId && info.extensionId !== api.runtime.id) return false;
    return true;
  }

  /**
   * @param {number} tabId
   * @return {!Promise<!Object>}
   */
  function releaseTabMute(tabId) {
    return loadMuteRt().then(function (rt) {
      var key = String(tabId);
      if (!rt.tabs[key]) return { ok: true, changed: false };
      delete rt.tabs[key];

      return saveMuteRt(rt)
        .then(function () { return api.tabs.get(tabId); })
        .then(function (tab) {
          if (!mutedByUs(tab)) return { ok: true, changed: false };
          return Promise.resolve(api.tabs.update(tabId, { muted: false }))
            .then(function () { return { ok: true, changed: true }; });
        });
    }).catch(function (e) {
      return { ok: false, error: String(e && e.message) };
    });
  }

  /**
   * @param {number} tabId
   * @param {boolean} muted
   * @return {!Promise<!Object>}
   */
  function setTabMuted(tabId, muted) {
    if (!muted) return releaseTabMute(tabId);

    return Promise.resolve(api.tabs.get(tabId)).then(function (tab) {
      // Already silent, by the user or by auto-join. Leave it alone and claim
      // nothing, so nothing here can unmute it later.
      if (tab && tab.mutedInfo && tab.mutedInfo.muted) {
        return { ok: true, changed: false };
      }
      return Promise.resolve(api.tabs.update(tabId, { muted: true }))
        .then(loadMuteRt)
        .then(function (rt) {
          rt.tabs[String(tabId)] = Date.now();
          return saveMuteRt(rt);
        })
        .then(function () { return { ok: true, changed: true }; });
    }).catch(function (e) {
      return { ok: false, error: String(e && e.message) };
    });
  }

  /**
   * Last line of defence. A content script that dies mid-break never sends its
   * unmute, and nobody should have to find that tab by hand.
   *
   * @return {!Promise<*>}
   */
  function sweepTabMutes() {
    return loadMuteRt().then(function (rt) {
      var now = Date.now();
      var chain = Promise.resolve();

      Object.keys(rt.tabs).forEach(function (key) {
        if (now - Number(rt.tabs[key] || 0) <= TAB_MUTE_MAX_MS) return;
        chain = chain.then(function () {
          log.warn('Ad mute on tab ' + key + ' outlived any ad break, releasing');
          return releaseTabMute(Number(key));
        });
      });
      return chain;
    }).catch(function (e) {
      log.warn('mute sweep: ' + (e && e.message));
    });
  }

  /** @param {number} tabId @return {!Promise<*>} */
  function forgetTabMute(tabId) {
    return loadMuteRt().then(function (rt) {
      if (!rt.tabs[String(tabId)]) return null;
      delete rt.tabs[String(tabId)];
      return saveMuteRt(rt);
    }).catch(function () {
      return null;
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
    if (alarm.name === ALARM_HEALTH) {
      g.ADT.watchHealth.check();
      sweepTabMutes();
    }
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

      case 'adt:watch-heartbeat':
        g.ADT.watchHealth.handleHeartbeat(
          msg, sender && sender.tab && sender.tab.id).then(function () {
            sendResponse({ ok: true });
          });
        return true;

      case 'adt:watch-stopped':
        if (sender && sender.tab && sender.tab.id != null) {
          g.ADT.watchHealth.forgetTab(sender.tab.id);
        }
        sendResponse({ ok: true });
        return true;

      // Ad mute at browser level. The sender decides when, this side only ever
      // touches the tab it came from.
      case 'adt:tab-mute':
        var muteTabId = sender && sender.tab && sender.tab.id;
        if (muteTabId == null) {
          sendResponse({ ok: false, error: 'no tab' });
          return true;
        }
        setTabMuted(muteTabId, !!msg.muted).then(sendResponse);
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
        Promise.all([g.ADT.settings.get(), g.ADT.liveWatch.status(), activityStatus()])
          .then(function (r) {
            sendResponse({ ok: true, settings: r[0], live: r[1], activity: r[2] });
          });
        return true;  // Async response.

      case 'adt:drops-check-now':
        runDropsCheck('popup').then(function () { sendResponse({ ok: true }); });
        return true;

      // Scraped off the inventory page by the content script.
      case 'adt:drops-progress':
        storeProgress(msg.items).then(function () { sendResponse({ ok: true }); });
        return true;

      // Raised by the content script when Twitch shows the unlock notification.
      // This is the primary trigger; the alarm is only a fallback.
      case 'adt:drop-unlocked':
        log.info('Drop unlock reported: ' + (msg.text || ''));
        runDropsCheck('unlock');
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
    g.ADT.watchHealth.forgetTab(tabId);
    forgetTabMute(tabId);
    delete lastInventoryReload[tabId];
  });

  /*
   * A navigating tab has no ad left to mute, and the content script that asked
   * for the mute is gone with the old document. Without this the tab would stay
   * silent until the sweep notices, or until the user unmutes it by hand.
   */
  api.tabs.onUpdated.addListener(function (tabId, changeInfo) {
    if (!changeInfo || changeInfo.status !== 'loading') return;
    releaseTabMute(tabId);
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
