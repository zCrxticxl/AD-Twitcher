# AD-Twitcher release checklist

## Package

- [ ] Version set with `npm run version:set -- X.Y.Z`
- [x] Stable Firefox ID set to `ad-twitcher@zcrxticxl`
- [x] English and German store copy prepared
- [x] Permission declarations prepared
- [x] Privacy policy prepared
- [x] Support contact prepared
- [x] Enable GitHub Pages from the `docs/` folder
- [x] Confirm the public privacy URL loads
- [ ] Confirm the existing real AD-Twitcher screenshots still match the shipped UI
- [ ] Run `npm run release:dry-run`
- [ ] Inspect all four ZIP files and `release/SHA256SUMS`
- [ ] Publish Chrome, Firefox and Edge through the protected tag workflow
- [ ] Upload the Opera GX ZIP manually to Opera Add-ons

A store never accepts a second upload under a version number it already has, so
every resubmission needs a new synchronized version and a fresh verified package.

## Store fields

- Developer name: `zCrxticxl`
- Category: `Entertainment` on Chrome, `Productivity` on Opera, which has no
  entertainment category
- Support URL: `https://x.com/zCrxticxl`
- Support page URL (Opera): `https://github.com/zCrxticxl/AD-Twitcher/issues`
- Privacy URL: `https://zcrxticxl.github.io/AD-Twitcher/privacy.html`
- Source URL for Opera moderators: `https://github.com/zCrxticxl/AD-Twitcher/tree/vX.Y.Z`
- Chrome single purpose and permissions: copy from `store/PERMISSIONS.md`
- Chrome remote code: `No`
- Opera GX single purpose and permissions: copy from `store/PERMISSIONS.md`
- Opera GX remote code: `No`
- Opera "Service website URL": leave empty. It is for the site the extension
  belongs to, and the field explicitly excludes GitHub profiles.
- Distribution: `Public`
- Firefox distribution: `On this site`

## Per-language listing text

- Chrome and Firefox take the name and summary from the package
  (`_locales/*/messages.json`), so those two cannot be edited in the dashboards.
- Opera needs a description and a changelog per language: `store/LISTING.opera.md`.
