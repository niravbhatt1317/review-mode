// The collector: a Vite plugin that injects the overlay into the project's pages and answers it. The overlay then
// works on the dev server without the extension (the extension only takes the pictures), and anyone, Claude
// included, can read the comments and move statuses over plain HTTP on the same port.
//   GET  /__review/overlay.js     the in-page script (the package's overlay.js: one file, two hosts)
//   GET  /__review/list           every comment of the project (or of ?session=_xxx, a local test session), JSON
//   GET  /__review/hub            { on, project, who, avatar, usage }
//   GET  /__review/               the list page
//   GET  /__review/shot/<file>    a picture (from the hub through the disk cache, or the local session)
//   POST /__review/save           one comment + its PNG and thumbnail (base64)
//   POST /__review/update         { id, text?, severity?, status?, note? }
//   POST /__review/thumb          { id, jpg }
//   POST /__review/delete         { id }
//   POST /__review/export         { id, n, png } -> .review/sessions/<project>/export/NN-<id>.png, for a brief
//   POST /__review/links          { ids, days } -> signed links to the full pictures
// STATUS: open -> progress (someone picked it up) -> approval (they are done) -> approved (the reviewer accepted);
// "Reopen" and "send back" move it back, with a note.
import fs from "node:fs";
import path from "node:path";
import { execSync } from "node:child_process";
import { loadConfig, pkgDir } from "./config.js";
import { codeNear } from "./source.js";
import { storeFor, prepare } from "./stores.js";
import { withNames, applyChange, mergePeople, avatarsOf, normalise, sentence, newId, teamOf, waitingOf, isApproverIn, sigOf, lightList, facesOf, claudeSessions, claudeSend, claudeStatus } from "../hub-core.js";

/* who is reviewing on this machine: the git name, mapped to a person by the people map */
let reviewer = "";
try {
  reviewer = execSync("git config user.name", { stdio: ["ignore", "pipe", "ignore"] }).toString().trim();
} catch {}

function readBody(req, limit = 40 * 1024 * 1024) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    req.on("data", (c) => {
      size += c.length;
      if (size > limit) {
        reject(new Error("too large"));
        req.destroy();
        return;
      }
      chunks.push(c);
    });
    req.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
    req.on("error", reject);
  });
}
function send(res, status, body, type = "application/json") {
  res.statusCode = status;
  res.setHeader("Content-Type", type);
  res.end(typeof body === "string" || Buffer.isBuffer(body) ? body : JSON.stringify(body));
}
const b64 = (s) => (s ? Buffer.from(String(s).split(",").pop(), "base64") : null);
/* the list page: the same panel the app shows, as a whole page; the project's own stylesheets are not needed */
const listPage = () => `<!doctype html><html lang="en"><head><meta charset="utf-8"><title>Review comments</title>
<meta name="viewport" content="width=device-width, initial-scale=1">
<style>html, body { margin: 0; height: 100%; background: #f6f8fb; }</style>
</head><body><script type="module" src="/__review/overlay.js"></script></body></html>`;

