#!/usr/bin/env node
/**
 * @license
 * Copyright 2026 zCrxticxl
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * @fileoverview Logic tests. Pure functions are lifted out of the extension
 * sources and executed in a VM context, so no build step and no test framework
 * are involved.
 */
import { readFileSync, readdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import vm from 'node:vm';

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
const read = (p) => readFileSync(join(ROOT, p), 'utf8');

let pass = 0;
let fail = 0;

const eq = (name, got, want) => {
  const a = JSON.stringify(got);
  const b = JSON.stringify(want);
  if (a === b) {
    pass++;
    console.log('  ok   ' + name + ' = ' + a);
  } else {
    fail++;
    console.log('  FAIL ' + name + ' got ' + a + ' want ' + b);
  }
};

/**
 * Extracts a source fragment and evaluates it in a fresh context.
 * @param {string} source
 * @param {!RegExp} pattern
 * @param {string} tail Expression appended after the fragment.
 * @param {!Object=} context
 * @return {*}
 */
function evalFragment(source, pattern, tail, context = {}) {
  const m = source.match(pattern);
  if (!m) throw new Error('fragment not found: ' + pattern);
  return vm.runInNewContext(m[0] + '\n' + tail, context);
}

/* ------------------------------------------- storage: merge and signature */
{
  const sandbox = {
    globalThis: null,
    console,
    chrome: {
      storage: {
        local: { get: () => Promise.resolve({}), set: () => Promise.resolve() },
        onChanged: { addListener() {} }
      }
    }
  };
  sandbox.globalThis = sandbox;
  sandbox.self = sandbox;
  vm.createContext(sandbox);
  vm.runInContext(read('src/lib/browser.js'), sandbox);
  vm.runInContext(read('src/lib/log.js'), sandbox);
  vm.runInContext(read('src/lib/storage.js'), sandbox);
  const S = sandbox.ADT.settings;

  console.log('\n[deepMerge]');
  eq('nested patch touches only its target key',
    S.deepMerge({ a: { x: 1, y: 2 }, b: 3 }, { a: { y: 9 } }), { a: { x: 1, y: 9 }, b: 3 });
  eq('arrays are replaced, not merged',
    S.deepMerge({ c: [1, 2, 3] }, { c: ['x'] }), { c: ['x'] });
  eq('undefined leaves the value alone',
    S.deepMerge({ a: 1 }, { a: undefined }), { a: 1 });
  eq('false is taken over, not treated as empty',
    S.deepMerge({ a: true }, { a: false }), { a: false });
  eq('defaults cover every module',
    Object.keys(S.DEFAULTS).sort(),
    ['adMute', 'autoJoin', 'channelPoints', 'drops', 'enabled', 'logLevel',
      'viewerStats', 'watchHealth'].sort());

  // Counters must not live in settings. While they did, every bump fired
  // storage.onChanged -> apply() -> restart -> the module saw the same ad or
  // chest again -> bumped again.
  eq('DEFAULTS carries no stats block', 'stats' in S.DEFAULTS, false);
  eq('getStats exists', typeof S.getStats, 'function');

  console.log('\n[configSig]');
  const base = S.DEFAULTS;
  const bumped = S.deepMerge(base, { stats: { pointsClaimed: 42 } });
  const changed = S.deepMerge(base, { drops: { checkIntervalMin: 30 } });
  eq('a stat bump leaves the signature alone', S.configSig(base) === S.configSig(bumped), true);
  eq('a config change moves the signature', S.configSig(base) !== S.configSig(changed), true);
}

/* ------------------------------------------------- i18n helper in browser.js */
{
  const catalog = JSON.parse(read('src/_locales/en/messages.json'));
  const sandbox = {
    globalThis: null,
    console,
    chrome: {
      runtime: { getManifest: () => ({ manifest_version: 3 }) },
      i18n: {
        getUILanguage: () => 'de-DE',
        getMessage: (key, subs) => {
          const entry = catalog[key];
          if (!entry) return '';
          return (subs || []).reduce(
            (acc, v, i) => acc.split('$' + (i + 1)).join(String(v)),
            entry.message);
        }
      }
    }
  };
  sandbox.globalThis = sandbox;
  sandbox.self = sandbox;
  vm.createContext(sandbox);
  vm.runInContext(read('src/lib/browser.js'), sandbox);
  const A = sandbox.ADT;

  console.log('\n[i18n]');
  eq('plain lookup', A.msg('tabStatus'), 'Status');
  eq('single substitution', A.msg('pageChannel', 'shroud'), 'Channel: shroud');
  eq('positional substitutions', A.msg('statusFilesLoaded', [9, 11]), '9 of 11 files loaded');
  eq('unknown key falls back to the key', A.msg('doesNotExist'), 'doesNotExist');
  eq('UI locale is picked up', A.uiLocale, 'de-DE');
  eq('numbers follow the UI locale',
    A.formatNumber(1234567), (1234567).toLocaleString('de-DE'));
  eq('null renders as a dash', A.formatNumber(null), '-');
  eq('explicit fallback wins', A.formatNumber(null, 'n/a'), 'n/a');
}

/* --------------------------------------------- viewer-stats: parseCount */
{
  const src = read('src/content/modules/viewer-stats.js');
  const parseCount = evalFragment(
    src,
    /var SCALES = \[[\s\S]*?\n {2}\];[\s\S]*?function parseCount[\s\S]*?\n {2}\}/,
    'parseCount;');

  console.log('\n[parseCount]');
  eq('"1.234"', parseCount('1.234'), 1234);
  eq('"12,345"', parseCount('12,345'), 12345);
  eq('"1,2K"', parseCount('1,2K'), 1200);
  eq('"1.2K"', parseCount('1.2K'), 1200);
  eq('"3M"', parseCount('3M'), 3000000);
  eq('"847 viewers"', parseCount('847 viewers'), 847);
  eq('"847 Zuschauer"', parseCount('847 Zuschauer'), 847);
  eq('fr narrow space "12 400"', parseCount('12 400'), 12400);
  eq('ru "1,2 тыс."', parseCount('1,2 тыс.'), 1200);
  eq('pl "3,4 tys."', parseCount('3,4 tys.'), 3400);
  eq('pt "1,5 mil"', parseCount('1,5 mil'), 1500);
  eq('tr "2,5 bin"', parseCount('2,5 bin'), 2500);
  eq('zh "1.2万"', parseCount('1.2万'), 12000);
  eq('ja "3.4万"', parseCount('3.4万'), 34000);
  eq('empty -> null', parseCount(''), null);
  eq('no digits -> null', parseCount('LIVE'), null);
}

