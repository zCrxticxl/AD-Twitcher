/**
 * @license
 * Copyright 2026 zCrxticxl
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * @fileoverview Ad mute and player overlay.
 *
 * Not an ad blocker and not a skipper. Twitch uses server-side ad insertion, so
 * the ad is muxed into the same HLS stream as the content: there is no separate
 * ad video to skip and no request to block. Seeking past it is impossible
 * because a live stream has no buffer beyond the live edge. Those seconds are
 * real wall time. What happens here is detect, mute, cover, restore.
 *
 * Where the mute happens matters more than it looks. Writing muted = true on
 * the <video> element is visible to Twitch: the player writes the state into
 * its own store, fires volumechange, and one restore that does not land leaves
 * the stream silent for the rest of the session. Muting the browser tab instead
 * happens entirely outside the page, so the player never learns about it and
 * the heartbeats that carry watch time and drop progress keep flowing. That is
 * the default; settings.adMute.muteTarget can still pick 'player' or 'none'.
 *
 * Performance is load-bearing in this file. The first revision attached a
 * MutationObserver to document.body, which fires more or less continuously
 * while chat is active, and ran seven querySelector calls plus
 * getBoundingClientRect and getComputedStyle per pass, twice a second. That
 * forces a layout recalculation often enough to stall the player, and the ad
 * countdown visibly froze. The rules now:
 *
 *   - one combined selector for explicit Twitch ad UI
 *   - visibility is checked because Twitch keeps stale markers in the DOM
 *   - observe the player container, never body
 *   - hold the mute via 'volumechange' instead of a timer
 *   - cache the player and video nodes
 */
