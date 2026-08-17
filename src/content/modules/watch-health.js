/**
 * @license
 * Copyright 2026 zCrxticxl
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * @fileoverview Reports whether a channel player is still advancing, and puts
 * it back to work when it stops on its own.
 *
 * A paused player earns no watch time and no drop progress. Twitch pauses one
 * more often than it admits: after an ad transition, after a network hiccup,
 * after the browser throttled a background tab. Nothing on the page brings it
 * back, so the tab sits there looking open while nothing accumulates. The pause
 * guard below takes that pause back. The one pause it leaves alone is the one
 * the user asked for.
 */
(function () {
  'use strict';

  var g = typeof globalThis !== 'undefined' ? globalThis : window;
  // Re-injection must not run this file twice; see content/beacon.js.
  if (g.__adtOnce && g.__adtOnce('content/modules/watch-health.js')) return;

  g.ADT = g.ADT || {};
  g.ADT.modules = g.ADT.modules || {};
  var D = g.ADT.dom;
  var log = g.ADT.log;

  /** @const {!Array<string>} Player container, for scoping user input. */
  var PLAYER_SELECTORS = [
    '[data-a-target="video-player"]',
    '.video-player__container',
    '.persistent-player'
  ];

  /** @const {number} A pause this soon after player input belongs to the user. */
  var USER_INTENT_MS = 1500;

  /** @const {number} Twitch fires pause during its own transitions; let it settle. */
  var RESUME_DELAY_MS = 400;

  /** @const {number} Ceiling for automatic resumes, so nothing can busy-loop. */
  var MAX_RESUMES_PER_MIN = 6;

  var state = {
    running: false,
    timer: null,
    firstTimer: null,
    cfg: null,
    video: null,
    lastTime: null,
    interactedAt: 0,
    userPaused: false,
    capped: false,
    watching: false,
    resumes: []
  };

  /** @return {?HTMLVideoElement} */
  function findPlayer() {
    var videos = Array.prototype.slice.call(document.querySelectorAll('video'));
    if (!videos.length) return null;
    return videos.filter(function (video) {
      return video.isConnected && !video.ended;
    }).sort(function (a, b) {
      return (b.clientWidth * b.clientHeight) - (a.clientWidth * a.clientHeight);
    })[0] || videos[0];
  }

  /* --------------------------------------------------------- pause guard */

  /**
   * @param {?EventTarget} node
   * @return {boolean} True for anything inside the player.
   */
  function inPlayer(node) {
    if (!node || typeof node.closest !== 'function') return false;
    try {
      return !!node.closest(PLAYER_SELECTORS.join(','));
    } catch (e) {
      return false;
    }
  }

  /**
   * Records intent, narrowly. A click in chat is not permission to stay paused,
   * so only player clicks and Twitch's own play/pause keys count.
   *
   * @param {!Event} ev
   */
  function onUserInput(ev) {
    if (!state.running) return;

    var target = ev.target || {};
    var tag = target.tagName || '';
    if (tag === 'INPUT' || tag === 'TEXTAREA' || target.isContentEditable) return;

    if (ev.type === 'keydown') {
      var key = String(ev.key || '').toLowerCase();
      if (key !== ' ' && key !== 'spacebar' && key !== 'k') return;
    } else if (!inPlayer(ev.target)) {
      return;
    }
    state.interactedAt = Date.now();
  }

  /**
   * @param {?HTMLVideoElement} video
   * @return {boolean} True if a resume was dispatched.
   */
  function resume(video) {
    if (!state.running || !state.cfg.keepPlaying || state.userPaused) return false;
    if (!video || !video.isConnected || !video.paused || video.ended) return false;
    if (typeof video.play !== 'function') return false;

    var now = Date.now();
    state.resumes = state.resumes.filter(function (t) { return now - t < 60000; });
    if (state.resumes.length >= MAX_RESUMES_PER_MIN) {
      // Once per window, not once per attempt.
      if (!state.capped) {
        state.capped = true;
        log.warn('Playback keeps pausing, resume attempts held back for a minute');
      }
      return false;
    }
    state.capped = false;
    state.resumes.push(now);

    try {
      var started = video.play();
      if (started && typeof started.catch === 'function') started.catch(function () {});
    } catch (e) {
      // Autoplay policy or a player mid-teardown. The next tick tries again.
      return false;
    }
    log.info('Playback resumed after an unrequested pause');
    return true;
  }

  /** @param {!Event} ev */
  function onPause(ev) {
    if (!state.running || !state.cfg.keepPlaying) return;
    var video = ev.target;
    if (!video || video.tagName !== 'VIDEO') return;

    if (Date.now() - state.interactedAt < USER_INTENT_MS) {
      state.userPaused = true;      // Their call. Stay out of it until they play.
      log.debug('Pause looks user-initiated, leaving it alone');
      return;
    }
    setTimeout(function () { resume(video); }, RESUME_DELAY_MS);
  }

  function report() {
    if (!state.running) return;
    var channel = D.currentChannel();
    if (!channel) return;

    var video = findPlayer();

    /*
     * No player anywhere on the page: an offline channel, or a stream that just
     * ended and took its player with it. Nothing here can advance, so a
     * heartbeat would have the watchdog wait for progress that was never coming
     * and then reload the tab under the user for a fault that does not exist.
     *
     * The tab is handed back instead, exactly as stop() does it, and the next
     * report re-registers it the moment a player mounts. The flag keeps that to
     * one message per transition rather than one per heartbeat, which would
     * wake the service worker every half minute for every offline tab.
     */
    if (!video) {
      state.video = null;
      state.lastTime = null;
      if (state.watching) {
        state.watching = false;
        g.ADT.send({ type: 'adt:watch-stopped' });
      }
      return;
    }
    state.watching = true;

    if (video !== state.video) {
      state.video = video;
      state.lastTime = null;
    }

    var time = video && Number.isFinite(video.currentTime) ? video.currentTime : 0;
    var advancing = !!video && state.lastTime != null && time > state.lastTime + 0.25;
    var playing = !!video && !video.paused && !video.ended && video.readyState >= 2;
    state.lastTime = video ? time : null;

    // Catches what the pause event missed: a tab that came back from a discard,
    // a player that was already paused when the module started.
    if (video && video.paused && !video.ended) resume(video);

    /*
     * `userPaused` travels with the heartbeat because this is the only place
     * that can tell the two reasons for a standing video time apart. A stalled
     * player and one the user paused on purpose look identical from the
     * background - both simply stop advancing - and without this the watchdog
     * treated a deliberate pause as a fault and reloaded the tab under them.
     */
    g.ADT.send({
      type: 'adt:watch-heartbeat',
      channel: channel,
      playing: playing,
      advancing: advancing,
      userPaused: state.userPaused
    });
  }

  /** @param {!Event=} ev */
  function onPlayerState(ev) {
    if (!state.running) return;
    // Playback is back, whoever started it. Drop the hands-off flag so a later
    // spontaneous pause is repaired again.
    if (ev && (ev.type === 'playing' || ev.type === 'play')) state.userPaused = false;
    if (ev && ev.type === 'pause') onPause(ev);
    setTimeout(report, 250);
  }

  /** @param {!Object} cfg settings.watchHealth */
  function start(cfg) {
    if (state.running) stop();
    state.running = true;
    state.cfg = cfg;
    state.video = null;
    state.lastTime = null;
    state.interactedAt = 0;
    state.userPaused = false;
    state.capped = false;
    state.watching = false;
    state.resumes = [];
    state.firstTimer = setTimeout(report, 2000);
    state.timer = setInterval(report, Math.max(15, cfg.heartbeatSec || 30) * 1000);
    document.addEventListener('playing', onPlayerState, true);
    document.addEventListener('play', onPlayerState, true);
    document.addEventListener('pause', onPlayerState, true);
    document.addEventListener('ended', onPlayerState, true);
    document.addEventListener('visibilitychange', onPlayerState);
    document.addEventListener('pointerdown', onUserInput, true);
    document.addEventListener('keydown', onUserInput, true);
    window.addEventListener('pageshow', onPlayerState);
  }

  function stop() {
    var wasRunning = state.running;
    state.running = false;
    if (state.timer) clearInterval(state.timer);
    if (state.firstTimer) clearTimeout(state.firstTimer);
    state.timer = null;
    state.firstTimer = null;
    state.video = null;
    state.lastTime = null;
    state.watching = false;
    state.resumes = [];
    document.removeEventListener('playing', onPlayerState, true);
    document.removeEventListener('play', onPlayerState, true);
    document.removeEventListener('pause', onPlayerState, true);
    document.removeEventListener('ended', onPlayerState, true);
    document.removeEventListener('visibilitychange', onPlayerState);
    document.removeEventListener('pointerdown', onUserInput, true);
    document.removeEventListener('keydown', onUserInput, true);
    window.removeEventListener('pageshow', onPlayerState);
    if (wasRunning) g.ADT.send({ type: 'adt:watch-stopped' });
  }

  g.ADT.modules.watchHealth = {
    start: start,
    stop: stop,
    reportNow: report
  };
  if (g.__adtLoaded) g.__adtLoaded('content/modules/watch-health.js');
})();
