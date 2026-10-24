---
name: review
description: Work the design review comments left on this project's running UI with Review mode (the review-mode package): list them, read their pictures, act on them, and move their status (In progress, For approval) as you go. Use when a brief starts with "Design review", when asked to fix review comments, or when asked about the review tool.
---

# Review comments

Review mode is an overlay on the project's UI. A reviewer ⌥-clicks anything, writes a comment with a tag (Fix or Question; older comments may carry must, should or idea: treat must and should as Fix, idea as Question), and the tool keeps the comment with a picture of the screen at that moment (the element boxed, the comment's number on it) on the team's hub. The developer, or Claude, works through them and moves their status; the reviewer approves.

## Where things are

- The project's name on the hub and the port are in `review.config.json` at the project root. Comments live on the hub, shared by the whole team; nothing here is the only copy, except the local test sessions under `.review/sessions/_*/` (never delete or rewrite a session folder).
- Pictures named in a brief (`- Picture: .review/sessions/<project>/export/NN-<id>.png`) are files: read them with the Read tool to see what the comment is about. A brief made elsewhere gives a `curl` line per picture instead: run it, then read the file.
- With the dev server running in review mode (`npm run dev:review`, the port from `review.config.json`, default 4178), the collector answers on `http://localhost:<port>/__review/…`.

## Commands

From any folder of the project (no dev server needed):

```sh
npx review list                                   # every comment: n, id, status, tag, text, send-back note
npx review show <id>                              # one comment as JSON (route, element, trail, history…)
npx review status <id> progress                   # started on it
npx review status <id> approval                   # done, and the reviewer confirmed it in the chat
npx review pull <id> [<id>…]                      # the full pictures to .review/sessions/<project>/export/
npx review reply <id> --claude "<answer>"         # answer a question (marked as Claude's answer)
```

Statuses: `open` → `progress` (picked up) → `approval` (done, waiting for the reviewer) → `approved` (the reviewer only, from the panel). `open` again reopens; `progress` from `approval` is "sent back", and carries a note with the reason. **A comment with a note is rework: do what the note says first, then the rest.** Never change a comment's text without being asked.

**Questions are answered, not worked.** A question goes Asked (`open`) → Answered (`approval`) → Resolved (`approved`, the asker's "Got it"). Never set a question's status: answer it with `npx review reply <id> --claude "<answer>"` after reading the code it points at (one or two plain sentences, as to a designer). If the honest answer is that something should change, say so in the answer; the asker can make it a fix. Replies are in the comment's `history` (kind `reply`).

## How to work a brief

1. Read every comment and its picture before changing anything. Group the ones that share a cause (same component, same rule, same copy pattern) and say the groups first.
2. For each group: set its comments to `progress`, make the change, say which numbers it closes and what moved.
3. When the reviewer confirms a change in the chat, set those comments to `approval`. Do not set `approved`; that is theirs.
4. If a comment is ambiguous, ask with its number. Never remove functionality to satisfy a comment.

## The tool, in short

`review-mode` is an npm package (github:niravbhatt1317/review-mode) and a browser extension. The package brings the overlay, the collector (a Vite plugin, wired by `.review/vite.config.js`), this skill and the `review` command; the extension carries the same overlay to any site and takes the pictures on the dev server. The hub is Supabase; `hub.json` in the package (or `hub` in `review.config.json`) says which.
