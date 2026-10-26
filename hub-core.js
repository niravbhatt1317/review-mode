// The review's rules and its hub client, shared by the collector (Node, .review/plugin.js through .review/hub.js)
// and the extension (the browser, background.js). No Node and no browser globals beyond fetch, so both can import it.
//
// The hub is Supabase: one row per comment in review_comments (the record as JSON plus the columns the hub sorts and
// sweeps by), the pictures in the private bucket review-shots at <project>/<id>.png and <project>/<id>.t.jpg.

export const STATUSES = ["open", "progress", "approval", "approved"];
const BUCKET = "review-shots";
export const RETENTION_DAYS = 14;
export const DRAFT_CLAIM_MS = 10 * 60 * 1000; // a session's claim on drafting a comment, before another may try
/* a comment a session may (re)draft: none yet, an answer to Claude's question waiting, or a claim that lapsed */
export const draftOpen = (d) => !d || d.state === "reply" || (d.state === "drafting" && Date.now() - (d.at || 0) > DRAFT_CLAIM_MS);

/* sentence case: the first letter capital, the rest as typed (Nirav, 2026-10-19) */
export const sentence = (t) => {
  const s = String(t ?? "").trim();
  return s ? s[0].toUpperCase() + s.slice(1) : s;
};
/* the status and its mirror kept in step: older comments carry only `resolved` */
export function normalise(c) {
  if (!STATUSES.includes(c.status)) c.status = c.resolved ? "approved" : "open";
  c.resolved = c.status === "approved";
  return c;
}
/* the number is the position: 1 to N in order of creation, open and resolved alike; a removal shifts the rest up.
   Identity is the id. Pictures carry no number: the overlay draws it live, so renumbering costs nothing. */
export function numbered(list) {
  list.sort((a, b) => (a.ts || 0) - (b.ts || 0));
  list.forEach((c, i) => (c.n = i + 1));
  return list;
}
/* the same tidy-up for a list from anywhere */
export function prepare(list) {
  for (const c of list) {
    c.text = sentence(c.text);
    normalise(c);
  }
  return numbered(list);
}
/* a short fingerprint of a list's text: the drawer sends back the last one it saw, and an unchanged list answers
   { same: true } instead of every comment again (Nirav, 2026-10-25: the data sent on every refresh) */
