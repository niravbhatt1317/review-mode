// The extension's back room. Three jobs:
//   1. the picture: the visible part of the tab that asked, as a PNG data URL (the share picker never shows);
//   2. the hub: it answers the overlay's /__review/… requests straight from Supabase (hub-core.js), one project
//      per site, so the overlay works on any page without the dev server;
//   3. hosting: on a site switched on with the toolbar button it injects the overlay into the page.
// On the console (localhost:4178) the dev server injects and answers itself; the extension only takes the picture.
import { makeHub, prepare, withNames, applyChange, bytesOf, newId, sentence, normalise, mergePeople, avatarsOf } from "./hub-core.js";
import { makeAuth } from "./auth.js";

/* ---------- configuration: hub.json beside this file, with what the options page saved over it ---------- */
let bundled = null;
async function config() {
  if (!bundled) bundled = await (await fetch(chrome.runtime.getURL("hub.json"))).json();
  const saved = (await chrome.storage.local.get(["who", "sites", "hub"])) || {};
  return {
    url: saved.hub?.url || bundled.url,
    key: saved.hub?.anonKey || bundled.anonKey,
    authPage: saved.hub?.authPage || bundled.authPage, // where the hub sends the sign-in back; in its allowed redirect URLs
    people: { ...(bundled.people || {}), ...(saved.hub?.people || {}) },
    who: saved.who || "",
    sites: saved.sites || {}, // origin -> { project }
  };
}
/* which project a page belongs to: what the options say for its origin, else the console's project on the dev
   server, else the host name */
async function projectFor(origin) {
  if (String(origin).startsWith("ext:")) return origin.slice(4); // the extension's own list page, one project
  const cfg = await config();
  const site = cfg.sites[origin];
  if (site?.project) return site.project;
  try {
    const u = new URL(origin);
    if (u.host === "localhost:4178") return bundled.project || u.host; // the console's dev server in review mode
    return /^(localhost|127\.0\.0\.1)$/.test(u.hostname) ? u.host : u.hostname; // local apps apart by port, sites by name
  } catch {
    return "site";
  }
}
const auth = makeAuth(
  async () => { const c = await config(); return { url: c.url, key: c.key, authPage: c.authPage }; },
  /* signed in: the person goes on the hub's people table (name, avatar), by their verified account */
  async (p) => {
    const cfg = await config();
    const hub = await hubFor(cfg.sites[Object.keys(cfg.sites)[0]]?.project || bundled.project || "main");
    await hub.bePerson({ handle: p.handle, name: p.name, avatar: await smallFace(p.avatar), userId: p.id });
    peopleCache.at = 0;
  });
/* who is commenting: the signed-in GitHub account (handle verified), else the handle typed in the options */
/* the person's photo kept on the hub itself (Nirav, 2026-10-23): GitHub's picture at 64 px as a data URL (3 to 5 KB), so
   every drawer gets the faces with the people list and never asks GitHub's picture server */
async function smallFace(url) {
  if (!url || url.startsWith("data:")) return url || null;
  try {
    const r = await fetch(url + (url.includes("?") ? "&" : "?") + "s=64");
    if (!r.ok) return url;
    const type = (r.headers.get("content-type") || "image/png").split(";")[0];
    const bytes = new Uint8Array(await r.arrayBuffer());
    let bin = "";
    for (let i = 0; i < bytes.length; i += 0x8000) bin += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
    return `data:${type};base64,${btoa(bin)}`;
  } catch {
    return url; // offline or blocked: the link, as before
  }
}
/* once per start of the extension: a signed-in person's own row gets the small copy (the hub lets each person write
   only their own row, so every browser looks after its owner) */
