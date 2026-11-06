// The Review mode MCP server (2026-10-26): `npx review mcp`, started by Claude Code from the project's .mcp.json.
//
// 1. Tools, in any Claude Code session: list the open comments, read one, pick it up, mark it done, answer a question,
//    save a picture. The same moves as `npx review`, acting as the person (`as`, their GitHub handle) and marked as made
//    with Claude, so the drawer shows "Pranjal and Claude are working on it".
// 2. Push (Claude Code channels, research preview): started with
//    `claude --dangerously-load-development-channels server:review`, the drawer's "Send to Claude" drops the selected
//    comments straight into this session. A small local endpoint on 127.0.0.1:47831-47840 takes them; it answers only
//    the dev server and the extension (no web page can reach it: a custom header and no page origin are required).
//
// No dependencies: MCP over stdio is one JSON message per line.
import http from "node:http";
import fs from "node:fs";
import path from "node:path";
import { execSync, execFileSync } from "node:child_process";
import os from "node:os";
import { loadConfig } from "../collector/config.js";
import { snap } from "./snap.mjs";
import { storeFor, prepare } from "../collector/stores.js";
import { withNames, applyChange, mergePeople, draftOpen, callOpen } from "../hub-core.js";

/* REVIEW_ROOT: the app's folder when Claude starts higher up (a monorepo root); else where Claude started */
const ROOT = process.env.REVIEW_ROOT ? path.resolve(process.env.REVIEW_ROOT) : process.cwd();
const cfg = loadConfig(ROOT);
const store = storeFor(cfg, new Map(), process.env.REVIEW_SESSION);
/* THE TEST SESSIONS (Nirav, 2026-11-04: "I want to test how Claude works"): @Claude in a local test session
   (.review/sessions/_test, the drawer's ?session=_test) is answered too, so a person can try every case without
   writing on the team's comments. Those calls name their session; the tools take it as "session". */
const TEST_SESSION = /^_[a-z0-9-]+$/;
const testStores = new Map();
const storeOf = (sess) => {
  if (!sess || sess === process.env.REVIEW_SESSION) return store;
  if (!TEST_SESSION.test(sess)) throw new Error(`Unknown session ${sess}`);
  if (!testStores.has(sess)) testStores.set(sess, storeFor(cfg, new Map(), sess));
  return testStores.get(sess);
};
const localTests = () => {
  if (process.env.REVIEW_TEST_CALLS === "0") return [];
  try {
    return fs.readdirSync(cfg.sessionsDir).filter((n) => TEST_SESSION.test(n) && n !== process.env.REVIEW_SESSION && fs.existsSync(path.join(cfg.sessionsDir, n, "comments.json")));
  } catch {
    return [];
  }
};
const PORTS = [47831, 47840];
const startedAt = Date.now();
const deliveries = new Map(); // id -> { at, acked }
let peopleCache = null;
const people = async () => (peopleCache ||= mergePeople(cfg.people, store.kind === "hub" ? await store.people().catch(() => ({})) : {}));
const defaultAs = (() => {
  if (process.env.REVIEW_AS) return process.env.REVIEW_AS;
  for (const c of ["git config github.user", "git config user.name"])
    try {
      const v = execSync(c, { stdio: ["ignore", "pipe", "ignore"] }).toString().trim();
      if (v) return v;
    } catch {}
  return "claude";
})();
const kind = (k) => (k === "question" || k === "idea" ? "question" : "fix");
const holder = (c) => (c.status === "progress" ? c.assignee : c.status === "approval" ? c.doneBy : null);