/* ------------------------------------------ sidebar-watch: loginFromHref */
{
  const src = read('src/content/modules/sidebar-watch.js');
  const fn = evalFragment(
    src,
    /var NON_CHANNEL_SEGMENTS = \[[\s\S]*?\n {2}\];[\s\S]*?function loginFromHref[\s\S]*?\n {2}\}/,
    'loginFromHref;',
    { location: { origin: 'https://www.twitch.tv' } });

  console.log('\n[loginFromHref]');
  eq('/shroud', fn('/shroud'), 'shroud');
  eq('/Shroud lowercases', fn('/Shroud'), 'shroud');
  eq('/shroud?x=1', fn('/shroud?x=1'), 'shroud');
  eq('/directory rejected', fn('/directory/game/x'), null);
  eq('/settings rejected', fn('/settings'), null);
  eq('null input', fn(null), null);
}

/* --------------------------------------------------- dom: currentChannel */
{
  const src = read('src/lib/dom.js');
  const fragment = src.match(/var NON_CHANNEL[\s\S]*?function currentChannel[\s\S]*?\n {2}\}/)[0];

  console.log('\n[currentChannel]');
  const run = (path) =>
    vm.runInNewContext(fragment + '\ncurrentChannel();', { location: { pathname: path } });

  eq('/shroud', run('/shroud'), 'shroud');
  eq('/shroud/home', run('/shroud/home'), 'shroud');
  eq('/drops/inventory', run('/drops/inventory'), null);
  eq('/directory', run('/directory'), null);
  eq('/ (home page)', run('/'), null);
  eq('/shroud/videos is not a channel watch', run('/shroud/videos'), null);
}

