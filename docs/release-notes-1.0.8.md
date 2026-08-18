# AD-Twitcher 1.0.8 — Release Notes & Review Notes

Version: 1.0.8 · Build: 2026-08-18 · Chrome, Firefox, Opera

---

## 1. Release Notes (for store listing / changelog fields)

### What's new in 1.0.8

- **Drops inventory rework.** Every running drop now shows as a progress bar
  in the popup, with finished drops marked instead of ranked. The list now
  reaches the actual running campaign (no more jumping to already-collected
  rewards), and a campaign is judged by its channel links, so it stays in the
  list correctly even after Twitch dims its image.
- **Popup reliability.** If a settings write fails (e.g. the background
  service worker was mid-restart), the popup now re-reads the real stored
  settings and re-syncs every control — no more toggle that silently flips
  back or shows the wrong state.
- **Manual refresh.** The popup's own "check now" button also refreshes the
  drop figures, so progress updates without waiting for the next automatic
  check.

### Fixes

- **Playback recovery no longer fights the user.** After an ad ends, the
  extension used to auto-resume and — if playback stayed stalled — reload the
  tab. It now recognizes a pause you made on purpose (player click or
  space/k key) and leaves your player exactly where it is. A genuinely
  stalled player is still recovered with a single guarded reload.
- **Auto-join no longer closes your own tabs.** When a followed channel goes
  live, the extension can auto-open and later auto-close that tab when the
  stream ends. It now only closes tabs it opened itself — a tab you already
  had open is never closed by the extension.
- **Drops: one inventory tab per unlock.** Two channel tabs seeing the same
  "drop unlocked" toast within a second could open two inventory tabs.
  Only one is opened now.

### What did not change

- No new permissions, no new data collection. All data stays on your device
  (settings, activity log and drop progress in extension storage).

---

## 2. Review Notes ("Notes for reviewers" fields)

### Permissions used

| Permission | Why |
|---|---|
| `storage` | Settings, activity log, drop progress — all local |
| `tabs` | Check whether a channel/inventory tab is already open (auto-join, drops) |
| `alarms` | Periodic checks that survive the MV3 service worker being stopped |
| `scripting` (Chrome/Opera) | Refresh/claim helper on the inventory page |
| `notifications` (Chrome) | "Stream may be stalled" watchdog notification |
| `host_permissions` / `*://*.twitch.tv/*` | Ad-mute, auto-claim, watchdog — all functionality runs on Twitch pages only |

Firefox uses an equivalent set (`storage`, `tabs`, `alarms`, `notifications`,
`*://*.twitch.tv/*`, persistent background page); MV3 service worker on
Chrome/Opera.

### Data handling

No telemetry, no analytics, no remote servers. The extension never transmits
anything: no tracking, no ad-network SDKs, no third-party requests. All
stored data (settings, activity history, drop progress) lives in
`chrome.storage.local`/`browser.storage.local` on the user's device and is
not sent anywhere. See `PRIVACY.md`.

### What changed in 1.0.8 (for the reviewer)

1. **Drops inventory page**: rewritten progress parsing and sorting (drops.js).
   Verify on https://www.twitch.tv/drops/inventory with at least one running
   campaign: every row shows a progress bar; finished drops are shown as
   markers, not ranked among running ones.
2. **Popup**: re-sync on failed settings write (popup.js). Reproduce: open
   the popup, toggle a switch — it must stick; no flicker back.
3. **Ad recovery** (ad-mute.js): play a channel, wait for an ad to finish,
   pause manually within ~3.5 s after the ad — the tab must NOT reload and
   the player must stay paused. Without pausing, a stalled player is still
   recovered by one reload.
4. **Auto-join** (live-watch.js): with a followed channel already open in a
   tab you opened yourself, the extension must not close that tab when the
   stream ends (close-when-offline setting).
5. **Drops inventory tab**: two channels unlocking a drop around the same
   time must open only one inventory tab.

### Files

Source is unminified and readable in `src/`. Firefox (AMO) additionally
requires a source upload — the same `src/` tree, no build step needed;
`node build.mjs --zip` reproduces the packaged extension if you want to
verify the zip matches the source.
