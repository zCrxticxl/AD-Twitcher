/**
 * @license
 * Copyright 2026 zCrxticxl
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * @fileoverview Cross-browser WebExtension shim, messaging helpers and the
 * i18n entry point. Firefox exposes a promise-based `browser` namespace,
 * Chrome exposes `chrome`, which returns promises for every API used here
 * under MV3. Everything downstream talks to `ADT.api` only.
 */
(function () {
  'use strict';

  var g = typeof globalThis !== 'undefined' ? globalThis : self;
  // Re-injection must not run this file twice; see content/beacon.js.
  if (g.__adtOnce && g.__adtOnce('lib/browser.js')) return;

  g.ADT = g.ADT || {};

  var hasBrowser = typeof g.browser !== 'undefined' && g.browser && g.browser.runtime;

  /** @const {!Object} The WebExtension namespace of the host browser. */
  g.ADT.api = hasBrowser ? g.browser : g.chrome;

  /** @const {boolean} */
  g.ADT.isFirefox = !!hasBrowser;

  /** @const {number} Manifest version of the running build. */
  g.ADT.mv = g.ADT.api && g.ADT.api.runtime && g.ADT.api.runtime.getManifest
    ? g.ADT.api.runtime.getManifest().manifest_version
    : 3;

  /** @const {?Object} `action` on MV3, `browserAction` on MV2. */
  g.ADT.actionApi = g.ADT.api.action || g.ADT.api.browserAction || null;

  /* ---------------------------------------------------------------- i18n */

  var i18n = g.ADT.api && g.ADT.api.i18n;

  /**
   * Resolves a message from `_locales`. Falls back to the raw key so a missing
   * translation shows up in the UI instead of rendering an empty element.
   *
   * @param {string} key Message name as declared in messages.json.
   * @param {(string|number|!Array<string|number>)=} subs Placeholder values
   *     for $1..$9, in order.
   * @return {string}
   */
  g.ADT.msg = function (key, subs) {
    if (!i18n || !i18n.getMessage) return key;
    var list = subs === undefined ? undefined
      : (Array.isArray(subs) ? subs : [subs]).map(String);
    var out = '';
    try {
      out = i18n.getMessage(key, list);
    } catch (e) {
      out = '';
    }
    return out || key;
  };

  /**
   * BCP-47 tag of the browser UI language, used for number and date
   * formatting so the popup never hardcodes a regional format.
   *
   * @const {string}
   */
  g.ADT.uiLocale = (function () {
    try {
      return (i18n && i18n.getUILanguage && i18n.getUILanguage()) || 'en';
    } catch (e) {
      return 'en';
    }
  })();

  /**
   * @param {?number} n
   * @param {string=} fallback Returned for null, undefined and NaN.
   * @return {string}
   */
  g.ADT.formatNumber = function (n, fallback) {
    if (n == null || isNaN(n)) return fallback === undefined ? '-' : fallback;
    try {
      return Number(n).toLocaleString(g.ADT.uiLocale);
    } catch (e) {
      return String(n);
    }
  };

  /* ----------------------------------------------------------- messaging */

  /**
   * Sends a runtime message. Resolves with null instead of rejecting when no
   * receiver is listening, which happens routinely while the MV3 service
   * worker is spinning up.
   *
   * @param {!Object} msg
   * @return {!Promise<?Object>}
   */
  g.ADT.send = function (msg) {
    try {
      var p = g.ADT.api.runtime.sendMessage(msg);
      return p && typeof p.then === 'function'
        ? p.catch(function () { return null; })
        : Promise.resolve(null);
    } catch (e) {
      return Promise.resolve(null);
    }
  };

  /**
   * Sends a message to one tab. A tab without content scripts resolves to
   * null rather than throwing; callers distinguish the two cases themselves.
   * The callback branch only exists for MV2 builds that predate promises.
   *
   * @param {number} tabId
   * @param {!Object} msg
   * @return {!Promise<?Object>}
   */
  g.ADT.sendToTab = function (tabId, msg) {
    try {
      var p = g.ADT.api.tabs.sendMessage(tabId, msg);
      if (p && typeof p.then === 'function') {
        return p.catch(function () { return null; });
      }
      return new Promise(function (resolve) {
        g.ADT.api.tabs.sendMessage(tabId, msg, function (res) {
          void g.ADT.api.runtime.lastError;  // Suppresses "Unchecked lastError".
          resolve(res || null);
        });
      });
    } catch (e) {
      return Promise.resolve(null);
    }
  };

  /**
   * @param {number} tabId
   * @return {!Promise<?Object>} Beacon response, or null if nothing answered.
   */
  g.ADT.pingTab = function (tabId) {
    return g.ADT.sendToTab(tabId, { type: 'adt:ping' }).then(function (r) {
      return r && r.ok ? r : null;
    });
  };

  /* ---------------------------------------------------------------- misc */

  /**
   * @param {number} ms
   * @return {!Promise<void>}
   */
  g.ADT.sleep = function (ms) {
    return new Promise(function (r) { setTimeout(r, ms); });
  };

  /**
   * Randomized delay. Keeps automated clicks off a fixed grid.
   *
   * @param {number} base
   * @param {number=} spread
   * @return {number} Milliseconds.
   */
  g.ADT.jitter = function (base, spread) {
    return base + Math.floor(Math.random() * (spread || 0));
  };

  if (g.__adtLoaded) g.__adtLoaded('lib/browser.js');
})();
