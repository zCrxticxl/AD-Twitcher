#!/usr/bin/env node
/**
 * @license
 * Copyright 2026 zCrxticxl
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * @fileoverview Static checks that need no dev dependencies:
 *   [1] every JS file passes `node --check`
 *   [2] all manifests parse and every file they reference exists
 *   [3] importScripts targets in the service worker resolve
 *   [4] content scripts report themselves to the beacon, in manifest order
 *   [5] the ping handler lives in the beacon and nowhere else
 *   [6] content scripts bind their namespace to globalThis, not window
 *   [7] no module bypasses the click guard
 *   [8] counters cannot feed back into a module restart
 *   [9] every locale defines the same keys as the default locale
 *  [10] every referenced message key exists, and no key is dead
 *  [11] delayed click paths are cancelled and revalidate lifecycle state
 *  [12] popup sizing cannot collapse in Firefox
 *  [13] ad state, and the mute it applies, cannot outlive the ad
 *  [14] the watchdog measures playback and keeps it running
 *  [15] lifetime statistics persist and are presented
 *  [16] creator links point where they claim to
 *  [17] a stale inventory view is reloaded instead of scanned again
 *  [18] the popup shows the installed version, read from the manifest
 *  [19] the popup can prove the extension is still working
 *  [20] drop progress is read, validated and shown
 */
import { readdir, stat, readFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const execFileP = promisify(execFile);
const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
const SRC = join(ROOT, 'src');

let errors = 0;
const fail = (m) => { console.error('  FAIL ' + m); errors++; };
const ok = (m) => console.log('  ok   ' + m);

async function walk(dir, filter, acc = []) {
  for (const entry of await readdir(dir)) {
    const p = join(dir, entry);
    if ((await stat(p)).isDirectory()) await walk(p, filter, acc);
    else if (filter(entry)) acc.push(p);
  }
  return acc;
}

console.log('\n[1] JavaScript syntax');
for (const f of await walk(SRC, (e) => e.endsWith('.js'))) {
  const rel = f.replace(ROOT + '/', '');
  try {
    await execFileP(process.execPath, ['--check', f]);
    ok(rel);
  } catch (e) {
    fail(rel + '\n' + (e.stderr || e.message));
  }
}

console.log('\n[2] Manifests');
for (const target of ['chrome', 'firefox', 'opera']) {
  const p = join(SRC, `manifest.${target}.json`);
  let m;
  try {
    m = JSON.parse(await readFile(p, 'utf8'));
    ok(`manifest.${target}.json parses`);
  } catch (e) {
    fail(`manifest.${target}.json: ${e.message}`);
    continue;
  }

  const refs = [];
  for (const c of m.content_scripts || []) {
    (c.js || []).forEach((x) => refs.push(x));
    (c.css || []).forEach((x) => refs.push(x));
  }
  if (m.background?.service_worker) refs.push(m.background.service_worker);
  (m.background?.scripts || []).forEach((x) => refs.push(x));
  const action = m.action || m.browser_action;
  if (action?.default_popup) refs.push(action.default_popup);
  Object.values(action?.default_icon || {}).forEach((x) => refs.push(x));
  Object.values(m.icons || {}).forEach((x) => refs.push(x));

  for (const r of [...new Set(refs)]) {
    if (existsSync(join(SRC, r))) ok(`  ${target}: ${r}`);
    else fail(`  ${target}: missing file ${r}`);
  }

  if (!m.default_locale) fail(`  ${target}: default_locale is not set`);
  else if (!existsSync(join(SRC, '_locales', m.default_locale))) {
    fail(`  ${target}: default_locale "${m.default_locale}" has no _locales folder`);
  } else {
    ok(`  ${target}: default_locale ${m.default_locale}`);
  }

  if (target === 'firefox') {
    const dataPermissions = m.browser_specific_settings?.gecko
      ?.data_collection_permissions?.required;
    if (JSON.stringify(dataPermissions) === JSON.stringify(['none'])) {
      ok('  firefox: declares no data collection or transmission');
    } else {
      fail('  firefox: data_collection_permissions.required must be ["none"]');
    }
  }
}

console.log('\n[3] importScripts targets in the service worker');
{
  const swSrc = await readFile(join(SRC, 'background/sw.js'), 'utf8');
  for (const m of swSrc.matchAll(/'(\.\.?\/[^']+\.js)'/g)) {
    const p = join(SRC, 'background', m[1]);
    if (existsSync(p)) ok(m[1]);
    else fail(`importScripts target missing: ${m[1]}`);
  }
}

