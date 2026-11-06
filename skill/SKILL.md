---
name: review
description: Work the design review comments left on this project's running UI with Review mode (the review-mode package): list them, read their pictures, pick them up as the person you work for, fix them, ask before marking them done, answer the questions, and end with a summary. Use when a brief starts with "Design review", when asked to fix or answer review comments, or when asked about the review tool.
---

# Review comments

Review mode is an overlay on the project's UI. A reviewer ⌥-clicks anything, writes a comment with a tag (Fix or Question; older comments may carry must, should or idea: treat must and should as Fix, idea as Question), and the tool keeps the comment with a picture of the screen at that moment (the element boxed, the comment's number on it) on the team's hub. The developer, or Claude, works through them and moves their status; the reviewer approves.

## Where things are

- The project's name on the hub and the port are in `review.config.json` at the project root. Comments live on the hub, shared by the whole team; nothing here is the only copy, except the local test sessions under `.review/sessions/_*/` (never delete or rewrite a session folder).
- Pictures named in a brief (`- Picture: .review/sessions/<project>/export/NN-<id>.png`) are files: read them with the Read tool to see what the comment is about. A brief made elsewhere gives a `curl` line per picture instead: run it, then read the file.
- With the dev server running in review mode (`npm run dev:review`, the port from `review.config.json`, default 4178), the collector answers on `http://localhost:<port>/__review/…`.

## Setting up (once per project)

If `npx --no review-mode` is not found, the project has no Review mode yet. Ask first (it changes the project), then:
`npm install --save-dev github:niravbhatt1317/review-mode` and `npx --no review-mode init <project>` (the project name the brief
gives; it adds review.config.json, .review/vite.config.js, a dev:review script, .gitignore lines and this skill).
`npx --no review-mode init` again later only refreshes this skill to the latest.

## The review tools (MCP)

