/**
 * @license
 * Copyright 2026 zCrxticxl
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * @fileoverview Reads live status from the followed-channels sidebar.
 *
 * Without OAuth there is no clean live API. The sidebar is the most reliable
 * DOM source available: Twitch keeps it current over its own websocket, so all
 * this module has to do is read.
 *
 * Known limitation: at least one logged-in Twitch tab has to be open and the
 * observed channel has to be followed. A collapsed sidebar works, but the list
 * is capped at roughly five entries until "Show More" is clicked, which this
 * module does once per page visit.
 */
(function () {
  'use strict';

  var g = typeof globalThis !== 'undefined' ? globalThis : window;
  // Re-injection must not run this file twice; see content/beacon.js.
  if (g.__adtOnce && g.__adtOnce('content/modules/sidebar-watch.js')) return;

  g.ADT = g.ADT || {};
  g.ADT.modules = g.ADT.modules || {};
  var D = g.ADT.dom;
  var log = g.ADT.log;

  /** @const {!Array<string>} */
  var CARD_SELECTORS = [
    'a[data-a-target="followed-channel"]',
    'a[data-a-target="side-nav-card"]',
    '.side-nav-card a[href^="/"]',
    'div[class*="side-nav-section"] a[href^="/"]'
  ];

  /**
   * Explicit live indicators only. A loose class match on "live" also hits
   * offline cards, because Twitch renders wrappers carrying that word
   * permanently, and that opened tabs for offline channels.
   * @const {!Array<string>}
   */
  var LIVE_SELECTORS = [
    '[data-a-target="side-nav-live-status"]',
    '.side-nav-card__live-status',
    'div[class*="side-nav-card__live-status"]',
    'span[class*="ScChannelStatusTextIndicator"]'
  ];

  /**
   * Collapsed sidebar: no text, but the avatar carries a live ring.
   * @const {!Array<string>}
   */
  var ONLINE_AVATAR_SELECTORS = [
    '[class*="avatar--online"]',
    '[class*="ScAvatarLive"]',
    '[data-a-target="side-nav-avatar-live"]'
  ];

  /**
   * The "Show More" caption in every shipped UI language. Matched whole.
   * @const {!Array<string>}
   */
  var SHOW_MORE_TEXTS = [
    'Show More', 'Show more',
    'Mehr anzeigen', 'Alle anzeigen',
    'Mostrar más', 'Ver más',
    'Afficher plus', 'Voir plus',
    'Mostra altro', 'Mostra di più',
    'Mostrar mais', 'Ver mais',
    'Pokaż więcej',
    'Показать больше', 'Показать ещё',
    'Daha Fazla Göster', 'Daha fazla göster',
    'もっと見る', 'さらに表示',
    '더 보기',
    '显示更多', '查看更多'
  ];

  /** Twitch system routes that are never channel logins. @const {!Array<string>} */
  var NON_CHANNEL_SEGMENTS = [
    'directory', 'videos', 'settings', 'drops', 'search', 'u', 'p'
  ];

  var state = {
    running: false,
    timer: null,
    expandTimer: null,
    firstTimer: null,
    cfg: null,
    lastSig: ''
  };

  /**
   * @param {?string} href Absolute or root-relative.
   * @return {?string} Lowercase login, or null for system routes.
   */
  function loginFromHref(href) {
    if (!href) return null;
    var m = /^\/([^\/?#]+)/.exec(href.replace(location.origin, ''));
    if (!m) return null;
    var name = m[1].toLowerCase();
    if (NON_CHANNEL_SEGMENTS.indexOf(name) >= 0) return null;
    return name;
  }

  /**
   * @param {!Element} card
   * @return {boolean}
   */
  function isOffline(card) {
    var cls = card.className || '';
    if (/offline/i.test(cls)) return true;
    if (card.querySelector('[class*="avatar--offline"], [class*="Offline"]')) return true;
    return false;
  }

  /**
   * @param {!Element} card
   * @return {boolean}
   */
  function isLive(card) {
    if (isOffline(card)) return false;

    // Expanded: live status element carrying the viewer count as text.
    for (var i = 0; i < LIVE_SELECTORS.length; i++) {
      var el = card.querySelector(LIVE_SELECTORS[i]);
      if (el && D.textOf(el)) return true;
    }
    // Collapsed: explicit online marker on the avatar.
    for (var j = 0; j < ONLINE_AVATAR_SELECTORS.length; j++) {
      if (card.querySelector(ONLINE_AVATAR_SELECTORS[j])) return true;
    }
    return false;
  }

  /**
   * Once per page visit. The sidebar has several "Show More" buttons (followed,
   * recommended, and so on) and React rebuilds them, so without this latch the
   * module clicks in a loop.
   */
  var expanded = false;

  function expandSidebar() {
    if (!state.running || expanded) return;
    var btns = D.buttonsByText(SHOW_MORE_TEXTS);
    if (!btns.length || !D.isVisible(btns[0])) return;
    expanded = true;
    if (D.safeClick(btns[0], 'sidebar-expand')) {
      log.debug('sidebar-watch: list expanded');
    }
  }

  /**
   * @return {{live: !Array<string>, known: !Array<string>}}
   */
  function collect() {
    var cards = D.qaAny(CARD_SELECTORS);
    var live = [];
    var known = [];
    var seen = new Set();

    cards.forEach(function (c) {
      var login = loginFromHref(c.getAttribute('href'));
      if (!login || seen.has(login)) return;
      seen.add(login);
      known.push(login);
      if (isLive(c)) live.push(login);
    });

    return { live: live, known: known };
  }

  function report() {
    if (!state.running) return;
    var r = collect();
    if (!r.known.length) return;  // Sidebar not rendered yet, or logged out.

    var sig = r.live.slice().sort().join(',') + '|' + r.known.length;
    // Report unchanged state occasionally so the popup can show staleness.
    var force = Date.now() % 300000 < 60000;
    if (sig === state.lastSig && !force) return;
    state.lastSig = sig;

    g.ADT.send({
      type: 'adt:live-report',
      live: r.live,
      known: r.known,
      at: Date.now()
    });
    log.debug('sidebar-watch: ' + r.live.length + ' live of ' + r.known.length);
  }

  /** @param {!Object} cfg settings.autoJoin */
  function start(cfg) {
    if (state.running) stop();
    state.cfg = cfg;
    state.running = true;
    state.lastSig = '';
    expanded = false;

    /*
     * Tracked, because this one clicks. `report` checks `state.running` and is
     * harmless once the module is gone, but a pending expand fired four seconds
     * after a channel switch and clicked a button belonging to a module that no
     * longer existed - the one thing no delayed action here is allowed to do.
     */
    state.expandTimer = setTimeout(expandSidebar, 4000);
    state.timer = setInterval(report, Math.max(15, cfg.pollIntervalSec) * 1000);
    state.firstTimer = setTimeout(report, 3000);
    log.debug('sidebar-watch: started');
  }

  function stop() {
    state.running = false;
    if (state.timer) {
      clearInterval(state.timer);
      state.timer = null;
    }
    if (state.expandTimer) {
      clearTimeout(state.expandTimer);
      state.expandTimer = null;
    }
    if (state.firstTimer) {
      clearTimeout(state.firstTimer);
      state.firstTimer = null;
    }
    log.debug('sidebar-watch: stopped');
  }

  g.ADT.modules.sidebarWatch = {
    start: start,
    stop: stop,
    collect: collect,
    report: report
  };
  if (g.__adtLoaded) g.__adtLoaded('content/modules/sidebar-watch.js');
})();
