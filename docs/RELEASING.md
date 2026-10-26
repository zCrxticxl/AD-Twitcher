# Releasing AD-Twitcher

The release system requires Node.js 22 and has no npm dependencies. It builds
Chrome, Microsoft Edge, Firefox and Opera GX from the same readable JavaScript
source tree.

## Local preparation

1. Start from a reviewed commit on `main`.
2. Set the version with `npm run version:set -- X.Y.Z`.
3. Write the version-specific notes. The dry run fails until all three exist
   for the new version:
   - `docs/release-notes-X.Y.Z.md` - release and review notes for the record.
   - `docs/amo-version-notes.txt` - sent to AMO as the public release notes.
   - `docs/amo-reviewer-notes.txt` - sent to AMO as the notes for reviewers.

   The first line of both AMO files must name the version (`AD-Twitcher X.Y.Z`);
   `publish-firefox.mjs` refuses to submit notes written for another version.
   Update the Opera changelogs in `store/LISTING.opera.md` as well.
4. Run `npm ci --ignore-scripts`.
5. Run `npm run release:dry-run`.
6. Inspect `release/SHA256SUMS` and the four ZIP files under `release/`.
7. Review the complete Git diff before committing.

The dry run executes all tests, builds every target twice, compares SHA256
hashes, parses every ZIP itself, verifies CRCs and package contents, scans for
credential-like material, and checks target manifests and permissions. It does
not call GitHub or any browser store API.

## Tag release

After the reviewed release commit is on GitHub, create and push an exact tag
matching the repository version, such as `v1.0.9`. The workflow rejects tags
with leading zeroes, prerelease suffixes, extra components, or a version that
does not equal `package.json`.

`.github/workflows/release.yml` then performs these isolated stages:

1. `validate` installs from the lockfile, validates the tag and runs the test suite.
2. `package` creates and verifies deterministic ZIPs and uploads one short-lived workflow artifact.
3. `github-release` enters the protected `production` environment and creates or refreshes the GitHub Release.
4. `publish-chrome`, `publish-firefox` and `publish-edge` independently enter `production`, download the verified artifact, and submit only their browser package.

## Approve the production deployment

Steps 3 and 4 do not start on their own. The `production` environment requires
a review by `zCrxticxl` and only admits tags matching `v*.*.*`, so after
`package` succeeds the run stops at "Waiting for review".

1. Open the run under **Actions → Release** (or `gh run list --workflow release.yml`).
2. Choose **Review deployments**, tick `production`, and **Approve and deploy**.
   One approval covers every job of the run that is waiting at that moment.

A pending review expires after 30 days. The job then fails with "The
deployment was rejected or didn't satisfy other protection rules" and the store
jobs are skipped. An expired run cannot be approved any more: re-run it with
`gh run rerun <run-id> --failed` within GitHub's re-run window, or push the
next version tag.

Never move a published tag. v1.0.9 was published to Chrome and Firefox on
3 September 2026 from commit `79a55be`; the tag was later force-moved to
`7720e35`, which started a second run that sat unapproved until it expired. It
could not have published anyway, because the stores had already accepted
1.0.9. A change after publishing always gets a new version.

Opera GX remains a manual submission because Opera Add-ons does not provide a
comparable supported publishing API. Upload
`release/ad-twitcher-opera-vX.Y.Z.zip` and use the listing material in `store/`.

## Failure handling

GitHub Release creation is rerunnable for the same tag and replaces only the
deterministic release files. Store jobs report package-processing and submission
status and fail on API errors or timeouts.

Do not reuse a browser-store version after a store has accepted it. Fix the
problem, set a new version, rerun the local dry run, and create a new reviewed
tag. Revoke and replace a store credential immediately if it appears in logs,
artifacts, commits or an untrusted system.

## Required setup

- Chrome Web Store: [`CHROME_WEB_STORE_SETUP.md`](CHROME_WEB_STORE_SETUP.md)
- Firefox AMO: [`FIREFOX_AMO_SETUP.md`](FIREFOX_AMO_SETUP.md)
- Microsoft Edge Add-ons: [`EDGE_ADDONS_SETUP.md`](EDGE_ADDONS_SETUP.md)
- Security boundaries: [`RELEASE_SECURITY.md`](RELEASE_SECURITY.md)