`npx --no review-mode init` also adds a `review` MCP server to `.mcp.json`. When it is loaded, prefer its tools to the shell:
`review_list`, `review_show`, `review_pick_up`, `review_done` (only after the person said yes), `review_reply`,
`review_suggest`, `review_talk`, `review_picture`, each with `as` set to the person's handle; moves are marked as made with Claude. A brief sent from the
drawer ("Send to Claude") arrives as `<channel source="review" delivery_id="...">`: call `review_ack` with that id
first, then follow it. A request to draft (`kind="draft"`, "Claude drafts first") asks only for `review_suggest` on each
comment listed: look at its picture (`review_picture`) and read its code, leave one or two plain sentences (a fix:
what to change and where; a question: the answer; not sure what is meant: `unsure` and one question back; where the request shows "you asked … they
answered …", draft again with that answer), change
nothing else, then carry on with what you were doing. A call (`kind="call"`, "@Claude on review comment #N") is someone on the team writing @Claude in a comment or a reply,
answering your question, or handing the comment to you: read first (`review_show`, `review_picture` then Read it, the
code at its source, the team's design system), then answer with `review_talk` and ONE kind: `answer` (a short message
in the thread), `ask` (you cannot tell what they mean: one question with 2 to 4 quick picks in `options`; their reply
comes back as a new call) or `draft` (they asked for help writing a reply: their words, only they see it). The team are
designers: plain design words and the design system's token and component names, file names only when asked. A call
changes no code and no status. Someone wants a change: `review_talk` kind `plan` (what you will change and where, in
design words); it waits for a person's Go. A go call (`kind="go"`) names a work folder (a fresh copy of the GitHub repo,
outside the person's project): make exactly the plan there, nothing else, no installs, no git, then `review_ship` with a
short title and summary. The review server commits, pushes, opens the PR and moves the comment to For approval. Never merge. A plan
may come with a live preview (`preview: true`, the brief says when): the reply names a work folder, make the plan
there, then `review_preview`; the server opens a draft PR whose preview shows on the plan, and Go makes it the PR. A STOP
brief means someone pressed Stop: no more edits, never ship; say what you had done with `review_talk` kind "ask"
(Throw it away / Carry on / Push what's done). Their answer comes back as a call: `review_ship` (or `review_preview`) to
finish or push, `review_drop` to throw it away. A CHECK brief comes once a preview is built: Read the before (staging)
and after (preview) pictures it names, then `review_checked`: ok true when the after shows the plan, ok false with what
is wrong and options, nothing true when nothing on screen changes, missed true when the pictures don't show the changed
part and you can't say how to get there. A spot not found, or in another view (a customer or "All clients", a tab, a
drawer): first `review_resnap` with the clicks that reach it from a fresh load ("click Internal", "click All clients"),
read from the code; they are remembered for that comment. After the PR (step 4): on a comment with your open PR, a clear
instruction from the person the PR is for or an approver ("make it 16", a send-back reason that says how) is the go:
`review_talk` kind "change", then edit the PR's work folder and `review_ship` (it updates the same PR). "Undo":
`review_undo` (files for a part; on a merged PR it opens a PR that takes it back out). Anyone else: plan as usual. Show changes
through that preview, not a Claude artifact; make an artifact only when someone asks for one by name. Build it from the
design system's real components: a React page importing them from its package, then `npx --no review-mode mock
<page.jsx>` makes one self-contained HTML to publish. Say in the thread it is private until its owner presses Share on
claude.ai. A brief line "Do this (your suggestion,
accepted…)" is the plan the person agreed to: do that. Sending needs Claude started with `npx --no review-mode claude` once (it registers the tools, offers a shell helper so
plain `claude` turns push on in this folder from then on, and starts Claude;
channels are a research preview). Never run a bare `npx review`: on npm that name is an unrelated package.

## Commands

From any folder of the project (no dev server needed). Always add `--as <their GitHub handle>` (the brief gives it;
else ask) so the change is theirs, and `--claude` so the card shows "… and Claude":

```sh
npx --no review-mode list --open                            # every open comment: n, id, status, kind, [who has it], text, note
npx --no review-mode list --open --mine --as <handle>       # the ones that person has now
npx --no review-mode show <id>                              # one comment as JSON (route, element, source file:line, trail, history, conversation)
npx --no review-mode status <id> progress --as <h> --claude # picked up; "Already picked up by X" (exit 2): leave it, tell them
npx --no review-mode status <id> approval --as <h> --claude # done, ONLY after the person said yes in the chat
npx --no review-mode reply <id> --as <h> --claude "<answer>"  # answer a question
npx --no review-mode pull <id> [<id>…]                      # the full pictures to .review/sessions/<project>/export/
```

With the extension instead of the dev server, put `REVIEW_PROJECT=<project>` before `npx`; for a test session,
`REVIEW_SESSION=_test`. The brief's commands already carry these.

Statuses: `open` → `progress` (picked up) → `approval` (done, waiting for the reviewer) → `approved` (the reviewer only, from the panel). `open` again reopens; `progress` from `approval` is "sent back", and carries a note with the reason. **A comment with a note is rework: do what the note says first, then the rest.** Never change a comment's text without being asked.

**Questions are answered, not worked.** A question goes Asked (`open`) → Answered (`approval`) → Resolved (`approved`, the asker's "Got it"). Never set a question's status: answer it with `npx --no review-mode reply <id> --claude "<answer>"` after reading the code it points at (one or two plain sentences, as to a designer). If the honest answer is that something should change, say so in the answer; the asker can make it a fix. Replies are in the comment's `history` (kind `reply`).

## How to work a brief

1. Read every comment and its picture before changing anything. A comment's `source` (in `show`, the "Code:" line in
   a brief) is where its element is written: `file:line` and the component, plus the files it sits inside (`up`).
   Open that file at that line first; search by the element's text only when there is no source. Its `anchor` (test
   id, role, accessible name, heading) gives search words when the source is missing. A "Maybe fixed already" line
   means the element or its code changed after the comment: check the page and the code before changing anything,
   and tell the person if it looks done already. Group the ones that share a cause (same component,
   same rule, same copy pattern) and say the groups first. Leave comments someone else has (`[Name]` in the list,
   "Who has it" in the brief).
2. Sent-back notes first: a comment with one came back from approval, the note says what was still wrong.
3. For each group: pick its comments up (`status <id> progress --as <h> --claude`), make the change, say which numbers
   it closes and what moved.
4. Show the person and ask "Mark #… as done?". Only on their yes: `status <id> approval --as <h> --claude`. Never
   `approved`: that is the reviewer's.
5. Questions: answer with `reply`, never a status (the command refuses and says so).
6. Follow the project's own rules (its CLAUDE.md, its design system). Never remove functionality. Unclear: ask with
   the number.
7. End with a short table: number, what changed, where it stands (in progress, waiting for approval, answered, left
   for someone else).

## The tool, in short

`review-mode` is an npm package (github:niravbhatt1317/review-mode) and a browser extension. The package brings the overlay, the collector (a Vite plugin, wired by `.review/vite.config.js`), this skill and the `review` command; the extension carries the same overlay to any site and takes the pictures on the dev server. The hub is Supabase; `hub.json` in the package (or `hub` in `review.config.json`) says which.
