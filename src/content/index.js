/**
 * @license
 * Copyright 2026 zCrxticxl
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * @fileoverview Content orchestrator. Decides from settings plus the current
 * route which modules run, and rebinds them cleanly on change. Twitch remounts
 * chat and player completely on a channel switch, so modules are torn down and
 * restarted rather than reused.
 */
(function () {
  'use strict';

  var g = typeof globalThis !== 'undefined' ? globalThis : window;
  g.ADT = g.ADT || {};
  var api = g.ADT.api;
  var log = g.ADT.log;
  var D = g.ADT.dom;
  var M = g.ADT.modules || {};

  g.ADT.state = {
    lastPointClaim: null,
    startedAt: Date.now(),
    active: [],
    page: 'other'
  };

  /** @type {!Object<string, boolean>} Module name to running flag. */
  var current = {};

  /** @type {?string} */
  var lastSig = null;

  /** @return {string} One of 'drops', 'channel', 'other'. */
  function pageKind() {
    if (/^\/drops\//.test(location.pathname)) return 'drops';
    if (D.currentChannel()) return 'channel';
    return 'other';
  }

  /**
   * @param {!Object} s Settings.
   * @return {!Object<string, !Object>} Module name to its config.
   */
  function desired(s) {
    var kind = pageKind();
    var want = {};
    if (!s.enabled) return want;

    if (kind === 'channel') {
      if (s.watchHealth.enabled) want.watchHealth = s.watchHealth;
      if (s.channelPoints.enabled) want.channelPoints = s.channelPoints;
      if (s.adMute.enabled) want.adMute = s.adMute;
      if (s.viewerStats.enabled) want.viewerStats = s.viewerStats;
    }
    if (s.drops.enabled) want.drops = s.drops;          // Notifications appear anywhere.
    if (s.autoJoin.enabled) want.sidebarWatch = s.autoJoin;
    return want;
  }

  /** @param {!Object} s Settings. */
  function apply(s) {
    log.setLevel(s.logLevel);
    g.ADT.state.page = pageKind();

    /*
     * Without this latch every storage change restarts all modules. A restarted
     * module sees the same ad or the same bonus chest again, counts it, which
     * triggers the next change: a feedback loop.
     */
    var sig = g.ADT.settings.configSig(s) + '|' + g.ADT.state.page;
    if (sig === lastSig) {
      log.debug('Configuration unchanged, no restart');
      return;
    }
    lastSig = sig;

    var want = desired(s);

    Object.keys(current).forEach(function (name) {
      if (!want[name] && M[name]) {
        M[name].stop();
        delete current[name];
      }
    });

    /*
     * start() is idempotent and resets internally. Guarded per module: one that
     * dies on a changed Twitch selector must not take the others with it.
     */
    Object.keys(want).forEach(function (name) {
      if (!M[name]) return;
      try {
        M[name].start(want[name]);
        current[name] = true;
      } catch (e) {
        log.error('Module ' + name + ' failed to start: ' + (e && e.message));
        if (g.__adtError) g.__adtError('start:' + name, e);
      }
    });

    g.ADT.state.active = Object.keys(current);
    log.debug('active modules: ' + (g.ADT.state.active.join(', ') || 'none'));
  }

  /** @return {!Promise<void>} */
  function refresh() {
    return g.ADT.settings.get().then(apply);
  }

  /*
   * Messages from popup and background. 'adt:ping' is deliberately not handled
   * here but in content/beacon.js: the ping has to answer even when this file
   * never loaded.
   */
  api.runtime.onMessage.addListener(function (msg, sender, sendResponse) {
    if (!msg || !msg.type) return;

    switch (msg.type) {
      case 'adt:get-viewer-stats':
        sendResponse(
          M.viewerStats && M.viewerStats.isRunning()
            ? { ok: true, data: M.viewerStats.snapshot() }
            : { ok: false, reason: 'inactive' });
        return true;

      // The report tells the background whether this page still has anything to
      // claim, and whether its view is old enough to be hiding a finished drop.
      case 'adt:claim-drops-now':
        sendResponse(M.drops
          ? { ok: true, report: M.drops.claimNow() }
          : { ok: false, reason: 'inactive' });
        return true;

      case 'adt:get-log':
        sendResponse({ ok: true, lines: log.history().slice(-60) });
        return true;

      case 'adt:refresh':
        refresh();
        sendResponse({ ok: true });
        return true;
    }
  });

  g.ADT.settings.onChange(apply);

  try {
    D.onRouteChange(function (path) {
      log.debug('route -> ' + path);
      Object.keys(current).forEach(function (n) {
        try {
          if (M[n]) M[n].stop();
        } catch (e) {
          // Keep tearing the rest down.
        }
      });
      current = {};
      lastSig = null;                       // Re-apply after a page change.
      if (D.resetClickBudget) D.resetClickBudget();
      setTimeout(refresh, 1200);
    });
  } catch (e) {
    log.warn('Route observation unavailable: ' + (e && e.message));
    if (g.__adtError) g.__adtError('onRouteChange', e);
  }

  refresh().then(function () {
    log.info('AD-Twitcher loaded (' + pageKind() + ')');
  }).catch(function (e) {
    log.error('Startup failed: ' + (e && e.message));
    if (g.__adtError) g.__adtError('refresh', e);
  });

  if (g.__adtLoaded) g.__adtLoaded('content/index.js');
})();
