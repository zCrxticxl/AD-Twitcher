/**
 * @license
 * Copyright 2026 zCrxticxl
 * SPDX-License-Identifier: Apache-2.0
 */

/** @fileoverview Reports whether a channel player is still advancing. */
(function () {
  'use strict';

  var g = typeof globalThis !== 'undefined' ? globalThis : window;
  g.ADT = g.ADT || {};
  g.ADT.modules = g.ADT.modules || {};
  var D = g.ADT.dom;

  var state = {
    running: false,
    timer: null,
    firstTimer: null,
    cfg: null,
    video: null,
    lastTime: null
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

  function report() {
    if (!state.running) return;
    var channel = D.currentChannel();
    if (!channel) return;

    var video = findPlayer();
    if (video !== state.video) {
      state.video = video;
      state.lastTime = null;
    }

    var time = video && Number.isFinite(video.currentTime) ? video.currentTime : 0;
    var advancing = !!video && state.lastTime != null && time > state.lastTime + 0.25;
    var playing = !!video && !video.paused && !video.ended && video.readyState >= 2;
    state.lastTime = video ? time : null;

    g.ADT.send({
      type: 'adt:watch-heartbeat',
      channel: channel,
      playing: playing,
      advancing: advancing
    });
  }

  function onPlayerState() {
    if (!state.running) return;
    setTimeout(report, 250);
  }

  /** @param {!Object} cfg settings.watchHealth */
  function start(cfg) {
    if (state.running) stop();
    state.running = true;
    state.cfg = cfg;
    state.video = null;
    state.lastTime = null;
    state.firstTimer = setTimeout(report, 2000);
    state.timer = setInterval(report, Math.max(15, cfg.heartbeatSec || 30) * 1000);
    document.addEventListener('playing', onPlayerState, true);
    document.addEventListener('pause', onPlayerState, true);
    document.addEventListener('ended', onPlayerState, true);
    document.addEventListener('visibilitychange', onPlayerState);
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
    document.removeEventListener('playing', onPlayerState, true);
    document.removeEventListener('pause', onPlayerState, true);
    document.removeEventListener('ended', onPlayerState, true);
    document.removeEventListener('visibilitychange', onPlayerState);
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
