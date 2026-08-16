/**
 * @license
 * Copyright 2026 zCrxticxl
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * @fileoverview Drops. Two strictly separated modes, selected by route:
 *
 *   /drops/inventory  CLAIMER. The only place a click can happen.
 *   everywhere else   WATCHER. Read-only. Detects the "drop unlocked" toast
 *                     and tells the background to open the inventory.
 *
 * Rationale: drops are only redeemable on the inventory page. A text scan for
 * "Claim" on channel pages used to hit channel point rewards and Power-ups,
 * which cost Bits. Outside /drops/ there is no click path left at all, not
 * even a narrow one.
 *
 * Progress itself is still counted server-side from player heartbeats. This
 * module claims drops, it does not farm them.
 */
(function () {
  'use strict';

  var g = typeof globalThis !== 'undefined' ? globalThis : window;
  g.ADT = g.ADT || {};
  g.ADT.modules = g.ADT.modules || {};
  var D = g.ADT.dom;
  var log = g.ADT.log;

  /* ------------------------------------- claimer, /drops/inventory only */

  /** @const {!Array<string>} */
  var INVENTORY_ROOTS = [
    '[data-test-selector="drops-inventory"]',
    'div[class*="inventory-page"]',
    'div[class*="drops-root"]'
  ];

  /** @const {!Array<string>} */
  var CLAIM_SELECTORS = [
    'button[data-test-selector*="claim" i]',
    'button[data-a-target*="claim" i]'
  ];

  /** Button captions in every shipped UI locale. @const {!Object<string, !Array<string>>} */
  var CLAIM_TEXTS_BY_LOCALE = {
    en: [
      'Claim', 'Claim Now', 'Claim Reward', 'Collect', 'Collect Now',
      'Redeem', 'Redeem Now'
    ],
    de: [
      'Einlösen', 'Einloesen', 'Jetzt einlösen', 'Belohnung einlösen',
      'Abholen', 'Jetzt abholen', 'Belohnung abholen'
    ],
    es: [
      'Reclamar', 'Reclamar ahora', 'Reclamar recompensa',
      'Canjear', 'Canjear ahora'
    ],
    fr: [
      'Réclamer', 'Réclamer maintenant', 'Réclamer la récompense',
      'Récupérer', 'Récupérer maintenant'
    ],
    it: [
      'Riscatta', 'Riscatta ora', 'Riscatta ricompensa',
      'Ritira', 'Ritira ora'
    ],
    pt_BR: [
      'Resgatar', 'Resgatar agora', 'Resgatar recompensa',
      'Coletar', 'Coletar agora'
    ],
    pl: [
      'Odbierz', 'Odbierz teraz', 'Odbierz nagrodę',
      'Zgarnij', 'Zgarnij teraz'
    ],
    ru: [
      'Получить', 'Получить сейчас', 'Получить награду',
      'Забрать', 'Забрать сейчас'
    ],
    tr: [
      'Talep Et', 'Şimdi Talep Et', 'Ödülü Talep Et',
      'Al', 'Şimdi Al'
    ],
    ja: [
      '受け取る', '今すぐ受け取る', '報酬を受け取る',
      '獲得', '今すぐ獲得'
    ],
    ko: [
      '받기', '지금 받기', '보상 받기',
      '수령', '지금 수령'
    ],
    zh_CN: [
      '领取', '立即领取', '现在领取', '领取奖励'
    ]
  };

  /** @const {!Array<string>} */
  var CLAIM_TEXTS = Object.keys(CLAIM_TEXTS_BY_LOCALE).reduce(function (all, locale) {
    return all.concat(CLAIM_TEXTS_BY_LOCALE[locale]);
  }, []);

  /* ---------------------------------- watcher, everywhere else, read-only */

  /** @const {!Array<string>} */
  var NOTIFY_ROOTS = [
    '[data-test-selector="onsite-notifications"]',
    'div[class*="onsite-notification"]',
    '[data-a-target*="onsite-notification" i]',
    'div[class*="toast"]',
    '[data-test-selector*="Drop" i]'
  ];

  /** The word "drop" itself, per script. @const {string} */
  var DROP_WORD = [
    'drop',           // en, de, es, fr, it, pt-BR, pl, tr
    'дроп',           // ru
    'ドロップ',           // ja
    '드롭',             // ko
    '掉宝', '掉落'      // zh-CN
  ].join('|');

  /** Wording that marks a drop as ready. @const {string} */
  var UNLOCK_WORD = [
    // en
    'unlocked', 'earned', 'ready', 'available',
    // de
    'freigeschaltet', 'erhalten', 'abholbereit', 'verfügbar', 'verfuegbar',
    // es
    'desbloquead', 'disponible', 'consegui',
    // fr
    'débloqué', 'debloque', 'disponible', 'obtenu',
    // it
    'sbloccat', 'disponibil', 'ottenut',
    // pt-BR
    'desbloquead', 'disponível', 'conquistad',
    // pl
    'odblokowan', 'dostępn', 'zdobyt',
    // ru
    'разблокирован',
    'получен', 'доступен',
    // tr
    'açıldı', 'kazanıldı', 'hazır',
    // ja
    '獲得', '受け取り', '解除',
    // ko
    '획득', '잠금 해제', '받을 수',
    // zh-CN
    '已解锁', '可领取', '已获得'
  ].join('|');

  /**
   * Drop word and unlock word within 40 characters of each other, in either
   * order. Deliberately loose: this only triggers a read, never a click.
   * @const {!RegExp}
   */
  var NOTIFY_RX = new RegExp(
    '(' + DROP_WORD + ').{0,40}(' + UNLOCK_WORD + ')|' +
    '(' + UNLOCK_WORD + ').{0,40}(' + DROP_WORD + ')', 'i');

  /** @const {number} Minimum gap between two notification reports. */
  var NOTIFY_DEBOUNCE_MS = 120000;

  /* ------------------------------------------------- inventory freshness */

  /*
   * Twitch renders the inventory once, from data it fetched while the page was
   * loading, and never refetches it on its own. A tab that has been sitting
   * open therefore keeps showing the state from back then: a drop that finished
   * in the meantime has no claim button anywhere in this DOM, and no amount of
   * scanning produces one. That is the whole reason claiming used to require a
   * manual F5. Only a reload brings the button into existence.
   */

  /** @const {number} Below this age the view is trusted to be current. */
  var STALE_VIEW_MS = 45000;

  /** @const {number} A hidden inventory tab is refreshed once it gets this old. */
  var VIEW_MAX_AGE_MS = 15 * 60000;

  /** @const {number} How often the age above is evaluated. */
  var FRESHNESS_TICK_MS = 60000;

  /* -------------------------------------------------------- drop progress */

  /*
   * The inventory page already prints how far every drop has come. Reading it
   * costs nothing and answers the question the counters cannot: how much longer
   * this is going to take.
   *
   * The caption is localized and its word order differs - "85% of 4 hours" in
   * English, "4 時間中 85%" in Japanese - so nothing here tries to understand the
   * sentence. The number carrying the percent sign is the progress, the other
   * number is the requirement. That holds in all twelve languages Twitch ships.
   */

  /** @const {number} Captions are short; anything longer is prose, not a value. */
  var PROGRESS_TEXT_MAX = 60;

  /** @const {number} Kept per report, so one huge inventory cannot flood storage. */
  var MAX_PROGRESS_ITEMS = 8;

  /** @const {number} How often a snapshot is sent while the page stays open. */
  var PROGRESS_TICK_MS = 120000;

  /**
   * Twitch's own progress bar. `role` is the load-bearing one; the class is a
   * component name that has outlived several redesigns, kept as a fallback.
   * @const {!Array<string>}
   */
  var PROGRESS_BAR_SELECTORS = ['[role="progressbar"]', '.tw-progress-bar'];

  /** @const {number} Ancestors searched for the caption next to a bar. */
  var CAPTION_LOOKUP_DEPTH = 2;

  /** @const {number} Ancestors searched for the drop's name. */
  var CARD_LOOKUP_DEPTH = 3;

  /** @const {number} Longer than this is a sentence, not a drop name. */
  var NAME_MAX = 40;

  /**
   * @param {string} text A progress caption.
   * @return {?{percent: number, hours: number}} Null when the text carries no
   *     percentage, which is most of the page.
   */
  function parseProgress(text) {
    // \s already matches the no-break space Twitch puts before the percent
    // sign in German and French, so the caption needs no cleaning first.
    var clean = String(text || '');
    // Turkish puts the sign in front of the number, most locales behind it.
    var pct = clean.match(/(\d+(?:[.,]\d+)?)\s*%|%\s*(\d+(?:[.,]\d+)?)/);
    if (!pct) return null;

    var raw = pct[1] !== undefined ? pct[1] : pct[2];
    var percent = Number(raw.replace(',', '.'));
    if (!isFinite(percent) || percent < 0 || percent > 100) return null;

    var rest = (clean.slice(0, pct.index) + ' ' +
      clean.slice(pct.index + pct[0].length)).match(/\d+(?:[.,]\d+)?/g) || [];
    var hours = rest.length ? Number(rest[0].replace(',', '.')) : 0;
    if (!isFinite(hours) || hours <= 0) hours = 0;

    return { percent: percent, hours: hours };
  }

  /**
   * The percentage does not have to be read out of text at all: Twitch renders
   * each drop with a real ARIA progress bar. That is a number, in every
   * language, and it stays correct when the caption is rewritten.
   *
   * @param {!Element} bar
   * @return {?number} 0..100, or null when the bar carries no value.
   */
  function barPercent(bar) {
    var now = Number(bar.getAttribute('aria-valuenow'));
    if (!isFinite(now)) return null;
    var max = Number(bar.getAttribute('aria-valuemax'));
    if (!isFinite(max) || max <= 0) max = 100;
    return Math.max(0, Math.min(100, (now / max) * 100));
  }

  /**
   * The caption sits next to the bar and is the only place the requirement
   * appears: "10 % von 1 Stunde". Twitch splits the number into its own span,
   * so this reads the container's text rather than a leaf.
   *
   * @param {!Element} bar
   * @return {string}
   */
  function captionNear(bar) {
    var node = bar.parentElement;
    for (var up = 0; up < CAPTION_LOOKUP_DEPTH && node; up++) {
      var nodes = node.querySelectorAll('p, span, div');
      for (var i = 0; i < nodes.length; i++) {
        var text = (nodes[i].textContent || '').trim();
        if (text && text.length <= PROGRESS_TEXT_MAX && text.indexOf('%') >= 0) {
          return text;
        }
      }
      node = node.parentElement;
    }
    return '';
  }

  /**
   * The drop's name is the last short label before its bar. Going by position
   * rather than by class name survives Twitch regenerating those, and skips the
   * longer status sentences that share the card.
   *
   * @param {!Element} bar
   * @return {string} '' when nothing name-shaped precedes the bar.
   */
  function cardName(bar) {
    var card = bar.parentElement;
    for (var up = 0; up < CARD_LOOKUP_DEPTH && card; up++) {
      var nodes = card.querySelectorAll('p, span, h1, h2, h3, h4, h5');
      var found = '';
      for (var i = 0; i < nodes.length; i++) {
        var el = nodes[i];
        // 4 is DOCUMENT_POSITION_FOLLOWING: stop once the bar is no longer
        // ahead of the candidate, so the caption itself cannot win.
        if (el.compareDocumentPosition &&
            !(el.compareDocumentPosition(bar) & 4)) break;
        var text = (el.textContent || '').trim();
        if (!text || text.length > NAME_MAX || text.indexOf('%') >= 0) continue;
        found = text;
      }
      if (found) return found;
      card = card.parentElement;
    }
    return '';
  }

  /**
   * @return {!Array<!Object>} One entry per drop in progress.
   */
  function collectProgress() {
    if (state.mode !== 'claim') return [];
    var root = D.qAny(INVENTORY_ROOTS) || document.body;
    var bars = root.querySelectorAll(PROGRESS_BAR_SELECTORS.join(','));
    var out = [];
    var seen = [];

    for (var i = 0; i < bars.length && out.length < MAX_PROGRESS_ITEMS; i++) {
      var bar = bars[i];
      if (seen.indexOf(bar) >= 0) continue;     // Both selectors can hit one bar.
      seen.push(bar);

      var caption = captionNear(bar);
      var parsed = parseProgress(caption);
      var percent = barPercent(bar);
      if (percent === null && parsed) percent = parsed.percent;
      if (percent === null) continue;

      out.push({
        name: cardName(bar),
        percent: percent,
        hours: parsed ? parsed.hours : 0
      });
    }
    return out;
  }

  /** Sends the current progress snapshot, if the page has one. */
  function reportProgress() {
    if (!state.running || state.mode !== 'claim') return;
    var items = collectProgress();
    if (!items.length) return;
    g.ADT.send({ type: 'adt:drops-progress', items: items });
  }

  var state = {
    running: false,
    mode: null,
    timer: null,
    freshTimer: null,
    progressTimer: null,
    observer: null,
    cfg: null,
    clicked: null,
    lastNotify: 0,
    viewLoadedAt: 0,
    pendingTimers: []
  };

  /** @return {boolean} */
  function onInventoryPage() {
    return /^\/drops\/inventory/.test(location.pathname);
  }

  /** @return {!Array<!Element>} */
  function collectClaimButtons() {
    // Twitch occasionally removes the inventory wrapper. The route remains the
    // hard boundary; only then may exact claim labels be scanned document-wide.
    if (!onInventoryPage()) return [];
    var root = D.qAny(INVENTORY_ROOTS) || document.body;

    var byAttr = D.qaAny(CLAIM_SELECTORS, root);
    var byText = D.buttonsByText(CLAIM_TEXTS, root);

    var seen = new Set();
    return byAttr.concat(byText).filter(function (b) {
      if (seen.has(b)) return false;
      seen.add(b);
      if (b.disabled || b.getAttribute('aria-disabled') === 'true') return false;
      if (state.clicked.has(b)) return false;
      if (!D.isVisible(b)) return false;
      if (D.isDangerous(b) || D.inModal(b)) return false;
      return true;
    });
  }

  /** @return {boolean} True when a reload could still reveal new claim buttons. */
  function viewIsStale() {
    return state.mode === 'claim' &&
      Date.now() - state.viewLoadedAt > STALE_VIEW_MS;
  }

  /**
   * @return {{mode: string, pending: number, stale: boolean}} What the caller
   *     needs to decide whether this page is worth reloading: how many claims
   *     are running, and whether the view is old enough to be hiding one.
   */
  function claimAll() {
    var report = {
      mode: state.mode || 'off',
      pending: 0,
      stale: viewIsStale()
    };
    if (!state.running || state.mode !== 'claim' || !state.cfg.autoClaim) return report;

    var targets = collectClaimButtons();
    if (!targets.length) return report;
    report.pending = targets.length;

    // Sequential with spacing: Twitch rebuilds the grid after every claim.
    targets.forEach(function (btn, i) {
      state.clicked.add(btn);
      var timer = setTimeout(function () {
        state.pendingTimers = state.pendingTimers.filter(function (id) { return id !== timer; });
        if (!state.running || state.mode !== 'claim' || !onInventoryPage()) return;
        if (!btn.isConnected || !D.isVisible(btn)) return;
        if (!D.safeClick(btn, 'drops')) return;
        log.info('Drop claimed: ' + (D.textOf(btn) || 'unnamed'));
        g.ADT.countStat('dropsClaimed');
        D.toast(g.ADT.msg('toastDropClaimed'));
      }, g.ADT.jitter(700 + i * 1400, 800));
      state.pendingTimers.push(timer);
    });
    return report;
  }

  /**
   * Keeps a parked inventory tab current. Reloading is only acceptable while
   * nobody is looking at the page and no claim is in flight, so this waits for
   * a hidden tab and skips the moment a click is pending.
   */
  function refreshStaleView() {
    if (!state.running || state.mode !== 'claim') return;
    if (!state.cfg.refreshInventory || !state.cfg.autoClaim) return;
    if (state.pendingTimers.length) return;
    if (document.visibilityState !== 'hidden') return;
    if (Date.now() - state.viewLoadedAt < VIEW_MAX_AGE_MS) return;
    if (collectClaimButtons().length) return;   // Claim first, reload later.

    log.info('Inventory view is stale, reloading in the background');
    location.reload();
  }

  /** Read-only. No click, no DOM mutation. */
  function watchNotifications() {
    if (!state.running || state.mode !== 'watch') return;
    if (Date.now() - state.lastNotify < NOTIFY_DEBOUNCE_MS) return;

    var hit = null;
    D.qaAny(NOTIFY_ROOTS).forEach(function (root) {
      if (hit || !D.isVisible(root)) return;
      var t = D.textOf(root);
      if (t && t.length < 400 && NOTIFY_RX.test(t)) hit = t;
    });
    if (!hit) return;

    state.lastNotify = Date.now();
    log.info('Drop notification detected, inventory will be checked');
    g.ADT.send({ type: 'adt:drop-unlocked', text: hit.slice(0, 120) });
  }

  /** @param {!Object} cfg settings.drops */
  function start(cfg) {
    if (state.running) stop();
    state.cfg = cfg;
    state.running = true;
    state.clicked = new WeakSet();
    state.mode = onInventoryPage() ? 'claim' : 'watch';
    state.viewLoadedAt = Date.now();

    if (state.mode === 'claim') {
      state.observer = D.observe(document.body, claimAll, 700);
      state.timer = setInterval(claimAll, 8000);
      state.freshTimer = setInterval(refreshStaleView, FRESHNESS_TICK_MS);
      state.progressTimer = setInterval(reportProgress, PROGRESS_TICK_MS);
      D.waitFor(INVENTORY_ROOTS, 20000).then(function () {
        if (!state.running) return;
        setTimeout(claimAll, 1500);
        // The grid is up by now, so this is the first honest reading.
        setTimeout(reportProgress, 2500);
      });
      log.debug('drops: claim mode (inventory)');
      return;
    }

    if (!cfg.watchNotifications) {
      log.debug('drops: watcher disabled');
      return;
    }
    state.observer = D.observe(document.body, watchNotifications, 1500);
    state.timer = setInterval(watchNotifications, 20000);
    log.debug('drops: watch mode (read-only)');
  }

  function stop() {
    state.running = false;
    state.mode = null;
    if (state.timer) {
      clearInterval(state.timer);
      state.timer = null;
    }
    if (state.freshTimer) {
      clearInterval(state.freshTimer);
      state.freshTimer = null;
    }
    if (state.observer) {
      state.observer.disconnect();
      state.observer = null;
    }
    state.pendingTimers.forEach(clearTimeout);
    state.pendingTimers = [];
    log.debug('drops: stopped');
  }

  g.ADT.modules.drops = {
    start: start,
    stop: stop,
    claimNow: claimAll,
    onInventoryPage: onInventoryPage
  };
  if (g.__adtLoaded) g.__adtLoaded('content/modules/drops.js');
})();
