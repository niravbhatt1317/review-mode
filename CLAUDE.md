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

## A comment's life (Nirav, 2026-10-24)

```
New ──Pick up──▶ In progress ──Done──▶ For approval ──Approve──▶ Approved
 ▲                  │                      │                       │
 └────Put back──────┘                      │                       │
                    ▲──────Send back───────┘                       │
New ◀──────────────────────Reopen──────────────────────────────────┘
```

| Move | Who | Note |
|---|---|---|
| Add a comment | everyone | kinds: Fix or Question |
| Pick up (New to In progress) | everyone | the picker becomes the assignee; the first one wins, a second a moment later is refused |
| Put back (In progress to New) | the assignee (and the approver) | the doer gives it up, with a reason |
| Done (In progress to For approval) | the assignee (and the approver) | Claude asks the person first, then marks it |
| Approve (to Approved) | approver only | |
| Send back (For approval to In progress) | approver only | with a reason; it returns to whoever did the work |
| Take back (For approval to In progress) | whoever did it (the assignee) | until the approver acts; no reason asked; history says "took it back" |
| Reopen (Approved to New) | approver only | |
| Hand over (In progress, to someone) | the assignee (and the approver) | optional note; moves at once |
| Assign (New, to someone) | the approver | |
| Make it a fix / question | everyone | |
| Edit the words | its author, or the approver | |
| Remove | its author while still New, or the approver | once picked up, only the approver |
| Everything | the approver (Nirav) | sees and does all of it |

**A question's life** (Nirav, 2026-10-24): answered, not worked. Asked (`open`) ──Answer──▶ Answered (`approval`)
──Got it──▶ Resolved (`approved`); the asker's Follow up sends it back to Asked; Make it a fix starts it over as a
New fix with its talk kept. Anyone answers (`answer`), the asker follows up or closes it (`follow_up`, `resolve`), an
approver closes any. Replies are history steps of kind `reply` (`via: "claude"` for Claude's, from `npx review reply
<id> --claude`); the card's note is the latest reply. "Ask Claude" copies a brief for a Claude session. Old questions
someone picked up read as Asked.

**The waiting list** (Nirav, 2026-10-24): whoever signs in with GitHub and is not in `review_members` joins it as
`waiting` (a trigger on `review_people`); an approver sees "Waiting to join" at the top of the drawer and lets them in
(`member`) or refuses them (`refused`). A signed-in person who is not a member reads and writes nothing and sees a
waiting screen, which opens by itself once they are let in. The publishable key alone (dev server, `npx review`,
Claude) is not gated yet: that is the later "lock the hub to signed-in users" step.

**The rules live in the hub's `review_rules` table** (`hub/roles.sql`), not in code: one row per action and who may
do it (`anyone`, `member`, `author`, `assignee`, `approver`), in which states, and whether it is `signed` (needs a
GitHub sign-in; the hub refuses others) or drawer-only (the dev server, `npx review` and Claude act without a
sign-in). An approver may always do everything. Change a row in Supabase and every drawer follows within a minute; the
hub checks the same rows on every change (`review_allowed`, the `review_guard` trigger, the delete policy). The drawer
keeps the shipped rows as `RULES_DEFAULT` for when the table is missing. Who has it changes only by a hand-over or an
approver; a second pick-up landing late is refused (the first wins). Who approves comes from `review_members`.
Defaults: the team's list opens on New + In progress, the approver's on For approval + In progress, grouped by status
(`?as=team` / `?as=approver` previews the other).

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
