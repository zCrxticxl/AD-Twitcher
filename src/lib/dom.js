/**
 * @license
 * Copyright 2026 zCrxticxl
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * @fileoverview DOM helpers and the click guard. Content script only.
 *
 * `safeClick` is the single click path available to modules. Twitch mixes free
 * actions and paid actions inside the same UI, so a selector that is one step
 * too broad ends up buying Power-ups. Every module goes through the money
 * blocklist, the dialog guard and the global click budget defined here.
 */
(function () {
  'use strict';

  /*
   * This has to be globalThis, not window. In Firefox content scripts the
   * sandbox global is not window, so `var g = window` builds a second, half
   * empty ADT object and lib/browser.js becomes invisible from here. Chrome
   * hides the bug because globalThis === window there.
   */
  var g = typeof globalThis !== 'undefined' ? globalThis : window;
  g.ADT = g.ADT || {};

  /**
   * @param {string} sel
   * @param {!Element|!Document=} root
   * @return {?Element}
   */
  function q(sel, root) {
    try {
      return (root || document).querySelector(sel);
    } catch (e) {
      return null;
    }
  }

  /**
   * @param {string} sel
   * @param {!Element|!Document=} root
   * @return {!Array<!Element>}
   */
  function qa(sel, root) {
    try {
      return Array.prototype.slice.call((root || document).querySelectorAll(sel));
    } catch (e) {
      return [];
    }
  }

  /**
   * First hit from a selector list. Twitch renames generated class names
   * regularly, so every lookup carries fallbacks.
   *
   * @param {!Array<string>} selectors
   * @param {!Element|!Document=} root
   * @return {?Element}
   */
  function qAny(selectors, root) {
    for (var i = 0; i < selectors.length; i++) {
      var el = q(selectors[i], root);
      if (el) return el;
    }
    return null;
  }

  /**
   * Union of all selector hits, de-duplicated, in selector order.
   *
   * @param {!Array<string>} selectors
   * @param {!Element|!Document=} root
   * @return {!Array<!Element>}
   */
  function qaAny(selectors, root) {
    var out = [];
    var seen = new Set();
    selectors.forEach(function (s) {
      qa(s, root).forEach(function (el) {
        if (!seen.has(el)) {
          seen.add(el);
          out.push(el);
        }
      });
    });
    return out;
  }

  /**
   * @param {?Element} el
   * @return {boolean}
   */
  function isVisible(el) {
    if (!el || !el.isConnected) return false;
    var r = el.getBoundingClientRect();
    if (r.width === 0 && r.height === 0) return false;
    var cs = getComputedStyle(el);
    return cs.visibility !== 'hidden' && cs.display !== 'none' && cs.opacity !== '0';
  }

  /**
   * @param {?Element} el
   * @return {string}
   */
  function textOf(el) {
    return (el && (el.innerText || el.textContent) || '').trim();
  }

  /**
   * Finds buttons by their visible label. Survives class renames, and it is the
   * only way to match a control whose markup carries no stable attribute.
   *
   * @param {!Array<string|!RegExp>} patterns Plain strings are matched whole,
   *     case-insensitively.
   * @param {!Element|!Document=} root
   * @return {!Array<!Element>}
   */
  function buttonsByText(patterns, root) {
    var rx = patterns.map(function (p) {
      return p instanceof RegExp ? p : new RegExp('^\\s*' + p + '\\s*$', 'i');
    });
    return qa('button, [role="button"]', root).filter(function (b) {
      var t = textOf(b);
      if (!t || t.length > 40) return false;
      return rx.some(function (r) { return r.test(t); });
    });
  }

  /**
   * @param {!Array<string>|string} selectors
   * @param {number=} timeoutMs Defaults to 15000.
   * @return {!Promise<?Element>} Null on timeout.
   */
  function waitFor(selectors, timeoutMs) {
    var list = Array.isArray(selectors) ? selectors : [selectors];
    return new Promise(function (resolve) {
      var found = qAny(list);
      if (found) return resolve(found);
      var done = false;
      var obs = new MutationObserver(function () {
        var el = qAny(list);
        if (el && !done) {
          done = true;
          obs.disconnect();
          resolve(el);
        }
      });
      obs.observe(document.documentElement, { childList: true, subtree: true });
      setTimeout(function () {
        if (!done) {
          done = true;
          obs.disconnect();
          resolve(null);
        }
      }, timeoutMs || 15000);
    });
  }

  /**
   * Throttled subtree observer. Twitch mutates constantly; an unthrottled
   * callback costs measurable CPU on a busy channel.
   *
   * @param {?Element} target Defaults to document.body.
   * @param {function()} cb
   * @param {number=} throttleMs Defaults to 300.
   * @param {!MutationObserverInit=} options Additional observer options. The
   *     defaults remain child-list only so busy Twitch attributes do not wake
   *     unrelated modules.
   * @return {!MutationObserver}
   */
  function observe(target, cb, throttleMs, options) {
    var pending = false;
    var wait = throttleMs || 300;
    var obs = new MutationObserver(function () {
      if (pending) return;
      pending = true;
      setTimeout(function () {
        pending = false;
        cb();
      }, wait);
    });
    obs.observe(target || document.body, Object.assign(
      { childList: true, subtree: true }, options || {}));
    return obs;
  }

  /* -------------------------------------------------------- click guard */

  /**
   * Money-adjacent wording in every locale the extension ships. A label that
   * matches is never clicked, whatever selector produced it.
   *
   * "Claim", "Einlösen", "Reclamar" and their siblings are deliberately absent:
   * those also label the harmless bonus chest.
   *
   * @const {!RegExp}
   */
  var DANGER_RX = new RegExp([
    // Locale independent
    'bits', 'power[\\s-]?up', 'powerup', 'cheer', 'hype\\s?train', 'gigantify',
    'celebration', 'turbo', 'prime',
    // en
    'buy', 'purchase', 'checkout', 'donate', 'subscribe', 'subscription',
    'resub', 'gift', 'upgrade', 'balance',
    // de
    'kaufen', 'bezahlen', 'spenden', 'abonnieren', 'geschenk', 'verschenken',
    'guthaben', 'los\\s?geht',
    // es
    'comprar', 'pagar', 'donar', 'suscri', 'regal', 'saldo',
    // fr
    'acheter', 'payer', 'faire un don', 'abonner', 'abonnement', 'cadeau',
    'offrir', 'solde',
    // it
    'acquist', 'compra', 'pagare', 'donare', 'abbona', 'regalo', 'regala',
    // pt-BR
    'pagamento', 'doar', 'inscrever', 'inscrição', 'presente', 'presentear',
    // pl
    'kup', 'zapła', 'wesprzyj', 'subskry', 'prezent', 'podaruj',
    // ru
    'купить', 'оплат', 'пожертв', 'подпис', 'подар', 'баланс',
    // tr
    'satın al', 'ödeme', 'bağış', 'abone', 'hediye', 'bakiye',
    // ja
    '購入', '支払', '寄付', 'ギフト', 'プレゼント', '残高',
    // ko
    '구매', '결제', '후원', '구독', '선물', '잔액',
    // zh-CN
    '购买', '支付', '打赏', '订阅', '赠送', '礼物', '余额'
  ].join('|'), 'i');

  /** @const {string} */
  var MODAL_SELECTOR = [
    '[role="dialog"]', '[role="alertdialog"]', '.ReactModal__Content',
    '[data-a-target*="modal" i]', '[class*="modal" i]', '[data-a-target*="bits" i]'
  ].join(',');

  /**
   * Everything that identifies an element to a human reader or to the guard.
   *
   * @param {!Element} el
   * @return {string}
   */
  function clickLabel(el) {
    return [
      textOf(el),
      el.getAttribute && el.getAttribute('aria-label'),
      el.getAttribute && el.getAttribute('data-a-target'),
      el.getAttribute && el.getAttribute('data-test-selector')
    ].filter(Boolean).join(' ');
  }

  /**
   * @param {?Element} el
   * @return {boolean} True also for null, so a lost node is never clicked.
   */
  function isDangerous(el) {
    if (!el) return true;
    if (DANGER_RX.test(clickLabel(el))) return true;
    // The container counts too: a "Yes" button inside a Bits dialog is unsafe.
    var box = el.closest && el.closest('[data-a-target], [data-test-selector]');
    if (box && box !== el && DANGER_RX.test(
      (box.getAttribute('data-a-target') || '') + ' ' +
      (box.getAttribute('data-test-selector') || ''))) {
      return true;
    }
    return false;
  }

  /**
   * @param {!Element} el
   * @return {boolean}
   */
  function inModal(el) {
    try {
      return !!(el.closest && el.closest(MODAL_SELECTOR));
    } catch (e) {
      return false;
    }
  }

  /*
   * Emergency brake against runaway clicking. React rebuilds nodes, so
   * per-element "already clicked" marks can silently stop applying. The budget
   * is global and hard.
   *
   * Every permitted click is recorded with its reason and label. Without that,
   * a tripped budget only says "something clicks too much".
   */
  var clicks = [];
  var tripped = false;

  /** @const {number} */
  var BUDGET_PER_MIN = 10;

  /**
   * @param {!Element} el
   * @return {string}
   */
  function describe(el) {
    var tag = el.tagName ? el.tagName.toLowerCase() : '?';
    var cls = String(el.className || '').split(/\s+/).slice(0, 2).join('.');
    return tag + (cls ? '.' + cls : '') + ' "' + clickLabel(el).slice(0, 40) + '"';
  }

  /** @return {boolean} */
  function budgetOk() {
    var now = Date.now();
    while (clicks.length && now - clicks[0].t > 60000) clicks.shift();
    if (clicks.length < BUDGET_PER_MIN) return true;

    if (!tripped) {
      tripped = true;
      var byReason = {};
      clicks.forEach(function (c) { byReason[c.reason] = (byReason[c.reason] || 0) + 1; });
      var summary = Object.keys(byReason).map(function (k) {
        return k + ' x' + byReason[k];
      }).join(', ');

      g.ADT.log.error('Click budget reached (' + BUDGET_PER_MIN +
        '/min), automation halted. Sources: ' + summary);
      clicks.slice(-BUDGET_PER_MIN).forEach(function (c, i) {
        g.ADT.log.error('  #' + (i + 1) + ' [' + c.reason + '] ' + c.what);
      });
      toast(g.ADT.msg('toastClickBudget'));
    }
    return false;
  }

  /**
   * The only click path modules are allowed to use. humanClick is private by
   * design: it bypasses all three guards.
   *
   * @param {?Element} el
   * @param {string=} reason Module name, shows up in the log.
   * @return {boolean} True if the click was dispatched.
   */
  function safeClick(el, reason) {
    reason = reason || '?';
    if (!el || !el.isConnected) return false;
    if (!budgetOk()) return false;

    if (isDangerous(el)) {
      g.ADT.log.warn('Click blocked (money) [' + reason + ']: ' + describe(el));
      return false;
    }
    if (inModal(el)) {
      g.ADT.log.warn('Click blocked (dialog) [' + reason + ']: ' + describe(el));
      return false;
    }

    var what = describe(el);
    clicks.push({ t: Date.now(), reason: reason, what: what });
    g.ADT.log.debug('Click [' + reason + '] ' + what +
      '  (' + clicks.length + '/' + BUDGET_PER_MIN + ' per min)');
    return humanClick(el);
  }

  /**
   * Full pointer and mouse cycle instead of a bare .click(). Some React
   * handlers listen on pointerdown or mouseup and ignore the click event.
   *
   * @param {?Element} el
   * @return {boolean}
   * @private
   */
  function humanClick(el) {
    if (!el) return false;
    var r = el.getBoundingClientRect();
    var x = r.left + r.width / 2 + (Math.random() * 4 - 2);
    var y = r.top + r.height / 2 + (Math.random() * 4 - 2);
    var opts = {
      bubbles: true, cancelable: true, view: window,
      clientX: x, clientY: y, button: 0
    };

    try {
      if (typeof PointerEvent === 'function') {
        el.dispatchEvent(new PointerEvent('pointerover', opts));
        el.dispatchEvent(new PointerEvent('pointerdown', opts));
      }
      el.dispatchEvent(new MouseEvent('mouseover', opts));
      el.dispatchEvent(new MouseEvent('mousedown', opts));
      el.dispatchEvent(new MouseEvent('mouseup', opts));
      if (typeof PointerEvent === 'function') {
        el.dispatchEvent(new PointerEvent('pointerup', opts));
      }
      // HTMLElement.click() is the single activation event. Dispatching a
      // synthetic click and then calling click() activates React handlers twice.
      if (typeof el.click === 'function') el.click();
      return true;
    } catch (e) {
      try {
        el.click();
        return true;
      } catch (e2) {
        return false;
      }
    }
  }

  /**
   * @param {string} text
   * @param {number=} ms Visible duration, defaults to 2600.
   */
  function toast(text, ms) {
    var host = document.getElementById('adt-toast-host');
    if (!host) {
      host = document.createElement('div');
      host.id = 'adt-toast-host';
      document.body.appendChild(host);
    }
    var el = document.createElement('div');
    el.className = 'adt-toast';
    el.textContent = text;
    host.appendChild(el);
    setTimeout(function () {
      el.classList.add('adt-toast--out');
      setTimeout(function () { el.remove(); }, 300);
    }, ms || 2600);
  }

  /**
   * Twitch system routes. Never channel logins, whatever the URL looks like.
   * @const {!Set<string>}
   */
  var NON_CHANNEL = new Set([
    'directory', 'videos', 'settings', 'drops', 'downloads', 'jobs', 'p',
    'subscriptions', 'inventory', 'wallet', 'friends', 'search', 'u',
    'popout', 'moderator', 'store', 'turbo', 'prime', 'following', ''
  ]);

  /**
   * @return {?string} Lowercase channel login, or null off a channel page.
   */
  function currentChannel() {
    var seg = location.pathname.split('/').filter(Boolean);
    if (!seg.length) return null;
    if (NON_CHANNEL.has(seg[0].toLowerCase())) return null;
    if (seg.length > 1 && seg[1] !== 'home') return null;
    return seg[0].toLowerCase();
  }

  /**
   * Twitch is a single-page app: pushState and replaceState fire no popstate.
   * The interval is a fallback for the case where Twitch replaces the history
   * methods after we patched them.
   *
   * @param {function(string)} cb Receives the new pathname.
   */
  function onRouteChange(cb) {
    var last = location.pathname;

    function fire() {
      if (location.pathname === last) return;
      last = location.pathname;
      cb(last);
    }

    ['pushState', 'replaceState'].forEach(function (m) {
      var orig = history[m];
      history[m] = function () {
        var r = orig.apply(this, arguments);
        setTimeout(fire, 0);
        return r;
      };
    });
    window.addEventListener('popstate', fire);
    setInterval(fire, 1500);
  }

  g.ADT.dom = {
    q: q, qa: qa, qAny: qAny, qaAny: qaAny,
    isVisible: isVisible, textOf: textOf, buttonsByText: buttonsByText,
    waitFor: waitFor, observe: observe,
    safeClick: safeClick,          // The only click path for modules.
    isDangerous: isDangerous, inModal: inModal,
    resetClickBudget: function () { clicks = []; tripped = false; },
    clickHistory: function () { return clicks.slice(); },
    toast: toast, currentChannel: currentChannel, onRouteChange: onRouteChange
  };

  if (g.__adtLoaded) g.__adtLoaded('lib/dom.js');
})();
