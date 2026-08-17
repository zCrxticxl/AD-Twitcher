/**
 * @license
 * Copyright 2026 zCrxticxl
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * @fileoverview Settings layer on top of storage.local: defaults, deep merge
 * and a serialized write queue. Every context (popup, background, each content
 * script) reads and writes the same two keys, so writes must not race.
 */
(function () {
  'use strict';

  var g = typeof globalThis !== 'undefined' ? globalThis : self;
  // Re-injection must not run this file twice; see content/beacon.js.
  if (g.__adtOnce && g.__adtOnce('lib/storage.js')) return;

  g.ADT = g.ADT || {};
  var api = g.ADT.api;

  /** @const */
  var DEFAULTS = {
    enabled: true,
    logLevel: 'info',

    channelPoints: {
      enabled: true,
      scanIntervalMs: 4000,       // Fallback scan next to the MutationObserver.
      minDelayMs: 400,            // Delay before the click.
      jitterMs: 1800,             // Random amount added on top.
      cooldownMs: 12000           // Lockout after a successful claim.
    },

    drops: {
      enabled: true,
      autoClaim: true,            // Clicks on /drops/inventory and nowhere else.
      watchNotifications: true,   // Read-only detection of the unlock toast.
      checkIntervalMin: 120,      // Safety net for a missed notification.
      openInventoryTab: true,     // Open the inventory in a background tab.
      refreshInventory: true,     // Reload an inventory view older than the drop.
      closeAfterMs: 25000
    },

    autoJoin: {
      enabled: false,
      channels: [],               // Lowercase login names.
      background: true,
      muteOnOpen: true,
      closeWhenOffline: true,
      pollIntervalSec: 45
    },

    watchHealth: {
      enabled: true,
      keepAwake: true,
      keepPlaying: true,          // Undo a pause the user did not ask for.
      notifications: true,
      recoverTab: true,
      heartbeatSec: 30,
      staleAfterMin: 5
    },

    adMute: {
      enabled: true,
      muteTarget: 'tab',          // 'tab' (browser level), 'player' or 'none'.
      overlay: true,
      restoreVolume: true,        // Player target only; the tab has no volume.
      graceMs: 1500               // Ad markers must stay gone this long to unmute.
    },

    viewerStats: {
      enabled: true,
      windowMin: 5,               // Rolling window for chat metrics.
      panel: false                // On-page panel.
    }
  };

  /**
   * Counters live under their own storage key on purpose. While they were part
   * of `settings`, every increment fired storage.onChanged, which restarted all
   * modules, which made a module re-detect the same ad or chest and increment
   * again.
   * @const {string}
   */
  var STATS_KEY = 'stats';

  /** @const */
  var STATS_DEFAULTS = {
    pointsClaimed: 0,
    dropsClaimed: 0,
    adsMuted: 0,
    streamsOpened: 0,
    trackingSince: 0,
    lastActivityAt: 0,
    lastAction: ''             // Which counter moved last, for the activity card.
  };

  /**
   * @param {*} v
   * @return {boolean} True for plain objects, false for arrays and primitives.
   */
  function isPlain(v) {
    return v && typeof v === 'object' && !Array.isArray(v);
  }

  /**
   * Recursively merges `over` into `base`. Arrays are replaced, not merged, so
   * removing a channel from the watchlist actually removes it.
   *
   * @param {!Object|!Array} base
   * @param {*} over
   * @return {!Object|!Array} A new value; neither input is mutated.
   */
  function deepMerge(base, over) {
    var out = Array.isArray(base) ? base.slice() : Object.assign({}, base);
    if (!isPlain(over)) return out;
    Object.keys(over).forEach(function (k) {
      if (isPlain(base[k]) && isPlain(over[k])) out[k] = deepMerge(base[k], over[k]);
      else if (over[k] !== undefined) out[k] = over[k];
    });
    return out;
  }

  var cache = null;
  var listeners = [];

  /**
   * Writes are serialized. get() followed by set() is a read-modify-write, and
   * without a queue two contexts (several Twitch tabs, or a tab plus the popup)
   * overwrite each other.
   * @type {!Promise<*>}
   */
  var writeQueue = Promise.resolve();

  /**
   * Storage key to its own pending write chain, for `updateLocal`.
   * @type {!Object<string, !Promise<*>>}
   */
  var localQueues = {};

  /** @return {!Promise<!Object>} */
  function get() {
    if (cache) return Promise.resolve(cache);
    return Promise.resolve(api.storage.local.get('settings')).then(function (res) {
      cache = deepMerge(DEFAULTS, (res && res.settings) || {});
      return cache;
    });
  }

  /**
   * Reads straight from storage. The cache may be stale if another context
   * wrote in the meantime, so read-modify-write never uses it.
   *
   * @return {!Promise<!Object>}
   */
  function readFresh() {
    return Promise.resolve(api.storage.local.get('settings')).then(function (res) {
      return deepMerge(DEFAULTS, (res && res.settings) || {});
    });
  }

  /**
   * @param {function(): !Promise<T>} fn
   * @return {!Promise<T>}
   * @template T
   */
  function enqueue(fn) {
    var run = writeQueue.then(fn, fn);
    // Failures must not propagate into the queue or it stays rejected forever.
    writeQueue = run.catch(function () { });
    return run;
  }

  /**
   * @param {!Object} patch Partial settings tree.
   * @return {!Promise<!Object>} The merged result.
   */
  function set(patch) {
    if (typeof window !== 'undefined' && !g.ADT.isBackgroundPage) {
      return g.ADT.send({ type: 'adt:set-settings', patch: patch }).then(function (res) {
        if (!res || !res.ok) throw new Error('Settings update was rejected');
        cache = res.settings;
        return cache;
      });
    }
    return enqueue(function () {
      return readFresh().then(function (cur) {
        var next = deepMerge(cur, patch);
        cache = next;
        return Promise.resolve(api.storage.local.set({ settings: next }))
          .then(function () { return next; });
      });
    });
  }

  /** @return {!Promise<!Object>} */
  function getStats() {
    return Promise.resolve(api.storage.local.get(STATS_KEY)).then(function (res) {
      return deepMerge(STATS_DEFAULTS, (res && res[STATS_KEY]) || {});
    });
  }

  /**
   * Background-only. Content scripts post {type: 'adt:bump-stat'} instead, so
   * N tabs never compete for the same key. Writes STATS_KEY, never `settings`.
   *
   * @param {string} key
   * @param {number=} by
   * @return {!Promise<!Object>}
   */
  function bumpStat(key, by) {
    return enqueue(function () {
      return getStats().then(function (cur) {
        var next = deepMerge(cur, {});
        var now = Date.now();
        if (!next.trackingSince) next.trackingSince = now;
        next.lastActivityAt = now;
        next.lastAction = key;

        /*
         * Both sides are checked for being numbers. `by` arrives from a content
         * script over a message, and a string turns the addition into a
         * concatenation: one bad increment leaves "01" in storage and every
         * later one appends to it, so the counter never recovers.
         */
        var step = Number(by);
        if (!isFinite(step) || step <= 0) step = 1;
        var prev = Number(cur[key]);
        next[key] = (isFinite(prev) ? prev : 0) + step;
        var o = {};
        o[STATS_KEY] = next;
        return Promise.resolve(api.storage.local.set(o)).then(function () { return next; });
      });
    });
  }

  /** @return {!Promise<!Object>} Fresh defaults. */
  function reset() {
    if (typeof window !== 'undefined' && !g.ADT.isBackgroundPage) {
      return g.ADT.send({ type: 'adt:reset-settings' }).then(function (res) {
        if (!res || !res.ok) throw new Error('Settings reset was rejected');
        cache = res.settings;
        return cache;
      });
    }
    return enqueue(function () {
      cache = null;
      var o = { settings: {} };
      o[STATS_KEY] = {};
      return Promise.resolve(api.storage.local.set(o)).then(get);
    });
  }

  /**
   * Fingerprint of the configuration. Counters no longer live here; the delete
   * only guards against pre-0.2 payloads still sitting in storage.
   *
   * @param {!Object} s
   * @return {string}
   */
  function configSig(s) {
    var copy = deepMerge(s, {});
    delete copy.stats;
    try {
      return JSON.stringify(copy);
    } catch (e) {
      return String(Math.random());
    }
  }

  // Pick up changes made in another context (popup, content, background).
  if (api && api.storage && api.storage.onChanged) {
    api.storage.onChanged.addListener(function (changes, area) {
      if (area !== 'local' || !changes.settings) return;
      cache = deepMerge(DEFAULTS, changes.settings.newValue || {});
      listeners.forEach(function (fn) {
        try {
          fn(cache);
        } catch (e) {
          // One bad listener must not take out the others.
        }
      });
    });
  }

  g.ADT.settings = {
    DEFAULTS: DEFAULTS,
    get: get,
    set: set,
    getStats: getStats,
    bumpStat: bumpStat,
    reset: reset,
    configSig: configSig,
    onChange: function (fn) { listeners.push(fn); },
    deepMerge: deepMerge
  };

  /**
   * Serialized read-modify-write for a single storage.local key.
   *
   * Everything the background keeps at runtime - which tabs it muted, which it
   * is watching, which channels it opened for the watchlist - is held as a
   * plain get/set pair, and those interleave. Two Twitch tabs reporting in the
   * same moment both read the old value, and the second write silently drops
   * the first one's change. What that looks like from outside is never an
   * obvious storage problem: a tab that stays silent after its ad break, a
   * channel tab that is never closed when the stream ends, a second tab opened
   * for a stream that is already running. So it is fixed here, on the same
   * queue the settings writes already use, rather than at each call site.
   *
   * @param {string} key
   * @param {function(!Object): (!Object|!Promise<!Object>|undefined)} mutate
   *     Receives the stored value, or {} when there is none. Returning
   *     undefined skips the write, which keeps a no-op from costing one. A
   *     promise is awaited before the write, so a pass that has to ask the
   *     browser something mid-decision still ends in a single atomic update.
   * @return {!Promise<*>} What was written, or undefined when nothing was.
   */
  g.ADT.updateLocal = function (key, mutate) {
    /*
     * One queue per key rather than the settings queue. Serialization is only
     * needed against writers of the same key, and sharing one queue across all
     * of them would mean a mutator that bumps a counter - which auto-join does
     * while it decides - waits on the update it is running inside.
     */
    var prev = localQueues[key] || Promise.resolve();
    var run = prev.then(function () {
      return Promise.resolve(api.storage.local.get(key)).then(function (res) {
        return mutate((res && res[key]) || {});
      }).then(function (next) {
        if (next === undefined) return undefined;
        var o = {};
        o[key] = next;
        return Promise.resolve(api.storage.local.set(o)).then(function () {
          return next;
        });
      });
    });
    // A failed update must not leave the key's queue rejected forever.
    localQueues[key] = run.catch(function () {});
    return run;
  };

  /**
   * Increments a counter from any context: directly in the background, by
   * message everywhere else. Modules only ever call this.
   *
   * @param {string} key
   * @param {number=} by
   * @return {!Promise<*>}
   */
  g.ADT.countStat = function (key, by) {
    // Chrome MV3 service workers have no `window`; Firefox MV2 sets the flag.
    if (typeof window === 'undefined' || g.ADT.isBackgroundPage) return bumpStat(key, by);
    return g.ADT.send({ type: 'adt:bump-stat', key: key, by: by || 1 });
  };

  if (g.__adtLoaded) g.__adtLoaded('lib/storage.js');
})();
