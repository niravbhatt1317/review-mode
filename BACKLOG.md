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

- [ ] **Loading skeletons** (Nirav, 2026-10-23): skeleton cards while the list loads, and a skeleton in a card's
  picture slot while its picture is still loading (or failed), instead of an empty box.

- [x] **The send-back / put-back note box looks off** (done 2026-10-24: the button sits inside the field at its right end, one 30 px control, for every box) (Nirav, 2026-10-24): the field is tall and the Put back button
  small beside it; make them one height and one family (field and button the same 28 px, or the button inside the
  field at its right end), and check the placeholder copy ("Why? Enter sends it, Esc keeps it here").

- [ ] **Cute empty states** (Nirav, 2026-10-24): a small illustration and a friendly line for every empty view, per
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

## Notifications

- [ ] **More in-drawer notices, with avatars**: today "2 new" exists; add "Your comment was approved", "Nirav picked
  up 3", "Sent back to you", and so on.
- [ ] **Dynamic-island notices** (Nirav, 2026-10-24): an iPhone-style island that grows out of the review bar, and one
  at the top of the drawer, for live events ("Pranjal picked up #12", "3 new comments", "Your comment was approved"),
  with faces; it expands, shows the event, shrinks back. Ties in with the in-drawer notices above.
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

- [ ] **A stronger Claude brief (the copy button).** Pasted into a Claude session, it should work the hub on its own:
  mark the comments In progress as it starts, fix them one by one, then ask the person "mark as done?" and on yes set
  them to For approval on the hub.
- [ ] **Review the skill and make it smarter with the hub.** First write down what it can do today, then extend it
  (read and update the hub directly, pictures, notes, statuses, who is who).
- [ ] **Claude on the card when it picks up** (Nirav, 2026-10-24): when Claude picks up a comment on someone's behalf,
  the card shows both faces, the person and Claude's mark ("Pranjal and Claude are working on it"); needs the move to
  record that Claude made it (for example `via: "claude"` from `npx review` / the skill).
- [ ] **Send to Claude without copy and paste** (like the agentation plugin): link the current Claude session to the
  extension once, then a button sends the selected comments straight in; Claude adds them as its tasks, works through
  them, moves their statuses. Choose which session when several are open. Needs a small local bridge (the extension
  cannot talk to a Claude Code session directly); research the options first.
- [ ] **Claude's own ideas for the extension**: a written list of directions to make it better, for Nirav to pick from.

## Parked

- Canvas pins (Figma and other canvas pages): see `HANDOFF.md`, "Parked ideas".

## Done along the way (2026-10-24)

- [x] **The card's hover strip waits a moment** ("pushpause", now the default): it opens once the pointer rests on a
  card for about half a second, words fade before it folds, gentle curves both ways. `?strip=push` opens at once,
  `?strip=float` floats it over the cards below (tried, not kept); the choice is remembered per browser.