export default function review(options = {}) {
  let cfg = null;
  let viteRoot = process.cwd(); // the stamps' paths start here
  const hubs = new Map();
  let peopleCache = { at: 0, map: {} };
  const peopleFor = async (store) => {
    /* the people always come from the hub, whichever store answers: a local test session used to fill the shared
       cache with nothing, and for a minute every face on the real list fell back to its initial */
    if (Date.now() - peopleCache.at > 60_000) {
      const hub = store.kind === "hub" ? store : cfg.hub ? storeFor(cfg, hubs) : null;
      const map = hub ? await hub.people().catch(() => null) : {};
      if (map && (Object.keys(map).length || !Object.keys(peopleCache.map).length)) peopleCache = { at: Date.now(), map }; // a miss (the hub answers {}) keeps the last good list
      else peopleCache.at = Date.now() - 50_000; // and tries again in about ten seconds
    }
    return mergePeople(cfg.people, peopleCache.map);
  };
  /* who approves: the hub's members table (the list the hub enforces), else hub.json's approvers */
  let membersCache = { at: 0, map: null };
  const approverIs = async (store, handle) => {
    if (Date.now() - membersCache.at > 60_000) {
      const hub = store.kind === "hub" ? store : cfg.hub ? storeFor(cfg, hubs) : null;
      membersCache = { at: Date.now(), map: hub?.members ? await hub.members() : null };
    }
    return membersCache.map ? isApproverIn(membersCache.map, handle) : (cfg.approvers || []).some((a) => a.toLowerCase() === String(handle || "").toLowerCase());
  };
  const shownWith = (people) => (c) => ({ ...withNames(c, people), avatars: avatarsOf(c, people) });
  return {
    name: "review-mode",
    apply: "serve",
    configResolved(resolved) {
      cfg = { ...loadConfig(resolved.root), ...options };
      viteRoot = resolved.root;
    },
    transformIndexHtml(html) {
      return html.replace("</body>", `<script type="module" src="/__review/overlay.js"></script></body>`);
    },
    configureServer(server) {
      server.middlewares.use(async (req, res, next) => {
        const [url, qs] = (req.url || "").split("?");
        if (!url.startsWith("/__review")) return next();
        const sess = new URLSearchParams(qs || "").get("session") || undefined;
        try {
          if (url === "/__review/overlay.js") {
            res.setHeader("Cache-Control", "no-store");
            return send(res, 200, fs.readFileSync(path.join(pkgDir, "overlay.js"), "utf8"), "text/javascript");
          }
          const store = storeFor(cfg, hubs, sess);
          if (url === "/__review/list") {
            store.sweep().catch((e) => console.warn("[review] sweep:", e.message));
            const ppl = await peopleFor(store);
            const q0 = new URLSearchParams(qs || "");
            if (store.lightList && q0.get("light") && q0.get("since") !== null) {
              /* the lean path (step 3): the hub sends only the rows wanted, only when something moved */
              const { list: rows, doneCount } = await store.lightList({ approved: !!q0.get("approved") });
              const body = { ...lightList(rows.map(shownWith(ppl)), { approved: !!q0.get("approved") }), doneCount, faces: facesOf(ppl) };
              const sig = sigOf(JSON.stringify(body));
              return send(res, 200, q0.get("since") === sig ? { same: true, sig } : { sig, ...body });
            }
            const list = prepare(await store.list()).map(shownWith(ppl));
            /* ?since=<fingerprint>: the drawer's refresh; an unchanged list answers { same: true }. ?light=1: the light
               list (no pictures of people, a small app snapshot, approved counted; ?approved=1 sends those instead) */
            const q = new URLSearchParams(qs || "");
            const since = q.get("since");
            if (since === null) return send(res, 200, list);
            const body = q.get("light") ? { ...lightList(list, { approved: !!q.get("approved") }), faces: facesOf(ppl) } : { list };
            const sig = sigOf(JSON.stringify(body));
            return send(res, 200, since === sig ? { same: true, sig } : { sig, ...body });
          }
          /* GET /__review/near?file=&line=&col=  the fingerprint of the code there now ("Maybe fixed?") */
          if (url === "/__review/near") {
            const q = new URLSearchParams(qs || "");
            return send(res, 200, codeNear(viteRoot, q.get("file"), q.get("line"), q.get("col")) || { near: null });
          }
          if (url === "/__review/next") return send(res, 200, { n: (await store.list()).length + 1 });
          if (url === "/__review/hub") {
            const on = store.kind === "hub";
            const ppl = await peopleFor(store);
            return send(res, 200, { on, project: store.project, who: ppl[reviewer]?.name || reviewer, handle: reviewer || null, avatar: ppl[reviewer]?.avatar || null, approver: await approverIs(store, reviewer), usage: on ? await store.usage().catch(() => null) : null });
          }
          if (url === "/__review/rules") {
            const hub = store.kind === "hub" ? store : cfg.hub ? storeFor(cfg, hubs) : null;
            return send(res, 200, (hub?.rules ? await hub.rules() : null) || []); // empty: the drawer's own defaults
          }
          /* Send to Claude: the open sessions, a send, whether Claude has it */
          if (url === "/__review/claude/sessions") return send(res, 200, await claudeSessions(fetch, store.project));
          if (url === "/__review/claude/send" && req.method === "POST") {
            const body = JSON.parse(await readBody(req));
            try {
              return send(res, 200, await claudeSend(body.port, String(body.text || ""), body.count));
            } catch (e) {
              return send(res, 502, { error: String(e.message || e) });
            }
          }
          if (url === "/__review/claude/status") {
            const q = new URLSearchParams(qs || "");
            return send(res, 200, await claudeStatus(q.get("port"), q.get("id")).catch(() => ({ acked: false })));
          }
          if (url === "/__review/members") {
            /* the waiting list to read; letting someone in needs the approver's sign-in, so the drawer sends that
               through the extension */
            if (req.method === "POST") return send(res, 401, { error: "Sign in first: letting people in goes through the extension" });
            await approverIs(store, reviewer);
            return send(res, 200, waitingOf(membersCache.map, await peopleFor(store)));
          }
          if (url === "/__review/people") {
            await approverIs(store, reviewer); // fills the members cache
            return send(res, 200, teamOf(await peopleFor(store), membersCache.map));
          }
          if (url === "/__review" || url === "/__review/") return send(res, 200, listPage(), "text/html");
          if (url.startsWith("/__review/shot/")) {
            const file = path.basename(url.slice("/__review/shot/".length));
            const buf = await store.shot(file);
            if (!buf) return send(res, 404, { error: "no such shot" });
            res.setHeader("Cache-Control", "private, max-age=3600");
            return send(res, 200, buf, file.endsWith(".jpg") ? "image/jpeg" : "image/png");
          }
          if (url === "/__review/save" && req.method === "POST") {
            const body = JSON.parse(await readBody(req));
            const st = body.session ? storeFor(cfg, hubs, body.session) : store;
            const { png, thumb, session, ...rest } = body;
            const entry = normalise({ id: newId(), ts: Date.now(), by: reviewer, ...rest, text: sentence(rest.text), shot: null, status: "open", clean: true });
            /* the code where the element is written, as it is now: "Maybe fixed?" compares it later */
            const near = entry.source?.how === "stamp" ? codeNear(viteRoot, entry.source.file, entry.source.line, entry.source.col) : null;
            if (near) entry.source.near = near.near;
            await st.insert(entry, b64(png), b64(thumb));
            const count = (await st.list()).length;
            entry.n = count;
            return send(res, 200, { ok: true, entry: shownWith(await peopleFor(st))(entry), count });
          }
          if (url === "/__review/update" && req.method === "POST") {
            const body = JSON.parse(await readBody(req));
            const c = await store.get(body.id);
            if (!c) return send(res, 404, { error: "no such comment" });
            c.text = sentence(c.text);
            normalise(c);
            applyChange(c, body, reviewer);
            await store.put(c);
            if (!c.n) c.n = prepare(await store.list()).find((x) => x.id === body.id)?.n;
            return send(res, 200, { ok: true, entry: shownWith(await peopleFor(store))(c) });
          }
          if (url === "/__review/links" && req.method === "POST") {
            const { ids, days } = JSON.parse(await readBody(req));
            const want = (await store.list()).filter((c) => ids?.includes(c.id) && c.shot);
            const urls = await store.sign(want.map((c) => c.shot), Math.min(30, Number(days) || 7) * 86400);
            const out = {};
            for (const c of want) if (urls[c.shot]) out[c.id] = urls[c.shot];
            return send(res, 200, out);
          }
          if (url === "/__review/export" && req.method === "POST") {
            /* a numbered picture as a file, for a brief Claude reads: .review/sessions/<project or session>/export/ */
            const { id, n, png } = JSON.parse(await readBody(req));
            const dir = path.join(cfg.sessionsDir, sess && /^_[a-z0-9-]+$/.test(sess) ? sess : cfg.project, "export");
            fs.mkdirSync(dir, { recursive: true });
            const file = `${String(n).padStart(2, "0")}-${String(id).replace(/[^a-z0-9-]/gi, "")}.png`;
            fs.writeFileSync(path.join(dir, file), b64(png));
            const rel = path.relative(cfg.root, path.join(dir, file)).split(path.sep).join("/");
            return send(res, 200, { ok: true, path: rel });
          }
          if (url === "/__review/thumb" && req.method === "POST") {
            const { id, jpg } = JSON.parse(await readBody(req));
            if (!(await store.list()).some((c) => c.id === id)) return send(res, 404, { error: "no such comment" });
            await store.putThumb(String(id).replace(/[^a-z0-9-]/gi, ""), b64(jpg));
            return send(res, 200, { ok: true });
          }
          if (url === "/__review/delete" && req.method === "POST") {
            const { id } = JSON.parse(await readBody(req));
            const gone = (await store.list()).find((c) => c.id === id);
            if (gone) await store.remove(gone);
            return send(res, 200, { ok: true, count: (await store.list()).length });
          }
          return send(res, 404, { error: "unknown" });
        } catch (e) {
          return send(res, e?.status || 500, { error: String(e?.message || e) }); // a refusal from the hub keeps its 403 and its words
        }
      });
    },
  };
}
