# Firefox AMO release setup

The Firefox manifest has the stable ID `ad-twitcher@zcrxticxl`. The integration
uses Mozilla's Add-on Submission API v5 directly: it uploads the verified
Firefox ZIP to the `listed` channel, polls validation, and creates a version only
after validation succeeds.

The repository intentionally does not install `web-ext`. The latest stable
release inspected while this automation was added resolved to a known
high-severity `image-size` parser denial-of-service advisory through
`addons-linter`. The documented AMO API requires only HS256 JWTs and multipart
upload, both implemented with Node.js 22 built-ins, so retaining that dependency
would increase rather than reduce CI risk.

## Account setup

1. Create or confirm the existing listed AD-Twitcher entry on addons.mozilla.org.
2. Confirm its add-on GUID is exactly `ad-twitcher@zcrxticxl`.
3. Complete listing metadata, categories, license, privacy policy and reviewer information in Developer Hub.
4. Open AMO's API Credentials page and generate a dedicated key and secret for release automation.

## GitHub configuration

Create this repository variable:

| Name | Value |
|---|---|
| `AMO_EXTENSION_ID` | `ad-twitcher@zcrxticxl` |

Create these secrets in the protected `production` environment:

| Name | Value |
|---|---|
| `WEB_EXT_API_KEY` | AMO API issuer/key, normally beginning with `user:` |
| `WEB_EXT_API_SECRET` | AMO API secret |

The JWT expires after 60 seconds and has a unique cryptographic ID. The long-lived
AMO secret is never passed on a command line or written to disk.

## Rotation and verification

Generate replacement AMO credentials, update both environment secrets, verify a
protected release, and revoke the old credentials. AMO signing and listed
submission remain **NOT YET VERIFIED** until a credentialed release confirms the
new version in Developer Hub.

Official references:

- <https://mozilla.github.io/addons-server/topics/api/auth.html>
- <https://mozilla.github.io/addons-server/topics/api/addons.html#upload-create>
- <https://mozilla.github.io/addons-server/topics/api/addons.html#version-create>
