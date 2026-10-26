# AD-Twitcher 1.0.10 — Release Notes & Review Notes

Version: 1.0.10 · Build: 2026-10-26 · Chrome, Edge, Firefox, Opera

---

## 1. Release Notes (for store listing / changelog fields)

### What's new in 1.0.10

- **Closing the farming tab pauses farming.** A farming tab you close yourself
  is no longer reopened straight away. Farming pauses and the popup says so;
  "Apply queue" or switching auto-farming off and on resumes it. If the whole
  window closes, farming carries on in a new tab as before.
- **An open inventory is always used.** With "Then open the inventory in a
  background tab" switched off, an inventory tab you already have open is still
  used to claim finished drops. The setting now only decides whether the
  extension may open a new tab. The periodic drops check runs either way.

### Fixes

- **The inventory tab closer only closes the inventory.** The extension closes
  the background inventory tab it opened after a short while. If that tab had
  since been navigated elsewhere - or, after a browser restart, the same tab id
  belonged to another tab - it was closed anyway. It is now left open unless it
  still shows the drops inventory.
- **Silent farming tab in older Firefox.** Firefox before 126 rejected the
  combined mute/keep-alive update, so the farming tab played audio. Muting is
  now a separate call.
- **No false "drop unlocked" in Russian and Japanese.** The extension's own
  "drop claimed" message matched the unlock detection in these languages and
  could trigger an unnecessary inventory check after leaving the inventory.
- **Settings fields respect their limits.** Number fields are clamped to their
  allowed range as you type; a failed full reset is now reported.
- **No double start.** Install and browser start no longer inject the content
  scripts twice into the same Twitch tab at once.
- Background errors from closed tabs are handled quietly instead of surfacing
  as unhandled errors.

### What did not change

- No new permissions, no new data collection. All data stays on your device.

---

## 2. Review Notes ("Notes for reviewers" fields)

### Permissions used

| Permission | Why |
|---|---|
| `storage` | Settings, activity log, drop progress, channel statistics — all local |
| `tabs` | Check whether a channel/inventory tab is already open (auto-join, drops, farming) |
| `alarms` | Periodic checks that survive the MV3 service worker being stopped |
| `scripting` (Chrome/Edge/Opera) | Inject the content scripts into Twitch tabs that were open before install |
| `notifications` | "Stream may be stalled" watchdog and farming notifications |
| `host_permissions` / `*://*.twitch.tv/*` | Ad-mute, auto-claim, watchdog — all functionality runs on Twitch pages only |

Firefox uses an equivalent set (`storage`, `tabs`, `alarms`, `notifications`,
`*://*.twitch.tv/*`, persistent background page); MV3 service worker on
Chrome, Edge and Opera.

### Data handling

No telemetry, no analytics, no remote servers. The extension never transmits
anything. All stored data lives in `chrome.storage.local` /
`browser.storage.local` on the user's device. See `PRIVACY.md`.

### What changed in 1.0.10 (for the reviewer)

1. **Farming pause** (background/drops-orchestrator.js): enable auto-farming,
   let it open its tab, close that tab by hand - no new tab opens and the
   popup shows the paused state. "Apply queue" resumes farming.
2. **Open inventory** (background/sw.js): switch off "open the inventory in a
   background tab", open twitch.tv/drops/inventory yourself and press the
   popup's drops check - claims run in that tab, no extra tab opens.
3. **Inventory tab closer** (background/sw.js): when the extension opens the
   inventory in a background tab, navigate that tab to a channel before it is
   closed - it stays open.
4. **Unlock detection** (content/modules/drops.js): the extension's own toast
   is ignored by the drop-unlock watcher.

### Files

Source is unminified and readable in `src/`. Firefox (AMO) additionally
requires a source upload — the same `src/` tree, no build step needed;
`node build.mjs --zip` reproduces the packaged extension if you want to
verify the zip matches the source.