let faceKept = false;
async function keepFace() {
  if (faceKept) return;
  faceKept = true;
  const p = await auth.person().catch(() => null);
  if (!p?.avatar) return;
  const face = await smallFace(p.avatar);
  if (!face?.startsWith("data:")) return;
  const cfg = await config();
  const hub = await hubFor(Object.values(cfg.sites)[0]?.project || bundled.project || "main");
  const known = (await hub.people().catch(() => ({})))[p.handle];
  if (known?.avatar?.startsWith("data:")) return;
  await hub.bePerson({ handle: p.handle, name: known?.name || p.name, avatar: face, userId: p.id }).catch(() => {});
  peopleCache.at = 0;
}
async function whoami() {
  keepFace().catch(() => {});
  const p = await auth.person().catch(() => null);
  if (p) return { handle: p.handle, name: p.name, avatar: p.avatar, signedIn: true };
  return { handle: "", name: "", avatar: null, signedIn: false };
}
const hubs = new Map(); // project -> client
async function hubFor(project) {
  const cfg = await config();
  const k = `${cfg.url}|${project}`;
  if (!hubs.has(k)) hubs.set(k, makeHub({ url: cfg.url, key: cfg.key, project, bearer: () => auth.token().catch(() => null) }));
  return hubs.get(k);
}

/* ---------- the people: who has signed in, with name and picture, cached a minute ---------- */
let peopleCache = { at: 0, map: {} };
async function peopleOn(hub) {
  if (Date.now() - peopleCache.at < 60_000) return peopleCache.map;
  /* a miss keeps the last good list: an empty answer for a minute turned every face into its initial */
  const map = await hub.people().catch(() => null);
  if (map && (Object.keys(map).length || !Object.keys(peopleCache.map).length)) peopleCache = { at: Date.now(), map };
  else peopleCache.at = Date.now() - 50_000; // try again in about ten seconds
  return peopleCache.map;
}
/* the names shown: the team's map first (a first name chosen by the team), else the GitHub name's first word */
function namesFrom(cfg, hubPeople, me) {
  const people = mergePeople(cfg.people, hubPeople);
  if (me.signedIn && me.handle && !people[me.handle]) people[me.handle] = { name: String(me.name || me.handle).split(/\s+/)[0], avatar: me.avatar };
  return people;
}
/* ---------- signed picture links, kept for fifty minutes ---------- */
const signed = new Map(); // project/file -> { url, at }
async function withUrls(hub, list) {
  const want = [];
  for (const c of list) for (const f of [c.shot, c.thumb]) if (f && !(signed.get(`${hub.project}/${f}`)?.at > Date.now() - 50 * 60_000)) want.push(f);
  if (want.length) {
    const urls = await hub.sign([...new Set(want)]);
    for (const [f, url] of Object.entries(urls)) signed.set(`${hub.project}/${f}`, { url, at: Date.now() });
  }
  return list.map((c) => ({ ...c, urls: { shot: c.shot ? signed.get(`${hub.project}/${c.shot}`)?.url : null, thumb: c.thumb ? signed.get(`${hub.project}/${c.thumb}`)?.url : null } }));
}

