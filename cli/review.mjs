#!/usr/bin/env node
// The review from the command line, in any project that installed review-mode:
//   npx review init                       set this project up (review.config.json, .review/vite.config.js, the dev:review
//                                         script, git-ignore lines, the Claude skill)
//   npx review list                       every comment of the project, one line each
//   npx review show <id>                  one comment as JSON
//   npx review status <id> <status> [note…]   open | progress | approval | approved
//   flags anywhere: --as <github-handle> (who acts; else REVIEW_AS, else git's user.name), --claude (made with Claude),
//   --force (pick up one someone else has); list also takes --open (no approved) and --mine
//   npx review reply <id> <text…>         answer a question (or follow it up); --claude marks Claude's answer
//   npx review resolve <id>               close a question (the asker's Got it)
//   npx review pull <id> [<id>…]          the full pictures to .review/sessions/<project>/export/
// The project and the hub come from review.config.json (REVIEW_PROJECT overrides the project).
import fs from "node:fs";
import path from "node:path";
import { execSync } from "node:child_process";
import { loadConfig, pkgDir } from "../collector/config.js";
import { storeFor, prepare } from "../collector/stores.js";
import { withNames, applyChange, mergePeople } from "../hub-core.js";

/* flags, anywhere on the line (2026-10-26): --as <handle>, --claude, --force, --open, --mine */
const argv = process.argv.slice(2);
const flag = (name) => {
  const i = argv.indexOf(name);
  if (i < 0) return false;
  argv.splice(i, 1);
  return true;
};
const flagValue = (name) => {
  const i = argv.indexOf(name);
  if (i < 0) return null;
  const v = argv[i + 1];
  argv.splice(i, 2);
  return v;
};
const AS = flagValue("--as");
const CLAUDE = flag("--claude");
const FORCE = flag("--force");
const ONLY_OPEN = flag("--open");
const MINE = flag("--mine");
const [cmd, ...args] = argv;
const cfg = loadConfig(process.cwd());

if (cmd === "mcp") {
  /* the MCP server Claude Code starts from .mcp.json (tools, and "Send to Claude" when channels are on) */
  await import("../mcp/server.mjs");
  await new Promise(() => {}); // it runs until Claude Code closes it; nothing below is for it
} else if (cmd === "init") {
  const root = cfg.root;
  const pkgPath = path.join(root, "package.json");
  const pkg = fs.existsSync(pkgPath) ? JSON.parse(fs.readFileSync(pkgPath, "utf8")) : {};
  const project = args[0] || cfg.project;
  const confPath = path.join(root, "review.config.json");
  if (!fs.existsSync(confPath)) fs.writeFileSync(confPath, JSON.stringify({ project, port: 4178 }, null, 2) + "\n");
  fs.mkdirSync(path.join(root, ".review"), { recursive: true });
  const vitePath = path.join(root, ".review", "vite.config.js");
  if (!fs.existsSync(vitePath)) {
    const hasVite = fs.existsSync(path.join(root, "vite.config.js")) || fs.existsSync(path.join(root, "vite.config.ts")) || fs.existsSync(path.join(root, "vite.config.mjs"));
    const baseImport = hasVite ? `import base from "../vite.config${fs.existsSync(path.join(root, "vite.config.ts")) ? ".ts" : fs.existsSync(path.join(root, "vite.config.mjs")) ? ".mjs" : ".js"}";` : `const base = {}; // no vite config of its own: a plain Vite server on this folder`;
    fs.writeFileSync(vitePath, `// Review mode: the normal dev server plus the comment overlay and its collector (npm run dev:review).\n// Everything else is the ordinary vite config, untouched.\nimport { withReview } from "review-mode/collector/vite.js";\n${baseImport}\n\nexport default withReview(base);\n`);
  }
  pkg.scripts = pkg.scripts || {};
  if (!pkg.scripts["dev:review"]) pkg.scripts["dev:review"] = "vite --config .review/vite.config.js";
  fs.writeFileSync(pkgPath, JSON.stringify(pkg, null, 2) + "\n");
  const gi = path.join(root, ".gitignore");
  const lines = fs.existsSync(gi) ? fs.readFileSync(gi, "utf8") : "";
  const add = [".review/sessions/", ".review/.cache/", ".review/hub.local.json"].filter((l) => !lines.split("\n").includes(l));
  if (add.length) fs.writeFileSync(gi, lines.replace(/\n?$/, "\n") + "# review mode: comments, pictures and local overrides stay on each machine\n" + add.join("\n") + "\n");
  const skillDir = path.join(root, ".claude", "skills", "review");
  fs.mkdirSync(skillDir, { recursive: true });
  fs.copyFileSync(path.join(pkgDir, "skill", "SKILL.md"), path.join(skillDir, "SKILL.md"));
  /* the MCP server for Claude Code: the review tools, and "Send to Claude" (2026-10-26); an existing .mcp.json keeps its other servers */
  const mcpPath = path.join(root, ".mcp.json");
  const mcp = fs.existsSync(mcpPath) ? JSON.parse(fs.readFileSync(mcpPath, "utf8")) : {};
  mcp.mcpServers = { ...(mcp.mcpServers || {}), review: { command: "npx", args: ["review", "mcp"] } };
  fs.writeFileSync(mcpPath, JSON.stringify(mcp, null, 2) + "\n");
  console.log(`review mode set up for "${project}" in ${root}:\n  review.config.json, .review/vite.config.js, the dev:review script, .gitignore lines, .claude/skills/review/SKILL.md, .mcp.json (review)\n  start: npm run dev:review  (http://localhost:${Number(JSON.parse(fs.readFileSync(confPath, "utf8")).port) || 4178})`);
  process.exit(0);
}

