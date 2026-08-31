# Chrome Web Store release setup

The integration uses the Chrome Web Store API v2 and a Google service account.
It uploads the verified Chrome ZIP, waits for package processing to succeed, and
submits the item for normal review with warnings treated as blocking. It never
requests review bypass.

## Account setup

1. Publish AD-Twitcher once through the Chrome Web Store developer dashboard and complete all listing, privacy and distribution fields.
2. Record the extension item ID and publisher ID from the dashboard.
3. Create or select a Google Cloud project and enable the Chrome Web Store API.
4. Create a dedicated service account and an RSA key for release automation.
5. Grant that service account access to the Chrome Web Store publisher account as described by the current Chrome Web Store API onboarding guide.
6. Keep the downloaded key outside the repository and delete local copies after configuring GitHub.

## GitHub configuration

Create a protected GitHub environment named `production`. Require trusted
reviewers and prevent unreviewed branches or tags from deploying to it.

Create these repository variables:

| Name | Value |
|---|---|
| `CHROME_EXTENSION_ID` | Existing Chrome Web Store item ID |
| `CHROME_PUBLISHER_ID` | Chrome Web Store publisher ID |
| `CHROME_SERVICE_ACCOUNT_EMAIL` | Dedicated service account email |

Create this `production` environment secret:

| Name | Value |
|---|---|
| `CHROME_SERVICE_ACCOUNT_PRIVATE_KEY` | The service-account JSON key's `private_key` value, including PEM boundaries |

Do not store the complete service-account JSON document. The workflow needs only
the non-sensitive email and private key, reducing accidental exposure and
avoiding a structured secret that GitHub cannot reliably redact as one unit.

## Rotation and verification

Create a replacement key, update the environment secret, run a reviewed tag
release, then revoke the previous key. Service-account publishing is
credential-dependent and remains **NOT YET VERIFIED** until a real protected
release succeeds and the developer dashboard shows the submitted version.

Official references:

- <https://developer.chrome.com/docs/webstore/using-api>
- <https://developer.chrome.com/docs/webstore/api/reference/rest/v2/media/upload>
- <https://developer.chrome.com/docs/webstore/api/reference/rest/v2/publishers.items/publish>
