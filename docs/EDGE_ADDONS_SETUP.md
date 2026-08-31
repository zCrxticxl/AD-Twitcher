# Microsoft Edge Add-ons release setup

Edge uses `src/manifest.chrome.json` and the shared Chromium source without a
fork. Verification requires the built Edge manifest to be byte-identical to the
Chrome manifest.

The integration uses Microsoft Edge Add-ons Update REST API v1.1. It uploads the
verified Edge ZIP to an existing product draft, polls package processing,
submits the draft, and polls submission processing.

## Account setup

1. Publish AD-Twitcher once through Microsoft Partner Center and complete its listing and privacy fields.
2. In the extension overview, record the product ID.
3. Under **Microsoft Edge > Publish API**, enable the new API-key experience.
4. Create dedicated API credentials and record the client ID and API key.
5. Note the API key expiry date and schedule rotation before it expires.

## GitHub configuration

Create these repository variables:

| Name | Value |
|---|---|
| `EDGE_PRODUCT_ID` | Existing Partner Center extension product GUID |
| `EDGE_CLIENT_ID` | Publish API v1.1 client ID |

Create this secret in the protected `production` environment:

| Name | Value |
|---|---|
| `EDGE_API_KEY` | Publish API v1.1 API key |

## Rotation and verification

Create a replacement API key in Partner Center, update the environment secret,
verify a protected tag release, then revoke the previous key. Edge package and
submission processing remain **NOT YET VERIFIED** until the API accepts a real
credentialed release and Partner Center displays the new submission.

Official references:

- <https://learn.microsoft.com/microsoft-edge/extensions/update/api/using-addons-api>
- <https://learn.microsoft.com/microsoft-edge/extensions/update/api/addons-api-reference>
