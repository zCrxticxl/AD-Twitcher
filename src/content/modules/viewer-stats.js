/**
 * @license
 * Copyright 2026 zCrxticxl
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * @fileoverview Viewer metrics.
 *
 * Honest framing, stated the same way in the UI: Twitch publishes an aggregate
 * viewer count and no viewer list. Telling a real viewer from a bought one is
 * not possible from the outside, by anyone, with any method. This module
 * measures observable raw values only: viewer count, chat activity, the ratio
 * between them, and jumps in the viewer curve. That supports a suspicion, never
 * a verdict. Low chat activity is entirely normal for music, chess and
 * watch-party streams, and small channels scatter heavily.
 */
(function () {
  'use strict';

  var g = typeof globalThis !== 'undefined' ? globalThis : window;
  g.ADT = g.ADT || {};
  g.ADT.modules = g.ADT.modules || {};
  var D = g.ADT.dom;
  var log = g.ADT.log;

  /** @const {!Array<string>} */
  var VIEWER_SELECTORS = [
    '[data-a-target="animated-channel-viewers-count"]',
    'p[data-a-target="animated-channel-viewers-count"]',
    'span[data-a-target="animated-channel-viewers-count"]',
    '.live-viewer-count',
    'strong[data-a-target="animated-channel-viewers-count"]'
  ];

  /** @const {!Array<string>} */
  var CHAT_ROOTS = [
    '[data-test-selector="chat-scrollable-area__message-container"]',
    '.chat-scrollable-area__message-container',
    'div[class*="chat-list"] .simplebar-content',
    'section[data-test-selector="chat-room-component-layout"]'
  ];

  /** @const {!Array<string>} */
  var MESSAGE_SELECTORS = [
    '.chat-line__message',
    '[data-a-target="chat-line-message"]',
    'div[class*="chat-line__message"]'
  ];

  /** @const {!Array<string>} */
  var AUTHOR_SELECTORS = [
    '.chat-author__display-name',
    '[data-a-target="chat-message-username"]',
    'span[class*="chat-author__display-name"]'
  ];

  /**
   * Abbreviation suffixes Twitch appends to viewer counts, by locale. Checked
   * largest first so "milhoes" never resolves as "mil".
   * @const {!Array<{rx: !RegExp, mult: number}>}
   */
  var SCALES = [
    { rx: /^(亿|億)$/, mult: 1e8 },
    { rx: /^(万|萬|만)$/, mult: 1e4 },
    { rx: /^(m|mln\.?|mio\.?|млн\.?|milhões|milhoes|millones|百万)$/, mult: 1e6 },
    { rx: /^(k|tys\.?|тыс\.?|mil|bin|천)$/, mult: 1e3 }
  ];

  /** @const {number} Viewer samples older than this are dropped. */
  var SAMPLE_RETENTION_MS = 20 * 60000;

  var state = {
    running: false,
    cfg: null,
    observer: null,
    timer: null,
    msgs: [],             // {t: number, user: string}
    viewerSamples: [],    // {t: number, n: number}
    lastViewers: null,
    seenNodes: null,
    panelEl: null,
    channel: null
  };

  /**
   * Parses a localized viewer count: "1,234", "1.234", "12,3 K", "1.2M",
   * "1,2 tys.", "1.2 man".
   *
   * @param {?string} raw
   * @return {?number} Null when the string carries no digits.
   */
  function parseCount(raw) {
    if (!raw) return null;
    // \s already covers the non-breaking and narrow spaces that fr, ru and pl
    // use as a thousands separator.
    var s = String(raw).replace(/\s+/g, '');
    var m = /(\d[\d.,]*)([^\d.,]*)/.exec(s);
    if (!m) return null;

    var digits = m[1];
    var suffix = (m[2] || '').toLowerCase();
    var mult = 1;
    for (var i = 0; i < SCALES.length; i++) {
      if (SCALES[i].rx.test(suffix)) {
        mult = SCALES[i].mult;
        break;
      }
    }

    if (mult > 1) {
      // With a suffix the separator is a decimal point: "1,2K" or "1.2K".
      var f = parseFloat(digits.replace(',', '.'));
      return isNaN(f) ? null : Math.round(f * mult);
    }
    var n = parseInt(digits.replace(/[.,]/g, ''), 10);
    return isNaN(n) ? null : n;
  }

  /** @return {?number} */
  function readViewers() {
    var el = D.qAny(VIEWER_SELECTORS);
    if (!el) return null;
    return parseCount(D.textOf(el));
  }

  /**
   * @param {!Element} node A chat line.
   * @return {?string} Lowercase display name.
   */
  function authorOf(node) {
    for (var i = 0; i < AUTHOR_SELECTORS.length; i++) {
      var a = node.querySelector(AUTHOR_SELECTORS[i]);
      if (a) return D.textOf(a).toLowerCase();
    }
    return null;
  }

  function harvestChat() {
    var root = D.qAny(CHAT_ROOTS);
    if (!root) return;
    var nodes = D.qaAny(MESSAGE_SELECTORS, root);
    var now = Date.now();
    for (var i = 0; i < nodes.length; i++) {
      var n = nodes[i];
      if (state.seenNodes.has(n)) continue;
      state.seenNodes.add(n);
      var user = authorOf(n);
      if (user) state.msgs.push({ t: now, user: user });
    }
  }

  function prune() {
    if (!state.cfg) return;
    var cutoff = Date.now() - state.cfg.windowMin * 60000;
    while (state.msgs.length && state.msgs[0].t < cutoff) state.msgs.shift();

    var sampleCutoff = Date.now() - SAMPLE_RETENTION_MS;
    while (state.viewerSamples.length && state.viewerSamples[0].t < sampleCutoff) {
      state.viewerSamples.shift();
    }
  }

  function sampleViewers() {
    var n = readViewers();
    if (n == null) return;
    state.lastViewers = n;
    state.viewerSamples.push({ t: Date.now(), n: n });
  }

  /**
   * A jump is a relative change above 30 % within 90 s, at 50 viewers absolute
   * or more. Organic growth is usually flatter, but a raid or a front-page
   * feature produces exactly the same shape. This proves nothing on its own.
   *
   * @return {!Array<{t: number, from: number, to: number, delta: number}>}
   */
  function detectJumps() {
    var out = [];
    var s = state.viewerSamples;
    for (var i = 1; i < s.length; i++) {
      var j = i - 1;
      while (j > 0 && s[i].t - s[j].t < 90000) j--;
      var prev = s[j];
      var cur = s[i];
      if (cur.t - prev.t > 150000) continue;
      var d = cur.n - prev.n;
      if (Math.abs(d) >= 50 && prev.n > 0 && Math.abs(d) / prev.n >= 0.3) {
        out.push({ t: cur.t, from: prev.n, to: cur.n, delta: d });
      }
    }
    // Collapse consecutive reports of the same event.
    return out.filter(function (x, i, arr) {
      return i === 0 || x.t - arr[i - 1].t > 60000;
    }).slice(-6);
  }

  /**
   * @return {!Object} Plain data, safe to post to the popup.
   */
  function snapshot() {
    prune();
    var winMin = state.cfg ? state.cfg.windowMin : 5;
    var users = new Set();
    state.msgs.forEach(function (m) { users.add(m.user); });

    var msgCount = state.msgs.length;
    var oldest = state.msgs.length ? state.msgs[0].t : Date.now();
    var span = Math.max(1, Math.min(winMin, (Date.now() - oldest) / 60000));
    var msgsPerMin = msgCount / span;
    var viewers = state.lastViewers;

    return {
      channel: state.channel,
      windowMin: winMin,
      viewers: viewers,
      messages: msgCount,
      msgsPerMin: Math.round(msgsPerMin * 10) / 10,
      uniqueChatters: users.size,
      // Active chatters per 1000 viewers, the most informative raw ratio.
      chattersPer1k: viewers ? Math.round((users.size / viewers) * 1000 * 10) / 10 : null,
      msgsPerChatter: users.size ? Math.round((msgCount / users.size) * 10) / 10 : null,
      jumps: detectJumps(),
      sampledFor: state.viewerSamples.length
        ? Math.round((Date.now() - state.viewerSamples[0].t) / 60000)
        : 0
    };
  }

  /* ------------------------------------------------------ on-page panel */

  function buildPanel() {
    if (state.panelEl) return;

    var headText = document.createElement('span');
    headText.textContent = g.ADT.msg('panelTitle');

    var close = document.createElement('button');
    close.className = 'adt-panel__close';
    close.type = 'button';
    close.setAttribute('aria-label', g.ADT.msg('panelClose'));
    close.textContent = '×';
    close.addEventListener('click', function () {
      g.ADT.settings.set({ viewerStats: { panel: false } });
    });

    var head = document.createElement('div');
    head.className = 'adt-panel__head';
    head.appendChild(headText);
    head.appendChild(close);

    var body = document.createElement('div');
    body.className = 'adt-panel__body';

    var foot = document.createElement('div');
    foot.className = 'adt-panel__foot';
    foot.textContent = g.ADT.msg('panelFooter');

    var el = document.createElement('div');
    el.className = 'adt-panel';
    el.appendChild(head);
    el.appendChild(body);
    el.appendChild(foot);

    document.body.appendChild(el);
    state.panelEl = el;
  }

  /**
   * @param {string} label
   * @param {string} value
   * @param {string=} hint
   * @return {!Element}
   */
  function row(label, value, hint) {
    var k = document.createElement('span');
    k.className = 'adt-panel__k';
    k.textContent = label;

    var v = document.createElement('span');
    v.className = 'adt-panel__v';
    v.appendChild(document.createTextNode(value));
    if (hint) {
      var em = document.createElement('em');
      em.textContent = hint;
      v.appendChild(em);
    }

    var el = document.createElement('div');
    el.className = 'adt-panel__row';
    el.appendChild(k);
    el.appendChild(v);
    return el;
  }

  function renderPanel() {
    if (!state.panelEl) return;
    var s = snapshot();
    var body = state.panelEl.querySelector('.adt-panel__body');
    var jumpText = s.jumps.length
      ? s.jumps.length + ' x (' + s.jumps.map(function (j) {
        return (j.delta > 0 ? '+' : '') + j.delta;
      }).join(', ') + ')'
      : g.ADT.msg('chipNone');

    body.textContent = '';
    body.appendChild(row(g.ADT.msg('rowViewers'), g.ADT.formatNumber(s.viewers)));
    body.appendChild(row(g.ADT.msg('rowMsgsPerMin'), g.ADT.formatNumber(s.msgsPerMin)));
    body.appendChild(row(g.ADT.msg('rowUniqueChatters'),
      g.ADT.formatNumber(s.uniqueChatters),
      g.ADT.msg('windowMinutes', s.windowMin)));
    body.appendChild(row(g.ADT.msg('rowChattersPer1k'), g.ADT.formatNumber(s.chattersPer1k)));
    body.appendChild(row(g.ADT.msg('rowMsgsPerChatter'), g.ADT.formatNumber(s.msgsPerChatter)));
    body.appendChild(row(g.ADT.msg('rowViewerJumps'), jumpText,
      g.ADT.msg('observedMinutes', s.sampledFor)));
  }

  function syncPanel() {
    if (state.cfg && state.cfg.panel) {
      buildPanel();
      renderPanel();
    } else if (state.panelEl) {
      state.panelEl.remove();
      state.panelEl = null;
    }
  }

  /* ---------------------------------------------------------- lifecycle */

  function tick() {
    if (!state.running) return;
    harvestChat();
    sampleViewers();
    prune();
    syncPanel();
  }

  /** @param {!Object} cfg settings.viewerStats */
  function start(cfg) {
    if (state.running) stop();
    state.cfg = cfg;
    state.running = true;
    state.msgs = [];
    state.viewerSamples = [];
    state.lastViewers = null;
    state.seenNodes = new WeakSet();
    state.channel = D.currentChannel();

    D.waitFor(CHAT_ROOTS, 20000).then(function (root) {
      if (!state.running) return;
      state.observer = D.observe(root || document.body, harvestChat, 500);
    });

    state.timer = setInterval(tick, 5000);
    tick();
    log.debug('viewer-stats: started (' + state.channel + ')');
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
    if (state.panelEl) {
      state.panelEl.remove();
      state.panelEl = null;
    }
    log.debug('viewer-stats: stopped');
  }

  g.ADT.modules.viewerStats = {
    start: start,
    stop: stop,
    snapshot: snapshot,
    isRunning: function () { return state.running; }
  };
  if (g.__adtLoaded) g.__adtLoaded('content/modules/viewer-stats.js');
})();
