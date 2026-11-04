# Claude, a buddy for everyone (discussion, 2026-11-04)

Nirav and Claude. This grows "Claude fixes it on its own" (`2026-10-29-claude-fixes-it.md`) into something bigger:
Claude as a teammate anyone can talk to on a comment, who understands first, asks when unsure, answers, helps write
replies, and does the work with a PR and a live preview. The backlog item is in `BACKLOG.md`, under "Claude".
Everything Nirav said and decided is kept here so nothing gets lost.

## What Nirav asked for (his words, 2026-11-04)

- When someone mentions @Claude, Claude first understands the comment and its thread, then answers (Q&A) or does the
  work, and asks and confirms when in doubt.
- When someone mentions Claude in a comment or a reply, Claude knows from there what it has to do.
- Claude is a buddy to everyone: helps with replies, does work, and many other things.
- The code is on GitHub now (github.com/niravbhatt1317/next-gen), so Claude can understand the code any time, change
  it and open PRs.
- Later: run the whole flow through a bot in Slack or Telegram, and get everything there.
- "First discuss how we can enhance this entire capability, and if I have missed something, add better things."
- On the full list below: "1 to 4 all are the best, we will cater all of it."

## Facts checked (2026-11-04)

- **The code:** github.com/niravbhatt1317/next-gen, a mirror of Azure `platform-documentation`. The default
  branch is `staging`; `main` lives only in Azure, and staging to main is done in Azure. "Pull from Azure" runs
  every 30 minutes. Branches that exist only on GitHub (designers' work) are never touched by it.
- **Previews already exist:** `.github/workflows/preview.yml` builds next-gen-ui and the mocks for every PR to
  Cloudflare Pages at `https://pr-N.<project>.pages.dev`. It comments the link on the PR (marker
  `<!-- preview-link -->`) and deletes it when the PR closes. Staging is at `https://<project>.pages.dev`. So
  Claude's PRs get a live preview with no new setup. Claude reads that PR comment and puts the link on the review
  comment.
- **Design system:** github.com/niravbhatt1317/nextgen-design-system (React, 46 components, 1209 Lucide icons, 113
  tokens; has `TOKENS.md`, `component-catalog.json`, `DECISIONS.md`, `CLAUDE.md`, `AGENTS.md`). **Not ObserveOps.**
  Claude checks every fix against this one.
- **The team:** only designers. Designers also do the developer work, so Claude talks like a designer would, never
  in developer terms.

## How Claude acts when someone writes @Claude

1. **Read first.** Before replying: the whole comment and thread, the page and the element it is pinned to, a
   picture of it, its live styles, its source in `next-gen`, the design system, past decisions, and who is asking.
2. **Work out what is asked, from where it was mentioned.** A mention on a comment, in a reply, or on a quote of
   Claude's own message each tells it something. Then one of:
   - **A question** ("why is this 12px?"): Claude answers in the thread, pointing to the token or component.
   - **Help with a reply** ("@Claude how do I explain this to Kishan?"): Claude drafts the reply for the person to
     send or edit.
   - **A change** ("@Claude fix the gap"): Claude posts a short plan in plain words ("I'll change the card gap from 8
     to 12, the `space-3` token") and **waits for "go". Every change, however small (Nirav: no skipping the confirm).**
   - **Unclear:** Claude asks one question and waits, as it does today.
3. **Do the work.** A branch and a PR on `next-gen`, then the PR link and the preview link on the comment. The comment
   moves to For approval like any other fix.
4. **A buddy for everyone.** Any designer can @Claude. Claude is also in the Assign and Hand over list like a teammate.

## Context all the time (honest note)

Claude does not remember between runs. It rebuilds the picture every time from the repo, the thread, the design
system and a shared notes file where it keeps decisions ("pills are 16px", "always the token, never the hex"). In
practice that works like memory and never goes stale. Corrections go into that file (see "Correcting Claude").

## The full capability (all wanted, Nirav 2026-11-04)

### 1. Understanding better
- **It sees what you see:** the pinned element's picture, its live styles and its source, not only the words.
- **It knows the design system:** the nextgen design system's tokens and components, so it picks `space-3`, not
  `12px`, and uses an existing component instead of new code.
- **It knows the history:** past decisions and similar comments that were already fixed.
- **It speaks like a designer:** everyone on the team is a designer, so plain design words: "the gap between the
  title and the icon", "the secondary button", "the spacing token". File names only when someone asks.

### 2. Making comments clearer
- **Sharpen a vague comment:** "this looks off" becomes "The card title sits 2px lower than the icon. Align them to
  the centre?", and the writer confirms.
- **Split a comment with several asks** (Nirav's worry, 2026-11-04: splitting could end up cutting small tasks into
  even smaller ones). The rule, Claude's proposal: split only when the asks are **independent**, meaning they could
  each be done and approved alone (different elements, or one could be done while another is argued about). Never
  split one change into its steps, and never a comment with fewer than 2 such asks. Claude only offers it and the writer
  decides; "keep together" is always one click. Example of a split: one comment like "make the title bold, change the icon to red, and the gap
  feels big" is three separate changes. Today they share one status, so if two are done and one is not, the
  comment can't be approved and nobody sees what's left. Claude offers "This has 3 asks. Split into 3 comments?".
  Each one then gets its own status, person, fix and approval, and they stay linked to the original.
- **"@Claude sum up":** a long thread becomes what was decided and what is left.
- **Spot clashes:** "Kishan asked for 12px here, Pranjal asked for 8px on #14. Which one?"

### 3. Doing the work well
- **It checks itself before posting:** builds, takes a picture of the result, and puts before and after in the thread
  (covers the parked "Before and after").
- **The live preview:** the PR's Cloudflare preview link on the comment, so people can open the real change and go
  through the whole flow, not only look at pictures (Nirav: pictures alone often are not enough).
- **One PR for many comments:** "@Claude fix all the spacing comments on this page."
- **It keeps going after the PR:** "make it 16 instead" in the thread updates the same PR.
- **"@Claude undo":** reverts its change.
- **It finds the same problem elsewhere:** "This gap is also wrong on 4 other pages. Fix those too?"

### 4. A proactive buddy
- **A morning digest it writes itself:** what waits for you and what it finished (joins "A daily digest").
- **Gentle nudges:** "#7 has waited 3 days for Kishan."
- **It learns from fixes:** after the third "use the token, not the hex", it suggests a rule (covers the parked "Turn
  fixes into rules").

## Rules and safety (decided)

- **Who can say "go": every designer.** The designers build this product, so any of them can have Claude change code
  (Nirav, 2026-11-04).
- **Claude never merges.** It opens the PR; a person merges. Nirav, as design lead, does the final merge.
- **No skipping the confirm step.** Every change waits for "go", even a one-line fix. How often it asks (Nirav asked
  2026-11-04 whether asking every time makes sense; Claude's proposal):
  - **Once per plan.** One "go" covers the whole change, all its steps and files.
  - **A clear instruction is the go.** "Make it 12", "undo the Agents part": the person said exactly what, so Claude
    does it on the same PR and shows the result. A plan only when the how is open (a Send back reason like "should be
    a link style" gets a plan and a go).
  - **Asks again only for something new:** more pages or files than planned, a different approach, two people
    disagreeing (asks the approver), or after Stop (throw away, carry on, push what's done).
  - **Its quick picks are only shortcuts** (Nirav asked 2026-11-04). Under every question of Claude's the reply box
    is already set to answer it ("Answering Claude"), so anyone can answer in their own words ("add it, but in its
    own PR", "10px, and the same on Alerts") or ask something else. Claude reads that like any answer, and if it
    changes the plan, Claude shows the new plan for a go.
  - **Never asks for talk:** answers, drafts, sum ups and suggestions change no code, so no go.
- **A stop button:** stops Claude mid-change; the thread says what it had done so far.
- **Cost and speed:** a daily limit, and a visible "Claude is working (about 1 min)" state on the card.
- **Clearly marked:** Claude's messages, branches and PRs always show they are Claude's.
- **Two people tell Claude different things:** it does not pick a side, it asks the approver.
- **Correcting Claude:** "@Claude no, we always do X" goes into its notes file so it does not happen again.

## Merging when Nirav is away (decided, Nirav 2026-11-04)

Both together:
- **PRs wait for Nirav, with a reminder on his phone** (through the chat app below), so he can check the preview and
  merge from anywhere.
- **A named stand-in designer** can merge while Nirav is marked "away" (an "Away until" in the drawer).
Still to settle: who the stand-in is, and whether GitHub should also need one approval on `staging` (Claude's
suggestion: yes).

## Where Claude runs

- **Nirav's Mac Claude session:** already connected to the hub; free and the fastest to get the behaviour right; only
  works while the Mac and session are on.
- **GitHub Actions:** an @Claude starts a job (Anthropic's Claude Code action) that reads `next-gen`, replies and
  opens the PR. Always on, for everyone; a minute or two to start each time. Needs an Anthropic API key (or a Claude
  subscription token) as a repo secret, added by Nirav.
- **Later, a small always-on server:** the same Claude, and where Slack or Telegram plugs in.
Claude's suggestion: build the behaviour on the Mac session first, then move it to GitHub Actions.

## The chat app: Slack (Nirav, 2026-11-04)

The team is on Microsoft Teams today, but Teams has many limits, so start with **Slack**. The hub stays the single
source of truth; Slack is another door to it. Nirav's biggest worry: how it is laid out (one channel for issues, one
chat with everything, or one per PR).

Claude's proposal, to settle with Nirav:
- **One channel per module, not per project** (Nirav, 2026-11-04). For example `#review-fleet`,
  `#review-access` (users, teams, roles, grants, service accounts), `#review-discovery` (discovery and credential
  profiles), `#review-onboarding`, `#review-orgs`. Designers join the modules they work on, so each channel stays
  small. Each review comment is **one message** in its module's channel, and that message's Slack thread **is** the
  comment's thread: replies, moves and Claude's messages, both ways. A reply in Slack lands in the hub, and the
  other way round.
- **How a comment finds its module:** from the page it was made on. A small map of page addresses to modules
  (`/agent-fleet` to Fleet) lives in the project's review settings. A comment on a page with no module goes to a
  catch-all `#review-general`, and moving a comment's module moves its message.
- **Nobody misses things outside their channels:** direct messages and the digest go to the person, whatever the
  module.
- **The message edits itself, it does not repeat.** When the status moves, the PR opens or the preview is ready, the
  same top message updates (status, person, PR, preview link). The channel stays one line per comment.
- **No channel per PR.** A PR belongs to a comment, so its link and preview live on that comment's message.
- **Direct messages only for what needs you:** you were mentioned, it was assigned or handed to you, sent back to
  you, waiting for your approval, a PR waiting for your merge (the phone reminder), Claude asking you something.
- **A morning digest by direct message** (the daily digest).
- **@Claude works in Slack too:** in a comment's thread it acts as in the hub; in a direct message it answers about
  the whole project ("what is waiting for me?").
- Buttons on the messages for the common moves (Go, Approve, Send back, Open preview).
- Each person chooses what reaches them (with "Told outside the browser").

## Pictures

- `2026-11-04-claude-buddy/1-claude-as-a-teammate.png`: step 1 (a question, asking when unsure, help me reply,
  assign to Claude).
- `2026-11-04-claude-buddy/2-claude-makes-a-change.png`: plan and go, working with Stop, before and after with the
  preview and PR, follow-ups, Send back, waiting for the merge, merged, when Claude asks again, and the use cases.

## Steps (to be re-cut once the open points are settled)

1. **Claude as a teammate** (S): in Assign and Hand over, and as @Claude; reads first, answers, asks, drafts replies.
2. **Plan, go, PR** (M): the change flow with confirm, on `next-gen`, the PR and preview link on the comment.
3. **Self-check** (S): build, picture, before and after in the thread.
4. **After the PR** (M): follow-ups update the same PR, undo, stop button.
5. **Clearer comments** (M): sharpen, split, sum up, clashes.
6. **Many and elsewhere** (M): one PR for many comments, the same problem on other pages.
7. **Proactive** (M): digest, nudges, rules from fixes.
8. **Always on** (M): move from the Mac session to GitHub Actions.
9. **Slack** (L): the channel and direct messages above, as a door to the hub.