/* ------------------------------------------------ dom: money blocklist */
{
  const src = read('src/lib/dom.js');
  const DANGER_RX = evalFragment(
    src,
    /var DANGER_RX = new RegExp\(\[[\s\S]*?\]\.join\('\|'\), 'i'\);/,
    'DANGER_RX;');

  console.log('\n[DANGER_RX blocks paid actions]');
  const blocked = [
    'Use Bits', 'Power-up', "Los geht's", 'Jetzt kaufen', 'Comprar ahora',
    'Acheter', 'Acquista', 'Comprar', 'Kup teraz', 'Купить', 'Satın al',
    '購入する', '구매하기', '购买', 'Subscribe', 'Abonnieren', 'Gift a Sub'
  ];
  blocked.forEach((t) => eq('blocks "' + t + '"', DANGER_RX.test(t), true));

  console.log('\n[DANGER_RX lets the bonus chest through]');
  const allowed = [
    'Claim Bonus', 'Bonus einlösen', 'Jetzt abholen', 'Reclamar', 'Récupérer', 'Riscatta',
    'Resgatar', 'Odbierz', 'Получить', 'Talep Et', '受け取る', '받기', '领取'
  ];
  allowed.forEach((t) => eq('allows "' + t + '"', DANGER_RX.test(t), false));
}

/* ---------------------------------------- drops: localized claim captions */
{
  const src = read('src/content/modules/drops.js');
  const catalog = evalFragment(
    src,
    /var CLAIM_TEXTS_BY_LOCALE = \{[\s\S]*?\n {2}\};/,
    'CLAIM_TEXTS_BY_LOCALE;');
  const normalize = evalFragment(
    read('src/lib/dom.js'),
    /function normalizeLabel\(value\) \{[\s\S]*?\n {2}\}/,
    'normalizeLabel;');
  const captions = Object.values(catalog).flat();
  const matchesClaim = (text) => captions.map(normalize).includes(normalize(text));
  const current = {
    en: 'Claim Now', de: 'Jetzt abholen', es: 'Reclamar ahora',
    fr: 'Récupérer maintenant', it: 'Riscatta ora', pt_BR: 'Resgatar agora',
    pl: 'Odbierz teraz', ru: 'Получить сейчас', tr: 'Şimdi Talep Et',
    ja: '今すぐ受け取る', ko: '지금 받기', zh_CN: '立即领取'
  };
  const locales = readdirSync(join(ROOT, 'src/_locales')).sort();
  const DANGER_RX = evalFragment(
    read('src/lib/dom.js'),
    /var DANGER_RX = new RegExp\(\[[\s\S]*?\]\.join\('\|'\), 'i'\);/,
    'DANGER_RX;');

  console.log('\n[drop claim captions]');
  eq('claim catalog covers every shipped locale', Object.keys(catalog).sort(), locales);
  Object.entries(current).forEach(([locale, caption]) =>
    eq(`${locale} matches "${caption}"`, matchesClaim(caption), true));
  eq('normalizes whitespace and case', matchesClaim('  JETZT\u00a0ABHOLEN  '), true);
  eq('does not match paid suffixes', matchesClaim('Jetzt abholen und Bits kaufen'), false);
  eq('no localized claim caption trips the money guard',
    captions.filter((caption) => DANGER_RX.test(caption)), []);
}

