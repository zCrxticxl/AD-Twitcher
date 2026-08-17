/**
 * @license
 * Copyright 2026 zCrxticxl
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * @fileoverview Diagnostic beacon. Must run as the first content script.
 *
 * The ping handler may not depend on any other file. While it lived in
 * content/index.js it called into lib/dom.js, so if any earlier file threw, the
 * handler threw too, sendResponse was never called, and the popup could not
 * tell "script is broken" from "script was never injected".
 *
 * This file has no dependencies, not even ADT, and reports which files made it
 * to the end of their IIFE. A file missing from that list is the one that died.
 */
(function () {
  'use strict';

  var g = typeof globalThis !== 'undefined' ? globalThis : self;
  var api = (typeof g.browser !== 'undefined' && g.browser && g.browser.runtime)
    ? g.browser
    : g.chrome;

  // Re-injection must not register a second listener.
  if (g.__ADT_DIAG && g.__ADT_DIAG.listening) {
    g.__ADT_DIAG.reinjected = (g.__ADT_DIAG.reinjected || 0) + 1;
    return;
  }

  var diag = g.__ADT_DIAG = g.__ADT_DIAG || {};
  diag.loaded = diag.loaded || [];
  diag.started = diag.started || [];
  diag.errors = diag.errors || [];
  diag.t0 = Date.now();
  diag.listening = false;

  /**
   * Called by every file as its last statement.
   * @param {string} name Path relative to the extension root.
   */
  g.__adtLoaded = function (name) {
    if (diag.loaded.indexOf(name) < 0) diag.loaded.push(name);
  };

  /**
   * Called by every file as its first statement, and the file returns when this
   * says yes.
   *
   * One document can receive the content scripts twice. The browser injects
   * them at document_idle, and the background injects into every Twitch tab
   * that did not answer a ping - which a tab that is still loading cannot do.
   * Running the files a second time registers a second message listener (so
   * sendResponse is called twice), a second storage listener, a second route
   * observer with its own interval, and a second click budget, while the
   * modules from the first pass keep their timers and observers with nothing
   * left holding a reference to stop them.
   *
   * Deliberately a separate list from `loaded`, which records files that
   * reached their last statement: a file that dies halfway must still show up
   * as not loaded, or the ping stops being a diagnostic.
   *
   * @param {string} name Path relative to the extension root.
   * @return {boolean} True when this file has already run in this document.
   */
  g.__adtOnce = function (name) {
    if (diag.started.indexOf(name) >= 0) return true;
    diag.started.push(name);
    return false;
  };

  /**
   * @param {string} where
   * @param {*} e
   */
  g.__adtError = function (where, e) {
    diag.errors.push({
      where: where,
      msg: String((e && e.message) || e),
      stack: String((e && e.stack) || '').split('\n').slice(0, 3).join(' | ')
    });
  };

  // Collect errors thrown by our own files. Twitch throws plenty of its own,
  // so filter by script origin.
  try {
    // window, not g: in Firefox addEventListener is not on the sandbox global.
    window.addEventListener('error', function (ev) {
      var f = String(ev.filename || '');
      if (!/(chrome-extension|moz-extension):/.test(f)) return;
      diag.errors.push({
        where: f.replace(/^.*\/\/[^\/]+\//, ''),
        msg: String(ev.message || ''),
        stack: 'line ' + ev.lineno + ':' + ev.colno
      });
    });
  } catch (e) {
    // A page with a hostile CSP can refuse this. Not fatal.
  }

  if (api && api.runtime && api.runtime.onMessage) {
    api.runtime.onMessage.addListener(function (msg, sender, sendResponse) {
      if (!msg || msg.type !== 'adt:ping') return;

      // Everything below is defensive: the ping has to answer even when ADT is
      // missing entirely, otherwise it is worthless as a diagnostic.
      var out = {
        ok: true,
        beacon: true,
        url: location.href,
        loaded: diag.loaded.slice(),
        errors: diag.errors.slice(0, 8),
        reinjected: diag.reinjected || 0,
        adt: !!g.ADT,
        channel: null,
        page: 'other',
        active: [],
        complete: false
      };

      try {
        if (g.ADT && g.ADT.dom && g.ADT.dom.currentChannel) {
          out.channel = g.ADT.dom.currentChannel();
        }
        if (g.ADT && g.ADT.state) {
          out.active = g.ADT.state.active || [];
          out.page = g.ADT.state.page || out.page;
          out.complete = true;
        }
      } catch (e) {
        out.errors.push({ where: 'ping', msg: String(e && e.message) });
      }

      sendResponse(out);
      return true;
    });
    diag.listening = true;
  }

  g.__adtLoaded('content/beacon.js');
})();
