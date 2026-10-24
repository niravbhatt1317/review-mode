#!/usr/bin/env node
// The review from the command line, in any project that installed review-mode:
//   npx review init                       set this project up (review.config.json, .review/vite.config.js, the dev:review
//                                         script, git-ignore lines, the Claude skill)
//   npx review list                       every comment of the project, one line each
//   npx review show <id>                  one comment as JSON
//   npx review status <id> <status> [note…]   open | progress | approval | approved
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

const [cmd, ...args] = process.argv.slice(2);
const cfg = loadConfig(process.cwd());

if (cmd === "init") {
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
  console.log(`review mode set up for "${project}" in ${root}:\n  review.config.json, .review/vite.config.js, the dev:review script, .gitignore lines, .claude/skills/review/SKILL.md\n  start: npm run dev:review  (http://localhost:${Number(JSON.parse(fs.readFileSync(confPath, "utf8")).port) || 4178})`);
  process.exit(0);
}

const store = storeFor(cfg, new Map(), process.env.REVIEW_SESSION);
let who = "";
try {
  who = execSync("git config user.name", { stdio: ["ignore", "pipe", "ignore"] }).toString().trim();
} catch {}
const people = mergePeople(cfg.people, store.kind === "hub" ? await store.people().catch(() => ({})) : {});
const kind = (k) => (k === "question" || k === "idea" ? "question" : "fix"); // the old four read as the two kinds
const QSTATUS = { open: "asked", progress: "asked", approval: "answered", approved: "resolved" }; // a question's words for the same states
const noteWord = (c) => (c.note?.kind === "reply" ? (c.note.via === "claude" ? "Claude answered" : c.note.by === c.by ? "followed up" : "answered") : c.note?.to === "open" ? "put back" : "sent back");
const line = (c) => `${String(c.n).padStart(3)}  ${c.id}  ${(kind(c.severity) === "question" ? QSTATUS[c.status] : c.status).padEnd(8)}  ${kind(c.severity).padEnd(8)}  ${c.text}${c.note?.text ? `  [${noteWord(c)}: ${c.note.text}]` : ""}`;

if (cmd === "list" || !cmd) {
  const list = prepare(await store.list()).map((c) => withNames(c, people));
  console.log(`${cfg.project}${store.kind === "hub" ? " (hub)" : " (local)"}: ${list.length} comments`);
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
  applyChange(c, { status, note: note.join(" ") }, who || "cli");
  await store.put(c);
  console.log(line({ ...withNames(c, people), n: prepare(await store.list()).find((x) => x.id === id)?.n }));
} else if (cmd === "reply") {
  const claude = args.includes("--claude");
  const [id, ...words] = args.filter((a) => a !== "--claude");
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
  console.error("review init [project] | list | show <id> | status <id> <status> [note] | reply <id> <text…> [--claude] | resolve <id> | pull <id…>");
  process.exit(1);
}
