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
- **Data, lean (2026-10-25)**: the drawer asks `/__review/list?light=1&since=<fingerprint>`; an unchanged list answers
  `{ same: true }`. The light list has the open comments only (approved counted; `&approved=1` when that view opens),
  no people's pictures in each comment (one `faces` map) and only the short values of the `app` snapshot. Hub side,
  `hub.lightList()` asks one tiny question first (newest change + row count), then only changed rows, from the
  `review_comments_light` view (`hub/light.sql`) when it exists. Writes always `get()` the full row. The drawer builds
  40 cards at a time (this page's first) and loads pictures as they near the screen. Keep these when changing the list.
- **Pins and source (2026-10-26)**: a pin is tied to its element, never to screen positions. Saved: a path
  (`selectorFor`: stable id or tag + nth-of-type), the text (`textKey`), the size (`rect`), and `anchor` (the source
  stamp, test id, role, accessible name, heading). `resolve` tries the path, then the anchors (they survive a row
  added above), then the same words anywhere; nothing: a ghost pin at the saved place. `source` is where the element
  is written: on the dev server `collector/source.js` stamps `data-rv-src="file:line:col@Component"` on every
  lower-case element (JSX/TSX, Vue, Svelte; the project's own parser; serve only, review mode only); elsewhere the
  framework's dev data (React owner + `_debugSource`, Vue `__file`, Svelte `__svelte_meta`, Angular `ng`, custom
  element tags). It is data for Claude (briefs, `show`, the MCP tools), never shown in the drawer (Nirav: "treat it as
  data"). Never React-only: anything new here must work for any framework or none.
- **Maybe fixed? (2026-10-26)**: `checkMaybe` in the pin loop, open and in-progress fixes on this page only, 4 s
  after the page opens. Gone (no element, none at its stamp), changed (other words; figures ignored), or code (the
  fingerprint of the element's own tag, `codeNear` in `collector/source.js`, kept at save and asked again at
  `/__review/near` with the live stamp's line and column; a neighbour's edit or lines moving do not count). Layers
  (drawer, menu, tooltip) are never judged closed. Live data (two or more figures in its words, or a chart: svg,
  canvas, "chart" in its place) is never judged by words or by being gone, only by code: a redrawn chart ghosts
  without being fixed (the Supabase charts). A hint only: nothing moves status by itself.
- **Claude drafts first (2026-10-26)**: the review MCP server (a Claude Code session started with
  `npx --no review-mode claude`) checks every 30 s for open comments of the last three days with no `draft`, claims
  up to three (`draft.state = "drafting"`, lapses after 10 min), only when its Claude can hear the channel (started
  with the channels flag, seen in the process tree, or it already acked a send or left a suggestion), and hands them to its Claude over the channel; Claude
  answers with `review_suggest` (`draft.state = "new"`). The card shows "Claude is looking at it…", then "Claude
  suggests" (or "Claude isn't sure" with its question back, Ignore only; Claude looks at the picture and asks rather
  than guesses; the author, an approver or the person on it answers with Reply, `draft.state = "reply"` with
  `draft.thread` [{q, a}], and the next session drafts again with the talk, answered ones first) with Accept (a fix: picked up with Claude and sent to Claude to do; a question: posted as Claude's
  answer) and Ignore. Picked up the usual way, it stays only for the person on it: "Let Claude do it" (sends it,
  marks the card with Claude, no second pick-up) or Ignore. Gone once For approval. Data only for the hub's rules. Off: `"drafts": false` in
  review.config.json or `REVIEW_DRAFTS=0`.
- **Sent already? (2026-10-26)**: the drawer keeps what reached Claude (localStorage `review.sent.<project><session>`, a
  week, a stamp of text, status, assignee, note, edits, draft). Sending something unchanged asks first ("Already with
  Claude": Send again, or Send the new only). Each send watches for Claude's yes only while it is the latest.
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
approver closes any. Replies are history steps of kind `reply` (`via: "claude"` for Claude's, from `npx --no review-mode reply
<id> --claude`); the card's note is the latest reply. "Ask Claude" copies a brief for a Claude session. Old questions
someone picked up read as Asked.

**The waiting list** (Nirav, 2026-10-24): whoever signs in with GitHub and is not in `review_members` joins it as
`waiting` (a trigger on `review_people`); an approver sees "Waiting to join" at the top of the drawer and lets them in
(`member`) or refuses them (`refused`). A signed-in person who is not a member reads and writes nothing and sees a
waiting screen, which opens by itself once they are let in. The publishable key alone (dev server, `npx --no review-mode`,
Claude) is not gated yet: that is the later "lock the hub to signed-in users" step.

**Claude works the hub as a person** (2026-10-26): the brief and the skill run `npx --no review-mode … --as <handle> --claude`,
so a move is the person's (the drawer's face and checks) and marked `via: "claude"` (`withClaude` on the comment:
"Pranjal and Claude are working on it"). `status` refuses a late pick-up ("Already picked up by …", `--force` takes
it over) and a question's status (answer with `reply`).

**Never a bare `npx review`** (2026-10-26): on npm, "review" is an unrelated package, and npx fetches it in any
folder without our package. The package also installs a `review-mode` command; every instruction (brief, skill, panel,
README) uses `npx --no review-mode …`, which fails safely instead of fetching. `npx --no review-mode claude` is the one
start command: it finds the app (here, above, or below for a monorepo), registers the review MCP server once in the
person's own Claude settings (local scope, REVIEW_ROOT), and starts Claude with push on; `--setup` only registers.
The first run also offers (once, `--shell` / `--no-shell`) a small `claude` function in ~/.zshrc or ~/.bashrc, between
markers: in a folder connected to Review mode plain `claude` gets the channel flag, elsewhere it is untouched.

**Send to Claude** (2026-10-26): `npx --no review-mode mcp` (mcp/server.mjs, no dependencies, MCP over stdio) gives Claude Code the
review_* tools and, as a channel, takes briefs on 127.0.0.1:47831-47840 (`/hello`, `/send`, `/status`). It answers only
requests with `x-review: 1` and no web-page Origin (extension origins pass), Host 127.0.0.1/localhost. The dev server
and the extension find sessions (`/__review/claude/sessions`) and forward (`/__review/claude/send`); Claude calls
`review_ack` so the drawer can say it has it. Push needs `claude --dangerously-load-development-channels server:review`
(research preview); without it the drawer falls back to copying. `npx --no review-mode init` adds the server to `.mcp.json`.

**The rules live in the hub's `review_rules` table** (`hub/roles.sql`), not in code: one row per action and who may
do it (`anyone`, `member`, `author`, `assignee`, `approver`), in which states, and whether it is `signed` (needs a
GitHub sign-in; the hub refuses others) or drawer-only (the dev server, `npx --no review-mode` and Claude act without a
sign-in). An approver may always do everything. Change a row in Supabase and every drawer follows within a minute; the
hub checks the same rows on every change (`review_allowed`, the `review_guard` trigger, the delete policy). The drawer
keeps the shipped rows as `RULES_DEFAULT` for when the table is missing. Who has it changes only by a hand-over or an
approver; a second pick-up landing late is refused (the first wins). Who approves comes from `review_members`.
Defaults: the team's list opens on New + In progress, the approver's on For approval + In progress, grouped by status
(`?as=team` / `?as=approver` previews the other).

## Releasing

- `node pack.mjs` bumps the patch version and writes `dist/review-mode-<v>.zip` (Chrome) and `-firefox.zip`.
  `--no-bump` keeps the version (the tag workflow uses it).
- **Links** (the owner asks for them every release): Firefox, https://addons.mozilla.org/en-US/developers/addons
  (My Add-ons, then Review mode, then "Upload New Version"); Chrome, https://chrome.google.com/webstore/devconsole
  (the item, then Package, then "Upload new package").
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