const chromeManifest = JSON.parse(await readFile(join(SRC, 'manifest.chrome.json'), 'utf8'));
const contentScripts = chromeManifest.content_scripts[0].js;

console.log('\n[4] Beacon self-reporting');
{
  if (contentScripts[0] === 'content/beacon.js') ok('beacon.js runs first');
  else fail(`beacon.js must be at position 0, found "${contentScripts[0]}"`);

  for (const f of contentScripts) {
    const src = await readFile(join(SRC, f), 'utf8');
    // Each file must report its own path, otherwise the popup diagnosis blames
    // the wrong file.
    if (src.includes(`__adtLoaded('${f}')`)) ok(`${f} reports itself`);
    else fail(`${f} does not call __adtLoaded('${f}')`);
  }

  for (const target of ['firefox', 'opera']) {
    const manifest = JSON.parse(await readFile(join(SRC, `manifest.${target}.json`), 'utf8'));
    JSON.stringify(manifest.content_scripts[0].js) === JSON.stringify(contentScripts)
      ? ok(`Chrome and ${target} lists are identical`)
      : fail(`content_scripts.js differs between Chrome and ${target}`);
  }

  const opera = JSON.parse(await readFile(join(SRC, 'manifest.opera.json'), 'utf8'));
  JSON.stringify(opera) === JSON.stringify(chromeManifest)
    ? ok('Opera GX manifest matches Chrome MV3 exactly')
    : fail('Opera GX manifest drifted from Chrome MV3');

  const popup = await readFile(join(SRC, 'popup/popup.js'), 'utf8');
  const block = popup.match(/EXPECTED_FILES\s*=\s*\[([\s\S]*?)\]/);
  if (!block) {
    fail('EXPECTED_FILES not found in popup.js');
  } else {
    const got = [...block[1].matchAll(/'([^']+)'/g)].map((x) => x[1]);
    JSON.stringify(got) === JSON.stringify(contentScripts)
      ? ok('popup EXPECTED_FILES matches the manifest')
      : fail('popup EXPECTED_FILES drifted:\n' +
             `       manifest: ${contentScripts.join(', ')}\n` +
             `       popup:    ${got.join(', ')}`);
  }
}

console.log('\n[5] Ping handler lives in the beacon');
{
  const beacon = await readFile(join(SRC, 'content/beacon.js'), 'utf8');
  const index = await readFile(join(SRC, 'content/index.js'), 'utf8');
  beacon.includes("'adt:ping'")
    ? ok('beacon.js handles adt:ping')
    : fail('beacon.js does not handle adt:ping');
  index.includes("case 'adt:ping'")
    ? fail('index.js handles adt:ping as well, sendResponse would fire twice')
    : ok('index.js stays out of it');
}

console.log('\n[6] Namespace global in content scripts');
{
  /*
   * Firefox content scripts: the sandbox global is not window. Hanging the ADT
   * namespace off window builds a second, incomplete ADT object that cannot see
   * lib/browser.js ("api is undefined"). Chrome hides it because globalThis and
   * window are the same object there.
   */
  for (const f of contentScripts) {
    const src = await readFile(join(SRC, f), 'utf8');
    if (/var\s+g\s*=\s*window\s*;/.test(src)) {
      fail(`${f}: "var g = window", must be globalThis (breaks in Firefox)`);
    } else if (/var\s+g\s*=\s*typeof globalThis/.test(src)) {
      ok(`${f} uses globalThis`);
    } else {
      fail(`${f}: no recognizable namespace global`);
    }
  }

  for (const f of ['background/sw.js', 'background/live-watch.js',
                   'lib/storage.js', 'lib/log.js', 'lib/browser.js']) {
    const src = await readFile(join(SRC, f), 'utf8');
    if (/var\s+g\s*=\s*window\s*;/.test(src)) fail(`${f}: "var g = window" in the background path`);
  }
  ok('background files are clean');
}

