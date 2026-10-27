# Backlog

Nirav's list of 2026-10-23, to pick up one by one. Each item: what he asked, then a short note on what it touches.
Tick an item (`[x]`) with the date when it ships; add new ones at the end of their group.

Not released yet (in `overlay.js`, uncommitted on 2026-10-23): Pins / List discs, minimise and power discs on hover of
the bar, light and dark theme (hover switch in the drawer head, ripple), lighter sync pill, dark card border, picture
viewer sized from the picture, approved line, Fix / Question only, status filter with colours, the floating bottom bar
(search pill with / shortcut, Fix / Question capsule, fade, hides while scrolling), smaller picture marker. Goes out
with the next Firefox build; `hub-core.js` accepts `fix` (reload the extension too).

## Fixes

- [x] **Picture viewer too small.** (done 2026-10-23: the frame is sized from the picture, as large as the window allows; no text selection in the viewer) Opening a picture shows it small (it was right before), and a click can leave the
  caption and picture selected (blue highlight). Probably the lightbox sizing after the bar/theme changes; check
  `.lb-frame` / `.lb-img` and stop text selection on double click.
- [x] **Approved numbers at the bottom of the list look odd** (done 2026-10-23: a check, "11 approved", a View button) ("Approved 1 2 4 5 6 ..." as a row of pills). Make it
  simpler: for example "11 approved · See them" or a single count chip.


- [x] **Avatars turning into initials** (fixed 2026-10-23): the collector's people cache was emptied by test-session
  requests (and by any failed fetch) for a minute; now people always come from the hub and a miss keeps the last list;
  faces retry twice; and each signed-in browser stores its owner's 64 px photo in review_people (data URL), so faces
  no longer come from GitHub. Nirav's and Pranjal's rows switch over when their extensions next start.

- [x] **Loading skeletons** (done 2026-10-25: skeleton cards while the list loads, a shimmer in the picture slot) (Nirav, 2026-10-23): skeleton cards while the list loads, and a skeleton in a card's
  picture slot while its picture is still loading (or failed), instead of an empty box.

- [x] **The send-back / put-back note box looks off** (done 2026-10-24: the button sits inside the field at its right end, one 30 px control, for every box) (Nirav, 2026-10-24): the field is tall and the Put back button
  small beside it; make them one height and one family (field and button the same 28 px, or the button inside the
  field at its right end), and check the placeholder copy ("Why? Enter sends it, Esc keeps it here").

- [x] **Cute empty states** (done 2026-10-25: line illustrations and a friendly line for each empty view) (Nirav, 2026-10-24): a small illustration and a friendly line for every empty view, per
  role and per state: no comments yet, nothing new to pick up (team), nothing waiting for you (approver), nothing in
  progress, no match for the search, a type with none, all approved, signed out, the hub not answering.

## Comments and statuses

- [x] **Only two kinds when adding a comment: Fix and Question.** (done 2026-10-23: old Must/Should read as Fix, Idea as Question, nothing rewritten on the hub; Fix red, Question blue) Today: Must fix, Should fix, Idea, Question. Decide
  what happens to existing comments with the old tags (map Must/Should to Fix, Idea to Question?).
- [x] **Filter by state** (done 2026-10-23): the dot pill in the head is now All, New, In progress, For approval (grey,
  blue, amber), counts follow the scope; Approved stays on the full page ("View" at the bottom). The tag filter is gone.
- [x] **Search and the Fix / Question filter** (done 2026-10-23): a toolbar at the top of the list, not in the head; it
  slides away on scroll down and back on scroll up. Search matches words, #number, page, place, people, the note.
- [x] **Show who added a comment on its card** (done 2026-10-23): a line under the text, picture and name ("You" for yours) and how long ago; older comments without an author show the time only.
- [~] **Delete only your own comments; Nirav can delete anything.** (built 2026-10-24: drawer side done, hub/roles.sql
  waiting for Nirav to run it) Needs the signed-in identity checked on the hub
  (row rules in Supabase), not only a hidden button.
- [~] **Only Nirav (GitHub niravbhatt1317) approves.** (built 2026-10-24, same script) Everyone else never sees the Approve button; the hub refuses an
  approval from anyone else. Same mechanism as the delete rule.

- [x] **Edits, removal and pick-up rules** (2026-10-24): words edited by author or approver only; a picked-up comment removed
  by the approver only; the approver read from the hub's members table; the first pick-up wins.
- [x] **Hand over / reassign** (2026-10-24): Hand over to… (assignee, approver) and Assign to… (approver), a people picker,
  an optional note, "Pranjal handed it to Kishan".
