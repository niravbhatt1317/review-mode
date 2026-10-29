# Claude fixes it on its own (discussion, 2026-10-29)

Nirav and Claude, to pick up later. The backlog item is in `BACKLOG.md`, under "Claude".

## Where it started

Nirav shared Tack's launch film (tack.so, a tool much like Review mode: comments pinned on a live site). What it shows:
press C to comment, an element label while picking, "All widths" or "Only 1280px" per comment, @mentions with the
team's faces, pins as initials bubbles in each person's colour, a phone and laptop preview where the pins follow the
layout, a thread per pin with nested replies and "Captured at 1440 × 900, Chrome, macOS", Resolve, and the fix
showing on the page.

Taken into the backlog: @mentions, pins as faces, a thread on every comment. Parked: comments for a screen width.
The resolved moment we already have (the approval lock and check, the pin leaving the page).

## The idea

Nirav: when a comment is assigned to Claude, or someone mentions @Claude on it, Claude starts fixing it by itself.
When the fix is done, Claude opens a pull request and puts the PR and a preview link on the comment, so Nirav sees the
change and approves it there. A big vision, to reach step by step.

## What exists today

- Send to Claude: comments go straight into a connected Claude Code session (the review MCP server and channel).
- Claude drafts first: a session with the review tools leaves "Claude suggests…" on new comments.
- Claude picks up with a person ("You and Claude are working on it") and moves work to For approval.
- Limits: it needs a Claude session open on a machine that has the code, and someone has to send the work.

## Where Claude runs: the deciding question

Claude has to run where the code is. The console is on Azure DevOps today (`Motadata/NextGen`).

- Azure DevOps could do it (a pipeline running Claude Code, Static Web Apps previews), but every part is ours to build.
- **GitHub, decided by Nirav (2026-10-29): use GitHub instead of Azure for this.** Anthropic's Claude Code GitHub
  Action runs Claude on GitHub's machines (from an @claude mention or a workflow started from outside), works on a
  branch and opens the PR. Vercel, Netlify or Cloudflare Pages build a preview of every PR. The GitHub API gives the
  PR's state. Only the hub side is ours.

Moving the console's code to GitHub (or mirroring it there) comes before step 2. Step 1 does not need it.

## The steps (each one usable on its own)

1. **Claude as a teammate** (S): Claude in Assign to / Hand over and as @Claude; the comment goes to a connected
   Claude session (today's Send to Claude), "Claude is working on it" on the card.
2. **Claude on GitHub** (M): giving a comment to Claude starts a GitHub workflow with the Claude Code action and the
   comment (words, picture, element, source file); Claude fixes it on its own branch and opens the PR.
3. **The PR on the card** (S): Claude writes back ("Opened PR #42"); the card shows the PR's state (open, checks
   passing, merged).
4. **A preview link** (S): every PR gets a preview build with Review mode on it; Nirav checks the fix on the pin.
5. **Approve merges** (M): approving the comment merges the PR; Send back gives Claude the reason and it pushes again
   on the same PR.

## Open questions (answer before building)

- Who may give work to Claude: only Nirav, or anyone? (One more row in the rules table.)
- Should Claude open the PR on its own, or ask on the card first ("Open a PR?")?
- How is the console deployed today, and which preview host (Vercel, Netlify, Cloudflare Pages)?
- The cost: an API key or a Claude subscription token as a repository secret; what daily cap?
- A big or unclear comment: Claude asks on the card instead of guessing (as "Claude drafts first" does).
- Moving the console to GitHub, or a mirror just for this?

## Claude's suggestion

Start with step 1, then step 2 as soon as the code is on GitHub. That reuses what we have and puts a PR link on a
comment within days; previews and approve-merges follow once the flow feels right.