/* ---------- the collector's endpoints, answered here ---------- */
async function answer(origin, { path, query, method, body }) {
  const cfg = await config();
  const project = await projectFor(origin);
  const hub = await hubFor(project);
  const me = await whoami();
  const who = me.handle || "someone";
  const data = body ? JSON.parse(body) : {};
  const people = namesFrom(cfg, await peopleOn(hub), me);
  const shown = (c) => ({ ...withNames(c, people), avatars: avatarsOf(c, people) });
  const ok = (b) => ({ ok: true, status: 200, body: b });
  const no = (status, error) => ({ ok: false, status, body: { error } });
  switch (path) {
    case "/__review/hub":
      return ok({ on: true, project, who: people[who]?.name || who, avatar: people[who]?.avatar || me.avatar || null, approver: me.signedIn && (bundled.approvers || []).includes(me.handle), signedIn: me.signedIn, usage: await hub.usage().catch(() => null) });
    case "/__review/list": {
      hub.sweep().catch(() => {});
      const list = prepare(await hub.list());
      return ok((await withUrls(hub, list)).map(shown));
    }
    case "/__review/next":
      return ok({ n: (await hub.list()).length + 1 });
    case "/__review/save": {
      if (method !== "POST") return no(405, "POST");
      if (!me.signedIn) return no(401, "sign in first: the Review icon, then Sign in with GitHub");
      const { png, thumb, session, ...rest } = data;
      const entry = normalise({ id: newId(), ts: Date.now(), by: who, ...rest, text: sentence(rest.text), shot: null, status: "open", clean: true });
      await hub.insert(entry, bytesOf(png), bytesOf(thumb));
      const list = prepare(await hub.list());
      entry.n = list.find((c) => c.id === entry.id)?.n || list.length;
      return ok({ ok: true, entry: shown(entry), count: list.length });
    }
    case "/__review/update": {
      if (method !== "POST") return no(405, "POST");
      if (!me.signedIn) return no(401, "sign in first: the Review icon, then Sign in with GitHub");
      const c = await hub.get(data.id);
      if (!c) return no(404, "no such comment");
      c.text = sentence(c.text);
      normalise(c);
      applyChange(c, data, who);
      await hub.put(c);
      c.n = prepare(await hub.list()).find((x) => x.id === c.id)?.n;
      const [withUrl] = await withUrls(hub, [c]);
      return ok({ ok: true, entry: shown(withUrl) });
    }
    case "/__review/thumb": {
      if (method !== "POST") return no(405, "POST");
      if (!(await hub.list()).some((c) => c.id === data.id)) return no(404, "no such comment");
      await hub.putThumb(String(data.id).replace(/[^a-z0-9-]/gi, ""), bytesOf(data.jpg));
      return ok({ ok: true });
    }
    case "/__review/delete": {
      if (method !== "POST") return no(405, "POST");
      const gone = (await hub.list()).find((c) => c.id === data.id);
      if (gone) await hub.remove(gone);
      return ok({ ok: true, count: (await hub.list()).length });
    }
    case "/__review/links": {
      /* signed links to the full pictures, for a brief that is read elsewhere */
      if (method !== "POST") return no(405, "POST");
      const list = await hub.list();
      const want = list.filter((c) => data.ids?.includes(c.id) && c.shot);
      const urls = await hub.sign(want.map((c) => c.shot), Math.min(30, Number(data.days) || 7) * 86400);
      const out = {};
      for (const c of want) if (urls[c.shot]) out[c.id] = urls[c.shot];
      return ok(out);
    }
    case "/__review/export":
    case "/__review/paste":
      return no(501, "not here: the extension keeps nothing on disk");
    default:
      return no(404, "unknown");
  }
}

