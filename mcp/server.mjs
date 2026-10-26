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
import { execSync } from "node:child_process";
import { loadConfig } from "../collector/config.js";
import { storeFor, prepare } from "../collector/stores.js";
import { withNames, applyChange, mergePeople } from "../hub-core.js";

/* REVIEW_ROOT: the app's folder when Claude starts higher up (a monorepo root); else where Claude started */
const ROOT = process.env.REVIEW_ROOT ? path.resolve(process.env.REVIEW_ROOT) : process.cwd();
const cfg = loadConfig(ROOT);
const store = storeFor(cfg, new Map(), process.env.REVIEW_SESSION);
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
  { name: "review_show", description: "One comment in full: page, element, how to get there, the history and, for a question, the conversation.", inputSchema: { type: "object", properties: { id: { type: "string" } }, required: ["id"] } },
  { name: "review_pick_up", description: "Start on a comment (In progress, as the person, made with Claude). Refused when someone else already has it: leave it and tell the person. Not for questions (answer them).", inputSchema: { type: "object", properties: { id: { type: "string" }, ...asProp }, required: ["id"] } },
  { name: "review_done", description: "Set a comment for approval. ONLY after the person said yes in the chat to marking it done. Never approves.", inputSchema: { type: "object", properties: { id: { type: "string" }, ...asProp }, required: ["id"] } },
  { name: "review_reply", description: "Answer a question (one or two plain sentences, from the code it points at). If something should change, say so; the asker can make it a fix.", inputSchema: { type: "object", properties: { id: { type: "string" }, text: { type: "string" }, ...asProp }, required: ["id", "text"] } },
  { name: "review_picture", description: "Save a comment's picture (the element boxed, its number on it) and return the file path to Read.", inputSchema: { type: "object", properties: { id: { type: "string" } }, required: ["id"] } },
  { name: "review_ack", description: "Call first when a <channel source=\"review\"> brief arrives, with its delivery_id, so the drawer shows that you have it.", inputSchema: { type: "object", properties: { delivery_id: { type: "string" } }, required: ["delivery_id"] } },
];
const line = (c) => `#${c.n} ${c.id} ${c.status} ${kind(c.severity)}${holder(c) ? ` [${holder(c)}${c.withClaude ? " + Claude" : ""}]` : ""}: ${c.text}${c.note?.text ? ` [note: ${c.note.text}]` : ""}`;
async function numbered(id) {
  return prepare(await store.list()).find((x) => x.id === id);
}
async function call(name, a = {}) {
  const who = a.as || defaultAs;
  const ppl = await people();
  if (name === "review_list") {
    const all = prepare(await store.list());
    const list = all.filter((c) => (a.open === false || c.status !== "approved") && (!a.mine || holder(c) === who)).map((c) => withNames(c, ppl));
    return list.length ? `${list.length} comment${list.length === 1 ? "" : "s"} on ${store.project}:\n${list.map(line).join("\n")}` : "No comments.";
  }
  const c = a.id ? await store.get(a.id) : null;
  if (name !== "review_ack" && name !== "review_list" && !c) throw new Error(`No comment with id ${a.id}`);
  if (name === "review_show") return JSON.stringify({ ...withNames(c, ppl), n: (await numbered(c.id))?.n }, null, 2);
  if (name === "review_pick_up") {
    if (kind(c.severity) === "question") throw new Error("This is a question: answer it with review_reply");
    if (c.status === "progress" && c.assignee && c.assignee !== who) throw new Error(`Already picked up by ${withNames(c, ppl).assignee}: leave it and tell the person`);
    applyChange(c, { status: "progress", via: "claude" }, who);
    await store.put(c);
    return `Picked up: ${line({ ...withNames(c, ppl), n: (await numbered(c.id))?.n })}`;
  }
  if (name === "review_done") {
    if (kind(c.severity) === "question") throw new Error("This is a question: answer it with review_reply");
    applyChange(c, { status: "approval", via: "claude" }, who);
    await store.put(c);
    return `For approval: ${line({ ...withNames(c, ppl), n: (await numbered(c.id))?.n })}`;
  }
  if (name === "review_reply") {
    applyChange(c, { reply: String(a.text || ""), via: "claude" }, who);
    await store.put(c);
    return `Answered #${(await numbered(c.id))?.n}`;
  }
  if (name === "review_picture") {
    if (!c.shot) return "This comment has no picture.";
    const bytes = await store.shot(c.shot);
    const dir = path.join(cfg.sessionsDir, cfg.project, "export");
    fs.mkdirSync(dir, { recursive: true });
    const n = (await numbered(c.id))?.n || 0;
    const file = path.join(dir, `${String(n).padStart(2, "0")}-${c.id}.png`);
    fs.writeFileSync(file, bytes);
    return file;
  }
  if (name === "review_ack") {
    const d = deliveries.get(a.delivery_id);
    if (d) d.acked = Date.now();
    return "Thanks: the drawer shows you have it.";
  }
  throw new Error(`Unknown tool ${name}`);
}

/* ---------- MCP over stdio ---------- */
const send = (msg) => process.stdout.write(JSON.stringify({ jsonrpc: "2.0", ...msg }) + "\n");
const INSTRUCTIONS = `Review mode (design-review comments on this project's running app). Use the review_* tools to list, read, pick up, finish and answer comments, acting as the person you work for (pass "as" with their GitHub handle; default ${defaultAs}). A comment's source (review_show) is the file and line its element is written at: start there. Briefs sent from the drawer arrive as <channel source="review" delivery_id="...">: call review_ack with the delivery_id first, then follow the brief. Ask the person before review_done. Never approve.`;
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