export function sigOf(text) {
  let h = 2166136261;
  for (let i = 0; i < text.length; i++) {
    h ^= text.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return (h >>> 0).toString(36) + text.length.toString(36);
}
/* THE LIGHT LIST (Nirav, 2026-10-25): what the drawer needs up front. The people's pictures leave each comment (they
   come once, as a map); of the app snapshot only the short entries stay (go-to reads two flags); approved comments are
   counted, not sent, unless asked for. Measured on the test session: the pictures and the snapshot were 90 % of it. */
export function lightList(list, { approved = false } = {}) {
  const small = (app) => {
    if (!app || typeof app !== "object") return undefined;
    const out = {};
    for (const [k, v] of Object.entries(app)) if (JSON.stringify(v ?? "").length <= 80) out[k] = v;
    return out;
  };
  const pick = list.filter((c) => (approved ? c.status === "approved" : c.status !== "approved"));
  return { list: pick.map(({ avatars, app, ...c }) => ({ ...c, ...(app ? { app: small(app) } : {}) })), doneCount: list.filter((c) => c.status === "approved").length };
}
/* the people's pictures by the name shown, once per answer */
export function facesOf(people = {}) {
  const out = {};
  for (const p of Object.values(people)) if (p?.name && p.avatar) out[p.name] = p.avatar;
  return out;
}
/* SEND TO CLAUDE (2026-10-26): the open Claude Code sessions with the review MCP server listen on 127.0.0.1:47831-47840
   (mcp/server.mjs); the dev server and the extension find them, and forward a brief to the one picked */
export const CLAUDE_PORTS = Array.from({ length: 10 }, (_, i) => 47831 + i);
export async function claudeSessions(fetchFn = globalThis.fetch, project = null) {
  const found = await Promise.all(
    CLAUDE_PORTS.map(async (port) => {
      try {
        const ctl = new AbortController();
        const t = setTimeout(() => ctl.abort(), 600);
        const r = await fetchFn(`http://127.0.0.1:${port}/hello`, { headers: { "x-review": "1" }, signal: ctl.signal });
        clearTimeout(t);
        const j = r.ok ? await r.json() : null;
        return j?.app === "review-mode" ? { port, ...j } : null;
      } catch {
        return null;
      }
    }),
  );
  const all = found.filter(Boolean);
  const same = project ? all.filter((s) => s.project === project) : all; // this project's first; any if none match
  return (same.length ? same : all).sort((a, b) => b.startedAt - a.startedAt);
}
export async function claudeSend(port, text, count, fetchFn = globalThis.fetch) {
  if (!CLAUDE_PORTS.includes(Number(port))) throw new Error("not a Claude session port");
  const r = await fetchFn(`http://127.0.0.1:${port}/send`, { method: "POST", headers: { "x-review": "1", "Content-Type": "application/json" }, body: JSON.stringify({ text, count }) });
  if (!r.ok) throw new Error(`the session said ${r.status}`);
  return r.json();
}
export async function claudeStatus(port, id, fetchFn = globalThis.fetch) {
  if (!CLAUDE_PORTS.includes(Number(port))) return { acked: false };
  const r = await fetchFn(`http://127.0.0.1:${port}/status?id=${encodeURIComponent(id)}`, { headers: { "x-review": "1" } });
  return r.ok ? r.json() : { acked: false };
}
export const newId = () => `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`;

/* an edit or a move: text, severity, status (with who did it and when), and the note that rides with a move back.
   STATUS: open -> progress (someone picked it up) -> approval (they are done) -> approved (the reviewer accepted).
   "Reopen" and "send back" move it back. A note on a move back stays on the comment through the rework and the
   next For approval, so whoever picks it up sees why it came back and the reviewer can check the change against
   their own ask; it clears on Approve (and stays in history). */
export function applyChange(c, body, who) {
  const { text, severity, status, resolved, note } = body;
  if (typeof text === "string" && text.trim()) c.text = sentence(text);
  const wasQuestion = c.severity === "question" || c.severity === "idea";
  if (["fix", "question", "must", "should", "idea"].includes(severity)) c.severity = severity; // fix and question since 2026-10-23; the old four still accepted
  /* THE QUESTION FLOW (Nirav, 2026-10-24): a question is answered, not worked. Asked (open) -> Answered (approval) ->
     Resolved (approved). A reply from anyone but the asker answers it; a reply from the asker follows up and it is
     Asked again; the asker (or an approver) closes it with Got it. Replies are history steps of kind "reply", so the
     conversation and the history are one list. A question made into a fix starts over as a New fix, its talk kept. */
  if (wasQuestion && (severity === "fix" || severity === "must" || severity === "should") && c.status !== "open") {
    const at = Date.now();
    (c.history ||= []).push({ at, by: who, status: "open", from: c.status, kind: "to_fix" });
    Object.assign(c, { status: "open", assignee: null, pickedAt: null, doneAt: null, approvedAt: null, resolvedAt: null, note: null });
    normalise(c);
  }
  /* CLAUDE DRAFTS FIRST (Nirav, 2026-10-26): a Claude Code session with the review tools reads each new comment's code
     and leaves a short suggestion on it; a person accepts it (a fix: picked up with Claude; a question: posted as the
     answer) or ignores it. "drafting" is the session's claim, so two sessions do not both work on one comment; it
     lapses after DRAFT_CLAIM_MS when nothing came. Data only: the hub's rules see no move until someone accepts. */
  /* "Claude isn't sure" (Nirav, 2026-10-26): Claude's question back is answered on the card ("reply", waiting for a
     session); the next session drafts again with the talk so far (thread: each question and its answer) */
  const thread = c.draft?.thread?.length ? { thread: c.draft.thread } : {};
  if (body.draft === "drafting") {
    if (draftOpen(c.draft)) c.draft = { state: "drafting", at: Date.now(), by: who, ...thread };
  } else if (body.draft && typeof body.draft.text === "string" && body.draft.text.trim()) {
    const isQ = c.severity === "question" || c.severity === "idea";
    c.draft = { state: "new", text: body.draft.text.trim().slice(0, 600), kind: isQ ? "answer" : "fix", at: Date.now(), by: who, via: "claude", ...(body.draft.unsure === true ? { unsure: true } : {}), ...thread };
  }
  const answer = typeof body.draftReply === "string" ? body.draftReply.trim().slice(0, 600) : "";
  if (answer && c.draft?.state === "new" && c.draft.unsure) c.draft = { state: "reply", at: Date.now(), by: who, thread: [...(c.draft.thread || []), { q: c.draft.text, a: answer, by: who, at: Date.now() }] };
  if ((body.draftState === "accepted" || body.draftState === "ignored") && c.draft?.state === "new") Object.assign(c.draft, { state: body.draftState, decidedBy: who, decidedAt: Date.now() });
  if (body.withClaude === true && c.status === "progress") c.withClaude = true; // the person on it handed the work to Claude too
  const reply = typeof body.reply === "string" ? body.reply.trim().slice(0, 1200) : "";
  if (reply) {
    const at = Date.now();
    const from = c.status;
    const claude = body.via === "claude"; // Claude answering (npx review reply): an answer even when run by the asker
    const asker = !claude && !!c.by && who === c.by;
    const isQ = c.severity === "question" || c.severity === "idea";
    const to = !isQ ? from : asker ? "open" : "approval";
    if (to !== from) {
      c.status = to;
      if (to === "approval") Object.assign(c, { doneBy: who, doneAt: at, assignee: null });
      if (to === "open") Object.assign(c, { assignee: null, pickedAt: null, doneAt: null, approvedAt: null, resolvedAt: null });
    } else if (to === "approval") Object.assign(c, { doneBy: who, doneAt: at }); // the latest answer's face on the card
    c.note = { text: reply, by: who, at, from, to, kind: "reply", ...(claude ? { via: "claude" } : {}) };
    (c.history ||= []).push({ at, by: who, status: to, from, kind: "reply", note: reply, ...(claude ? { via: "claude" } : {}) });
    normalise(c);
    c.edited = Date.now();
    return c;
  }
  /* HAND OVER (Nirav, 2026-10-24): the doer passes it on, or the approver assigns it (New or in progress); it moves at
     once and stays in progress, with the new person on it; an optional reason rides along as the card's note */
  if (typeof body.assignTo === "string" && body.assignTo && body.assignTo !== c.assignee) {
    const at = Date.now();
    const from = c.status;
    const words = typeof note === "string" ? note.trim().slice(0, 600) : "";
    Object.assign(c, { status: "progress", assignee: body.assignTo, pickedAt: at, handedBy: who, handedAt: at });
    c.note = { text: words, by: who, at, from, to: "progress", kind: "hand", toWho: body.assignTo };
    (c.history ||= []).push({ at, by: who, status: "progress", from, kind: "hand", toWho: body.assignTo, ...(words ? { note: words } : {}) });
    normalise(c);
    c.edited = Date.now();
    return c;
  }
  const to = STATUSES.includes(status) ? status : typeof resolved === "boolean" ? (resolved ? "approved" : "open") : null;
  if (to && to !== c.status) {
    const at = Date.now();
    const from = c.status;
    c.status = to;
    /* sent back (for approval -> in progress): it goes back to whoever did the work, not to the approver who sent it */
    if (to === "progress") Object.assign(c, from === "approval" ? { assignee: c.doneBy || c.assignee || who, pickedAt: at } : { assignee: who, pickedAt: at });
    if (to === "approval") Object.assign(c, { doneBy: who, doneAt: at });
    if (to === "approved") Object.assign(c, { approvedBy: who, approvedAt: at, resolvedAt: at });
    if (to === "open") Object.assign(c, { assignee: null, pickedAt: null, doneAt: null, approvedAt: null, resolvedAt: null });
    const step = { at, by: who, status: to, from, ...(body.via === "claude" ? { via: "claude" } : {}) };
    /* CLAUDE ON THE CARD (2026-10-26): a move made with Claude (npx review --claude) keeps the mark while the work is
       with that person; it goes when the comment goes back to New or is approved */
    if (to === "progress" || to === "approval") c.withClaude = body.via === "claude" || (to === "approval" && !!c.withClaude && c.doneBy === who);
    else c.withClaude = false;
    /* TAKE BACK (Nirav, 2026-10-24): the doer pulls it back from For approval before the approver acts; the hub's guard
       reads this step's kind to tell it from a send back. No reason asked, and a send-back note riding on it stays */
    const take = body.take === true && from === "approval" && to === "progress";
    if (take) step.kind = "take";
    const back = STATUSES.indexOf(to) < STATUSES.indexOf(from);
    const words = typeof note === "string" ? note.trim().slice(0, 600) : "";
    if (back && words) step.note = words;
    if (back && !take) c.note = words ? { text: words, by: who, at, from, to } : null;
    if (to === "approved") c.note = null;
    (c.history ||= []).push(step);
    normalise(c);
  }
  c.edited = Date.now();
  return c;
}
/* who is who: ids in the data (git handles) shown as people; `people` maps handle -> name. Unknown ones show as is. */
export function withNames(c, people = {}) {
  const find = (id) => people[id] ?? people[Object.keys(people).find((k) => k.toLowerCase() === String(id).toLowerCase())]; // any case
  const name = (id) => (id && (typeof find(id) === "string" ? find(id) : find(id)?.name)) || id;
  const out = { ...c, by: name(c.by), assignee: name(c.assignee), doneBy: name(c.doneBy), approvedBy: name(c.approvedBy) };
  if (c.note) out.note = { ...c.note, by: name(c.note.by), ...(c.note.toWho ? { toWho: name(c.note.toWho) } : {}) };
  if (Array.isArray(c.history)) out.history = c.history.map((h) => ({ ...h, by: name(h.by), ...(h.toWho ? { toWho: name(h.toWho) } : {}) }));
  return out;
}
/* the people shown: the hub's (first word of the GitHub name, the picture) under the team's own map (a chosen name) */
export function mergePeople(teamMap = {}, hubPeople = {}) {
  const out = {};
  for (const [h, p] of Object.entries(hubPeople)) out[h] = { name: String(p.name || h).split(/\s+/)[0], avatar: p.avatar || null };
  /* the team's chosen names win, matched in any case (Nikhil482008 is nikhil482008 in the team's list, 2026-10-26) */
  for (const [h, n] of Object.entries(teamMap)) {
    const twins = Object.keys(out).filter((k) => k.toLowerCase() === h.toLowerCase());
    const avatar = twins.map((k) => out[k].avatar).find(Boolean) || out[h]?.avatar || null;
    out[h] = { name: n, avatar };
    for (const k of twins) out[k] = { name: n, avatar };
  }
  return out;
}
/* the pictures of the people on a comment, keyed by the name shown, for the cards and the pin card */
export function avatarsOf(c, people) {
  const out = {};
  const steps = Array.isArray(c.history) ? c.history.flatMap((s) => [s.by, s.toWho]) : []; // the faces in the card's history too
  for (const h of [c.by, c.assignee, c.doneBy, c.approvedBy, c.note?.by, c.note?.toWho, ...steps]) if (h && people[h]?.avatar) out[people[h].name] = people[h].avatar;
  return out;
}
/* who waits to be let in, with their name and picture when they have signed in */
/* GitHub handles ignore case (Nirav, 2026-10-26: Nikhil482008 waited while nikhil482008 was on the team): the members
   map is keyed in lower case, and every look-up lowers the handle first */
const lc = (h) => String(h || "").toLowerCase();
const personOf = (people, handle) => {
  const k = Object.keys(people).find((x) => lc(x) === lc(handle));
  return k ? { key: k, ...people[k] } : null;
};
export function waitingOf(members = null, people = {}) {
  if (!members) return [];
  return Object.entries(members)
    .filter(([, role]) => role === "waiting")
    .map(([handle]) => {
      const p = personOf(people, handle);
      return { handle: p?.key || handle, name: p?.name || handle, avatar: p?.avatar || null };
    });
}
/* a signed-in person's place: approver, member, waiting or refused; someone not listed yet is waiting (the hub adds
   them as they sign in); with no members table everyone is a member */
export const roleIn = (members, handle) => (!members ? "member" : members[lc(handle)] || "waiting");
export const isApproverIn = (members, handle) => !!members && members[lc(handle)] === "approver";
/* the people a comment can be handed to: the team's map and everyone signed in, without the waiting list */
export function teamOf(people = {}, members = null) {
  return Object.entries(people)
    .filter(([h]) => !members || (members[lc(h)] && members[lc(h)] !== "waiting" && members[lc(h)] !== "refused"))
    .map(([handle, p]) => ({ handle, name: p.name, avatar: p.avatar || null }))
    .filter((p, i, all) => all.findIndex((q) => q.handle.toLowerCase() === p.handle.toLowerCase()) === i) // case twins once
    .sort((a, b) => a.name.localeCompare(b.name));
}
/* a data URL or base64 string to bytes */
export function bytesOf(s) {
  if (!s) return null;
  const b64 = String(s).split(",").pop();
  const bin = atob(b64);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

/* The hub client. `cache` (optional) keeps pictures on disk: { get(file) -> bytes|null, put(file, bytes), drop(file) }.
   Download traffic is the free tier's one real limit, so the list is polled by ids and update times only (about a
   kilobyte) and the full rows are fetched once, cold; after that only the rows whose stamp moved. Our own writes
   answer with the row and keep the held copy warm. */
export function makeHub({ url, key, project, cache = null, fetchFn = globalThis.fetch, bearer = null }) {
  url = String(url).replace(/\/+$/, "");
  /* the key identifies the project; the bearer is the signed-in person's token when there is one (`bearer()`
     returns it, or null), else the key itself (the anonymous role) */
  const auth = async () => ({ apikey: key, Authorization: `Bearer ${(bearer && (await bearer())) || key}` });
  const rest = async (method, q, body, extra = {}) => {
    const r = await fetchFn(`${url}/rest/v1/${q}`, {
      method,
      headers: { ...(await auth()), "Content-Type": "application/json", Prefer: "return=representation", ...extra },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    if (!r.ok) {
      const text = (await r.text()).slice(0, 300);
      /* the hub's own refusal ("Only an approver can approve") is said as it is */
      const body = (() => { try { return JSON.parse(text); } catch { return null; } })();
      const rule = !!body?.message && (body.code === "42501" || /approver|picked up/i.test(body.message)); // one of the hub's own rules (hub/roles.sql)
      const said = rule ? String(body.message).replace(/^Not allowed: (.+)$/, "Not allowed to $1 this comment") : null; // "Not allowed to send back this comment"
      const e = new Error(rule ? said : `hub ${method} ${q.split("?")[0]}: ${r.status} ${text}`);
      e.status = rule ? 403 : r.status;
      throw e;
    }
    const t = await r.text();
    return t ? JSON.parse(t) : null;
  };
  const objectPath = (file) => `${project}/${file}`;
  const upload = async (file, bytes, type) => {
    const r = await fetchFn(`${url}/storage/v1/object/${BUCKET}/${objectPath(file)}`, { method: "POST", headers: { ...(await auth()), "Content-Type": type, "x-upsert": "true" }, body: bytes });
    if (!r.ok) throw new Error(`hub upload ${file}: ${r.status} ${(await r.text()).slice(0, 200)}`);
    cache?.put(file, bytes);
  };
  const removeFiles = async (files) => {
    if (!files.length) return;
    const r = await fetchFn(`${url}/storage/v1/object/${BUCKET}`, { method: "DELETE", headers: { ...(await auth()), "Content-Type": "application/json" }, body: JSON.stringify({ prefixes: files.map(objectPath) }) });
    if (!r.ok) throw new Error(`hub remove: ${r.status} ${(await r.text()).slice(0, 200)}`);
    for (const f of files) cache?.drop(f);
  };
  const unpack = (row) => ({ ...row.data, id: row.id, ts: Number(row.ts), status: row.status, shot: row.shot ? `${row.id}.png` : null, thumb: row.thumb ? `${row.id}.t.jpg` : null });
  const pack = (c) => {
    const { shot, thumb, n, urls, ...data } = c;
    return {
      id: c.id,
      project,
      ts: c.ts,
      status: c.status,
      approved_at: c.status === "approved" && (c.approvedAt || c.resolvedAt) ? new Date(c.approvedAt || c.resolvedAt).toISOString() : null,
      shot: !!shot,
      thumb: !!thumb,
      data,
    };
  };
  let cached = null; // { rows, sig, at }
  const where = `review_comments?project=eq.${encodeURIComponent(project)}`;
  const sigOf = (rows) => rows.map((r) => `${r.id}@${r.updated_at}`).sort().join("|");
  const fresh = () => {
    cached = null;
    lean.answers = {};
  };
  const hold = (row) => {
    lean.answers = {}; // our own write: the next look is fresh
    if (!cached) return;
    const i = cached.rows.findIndex((r) => r.id === row.id);
    if (i < 0) cached.rows.push(row);
    else cached.rows[i] = row;
    cached.rows.sort((a, b) => Number(a.ts) - Number(b.ts));
    cached.sig = sigOf(cached.rows);
    cached.at = Date.now();
  };
  const drop = (id) => {
    lean.answers = {};
    if (!cached) return;
    cached.rows = cached.rows.filter((r) => r.id !== id);
    cached.sig = sigOf(cached.rows);
    cached.at = Date.now();
  };
  let lastSweep = 0;
  const lean = { stamps: null, total: -1, latest: "", open: new Map(), done: new Map(), table: "review_comments_light", answers: {} }; // lightList's own
  return {
    kind: "hub",
    project,
    async list() {
      if (cached && Date.now() - cached.at < 1500) return cached.rows.map(unpack); // the same request asking twice
      const stamps = await rest("GET", `${where}&select=id,updated_at`);
      const sig = sigOf(stamps);
      if (cached && cached.sig === sig) {
        cached.at = Date.now();
        return cached.rows.map(unpack);
      }
      if (!cached) {
        const rows = await rest("GET", `${where}&order=ts.asc`);
        cached = { rows, sig: sigOf(rows), at: Date.now() };
        return rows.map(unpack);
      }
      /* only the difference: the rows whose stamp is new or moved are fetched, the ones no longer listed dropped */
      const held = new Map(cached.rows.map((r) => [r.id, r.updated_at]));
      const changed = stamps.filter((r) => held.get(r.id) !== r.updated_at).map((r) => r.id);
      const listed = new Set(stamps.map((r) => r.id));
      cached.rows = cached.rows.filter((r) => listed.has(r.id));
      if (changed.length) {
        const rows = await rest("GET", `${where}&id=in.(${changed.map(encodeURIComponent).join(",")})`);
        for (const r of rows) {
          const i = cached.rows.findIndex((x) => x.id === r.id);
          if (i < 0) cached.rows.push(r);
          else cached.rows[i] = r;
        }
        cached.rows.sort((a, b) => Number(a.ts) - Number(b.ts));
      }
      cached.sig = sigOf(cached.rows);
      cached.at = Date.now();
      return cached.rows.map(unpack);
    },
    /* THE LIGHT LIST FROM THE HUB (Nirav, 2026-10-25, step 3): what the drawer shows, fetched lean.
       1. One tiny question first: the newest change and the number of rows (about 100 bytes). Only when either moved
          are the ids, times and statuses asked for (numbering and counts come from those).
       2. Only the rows asked for: the open ones, or the approved ones when their view opens; of those only the rows
          that are new or changed; from the light view (hub/light.sql: no app snapshot) when it is there.
       Writes never use these rows: get() reads the full row. */
    async lightList({ approved = false } = {}) {
      /* several tabs on one project ask within moments of each other: one answer serves them all for 2 s */
      const key = approved ? "done" : "open";
      if (lean.answers[key] && Date.now() - lean.answers[key].at < 2000) return lean.answers[key].value;
      const value = await this.lightListFresh({ approved });
      lean.answers[key] = { at: Date.now(), value };
      return value;
    },
    async lightListFresh({ approved = false } = {}) {
      const r = await fetchFn(`${url}/rest/v1/${where}&select=updated_at&order=updated_at.desc&limit=1`, { headers: { ...(await auth()), Prefer: "count=exact" } });
      if (!r.ok) throw new Error(`hub GET review_comments: ${r.status}`);
      const total = Number((r.headers.get("content-range") || "").split("/")[1]) || 0;
      const latest = (await r.json())[0]?.updated_at || "";
      if (!lean.stamps || lean.total !== total) {
        /* a comment came or went: the whole id list again */
        lean.stamps = await rest("GET", `${where}&select=id,updated_at,ts,status&order=ts.asc`);
      } else if (lean.latest !== latest) {
        /* only edits: just the rows changed since the last look */
        const moved = await rest("GET", `${where}&select=id,updated_at,ts,status&updated_at=gt.${encodeURIComponent(lean.latest)}`);
        const known = new Set(lean.stamps.map((st) => st.id));
        if (moved.some((m) => !known.has(m.id))) lean.stamps = await rest("GET", `${where}&select=id,updated_at,ts,status&order=ts.asc`); // one went, one came: the whole list
        else {
          const at = new Map(moved.map((m) => [m.id, m]));
          lean.stamps = lean.stamps.map((st) => at.get(st.id) || st);
        }
      }
      lean.total = total;
      lean.latest = latest;
      const nOf = new Map(lean.stamps.map((s, i) => [s.id, i + 1]));
      const want = lean.stamps.filter((s) => (approved ? s.status === "approved" : s.status !== "approved"));
      const held = approved ? lean.done : lean.open;
      const listed = new Set(want.map((s) => s.id));
      for (const id of [...held.keys()]) if (!listed.has(id)) held.delete(id);
      const need = want.filter((s) => held.get(s.id)?.updated_at !== s.updated_at).map((s) => s.id);
      for (let i = 0; i < need.length; i += 80) {
        const ids = need.slice(i, i + 80).map(encodeURIComponent).join(",");
        let rows;
        try {
          rows = await rest("GET", `${lean.table}?project=eq.${encodeURIComponent(project)}&id=in.(${ids})`);
        } catch (e) {
          if (lean.table === "review_comments") throw e;
          lean.table = "review_comments"; // the light view is not there yet: the table, trimmed here instead
          rows = await rest("GET", `${where}&id=in.(${ids})`);
        }
        for (const row of rows) held.set(row.id, row);
      }
      const list = want.filter((s) => held.has(s.id)).map((s) => ({ ...unpack(held.get(s.id)), n: nOf.get(s.id) }));
      return { list, doneCount: lean.stamps.filter((s) => s.status === "approved").length, total };
    },
    async get(id) {
      /* always the full row: a write must never start from a light one */
      const rows = await rest("GET", `${where}&id=eq.${encodeURIComponent(id)}`);
      if (!rows.length) return null;
      hold(rows[0]);
      return unpack(rows[0]);
    },
    async insert(entry, png, thumb) {
      if (png) await upload(`${entry.id}.png`, png, "image/png");
      if (thumb) await upload(`${entry.id}.t.jpg`, thumb, "image/jpeg");
      entry.shot = png ? `${entry.id}.png` : null;
      entry.thumb = thumb ? `${entry.id}.t.jpg` : null;
      const [row] = await rest("POST", "review_comments", pack(entry));
      hold(row);
      return entry;
    },
    async put(c) {
      const [row] = await rest("PATCH", `review_comments?id=eq.${encodeURIComponent(c.id)}`, pack(c));
      if (row) hold(row);
      else fresh();
      return c;
    },
    async putThumb(id, jpg) {
      await upload(`${id}.t.jpg`, jpg, "image/jpeg");
      const [row] = await rest("PATCH", `review_comments?id=eq.${encodeURIComponent(id)}`, { thumb: true });
      if (row) hold(row);
      else fresh();
    },
    /* the comment first, then its pictures: the hub may refuse (only its author or an approver, signed in, may
       remove it; hub/roles.sql), and a refused comment must keep its pictures */
    async remove(c) {
      const gone = await rest("DELETE", `review_comments?id=eq.${encodeURIComponent(c.id)}`);
      if (Array.isArray(gone) && !gone.length) {
        const e = new Error("Only its author or an approver can remove this comment");
        e.status = 403;
        throw e;
      }
      await removeFiles([c.shot, c.thumb].filter(Boolean)).catch(() => {});
      drop(c.id);
    },
    /* a picture's bytes: from the cache, else downloaded once and kept */
    async shot(file) {
      const held = cache?.get(file);
      if (held) return held;
      const r = await fetchFn(`${url}/storage/v1/object/${BUCKET}/${objectPath(file)}`, { headers: await auth() });
      if (!r.ok) return null;
      const bytes = new Uint8Array(await r.arrayBuffer());
      cache?.put(file, bytes);
      return bytes;
    },
    /* signed links to pictures, for a page that cannot proxy them (the extension): an hour each, many at once */
    async sign(files, expiresIn = 3600) {
      if (!files.length) return {};
      const r = await fetchFn(`${url}/storage/v1/object/sign/${BUCKET}`, { method: "POST", headers: { ...(await auth()), "Content-Type": "application/json" }, body: JSON.stringify({ expiresIn, paths: files.map(objectPath) }) });
      if (!r.ok) throw new Error(`hub sign: ${r.status}`);
      const out = {};
      for (const row of await r.json()) if (row.signedURL) out[row.path.slice(project.length + 1)] = `${url}/storage/v1${row.signedURL}`;
      return out;
    },
    /* the people: everyone who has signed in, with name and picture; the signed-in person writes their own row */
    /* the rules (hub/roles.sql, review_rules): who may do what; null when the table is not there yet */
    async rules() {
      try {
        return await rest("GET", "review_rules?select=action,who,statuses,signed");
      } catch {
        return null;
      }
    },
    /* the members and their roles (hub/roles.sql): who approves; null when the table is not there yet */
    async members() {
      try {
        const rows = await rest("GET", "review_members?select=handle,role");
        /* lower-case keys; two rows for one person (a case twin) keep the stronger role */
        const rank = { approver: 3, member: 2, refused: 1, waiting: 0 };
        const out = {};
        for (const r of rows) {
          const k = String(r.handle).toLowerCase();
          if (!(k in out) || (rank[r.role] ?? 0) > (rank[out[k]] ?? 0)) out[k] = r.role;
        }
        return out;
      } catch {
        return null;
      }
    },
    /* THE WAITING LIST (Nirav, 2026-10-24): an approver lets someone in (member) or refuses them; the hub allows it to
       approvers only, so no row changed means no */
    async setMember(handle, role) {
      if (!["member", "refused", "approver"].includes(role)) throw Object.assign(new Error("role: member | refused"), { status: 400 });
      const rows = await rest("PATCH", `review_members?handle=ilike.${encodeURIComponent(handle)}`, { role }, { Prefer: "return=representation" }); // any case
      if (!Array.isArray(rows) || !rows.length) throw Object.assign(new Error("Only an approver can let people in"), { status: 403 });
      return rows[0];
    },
    async people() {
      try {
        const rows = await rest("GET", "review_people?select=handle,name,avatar");
        const out = {};
        for (const r of rows) out[r.handle] = { name: r.name, avatar: r.avatar };
        return out;
      } catch {
        return {};
      }
    },
    async bePerson({ handle, name, avatar, userId }) {
      await rest("POST", "review_people", { handle, name, avatar: avatar || null, user_id: userId, seen_at: new Date().toISOString() }, { Prefer: "resolution=merge-duplicates,return=minimal" });
    },
    /* the meter: files and bytes in the bucket, this project and all */
    async usage() {
      const rows = await rest("POST", "rpc/review_usage", {});
      const all = rows.reduce((s, r) => s + Number(r.bytes), 0);
      const mine = rows.find((r) => r.project === project);
      return { project, files: Number(mine?.files || 0), bytes: Number(mine?.bytes || 0), total: all, limit: 1024 * 1024 * 1024 };
    },
    /* retention: pictures of comments approved more than 14 days ago go, the comment stays. Once an hour per
       client, from whichever machine is running; the record says the picture is gone. */
    async sweep() {
      if (Date.now() - lastSweep < 3600_000) return 0;
      lastSweep = Date.now();
      const due = await rest("POST", "rpc/review_sweepable", { days: RETENTION_DAYS });
      let gone = 0;
      for (const { id, project: p } of due) {
        if (p !== project) continue; // another project's client sweeps its own
        await removeFiles([`${id}.png`, `${id}.t.jpg`]);
        await rest("PATCH", `review_comments?id=eq.${encodeURIComponent(id)}`, { shot: false, thumb: false });
        gone++;
      }
      if (gone) fresh();
      return gone;
    },
  };
}
