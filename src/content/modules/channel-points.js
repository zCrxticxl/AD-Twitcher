/**
 * @license
 * Copyright 2026 zCrxticxl
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * @fileoverview Channel points bonus auto-claim.
 *
 * The bonus button is a small chest icon at the bottom right of the chat.
 * React re-renders it, so a throttled MutationObserver is paired with an
 * interval fallback for the case where the observer misses the container, for
 * example after chat remounts on a channel switch.
 */
(function () {
  'use strict';

  var g = typeof globalThis !== 'undefined' ? globalThis : window;
  // Re-injection must not run this file twice; see content/beacon.js.
  if (g.__adtOnce && g.__adtOnce('content/modules/channel-points.js')) return;

  g.ADT = g.ADT || {};
  g.ADT.modules = g.ADT.modules || {};
  var D = g.ADT.dom;
  var log = g.ADT.log;

  /**
   * The bonus chest and nothing else. An earlier revision listed
   * `[data-test-selector="community-points-summary"] button[class*="ScCoreButton"]`,
   * which is every button in that container, "Rewards" included. That opened
   * the rewards modal, and the next scan hit the Power-up confirm button, which
   * costs Bits. Every selector here has to carry the claimable-bonus marker or
   * an unambiguous aria-label.
   *
   * @const {!Array<string>}
   */
  var CLAIM_SELECTORS = [
    '.claimable-bonus__icon',
    'div[class*="claimable-bonus"] button',
    'button[class*="claimable-bonus"]',
    '[data-test-selector="community-points-summary"] button[aria-label*="Bonus" i]',
    '[data-test-selector="community-points-summary"] button[aria-label*="Claim" i][aria-label*="Point" i]'
  ];

  /**
   * "Bonus" as it appears in the aria-label of every shipped UI language.
   * @const {!RegExp}
   */
  var BONUS_RX = new RegExp([
    'bonus',      // en, de, fr, it, pl, tr
    'bonifica',   // es
    'bônus',      // pt-BR
    'бонус',      // ru
    'ボーナス',      // ja
    '보너스',        // ko
    '奖励'          // zh-CN
  ].join('|'), 'i');

  /** @const {!Array<string>} */
  var SUMMARY_SELECTORS = [
    '[data-test-selector="community-points-summary"]',
    'div[class*="community-points-summary"]',
    '.chat-input__buttons-container'
  ];

  var state = {
    running: false,
    timer: null,
    observer: null,
    cooldownUntil: 0,
    pendingClick: false,
    cfg: null,
    pendingTimer: null
  };

  /**
   * Second gate: a selector hit alone is not enough, the resolved button has to
   * demonstrably belong to the bonus chest.
   *
   * @param {?Element} btn
   * @return {boolean}
   */
  function looksLikeBonus(btn) {
    if (!btn) return false;
    var cls = String(btn.className || '');
    if (/claimable-bonus/i.test(cls)) return true;
    if (btn.querySelector('[class*="claimable-bonus"]')) return true;
    if (btn.closest('[class*="claimable-bonus"]')) return true;

    var label = btn.getAttribute('aria-label') || '';
    if (BONUS_RX.test(label) &&
        btn.closest('[data-test-selector="community-points-summary"]')) {
      return true;
    }
    return false;
  }

  /** @return {?Element} */
  function findClaim() {
    for (var i = 0; i < CLAIM_SELECTORS.length; i++) {
      var el = D.q(CLAIM_SELECTORS[i]);
      if (!el) continue;
      // Icon divs resolve up to the enclosing button.
      var btn = el.tagName === 'BUTTON' ? el : (el.closest('button') || el);
      if (!D.isVisible(btn)) continue;
      if (!looksLikeBonus(btn)) continue;
      if (D.isDangerous(btn) || D.inModal(btn)) continue;
      return btn;
    }
    return null;
  }

  function scan() {
    if (!state.running || state.pendingClick) return;
    if (Date.now() < state.cooldownUntil) return;

    var btn = findClaim();
    if (!btn) return;

    state.pendingClick = true;
    var delay = g.ADT.jitter(state.cfg.minDelayMs, state.cfg.jitterMs);

    state.pendingTimer = setTimeout(function () {
      state.pendingTimer = null;
      if (!state.running || !state.cfg || Date.now() < state.cooldownUntil) return;
      // Resolve again: the button can disappear while we wait.
      var live = findClaim();
      if (!live) {
        state.pendingClick = false;
        return;
      }

      var ok = D.safeClick(live, 'channel-points');
      state.pendingClick = false;

      if (!ok) {
        // Never fail silently here. Otherwise a tripped budget shows up in the
        // log without naming the module that consumed it.
        log.debug('channel-points: click rejected');
        return;
      }
      state.cooldownUntil = Date.now() + state.cfg.cooldownMs;

      log.info('Channel points bonus claimed (' + (D.currentChannel() || '?') + ')');
      g.ADT.countStat('pointsClaimed');
      if (g.ADT.state) g.ADT.state.lastPointClaim = Date.now();
      D.toast(g.ADT.msg('toastBonusClaimed'));
    }, delay);
  }

  function attachObserver() {
    if (state.observer) {
      state.observer.disconnect();
      state.observer = null;
    }
    var root = D.qAny(SUMMARY_SELECTORS) || document.body;
    state.observer = D.observe(root, scan, 400);
  }

  /** @param {!Object} cfg settings.channelPoints */
  function start(cfg) {
    /*
     * Carry the cooldown across the restart. This used to reset to 0, so every
     * restart dropped the 12 second lockout and the same chest was clicked
     * once per second.
     */
    var keepCooldown = state.cooldownUntil || 0;
    if (state.running) stop();
    state.cfg = cfg;
    state.running = true;
    state.cooldownUntil = keepCooldown;

    attachObserver();
    // The container may only exist after chat mounts, so re-attach later.
    D.waitFor(SUMMARY_SELECTORS, 30000).then(function (el) {
      if (state.running && el) attachObserver();
    });

    state.timer = setInterval(scan, Math.max(1500, cfg.scanIntervalMs));
    scan();
    log.debug('channel-points: started');
  }

  function stop() {
    state.running = false;
    if (state.timer) {
      clearInterval(state.timer);
      state.timer = null;
    }
    if (state.observer) {
      state.observer.disconnect();
      state.observer = null;
    }
    state.pendingClick = false;
    if (state.pendingTimer) {
      clearTimeout(state.pendingTimer);
      state.pendingTimer = null;
    }
    log.debug('channel-points: stopped');
  }

  g.ADT.modules.channelPoints = { start: start, stop: stop, _state: state };
  if (g.__adtLoaded) g.__adtLoaded('content/modules/channel-points.js');
})();