- [x] **Rules as a table** (2026-10-24): `review_rules` in the hub decides every button and every hub check; edit a row in
  Supabase, no new extension.
- [x] **History on the card** (6, 2026-10-24): "History · N" in the hover strip opens every step, oldest first, as
  sentences with faces, times and the words ("You sent it back: “…”"); long ones fold to "Show 90 earlier". Steps now
  record where they came from (`from`).
- [x] **Take back after Done** (7, 2026-10-24): "Take back" in the doer's ⋯ menu while it waits for approval (rule
  `take_back`, assignee, unsigned); no reason asked; history "took it back"; the approver keeps Send back.
- [x] **The question flow** (2026-10-24): Asked → Answered → Resolved; anyone answers, the asker follows up or says
  Got it (Nirav closes any), a conversation in the history, Make it a fix keeps the talk, Ask Claude copies a brief and
  Claude answers with `npx review reply <id> --claude`. Answered questions have their own group; the pill says "For
  approval or answered" (2026-10-25).

- [x] **A goodbye for a removed card** (done 2026-10-25): dust, the Infinity War snap; the ash takes over the whole card
  while a hint of the card stays for a moment, then the list closes the gap (about 1 s). Tried: grain, shred, fade.
- [x] **A small moment for an approval** (done 2026-10-25): lock, HUD corner brackets and a scan line, then the Approve
  button closes into Stripe's green check (about 1.3 s). Tried and dropped: tick, stamp, burst, Tron, hyperspace, ink,
  Matrix, beam, glitch, mischief, fold, balloons, Linear, Things, Stripe, shine, HUD alone.

- [x] **A feel-good moment for Done** (done 2026-10-25, and for Pick up too: a small pill where the button was, a drawn
  face per line with its own animation and a bold extra, confetti, sparkles, hearts, a glint; teal for Done, orange
  for Pick up). Asked (Nirav, 2026-10-24): when someone who picked a comment up marks it Done (it goes
  for approval), a small happy moment for them: a smiling face, a word of praise ("Nice one, Pranjal"), something light
  that makes the work feel good. In the same family as the approval and removal effects.

## Data and sync

- [x] **Lean data** (done 2026-10-25): batches of 40 cards (this page first), pictures as they near the screen, a
  refresh that answers "no change" in a few bytes, the light list (no people's pictures per comment, short app values,
  approved on demand), the hub asked one tiny question first and only changed rows after (`hub/light.sql`). The
  console's real project: 1,109 KB every 10 s down to 27 KB once and a few bytes per check.
- [x] **Smart timing** (done 2026-10-25): checks every 2.5 s while someone is active with the drawer open, 10 s when
  stepped away, once a minute with it shut, none in a hidden tab; one hub check shared across tabs. Others' changes
  show in 0.8 to 2.8 s while active.
- [ ] **Realtime push for a big team** (Nirav, 2026-10-25): instead of every person asking, the hub tells everyone
  when something changes (Supabase Realtime, `postgres_changes` on `review_comments`). One SQL line to switch it on for
  the table, a live connection in the extension's background (and the dev server), the checks kept as a slow fallback.
  Changes would show in well under a second and the hub traffic would no longer grow with the number of people.

## Notifications

- [x] **More in-drawer notices, with avatars** (done 2026-10-27): the faces and a count in the drawer's header; a click
  drops the list down ("Since you were here"): picked up yours, handed you, finished for your approval (approvers),
  approved yours, sent back to you, answered your question. One line per person and kind; a line goes to its comment.