const store = storeFor(cfg, new Map(), process.env.REVIEW_SESSION);
/* who acts: the GitHub handle the drawer knows (--as, or REVIEW_AS), else git's name as before */
let who = AS || process.env.REVIEW_AS || "";
if (!who)
  try {
    who = execSync("git config user.name", { stdio: ["ignore", "pipe", "ignore"] }).toString().trim();
  } catch {}
const people = mergePeople(cfg.people, store.kind === "hub" ? await store.people().catch(() => ({})) : {});
const kind = (k) => (k === "question" || k === "idea" ? "question" : "fix"); // the old four read as the two kinds
const QSTATUS = { open: "asked", progress: "asked", approval: "answered", approved: "resolved" }; // a question's words for the same states
const noteWord = (c) => (c.note?.kind === "reply" ? (c.note.via === "claude" ? "Claude answered" : c.note.by === c.by ? "followed up" : "answered") : c.note?.to === "open" ? "put back" : "sent back");
const holder = (c) => (c.status === "progress" ? c.assignee : c.status === "approval" ? c.doneBy : null); // who has it now
const line = (c) => `${String(c.n).padStart(3)}  ${c.id}  ${(kind(c.severity) === "question" ? QSTATUS[c.status] : c.status).padEnd(8)}  ${kind(c.severity).padEnd(8)}  ${holder(c) ? `[${holder(c)}${c.withClaude ? " + Claude" : ""}] ` : ""}${c.text}${c.note?.text ? `  [${noteWord(c)}: ${c.note.text}]` : ""}`;

if (cmd === "list" || !cmd) {
  const all = prepare(await store.list());
  const mineToo = (c) => (c.status === "progress" && c.assignee === who) || (c.status === "approval" && c.doneBy === who); // the ones you have now
  const list = all.filter((c) => (!ONLY_OPEN || c.status !== "approved") && (!MINE || mineToo(c))).map((c) => withNames(c, people));
  console.log(`${cfg.project}${store.kind === "hub" ? " (hub)" : " (local)"}: ${list.length} comment${list.length === 1 ? "" : "s"}${ONLY_OPEN ? " open" : ""}${MINE ? ` for ${who}` : ""}`);
  for (const c of list) console.log(line(c));
} else if (cmd === "show") {
  const c = await store.get(args[0]);
  if (!c) throw new Error("no such comment");
  console.log(JSON.stringify(withNames(c, people), null, 2));
} else if (cmd === "status") {
  const [id, status, ...note] = args;
  if (!["open", "progress", "approval", "approved"].includes(status)) throw new Error("status: open | progress | approval | approved");
  const c = await store.get(id);
  if (!c) throw new Error("no such comment");
  /* someone else has it: say so, do not take it over (the hub would refuse a late pick-up too) */
  if (status === "progress" && c.status === "progress" && c.assignee && c.assignee !== who && !FORCE) {
    console.error(`Already picked up by ${withNames(c, people).assignee}: leave it, or ask them (--force takes it over)`);
    process.exit(2);
  }
  if ((c.severity === "question" || c.severity === "idea") && status !== "approved" && status !== "open") {
    console.error(`#${id} is a question: answer it with  npx review reply ${id} --claude "<answer>"`);
    process.exit(2);
  }
  applyChange(c, { status, note: note.join(" "), ...(CLAUDE ? { via: "claude" } : {}) }, who || "cli");
  await store.put(c);
  console.log(line({ ...withNames(c, people), n: prepare(await store.list()).find((x) => x.id === id)?.n }));
} else if (cmd === "reply") {
  const claude = CLAUDE;
  const [id, ...words] = args;
  if (!words.join(" ").trim()) throw new Error("reply <id> <text…>");
  const c = await store.get(id);
  if (!c) throw new Error("no such comment");
  applyChange(c, { reply: words.join(" "), ...(claude ? { via: "claude" } : {}) }, who || "cli");
  await store.put(c);
  console.log(line({ ...withNames(c, people), n: prepare(await store.list()).find((x) => x.id === id)?.n }));
} else if (cmd === "resolve") {
  const c = await store.get(args[0]);
  if (!c) throw new Error("no such comment");
  applyChange(c, { status: "approved" }, who || "cli");
  await store.put(c);
  console.log(line({ ...withNames(c, people), n: prepare(await store.list()).find((x) => x.id === args[0])?.n }));
} else if (cmd === "pull") {
  const list = prepare(await store.list());
  const dir = path.join(cfg.sessionsDir, cfg.project, "export");
  fs.mkdirSync(dir, { recursive: true });
  for (const id of args) {
    const c = list.find((x) => x.id === id);
    if (!c?.shot) {
      console.log(`${id}: no picture`);
      continue;
    }
    const bytes = await store.shot(c.shot);
    const file = path.join(dir, `${String(c.n).padStart(2, "0")}-${id}.png`);
    fs.writeFileSync(file, bytes);
    console.log(path.relative(process.cwd(), file));
  }
} else {
  console.error("review init [project] | list [--open] [--mine] | show <id> | status <id> <status> [note] | reply <id> <text…> | resolve <id> | pull <id…>   flags: --as <handle> --claude --force");
  process.exit(1);
}
