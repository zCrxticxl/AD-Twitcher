/**
 * @license
 * Copyright 2026 zCrxticxl
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * @fileoverview Level-filtered logger with a ring buffer. The buffer backs the
 * popup's log tab, so the last few minutes stay readable without the developer
 * console being open. Log text is English on purpose: it is diagnostic output,
 * not user-facing UI, and it ends up in bug reports.
 */
(function () {
  'use strict';

  var g = typeof globalThis !== 'undefined' ? globalThis : self;
  // Re-injection must not run this file twice; see content/beacon.js.
  if (g.__adtOnce && g.__adtOnce('lib/log.js')) return;

  g.ADT = g.ADT || {};

  /** @const {!Object<string, number>} */
  var ORDER = { debug: 0, info: 1, warn: 2, error: 3, silent: 4 };

  /** @const {number} Entries kept per context. */
  var BUFFER_MAX = 200;

  /** @const {string} */
  var TAG = '%c[AD-Twitcher]';

  /** @const {string} */
  var STYLE = 'color:#a970ff;font-weight:600';

  var level = 'info';
  var buffer = [];

  /**
   * @param {string} kind
   * @param {!Arguments} args
   */
  function push(kind, args) {
    buffer.push({
      t: Date.now(),
      kind: kind,
      msg: Array.prototype.map.call(args, function (a) {
        if (typeof a === 'string') return a;
        try {
          return JSON.stringify(a);
        } catch (e) {
          return String(a);
        }
      }).join(' ')
    });
    if (buffer.length > BUFFER_MAX) buffer.splice(0, buffer.length - BUFFER_MAX);
  }

  /**
   * @param {string} kind
   * @param {function(...*)} consoleFn
   * @return {function(...*)}
   */
  function make(kind, consoleFn) {
    return function () {
      if (ORDER[level] > ORDER[kind]) return;
      push(kind, arguments);
      consoleFn.apply(console, [TAG, STYLE].concat(Array.prototype.slice.call(arguments)));
    };
  }

  g.ADT.log = {
    /** @param {string} l One of debug, info, warn, error, silent. */
    setLevel: function (l) {
      if (l in ORDER) level = l;
    },
    /** @return {string} */
    getLevel: function () {
      return level;
    },
    /** @return {!Array<{t: number, kind: string, msg: string}>} */
    history: function () {
      return buffer.slice();
    },
    debug: make('debug', console.debug.bind(console)),
    info: make('info', console.log.bind(console)),
    warn: make('warn', console.warn.bind(console)),
    error: make('error', console.error.bind(console))
  };

  if (g.__adtLoaded) g.__adtLoaded('lib/log.js');
})();