console.log('\n[7] Click guard');
{
  /*
   * Modules may only click through D.safeClick(). humanClick() skips the money
   * blocklist, the dialog guard and the click budget, which is exactly how
   * Power-ups (Bits) and reward dialogs got clicked before.
   */
  for (const f of contentScripts) {
    if (f === 'lib/dom.js') continue;  // Defines both.
    const src = await readFile(join(SRC, f), 'utf8');
    if (/\bhumanClick\s*\(/.test(src)) fail(`${f}: calls humanClick() directly, must be D.safeClick()`);
  }
  ok('no module bypasses safeClick()');

  const dom = await readFile(join(SRC, 'lib/dom.js'), 'utf8');
  /^\s*humanClick:/m.test(dom)
    ? fail('lib/dom.js exports humanClick, only safeClick may be public')
    : ok('humanClick stays private');
  /DANGER_RX/.test(dom) && /budgetOk/.test(dom)
    ? ok('money blocklist and click budget present')
    : fail('DANGER_RX or budgetOk missing from lib/dom.js');

  const drops = await readFile(join(SRC, 'content/modules/drops.js'), 'utf8');
  /'main'/.test(drops)
    ? fail("drops.js: 'main' as a root matches every page, the text scan hits rewards")
    : ok('drops.js has no page-wide root');
  /onInventoryPage\(\)/.test(drops) && /mode !== 'claim'/.test(drops)
    ? ok('drops.js clicks in claim mode only')
    : fail('drops.js: click path is not confined to the inventory page');
}

console.log('\n[8] No feedback loop from counters into module restarts');
{
  /*
   * The loop this guards against:
   *   countStat() -> writes settings -> storage.onChanged -> apply()
   *   -> every module stop/start -> module re-detects the same ad or chest
   *   -> countStat() -> ...
   */
  const storage = await readFile(join(SRC, 'lib/storage.js'), 'utf8');

  /^\s*var STATS_KEY/m.test(storage)
    ? ok('counters have their own storage key')
    : fail('lib/storage.js: STATS_KEY missing, counters are back in settings');

  /\bstats:\s*\{/.test(storage.split('var STATS_KEY')[0])
    ? fail('DEFAULTS still contains a stats block')
    : ok('DEFAULTS has no stats block');

  /o\[STATS_KEY\]\s*=\s*next/.test(storage)
    ? ok('bumpStat writes STATS_KEY only')
    : fail('bumpStat may be writing settings');

  const index = await readFile(join(SRC, 'content/index.js'), 'utf8');
  /sig === lastSig/.test(index)
    ? ok('apply() restarts only on a real config change')
    : fail('content/index.js: apply() has no signature latch');

  const points = await readFile(join(SRC, 'content/modules/channel-points.js'), 'utf8');
  /state\.cooldownUntil\s*=\s*0\s*;/.test(points)
    ? fail('channel-points.js resets cooldownUntil to 0 on start')
    : ok('channel-points keeps its cooldown across restarts');

  const adMute = await readFile(join(SRC, 'content/modules/ad-mute.js'), 'utf8');
  /lastAdEnd/.test(adMute)
    ? ok('ad-mute does not count the same ad twice')
    : fail('ad-mute.js: no debounce against double counting');
}

console.log('\n[9] Locale catalogs');
const LOCALES_DIR = join(SRC, '_locales');
const defaultLocale = chromeManifest.default_locale;
const catalogs = new Map();
{
  const dirs = (await readdir(LOCALES_DIR)).sort();
  for (const locale of dirs) {
    const p = join(LOCALES_DIR, locale, 'messages.json');
    if (!existsSync(p)) {
      fail(`${locale}: messages.json missing`);
      continue;
    }
    try {
      catalogs.set(locale, JSON.parse(await readFile(p, 'utf8')));
    } catch (e) {
      fail(`${locale}: ${e.message}`);
    }
  }

  const base = catalogs.get(defaultLocale);
  if (!base) {
    fail(`default locale ${defaultLocale} has no catalog`);
  } else {
    ok(`${catalogs.size} locales, ${Object.keys(base).length} keys in ${defaultLocale}`);
    const baseKeys = Object.keys(base).sort();

    for (const [locale, catalog] of catalogs) {
      if (locale === defaultLocale) continue;
      const keys = Object.keys(catalog).sort();
      const missing = baseKeys.filter((k) => !keys.includes(k));
      const extra = keys.filter((k) => !baseKeys.includes(k));
      const empty = keys.filter((k) => !String(catalog[k]?.message || '').trim());

      if (missing.length) fail(`${locale}: missing ${missing.join(', ')}`);
      if (extra.length) fail(`${locale}: unknown key ${extra.join(', ')}`);
      if (empty.length) fail(`${locale}: empty message ${empty.join(', ')}`);
      if (!missing.length && !extra.length && !empty.length) ok(`${locale} complete`);
    }

    // Placeholders must line up, otherwise a translation renders "$1".
    for (const [locale, catalog] of catalogs) {
      if (locale === defaultLocale) continue;
      for (const key of baseKeys) {
        if (!catalog[key]) continue;
        const want = [...new Set((base[key].message.match(/\$\d/g) || []))].sort();
        const got = [...new Set((catalog[key].message.match(/\$\d/g) || []))].sort();
        if (want.join() !== got.join()) {
          fail(`${locale}.${key}: placeholders ${got.join(',') || 'none'} ` +
               `do not match ${want.join(',') || 'none'}`);
        }
      }
    }
  }
}

console.log('\n[10] Message key usage');
{
  const base = catalogs.get(defaultLocale) || {};
  const defined = new Set(Object.keys(base));
  const used = new Set();

  const sources = await walk(SRC, (e) =>
    e.endsWith('.js') || e.endsWith('.html') || e.endsWith('.json'));

  for (const file of sources) {
    if (file.startsWith(LOCALES_DIR)) continue;   // Catalogs define, not reference.
    const src = await readFile(file, 'utf8');

    for (const m of src.matchAll(/ADT\.msg\(\s*'([^']+)'/g)) used.add(m[1]);
    for (const m of src.matchAll(/data-i18n(?:-[a-z-]+)?="([^"]+)"/g)) used.add(m[1]);
    for (const m of src.matchAll(/__MSG_([A-Za-z0-9_]+)__/g)) used.add(m[1]);
    // Label maps hold bare key literals; count any literal that names a key.
    for (const m of src.matchAll(/'([A-Za-z][A-Za-z0-9]*)'/g)) {
      if (defined.has(m[1])) used.add(m[1]);
    }
  }

  const missing = [...used].filter((k) => !defined.has(k)).sort();
  const dead = [...defined].filter((k) => !used.has(k)).sort();

  if (missing.length) fail(`referenced but not defined: ${missing.join(', ')}`);
  else ok(`${used.size} referenced keys all resolve`);

  if (dead.length) fail(`defined but never used: ${dead.join(', ')}`);
  else ok('no dead keys');
}

console.log('\n[11] Click lifecycle');
{
  const dom = await readFile(join(SRC, 'lib/dom.js'), 'utf8');
  !/dispatchEvent\(new MouseEvent\('click'/.test(dom)
    ? ok('humanClick has one primary activation and one exception fallback')
    : fail('humanClick may activate an element more than once');

  for (const file of ['channel-points.js', 'drops.js']) {
    const src = await readFile(join(SRC, 'content/modules', file), 'utf8');
    /clearTimeout/.test(src) && /!state\.running/.test(src)
      ? ok(`${file} cancels and revalidates delayed clicks`)
      : fail(`${file} leaves delayed clicks alive after stop()`);
  }
}

console.log('\n[12] Firefox popup sizing');
{
  const css = await readFile(join(SRC, 'popup/popup.css'), 'utf8');
  const fixedRoot = /html\s*\{[\s\S]*?width:\s*380px/.test(css) &&
    /body\s*\{[\s\S]*?min-width:\s*380px/.test(css);
  const viewportWidth = /body\s*\{[\s\S]*?(?:100vw|\bvw\b)/.test(css);
  fixedRoot && !viewportWidth
    ? ok('popup has a fixed intrinsic width and no viewport-width cycle')
    : fail('popup width can collapse during Firefox intrinsic sizing');
}

console.log('\n[13] Ad marker lifecycle');
{
  const adMute = await readFile(join(SRC, 'content/modules/ad-mute.js'), 'utf8');
  const strongMarkerBlock = (adMute.match(
    /var AD_MARKER_SELECTOR = \[[\s\S]*?\]\.join/) || [''])[0];
  !/\.persistent-player--ad|\.video-player__container--ad/.test(adMute) &&
      !/sad-overlay/.test(strongMarkerBlock) &&
      /querySelectorAll\(AD_MARKER_SELECTOR\)/.test(adMute) &&
      /markerIsRendered/.test(adMute)
    ? ok('only rendered explicit ad markers can keep the overlay active')
    : fail('stale player classes or Twitch sad-overlay can keep the ad active');

  /visibilitychange/.test(adMute) && /addEventListener\('focus'/.test(adMute) &&
      /addEventListener\('pageshow'/.test(adMute) && /tick\(true\)/.test(adMute)
    ? ok('foreground return immediately reconciles a finished ad')
    : fail('background-tab ad state is not reconciled on foreground return');

  /function bindPlayerObserver/.test(adMute) && /rootObserver/.test(adMute) &&
      /observerHost\.isConnected/.test(adMute)
    ? ok('player observer is rebound after Twitch remounts the player')
    : fail('ad observer can remain attached to a detached player');

  /attributes:\s*true/.test(adMute) &&
      /attributeFilter:\s*\[['"]hidden['"],\s*['"]aria-hidden['"],\s*['"]style['"],\s*['"]class['"]\]/.test(adMute)
    ? ok('ad marker visibility attribute changes trigger a check')
    : fail('hidden or restyled ad markers do not trigger a lifecycle check');

  /removeEventListener\('visibilitychange'/.test(adMute) &&
      /removeEventListener\('focus'/.test(adMute) &&
      /removeEventListener\('pageshow'/.test(adMute)
    ? ok('foreground lifecycle listeners are removed on stop')
    : fail('ad-mute leaks foreground lifecycle listeners');

  /hideStaleTwitchPlaceholder/.test(adMute) &&
      /adt-twitch-placeholder--stale/.test(adMute) &&
      /v\.paused/.test(adMute) && /v\.play\(\)/.test(adMute)
    ? ok('stale Twitch question-mark placeholder is hidden and playback resumed')
    : fail('Twitch question-mark placeholder can remain after the ad');

  /function schedulePlaybackRecovery/.test(adMute) &&
      /currentTime > startedAt \+ 0\.25/.test(adMute) &&
      /RECOVERY_RELOAD_COOLDOWN_MS/.test(adMute) &&
      /location\.reload\(\)/.test(adMute)
    ? ok('stalled post-ad playback triggers one cooldown-protected reload')
    : fail('post-ad player stalls have no automatic recovery fallback');

  /*
   * Muting the <video> element is visible to Twitch and a restore that does not
   * land costs the rest of the session's watch time. The default therefore
   * mutes the tab from the background, where the page cannot see it, and the
   * player path must stay behind the muteTarget switch.
   */
  const swMute = await readFile(join(SRC, 'background/sw.js'), 'utf8');
  /function muteTarget/.test(adMute) && /'adt:tab-mute'/.test(adMute) &&
      /muteTarget\(\) === 'player'/.test(adMute)
    ? ok('ad mute can silence the tab without touching the player')
    : fail('ad-mute.js has no browser-level mute path');

  const storageDefaults = await readFile(join(SRC, 'lib/storage.js'), 'utf8');
  /muteTarget:\s*'tab'/.test(storageDefaults)
    ? ok('the tab is the default mute target')
    : fail('lib/storage.js: adMute.muteTarget does not default to the tab');

  /mutedInfo/.test(swMute) && /function mutedByUs/.test(swMute) &&
      /function releaseTabMute/.test(swMute)
    ? ok('only a mute the extension set is ever released')
    : fail('background/sw.js can unmute a tab the user muted by hand');

  // An ad break outlives the MV3 worker, so a mute recorded in a variable is a
  // tab that stays silent for good.
  /MUTE_RT_KEY/.test(swMute) && /api\.storage\.local\.set/.test(swMute) &&
      /function sweepTabMutes/.test(swMute)
    ? ok('ad mutes survive a worker restart and expire on their own')
    : fail('background/sw.js keeps its ad mutes in memory only');

  /changeInfo\.status !== 'loading'/.test(swMute)
    ? ok('a navigating tab does not keep an orphaned mute')
    : fail('background/sw.js leaves the tab muted when the page navigates away');
}

console.log('\n[14] Stream watchdog');
{
  for (const target of ['chrome', 'firefox', 'opera']) {
    const manifest = JSON.parse(await readFile(join(SRC, `manifest.${target}.json`), 'utf8'));
    (manifest.permissions || []).includes('notifications')
      ? ok(`${target} declares notification permission`)
      : fail(`${target}: notification permission missing`);
  }

  const content = await readFile(join(SRC, 'content/modules/watch-health.js'), 'utf8');
  /currentTime/.test(content) && /advancing/.test(content) && /adt:watch-heartbeat/.test(content)
    ? ok('watchdog measures video progress and reports heartbeats')
    : fail('watchdog does not verify real player progress');

  const background = await readFile(join(SRC, 'background/watch-health.js'), 'utf8');
  /autoDiscardable:\s*false/.test(background) && /api\.notifications\.create/.test(background) &&
      /api\.tabs\.reload/.test(background)
    ? ok('watchdog protects, notifies and recovers stream tabs')
    : fail('watchdog recovery path is incomplete');

  /*
   * A paused player earns no watch time and no drop progress. Everything except
   * a pause the user asked for has to be taken back, and the resume path needs
   * a ceiling so a player that refuses to start cannot spin.
   */
  /function resume\(/.test(content) && /keepPlaying/.test(content) &&
      /USER_INTENT_MS/.test(content) && /state\.userPaused/.test(content)
    ? ok('an unrequested pause is resumed, a user pause is not')
    : fail('watchdog does not keep the player running');

  /MAX_RESUMES_PER_MIN/.test(content)
    ? ok('automatic resumes are capped per minute')
    : fail('the resume path has no ceiling');

  /removeEventListener\('pointerdown'/.test(content) &&
      /removeEventListener\('keydown'/.test(content)
    ? ok('pause guard input listeners are removed on stop')
    : fail('watch-health leaks its user-input listeners');
}

console.log('\n[15] Lifetime statistics');
{
  const storage = await readFile(join(SRC, 'lib/storage.js'), 'utf8');
  const popupHtml = await readFile(join(SRC, 'popup/popup.html'), 'utf8');
  const popupJs = await readFile(join(SRC, 'popup/popup.js'), 'utf8');
  /trackingSince:\s*0/.test(storage) && /lastActivityAt:\s*0/.test(storage) &&
      /if \(!next\.trackingSince\) next\.trackingSince = now/.test(storage)
    ? ok('statistics persist their first and latest activity timestamps')
    : fail('statistics do not persist their activity period');
  /data-i18n="cardLifetimeStats"/.test(popupHtml) &&
      /statsRecordedSince/.test(popupJs) && /Intl\.DateTimeFormat/.test(popupJs)
    ? ok('popup presents lifetime totals with a localized tracking date')
    : fail('popup does not clearly present lifetime statistics');
}

console.log('\n[16] Creator links');
{
  const popup = await readFile(join(SRC, 'popup/popup.html'), 'utf8');
  const coffee = /href="https:\/\/buymeacoffee\.com\/zcrxticxl"/.test(popup);
  const twitter = /href="https:\/\/x\.com\/zCrxticxl"/.test(popup);
  const safeTargets = (popup.match(/target="_blank" rel="noopener noreferrer"/g) || []).length === 2;
  coffee && twitter && safeTargets
    ? ok('support and social links use exact safe external targets')
    : fail('creator links are missing, incorrect, or open unsafely');
}

console.log('\n[17] Drops inventory freshness');
{
  /*
   * Twitch renders the inventory once, from data fetched at load time, and
   * never refetches it. A drop that finishes afterwards has no claim button in
   * that DOM, which is exactly why claiming used to need a manual F5. Scanning
   * cannot fix that, only a reload, and that reload needs a cooldown.
   */
  const drops = await readFile(join(SRC, 'content/modules/drops.js'), 'utf8');
  const sw = await readFile(join(SRC, 'background/sw.js'), 'utf8');
  const index = await readFile(join(SRC, 'content/index.js'), 'utf8');

  /STALE_VIEW_MS/.test(drops) && /function viewIsStale/.test(drops) &&
      /stale: viewIsStale\(\)/.test(drops)
    ? ok('the claim scan reports how old its view is')
    : fail('drops.js cannot tell a current inventory from a stale one');

  /report: M\.drops\.claimNow\(\)/.test(index)
    ? ok('the report reaches the background')
    : fail('content/index.js swallows the claim report');

  /function refreshInventoryTab/.test(sw) && /api\.tabs\.reload/.test(sw) &&
      /INVENTORY_RELOAD_COOLDOWN_MS/.test(sw)
    ? ok('a stale inventory tab is reloaded once, then claimed')
    : fail('background/sw.js still expects a manual reload of the inventory');

  /report\.stale === false/.test(sw)
    ? ok('a current inventory with nothing to claim is left alone')
    : fail('background/sw.js reloads the inventory unconditionally');

  /function refreshStaleView/.test(drops) &&
      /visibilityState !== 'hidden'/.test(drops)
    ? ok('a parked inventory tab refreshes itself, a watched one does not')
    : fail('drops.js can reload the inventory while the user is reading it');
}

console.log('\n[18] Version badge');
{
  /*
   * A version printed into the markup is a version that goes stale on the next
   * release. The badge has to read the manifest, which build.mjs stamps from
   * package.json, so what the popup shows is what is installed.
   */
  const html = await readFile(join(SRC, 'popup/popup.html'), 'utf8');
  const js = await readFile(join(SRC, 'popup/popup.js'), 'utf8');

  /id="appVersion"/.test(html)
    ? ok('the popup footer carries a version slot')
    : fail('popup.html has no version element');

  /function renderVersion/.test(js) && /getManifest\(\)/.test(js) &&
      /'v' \+ version/.test(js)
    ? ok('the badge is filled from the manifest at runtime')
    : fail('the version badge does not read the manifest');

  /<span class="creator-version"[^>]*><\/span>/.test(html)
    ? ok('no version number is hardcoded in the markup')
    : fail('popup.html hardcodes a version that will go stale');
}

console.log('\n[19] Activity card');
{
  /*
   * A working extension and a dead one look identical from the outside: the
   * counters only move when something is claimed, which can be hours apart.
   * The activity record is what closes that gap, so it has to survive a worker
   * restart, which means storage rather than a variable.
   */
  const sw = await readFile(join(SRC, 'background/sw.js'), 'utf8');
  const watch = await readFile(join(SRC, 'background/watch-health.js'), 'utf8');
  const html = await readFile(join(SRC, 'popup/popup.html'), 'utf8');
  const js = await readFile(join(SRC, 'popup/popup.js'), 'utf8');

  /var ACTIVITY_KEY = 'activityRuntime'/.test(sw) &&
      /api\.storage\.local\.set\(out\)/.test(sw)
    ? ok('the drops check records its outcome in storage')
    : fail('the activity record would not survive a worker restart');

  /function noteDropsCheck/.test(sw) &&
      /noteDropsCheck\('error'/.test(sw) && /noteDropsCheck\('off'/.test(sw)
    ? ok('a skipped or failed check is recorded too')
    : fail('only successful checks are recorded, so silence stays ambiguous');

  /activity: r\[2\]/.test(sw) && /function activityStatus/.test(sw)
    ? ok('the status answer carries the activity block')
    : fail('background/sw.js does not report activity to the popup');

  /function status\(\)/.test(watch) && /g\.ADT\.watchHealth = \{[\s\S]*status: status/.test(watch)
    ? ok('the watchdog exposes which tabs it is watching')
    : fail('watch-health keeps its runtime to itself');

  /id="acWatching"/.test(html) && /id="acDrops"/.test(html) &&
      /id="acNext"/.test(html) && /id="acClaim"/.test(html)
    ? ok('the popup has a row for each activity signal')
    : fail('popup.html is missing activity rows');

  /function renderActivity/.test(js) && /DROPS_OUTCOMES/.test(js)
    ? ok('outcomes are localized, not printed raw')
    : fail('popup.js would show raw outcome identifiers');
}

console.log('\n[20] Drop progress');
{
  /*
   * The percentages are read off the inventory page, so the caption is
   * localized and its word order is not fixed. Nothing may parse the sentence,
   * and the values arrive from a content script, which is untrusted input.
   */
  const drops = await readFile(join(SRC, 'content/modules/drops.js'), 'utf8');
  const sw = await readFile(join(SRC, 'background/sw.js'), 'utf8');
  const js = await readFile(join(SRC, 'popup/popup.js'), 'utf8');
  const html = await readFile(join(SRC, 'popup/popup.html'), 'utf8');

  /function parseProgress/.test(drops) && /%\\s\*\(/.test(drops)
    ? ok('the caption is read in both percent-sign orders')
    : fail('drops.js only reads one percent-sign order, which breaks Turkish');

  // Twitch renders a real ARIA progress bar per drop. Reading aria-valuenow is
  // language-independent and survives a rewritten caption; going back to text
  // for the percentage would be a regression, not a simplification.
  /role="progressbar"/.test(drops) && /aria-valuenow/.test(drops) &&
      /function barPercent/.test(drops)
    ? ok('the percentage comes from the progress bar, not from text')
    : fail('drops.js reads the percentage out of text again');

  /function captionNear/.test(drops) && !/if \(el\.children\.length\) continue/.test(drops)
    ? ok('the caption is read from its container, which is not a leaf')
    : fail('drops.js expects the caption to be a leaf node again');

  /function collectProgress/.test(drops) && /state\.mode !== 'claim'/.test(drops)
    ? ok('progress is only read on the inventory page')
    : fail('drops.js scrapes progress outside the inventory');

  /*
   * An inventory holds months of campaigns and the running one is at the
   * bottom. A bound that counts kept bars lets the expired ones upstream eat
   * the budget before the scan arrives.
   */
  /for \(var i = 0; i < bars\.length && i < MAX_SCANNED_BARS; i\+\+\)/.test(drops)
    ? ok('the scan bound counts bars examined, not bars kept')
    : fail('drops.js can run out of scan budget before the live campaign');

  /function storeProgress/.test(sw) && /Array\.isArray\(items\)/.test(sw) &&
      /slice\(0, MAX_PROGRESS_ITEMS\)/.test(sw)
    ? ok('the background validates and caps what the page reported')
    : fail('background/sw.js trusts the scraped progress unchecked');

  /*
   * The inventory lists campaign after campaign. Capping in document order
   * before ranking keeps four drops that just started and throws away the one
   * that is nearly finished further down the page.
   */
  /progressRank\(a\) - progressRank\(b\) \|\| remainingMs\(a\) - remainingMs\(b\)/.test(sw) &&
      sw.indexOf('.sort(') < sw.indexOf('slice(0, MAX_PROGRESS_ITEMS)')
    ? ok('progress is ranked before it is capped')
    : fail('background/sw.js caps the progress list before ranking it');

  /function campaignName/.test(drops) && /CAMPAIGN_ROW/.test(drops)
    ? ok('each drop is reported with its campaign')
    : fail('drops.js reports drop names without their campaign');

  /*
   * A dimmed reward image marks a drop the user has not earned yet, not a
   * campaign that ended - reading it as the latter marked every running drop as
   * expired. What separates the two is that a live campaign links to the
   * channels where it can be earned.
   */
  /function campaignIsOver/.test(drops) && /a\[href\]/.test(drops) &&
      !/inventory-opacity/.test(drops)
    ? ok('a campaign counts as over when it no longer links to its channels')
    : fail('drops.js judges campaigns by the dimmed reward image again');

  /if \(!live\.length\) live = out;/.test(drops)
    ? ok('expired campaigns are dropped, but never the whole list')
    : fail('drops.js can filter every drop away');

  /*
   * A finished drop has no remaining time, so it must not take a row from a
   * running one - but it is still worth showing. The popup splits the two and
   * renders the finished ones as markers.
   */
  /item\.percent < 100/.test(js) && /function doneRow/.test(js)
    ? ok('finished drops are marked, not ranked against running ones')
    : fail('popup.js mixes finished drops into the running list');

  /function progressRow/.test(js) && /dp-fill/.test(js) &&
      /fill\.style\.width/.test(js)
    ? ok('each running drop gets a bar sized to its progress')
    : fail('popup.js shows progress as text only');

  /createElement\('div'\)/.test(js) && !/dpList[^\n]*innerHTML/.test(js)
    ? ok('progress rows are built as nodes, not as markup')
    : fail('popup.js builds progress rows from a string');

  /id="dpList"/.test(html)
    ? ok('the popup has a progress card')
    : fail('popup.html has no progress card');
}

console.log(errors ? `\n${errors} problem(s).\n` : '\nAll clean.\n');
process.exit(errors ? 1 : 0);
