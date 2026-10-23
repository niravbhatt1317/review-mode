# Review mode

Design review comments on any page, shared on a team hub. Hold ⌥ (Alt on Windows), click anything, write a comment
with a tag; the extension takes a picture of the screen at that moment (the element boxed, the comment's number on
it) and sends both to the team's hub (Supabase). Pins on the page, a list drawer and a list page, a status flow
(Open, In progress, For approval, Approved) with reasons on the way back, names and pictures from GitHub sign-in,
"new" states, and copies as a Claude brief or a Microsoft Loop checklist.

Install: https://niravbhatt1317.github.io/review-mode/ (Chrome Web Store for Chromium browsers; a signed file for
Firefox that updates itself).

## What is here

| File | Role |
|---|---|
| `overlay.js` | the whole UI, in a shadow root; one file for both hosts (the extension, and a project's dev server that serves it) |
| `hub-core.js` | the rules (statuses, notes, names, people) and the hub client; shared with the dev-server collector |
| `background.js` | answers the overlay from the hub, takes pictures, injects the overlay on sites that are on, sign-in |
| `auth.js` | sign in with GitHub through the hub's auth |
| `bridge.js` | relays between a page and the background |
| `popup.*`, `options.*`, `list.*` | the toolbar popup, the sites page, the list page |
| `hub.json` | the team's hub: URL, publishable key (public by design; row rules hold access), the console's project, the `people` map |
| `pack.mjs` | bumps the version and writes `dist/review-mode-<v>.zip` (Chrome) and `-firefox.zip` |
| `firefox-release.mjs` | after Mozilla signs a build: the files for `docs/firefox/` (served by GitHub Pages) |
| `docs/` | the site: install page, privacy page, Firefox files and update list |
| `collector/` | the Vite plugin (`plugin.js`), the wrapper (`vite.js`), the config and the stores |
| `cli/review.mjs` | the `review` command: init, list, show, status, pull |
| `skill/SKILL.md` | the Claude skill a project gets from `npx review init` |
| `hub/` | the SQL that sets up a team's hub |
| `STORE.md` | how both stores are published |

## Release

1. `node pack.mjs` (or `minor`), commit, push, tag `v<version>`, push the tag: the workflow attaches both zips to a
   GitHub Release.
2. Chrome Web Store: dashboard → Package → upload the Chrome zip → Submit for review.
3. Firefox: Developer Hub → Upload New Version → the Firefox zip → when approved, download the signed `.xpi`, then
   `node firefox-release.mjs <that file>`, commit `docs/`, push. Firefox installs update within a day.

## Using it in a project (the dev-server host)

Any Vite project can serve the overlay itself and answer it with a local collector, so reviewers need no extension on
the dev server beyond the pictures, and Claude or a developer can read the comments and move statuses from the
command line:

```sh
npm install -D github:niravbhatt1317/review-mode
npx review init            # review.config.json, .review/vite.config.js, the dev:review script, .gitignore lines, the Claude skill
npm run dev:review         # the project on the review port (4178 by default), with the overlay
npx review list            # the project's comments; also show, status, pull
```

`review.config.json` holds the project's name on the hub and the port; add a `hub` block ({ url, anonKey, people })
for another team's hub. `.review/sessions/_*/` are local test sessions (`?session=_test`); everything else is on the
hub. The skill at `.claude/skills/review/SKILL.md` tells Claude the same commands. The hub itself is set up once per
team with `hub/schema.sql` and `hub/people.sql` in the Supabase SQL Editor.

## Testing headless

Google Chrome 137+ ignores `--load-extension`; use Chrome for Testing (`npx @puppeteer/browsers install chrome@stable`).
Firefox: puppeteer-core with `browser.installExtension`. Mozilla's own check: `npx addons-linter --self-hosted dist/review-mode-<v>-firefox.zip`.
