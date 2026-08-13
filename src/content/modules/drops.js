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

  var state = {
    running: false,
    mode: null,
    timer: null,
    observer: null,
    cfg: null,
    clicked: null,
    lastNotify: 0,
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

  function claimAll() {
    if (!state.running || state.mode !== 'claim' || !state.cfg.autoClaim) return;

    var targets = collectClaimButtons();
    if (!targets.length) return;

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

    if (state.mode === 'claim') {
      state.observer = D.observe(document.body, claimAll, 700);
      state.timer = setInterval(claimAll, 8000);
      D.waitFor(INVENTORY_ROOTS, 20000).then(function () {
        if (state.running) setTimeout(claimAll, 1500);
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
