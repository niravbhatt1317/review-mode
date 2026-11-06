# The always-on Claude: the short page

A small server keeps the review Claude listening, so @Claude, Go and Stop work while every Mac is closed. It runs the
same thing you run on your Mac (`npx --no review-mode claude`), as its own `review` user, inside tmux, restarted by
itself if it ever stops, and updated every night.

| Piece | Where |
|---|---|
| Server | OVHcloud VPS-2 (4 vCore, 8 GB, 75 GB), Canada East, Ubuntu 24.04 |
| Claude | your Max plan, through a token made with `claude setup-token` |
| GitHub | a fine-grained token that can only change `niravbhatt1317/next-gen` |
| The console | `/home/review/next-gen`, following `staging` |
| Tokens | `/home/review/.config/review/env`, readable by the review user only |

All the commands below are typed on the server, after `ssh ubuntu@<server IP>` from your Mac.

## The first time (once)

1. **Log in**: `ssh ubuntu@<server IP>` (with the key made for it: `ssh -i ~/.ssh/ovh_review ubuntu@<server IP>`).
2. **Install everything** (about 5 minutes):
   `curl -fsSL https://raw.githubusercontent.com/niravbhatt1317/review-mode/main/server/setup.sh | sudo bash`
3. **Make the two tokens**:
   - Claude: on your **Mac**, run `claude setup-token`, sign in, and copy the token it prints (it lasts a year).
   - GitHub: github.com, Settings, Developer settings, Fine-grained tokens, Generate. Repository access: only
     `next-gen`. Permissions: **Contents** read and write, **Pull requests** read and write. Expiry: a year.
4. **Give them to the server**: `sudo review-server secrets`. It asks for each one and shows nothing while you paste.
   It checks the GitHub token can write to the repo before saving.
5. **Start**: `sudo review-server start` (clones the console and installs it, a few minutes the first time).
6. **Answer Claude's first questions**: `sudo review-server attach`. Claude may ask once about the preview feature
   ("I am using this for local development") and the folder. Answer, then leave with **Ctrl-b, then d**.
7. **Try it**: write @Claude on a comment. An answer within a minute means it works.

## Every day

Nothing. To look: `sudo review-server status`

```
Claude: running
Tokens: saved
Console: 4e1c2a9, 3 hours ago
Last update: Fri 2026-11-07 21:30 UTC
Work folders: 1
Disk: 9.1G used of 72G (13%)
Memory: 2.3Gi used of 7.6Gi
```

## When something is off

| You see | Do |
|---|---|
| @Claude gets no answer for minutes | `sudo review-server status`, then `sudo review-server logs` |
| Status says "waiting for a question" | `sudo review-server attach`, answer it, Ctrl-b d |
| Claude seems stuck | `sudo review-server restart`. A call it was on is picked up again by itself |
| "Usage limit" on its screen | Your Max plan's limit: it carries on when the limit resets. Your Mac shares the same limit |
| Logs say the token is invalid or expired | `sudo review-server secrets claude` (or `github`), then `sudo review-server restart` |
| You want it off for a while | `sudo review-server stop`, later `sudo review-server start` |

In `attach`, leave with **Ctrl-b, then d**. Ctrl-c or `/exit` only makes it restart 30 seconds later.

## Your Mac and the server together

While the server runs, it answers the hub's calls. Don't also start the review Claude for the console on your Mac
(`npx --no review-mode claude` in next-gen-ui), or both may pick up the same call. Your Mac's own test sessions
(`_test`) never reach the server. Claude in any other folder is unaffected.

## Updates

- **Every night at 03:00 India time** the server updates the console to the latest `staging`, review mode to the latest
  `main`, and Claude Code itself, then restarts Claude. If Claude is in the middle of a change, it waits a day.
- **Now**: `sudo review-server update`, for example right after pushing a review-mode change.
- Ubuntu's security updates install by themselves; the server restarts at 03:30 India time when one needs it.

## Disk and memory

`status` shows both. Below 70% disk there is nothing to do. Above that:
- `sudo -u review npm cache clean --force` (old package downloads)
- `sudo du -sh /home/review/.review-mode/*` shows the work folders and pictures. Work folders older than two hours
  are removed by Claude itself; pictures are kept on the hub, so `/home/review/.review-mode/pics` may be emptied.

Memory: Claude, its review tools and the picture Chrome use about 2 to 3 GB at their busiest. More bots later fit in
the rest; if memory stays above 6 GB, move to VPS-3.

## Cost

| | Per month |
|---|---|
| Server (VPS-2, no commitment) | ₹953 + 18% GST, about ₹1,125 |
| Claude | nothing extra: your Max plan, shared with your Mac |
| GitHub, Cloudflare previews, Supabase hub | nothing extra |

OVH bills monthly; cancel in the OVH control panel, nothing else to undo.

## Safety

- Claude runs as the `review` user, never root, in Claude Code's auto permission mode (the same as on your Mac).
- The GitHub token can change one repository and nothing else; Claude never merges, a person does.
- The tokens live in one file only the review user can read. Never paste them in a comment, a chat or a script.
- Only SSH comes in (the firewall), and only with your key.
- Before other designers use it: their calls would run on your Max plan. Add the `answerOnly` guard or API keys first.

## Moving to another server

On the new one: steps 2, 4 and 5 above (the same tokens work). Then cancel the old one. About 10 minutes.