- [x] **Dynamic-island notices** (done 2026-10-27): what others did, live, in an island over the middle of the review
  bar: the face pops up, widens with the words, then shrinks while it moves over the list button and drops into it
  (like YouTube's "Saved to playlist"). Dark like the bar, with a ring and a soft glow in the kind's colour (blue
  handed or answered, orange picked up or sent back, teal finished or approved, purple new); more than three at once
  become one "5 updates". Held while writing a comment, in a hidden tab, or with review off.

  **Kept as backups, in case the team does not like it** (tried with Nirav the same day):
  - Exit "glide": shrinks in the middle, then the face glides over the list button and drops in. In the code:
    `ISLAND_EXIT = "glide"`.
  - Where it shows: out of the middle of the review pill (rising from behind it, and back into it the same way); or
    out of the list button, right-aligned with it (`L = a.right - W`) or centred on it.
  - Looks: plain white (`--is-bg: #fff; --is-ink: #1d2b3e`, shadow `0 8px 24px rgba(29,43,62,.22)`); filled with the
    kind's colour, white words (`--is-bg: var(--tone)`: #0262DF blue, #D45F00 orange, #1E8C81 teal, #8B3FD9 purple);
    white with the ring and glow (the chosen look on #fff). The coloured strip at the start was tried and dropped.
  - Glow: chosen 12px at 33% (`0 0 12px color-mix(in srgb, var(--tone-lit) 33%, transparent)`); tried 16px at 45%
    and 10px at 28%.
  - Size: chosen 30 px tall, 20 px faces; first tried 36 px and 22 px.
- [ ] **Nirav gets told when work waits for his approval** (outside the browser): email, Teams or a push. Pick the
  channel.
- [ ] **Microsoft Teams integration** for the notifications above (an incoming webhook into a channel is the simplest
  start; a bot for personal messages is more work).

## Access

- [x] **Waiting list for outside GitHub users.** (built 2026-10-24, in hub/roles.sql: outsiders who sign in wait, Nirav
  lets them in or refuses them from the drawer, a waiting screen for them; the publishable key is not gated yet, that
  is the "lock the hub" step) The six team members are approved by default; anyone else who signs
  in lands on "You are on the waiting list", and Nirav gets a notice to approve or refuse them. Hub: a members table
  with a status, row rules that only let approved members read and write.

## Claude

- [x] **A stronger Claude brief (the copy button).** (done 2026-10-26: works the hub on its own as you, marked as
  Claude's; leaves others' work; sent-back notes first; asks before Done; answers questions; ends with a table; the
  right `npx review` commands for any project) Pasted into a Claude session, it should work the hub on its own:
  mark the comments In progress as it starts, fix them one by one, then ask the person "mark as done?" and on yes set
  them to For approval on the hub.
- [x] **Review the skill and make it smarter with the hub.** (done 2026-10-26: the same flow; `--as`, `--claude`,
  `--force`, `list --open --mine`; refuses a question's status and a late pick-up) First write down what it can do today, then extend it
  (read and update the hub directly, pictures, notes, statuses, who is who).
- [x] **Claude on the card when it picks up** (done 2026-10-26: "Pranjal and Claude are working on it", both faces;
  "with Claude" in the history; the mark stays through For approval) (Nirav, 2026-10-24): when Claude picks up a comment on someone's behalf,
  the card shows both faces, the person and Claude's mark ("Pranjal and Claude are working on it"); needs the move to
  record that Claude made it (for example `via: "claude"` from `npx review` / the skill).
- [x] **Send to Claude without copy and paste** (done 2026-10-26: the review MCP server, tools in any session and a
  channel for push; "Send to Claude" in the drawer, a picker for several sessions, Claude confirms it has it, the copy
  as fallback; push needs Claude started with the channels flag while they are a research preview. Made automatic the
  same day: `npx --no review-mode claude` once per folder connects it and adds a shell helper, after which plain
  `claude` has the plane on; a first-time card in the drawer says so; 31 flow tests) (like the agentation plugin): link the current Claude session to the
  extension once, then a button sends the selected comments straight in; Claude adds them as its tasks, works through
  them, moves their statuses. Choose which session when several are open. Needs a small local bridge (the extension
  cannot talk to a Claude Code session directly); research the options first.
- [x] **Claude's own ideas for the extension** (written 2026-10-26: the list below, for Nirav to pick from).

## Ideas from Claude (2026-10-26, to pick from)

Effort: S a day or less, M a few days, L a week or more.

**Faster, surer fixes**
- [x] **Source on every comment** (M, done 2026-10-26): any framework. The dev server stamps each element with its
  file, line and component (JSX/TSX, Vue, Svelte); without the stamps, what the framework knows (React, Vue, Svelte,
  Angular, web components). Data for Claude only, never shown in the drawer: briefs and `show` carry it. Pins also keep
  anchors (test id, role, name, heading), so a row added above no longer moves them.
- [x] **"Maybe fixed?"** (S, done 2026-10-26): an open fix whose element changed (new words), is gone, or whose own
  tag in the code was edited after the comment (dev server, from the source stamp) gets a quiet "Maybe fixed?" pill;
  the tip says what changed. Only a hint, no status moves by itself; the brief tells Claude to check first.
- [x] **Claude drafts first** (M, done 2026-10-26): an open Claude Code session with the review tools reads each new
  comment's code and leaves "Claude suggests…" on its card; Accept picks a fix up with Claude and sends it to Claude to
  do, or posts a question's answer; Ignore hides it. No session open: drafted when one opens.

**Better comments**
- [x] **Same thing twice** (S, done 2026-10-27): while a comment is written, an open one on the same element, or one
  on this page with much the same words, is named under the box with Show; saving still works.

**Running a review**
- [ ] **A daily digest** (S, after notices): what waits for you, what came back, who is on what, in the drawer each
  morning.
- [x] **Numbers** (S, done 2026-10-27): a Numbers view on the full page (Open, Approved, Numbers): raised to approved,
  picked up within, sent back, open now; per page and per person (raised, finished, pick up to done, sent back, with
  Claude); all time, 30 or 7 days.

Claude's pick: source on every comment, before and after, and "maybe fixed?". Together they make Claude faster and
the approver surer, which is where most of the time goes.

## Designing with Claude (to discuss first)

- [ ] **Draft mode: design together with Claude on the page** (Nirav, 2026-10-26; like the agentation tool he shared):
  a designer opens their own draft in the project, pins tweaks on it ("tighter gap here", "this label in the
  secondary colour"), sends them to the connected Claude session, and Claude makes the changes while the page
  reloads in place. Not a review: no hub, no statuses, no approver, and these notes must never mix with the review
  comments. To decide together before building:
  - a switcher on the bar (Review / Draft), or a separate mode the designer turns on for a page;
  - where draft notes live (on this machine only, in `.review/drafts/`, gone when done), and whether one can be
    promoted to a real review comment;
  - how each tweak closes: Claude says what it changed, the designer keeps it or undoes it (a checkpoint per tweak);
  - sending one at a time as they are pinned, or a batch;
  - before and after for each tweak (shares the work with "Before and after").
- [ ] **Review / Design switch on the review bar** (Nirav, 2026-10-27): one switch on the bar moves between Review mode
  and Design mode (Draft mode above).
- [ ] **The same switch in the drawer** (Nirav, 2026-10-27): a toggle in the drawer's header, like the one in Zomato
  and similar apps, so the mode can change from the list too.
- [ ] **Each mode its own colours** (Nirav, 2026-10-27): the drawer, the review bar and the pins change colour when
  the mode changes, so it is always clear which one is on.

## The drawer

- [x] **Selection actions move to a bar** (done 2026-10-27): with comments selected, the "N selected ×" count moves
  next to the three actions (Copy prompt, Send to Claude, Copy for Loop), in one bar, perhaps at the bottom of the
  drawer.
- [x] **The title hides on scroll** (done 2026-10-27): scrolling the list hides the drawer's title row (nothing
  sits under it); scrolling back up shows it again.
- [ ] **The pin card like the drawer card** (Nirav, 2026-10-27): the card that opens on a pin shows much less than the
  same comment's card in the drawer; bring them together (the status line with faces, the history, the note,
  Claude's suggestion, Read more, the same actions), one card design in both places.
- [x] **A drawer you can resize** (done 2026-10-27): drag its edge to make it wider or narrower, between a minimum
  and a maximum width; double-click the edge to go back to the default width; the width is remembered.

## Parked

- **Before and after** (M): when Claude marks a comment done, the dev server takes the same picture again (same
  page, same element, same window size). The approver sees a before/after slider on the card and approves from it.
- **Design-token check** (S): on a colour, spacing or type comment, the card shows the element's computed value
  next to the nearest design-system token ("#6b7280, looks like neutral-60"), so the fix starts from the rulebook.
- **Accessibility on the spot** (S): contrast ratio, missing label or focus problems of the picked element,
  attached to the comment automatically.
- **Short recordings** (L): a 10-second screen clip on a comment, for animations and flows a still picture misses.
- **Review rounds** (M): name a round ("Sprint 14, IAM"), see its progress, and close it with a one-page summary
  (what was raised, fixed, answered, left), ready for Teams or Loop.
- **Turn fixes into rules** (M): when the same kind of fix repeats (three "use the token" fixes), Claude proposes a
  rulebook line or a lint check so it stops coming back.
  (Parked by Nirav, 2026-10-27: the small ones first.)

- Canvas pins (Figma and other canvas pages): see `HANDOFF.md`, "Parked ideas".

## Done along the way (2026-10-24)

- [x] **The card's hover strip waits a moment** ("pushpause", now the default): it opens once the pointer rests on a
  card for about half a second, words fade before it folds, gentle curves both ways. `?strip=push` opens at once,
  `?strip=float` floats it over the cards below (tried, not kept); the choice is remembered per browser.
