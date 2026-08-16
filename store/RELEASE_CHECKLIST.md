# AD-Twitcher 1.0.7 release checklist

## Package

- [x] Version set to 1.0.7
- [x] Stable Firefox ID set to `ad-twitcher@zcrxticxl`
- [x] English and German store copy prepared
- [x] Permission declarations prepared
- [x] Privacy policy prepared
- [x] Support contact prepared
- [x] Enable GitHub Pages from the `docs/` folder
- [x] Confirm the public privacy URL loads
- [x] Create privacy-safe store screenshots with representative sample data
- [ ] Refresh the screenshots: the status tab gained the activity and drop
      progress cards, and the footer now shows the version
- [ ] Upload Chrome ZIP to the Chrome Web Store
- [ ] Upload Firefox ZIP to Mozilla Add-ons
- [ ] Upload Opera GX ZIP to Opera Add-ons

A store never accepts a second upload under a version number it already has, so
every resubmission needs `package.json` bumped and `node build.mjs --zip` rerun.

## Store fields

- Developer name: `zCrxticxl`
- Category: `Entertainment` on Chrome, `Productivity` on Opera, which has no
  entertainment category
- Support URL: `https://x.com/zCrxticxl`
- Support page URL (Opera): `https://github.com/zCrxticxl/AD-Twitcher/issues`
- Privacy URL: `https://zcrxticxl.github.io/AD-Twitcher/privacy.html`
- Source URL for Opera moderators: `https://github.com/zCrxticxl/AD-Twitcher/tree/v1.0.7`
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
