# AD-Twitcher - status and handover

Version 1.0.7, 17 August 2026. Audited in full on the same day.

## Verification status

| Layer | State |
|---|---|
| `npm test` (syntax, manifests, 21 static checks, 152 logic tests, lifecycle harness) | passing |
| Runtime in Firefox | **partial**, see open items |
| Runtime in Chrome | **never tested** |
| Runtime in Opera GX | package loads; 12-locale drop-claim fixture passing; live Twitch pending |
| Popup rendering in a real browser | **passing** at 380 × 600; overview and tab interaction checked |

The source and all three distribution targets build successfully. A dependency-free
lifecycle harness now verifies that delayed automation cannot click after a
module has stopped. The popup was rendered and interacted with in a browser;
live Twitch behavior still requires manual browser sessions.

## Reliability and UI pass

1. `humanClick()` now emits exactly one activation instead of dispatching a
   click event and then calling `element.click()` a second time.
2. Channel-point and drop timers are tracked, cancelled on `stop()`, and
   revalidate module state and route immediately before clicking.
3. Settings and counter writes are serialized through the background context.
4. Temporary MV3 inventory tabs close through persisted browser alarms rather
   than service-worker timers.
5. Sidebar reports are stored per tab and merged, with stale reports pruned.
6. `scripts/harness.mjs` exercises stop-with-pending-click lifecycle behavior.
7. The popup has a new compact visual system, accessible tab state, keyboard
   focus treatment, reduced-motion support and viewport-safe sizing.
8. Ad-mute now ignores hidden and stale Twitch ad markers. Player-level `--ad`
   classes no longer keep the overlay and mute state alive after an ad break.
9. The overview identifies its counters as lifetime statistics, uses precise
   action labels, and stores the first and latest recorded activity timestamps.
10. Small, safely opened creator links for Buy Me a Coffee and @zCrxticxl are
    available in the popup footer, with localized accessible labels.
11. Ad recovery now reacts to tab focus and visibility changes, rebinds after
    Twitch replaces the player, removes stale placeholders and verifies that
    media time progresses after an ad. If Twitch still leaves the player
    stalled, one guarded automatic reload recovers playback.
12. The stream watchdog measures actual video-time progress, marks monitored
    tabs as non-discardable, reports stale or suspended tabs through localized
    browser notifications and performs at most one recovery reload per incident.
13. Drops no longer wait for a manual F5. Twitch renders the inventory once from
    data fetched at load time, so an open tab cannot show a drop that finished
    afterwards. When an unlock is reported and the open inventory has nothing to
    claim, the background reloads that tab once (three-minute cooldown) and
    claims when it is back; a hidden inventory tab also refreshes itself past a
    15-minute view age. The claim scan reports what it found and how old its
    view is, so a current inventory is never reloaded for nothing.
14. Ads are muted on the browser tab instead of the `<video>` element, so the
    player never sees a mute and watch time keeps accruing. A tab already muted
    by hand is left untouched and never unmuted. Mute ownership lives in
    `storage.local` and expires after ten minutes, because an ad break outlives
    the MV3 worker and a lost record would leave the tab silent for good. The
    watchdog additionally takes back any pause the user did not ask for, capped
    at six resumes per minute.
15. The popup footer shows the installed version in its bottom right corner. It
    is read from the manifest at runtime, which `build.mjs` stamps from
    `package.json`, so the badge cannot drift from the loaded package.
16. The status tab has an activity card, because a working extension and a dead
    one used to look identical: lifetime counters only move when something is
    claimed, and hours can pass in between. It shows the channel being watched
    and for how long, when the last drops check ran and what came of it
    (claimed, reloaded, opened, idle, off, error), when the next one is due, and
    what was claimed last. The drops outcome is written to `activityRuntime` in
    `storage.local` on every check, including skipped and failed ones, so the
    record survives the service worker that produced it.