/* ------------------------------------- drops: notification matcher per locale */
{
  const src = read('src/content/modules/drops.js');
  const NOTIFY_RX = evalFragment(
    src,
    /var DROP_WORD = \[[\s\S]*?var NOTIFY_RX = new RegExp\([\s\S]*?'i'\);/,
    'NOTIFY_RX;');

  console.log('\n[drop notification matcher]');
  const hits = [
    'Drop unlocked!',
    'Drop freigeschaltet',
    'Drop desbloqueado',
    'Drop débloqué',
    'Drop sbloccato',
    'Drop desbloqueado com sucesso',
    'Drop odblokowany',
    'Дроп разблокирован',
    'Drop açıldı',
    'ドロップを獲得しました',
    '드롭 획득',
    '掉宝已解锁'
  ];
  hits.forEach((t) => eq('matches "' + t + '"', NOTIFY_RX.test(t), true));
  eq('ignores unrelated chat text', NOTIFY_RX.test('someone dropped a nice clip'), false);
}

/* --------------------------------------- drops: progress caption per locale */
{
  const src = read('src/content/modules/drops.js');
  const body = src.match(/function parseProgress[\s\S]*?\n {2}\}/)[0];
  const parseProgress = vm.runInNewContext(
    '(' + body.replace(/^function parseProgress/, 'function') + ')', {isFinite, Number, String});

  console.log('\n[drop progress caption]');

  // Word order differs per language, which is exactly why nothing here parses
  // the sentence. Twitch writes a no-break space before % in several locales.
  const captions = [
    ['85% of 4 hours', 85, 4],
    ['85 % von 4 Stunden', 85, 4],
    ['48 % de 7 heures', 48, 7],
    ['18% de 1 hora', 18, 1],
    ['3 % di 6 ore', 3, 6],
    ['6% z 3 godzin', 6, 3],
    ['9 % от 2 часов', 9, 2],
    ['12 saatin %1 kadarı', 1, 12],
    ['4 時間中 85%', 85, 4],
    ['5시간 중 68%', 68, 5],
    ['9 小时中的 37%', 37, 9]
  ];
  captions.forEach(([text, percent, hours]) => {
    const got = parseProgress(text);
    eq('reads "' + text + '"', got && [got.percent, got.hours], [percent, hours]);
  });

  eq('a decimal comma is a decimal point', parseProgress('37,5 % von 9 Stunden').percent, 37.5);
  eq('a caption without a requirement still yields the percentage',
    parseProgress('100% complete'), {percent: 100, hours: 0});
  eq('plain text is not progress', parseProgress('Legendary 2'), null);
  eq('an empty caption is not progress', parseProgress(''), null);
  // Twitch counts past the requirement and prints the raw figure, so a value
  // above 100 is earned progress, not a corrupt caption.
  eq('progress beyond the requirement is capped, not discarded',
    parseProgress('470 % von 1 Stunde'), {percent: 100, hours: 1});
}

