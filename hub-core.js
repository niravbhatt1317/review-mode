// The review's rules and its hub client, shared by the collector (Node, .review/plugin.js through .review/hub.js)
// and the extension (the browser, background.js). No Node and no browser globals beyond fetch, so both can import it.
//
// The hub is Supabase: one row per comment in review_comments (the record as JSON plus the columns the hub sorts and
// sweeps by), the pictures in the private bucket review-shots at <project>/<id>.png and <project>/<id>.t.jpg.

export const STATUSES = ["open", "progress", "approval", "approved"];
const BUCKET = "review-shots";
export const RETENTION_DAYS = 14;

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
export const newId = () => `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`;

/* an edit or a move: text, severity, status (with who did it and when), and the note that rides with a move back.
   STATUS: open -> progress (someone picked it up) -> approval (they are done) -> approved (the reviewer accepted).
   "Reopen" and "send back" move it back. A note on a move back stays on the comment through the rework and the
   next For approval, so whoever picks it up sees why it came back and the reviewer can check the change against
   their own ask; it clears on Approve (and stays in history). */
export function applyChange(c, body, who) {
  const { text, severity, status, resolved, note } = body;
  if (typeof text === "string" && text.trim()) c.text = sentence(text);
  if (["must", "should", "idea", "question"].includes(severity)) c.severity = severity;
  const to = STATUSES.includes(status) ? status : typeof resolved === "boolean" ? (resolved ? "approved" : "open") : null;
  if (to && to !== c.status) {
    const at = Date.now();
    const from = c.status;
    c.status = to;
    if (to === "progress") Object.assign(c, { assignee: who, pickedAt: at });
    if (to === "approval") Object.assign(c, { doneBy: who, doneAt: at });
    if (to === "approved") Object.assign(c, { approvedBy: who, approvedAt: at, resolvedAt: at });
    if (to === "open") Object.assign(c, { assignee: null, pickedAt: null, doneAt: null, approvedAt: null, resolvedAt: null });
    const step = { at, by: who, status: to };
    const back = STATUSES.indexOf(to) < STATUSES.indexOf(from);
    const words = typeof note === "string" ? note.trim().slice(0, 600) : "";
    if (back && words) step.note = words;
    if (back) c.note = words ? { text: words, by: who, at, from, to } : null;
    if (to === "approved") c.note = null;
    (c.history ||= []).push(step);
    normalise(c);
  }
  c.edited = Date.now();
  return c;
}
/* who is who: ids in the data (git handles) shown as people; `people` maps handle -> name. Unknown ones show as is. */
export function withNames(c, people = {}) {
  const name = (id) => (id && (typeof people[id] === "string" ? people[id] : people[id]?.name)) || id;
  const out = { ...c, by: name(c.by), assignee: name(c.assignee), doneBy: name(c.doneBy), approvedBy: name(c.approvedBy) };
  if (c.note) out.note = { ...c.note, by: name(c.note.by) };
  if (Array.isArray(c.history)) out.history = c.history.map((h) => ({ ...h, by: name(h.by) }));
  return out;
}
/* the people shown: the hub's (first word of the GitHub name, the picture) under the team's own map (a chosen name) */
export function mergePeople(teamMap = {}, hubPeople = {}) {
  const out = {};
  for (const [h, p] of Object.entries(hubPeople)) out[h] = { name: String(p.name || h).split(/\s+/)[0], avatar: p.avatar || null };
  for (const [h, n] of Object.entries(teamMap)) out[h] = { name: n, avatar: out[h]?.avatar || null };
  return out;
}
/* the pictures of the people on a comment, keyed by the name shown, for the cards and the pin card */
export function avatarsOf(c, people) {
  const out = {};
  for (const h of [c.by, c.assignee, c.doneBy, c.approvedBy, c.note?.by]) if (h && people[h]?.avatar) out[people[h].name] = people[h].avatar;
  return out;
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
    if (!r.ok) throw new Error(`hub ${method} ${q.split("?")[0]}: ${r.status} ${(await r.text()).slice(0, 200)}`);
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
  const fresh = () => (cached = null);
  const hold = (row) => {
    if (!cached) return;
    const i = cached.rows.findIndex((r) => r.id === row.id);
    if (i < 0) cached.rows.push(row);
    else cached.rows[i] = row;
    cached.rows.sort((a, b) => Number(a.ts) - Number(b.ts));
    cached.sig = sigOf(cached.rows);
    cached.at = Date.now();
  };
  const drop = (id) => {
    if (!cached) return;
    cached.rows = cached.rows.filter((r) => r.id !== id);
    cached.sig = sigOf(cached.rows);
    cached.at = Date.now();
  };
  let lastSweep = 0;
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
    async get(id) {
      const held = cached?.rows.find((r) => r.id === id);
      if (held && Date.now() - cached.at < 1500) return unpack(held);
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
    async remove(c) {
      await removeFiles([c.shot, c.thumb].filter(Boolean));
      await rest("DELETE", `review_comments?id=eq.${encodeURIComponent(c.id)}`);
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