17. Drop progress is read off the inventory page and shown as a remaining time,
    closest drop first, each with the campaign it belongs to. The percentage
    comes from the card's ARIA progress bar rather than from its caption, which
    is a number in every language; the caption is only read for the requirement.
    Expired campaigns keep their bars, so cards whose reward image Twitch has
    dimmed are dropped - unless that would empty the list, in which case they
    stay, because a class rename must not blank the card. Drops at 100 % are
    left out as well: they are claimed or waiting for the claimer, and either
    way they have no remaining time. Two campaigns can run under the same title
    with the same reward tiers, so a tier repeated within one campaign is
    reduced to its furthest entry while the same tier in a different campaign
    stays. The requirement is
    parsed without understanding the sentence: the number carrying the percent
    sign is the progress, the other number the requirement, and Turkish writes
    the sign in front, which the logic tests caught. Ranking happens over the
    whole page before the list is capped - capping in document order kept four
    drops that had just started and discarded one at 93 %. Scraped values are
    validated in the background, because they arrive from a content script.
18. Campaigns that are closed or already collected are gone from the list.
    Inferring it from the markup was not enough: the channel-link test misses
    rows that still carry their links, and reported drops nobody could earn any
    more. Twitch states it in a sentence instead - "Diese Belohnung ist nicht
    mehr verfügbar." - and the notice describes the whole campaign, not the one
    card it sits on, so a single occurrence retires the row it belongs to. The
    wording is matched in all twelve locales, as negated fragments only, since
    the bare word for "available" is a positive signal in `UNLOCK_WORD` and
    would flag every running drop.

    The two tests deliberately do not share a safety net. The link heuristic is
    an inference about markup and keeps its "never filter everything" fallback,
    because a redesign could make it match all rows. The notice gets none: when
    every campaign carries it, an empty list is the correct answer. A text
    matcher fails by going quiet, which only makes the list too long again -
    the harmless direction - so the net would buy nothing and cost the fix.

    That made the empty snapshot meaningful, and it was being thrown away at
    both ends. A stored snapshot is only ever replaced, never expired, so
    without a way to store an empty one the popup kept listing drops from a
    campaign that closed weeks ago. The content script now reports whether it
    read the page at all, and only a read page may clear the stored list; a
    scan that found nothing to go on still leaves it untouched. The popup tells
    the two states apart by the timestamp and says either "nothing earnable
    left" (`dropProgressNone`) or "not read yet" (`dropProgressEmpty`).

## Audit pass, 17 August 2026

A full read of the tree rather than a look at what was already suspected. Six
defects, none of which any existing test could have caught, because each one
needed a second execution, a second context or a restart to show itself.

19. **The periodic drops check never ran.** Creating an alarm that already
    exists restarts its countdown, and in MV3 the worker file runs again on
    every worker start - which the one-minute health alarm guarantees at least
    once a minute. So the drops alarm was pushed ten minutes into the future
    once a minute and never reached its own delay. The code was correct on the
    page and dead in the browser. Alarms now go through `ensureAlarm`, which
    only writes when the alarm is missing or its period changed, and the
    harness boots the worker twice on one alarm registry to prove it.

20. **A second injection duplicated everything.** The browser injects content
    scripts at document_idle, and the background injects into any Twitch tab
    that did not answer a ping - which a tab that is still loading cannot do.
    Only `beacon.js` guarded against running twice. A second pass registered a
    second message listener (so `sendResponse` fired twice), a second storage
    listener, a second route observer with its own interval and a second click
    budget - and left the first pass's modules running with nothing holding a
    reference to stop them. Every injected file now opens with `__adtOnce`.
    `started` is kept apart from `loaded` on purpose: `loaded` still means
    "reached its last statement", or the ping stops being a diagnostic.

21. **`drops.stop()` forgot its progress timer.** A channel switch stops and
    restarts every module, so one interval accumulated per navigation, and all
    of them resumed reporting the moment the module came back. Check [21] now
    diffs the timers a module starts against the ones it clears, for all six.

22. **`sidebar-watch` clicked after teardown.** Its expand timer was untracked,
    so a pending expand fired four seconds after a channel switch and clicked
    for a module that no longer existed. Tracked and cleared now, and
    `expandSidebar` checks `running` as well.

23. **Runtime records raced.** Which tabs are muted, which are watched, which
    channels auto-join opened - each was a plain get/set pair, and two Twitch
    tabs acting at once interleave them, so the second write drops the first
    one's change. It never looks like a storage bug: a tab stays silent after
    its ad, a channel tab is never closed, a second tab opens for a stream
    already running. `ADT.updateLocal` serializes per key, and the watchdog's
    whole pass is now one atomic read-decide-write.