/* ------------------------------- drops: progress read off the real inventory */
{
  /*
   * The tree below is the drop card as Twitch actually ships it, taken from a
   * live /drops/inventory page on 2026-08-16. Two details matter and both broke
   * an earlier attempt: the percentage lives in aria-valuenow rather than in
   * text, and the caption splits its number into a child span, so the caption
   * is not a leaf node.
   */
  const src = read('src/content/modules/drops.js');

  let counter = 0;
  // Content is ordered, mixing text and elements, because the caption depends
  // on it: <span>10</span> comes before the "&nbsp;% von 1 Stunde" text node.
  const el = (tagName, props = {}, content = []) => {
    const node = {
      tagName,
      order: counter++,
      attrs: props.attrs || {},
      content,
      children: content.filter((c) => typeof c !== 'string'),
      parentElement: null,
      getAttribute(name) {
        return Object.prototype.hasOwnProperty.call(this.attrs, name)
          ? this.attrs[name]
          : null;
      },
      get textContent() {
        return this.content
          .map((c) => (typeof c === 'string' ? c : c.textContent))
          .join('');
      },
      descendants() {
        return this.children.flatMap((c) => [c, ...c.descendants()]);
      },
      matches(selector) {
        // Tag matching is case-insensitive in HTML documents, like the real one.
        const classes = String(this.attrs.class || '').split(/\s+/);
        return selector.split(',').map((s) => s.trim().toLowerCase()).some((w) => {
          if (w === this.tagName.toLowerCase()) return true;
          if (w.startsWith('.')) return classes.includes(w.slice(1));
          if (w.startsWith('[role=')) return this.attrs.role === w.slice(7, -2);
          const sub = w.match(/^([a-z]*)\[class\*="([^"]+)"\]$/);
          if (sub) {
            return (!sub[1] || this.tagName.toLowerCase() === sub[1]) &&
              String(this.attrs.class || '').includes(sub[2]);
          }
          const attr = w.match(/^([a-z]*)\[([a-z-]+)\]$/);
          if (attr) {
            return (!attr[1] || this.tagName.toLowerCase() === attr[1]) &&
              Object.prototype.hasOwnProperty.call(this.attrs, attr[2]);
          }
          return false;
        });
      },
      querySelectorAll(selector) {
        return this.descendants().filter((n) => n.matches(selector));
      },
      querySelector(selector) {
        return this.querySelectorAll(selector)[0] || null;
      },
      closest(selector) {
        let node = this;
        while (node) {
          if (node.matches(selector)) return node;
          node = node.parentElement;
        }
        return null;
      },
      compareDocumentPosition(other) {
        return other.order > this.order ? 4 : 2;
      }
    };
    node.children.forEach((c) => { c.parentElement = node; });
    return node;
  };

  // <p><span>10</span>&nbsp;% von 1 Stunde</p>, no-break space included: the
  // parser must not need to clean it, because s already covers it.
  const card = (name, valuenow, requirement, gone) => el('DIV', {}, [
    el('DIV', {}, [
      el('DIV', {}, [el('IMG', {attrs: {class: gone
        ? 'inventory-drop-image inventory-opacity-2 tw-image'
        : 'inventory-drop-image inventory-opacity-1 tw-image'}})]),
      gone
        ? el('DIV', {}, [el('P', {}, ['Diese Belohnung ist nicht mehr verfügbar.'])])
        : el('DIV', {}, []),
      el('DIV', {}, [el('P', {}, [name])])
    ]),
    el('DIV', {}, [
      el('DIV', {attrs: {role: 'progressbar', 'aria-valuenow': String(valuenow),
        'aria-valuemin': '0', 'aria-valuemax': '100'}}),
      el('DIV', {}, [
        el('P', {}, [el('SPAN', {}, [String(valuenow)]), ' % ' + requirement])
      ])
    ])
  ]);

  // Title, end date, then the tower that holds this campaign's cards. A live
  // campaign also links to the channels where it can be earned; one that has
  // ended keeps only its outward "about this drop" link, and that difference is
  // what separates them without parsing a localized date.
  const campaign = (title, cards, over) => el('DIV', {}, [
    el('DIV', {}, [
      el('P', {}, [title]),
      el('P', {}, ['Ende: Mo., 24. Aug., 15:00 MESZ']),
      over
        ? el('A', {attrs: {href: 'https://example.invalid/drops'}}, ['Über diesen Drop'])
        : el('DIV', {}, [
          el('A', {attrs: {href: '/directory/category/kord-breach'}},
            ['teilnehmenden Live-Kanal']),
          el('A', {attrs: {href: 'https://example.invalid/drops'}}, ['Über diesen Drop'])
        ])
    ]),
    // The generated hash in front is exactly why nothing may match on it.
    el('DIV', {}, [
      el('DIV', {attrs: {class: 'ScTower-sc-1sjzzes-0 gBmiMA tw-tower'}}, cards)
    ])
  ]);

  // Two campaigns, the first one finished. Its cards still carry progress
  // bars, which is what pushed four irrelevant drops in front of a 93 % one.
  const inventory = el('DIV', {}, [
    campaign('KORD BREACH S1 Drops', [
      card('Common 1', 10, 'von 1 Stunde', true),
      card('Rare 1', 5, 'von 2 Stunden', true)
    ], true),
    // Same title as the campaign above, which is why one alone is no identity:
    // a finished drop, the same tier listed twice, and one still running.
    campaign('KORD BREACH S1 Drops', [
      card('Common 1', 100, 'von 1 Stunde', false),
      card('Common 1', 40, 'von 1 Stunde', false),
      card('Common 1', 55, 'von 1 Stunde', false),
      card('Rare 2', 94, 'von 4 Stunden', false)
    ], false),
    campaign('EWC 2026', [
      card('EWC 2026 (Bronze)', 18, 'von 1 Stunde', false),
      card('EWC 2026 (Diamond)', 1, 'von 12 Stunden', false),
      card('Rare 2', 93, 'von 4 Stunden', false)
    ], false),
    // The "Abgeholt" section: rewards already collected. Full bar, but a date
    // where a progress caption would be, so there is nothing to report.
    campaign('Abgeholt', [
      el('DIV', {}, [
        el('DIV', {}, [el('DIV', {}, [el('P', {}, ['1000000 RUB'])])]),
        el('DIV', {}, [
          el('DIV', {attrs: {role: 'progressbar', 'aria-valuenow': '100',
            'aria-valuemin': '0', 'aria-valuemax': '100'}}),
          el('DIV', {}, [el('P', {}, ['vor 2 Stunden'])])
        ])
      ])
    ], false)
  ]);

  const body = src.match(
    /var PROGRESS_BAR_SELECTORS[\s\S]*?function collectProgress[\s\S]*?\n {2}\}/)[0];
  const collect = vm.runInNewContext(
    body + '\ncollectProgress;',
    {
      isFinite, Number, String, Math, Array, Object,
      state: {mode: 'claim'},
      document: {body: inventory},
      INVENTORY_ROOTS: [],
      D: {qAny: () => inventory},
      parseProgress: vm.runInNewContext(
        '(' + src.match(/function parseProgress[\s\S]*?\n {2}\}/)[0]
          .replace(/^function parseProgress/, 'function') + ')',
        {isFinite, Number, String}),
      PROGRESS_TEXT_MAX: 60,
      MAX_SCANNED_BARS: 60
    });

  console.log('\n[drop progress on the real inventory markup]');
  const got = collect();
  eq('the expired campaign is left out, everything running is kept',
    got.length, 7);
  eq('the percentage comes from the progress bar',
    got.map((g) => g.percent), [100, 40, 55, 94, 18, 1, 93]);
  eq('a finished drop is reported, for the popup to mark rather than rank',
    got.filter((g) => g.percent >= 100).length, 1);
  eq('the requirement comes from the caption',
    got.map((g) => g.hours), [1, 1, 1, 4, 1, 12, 4]);
  eq('the name is the label in front of the bar',
    got.map((g) => g.name).slice(-4),
    ['Rare 2', 'EWC 2026 (Bronze)', 'EWC 2026 (Diamond)', 'Rare 2']);
  eq('every drop carries its campaign',
    got.map((g) => g.campaign).filter((c, i, all) => all.indexOf(c) === i),
    ['KORD BREACH S1 Drops', 'EWC 2026']);
  eq('the same tier in two campaigns stays two drops',
    got.filter((g) => g.name === 'Rare 2').length, 2);
  eq('a collected reward has a bar but no caption, and is not progress',
    got.some((g) => g.name === '1000000 RUB'), false);
}

