#!/usr/bin/env node
// The review from the command line, in any project that installed review-mode. Always "npx --no review-mode":
// a bare "npx review" can fetch an unrelated npm package of that name.
//   npx --no review-mode init                       set this project up (review.config.json, .review/vite.config.js, the dev:review
//                                         script, git-ignore lines, the Claude skill)
//   npx --no review-mode list                       every comment of the project, one line each
//   npx --no review-mode show <id>                  one comment as JSON
//   npx --no review-mode claude [claude args…]   start Claude with the review tools and "Send to Claude" on (registers them once)
//   npx --no review-mode claude --setup          only register the review tools for this project (no start)
//   npx --no review-mode status <id> <status> [note…]   open | progress | approval | approved
//   flags anywhere: --as <github-handle> (who acts; else REVIEW_AS, else git's user.name), --claude (made with Claude),
//   --force (pick up one someone else has); list also takes --open (no approved) and --mine
//   npx --no review-mode reply <id> <text…>         answer a question (or follow it up); --claude marks Claude's answer
//   npx --no review-mode resolve <id>               close a question (the asker's Got it)
//   npx --no review-mode pull <id> [<id>…]          the full pictures to .review/sessions/<project>/export/
// The project and the hub come from review.config.json (REVIEW_PROJECT overrides the project).
import fs from "node:fs";
import path from "node:path";
import { execSync, spawnSync, spawn } from "node:child_process";
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
const SETUP_ONLY = flag("--setup");
const [cmd, ...args] = argv;
const cfg = loadConfig(process.cwd());

if (cmd === "claude") {
  /* ONE START COMMAND (Nirav, 2026-10-26: "they don't have to set up every time"): find the app (here, above, or in a
     folder below for a monorepo), register the review MCP server for this folder once (Claude Code's local scope: in
     your own settings, nothing in the repo), then start Claude with push on. --setup only registers. */
  const here = process.cwd();
  const findApp = () => {
    const up = loadConfig(here).root;
    if (fs.existsSync(path.join(up, "review.config.json"))) return up;
    const queue = [[here, 0]];
    while (queue.length) {
      const [dir, d] = queue.shift();
      if (fs.existsSync(path.join(dir, "review.config.json"))) return dir;
      if (d >= 4) continue;
      let entries = [];
      try {
        entries = fs.readdirSync(dir, { withFileTypes: true });
      } catch {}
      for (const e of entries) if (e.isDirectory() && !/^(node_modules|\.git|dist|build|\.review|\.next)$/.test(e.name) && !e.name.startsWith(".")) queue.push([path.join(dir, e.name), d + 1]);
    }
    return null;
  };
  const app = findApp();
  if (!app) {
    console.error("No Review mode project here or below (no review.config.json). Set one up first: npx review init");
    process.exit(1);
  }
  /* the server's command: the app's own copy of the package, so it stays put */
  const own = path.join(app, "node_modules", "review-mode", "cli", "review.mjs");
  const cliPath = fs.existsSync(own) ? own : fs.realpathSync(new URL(import.meta.url).pathname);
  const claudeOk = spawnSync("claude", ["--version"], { stdio: "ignore" }).status === 0;
  if (!claudeOk) {
    console.error("Claude Code is not installed here: https://claude.com/claude-code");
    process.exit(1);
  }
  const got = spawnSync("claude", ["mcp", "get", "review"], { cwd: here, encoding: "utf8" });
  const has = got.status === 0 && got.stdout.includes(cliPath) && got.stdout.includes(app);
  if (!has) {
    if (got.status === 0) spawnSync("claude", ["mcp", "remove", "review", "--scope", "local"], { cwd: here, stdio: "ignore" });
    const add = spawnSync("claude", ["mcp", "add", "review", "--scope", "local", "-e", `REVIEW_ROOT=${app}`, "--", "node", cliPath, "mcp"], { cwd: here, encoding: "utf8" });
    if (add.status !== 0) {
      console.error(`Could not register the review tools: ${(add.stderr || add.stdout || "").trim()}`);
      process.exit(1);
    }
    console.log(`Review tools registered for ${here} (your own Claude settings, nothing in the repo).`);
  } else if (SETUP_ONLY) console.log(`Review tools already registered for ${here}.`);
  if (SETUP_ONLY) process.exit(0);
  console.log(`Starting Claude with "Send to Claude" on (project ${loadConfig(app).project}). Claude Code shows a one-time warning for this preview feature: choose "I am using this for local development".`);
  const child = spawn("claude", ["--dangerously-load-development-channels", "server:review", ...args], { cwd: here, stdio: "inherit" });
  child.on("exit", (code) => process.exit(code ?? 0));
  await new Promise(() => {});
} else if (cmd === "mcp") {
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
  mcp.mcpServers = { ...(mcp.mcpServers || {}), review: { command: "npx", args: ["--no", "review-mode", "mcp"] } }; // never the unrelated "review" on npm
  fs.writeFileSync(mcpPath, JSON.stringify(mcp, null, 2) + "\n");
  console.log(`review mode set up for "${project}" in ${root}:\n  review.config.json, .review/vite.config.js, the dev:review script, .gitignore lines, .claude/skills/review/SKILL.md, .mcp.json (review)\n  Claude: start it with  npx --no review-mode claude  (the review tools, and "Send to Claude" from the drawer)\n  start: npm run dev:review  (http://localhost:${Number(JSON.parse(fs.readFileSync(confPath, "utf8")).port) || 4178})`);
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
