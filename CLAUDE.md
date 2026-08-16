# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Commands

```bash
npm test              # check + smoke + harness, in that order. The gate for everything.
npm run check         # scripts/check.mjs   static/source-pattern checks, numbered [1]..[18]
npm run smoke         # scripts/smoke.mjs   pure-function logic tests in a vm context
npm run harness       # scripts/harness.mjs lifecycle/integration sandboxes
node build.mjs        # dist/chrome, dist/firefox, dist/opera
node build.mjs chrome --zip
```

There is no test-name filter and no watch mode. The three scripts are the unit of
granularity: run the one that covers what you touched, then `npm test` before
calling anything done. Node >= 18, no dependencies, no `node_modules`, nothing to
install.

Load an unpacked build from `dist/<target>/`, never from `src/` — `src/` holds
three manifests and no valid single one.

## Architecture

A Twitch extension built from one source tree for Chrome/Opera GX (MV3) and
Firefox (MV2). Plain ES5-style JavaScript in IIFEs (`var`, no `let`/arrow/class),
no bundler, no transpiler, no runtime dependencies. `build.mjs` copies `src/` to
`dist/<target>/`, drops the matching `manifest.<target>.json` in as
`manifest.json`, and stamps the version from `package.json` — so the manifests'
own `version` fields are dead values, and `package.json` is the single source.

Every file attaches to one global namespace, `g.ADT`, and files depend on load
order rather than imports:

- **Content scripts** — `manifest.*.json` `content_scripts[0].js` fixes the order:
  `beacon.js` first, then `lib/*`, then `content/modules/*`, then
  `content/index.js` last. `popup.js` mirrors that list in `EXPECTED_FILES`, and
  check `[3]`/`[4]` fails the build when the two drift.
- **Background** — the same libs, loaded by `importScripts` inside `sw.js` under
  MV3 and by the manifest's `background.scripts` array under MV2. `sw.js` guards
  the import with `if (typeof importScripts === 'function' && !g.ADT)`.
- **`content/index.js`** is the orchestrator: it picks modules from settings plus
  the current route and fully stops/restarts them on SPA navigation, because
  Twitch remounts player and chat on a channel switch. Modules expose
  `{ start(cfg), stop() }` on `g.ADT.modules.<name>` and must be inert after
  `stop()` — including any timer they already scheduled.
- **`content/beacon.js`** must stay dependency-free and run first. It answers
  `adt:ping` with the list of files that reached the end of their IIFE, which is
  what lets the popup distinguish "script never injected" from "script threw".

### Invariants that the checks enforce

**All runtime state lives in `storage.local`, never in a module variable.**
Chrome terminates the MV3 service worker at any moment, including mid-ad and
mid-claim. A variable that survives in Firefox's persistent background page
silently vanishes in Chrome. The one deliberate exception is `lastInventoryReload`
in `sw.js`, a cooldown whose worst case on worker loss is one extra reload.

**`D.safeClick` is the only click path.** Twitch mixes free and paid actions in
the same UI, so a selector one step too broad buys Power-ups with Bits. Three
guards in `lib/dom.js`: the `DANGER_RX` money blocklist (all 12 languages), the
dialog guard, and a global budget of 10 clicks/minute. `humanClick` stays
private, and `drops.js` may not click outside `/drops/inventory`.

**`globalThis`, not `window`.** In Firefox content scripts the sandbox global is
not `window`; mixing the two builds two half-filled `ADT` objects. Chrome hides
this because `globalThis === window` there.

**The 12 locale catalogs must define the identical key set.** Adding a UI string
means adding it to all of `src/_locales/*/messages.json`. Check `[9]`/`[10]` fail
on a missing key, an extra key, an empty message, a placeholder mismatch, a
referenced key that does not exist, and a defined key nothing uses. UI text goes
through `ADT.msg(key)` or `data-i18n` attributes; log output stays English on
purpose, because it ends up in bug reports.

**DOM matchers cover all 12 Twitch UI languages,** not just the UI locale:
`CLAIM_TEXTS` (drops), `SHOW_MORE_TEXTS` (sidebar-watch), `NOTIFY_RX` (drops),
`BONUS_RX` (channel-points), `DANGER_RX` (dom), `SCALES` (viewer-stats).

**Files are CRLF.** All 50 text files in the tree are, and there is no
`.gitattributes` to normalize. A script that rewrites a file with `\n` produces a
mixed-ending file that no check catches — join with `\r\n` when generating edits.

**No `innerHTML` on injected surfaces.** Overlay, viewer panel and popup
diagnostics build nodes with `createElement`/`textContent`, because Twitch text
and error strings flow into them.

### Things Twitch makes impossible

Documented in README and STATUS so they do not get re-attempted: ads cannot be
skipped or blocked (SSAI muxes them into the same HLS stream), drops cannot be
farmed without a running player (progress is counted server-side from
heartbeats), and bought viewers cannot be told from real ones. `viewerStats`
therefore reports raw values and passes no judgment.

Twitch also renders `/drops/inventory` once from load-time data and never
refetches it, so a finished drop has no claim button in an old tab's DOM.
Claiming needs a reload, not another scan — that is why the background owns a
cooldowned `refreshInventoryTab()` and the content script reports
`{ pending, stale }` back to it.

## Repository conventions

- Apache 2.0 header plus `@fileoverview` on every source file; JSDoc types on
  functions; English comments that explain *why*, named constants instead of
  inline magic numbers.
- Comments carry the reasoning that is expensive to rediscover (why the mute is
  on the tab and not the player, why the beacon has no dependencies). Match that
  density; do not add narration.
- `STATUS.md` is the handover document: verification state per browser, what was
  fixed and why, open items, and a "not feasible, do not retry" list. Update it
  when behavior changes. `README.md` is the user-facing half.
- Bumping a user-visible behavior usually means touching six places at once:
  the module, `lib/storage.js` DEFAULTS, `popup.html`, all 12 locales,
  `scripts/check.mjs`, and `STATUS.md`.
- `store/` holds listing copy and screenshots; a UI change may leave the
  screenshots stale.
