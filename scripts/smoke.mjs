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