24. **A rejected promise could blank the popup.** A handler returning `true`
    has promised a reply; if its promise rejected, the reply never came, the
    port hung, and the popup - which turns a dead port into `null` - rendered
    nothing, with no error anywhere. `answerWith` answers either way.

Smaller: counters coerce their increment, so a bad message cannot leave a
string in storage that every later bump appends to; the ad recovery reload
refuses to fire when its cooldown cannot be stored, because without the
cooldown it is a reload loop; `saveRt`/`saveMuteRt` are gone as dead code.

## 0.2.0

Full internationalization and a source-level pass over the whole tree.

1. **12 locales** under `src/_locales`: en (default), de, es, fr, it, pt_BR, pl,
   ru, tr, ja, ko, zh_CN. Both manifests carry `default_locale` and reference
   `__MSG_extName__` / `__MSG_extDescription__` / `__MSG_extActionTitle__`.

2. **No hardcoded UI text left.** `ADT.msg(key, subs)` in JavaScript,
   `data-i18n` / `data-i18n-title` / `data-i18n-aria-label` in `popup.html`,
   resolved once on load by `localizeDom()`. Log output stays English on
   purpose: it is diagnostic, and it ends up in bug reports.

3. **No hardcoded number formats left.** `ADT.formatNumber` follows
   `i18n.getUILanguage()`. The old `toLocaleString('de-DE')` calls are gone.

4. **DOM matchers now cover all 12 Twitch UI languages.** This is the part that
   actually changes behavior, not just wording:
   - `CLAIM_TEXTS` (drops) - 12 language sets instead of English and German
   - `SHOW_MORE_TEXTS` (sidebar-watch) - same
   - `NOTIFY_RX` (drops) - built from a drop-word list and an unlock-word list
     per language, matched in either order
   - `BONUS_RX` (channel-points) - "bonus" across Latin, Cyrillic and CJK
   - `DANGER_RX` (dom) - the money blocklist, extended from 2 languages to 12
   - `SCALES` (viewer-stats) - count suffixes: K, M, тыс., tys., mil, bin, 万,
     亿, and their relatives

   `DANGER_RX` was the actual risk here. Before this change the click guard only
   recognized paid wording in English and German, so a Turkish or Japanese
   Twitch UI would have slipped "buy" labels straight past it.

5. **Innerhtml removed from every injected surface.** Ad overlay, viewer panel
   and popup diagnostics are built with `createElement` and `textContent`. The
   old string concatenation put unescaped Twitch and error text into `innerHTML`.

6. **Source pass.** Apache 2.0 headers, `@fileoverview` and JSDoc types
   throughout, English comments, named constants instead of inline magic numbers
   (`RECOUNT_GRACE_MS`, `NOTIFY_DEBOUNCE_MS`, `STALE_AFTER_MS`,
   `SAMPLE_RETENTION_MS`, `BUDGET_PER_MIN`).

7. **Two new static checks.** `[9]` locale catalogs: identical key sets, no empty
   messages, matching `$1` placeholders. `[10]` key usage: every referenced key
   exists, every defined key is used. Both fail the build.

8. **New logic tests** in `scripts/smoke.mjs`: `ADT.msg` substitution and
   fallback, `formatNumber`, `parseCount` against 8 locale number formats,
   `DANGER_RX` against paid labels in all 12 languages plus the bonus chest
   captions it must *not* block, `NOTIFY_RX` against unlock notifications in all
   12 languages.

## Fixed earlier (0.1.0, all backed by real logs)

1. **Firefox: `globalThis` is not `window` in content scripts.**
   `lib/browser.js`, `log.js` and `storage.js` used `globalThis` while
   `lib/dom.js` and the modules used `window`. Result: two separate `ADT`
   objects, `window.ADT.api` undefined, `TypeError` in `index.js`. Invisible in
   Chrome, where `globalThis === window`. Guarded by check `[6]`.

2. **Content scripts were not injected into already open tabs.**
   The background does it itself on install, update and startup
   (`injectIntoOpenTabs`); Chrome needs the `scripting` permission for that.