/* ---------- hosting: the overlay into a page of a site that is switched on ---------- */
async function host(tabId, origin) {
  const cfg = await config();
  const project = await projectFor(origin);
  const me = await whoami();
  const ext = { project, who: me.signedIn ? (cfg.people[me.handle] || String(me.name || me.handle).split(/\s+/)[0]) : cfg.people[cfg.who] || cfg.who || "", avatar: me.avatar || null, listUrl: chrome.runtime.getURL(`list.html?project=${encodeURIComponent(project)}`) };
  /* once per page: a second copy would only throw on its first line (the page asked on load, then the popup's
     Switch on asked again, or a page restored from the back-forward cache asks anew) */
  const [has] = await chrome.scripting.executeScript({ target: { tabId }, world: "MAIN", func: () => !!document.getElementById("__review-host") || typeof window.__reviewPeek === "function" });
  if (has?.result) return;
  await chrome.scripting.executeScript({ target: { tabId }, world: "MAIN", func: (e) => { window.__reviewExt = e; }, args: [ext] });
  await chrome.scripting.executeScript({ target: { tabId }, world: "MAIN", files: ["overlay.js"] });
}
async function siteOn(origin) {
  const cfg = await config();
  return !!cfg.sites[origin];
}
/* the popup switched a site on (and saved it): the overlay now, unless the dev server carries it */
async function switchOn(tabId, origin) {
  if (!(tabId >= 0)) return;
  chrome.action.setBadgeText({ tabId, text: "on" });
  chrome.action.setBadgeBackgroundColor({ color: "#1d2b3e" });
  const tab = await chrome.tabs.get(tabId);
  if (!/^http:\/\/(localhost|127\.0\.0\.1)(:\d+)?\//.test(tab.url || "") || !(await devServerHosts(tabId))) await host(tabId, origin);
}
/* the projects the hub knows, for the popup's suggestions */
async function projectNames() {
  const cfg = await config();
  const r = await fetch(`${cfg.url}/rest/v1/review_comments?select=project`, { headers: { apikey: cfg.key, Authorization: `Bearer ${cfg.key}` } });
  const rows = r.ok ? await r.json() : [];
  const names = new Set(rows.map((x) => x.project).filter((p) => p && !p.startsWith("_")));
  for (const s of Object.values(cfg.sites)) if (s.project) names.add(s.project);
  return [...names].sort();
}
/* the console's dev server already carries the overlay: then the extension only takes pictures */
async function devServerHosts(tabId) {
  try {
    const [r] = await chrome.scripting.executeScript({ target: { tabId }, func: () => !!document.querySelector('script[src^="/__review/overlay.js"]') });
    return !!r?.result;
  } catch {
    return false;
  }
}

chrome.runtime.onMessage.addListener((msg, sender, reply) => {
  if (msg?.type === "review-capture") {
    /* promise form: the same call in Chrome and Firefox */
    Promise.resolve(chrome.tabs.captureVisibleTab(sender.tab.windowId, { format: "png" }))
      .then((dataUrl) => reply({ ok: !!dataUrl, dataUrl: dataUrl || null, error: dataUrl ? null : "no picture" }))
      .catch((e) => reply({ ok: false, dataUrl: null, error: String(e?.message || e) }));
    return true;
  }
  if (msg?.type === "review-api") {
    const origin = msg.origin || (sender.tab?.url ? new URL(sender.tab.url).origin : sender.origin);
    answer(origin, msg).then(reply, (e) => reply({ ok: false, status: 500, body: { error: String(e?.message || e) } }));
    return true;
  }
  if (msg?.type === "review-switch-on") {
    switchOn(msg.tabId, msg.origin).then(() => reply({ ok: true }), (e) => reply({ ok: false, error: String(e?.message || e) }));
    return true;
  }
  if (msg?.type === "review-open") {
    /* the list page (or another page of ours) in a new tab, only ever our own pages */
    const url = String(msg.url || "");
    if (url.startsWith(chrome.runtime.getURL(""))) chrome.tabs.create({ url, index: (sender.tab?.index ?? 0) + 1 });
    reply({ ok: true });
    return;
  }
  if (msg?.type === "review-whoami") {
    whoami().then(reply, () => reply({ handle: "", name: "", signedIn: false }));
    return true;
  }
  if (msg?.type === "review-sign-in") {
    auth.signIn().then(reply, (e) => reply({ ok: false, error: String(e?.message || e) }));
    return true;
  }
  if (msg?.type === "review-sign-out") {
    auth.signOut().then(() => reply({ ok: true }), (e) => reply({ ok: false, error: String(e?.message || e) }));
    return true;
  }
  if (msg?.type === "review-projects") {
    projectNames().then(reply, () => reply([]));
    return true;
  }
  if (msg?.type === "review-host?") {
    /* a page asks whether its site is on; if so the overlay goes in (unless the dev server has it already) */
    const tab = sender.tab;
    if (!tab?.url || !(tab.id >= 0)) return; // a prerendering page has no tab yet
    const origin = new URL(tab.url).origin;
    siteOn(origin).then(async (on) => {
      chrome.action.setBadgeText({ tabId: tab.id, text: on ? "on" : "" });
      if (on && !msg.devServer) await host(tab.id, origin);
      reply({ on });
    });
    return true;
  }
});
