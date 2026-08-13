# Store permission declarations

## Single purpose

AD-Twitcher provides local Twitch viewing utilities that automate the claiming of already available rewards, manage selected live channels, mute ad breaks and display activity measurements.

## Chrome permissions

### storage

Stores user settings, local activity counters, diagnostic logs, watched channel names and measured viewer activity. The data remains on the user's device and is not transmitted by the extension.

### tabs

Finds open Twitch tabs, opens the Twitch Drops inventory when a completed drop notification is detected, and opens or closes selected followed-channel tabs for the optional auto-join feature.

### alarms

Schedules local periodic checks for completed drops and maintenance of live-channel state while allowing the Manifest V3 service worker to remain idle between checks.

### scripting

Reinjects the extension's packaged content scripts into already open Twitch tabs after installation or an extension update. No downloaded or remotely hosted code is executed.

### Host access: `*://*.twitch.tv/*`

Required because every feature operates exclusively on Twitch pages. The extension reads Twitch page state to identify available reward buttons, completed drop notifications, ad state, followed live channels, viewer counts and chat activity. It does not access other websites.

## Firefox permissions

Firefox uses the same `storage`, `tabs`, `alarms` and Twitch host-access purposes described above. The Firefox Manifest V2 build does not request the `scripting` permission because its packaged scripts use the Manifest V2 tab injection API.

## Opera GX permissions

Opera GX uses the same Manifest V3 package and the same `storage`, `tabs`,
`alarms`, `scripting` and Twitch host-access purposes described for Chrome.

## Remote code declaration

No. AD-Twitcher does not download or execute remote code. All executable code is included in the submitted package as readable JavaScript.

## Data-use declaration

AD-Twitcher does not collect or transmit user data. Settings, watched channel names, counters, diagnostic logs and activity measurements are processed and stored locally only. No analytics, advertising SDKs, tracking technologies or external APIs are used.

## Reviewer test notes

1. Sign in to Twitch and open a channel page.
2. Open the extension popup and confirm that the channel and active modules appear.
3. Use the Settings tab to enable or disable individual modules.
4. A channel point claim can be observed when Twitch displays a bonus chest.
5. A completed drop can be claimed on `https://www.twitch.tv/drops/inventory`.
6. The ad overlay appears only while Twitch reports an active ad break and disappears when the ad ends.
7. Viewer metrics appear after chat and viewer activity have been observed on a channel page.

No separate account, paid feature or test credential is required beyond a normal Twitch account.