3. **The ping handler hung off `content/index.js`** and died with it, so "no
   script" and "broken script" looked identical in the popup. It now lives in
   `content/beacon.js` with zero dependencies and reports which files loaded.
   Guarded by checks `[4]` and `[5]`.

4. **Click storm on Power-ups (they cost Bits).**
   `drops.js` had `'main'` as a root fallback and scanned every page for
   "Claim", which hit channel point rewards and Power-ups.
   `channel-points.js` matched `button[class*="ScCoreButton"]` inside the points
   container, meaning *every* button in it, "Rewards" included. Now: drops only
   click on `/drops/inventory`, everywhere else the notification is read only.
   Channel points require the `claimable-bonus` marker. Plus the money
   blocklist, the dialog guard and a global budget of 10 clicks per minute in
   `lib/dom.js`. Guarded by check `[7]`.

5. **Feedback loop: counters into module restarts.**
   Counters lived in `settings`; every bump fired `storage.onChanged`, `apply()`
   restarted all modules, the module saw the same ad or chest again and counted
   up. Four latches: separate `stats` storage key, signature comparison in
   `apply()`, cooldown surviving restarts, ad-mute debounce. Guarded by check
   `[8]`.

6. **`ad-mute` made the player stutter.**
   MutationObserver on `document.body` (fires continuously while chat runs)
   times seven `querySelector` calls plus `getBoundingClientRect` and
   `getComputedStyle` per pass, every 500 ms. Now one combined selector, the
   observer scoped to the player, a 1 s tick, `volumechange` instead of a timer,
   cached nodes.

## Open items

1. **Extend the lifecycle harness into a full integration harness.**
   Load all content scripts in manifest order into a full Twitch fixture and
   simulate 60 s. It should additionally verify:
   - no stop/start loop
   - the click budget is not exhausted
   - `adt:ping` answers with all 11 files
   - `localizeDom()` leaves no element empty

2. **Verify ad-mute recovery in a real Firefox.** Automated lifecycle and
   source-level checks pass. A real Twitch ad break is still required to verify
   the final behavior against Twitch's current player implementation. Two things
   to watch specifically: that the tab audio comes back after the break, and
   that `mutedInfo.reason` reports `extension` in Firefox the way it does in
   Chrome, since the release path checks it before unmuting.

3. **Verify the inventory reload against a real finished drop.** The reload
   path is driven end to end in the harness against stub tabs. What no test can
   answer is how long Twitch needs after a reload before the claim button is in
   the DOM; `INVENTORY_RENDER_MS` in `background/sw.js` is currently 4 s, and
   the content script keeps scanning afterwards regardless.

4. **Chrome has never been tested.** Above all `scripting.executeScript`
   injection and the MV3 service worker lifecycle.

5. **Auto-join is untested.** It depends on the followed sidebar and needs an
   open, logged-in Twitch tab.

6. **Locales are unverified at runtime.** The catalogs are statically complete
   and consistent, but no locale has been rendered in a browser. Worth checking
   specifically: popup width at 360 px with the longer German, Russian and
   Turkish strings, and whether Twitch's actual claim captions in ja, ko and
   zh_CN match `CLAIM_TEXTS` exactly (they are matched whole, so a trailing
   character breaks the match).

## Not feasible, do not retry

- **Skipping ads.** SSAI: ads are muxed into the same HLS stream. No separate
  video, no blockable request, and a live stream offers nothing past the live
  edge. Those 50 s are real wall time. The only ways out are Turbo, a sub, or a
  playlist proxy (external infrastructure, breaks constantly, cuts streamer
  payouts - deliberately not built).
- **Farming drops.** Twitch counts progress server-side from player heartbeats.
  Nothing grows without a running player.
- **Telling real viewers from bought ones.** Twitch publishes no viewer list.
  `viewerStats` deliberately returns raw values only.

## Debugging entry point

Popup, log level `debug`, Log tab. The informative lines:

- `Click [module] element "text" (n/10 per min)` - every permitted click
- `Click blocked (money|dialog)` - a guard fired
- `Configuration unchanged, no restart` - the loop latch is working
- stop/start chains within the same second - the feedback loop is back