(function () {
  'use strict';

  var g = typeof globalThis !== 'undefined' ? globalThis : window;
  // Re-injection must not run this file twice; see content/beacon.js.
  if (g.__adtOnce && g.__adtOnce('content/modules/ad-mute.js')) return;

  g.ADT = g.ADT || {};
  g.ADT.modules = g.ADT.modules || {};
  var D = g.ADT.dom;
  var log = g.ADT.log;

  /**
   * Explicit ad UI only. Twitch may leave the player-level `--ad` classes on
   * the container after playback has returned to the stream, so those classes
   * are deliberately not sufficient evidence.
   * @const {string}
   */
  var AD_MARKER_SELECTOR = [
    '[data-a-target="video-ad-label"]',
    '[data-a-target="video-ad-countdown"]',
    '[data-a-target="advertisement-overlay"]'
  ].join(',');

  /** @const {!Array<string>} */
  var PLAYER_SELECTORS = [
    '[data-a-target="video-player"]',
    '.video-player__container',
    '.persistent-player',
    'div[class*="video-player"]'
  ];

  /** @const {string} */
  var COUNTDOWN_SELECTOR = '[data-a-target="video-ad-countdown"]';

  /** Twitch's question-mark placeholder is not proof that an ad is active. */
  var TWITCH_PLACEHOLDER_SELECTOR = '[data-test-selector="sad-overlay"]';

  /** @const {number} Ads that resume within this window are not recounted. */
  var RECOUNT_GRACE_MS = 10000;

  /** @const {number} Prevents a broken Twitch player from causing reload loops. */
  var RECOVERY_RELOAD_COOLDOWN_MS = 120000;

  /** @const {string} Survives one page reload in the current Twitch tab. */
  var RECOVERY_RELOAD_KEY = 'adt:last-ad-recovery-reload';

  var state = {
    running: false,
    cfg: null,
    tickTimer: null,
    countdownTimer: null,
    observer: null,
    observerHost: null,
    rootObserver: null,
    player: null,
    video: null,
    volumeHandler: null,
    tabMuted: false,
    adActive: false,
    lastSeenAd: 0,
    lastAdEnd: 0,
    saved: null,
    overlayEl: null,
    overlayHost: null,
    changedHostPosition: false,
    lastCountdown: '',
    foregroundHandler: null,
    recoveryTimer: null
  };

  /** @return {string} 'tab', 'player' or 'none'. */
  function muteTarget() {
    var target = state.cfg && state.cfg.muteTarget;
    return (target === 'player' || target === 'none') ? target : 'tab';
  }

  /* ------------------------------------------------- cached node access */

  /** @return {?Element} */
  function player() {
    if (state.player && state.player.isConnected) return state.player;
    state.player = D.qAny(PLAYER_SELECTORS);
    return state.player;
  }

  /** @return {?HTMLVideoElement} */
  function video() {
    if (state.video && state.video.isConnected) return state.video;
    var p = player();
    state.video = (p && p.querySelector('video')) || document.querySelector('video');
    return state.video;
  }

  /**
   * Twitch often hides an ad marker instead of removing it. Existence alone
   * therefore cannot keep the overlay alive.
   *
   * @param {?Element} marker
   * @return {boolean}
   */
  function markerIsRendered(marker) {
    if (!marker || !marker.isConnected || marker.hidden) return false;
    if (marker.getAttribute('aria-hidden') === 'true') return false;

    var style;
    try {
      style = window.getComputedStyle(marker);
    } catch (e) {
      return false;
    }
    if (!style || style.display === 'none' || style.visibility === 'hidden' ||
        Number(style.opacity) === 0) {
      return false;
    }

    try {
      var rects = marker.getClientRects();
      if (!rects.length) return false;
      return Array.prototype.some.call(rects, function (rect) {
        return rect.width > 0 && rect.height > 0;
      });
    } catch (e2) {
      return false;
    }
  }

  /** @return {boolean} */
  function adMarkerPresent() {
    return Array.prototype.some.call(
      document.querySelectorAll(AD_MARKER_SELECTOR), markerIsRendered);
  }

  /* ------------------------------------------------------------ overlay */

  function buildOverlay() {
    if (!state.cfg.overlay || (state.overlayEl && state.overlayEl.isConnected)) return;
    var host = player();
    if (!host) return;

    state.changedHostPosition = host.style.position === '';
    if (state.changedHostPosition) host.style.position = 'relative';

    var box = document.createElement('div');
    box.className = 'adt-ad-overlay__box';

    var title = document.createElement('div');
    title.className = 'adt-ad-overlay__title';
    title.textContent = g.ADT.msg('overlayTitle');

    var sub = document.createElement('div');
    sub.className = 'adt-ad-overlay__sub';
    sub.textContent = g.ADT.msg('overlaySubtitle');

    var count = document.createElement('div');
    count.className = 'adt-ad-overlay__count';
    count.textContent = g.ADT.msg('overlayWaiting');

    box.appendChild(title);
    // The subtitle claims the ad is muted. Only true when something is.
    if (muteTarget() !== 'none') box.appendChild(sub);
    box.appendChild(count);

    var el = document.createElement('div');
    el.className = 'adt-ad-overlay';
    el.appendChild(box);
    host.appendChild(el);

    state.overlayEl = el;
    state.overlayHost = host;
    state.lastCountdown = '';
  }

  /**
   * Mirrors Twitch's own countdown. The node is re-rendered and briefly empty
   * during that; writing the empty value straight through made the overlay
   * flicker, so the last valid value is held instead.
   */
  function updateCountdown() {
    if (!state.overlayEl || !state.adActive) return;
    var node = document.querySelector(COUNTDOWN_SELECTOR);
    var txt = node ? (node.textContent || '').trim() : '';
    if (!txt || txt === state.lastCountdown) return;
    state.lastCountdown = txt;
    var slot = state.overlayEl.querySelector('.adt-ad-overlay__count');
    if (slot) slot.textContent = txt;
  }

  function removeOverlay() {
    if (state.overlayEl) {
      state.overlayEl.remove();
      state.overlayEl = null;
    }
    if (state.overlayHost && state.changedHostPosition &&
        state.overlayHost.isConnected && state.overlayHost.style.position === 'relative') {
      state.overlayHost.style.position = '';
    }
    state.overlayHost = null;
    state.changedHostPosition = false;
    state.lastCountdown = '';
  }

  /**
   * Twitch can leave its own question-mark layer mounted after the strong ad
   * markers are gone. It is presentation, not ad state, so hide it until
   * Twitch reuses or replaces it for a later break.
   */
  function hideStaleTwitchPlaceholder() {
    Array.prototype.forEach.call(
      document.querySelectorAll(TWITCH_PLACEHOLDER_SELECTOR), function (el) {
        el.classList.add('adt-twitch-placeholder--stale');
      });
  }

  function releaseTwitchPlaceholder() {
    Array.prototype.forEach.call(
      document.querySelectorAll(TWITCH_PLACEHOLDER_SELECTOR), function (el) {
        el.classList.remove('adt-twitch-placeholder--stale');
      });
  }

  function clearRecoveryTimer() {
    if (!state.recoveryTimer) return;
    clearTimeout(state.recoveryTimer);
    state.recoveryTimer = null;
  }

  /** @return {number} */
  function lastRecoveryReload() {
    try {
      return Number(window.sessionStorage.getItem(RECOVERY_RELOAD_KEY)) || 0;
    } catch (e) {
      return 0;
    }
  }

  function reloadForRecovery() {
    var now = Date.now();
    if (now - lastRecoveryReload() < RECOVERY_RELOAD_COOLDOWN_MS) {
      log.warn('Player still stalled after ad; recovery reload suppressed by cooldown');
      return;
    }
    /*
     * The cooldown is the only thing standing between this and a reload loop,
     * and it lives in sessionStorage because the reload wipes everything else.
     * If it cannot be written it cannot be read back either, so the next page
     * would find no record, find the player still stalled, and reload again.
     * Recovery is worth having; a tab that reloads forever is not.
     */
    try {
      window.sessionStorage.setItem(RECOVERY_RELOAD_KEY, String(now));
    } catch (e) {
      log.warn('Player did not recover after ad, but the reload cooldown ' +
        'cannot be stored; leaving the page alone rather than risking a loop');
      return;
    }
    log.warn('Player did not recover after ad; reloading Twitch once');
    location.reload();
  }

  /**
   * Twitch occasionally removes every ad marker but leaves the underlying
   * video stalled. First ask the existing video to continue. Then require
   * actual media-time progress; if none arrives, reload once as a last resort.
   */
  function schedulePlaybackRecovery() {
    clearRecoveryTimer();
    if (document.visibilityState === 'hidden') return;

    var v = video();
    var startedAt = v && Number.isFinite(v.currentTime) ? v.currentTime : null;
    if (v && typeof v.play === 'function') {
      try {
        var resume = v.play();
        if (resume && typeof resume.catch === 'function') resume.catch(function () {});
      } catch (e) {
        // The health check below decides whether a reload is necessary.
      }
    }

    state.recoveryTimer = setTimeout(function () {
      state.recoveryTimer = null;
      if (!state.running || state.adActive || adMarkerPresent()) return;
      hideStaleTwitchPlaceholder();

      var current = video();
      var hasFrame = !!current && current.readyState >= 2 &&
        current.videoWidth > 0 && current.videoHeight > 0;
      var progressed = !!current && startedAt != null &&
        Number.isFinite(current.currentTime) && current.currentTime > startedAt + 0.25;
      if (hasFrame && progressed && !current.paused) {
        log.debug('Player recovered after ad');
        return;
      }
      reloadForRecovery();
    }, 3500);
  }

  /* --------------------------------------------------------------- mute */

  /**
   * Set mute once and only react when the player undoes it, instead of writing
   * muted = true on a timer.
   *
   * @param {!HTMLVideoElement} v
   */
  function attachVolumeGuard(v) {
    detachVolumeGuard();
    state.volumeHandler = function () {
      if (state.adActive && !v.muted) v.muted = true;
    };
    v.addEventListener('volumechange', state.volumeHandler);
  }

  function detachVolumeGuard() {
    if (state.volumeHandler && state.video) {
      try {
        state.video.removeEventListener('volumechange', state.volumeHandler);
      } catch (e) {
        // Node already gone. Nothing to detach from.
      }
    }
    state.volumeHandler = null;
  }

  /**
   * Asks the background to mute the tab itself. It refuses when the tab is
   * already silent, so a tab the user muted by hand is never unmuted later.
   *
   * The flag is set before the answer arrives on purpose. A redundant unmute
   * costs nothing, the background checks its own record; a skipped one leaves
   * the tab silent, which is the failure this whole path exists to avoid.
   *
   * @param {boolean} muted
   */
  function requestTabMute(muted) {
    state.tabMuted = muted;
    g.ADT.send({ type: 'adt:tab-mute', muted: muted });
  }

  /** Silences the ad wherever settings say it should happen. */
  function applyMute() {
    var target = muteTarget();
    if (target === 'none') return;

    if (target === 'tab') {
      requestTabMute(true);
      return;
    }

    var v = video();
    if (!v) return;
    state.saved = { muted: v.muted, volume: v.volume };
    v.muted = true;
    attachVolumeGuard(v);
  }

  /** Undoes exactly what applyMute did, whichever layer that was. */
  function releaseMute() {
    if (state.tabMuted) requestTabMute(false);
    detachVolumeGuard();

    var v = video();
    if (v && state.saved && state.cfg.restoreVolume) {
      v.muted = state.saved.muted;
      if (typeof state.saved.volume === 'number' && v.volume === 0) {
        v.volume = state.saved.volume;
      }
    }
    state.saved = null;
  }

  function enterAd() {
    var v = video();
    if (!v) return;

    clearRecoveryTimer();
    state.adActive = true;
    releaseTwitchPlaceholder();
    applyMute();

    buildOverlay();
    if (!state.countdownTimer) {
      state.countdownTimer = setInterval(updateCountdown, 1000);
    }
    updateCountdown();

    // Do not count the same ad twice when the module restarts mid-break.
    if (Date.now() - state.lastAdEnd > RECOUNT_GRACE_MS) {
      g.ADT.countStat('adsMuted');
      log.info('Ad detected, mute target: ' + muteTarget());
    } else {
      log.debug('Ad still running after restart, not counted again');
    }
  }

  /** @param {boolean=} preserveTwitchUi True when the module is disabled. */
  function exitAd(preserveTwitchUi) {
    state.adActive = false;
    state.lastAdEnd = Date.now();

    if (state.countdownTimer) {
      clearInterval(state.countdownTimer);
      state.countdownTimer = null;
    }
    removeOverlay();
    if (!preserveTwitchUi) hideStaleTwitchPlaceholder();

    releaseMute();

    var v = video();
    if (!preserveTwitchUi && v && v.paused && typeof v.play === 'function') {
      try {
        var resume = v.play();
        if (resume && typeof resume.catch === 'function') resume.catch(function () {});
      } catch (e) {
        // Twitch will retry playback itself if the browser blocks autoplay.
      }
    }
    if (!preserveTwitchUi) schedulePlaybackRecovery();
    log.info('Ad finished, audio restored');
  }

  /* ---------------------------------------------------------- lifecycle */

  /**
   * Rebinds after Twitch replaces the player node. A MutationObserver remains
   * attached to a detached node forever, so keeping the original observer is
   * not a valid fallback across ad and channel transitions.
   */
  function bindPlayerObserver() {
    if (!state.running) return;
    var host = D.qAny(PLAYER_SELECTORS);
    if (host === state.observerHost && host && host.isConnected) return;

    if (state.observer) state.observer.disconnect();
    state.observer = null;
    state.observerHost = null;

    detachVolumeGuard();
    state.player = host || null;
    state.video = null;
    if (!host) return;

    state.observerHost = host;
    state.observer = D.observe(host, tick, 150, {
      attributes: true,
      attributeFilter: ['hidden', 'aria-hidden', 'style', 'class']
    });

    // The ad can outlive the old player node. Move both protection layers to
    // the replacement without overwriting the user's pre-ad volume snapshot.
    // A tab mute survives the swap by itself, there is nothing to move.
    if (state.adActive) {
      if (muteTarget() === 'player') {
        var v = video();
        if (v) {
          v.muted = true;
          attachVolumeGuard(v);
        }
      }
      buildOverlay();
    }
  }

  /** @param {boolean=} immediateExit */
  function tick(immediateExit) {
    if (!state.running) return;

    if (!state.observerHost || !state.observerHost.isConnected) {
      bindPlayerObserver();
    }

    if (adMarkerPresent()) {
      state.lastSeenAd = Date.now();
      if (!state.adActive) enterAd();
      return;
    }
    if (state.adActive && (immediateExit ||
        Date.now() - state.lastSeenAd > state.cfg.graceMs)) {
      exitAd();
    }
  }

  /** Reconcile immediately when a throttled background tab becomes active. */
  function reconcileForeground() {
    if (!state.running || document.visibilityState === 'hidden') return;
    bindPlayerObserver();
    tick(true);
    if (!state.adActive && state.lastAdEnd &&
        Date.now() - state.lastAdEnd < 60000 && !adMarkerPresent()) {
      hideStaleTwitchPlaceholder();
      schedulePlaybackRecovery();
    }
  }

  /** @param {!Object} cfg settings.adMute */
  function start(cfg) {
    if (state.running) stop();
    state.cfg = cfg;
    state.running = true;
    state.player = null;
    state.video = null;

    // The timer is only a fallback. Background tabs throttle it heavily, so
    // foreground lifecycle events below always perform an immediate check.
    state.tickTimer = setInterval(tick, 1000);

    state.foregroundHandler = reconcileForeground;
    document.addEventListener('visibilitychange', state.foregroundHandler);
    window.addEventListener('focus', state.foregroundHandler);
    window.addEventListener('pageshow', state.foregroundHandler);

    // Watch the document only for player replacement. The expensive marker
    // checks stay scoped to the player observer.
    state.rootObserver = D.observe(document.documentElement, function () {
      bindPlayerObserver();
    }, 400);

    D.waitFor(PLAYER_SELECTORS, 20000).then(function (host) {
      if (!state.running || !host) return;
      bindPlayerObserver();
      tick();
    });

    bindPlayerObserver();
    tick();
    log.debug('ad-mute: started (foreground reconcile, remount-aware observer)');
  }

  function stop() {
    state.running = false;
    if (state.tickTimer) {
      clearInterval(state.tickTimer);
      state.tickTimer = null;
    }
    if (state.countdownTimer) {
      clearInterval(state.countdownTimer);
      state.countdownTimer = null;
    }
    clearRecoveryTimer();
    if (state.observer) {
      state.observer.disconnect();
      state.observer = null;
    }
    state.observerHost = null;
    if (state.rootObserver) {
      state.rootObserver.disconnect();
      state.rootObserver = null;
    }
    if (state.foregroundHandler) {
      document.removeEventListener('visibilitychange', state.foregroundHandler);
      window.removeEventListener('focus', state.foregroundHandler);
      window.removeEventListener('pageshow', state.foregroundHandler);
      state.foregroundHandler = null;
    }
    if (state.adActive) exitAd(true);
    // Belt and braces: a tab must never stay muted because a module went away.
    if (state.tabMuted) requestTabMute(false);
    detachVolumeGuard();
    state.player = null;
    state.video = null;
    log.debug('ad-mute: stopped');
  }

  g.ADT.modules.adMute = {
    start: start,
    stop: stop,
    isAdActive: function () { return state.adActive; },
    markerIsRendered: markerIsRendered
  };
  if (g.__adtLoaded) g.__adtLoaded('content/modules/ad-mute.js');
})();
