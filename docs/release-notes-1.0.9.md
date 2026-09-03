# AD-Twitcher 1.0.9 — Release Notes & Review Notes

Version: 1.0.9 · Build: 2026-09-03 · Chrome, Firefox, Opera

---

## 1. Release Notes (for store listing / changelog fields)

### What's new in 1.0.9

- **Settings tab redesigned.** Every settings card is now grouped and clearly
  labelled, numeric fields show their default value right next to the input,
  each card has its own Reset button, and a separate "Danger zone" section
  holds the global reset. Saving changes shows a confirmation toast.
- **Personal channel statistics.** The extension can now track how long you
  watch each channel (local watch-time, weekly/monthly totals and per-channel
  ranking) — an opt-in feature under Watch Health. A follow-up setting
  `includeInStats` lets Drops farming channels count toward your own statistics.
- **Farming robustness.** Automatic Drops farming no longer fights your own
  browser tabs: tab ownership survives a browser restart, and the extension
  only ever takes over tabs it created itself. Campaign drops appear to farms
  even while automatic claiming is switched off, and expired campaigns leave
  the queue automatically.
- **Fresher drop list.** The inventory scan is now authoritative: a small or
  empty (but successfully read) drop list correctly removes campaigns that are
  no longer available, instead of keeping stale entries.

### Fixes

- **Farming after a browser restart.** Restoring a browser session now finds
  the extension's own farming tab again (via a private page marker), instead of
  opening a duplicate and leaving the old one orphaned. A tab you opened
  yourself is never mistaken for a farming tab.
- **Concurrent settings.** A settings change arriving while Drops discovery was
  in flight is now applied immediately afterwards instead of being dropped.
- **Selected campaign stays selected.** An empty inventory no longer
  resurrects a campaign you had already removed or that genuinely ended.
- **Watch Health off means off.** Turning off Watch Health stops recording
  personal channel history too — no more history being built while the feature
  is disabled.

### What did not change

- No new permissions, no new data collection. All data stays on your device
  (settings, activity log, drop progress and channel statistics in extension
  storage).

---

## 2. Review Notes ("Notes for reviewers" fields)

### Permissions used

| Permission | Why |
|---|---|
| `storage` | Settings, activity log, drop progress, channel statistics — all local |
| `tabs` | Check whether a channel/inventory tab is already open (auto-join, drops, farming) |
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
stored data (settings, activity history, drop progress, channel statistics)
lives in `chrome.storage.local`/`browser.storage.local` on the user's device
and is not sent anywhere. See `PRIVACY.md`.

### What changed in 1.0.9 (for the reviewer)

1. **Settings tab** (popup.js/popup.html/popup.css): cards are grouped with
   aria labels, numeric defaults shown, per-card Reset, and a Danger zone for
   the global reset. Verify all controls still save after the rework.
2. **Channel statistics + includeInStats** (watch-health.js): enable Watch
   Health to record per-channel local watch-time; the Drops `includeInStats`
   option lets farmed channels count. Verify no data is sent off-device.
3. **Farming tab ownership** (drops-orchestrator.js): enable auto-farming, then
   restart the browser — the extension must recover its own farm tab without
   opening a duplicate, and must never adopt a tab you opened yourself.
4. **Drops farming with auto-claim off**: with automatic claiming disabled but
   farming enabled, discover/select a campaign — it must still farm progress.
5. **Authoritative drop list** (drops.js): with auto-claim on, an inventory
   showing a smaller/empty list of earnable drops must remove formerly cached
   campaigns instead of keeping stale entries.

### Files

Source is unminified and readable in `src/`. Firefox (AMO) additionally
requires a source upload — the same `src/` tree, no build step needed;
`node build.mjs --zip` reproduces the packaged extension if you want to
verify the zip matches the source.
