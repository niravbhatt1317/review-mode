**On session start:** If `HANDOFF.md` exists in this directory, read it before anything else (local only, not in git).

# Review mode

Design review comments on a running UI. A browser extension (Chrome, Edge, Firefox, Zen) carries the overlay to any
site; an npm package (`github:niravbhatt1317/review-mode`) brings the same overlay, a Vite collector, the `review`
command and a Claude skill to a project. Comments, pictures and people live on a Supabase hub. `README.md` has the
file map; read it next.

## Writing rules

- Never the em dash (—), nor the en dash as a pause (–), in anything: UI copy, docs, commit messages, replies. Use a
  full stop, comma or colon. A plain hyphen between words is fine.
- Sentence case in UI copy.

## How things work, short

- **Overlay** (`overlay.js`): one file, shadow DOM host `#__review-host`. `window.__reviewExt` set means the extension
  hosts it; otherwise the dev server does. Page mode (the list as a page) is `/__review/…` or any `*-extension:` page.
  Everything must be generic: no fixes for one site, solve the pattern (shadow roots, modal dialogs, popovers, panes).
- **Background** (`background.js`): answers the overlay's `/__review/…` calls from the hub (`hub-core.js`), takes
  pictures, injects the overlay on switched-on sites, runs sign-in.
- **Sign-in** (`auth.js`): GitHub through Supabase Auth, PKCE in a normal tab. The hub sends `?code=` to `hub.json`
  `authPage` (`docs/auth.html` on the site, listed in the hub's Redirect URLs); the background watches the tab, trades
  code + verifier, closes the tab. Do not go back to `chrome.identity.launchWebAuthFlow`: Firefox 156+ never catches
  its redirect.
- **Hub**: `hub.json` (URL and publishable key, public by design). Schema in `hub/schema.sql`, `hub/people.sql`; the
  owner runs SQL in the Supabase SQL editor. Never use or ask for the service_role key.
- **Site**: GitHub Pages from `docs/` (install page, privacy, auth page, `firefox/` with signed xpi + `updates.json`).
  `site.mjs` holds the address.

## Releasing

- `node pack.mjs` bumps the patch version and writes `dist/review-mode-<v>.zip` (Chrome) and `-firefox.zip`.
  `--no-bump` keeps the version (the tag workflow uses it).
- **Firefox**: the owner uploads the Firefox zip on the Mozilla Developer Hub (add-on `review-mode@heynirav`,
  unlisted, no source code) and downloads the signed xpi to `~/Downloads`; then `node firefox-release.mjs <xpi>`,
  commit `manifest*.json`, `package.json`, `docs/firefox/`, push. Installed copies update themselves within a day.
- **Chrome**: the owner uploads the Chrome zip to the Chrome Web Store item (unlisted); Google reviews.
- Check Firefox builds with `npx addons-linter --self-hosted dist/review-mode-<v>-firefox.zip` (0 errors expected;
  the innerHTML warnings are known and accepted).

## Local development on the console

The console's `Functional/next-gen-ui/node_modules/review-mode` is a symlink to this clone (set 2026-10-23; an
`npm install` there puts the GitHub copy back, so redo it with `ln -s ~/Claude-Projects/review-mode
node_modules/review-mode` after moving the installed folder aside). The collector reads `overlay.js` on every request,
so overlay edits show on http://localhost:4178/ with a page refresh. `collector/` or `hub-core.js` changes need the dev
server restarted (`npm run dev:review`). `background.js`, `popup.*`, `auth.js` changes still need the extension reloaded.

## Testing

- Google Chrome 137+ ignores `--load-extension`: use Chrome for Testing (`npx @puppeteer/browsers install
  chrome@stable`). Firefox: puppeteer-core with `browser.installExtension` (BiDi cannot open moz-extension pages;
  have the test copy's background open and report on them).
- Hub writes in tests go to project `_trial` and are cleaned up; never write test data to a real project.
- Projects that use the package keep local sessions in `.review/sessions/`: never delete or rewrite them; tests use
  `_test` and assert `window.__reviewSession === "_test"` before writing.

## Never

- Never handle the owner's passwords, 2FA codes, OAuth client secrets or tokens; never create accounts for him. Store
  forms that ask for test credentials stay empty.
- Commit only when asked, by named paths (never `dist/`, `node_modules/`), and push to `main`.