/* ---------- the tools ---------- */
const asProp = { as: { type: "string", description: "The GitHub handle of the person you work for (the brief gives it). Leave out to use the default." } };
const TOOLS = [
  { name: "review_list", description: "List the review comments: number, id, status, kind (fix or question), who has it, text and any sent-back note. Open ones by default.", inputSchema: { type: "object", properties: { open: { type: "boolean", description: "Only open ones (default true)" }, mine: { type: "boolean", description: "Only the ones this person has now" }, ...asProp } } },
  { name: "review_show", description: "One comment in full: page, element, how to get there, the history and, for a question, the conversation.", inputSchema: { type: "object", properties: { id: { type: "string" }, session: { type: "string", description: "The test session a call came from (the brief names it, e.g. _test); leave out for the team comments" } }, required: ["id"] } },
  { name: "review_pick_up", description: "Start on a comment (In progress, as the person, made with Claude). Refused when someone else already has it: leave it and tell the person. Not for questions (answer them).", inputSchema: { type: "object", properties: { id: { type: "string" }, ...asProp }, required: ["id"] } },
  { name: "review_done", description: "Set a comment for approval. ONLY after the person said yes in the chat to marking it done. Never approves.", inputSchema: { type: "object", properties: { id: { type: "string" }, ...asProp }, required: ["id"] } },
  { name: "review_reply", description: "Answer a question (one or two plain sentences, from the code it points at). If something should change, say so; the asker can make it a fix.", inputSchema: { type: "object", properties: { id: { type: "string" }, text: { type: "string" }, ...asProp }, required: ["id", "text"] } },
  { name: "review_picture", description: "Save a comment's picture (the element boxed, its number on it) and return the file path to Read.", inputSchema: { type: "object", properties: { id: { type: "string" }, session: { type: "string", description: "The test session a call came from (the brief names it, e.g. _test); leave out for the team comments" } }, required: ["id"] } },
  { name: "review_suggest", description: "Claude drafts first: leave a short suggestion on a new comment, for a person to accept or ignore. For a fix, what you would change and where (file and line), in one or two plain sentences; for a question, the answer. When you cannot tell what is meant, or the code shows no clear change, set unsure and say in one sentence what you would need to know, instead of guessing. Draft only: change no code and no status.", inputSchema: { type: "object", properties: { id: { type: "string" }, text: { type: "string" }, unsure: { type: "boolean", description: "True when the text is a question back to the person, not a suggestion" }, ...asProp }, required: ["id", "text"] } },
  { name: "review_talk", description: "Answer a call: someone mentioned @Claude on a comment (or handed it to Claude). Read first (review_show, review_picture, the code, the design system), then ONE of: kind \"answer\" (a message in the thread, as a designer would say it), kind \"ask\" (one question back when you cannot tell what is meant, with 2 to 4 short quick picks in options; their reply comes back to you as a new call), kind \"draft\" (when they asked for help writing a reply: words only they see, to send as their own), or kind \"plan\" (they want something changed: what you will change and where, in design words; it waits for a person's Go, then comes back to you as a go call). Never changes code or status.", inputSchema: { type: "object", properties: { id: { type: "string" }, kind: { type: "string", enum: ["answer", "ask", "draft", "plan", "change"], description: "change: only on a comment with an open PR, when they told you exactly what to change (\"make it 16\"): that is the go; the text is one short line of what you'll do, and the reply names the PR's work folder" }, preview: { type: "boolean", description: "For plan: true to build a live preview before Go (the brief says when); the reply names a work folder to make the change in, then review_preview" }, text: { type: "string" }, options: { type: "array", items: { type: "string" }, description: "For ask: 2 to 4 quick picks, a few words each" }, session: { type: "string", description: "The test session a call came from (the brief names it, e.g. _test); leave out for the team comments" }, ...asProp }, required: ["id", "kind", "text"] } },
  { name: "review_ship", description: "After a go call: you made the planned change in the work folder the brief named. The review server commits it, pushes the branch, opens the pull request, puts it on the comment and moves the comment to For approval. Never merges.", inputSchema: { type: "object", properties: { id: { type: "string" }, title: { type: "string", description: "The PR title: short, what changed (\"Agent Fleet: 8px between the score and its arrow\")" }, summary: { type: "string", description: "One or two sentences in design words: what changed and where" }, session: { type: "string" } }, required: ["id", "title", "summary"] } },
  { name: "review_preview", description: "After a plan with preview (or a preview call): you made the planned change in the work folder named. The review server commits it, pushes the branch and opens (or updates) a DRAFT pull request, whose live preview link shows on the plan. The plan still waits for a person's Go.", inputSchema: { type: "object", properties: { id: { type: "string" }, title: { type: "string", description: "The PR title: short, what changes" }, session: { type: "string" } }, required: ["id", "title"] } },
  { name: "review_drop", description: "After a Stop, when they chose to throw your work away: the work folder goes, nothing is pushed, and your plan waits for Go again. Says so in the thread.", inputSchema: { type: "object", properties: { id: { type: "string" }, session: { type: "string" } }, required: ["id"] } },
  { name: "review_checked", description: "After a CHECK brief: you looked at the before and after pictures against your plan. ok true: they match (the pair is marked checked). ok false: say in text what you see that is wrong, one question with options; it goes in the thread as your question. nothing true: nothing on screen changes with this plan (a link, a screen reader label), so the pictures are hidden. missed true: the pictures don't show the part you changed (another tab, scrolled away, a closed drawer), so they are hidden and the thread says to try it live.", inputSchema: { type: "object", properties: { id: { type: "string" }, ok: { type: "boolean" }, nothing: { type: "boolean" }, missed: { type: "boolean" }, text: { type: "string" }, options: { type: "array", items: { type: "string" } }, session: { type: "string" } }, required: ["id", "ok"] } },
  { name: "review_resnap", description: "After a CHECK brief whose pictures missed the spot: take them again, with the clicks that reach the comment's view from a fresh page load (by their visible words: \"click Internal\", \"click All clients\", \"hover Try again\", \"press Escape\") and, if the spot's own words differ there, target (its visible words). Remembered for this comment's later pictures. Answers with the new pictures' paths: Read them, then review_checked.", inputSchema: { type: "object", properties: { id: { type: "string" }, steps: { type: "array", items: { type: "string" } }, target: { type: "string" }, session: { type: "string" } }, required: ["id", "steps"] } },
  { name: "review_undo", description: "When the person the PR is for or an approver says undo (a clear instruction is the go). On an open PR: no files closes the PR (nothing reaches staging, the comment goes back to In progress); files puts those back as they are on staging, on the same PR (\"undo the Agents part\"). On a merged PR: opens a PR that takes the whole change back out. text: one short line for the thread, in design words.", inputSchema: { type: "object", properties: { id: { type: "string" }, files: { type: "array", items: { type: "string" }, description: "Paths in the app (src/...) to put back as on staging; leave out to undo all of it" }, text: { type: "string" }, session: { type: "string" } }, required: ["id", "text"] } },
  { name: "review_ack", description: "Call first when a <channel source=\"review\"> brief arrives, with its delivery_id, so the drawer shows that you have it.", inputSchema: { type: "object", properties: { delivery_id: { type: "string" } }, required: ["delivery_id"] } },
];
const line = (c) => `#${c.n} ${c.id} ${c.status} ${kind(c.severity)}${holder(c) ? ` [${holder(c)}${c.withClaude ? " + Claude" : ""}]` : ""}: ${c.text}${c.note?.text ? ` [note: ${c.note.text}]` : ""}`;
async function numbered(id, st = store) {
  return prepare(await st.list()).find((x) => x.id === id);
}
async function call(name, a = {}) {
  const st = storeOf(a.session);
  const who = a.as || defaultAs;
  const ppl = await people();
  if (name === "review_list") {
    const all = prepare(await st.list());
    const list = all.filter((c) => (a.open === false || c.status !== "approved") && (!a.mine || holder(c) === who)).map((c) => withNames(c, ppl));
    return list.length ? `${list.length} comment${list.length === 1 ? "" : "s"} on ${st.project}:\n${list.map(line).join("\n")}` : "No comments.";
  }
  const c = a.id ? await st.get(a.id) : null;
  if (name !== "review_ack" && name !== "review_list" && !c) throw new Error(`No comment with id ${a.id}`);
  /* what Claude has read shows on the card while a call is answered: the thread (show), the picture */
  const tick = async (what) => {
    if (c.call?.state !== "reading" || c.call.read?.includes(what)) return;
    applyChange(c, { claudeRead: what }, who);
    await st.put(c);
  };
  if (name === "review_show") {
    await tick("thread");
    return JSON.stringify({ ...withNames(c, ppl), n: (await numbered(c.id, st))?.n }, null, 2);
  }
  if (name === "review_pick_up") {
    if (kind(c.severity) === "question") throw new Error("This is a question: answer it with review_reply");
    if (c.status === "progress" && c.assignee && c.assignee !== who) throw new Error(`Already picked up by ${withNames(c, ppl).assignee}: leave it and tell the person`);
    applyChange(c, { status: "progress", via: "claude" }, who);
    await st.put(c);
    return `Picked up: ${line({ ...withNames(c, ppl), n: (await numbered(c.id, st))?.n })}`;
  }
  if (name === "review_done") {
    if (kind(c.severity) === "question") throw new Error("This is a question: answer it with review_reply");
    applyChange(c, { status: "approval", via: "claude" }, who);
    await st.put(c);
    return `For approval: ${line({ ...withNames(c, ppl), n: (await numbered(c.id, st))?.n })}`;
  }
  if (name === "review_reply") {
    applyChange(c, { reply: String(a.text || ""), via: "claude" }, who);
    await st.put(c);
    return `Answered #${(await numbered(c.id, st))?.n}`;
  }
  if (name === "review_picture") {
    if (!c.shot) return "This comment has no picture.";
    await tick("picture");
    const bytes = await st.shot(c.shot);
    const sess = a.session || process.env.REVIEW_SESSION;
    const dir = path.join(cfg.sessionsDir, sess && /^_[a-z0-9-]+$/.test(sess) ? sess : cfg.project, "export"); // a test session's pictures stay in its own folder
    fs.mkdirSync(dir, { recursive: true });
    const n = (await numbered(c.id, st))?.n || 0;
    const file = path.join(dir, `${String(n).padStart(2, "0")}-${c.id}.png`);
    fs.writeFileSync(file, bytes);
    return file;
  }
  if (name === "review_suggest") {
    if (c.draft && c.draft.state !== "drafting" && c.draft.state !== "reply") return `#${(await numbered(c.id, st))?.n} already has a suggestion: nothing to do`;
    if (c.status !== "open" && !(c.status === "progress" && c.draft?.thread?.length)) return `#${(await numbered(c.id, st))?.n} is already being worked: no suggestion needed`;
    applyChange(c, { draft: { text: String(a.text || ""), unsure: a.unsure === true } }, who);
    await st.put(c);
    drafted.add(`${c.id}:${c.draft?.thread?.length || 0}`);
    heard = true;
    return `Suggestion left on #${(await numbered(c.id, st))?.n}; the person accepts or ignores it in the drawer.`;
  }
  if (name === "review_talk") {
    const words = String(a.text || "").trim();
    if (!words) throw new Error("Say something: text is empty");
    if (!c.call || c.call.state === "done") return `#${(await numbered(c.id, st))?.n}: nobody is waiting on Claude here, nothing sent`;
    /* STEP 4, A FOLLOW-UP ON THE SAME PR (Nirav, 2026-11-04: a clear instruction is the go): "make it 16" from the asker
       or an approver changes the open PR's branch, no new plan, no new PR; anyone else's needs a plan and a Go */
    if (a.kind === "change") {
      if (!(c.pr?.n && c.pr.state === "open" && !c.pr.draft && c.pr.branch)) throw new Error('kind "change" is only for a comment with an open, ready PR: use kind "plan"');
      const asker = c.call.by;
      if (!mayFollow(c, asker)) throw new Error(`${withNames(c, ppl).call.by} can't give the go on their own: use kind "plan", and the person the PR is for or an approver says Go`);
      applyChange(c, { reply: words, via: "claude", prN: c.pr.n }, who);
      const step = c.history.at(-1);
      c.call = { state: "reading", kind: "go", followup: true, at: step.at, by: asker, asker, claimedAt: Date.now(), words, read: [], step: step.at };
      const n = (await numbered(c.id, st))?.n;
      let w;
      try {
        w = prepareWork(c, n, c.pr.branch);
      } catch (e) {
        c.call.state = "done";
        await st.put(c);
        throw new Error(`Could not open PR #${c.pr.n}'s branch: ${String(e.message || e).split("\n")[0]}`);
      }
      works.set(c.id, { ...w, plan: words, by: asker, sess: a.session || "", mode: "followup" });
      c.call.alive = Date.now();
      held.add(callKey(c));
      await st.put(c);
      called.delete(callKey(c));
      heard = true;
      return `On PR #${c.pr.n}'s branch: make exactly that, nothing more, in ${w.app} (never ${ROOT}; no installs, no git). Then review_ship with id ${c.id}, a short title and a one-sentence summary: it updates the same PR.`;
    }
    if (a.kind === "draft") applyChange(c, { claudeDraft: { text: words } }, who);
    else {
      const stopped = c.call.state === "stopped" || (works.has(c.id) && !["go", "preview"].includes(c.call.kind)); // after a Stop: the folder waits for their answer
      const live = a.kind === "plan" && cfg.previews !== "never" && (a.preview === true || cfg.previews === "always");
      applyChange(c, { reply: words, via: "claude", ...(a.kind === "ask" ? { ask: true, options: a.options || [] } : a.kind === "plan" ? { plan: true, ...(live ? { preview: true } : {}) } : {}) }, who);
      if (works.has(c.id) && !stopped) dropWork(c.id); // a go that ends in words: the work folder goes
      if (live) {
        await st.put(c);
        const n = (await numbered(c.id, st))?.n;
        try {
          const w = prepareWork(c, n, draftBranch(c));
          works.set(c.id, { ...w, plan: words, by: c.call.by, sess: a.session || "", mode: "preview" });
          return `Plan left on #${n}. Now build its live preview: make exactly the planned change in ${w.app} (a fresh copy, branch ${w.branch}; never ${ROOT}; no installs, no git), then review_preview with id ${c.id} and a short PR title. The plan waits for a person's Go meanwhile.`;
        } catch (e) {
          return `Plan left on #${n}, but the live preview could not start: ${String(e.message || e).split("\n")[0]}. The plan still works with Go.`;
        }
      }
    }
    await st.put(c);
    called.delete(callKey(c));
    heard = true;
    const n = (await numbered(c.id, st))?.n;
    if (a.kind === "plan") return `Plan left on #${(await numbered(c.id, st))?.n}; it waits for a person's Go, then comes back to you`;
    return a.kind === "draft" ? `Draft left on #${n}, only ${withNames(c, ppl).call?.draft?.for || "they"} sees it` : a.kind === "ask" ? `Asked on #${n}; their reply comes back as a new call` : `Answered on #${n}`;
  }
  if (c.call?.state === "stopped" && (name === "review_ship" || name === "review_preview"))
    throw new Error(`${withNames(c, await people()).call.stoppedBy || "Someone"} pressed Stop: do not ship. Say what you had done with review_talk (kind "ask", options Throw it away / Carry on / Push what's done) and wait for their answer`);
  if (name === "review_ship") return works.get(c.id)?.mode === "preview" ? previewBuild(c, st, a) : ship(c, st, a);
  if (name === "review_preview") return previewBuild(c, st, a);
  if (name === "review_undo") {
    if (!c.pr?.n) throw new Error("This comment has no PR of Claude's to undo");
    const asker = c.call?.by || who;
    if (!mayFollow(c, asker)) throw new Error(`${withNames(c, ppl).call?.by || asker} can't undo on their own: ask the person the PR is for, or an approver`);
    const gh = cfg.github, n = (await numbered(c.id, st))?.n, text = String(a.text || "").trim().replace(/^undone\s*[:,.-]?\s*/i, "").slice(0, 300); // "Undone:" is said once, by the server
    const dry = process.env.REVIEW_SHIP_DRY === "1";
    const files = (Array.isArray(a.files) ? a.files : []).map((f) => String(f).trim().replace(/^\/+/, "")).filter(Boolean).slice(0, 20);
    const say = (words, extra = {}) => applyChange(c, { reply: words, via: "claude", ...extra }, asker);
    if (c.pr.state === "open" && files.length) {
      const w = prepareWork(c, n, c.pr.branch);
      works.set(c.id, { ...w, mode: "undo" }); // so dropWork clears the folder
      try {
        run("git", ["-C", GIT_ROOT, "fetch", w.remote, gh.base]);
        for (const f of files) {
          const rel = fs.existsSync(path.join(w.dir, f)) || !APP_REL ? f : path.join(APP_REL, f);
          try { run("git", ["-C", w.dir, "checkout", `${w.remote}/${gh.base}`, "--", rel]); } catch { run("git", ["-C", w.dir, "rm", "-q", "--", rel]); } // new on the branch: it goes
        }
        if (!run("git", ["-C", w.dir, "status", "--porcelain"])) throw new Error("Those files are already as they are on staging");
        run("git", ["-C", w.dir, "commit", "-q", "-am", `Undo part of review #${n}: ${files.join(", ")} back as on ${gh.base}\n\nCo-Authored-By: Claude <noreply@anthropic.com>`]);
        if (!dry) run("git", ["-C", w.dir, "push", "-q", w.remote, w.branch]);
      } finally {
        dropWork(c.id);
      }
      prSoon();
      say(`Undone: ${text} It's on the same PR #${c.pr.n}; new before and after pictures come in a minute or two.`, { prN: c.pr.n });
      await st.put(c);
      return dry ? `DRY RUN: undo committed on ${c.pr.branch}, not pushed` : `Part undone on PR #${c.pr.n}.`;
    }
    if (c.pr.state === "open") {
      if (dry) return `DRY RUN: PR #${c.pr.n} would be closed and #${n} go back to In progress`;
      run("gh", ["pr", "close", String(c.pr.n), "--repo", c.pr.repo || gh.repo, "--delete-branch", "--comment", `Undone from review comment #${n}.`]);
      applyChange(c, { pr: { n: c.pr.n, state: "closed" } }, asker);
      say(`Undone: ${text} I closed PR #${c.pr.n}, so nothing reaches staging.`);
      if (c.status === "approval") applyChange(c, { status: "progress", via: "claude" }, asker);
      await st.put(c);
      return dry ? "DRY RUN: the PR would be closed" : `PR #${c.pr.n} closed; #${n} is In progress again.`;
    }
    if (c.pr.state === "merged") {
      const sha = JSON.parse(run("gh", ["pr", "view", String(c.pr.n), "--repo", c.pr.repo || gh.repo, "--json", "mergeCommit"])).mergeCommit?.oid;
      if (!sha) throw new Error(`Couldn't find what PR #${c.pr.n} merged`);
      const old = c.pr.n;
      const w = prepareWork({ ...c, pr: null, text: `undo ${old}` }, n);
      works.set(c.id, { ...w, mode: "undo" });
      let url = "", prN = 0;
      try {
        run("git", ["-C", GIT_ROOT, "fetch", w.remote, sha]);
        const parents = run("git", ["-C", w.dir, "rev-list", "--parents", "-n", "1", sha]).split(" ").length - 1;
        run("git", ["-C", w.dir, "revert", "--no-edit", ...(parents > 1 ? ["-m", "1"] : []), sha]);
        if (dry) return `DRY RUN: PR #${old} reverted on ${w.branch}, not pushed`;
        run("git", ["-C", w.dir, "push", "-q", "-u", w.remote, w.branch]);
        works.get(c.id).pushed = true;
        url = run("gh", ["pr", "create", "--repo", gh.repo, "--base", gh.base, "--head", w.branch, "--title", `Undo PR #${old} (review #${n})`, "--body", [`Takes PR #${old} back out of ${gh.base}, asked in review comment #${n}: ${text}`, ``, `Claude never merges: a person merges this.`, ``, `🤖 Generated with [Claude Code](https://claude.com/claude-code)`].join("\n")]).split("\n").pop();
        prN = Number(url.match(/\/pull\/(\d+)/)?.[1]);
      } finally {
        dropWork(c.id);
      }
      prSoon();
      applyChange(c, { pr: { n: prN, url, branch: w.branch, repo: gh.repo, state: "open", draft: false, for: asker } }, asker);
      c.pr.undoes = old;
      say(`Undone: ${text} PR #${prN} takes PR #${old} back out of staging; it needs a merge like any PR.`, { prN });
      await st.put(c);
      return `PR #${prN} undoes PR #${old}; a person merges it.`;
    }
    throw new Error(`PR #${c.pr.n} is ${c.pr.state}: nothing to undo`);
  }
  if (name === "review_resnap") {
    const p = c.pics?.at(-1);
    if (!p || !c.pr?.preview) throw new Error("No pictures or preview on this comment to retake");
    const key = `${c.id}:${p.sha}:resnap`;
    if ((snapFails.get(key) || 0) >= 3) throw new Error("Already retaken 3 times: answer review_checked with missed true");
    snapFails.set(key, (snapFails.get(key) || 0) + 1);
    const steps = (Array.isArray(a.steps) ? a.steps : []).map((x) => String(x).trim()).filter(Boolean).slice(0, 8).map((x) => {
      const m = x.match(/^(click|hover|press)\s+(.+)$/i);
      if (!m) return { kind: "click", textKey: x.slice(0, 80) };
      const kind = m[1].toLowerCase();
      return kind === "press" ? { kind: "key", key: m[2].trim(), code: m[2].trim() } : { kind, textKey: m[2].trim().replace(/^["']|["']$/g, "").slice(0, 80) };
    });
    c.snapSteps = steps;
    if (a.target) c.snapTarget = String(a.target).trim().slice(0, 80);
    await st.put(c);
    const r = await picsFor(c.id, a.session || "", new URL(c.pr.preview).origin, p.sha, true);
    if (!r) throw new Error("The pictures could not be taken again");
    return `Retaken with ${steps.length} step${steps.length === 1 ? "" : "s"}: the spot was ${r.found.before && r.found.after ? "found on both pages" : `not found on ${!r.found.before && !r.found.after ? "either page" : !r.found.before ? "staging" : "the preview"} (the whole window)`}. Read before ${r.local.before} and after ${r.local.after}, then review_checked.`;
  }
  if (name === "review_checked") {
    const p = c.pics?.at(-1);
    if (!p) throw new Error("No pictures on this comment to check");
    if (a.ok === true || a.nothing === true || a.missed === true) {
      applyChange(c, { picsChecked: true }, who);
      if (a.nothing === true) c.pics.at(-1).hidden = true;
      if (a.missed === true) c.pics.at(-1).missed = true;
      await st.put(c);
      return a.nothing ? "Pictures hidden: nothing on screen changes." : a.missed ? "Pictures hidden: the thread says to try it live." : "Marked checked: the after matches your plan.";
    }
    const words = String(a.text || "").trim();
    if (!words) throw new Error("Say what is wrong in text");
    p.wrong = Date.now();
    applyChange(c, { reply: words, via: "claude", ask: true, options: Array.isArray(a.options) ? a.options : [] }, who);
    const step = c.history.at(-1);
    if (c.call && c.call.state !== "asked") Object.assign(c.call, { state: "asked", askAt: step.at }); // their answer comes back to you
    else if (!c.call) c.call = { state: "asked", at: step.at, by: c.pr?.for || who, words: "", read: [], askAt: step.at };
    if (!step.for && c.pr?.for) step.for = c.pr.for;
    await st.put(c);
    return `Asked on #${(await numbered(c.id, st))?.n}; their answer comes back as a call.`;
  }
  if (name === "review_drop") {
    dropWork(c.id);
    applyChange(c, { reply: "Thrown away, nothing was pushed. The plan still waits for Go.", via: "claude" }, who);
    applyChange(c, { replan: true }, who);
    await st.put(c);
    called.delete(callKey(c));
    return `Work on #${(await numbered(c.id, st))?.n} thrown away; the plan waits for Go again.`;
  }
  if (name === "review_ack") {
    const d = deliveries.get(a.delivery_id);
    if (d) d.acked = Date.now();
    heard = true; // a brief from the drawer reached Claude: drafting requests will too
    return "Thanks: the drawer shows you have it.";
  }
  throw new Error(`Unknown tool ${name}`);
}

/* ---------- Claude drafts first ---------- */
/* Every 30 s: the open comments of the last three days with no suggestion (and no live claim by another session) are
   claimed and handed to this Claude session through the channel, three at a time, so each new comment gets a short
   "Claude suggests…" on its card. Without channels the hand-off is not heard; the claim lapses after ten minutes and
   another session may try. Off with "drafts": false in review.config.json or REVIEW_DRAFTS=0. */
const DRAFT_EVERY = 30_000, DRAFT_WINDOW = 3 * 86400_000, DRAFT_BATCH = 3;
const drafted = new Set();
let ready = false; // the session said hello (initialized): channel messages before that are lost
/* CAN THIS SESSION HEAR US? (Nirav, 2026-10-26: no "Claude is looking at it…" when it is not.) A comment is claimed
   only when the Claude above this server was started the connected way (its command line carries
   --dangerously-load-development-channels with server:review, as `npx --no review-mode claude` and the shell helper
   do), or this session has already shown it hears: Claude confirmed a "Send to Claude" or left a suggestion. */
let heard = process.env.REVIEW_CHANNEL === "1";
const startedConnected = (() => {
  if (process.platform === "win32") return false;
  try {
    let pid = process.ppid;
    for (let i = 0; i < 5 && pid > 1; i++) {
      const [ppid, ...args] = execSync(`ps -o ppid=,args= -p ${pid}`, { stdio: ["ignore", "pipe", "ignore"] }).toString().trim().split(/\s+/);
      const cmd = args.join(" ");
      const isClaude = args.slice(0, 2).some((x) => /claude/i.test(x.split("/").pop() || "")); // claude itself, not a shell whose script mentions it
      if (isClaude && /--dangerously-load-development-channels/.test(cmd) && /server:review\b/.test(cmd)) return true;
      pid = Number(ppid);
    }
  } catch {}
  return false;
})();
const canHear = () => heard || startedConnected;
async function draftRound() {
  if (!ready || !cfg.drafts || !canHear()) return;
  try {
    const all = prepare(await store.list());
    const turn = (c) => `${c.id}:${c.draft?.thread?.length || 0}`; // a new answer from the person is a new turn
    const fresh = all.filter((c) => (c.status === "open" || (c.status === "progress" && c.draft?.state === "reply")) && Date.now() - (c.ts || 0) < DRAFT_WINDOW && !drafted.has(turn(c)) && draftOpen(c.draft));
    /* answers to Claude's questions first (someone is waiting on the card), then the newest */
    const pick = [...fresh.filter((c) => c.draft?.state === "reply"), ...fresh.filter((c) => c.draft?.state !== "reply").reverse()].slice(0, DRAFT_BATCH);
    if (!pick.length) return;
    const lines = [];
    for (const c of pick) {
      const full = await store.get(c.id);
      if (!full || !draftOpen(full.draft)) continue;
      applyChange(full, { draft: "drafting" }, defaultAs);
      await store.put(full);
      drafted.add(turn(full));
      const src = full.source?.file ? ` · code: ${full.source.file}${full.source.line ? `:${full.source.line}` : ""}${full.source.component ? ` (${full.source.component})` : ""}` : "";
      const talk = (full.draft?.thread || []).map((t) => `\n    you asked: "${t.q}"\n    ${t.by || "they"} answered: "${t.a}"`).join("");
      lines.push(`#${c.n} ${c.id} ${kind(full.severity)}: "${full.text}" · ${full.pageTitle || full.route}${src}${talk}`);
    }
    if (!lines.length) return;
    const text = [
      `Claude drafts first: ${lines.length === 1 ? "a new review comment needs" : `${lines.length} new review comments need`} a suggestion.`,
      `For each: read it (review_show), look at its picture (review_picture, then Read the file: most comments are about`,
      `what the screen looks like), and read the code it points at. Then call review_suggest with one or two plain`,
      `sentences: for a fix, what you would change and where (file and line); for a question, the answer.`,
      `Not sure what is meant, or no clear change in the code? Set unsure and ask, in one sentence, what you would need`,
      `to know. A wrong suggestion said with confidence is worse than none.`,
      `Where you asked before and the person answered, draft again with their answer.`,
      `Draft only: change no code and no status. Then carry on with whatever you were doing.`,
      ``,
      ...lines,
    ].join("\n");
    send({ method: "notifications/claude/channel", params: { content: text, meta: { kind: "draft", comments: String(lines.length), project: String(store.project) } } });
  } catch {}
}
setInterval(draftRound, DRAFT_EVERY).unref?.();

/* ---------- Claude as a teammate: answering calls ---------- */
/* Every 6 s: comments whose call waits (someone wrote @Claude, answered Claude's question, or handed it to Claude) are
   claimed and sent to this session with everything Claude needs to read first. A claim lapses after ten minutes. */
const CALL_EVERY = 6_000;
const called = new Set();
const held = new Set(); // calls this session claimed: kept alive while it runs
const callKey = (c) => `${c.id}:${c.call?.at || 0}`; // ids are unique across sessions (time-based)
const ago = (t) => { const m = Math.round((Date.now() - t) / 60000); return m < 1 ? "just now" : m < 60 ? `${m} min ago` : m < 1440 ? `${Math.round(m / 60)} h ago` : `${Math.round(m / 1440)} d ago`; };
async function callRound() {
  if (!ready || !canHear()) return;
  try {
    const ppl = await people();
    for (const sess of ["", ...localTests()]) {
    const st = storeOf(sess);
    const all = prepare(await st.list());
    /* the calls this session holds: touched once a minute, so the page and other sessions know it is still here */
    for (const c of all.filter((x) => x.call?.state === "reading" && held.has(callKey(x)) && Date.now() - (x.call.alive || 0) > 60_000)) {
      const full = await st.get(c.id);
      if (!full || full.call?.state !== "reading" || !held.has(callKey(full))) continue;
      applyChange(full, { callAlive: true }, defaultAs);
      await st.put(full);
    }
    /* STOP (Nirav, 2026-11-05): someone pressed Stop while Claude worked. Claude is told at once; with no work folder
       here (another session, or a restart) the review server answers for it and the plan waits for Go again */
    for (const c of all.filter((x) => x.call?.state === "stopped" && !x.call.stopSent)) {
      const full = await st.get(c.id);
      if (!full || full.call?.state !== "stopped" || full.call.stopSent) continue;
      const w = works.get(full.id);
      const by = withNames(full, ppl).call.stoppedBy || "Someone";
      if (!w) {
        applyChange(full, { reply: "Stopped. Nothing was changed. The plan still waits for Go.", via: "claude" }, defaultAs);
        applyChange(full, { replan: true }, defaultAs);
        await st.put(full);
        continue;
      }
      applyChange(full, { stopSent: true }, defaultAs);
      await st.put(full);
      const changed = (() => { try { return run("git", ["-C", w.dir, "status", "--porcelain"]); } catch { return ""; } })();
      send({ method: "notifications/claude/channel", params: { content: [
        `STOP on review comment #${c.n} (${full.id})${sess ? `, TEST SESSION ${sess} (pass session "${sess}" to the review tools)` : ""}: ${by} pressed Stop.`,
        `Stop working on it now: no more edits in ${w.app}, do not ship.`,
        changed ? `Files changed so far:\n${changed}` : `Nothing is changed in the work folder yet.`,
        `Then review_talk kind "ask" (as "${defaultAs}"): one or two sentences on what you had done (or that nothing was changed), with options`,
        `${changed ? `["Throw it away", "Carry on", "Push what's done"]` : `["Throw it away", "Carry on"]`}. Their answer comes back as a call; the work folder waits for it.`,
      ].join("\n"), meta: { kind: "stop", comment: String(c.n), project: String(store.project), ...(sess ? { session: sess } : {}) } } });
    }
    for (const c of all.filter((x) => callOpen(x.call) && !called.has(callKey(x))).slice(0, 3)) {
      const full = await st.get(c.id);
      if (!full || !callOpen(full.call)) continue;
      applyChange(full, { callState: "reading" }, defaultAs);
      await st.put(full);
      called.add(callKey(full));
      held.add(callKey(full));
      const named = withNames(full, ppl);
      const k = named.call;
      /* Go on the plan whose preview is built: the draft becomes the PR, nothing to redo */
      if (k.kind === "go" && full.pr?.draft && full.pr.state === "open" && full.pr.planAt && full.pr.planAt === full.call.planAt && !works.has(full.id)) {
        try {
          run("gh", ["pr", "ready", String(full.pr.n), "--repo", full.pr.repo || cfg.github.repo]);
          await finishGo(full, st, full.pr.n, full.pr.url, (k.words || "").replace(/^plan:\s*/i, ""), full.call.by);
        } catch (e) {
          applyChange(full, { reply: `I couldn't mark PR #${full.pr.n} ready: ${String(e.message || e).split("\n")[0]}.`, via: "claude" }, full.call.by);
          await st.put(full);
        }
        continue;
      }
      if ((k.kind === "go" || k.kind === "preview") && works.has(full.id)) continue; // Claude is building it already: review_preview ships or shows it
      if (k.kind === "preview") {
        const p = (named.history || []).find((h) => h.at === full.call.planAt && h.via === "claude");
        let w;
        try {
          w = { ...prepareWork(full, c.n, draftBranch(full)), plan: p?.note || k.words, by: full.call.by, sess, mode: "preview" };
        } catch (e) {
          applyChange(full, { callState: "planned" }, full.call.by);
          applyChange(full, { reply: `I couldn't build a live preview: ${String(e.message || e).split("\n")[0]}. The plan still works with Go.`, via: "claude" }, full.call.by);
          await st.put(full);
          continue;
        }
        works.set(full.id, w);
        send({ method: "notifications/claude/channel", params: { content: [
          `LIVE PREVIEW for review comment #${c.n} (${full.id})${sess ? `, TEST SESSION ${sess} (pass session "${sess}" to the review tools)` : ""}: ${k.by} asked to see your plan live:`,
          `  "${w.plan}"`,
          ``,
          `Make exactly that change in the work folder: ${w.app} (branch ${w.branch}). Edit files ONLY there, never in ${ROOT}.`,
          `No installs, no dev server, no git. Then review_preview with id ${full.id} and a short PR title: a draft PR, its preview shows on the plan.`,
        ].join("\n"), meta: { kind: "preview", comment: String(c.n), project: String(store.project), ...(sess ? { session: sess } : {}) } } });
        continue;
      }
      if (k.kind === "go") {
        let w;
        try {
          w = { ...prepareWork(full, c.n, draftBranch(full)), plan: k.words, by: full.call.by, sess };
        } catch (e) {
          applyChange(full, { reply: `I couldn't start on it: ${String(e.message || e).split("\n")[0]}. Nothing was changed.`, via: "claude" }, full.call.by);
          await st.put(full);
          continue;
        }
        works.set(full.id, w);
        const go = [
          `GO on review comment #${c.n} (${full.id})${sess ? `, TEST SESSION ${sess} (pass session "${sess}" to the review tools)` : ""}: ${k.by} said go to your plan:`,
          `  "${k.words}"`,
          ``,
          `Comment by ${named.by}: "${full.text}" · Page: ${full.pageTitle || full.route || "?"} · Code: ${full.source?.file ? `${full.source.file}${full.source.line ? `:${full.source.line}` : ""}` : "find it from the page"}`,
          ``,
          ...(draftBranch(full) ? [`The branch already holds the live preview you built for an earlier plan: bring it to this plan.`] : []),
          `Make exactly that change, nothing more, in the work folder: ${w.app}`,
          `(a fresh copy of ${cfg.github.repo} ${cfg.github.base}, branch ${w.branch}). Edit files ONLY there, never in ${ROOT}.`,
          `Use the design system's tokens and components${cfg.designSystem ? ` (${cfg.designSystem})` : ""}. No installs, no dev server, no git: the review server does the git.`,
          `When it is done: review_ship with id ${full.id}, a short PR title and a one or two sentence summary in design words.`,
          `It commits, pushes, opens the PR on the comment and moves it to For approval. If you find you cannot do it as planned,`,
          `review_talk instead (ask, or answer to say why); the work folder is thrown away. Then carry on with what you were doing.`,
        ].join("\n");
        send({ method: "notifications/claude/channel", params: { content: go, meta: { kind: "go", comment: String(c.n), project: String(store.project), ...(sess ? { session: sess } : {}) } } });
        continue;
      }
      const src = full.source?.file ? `${full.source.file}${full.source.line ? `:${full.source.line}` : ""}${full.source.component ? ` (${full.source.component})` : ""}` : "none recorded: find it from the page and the element";
      const talk = (named.history || []).filter((h) => h.kind === "reply").map((h) => `  ${h.via === "claude" ? "Claude" : h.by} (${ago(h.at)}): ${h.note}${h.ask ? "  [your question]" : ""}`);
      const asked = k.answers ? (named.history || []).find((h) => h.at === k.answers && h.via === "claude") : null; // the question this reply answers
      const what = k.sentBack ? `${k.by} sent your change back: "${k.words}". It's about your PR #${full.pr?.n}: if the reason says how, change it on the same PR (kind "change"); if not, plan or ask.`
        : k.kind === "assigned" ? `${k.by} handed this comment to you. Work out what it needs and tell them (an answer, or what you would change and where).`
        : k.kind === "draft" ? `${k.by} asked for help writing a reply: "${k.words}". Draft it (kind "draft"), only they see it.`
        : asked ? `${k.by} answered your question ("${asked.note}"): "${k.words}". Carry on from there.`
        : `${k.by} wrote: "${k.words}"`;
      const text = [
        `@Claude on review comment #${c.n} (${full.id}), ${kind(full.severity)}, ${named.status}${named.assignee ? `, ${named.assignee} on it` : ""}.`,
        ...(sess ? [`TEST SESSION ${sess}: pass session "${sess}" to review_show, review_picture and review_talk. A person is trying Claude out here.`] : []),
        what,
        ``,
        `Comment by ${named.by}: "${full.text}"`,
        `Page: ${full.pageTitle || full.route || "?"}${full.route ? ` (${full.route})` : ""} · Code: ${src}${full.shot ? " · has a picture" : ""}`,
        ...(talk.length ? [`The thread so far:`, ...talk] : [`No replies before this.`]),
        ``,
        `Read first: review_show ${full.id}${sess ? ` (session ${sess})` : ""} (the whole record), review_picture then Read the file (what it looks like),`,
        `the code at the source, ${cfg.designSystem ? `and the team's design system (${cfg.designSystem}${/github\.com\//.test(cfg.designSystem) ? "; read it with gh, its TOKENS.md and component-catalog.json first" : ""}): use its tokens and components by name` : "and the project's design system or tokens"}.`,
        `Then answer with review_talk (as "${defaultAs}"), ONE of:`,
        `(Keep every message short: the point in the first sentence, 3 sentences at most, more only when they ask. Long`,
        `messages fold after 4 lines in the thread, so what comes first is what people read.)`,
        `- "answer": a short message in the thread. Everyone on this team is a designer: plain design words ("the gap`,
        `  between the title and the icon", "the spacing token space-2"), no code talk unless they ask for files.`,
        `- "ask": you cannot tell what they mean, or your message asks them anything at all. One question, with 2 to 4`,
        `  quick picks in options. Anything that waits on their reply is an ask, never an answer: only an ask comes back to you.`,
        `- "draft": they asked for help writing a reply. The words they would send, in their voice.`,
        `- "plan": they want something changed. What you will change and where, in design words, one short paragraph; it`,
        `  waits for a person's Go (every change does), then comes back to you to make.`,
        ...(cfg.previews === "never" ? [] : cfg.previews === "always" ? [`  Every plan comes with a live preview (the team's setting): you will be told where to make it.`] : [
        `  Decide on a live preview (preview: true) and say which in the plan, with why ("Live preview: this changes every`,
        `  banner's hover" / "No preview: only the label text changes"). PREVIEW when it changes how something looks (colour,`,
        `  spacing, size, type, borders, shadows), how it behaves (hover, press, focus, motion, open and close, loading),`,
        `  layout (moves, wraps, other widths), a shared piece (a common component or style: other pages change too), or`,
        `  when you are not sure it will look right. NO PREVIEW for words only, a value swapped for its exact token with`,
        `  nothing visible changing, non-visual fixes (a link, a click, a screen reader label), or an obvious one-liner.`]),
        ...(cfg.previews === "never" ? [] : [
        `  When they ask to SEE it ("show me", "an image", "how will it look", "can I try it"), that is a plan with`,
        `  preview: true, whatever the rules above say: never answer that you can only write words.`,
        `  Show a change through that live preview (anyone on the team can open it), not a Claude artifact. Only when`,
        `  they ask for an artifact or a mock by name, make one: write the page in React from the design system's own`,
        `  components (import them from its package, never look-alikes), run npx --no review-mode mock <page.jsx>, publish`,
        `  the HTML it makes, and put its link in an answer, saying it is private: only`,
        `  ${defaultAs} (whose Claude made it) can open it until they press Share on it in claude.ai.`]),
        `  Explaining a change you would make is always a plan (so it carries Go and Show me live), never an answer.`,
        `  Asking them anything is always an ask (with quick picks), never an answer.`,
        ...(full.pr?.draft && full.pr.state === "open" ? [`  There is a draft PR #${full.pr.n} from your earlier plan: a new plan with a preview builds on its branch.`] : []),
        ...(full.pr?.n && full.pr.state === "open" && !full.pr.draft ? [
        `- "change": this comment has your open PR #${full.pr.n}. When ${k.by} says exactly what to change ("make it 16", "use the token",`,
        `  a send-back reason that says how), that is the go: kind "change", one short line of what you'll do; it updates the same PR.`,
        `  When the how is open ("it should feel lighter"), plan instead. "Undo" (all of it, or a part: "undo the Agents part"):`,
        `  review_undo, with the files to put back for a part.`] : []),
        ...(full.pr?.n && full.pr.state === "merged" ? [`  Your PR #${full.pr.n} was merged. "Undo" from ${k.by}: review_undo opens a PR that takes it back out.`] : []),
        ...(works.has(full.id) ? [
        `AFTER A STOP: your work folder for this change is still there (${works.get(full.id).app}). Their reply says what next:`,
        `  carry on: finish exactly the plan there, then review_ship (or review_preview for a preview); push what's done: review_ship`,
        `  (review_preview for a preview) with what is there; throw it away: review_drop. Anything else: answer or ask as usual.`] : [
        `Do not change code or any status from a call.`]),
        `Then carry on with what you were doing.`,
      ].join("\n");
      send({ method: "notifications/claude/channel", params: { content: text, meta: { kind: "call", comment: String(c.n), project: String(store.project), ...(sess ? { session: sess } : {}) } } });
    }
    }
  } catch {}
}
setInterval(callRound, CALL_EVERY).unref?.();

/* a follow-up or an undo on Claude's PR is a go: from the person the PR is for (who asked, or said Go), or an approver */
const sameWho = (a, b) => !!a && !!b && String(a).toLowerCase() === String(b).toLowerCase();
function mayFollow(c, who) {
  const plan = [...(c.history || [])].reverse().find((h) => h.plan && h.via === "claude");
  return (cfg.approvers || []).some((x) => sameWho(x, who)) || sameWho(c.pr?.for, who) || sameWho(plan?.for, who);
}
/* ---------- Step 2: Go, the work folder, the PR ---------- */
/* On Go the review server, not Claude, does the git: a fresh worktree of the GitHub repo's base branch outside the
   project (Claude never edits the person's own folder), and when Claude is done (review_ship) it commits, pushes and
   opens the PR. REVIEW_SHIP_DRY=1 stops before the push, for trying it out. */
const run = (cmd, args, opts = {}) => execFileSync(cmd, args, { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"], timeout: 180_000, ...opts }).trim();
const GIT_ROOT = (() => {
  try {
    return run("git", ["-C", ROOT, "rev-parse", "--show-toplevel"]);
  } catch {
    return null;
  }
})();
const APP_REL = GIT_ROOT ? path.relative(GIT_ROOT, ROOT) : "";
const WORK_DIR = path.join(os.homedir(), ".review-mode", "work");
const works = new Map(); // comment id -> { branch, dir, app, remote, plan, by, sess }
const remoteFor = (repo) => run("git", ["-C", GIT_ROOT, "remote", "-v"]).split("\n").find((l) => new RegExp(`github\\.com[/:]${repo.replace(/[.]/g, "\\.")}(\\.git)?\\s`).test(l))?.split(/\s+/)[0];
const slug = (t) => String(t || "").toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 28).replace(/-+$/, "");
/* the open draft PR's branch, for a new plan or a Go to build on */
const draftBranch = (c) => (c.pr?.draft && c.pr.state === "open" && c.pr.branch ? c.pr.branch : null);
function prepareWork(c, n, from = null) {
  const gh = cfg.github;
  if (!gh) throw new Error("no GitHub repo is set for this project (github in hub.json)");
  if (!GIT_ROOT) throw new Error("the project is not in git");
  const remote = remoteFor(gh.repo);
  if (!remote) throw new Error(`no git remote of this project points at ${gh.repo}`);
  const branch = from || `claude/review-${n}-${slug(c.text) || "fix"}-${Date.now().toString(36).slice(-4)}`;
  run("git", ["-C", GIT_ROOT, "fetch", remote, from || gh.base]);
  const dir = path.join(WORK_DIR, branch.replace(/\//g, "__"));
  fs.mkdirSync(WORK_DIR, { recursive: true });
  /* a folder for this branch a closed session left behind: cleared, the work starts again from the branch */
  if (fs.existsSync(dir)) {
    try { run("git", ["-C", GIT_ROOT, "worktree", "remove", "--force", dir]); } catch { fs.rmSync(dir, { recursive: true, force: true }); run("git", ["-C", GIT_ROOT, "worktree", "prune"]); }
  }
  run("git", ["-C", GIT_ROOT, "worktree", "add", "--no-track", "-B", branch, dir, `${remote}/${from || gh.base}`]);
  return { branch, dir, app: path.join(dir, APP_REL), remote };
}
function dropWork(id) {
  const w = works.get(id);
  works.delete(id);
  if (!w) return;
  try {
    run("git", ["-C", GIT_ROOT, "worktree", "remove", "--force", w.dir]);
    if (!w.pushed) run("git", ["-C", GIT_ROOT, "branch", "-D", w.branch]);
  } catch {}
}
async function ship(c, st, a) {
  const w = works.get(c.id);
  if (!w) throw new Error("No work folder for this comment: only a go call is shipped");
  const gh = cfg.github;
  if (!run("git", ["-C", w.dir, "status", "--porcelain"])) throw new Error(`Nothing changed in ${w.app}: make the change there first`);
  const n = (await numbered(c.id, st))?.n;
  const ppl = await people();
  const goer = withNames(c, ppl).call?.by || w.by;
  const title = String(a.title || "").trim().slice(0, 120) || `Review #${n}`;
  const summary = String(a.summary || "").trim().slice(0, 600);
  run("git", ["-C", w.dir, "add", "-A"]);
  run("git", ["-C", w.dir, "commit", "-q", "-m", `${title}\n\nReview comment #${n}: ${c.text}\nGo by ${goer} to the plan: ${w.plan}\n\nCo-Authored-By: Claude <noreply@anthropic.com>`]);
  if (process.env.REVIEW_SHIP_DRY === "1") {
    const files = run("git", ["-C", w.dir, "show", "--stat", "--format=", "HEAD"]);
    dropWork(c.id);
    return `DRY RUN: committed on ${w.branch}, not pushed. Files:\n${files}`;
  }
  run("git", ["-C", w.dir, "push", "-q", "-u", w.remote, w.branch]);
  w.pushed = true;
  prSoon();
  if (w.mode === "followup") {
    dropWork(c.id);
    const fresh = await st.get(c.id);
    applyChange(fresh, { reply: `Updated PR #${fresh.pr.n}: ${summary} New before and after pictures come here in a minute or two.`, via: "claude", prN: fresh.pr.n }, w.by);
    if (fresh.status === "progress") applyChange(fresh, { status: "approval", via: "claude" }, w.by);
    await st.put(fresh);
    return `PR #${fresh.pr.n} updated; #${n} is For approval.`;
  }
  if (c.pr?.draft && c.pr.branch === w.branch && c.pr.state === "open") {
    run("gh", ["pr", "ready", String(c.pr.n), "--repo", gh.repo]);
    run("gh", ["pr", "edit", String(c.pr.n), "--repo", gh.repo, "--title", title]);
    dropWork(c.id);
    return finishGo(c, st, c.pr.n, c.pr.url, summary, w.by);
  }
  const page = c.pageTitle || c.route || "the page";
  const body = [`From review comment #${n} on ${page}${w.sess ? ` (test session ${w.sess})` : ""}: "${c.text}"`, ``, `**The plan, Go by ${goer}:** ${w.plan}`, ``, `**What changed:** ${summary}`, ``, `Made by Claude from the review thread. Claude never merges: the comment is approved in Review mode, and a person merges this.`, ``, `🤖 Generated with [Claude Code](https://claude.com/claude-code)`].join("\n");
  const url = run("gh", ["pr", "create", "--repo", gh.repo, "--base", gh.base, "--head", w.branch, "--title", title, "--body", body]).split("\n").pop();
  const prN = Number(url.match(/\/pull\/(\d+)/)?.[1]);
  dropWork(c.id);
  const fresh = await st.get(c.id);
  applyChange(fresh, { pr: { n: prN, url, branch: w.branch, repo: gh.repo, state: "open", draft: false, for: w.by } }, w.by);
  await st.put(fresh);
  return finishGo(fresh, st, prN, url, summary, w.by);
}
/* the work is in a ready PR: Claude says so, and the comment waits for approval */
async function finishGo(c, st, prN, url, summary, by) {
  const fresh = await st.get(c.id);
  applyChange(fresh, { pr: { n: prN, draft: false } }, by);
  applyChange(fresh, { reply: `Done: ${summary} It's in PR #${prN}${fresh.pr?.preview ? ", the same as the live preview" : "; the live preview and before and after pictures show here in a minute or two"}.`, via: "claude", prN }, by);
  if (fresh.status === "progress") applyChange(fresh, { status: "approval", via: "claude" }, by);
  await st.put(fresh);
  return `PR ${url} is ready; #${(await numbered(c.id, st))?.n} is For approval. A person merges it.`;
}
/* a live preview before Go (Nirav, 2026-11-05): the planned change on a DRAFT PR, so its preview is the real page */
async function previewBuild(c, st, a) {
  const w = works.get(c.id);
  if (!w) throw new Error("No work folder for this comment: a preview comes from a plan with preview, or Show me live");
  if (c.call?.kind === "go") return ship(c, st, { title: a.title, summary: w.plan }); // Go came while you built it: it ships
  const gh = cfg.github;
  if (!run("git", ["-C", w.dir, "status", "--porcelain"])) throw new Error(`Nothing changed in ${w.app}: make the change there first`);
  const n = (await numbered(c.id, st))?.n;
  const title = String(a.title || "").trim().slice(0, 120) || `Review #${n}`;
  run("git", ["-C", w.dir, "add", "-A"]);
  run("git", ["-C", w.dir, "commit", "-q", "-m", `${title}\n\nReview comment #${n}: ${c.text}\nThe plan, before Go: ${w.plan}\n\nCo-Authored-By: Claude <noreply@anthropic.com>`]);
  if (process.env.REVIEW_SHIP_DRY === "1") {
    dropWork(c.id);
    return `DRY RUN: committed on ${w.branch} for a preview, not pushed`;
  }
  run("git", ["-C", w.dir, "push", "-q", "-u", w.remote, w.branch]);
  w.pushed = true;
  prSoon();
  let prN = c.pr?.draft && c.pr.branch === w.branch && c.pr.state === "open" ? c.pr.n : 0, url = prN ? c.pr.url : "";
  if (!prN) {
    const body = [`A live preview of Claude's plan for review comment #${n} (${c.pageTitle || c.route || "the page"}): "${c.text}"`, ``, `**The plan:** ${w.plan}`, ``, `Draft until someone says Go in the review thread. Claude never merges.`, ``, `🤖 Generated with [Claude Code](https://claude.com/claude-code)`].join("\n");
    url = run("gh", ["pr", "create", "--draft", "--repo", gh.repo, "--base", gh.base, "--head", w.branch, "--title", title, "--body", body]).split("\n").pop();
    prN = Number(url.match(/\/pull\/(\d+)/)?.[1]);
  }
  dropWork(c.id);
  const fresh = await st.get(c.id);
  applyChange(fresh, { pr: { n: prN, url, branch: w.branch, repo: gh.repo, state: "open", draft: true, for: w.by, ...(fresh.pr?.n === prN ? {} : {}) } }, w.by);
  if (fresh.pr) Object.assign(fresh.pr, { planAt: fresh.call?.planAt || null, preview: null, previewAt: null, builtAt: Date.now() }); // a new build: its link comes again
  if (fresh.call?.kind === "preview") applyChange(fresh, { callState: "planned" }, w.by);
  await st.put(fresh);
  return `Draft PR ${url}: its live preview shows on the plan in about a minute. The plan waits for Go.`;
}
/* a session that stopped mid-work leaves its folder: at start, work folders untouched for 2 h with nothing changed go */
function sweepWork() {
  if (!GIT_ROOT || !fs.existsSync(WORK_DIR)) return;
  for (const name of fs.readdirSync(WORK_DIR)) {
    const dir = path.join(WORK_DIR, name);
    try {
      if (Date.now() - fs.statSync(dir).mtimeMs < 2 * 3600_000 || run("git", ["-C", dir, "status", "--porcelain"])) continue;
      const branch = run("git", ["-C", dir, "rev-parse", "--abbrev-ref", "HEAD"]);
      const pushed = (() => { try { return !!run("git", ["-C", dir, "ls-remote", "--heads", run("git", ["-C", dir, "config", `branch.${branch}.remote`]) || "origin", branch]); } catch { return false; } })();
      run("git", ["-C", GIT_ROOT, "worktree", "remove", dir]);
      if (!pushed && /^claude\//.test(branch)) run("git", ["-C", GIT_ROOT, "branch", "-D", branch]);
    } catch {}
  }
}
setTimeout(sweepWork, 15_000).unref?.();
/* what GitHub says about each open PR: the preview link (the Preview workflow's comment), merged, closed. Every 45 s,
   and every 10 s while a preview is building (it takes about a minute; Nirav, 2026-11-05: no waiting on our side) */
const PR_EVERY = 45_000, PR_BUILDING = 10_000;
let prBuilding = false;
async function prRound() {
  if (!ready || !cfg.github) return;
  let building = false;
  for (const sess of ["", ...localTests()]) {
    try {
      const st = storeOf(sess);
      for (const c of (await st.list()).filter((x) => x.pr?.n && (!x.pr.state || x.pr.state === "open"))) {
        const repo = c.pr.repo || cfg.github.repo;
        let info;
        try {
          info = JSON.parse(run("gh", ["pr", "view", String(c.pr.n), "--repo", repo, "--json", "state,comments,isDraft,headRefOid"], { timeout: 30_000 }));
        } catch {
          continue;
        }
        /* ready only when the Preview workflow's comment names the branch's latest commit: a rebuilt draft waits for its own */
        const head = String(info.headRefOid || "").slice(0, 7);
        const note = (info.comments || []).map((x) => x.body || "").find((b) => b.includes("<!-- preview-link -->") && /Preview is ready/i.test(b) && (!head || b.includes(head)));
        const base = note?.match(/https:\/\/[^\s|)]+/)?.[0];
        const preview = base ? `${base.replace(/\/+$/, "")}${c.route && c.route.startsWith("/") ? c.route : ""}` : c.pr.preview;
        const state = info.state === "MERGED" ? "merged" : info.state === "CLOSED" ? "closed" : "open";
        if (state === "open" && !note && Date.now() - (c.pr.builtAt || c.pr.at || 0) < 10 * 60_000) building = true; // never fast for a PR with no preview
        if (state === "open" && base && head && c.route && !(c.pics || []).some((p) => p.sha === head) && !snapping.has(c.id) && (snapFails.get(`${c.id}:${head}`) || 0) < 2) picsFor(c.id, sess, base.replace(/\/+$/, ""), head);
        if (preview === c.pr.preview && state === c.pr.state && !!info.isDraft === !!c.pr.draft) continue;
        const full = await st.get(c.id);
        applyChange(full, { pr: { n: c.pr.n, ...(preview ? { preview } : {}), state, draft: !!info.isDraft } }, defaultAs);
        await st.put(full);
      }
    } catch {}
  }
  prBuilding = building;
}
/* BEFORE AND AFTER (step 3, Nirav 2026-11-05): once a preview is built for the branch's latest commit, the same spot on
   staging and on the preview, put on Claude's message (the plan for a draft, "Done" for a PR), then Claude is asked to
   check the after against its plan. Pictures are taken in the background: the PR round does not wait for them */
const snapping = new Set();
const snapFails = new Map(); // "<id>:<sha>" -> tries that failed: twice and it stops trying
const PICS_DIR = path.join(os.homedir(), ".review-mode", "pics");
async function picsFor(id, sess, base, sha, quiet = false) {
  snapping.add(id);
  try {
    const st = storeOf(sess);
    const c = await st.get(id);
    if (!c?.pr?.n) return;
    const staging = (cfg.github?.staging || base.replace(/\/\/pr-\d+\./, "//")).replace(/\/+$/, "");
    if (staging === base) return; // not a pr-N preview: nothing to compare with
    const msg = c.pr.draft ? (c.history || []).find((h) => h.at === c.pr.planAt && h.via === "claude") : [...(c.history || [])].reverse().find((h) => h.via === "claude" && h.note && (h.pr === c.pr.n || (/^Done\b/.test(h.note) && h.at >= (c.pr.at || 0) - 5000))); // older "Done" messages carry no PR number
    if (!msg) return; // the "Done" message comes with the PR: the next round
    const r = await snap({ before: staging + c.route, after: base + c.route, comment: c, login: cfg.previewLogin });
    if (quiet) { // a retake Claude asked for: it gets the pictures back in the tool's answer
      const stem0 = `${c.id}.ba-${sha}`;
      await st.putFile(`${stem0}-before.jpg`, r.before);
      await st.putFile(`${stem0}-after.jpg`, r.after);
      fs.mkdirSync(PICS_DIR, { recursive: true });
      const loc = { before: path.join(PICS_DIR, `${stem0}-before.jpg`), after: path.join(PICS_DIR, `${stem0}-after.jpg`) };
      fs.writeFileSync(loc.before, r.before);
      fs.writeFileSync(loc.after, r.after);
      const full = await st.get(id);
      applyChange(full, { pics: { at: msg.at, sha, before: `${stem0}-before.jpg`, after: `${stem0}-after.jpg`, w: r.w, h: r.h, found: r.found, pr: c.pr.n } }, defaultAs);
      await st.put(full);
      return { found: r.found, local: loc };
    }
    const stem = `${c.id}.ba-${sha}`;
    await st.putFile(`${stem}-before.jpg`, r.before);
    await st.putFile(`${stem}-after.jpg`, r.after);
    fs.mkdirSync(PICS_DIR, { recursive: true });
    const local = { before: path.join(PICS_DIR, `${stem}-before.jpg`), after: path.join(PICS_DIR, `${stem}-after.jpg`) };
    fs.writeFileSync(local.before, r.before);
    fs.writeFileSync(local.after, r.after);
    const full = await st.get(id);
    applyChange(full, { pics: { at: msg.at, sha, before: `${stem}-before.jpg`, after: `${stem}-after.jpg`, w: r.w, h: r.h, found: r.found, pr: c.pr.n } }, defaultAs);
    await st.put(full);
    if (!canHear()) return;
    const n = (await numbered(id, st))?.n;
    send({ method: "notifications/claude/channel", params: { content: [
      `CHECK on review comment #${n} (${id})${sess ? `, TEST SESSION ${sess} (pass session "${sess}" to the review tools)` : ""}: the before and after pictures of the spot are in the thread.`,
      `Your plan: "${msg.note}"`,
      `Read both: before (staging) ${local.before} · after (the preview) ${local.after}${!r.found.before || !r.found.after ? ` (the spot was not found on the ${!r.found.before && !r.found.after ? "two pages" : !r.found.before ? "staging page" : "preview"}: the whole window was taken)` : ""}.`,
      `Then review_checked with id ${id}: ok true when the after shows your plan; nothing true when nothing on screen changes with this plan;`,
      `missed true when the pictures don't show the part you changed at all, and you can't say how to get there. If the spot wasn't found`,
      `or it's in another view (another tab, a customer or "All clients", a drawer), FIRST try review_resnap: the clicks that get there from a`,
      `fresh page load as a signed-in test user (read the code to know them), by their visible words, and the words of the spot; then check those.`,
      `ok false with text (what you see that is wrong, in design words, one or two sentences) and 2 or 3 options when it doesn't. Then carry on.`,
    ].join("\n"), meta: { kind: "check", comment: String(n), project: String(store.project), ...(sess ? { session: sess } : {}) } } });
  } catch (e) {
    snapFails.set(`${id}:${sha}`, (snapFails.get(`${id}:${sha}`) || 0) + 1);
    process.stderr.write(`[review] before and after for ${id}: ${String(e?.message || e).split("\n")[0]}\n`);
  } finally {
    snapping.delete(id);
  }
}
/* a building preview right after a push: the next round soon, not in 45 s */
const prSoon = () => { prBuilding = true; };
(function prLoop() {
  setTimeout(async () => {
    await prRound().catch(() => {});
    prLoop();
  }, prBuilding ? PR_BUILDING : PR_EVERY).unref?.();
})();

/* ---------- MCP over stdio ---------- */
const send = (msg) => process.stdout.write(JSON.stringify({ jsonrpc: "2.0", ...msg }) + "\n");
const INSTRUCTIONS = `Review mode (design-review comments on this project's running app). Use the review_* tools to list, read, pick up, finish and answer comments, acting as the person you work for (pass "as" with their GitHub handle; default ${defaultAs}). A comment's source (review_show) is the file and line its element is written at: start there. Briefs sent from the drawer arrive as <channel source="review" delivery_id="...">: call review_ack with the delivery_id first, then follow the brief. Requests to draft (kind="draft") ask only for review_suggest: read the code, leave the suggestion, change nothing, then carry on. A call (kind="call") is someone writing @Claude on a comment: read first, then answer it with review_talk (answer, ask, draft, or plan for a change), change nothing, then carry on. A go call (kind="go") is a person's Go to your plan: make the change only in the work folder it names, then review_ship. Ask the person before review_done. Never approve.`;
let buf = "";
let queue = Promise.resolve(); // tool calls, one after another
process.stdin.setEncoding("utf8");
process.stdin.on("data", (chunk) => {
  buf += chunk;
  let i;
  while ((i = buf.indexOf("\n")) >= 0) {
    const raw = buf.slice(0, i).trim();
    buf = buf.slice(i + 1);
    if (raw) handle(raw);
  }
});
process.stdin.on("end", () => process.exit(0));
async function handle(raw) {
  let m;
  try {
    m = JSON.parse(raw);
  } catch {
    return;
  }
  if (m.method === "initialize")
    return send({
      id: m.id,
      result: {
        protocolVersion: m.params?.protocolVersion || "2025-06-18",
        capabilities: { tools: {}, experimental: { "claude/channel": {} } },
        serverInfo: { name: "review", version: "1.0.0" },
        instructions: INSTRUCTIONS,
      },
    });
  if (m.method === "notifications/initialized") {
    ready = true;
    setTimeout(draftRound, 5000); // a first round soon after the session opens: comments made while none was open
    setTimeout(callRound, 2000);
    setTimeout(prRound, 8000);
    return;
  }
  if (m.method === "ping") return send({ id: m.id, result: {} });
  if (m.method === "tools/list") return send({ id: m.id, result: { tools: TOOLS } });
  if (m.method === "tools/call") {
    /* one at a time: two moves on one comment (Claude may call tools together) must not both read it before either
       writes, or a second pick-up would slip past the "already picked up" check */
    const run = queue.then(() => call(m.params?.name, m.params?.arguments || {}));
    queue = run.catch(() => {});
    try {
      const text = await run;
      return send({ id: m.id, result: { content: [{ type: "text", text }] } });
    } catch (e) {
      return send({ id: m.id, result: { content: [{ type: "text", text: String(e.message || e) }], isError: true } });
    }
  }
  if (m.id !== undefined && m.method) send({ id: m.id, error: { code: -32601, message: `Method not found: ${m.method}` } });
}

/* ---------- the local endpoint for "Send to Claude" ---------- */
const label = `${path.basename(ROOT)} · ${new Date(startedAt).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", second: "2-digit" })}`; // seconds: two sessions started in one minute stay apart
function allowed(req, port) {
  const origin = req.headers.origin;
  if (origin && !/^(chrome|moz)-extension:\/\//.test(origin)) return false; // a web page: never
  if (req.headers["x-review"] !== "1") return false; // a custom header: pages cannot send it without asking first
  const host = String(req.headers.host || "");
  return host === `127.0.0.1:${port}` || host === `localhost:${port}`; // no DNS rebinding
}
function listen(port) {
  if (port > PORTS[1]) return;
  const srv = http.createServer(async (req, res) => {
    const out = (code, body) => {
      res.writeHead(code, { "Content-Type": "application/json" });
      res.end(JSON.stringify(body));
    };
    if (!allowed(req, port)) return out(403, { error: "forbidden" });
    const url = new URL(req.url, "http://x");
    if (req.method === "GET" && url.pathname === "/hello") return out(200, { app: "review-mode", project: store.project, cwd: ROOT, label, startedAt, pid: process.pid, as: defaultAs });
    if (req.method === "GET" && url.pathname === "/status") return out(200, { acked: !!deliveries.get(url.searchParams.get("id"))?.acked });
    if (req.method === "POST" && url.pathname === "/send") {
      let body = "";
      for await (const ch of req) body += ch;
      let data;
      try {
        data = JSON.parse(body);
      } catch {
        return out(400, { error: "bad json" });
      }
      const text = String(data.text || "").slice(0, 200_000);
      if (!text.trim()) return out(400, { error: "empty" });
      const id = Math.random().toString(36).slice(2, 8);
      deliveries.set(id, { at: Date.now(), acked: 0 });
      send({ method: "notifications/claude/channel", params: { content: text, meta: { delivery_id: id, comments: String(data.count || ""), project: String(store.project) } } });
      return out(200, { ok: true, id });
    }
    return out(404, { error: "unknown" });
  });
  srv.on("error", () => listen(port + 1)); // taken by another session: the next one
  srv.listen(port, "127.0.0.1");
}
listen(PORTS[0]);