/* ------------------------------------------- ad-mute: stale marker handling */
{
  const src = read('src/content/modules/ad-mute.js');
  const body = src.match(/function markerIsRendered[\s\S]*?\n {2}\}/)[0];
  const markerIsRendered = vm.runInNewContext(
    '(' + body.replace(/^function markerIsRendered/, 'function') + ')', {
      window: {getComputedStyle: (el) => el.styleState}
    });
  const marker = (over = {}) => Object.assign({
    isConnected: true,
    hidden: false,
    getAttribute: () => null,
    getClientRects: () => [{width: 120, height: 24}],
    styleState: {display: 'block', visibility: 'visible', opacity: '1'}
  }, over);

  console.log('\n[ad marker visibility]');
  eq('visible marker is active', markerIsRendered(marker()), true);
  eq('detached marker is inactive', markerIsRendered(marker({isConnected: false})), false);
  eq('hidden attribute is inactive', markerIsRendered(marker({hidden: true})), false);
  eq('aria-hidden marker is inactive', markerIsRendered(marker({
    getAttribute: () => 'true'
  })), false);
  eq('display:none marker is inactive', markerIsRendered(marker({
    styleState: {display: 'none', visibility: 'visible', opacity: '1'}
  })), false);
  eq('zero-layout marker is inactive', markerIsRendered(marker({
    getClientRects: () => []
  })), false);
  eq('zero-size marker is inactive', markerIsRendered(marker({
    getClientRects: () => [{width: 0, height: 0}]
  })), false);
}

/* ------------------------------------------------ locale catalog coverage */
{
  console.log('\n[locales]');
  const dir = join(ROOT, 'src/_locales');
  const locales = readdirSync(dir).sort();
  const base = JSON.parse(read('src/_locales/en/messages.json'));
  const baseKeys = Object.keys(base).sort();

  eq('shipped locales', locales.length, 12);
  eq('en is present', locales.includes('en'), true);

  let complete = 0;
  for (const locale of locales) {
    const catalog = JSON.parse(read(`src/_locales/${locale}/messages.json`));
    if (JSON.stringify(Object.keys(catalog).sort()) === JSON.stringify(baseKeys)) complete++;
  }
  eq('every locale carries the full key set', complete, locales.length);

  // A locale that only copies English is not a translation.
  const untranslated = locales.filter((locale) => {
    if (locale === 'en') return false;
    const catalog = JSON.parse(read(`src/_locales/${locale}/messages.json`));
    return catalog.tabSettings.message === base.tabSettings.message &&
      catalog.btnRefresh.message === base.btnRefresh.message;
  });
  eq('no locale is a copy of English', untranslated, []);
}

console.log(`\n${pass} ok, ${fail} fail\n`);
process.exit(fail ? 1 : 0);
