# Store permission declarations

## Single purpose

AD-Twitcher provides local Twitch viewing utilities that automate the claiming of already available rewards, manage selected live channels, mute ad breaks and display activity measurements.

## Chrome permissions

### storage

Stores user settings, local activity counters, watched channel names, verified playback totals, session counts, viewing timestamps, measured viewer activity, the automatic Drops campaign queue, farming-tab state and claim history. Channel history is recorded only while Watch Health is enabled and can be deleted in the popup. Diagnostic logs remain in memory only. The data remains on the user's device and is not transmitted by the extension.

### tabs

Finds open Twitch tabs, opens the Twitch Drops inventory when needed, owns one muted eligible stream tab for optional automatic Drops farming, and opens or closes selected followed-channel tabs for the optional auto-join feature. The farming tab is tracked locally so unrelated user tabs are never adopted or closed.

### alarms

Schedules local periodic checks for Drops campaign progress, completed rewards and live-channel maintenance while allowing the Manifest V3 service worker to remain idle between checks.

### scripting

Reinjects the extension's packaged content scripts into already open Twitch tabs after installation or an extension update. No downloaded or remotely hosted code is executed.

### notifications

Shows a local warning when a monitored Twitch stream stops progressing or the browser suspends its tab, because Drops and channel points may no longer accumulate. When Automatic Drops farming is enabled, notifications are also shown when a farming stream switches, a campaign completes and no more eligible streams remain, or a drop is claimed. Notifications contain only the affected channel or campaign name and never leave the user's device.

### Host access: `*://*.twitch.tv/*`

Required because every feature operates exclusively on Twitch pages. The extension reads Twitch page state to identify available reward buttons, completed drop notifications, ad state, followed live channels, player media progress, viewer counts and chat activity. It does not access other websites.

## Firefox permissions

Firefox uses the same `storage`, `tabs`, `alarms`, `notifications` and Twitch host-access purposes described above. The Firefox Manifest V2 build does not request the `scripting` permission because its packaged scripts use the Manifest V2 tab injection API.

## Opera GX permissions

Opera GX uses the same Manifest V3 package and the same `storage`, `tabs`,
`alarms`, `scripting`, `notifications` and Twitch host-access purposes described for Chrome.

## Microsoft Edge permissions

Microsoft Edge uses the exact Chrome Manifest V3 package and therefore the same
`storage`, `tabs`, `alarms`, `scripting`, `notifications` and Twitch host-access
purposes described for Chrome.

## Remote code declaration

No. AD-Twitcher does not download or execute remote code. All executable code is included in the submitted package as readable JavaScript.

## Data-use declaration

AD-Twitcher does not collect or transmit user data. Settings, watched channel names, verified playback totals, session counts, viewing timestamps, counters, activity measurements, the automatic Drops campaign queue, farming-tab state and claim history are processed and stored locally only; diagnostic logs remain in memory. No analytics, advertising SDKs, tracking technologies or external APIs are used.

## Reviewer test notes

1. Sign in to Twitch and open a channel page.
2. Open the extension popup and confirm that the channel and active modules appear.
3. Use the Settings tab to enable or disable individual modules.
4. A channel point claim can be observed when Twitch displays a bonus chest.
5. A completed drop can be claimed on `https://www.twitch.tv/drops/inventory`.
6. The ad overlay appears only while Twitch reports an active ad break and disappears when the ad ends.
7. Viewer metrics appear after chat and viewer activity have been observed on a channel page.
8. Pause a channel player for the configured warning period to observe the localized playback-stopped notification and one automatic recovery reload.
9. Enable Automatic Drops farming in Settings. Confirm the farming tab opens, switches channels after the configured progress-probe window, and shows the active campaign in the popup.
10. With Watch Health enabled, watch two channels, then open My stats to inspect local totals for today, week, month and all time. Disabling Watch Health stops new history; the delete button clears existing channel history.

No separate account, paid feature or test credential is required beyond a normal Twitch account.
