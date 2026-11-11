/* BEFORE AND AFTER (step 3, Nirav 2026-11-05): the same spot of a comment's page, as it is now (staging) and as it is on
   Claude's live preview. A hidden Chrome opens both, signs in the way the project says (previewLogin), replays the
   clicks the comment recorded (its trail: a drawer opened, a tab picked), finds the element the comment is pinned to,
   and takes the same-sized picture of it on both pages.
   BETTER PICTURES (Nirav, 2026-11-06, the sheet 5-better-pictures.png):
   - framed in its place: the row, card or panel around the element, the element outlined, not the element cut out;
   - what changed, marked: the two pictures compared pixel by pixel, the changed part as a box (fractions of the after);
   - a state: hover, focus or open (a click) on the element before the picture, the layer it opens framed with it;
   - a picked area: a comment on an area of an element (c.area, fractions of it) is pictured as that area;
   - views: one pair per page (up to 4) or per width; a pair with no difference at all says so (same: true).
   snap({ staging, preview, comment, login, views }) ->
     { views: [{ label, route, width, before, after (jpeg bytes), w, h, found: { before, after }, chg, same }] } */
import { spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const CHROMES = [
  process.env.REVIEW_CHROME,
  "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
  "/Applications/Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing",
  "/Applications/Chromium.app/Contents/MacOS/Chromium",
  "/usr/bin/google-chrome",
  "/usr/bin/chromium",
].filter(Boolean);
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
const PAD = 72; // room around an element with no container to frame it
const MAXW = 720; // the widest frame that still reads in the drawer's card
const OUTLINE = "#2F7BF5";

/* runs inside the page: find a recorded step's element (its address, else its words among clickable things) */
const FIND = `(() => {
  const queryDeep = (selector, root = document) => {
    const [head, ...rest] = String(selector).split(" >>> ");
    let hits = [];
    try { hits = Array.from(root.querySelectorAll(head)); } catch { return []; }
    if (!rest.length) return hits;
    const out = [];
    for (const h of hits) if (h.shadowRoot) out.push(...queryDeep(rest.join(" >>> "), h.shadowRoot));
    return out;
  };
  const norm = (t) => String(t || "").toLowerCase().replace(/\\s+/g, " ").trim();
  const txt = (e) => norm(e.textContent || "").slice(0, 80); // as the page recorded it (raw text, words run together)
  const seen = (e) => { const r = e.getBoundingClientRect(); return r.width > 0 && r.height > 0; };
  /* BY THE PAGE'S HEADING (Nirav, 2026-11-11: #33's header band): a spot that holds the page's heading is found on
     any page, and in any build, as the box around that page's main heading of about the spot's size */
  const byHead = ({ heading, w, h }) => {
    const hs = Array.from(document.querySelectorAll("h1, h2, [role=heading]")).filter(seen);
    const hd = (heading && hs.find((e) => norm(e.textContent) === norm(heading))) || hs.find((e) => e.tagName === "H1") || hs[0];
    if (!hd) return null;
    let best = hd;
    for (let e = hd.parentElement; e && e !== document.body; e = e.parentElement) {
      const r = e.getBoundingClientRect();
      if (r.height > h * 1.8 + 40) break; // past the band: the panel around it
      best = e;
      if (r.width >= w * 0.85) break; // as wide as the spot was
    }
    return best;
  };
  window.__snapFind = (step) => {
    if (step.head) return byHead(step.head);
    const key = norm(step.textKey).slice(0, 80);
    const hits = step.selector ? queryDeep(step.selector).filter(seen) : [];
    const same = hits.find((e) => !key || txt(e) === key);
    if (same) return same;
    if (key.length >= 3) {
      const pool = Array.from(document.querySelectorAll("button, a, [role], tr, td, th, li, label, summary, input, p, span, div, h1, h2, h3, h4"));
      const byText = pool.filter((e) => seen(e) && txt(e) === key);
      if (byText.length) return byText.sort((a, b) => a.getBoundingClientRect().width * a.getBoundingClientRect().height - b.getBoundingClientRect().width * b.getBoundingClientRect().height)[0];
    }
    if (step.loose && key.length >= 2) {
      const pool = Array.from(document.querySelectorAll("button, a, [role=option], [role=menuitem], [role=tab], [role=button], [role=row], li, label, summary, tr, td, th, span, div, p, h1, h2, h3, h4"));
      const area = (e) => { const r = e.getBoundingClientRect(); return r.width * r.height; };
      const near = pool.filter((e) => seen(e) && (txt(e) === key || txt(e).startsWith(key))).sort((a, b) => area(a) - area(b));
      const pick = near[0] || pool.filter((e) => seen(e) && txt(e).includes(key)).sort((a, b) => area(a) - area(b))[0];
      if (pick) return pick.closest("button, a, [role=option], [role=menuitem], [role=tab], [role=button], li, tr, label, summary") || pick;
    }
    return hits[0] || null;
  };
  const page = (r) => ({ x: r.left + scrollX, y: r.top + scrollY, w: r.width, h: r.height });
  window.__snapBox = (step) => {
    const e = window.__snapFind(step);
    if (!e) return null;
    e.scrollIntoView({ block: "center", inline: "nearest" });
    const r = e.getBoundingClientRect();
    const a = e.closest("a[href]");
    const away = !!a && (() => { try { const u = new URL(a.href, location.href); return u.origin === location.origin && u.pathname !== location.pathname; } catch { return false; } })();
    return { ...page(r), cx: r.left + r.width / 2, cy: r.top + r.height / 2, away };
  };
  /* the layers open now (a menu, a tooltip, a popover, a dialog): what a hover or a click on the element opened */
  const LAYERS = "[role=tooltip],[role=menu],[role=listbox],[role=dialog],[role=alertdialog],dialog[open],:popover-open,[data-radix-popper-content-wrapper],[data-state=open][data-side]";
  window.__snapLayers = () => Array.from(document.querySelectorAll(LAYERS)).filter(seen);
  /* FRAMED IN ITS PLACE: from the element up to the first container that reads as one (a row, an item, a card, a
     panel: its role or tag, a border, a shadow or its own background), wide enough to show the element in place and
     not taller than a screen's worth; none: the element with room around it */
  const up = (e) => e.parentElement || (e.getRootNode() instanceof ShadowRoot ? e.getRootNode().host : null);
  const boxy = (e) => {
    if (/^(TR|LI|FIELDSET|FORM|SECTION|ARTICLE|DIALOG|ASIDE|HEADER|NAV|TABLE)$/.test(e.tagName)) return true;
    if (/^(row|dialog|group|toolbar|tabpanel|region|listitem|menu|listbox|alertdialog|tooltip)$/.test(e.getAttribute("role") || "")) return true;
    const cs = getComputedStyle(e);
    if (cs.boxShadow !== "none") return true;
    if (parseFloat(cs.borderTopWidth) > 0 && cs.borderTopStyle !== "none" && parseFloat(cs.borderBottomWidth) > 0) return true;
    const bg = cs.backgroundColor;
    if (bg && bg !== "transparent" && !/rgba\\(.*,\\s*0\\)$/.test(bg)) {
      const p = up(e);
      return !p || getComputedStyle(p).backgroundColor !== bg;
    }
    return false;
  };
  window.__snapFrame = (step, target, vw, vh) => {
    const e = window.__snapFind(step);
    const maxH = Math.min(vh * 0.75, 640), minW = Math.min(Math.max(target.w + 48, 360), vw);
    let pick = null;
    for (let p = e && up(e); p && p !== document.body && p !== document.documentElement; p = up(p)) {
      const q = p.getBoundingClientRect();
      if (q.height > maxH || q.width > vw + 1) break;
      if (q.width < target.w || q.height < target.h) continue;
      if (boxy(p)) { pick = p; if (q.width >= minW) break; }
    }
    if (!pick) return null;
    const q = page(pick.getBoundingClientRect());
    return { x: q.x - 12, y: q.y - 12, w: q.w + 24, h: q.h + 24 };
  };
  /* the outline drawn on the picture: on the page, above everything, never in the way */
  window.__snapOutline = (r, dashed) => {
    let o = document.getElementById("__snap-outline");
    if (!o) { o = document.createElement("div"); o.id = "__snap-outline"; document.documentElement.appendChild(o); }
    o.style.cssText = "position:absolute;pointer-events:none;z-index:2147483647;box-sizing:border-box;border-radius:6px;"
      + "left:" + (r.x - 4) + "px;top:" + (r.y - 4) + "px;width:" + (r.w + 8) + "px;height:" + (r.h + 8) + "px;"
      + "border:2px " + (dashed ? "dashed" : "solid") + " ${OUTLINE};box-shadow:0 0 0 3px rgba(47,123,245,.18);";
  };
  window.__snapUnoutline = () => document.getElementById("__snap-outline")?.remove();
})()`;

/* runs in a blank tab: the two pictures compared pixel by pixel; the changed part as fractions of the picture */
const DIFF = (a, b) => `(async () => {
  const load = (s) => new Promise((r, j) => { const i = new Image(); i.onload = () => r(i); i.onerror = j; i.src = s; });
  const [A, B] = await Promise.all([load(${JSON.stringify(a)}), load(${JSON.stringify(b)})]);
  const w = Math.min(A.width, B.width), h = Math.min(A.height, B.height);
  const px = (img) => { const c = document.createElement("canvas"); c.width = w; c.height = h; const g = c.getContext("2d"); g.drawImage(img, 0, 0); return g.getImageData(0, 0, w, h).data; };
  const p = px(A), q = px(B);
  let n = 0, x0 = w, y0 = h, x1 = -1, y1 = -1;
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
    const i = (y * w + x) * 4;
    if (Math.abs(p[i] - q[i]) + Math.abs(p[i + 1] - q[i + 1]) + Math.abs(p[i + 2] - q[i + 2]) > 40) {
      n++;
      if (x < x0) x0 = x; if (x > x1) x1 = x; if (y < y0) y0 = y; if (y > y1) y1 = y;
    }
  }
  const diff = n > 0 || A.width !== B.width || A.height !== B.height;
  if (n < 4) return JSON.stringify({ same: !diff, chg: null });
  const m = 6;
  x0 = Math.max(0, x0 - m); y0 = Math.max(0, y0 - m); x1 = Math.min(w - 1, x1 + m); y1 = Math.min(h - 1, y1 + m);
  const chg = { x: x0 / w, y: y0 / h, w: (x1 - x0 + 1) / w, h: (y1 - y0 + 1) / h };
  return JSON.stringify({ same: false, chg: chg.w * chg.h > 0.85 ? null : chg }); // nearly all of it: no box to point at
})()`;

async function chrome() {
  const bin = CHROMES.find((p) => fs.existsSync(p));
  if (!bin) throw new Error("no Chrome found for the pictures (set REVIEW_CHROME)");
  const prof = fs.mkdtempSync(path.join(os.tmpdir(), "review-snap-"));
  const port = 9400 + Math.floor(Math.random() * 500);
  const proc = spawn(bin, ["--headless=new", `--remote-debugging-port=${port}`, `--user-data-dir=${prof}`, "--no-first-run", "--hide-scrollbars", "--mute-audio", "about:blank"], { stdio: "ignore" });
  let ok = false;
  for (let i = 0; i < 60 && !ok; i++) {
    try {
      ok = (await fetch(`http://127.0.0.1:${port}/json/version`)).ok;
    } catch {}
    if (!ok) await wait(250);
  }
  if (!ok) {
    proc.kill();
    throw new Error("Chrome did not start for the pictures");
  }
  const close = () => {
    try { proc.kill(); } catch {}
    try { fs.rmSync(prof, { recursive: true, force: true }); } catch {}
  };
  return { port, close };
}
/* one tab: its own CDP connection */
async function tab(port) {
  const t = await (await fetch(`http://127.0.0.1:${port}/json/new?about:blank`, { method: "PUT" })).json();
  const ws = new WebSocket(t.webSocketDebuggerUrl);
  await new Promise((r, j) => ((ws.onopen = r), (ws.onerror = j)));
  let id = 0;
  const waiting = new Map();
  ws.onmessage = (m) => {
    const d = JSON.parse(m.data);
    if (d.id && waiting.has(d.id)) {
      waiting.get(d.id)(d);
      waiting.delete(d.id);
    }
  };
  const send = (method, params = {}) => new Promise((r) => { const i = ++id; waiting.set(i, r); ws.send(JSON.stringify({ id: i, method, params })); });
  const ev = async (expression) => (await send("Runtime.evaluate", { expression, returnByValue: true, awaitPromise: true })).result?.result?.value;
  const json = async (expression) => { const v = await ev(`JSON.stringify(${expression})`); return v ? JSON.parse(v) : null; };
  return { send, ev, json, close: () => { ws.close(); fetch(`http://127.0.0.1:${port}/json/close/${t.id}`).catch(() => {}); } };
}
const union = (rs) => {
  const ok = rs.filter(Boolean);
  if (!ok.length) return null;
  const x = Math.min(...ok.map((r) => r.x)), y = Math.min(...ok.map((r) => r.y));
  return { x, y, w: Math.max(...ok.map((r) => r.x + r.w)) - x, h: Math.max(...ok.map((r) => r.y + r.h)) - y };
};
/* the page as the comment saw it: its size, signed in, its clicks replayed (on the comment's own page only), the state
   asked for; then the spot: the element (or the picked area of it), and the frame to picture it in */
async function open(t, url, c, login, view) {
  const vw = Math.min(Math.max(view.width || c.viewport?.w || 1440, 320), 1920), vh = Math.min(Math.max(c.viewport?.h || 900, 480), 1200);
  await t.send("Page.enable");
  await t.send("Emulation.setDeviceMetricsOverride", { width: vw, height: vh, deviceScaleFactor: 2, mobile: false });
  const pre = [];
  for (const [k, v] of Object.entries(login?.sessionStorage || {})) pre.push(`sessionStorage.setItem(${JSON.stringify(k)}, ${JSON.stringify(typeof v === "string" ? v : JSON.stringify(v))});`);
  for (const [k, v] of Object.entries(login?.localStorage || {})) pre.push(`localStorage.setItem(${JSON.stringify(k)}, ${JSON.stringify(typeof v === "string" ? v : JSON.stringify(v))});`);
  await t.send("Page.addScriptToEvaluateOnNewDocument", { source: `try { ${pre.join(" ")} } catch {}` });
  await t.send("Page.navigate", { url });
  for (let i = 0; i < 40; i++) {
    await wait(250);
    if ((await t.ev("document.readyState")) === "complete") break;
  }
  await wait(2500); // the app draws its data
  await t.ev(FIND);
  const mouse = async (type, x, y) => t.send("Input.dispatchMouseEvent", { type, x, y, button: type === "mouseMoved" ? "none" : "left", clickCount: 1, buttons: type === "mousePressed" ? 1 : 0 });
  const click = async (b) => { await mouse("mouseMoved", b.cx, b.cy); await mouse("mousePressed", b.cx, b.cy); await mouse("mouseReleased", b.cx, b.cy); };
  /* Claude's steps first (how to reach the comment's view: "click Internal", "click All clients"), then the way here
     (clicks on the pages before: a view picked elsewhere), then this page's own clicks. Another page: Claude's only */
  const own = !view.route || view.route === c.route;
  const lead = own ? (c.lead || []).filter((x) => x.kind === "click" || x.kind === "select").map((x) => ({ ...x, lead: true })) : [];
  for (const s of [...(view.steps || c.snapSteps || []).map((x) => ({ ...x, loose: true })), ...lead, ...(own ? (c.trail || []).slice(-12) : [])]) {
    const b = await t.json(`window.__snapBox(${JSON.stringify(s)})`);
    if (s.kind === "key") {
      await t.send("Input.dispatchKeyEvent", { type: "keyDown", key: s.key, code: s.code });
      await t.send("Input.dispatchKeyEvent", { type: "keyUp", key: s.key, code: s.code });
    } else if (!b || (s.lead && b.away)) continue; // not on this page (any more), or a link that would leave it: the next
    else if (s.kind === "click" || s.kind === "dblclick" || s.kind === "contextmenu") await click(b);
    else if (s.kind === "hover") await mouse("mouseMoved", b.cx, b.cy);
    else if (s.kind === "type" || s.kind === "select")
      await t.ev(`(() => { const e = window.__snapFind(${JSON.stringify(s)}); if (!e) return; e.focus?.(); const set = Object.getOwnPropertyDescriptor(e.constructor.prototype, "value")?.set; if (set) set.call(e, ${JSON.stringify(String(s.value ?? ""))}); e.dispatchEvent(new Event("input", { bubbles: true })); e.dispatchEvent(new Event("change", { bubbles: true })); })()`);
    if (process.env.REVIEW_SNAP_DEBUG) console.error(`[snap] ${s.kind} "${String(s.textKey || s.key || "").slice(0, 30)}": ${b ? `at ${Math.round(b.cx)},${Math.round(b.cy)}` : "not found"}`);
    await wait(700);
  }
  await wait(600);
  /* the spot: the element by its address and words, else by Claude's words for it on this page */
  const steps = [{ selector: own ? c.selector : "", textKey: view.target || c.textKey, loose: !!view.target }, ...(c.snapTarget || view.target ? [{ textKey: view.target || c.snapTarget, loose: true }] : [])];
  let step = null, el = null;
  for (const s of steps) if ((el = await t.json(`window.__snapBox(${JSON.stringify(s)})`))) { step = s; break; }
  /* a spot that holds the page's heading (the header band): found by the heading when its address and words miss
     (another page) or land on something much bigger (another build's structure) */
  const headed = c.anchor?.heading && c.rect?.h;
  const tooBig = el && headed && el.h > c.rect.h * 2.5 + 40;
  if (headed && (!el || tooBig)) {
    const s = { head: { heading: own ? c.anchor.heading : "", w: c.rect.w * (vw / (c.viewport?.w || vw)), h: c.rect.h } };
    const got = await t.json(`window.__snapBox(${JSON.stringify(s)})`);
    if (got && got.h <= c.rect.h * 2.5 + 40) { el = got; step = s; }
  }
  /* the state asked for, on the element itself: the pointer over it, the focus ring, or open (clicked) */
  let layer = null;
  const st = view.state || c.snapState;
  if (el && st) {
    const before = await t.ev("window.__snapLayers().length");
    if (st === "hover") await mouse("mouseMoved", el.cx, el.cy);
    else if (st === "focus") await t.ev(`window.__snapFind(${JSON.stringify(step)})?.focus({ focusVisible: true })`);
    else if (st === "open") await click(el);
    await wait(900);
    const now = await t.json(`window.__snapLayers().map((e) => { const r = e.getBoundingClientRect(); return { x: r.left + scrollX, y: r.top + scrollY, w: r.width, h: r.height }; })`);
    if (now && now.length > (before || 0)) layer = union(now.slice(before || 0));
    el = (await t.json(`(() => { const e = window.__snapFind(${JSON.stringify(step)}); if (!e) return null; const r = e.getBoundingClientRect(); return { x: r.left + scrollX, y: r.top + scrollY, w: r.width, h: r.height }; })()`)) || el; // where it is now (no scrolling: a hover stays)
  }
  /* A PICKED AREA: a part of the element, kept as fractions of it */
  const a = own && c.area && el ? { x: el.x + c.area.x * el.w, y: el.y + c.area.y * el.h, w: c.area.w * el.w, h: c.area.h * el.h } : null;
  const target = a || (el ? { x: el.x, y: el.y, w: el.w, h: el.h } : null);
  let frame = null;
  if (a) frame = { x: a.x - 24, y: a.y - 24, w: a.w + 48, h: a.h + 48 };
  else if (target) frame = (await t.json(`window.__snapFrame(${JSON.stringify(step)}, ${JSON.stringify(target)}, ${vw}, ${vh})`)) || { x: target.x - PAD, y: target.y - PAD, w: target.w + PAD * 2, h: target.h + PAD * 2 };
  /* readable in a card: at most 720 wide around the spot (a wider row or panel is cut at its sides), and never a thin
     strip: a wide frame takes in what is above it (the rows before, the header) up to 2.4 wide to 1 tall */
  if (frame && !a) {
    const cx = target.x + target.w / 2;
    /* a spot wider than the card (a full-width header band, a table row): at most about 1040 wide, from its start,
       where its words begin (a centred cut lost the page title) */
    const w = Math.max(MAXW, Math.min(target.w + 48, 1040));
    if (frame.w > w) frame = target.w + 48 > w ? { ...frame, x: Math.max(0, target.x - 24), w } : { ...frame, x: Math.max(frame.x, Math.min(cx - w / 2, frame.x + frame.w - w)), w };
    const h = Math.min(frame.w / 2.4, vh * 0.6, frame.h + 220); // some context, not the whole page
    if (h > frame.h) frame = { ...frame, y: Math.max(0, frame.y + frame.h - h), h }; // upward: the rows above, the header
    /* and never a whole tall panel around a short spot: the spot with some room, more above than below */
    const tall = Math.max(target.h + 160, Math.min(frame.w / 2.4, vh * 0.6));
    if (frame.h > tall && target.h < tall) frame = { ...frame, y: Math.max(0, target.y - (tall - target.h) * 0.6), h: tall };
  }
  if (frame && layer) frame = union([frame, { x: layer.x - 12, y: layer.y - 12, w: layer.w + 24, h: layer.h + 24 }]);
  const docW = (await t.ev("Math.max(document.documentElement.scrollWidth, innerWidth)")) || vw;
  return { target, frame, area: !!a, vw, vh, docW };
}
/* one pair: both pages, the same frame size on both, compared, the target outlined on the pictures */
async function pair(port, staging, preview, c, login, view) {
  const tb = await tab(port);
  await tb.send("Page.bringToFront");
  const b = await open(tb, staging + (view.route || c.route || "/"), c, login, view);
  const ta = await tab(port);
  await ta.send("Page.bringToFront");
  const a = await open(ta, preview + (view.route || c.route || "/"), c, login, view);
  try {
    const found = { before: !!b.target, after: !!a.target };
    const any = b.frame || a.frame;
    const w = any ? Math.ceil(Math.min(Math.max(b.vw, 120), Math.max(b.frame?.w || 0, a.frame?.w || 0, 120))) : b.vw;
    const h = any ? Math.ceil(Math.min(b.vh, Math.max(b.frame?.h || 0, a.frame?.h || 0, 80))) : b.vh;
    /* the spot in about the same place on both: one clip for both, so the two line up and the comparison sees only
       what changed (an element that grew or shrank would shift a clip centred on itself) */
    const near = b.frame && a.frame && Math.abs(b.frame.x - a.frame.x) < 200 && Math.abs(b.frame.y - a.frame.y) < 200;
    const both = near ? union([b.frame, a.frame]) : null;
    const clip = (p, scale) => {
      if (!p.frame) return { x: 0, y: 0, width: p.vw, height: p.vh, scale };
      const f = both || p.frame;
      const cx = f.x + f.w / 2, cy = f.y + f.h / 2;
      return { x: Math.max(0, Math.min(cx - w / 2, p.docW - w)), y: Math.max(0, cy - h / 2), width: w, height: h, scale };
    };
    const shoot = async (t, p, format, scale) => (await t.send("Page.captureScreenshot", { format, ...(format === "jpeg" ? { quality: 88 } : {}), captureBeyondViewport: true, clip: clip(p, scale) })).result.data;
    /* compared first, with nothing drawn on them: plain pixels, at half the size (enough to find the change) */
    await tb.send("Page.bringToFront");
    const pb = await shoot(tb, b, "png", 0.5);
    await ta.send("Page.bringToFront");
    const pa = await shoot(ta, a, "png", 0.5);
    const td = await tab(port); // a blank tab: the app's own rules (its CSP) never block the comparison
    const d = JSON.parse((await td.ev(DIFF(`data:image/png;base64,${pb}`, `data:image/png;base64,${pa}`))) || '{"same":false,"chg":null}');
    td.close();
    /* then the pictures people see, the spot outlined when it sits in a bigger frame */
    const pic = async (t, p) => {
      const ring = p.target && (p.area || p.frame.w > p.target.w + 40 || p.frame.h > p.target.h + 40);
      if (ring) await t.ev(`window.__snapOutline(${JSON.stringify(p.target)}, ${p.area})`);
      await t.send("Page.bringToFront");
      const data = await shoot(t, p, "jpeg", 1);
      if (ring) await t.ev("window.__snapUnoutline()");
      return Buffer.from(data, "base64");
    };
    return { label: view.label || "", route: view.route || c.route || "/", width: view.width || null, state: view.state || c.snapState || null, before: await pic(tb, b), after: await pic(ta, a), w, h, found, chg: d.chg, same: !!d.same };
  } finally {
    tb.close();
    ta.close();
  }
}
export async function snap({ staging, preview, comment: c, login, views, timeout }) {
  const list = (views?.length ? views : [{}]).slice(0, 4);
  const ch = await chrome();
  const timer = setTimeout(() => ch.close(), timeout || 60_000 + 45_000 * list.length);
  try {
    /* one pair after the other: a hidden tab in the back does not take clicks reliably */
    const out = [];
    for (const v of list) out.push(await pair(ch.port, staging, preview, c, login, v));
    return { views: out };
  } finally {
    clearTimeout(timer);
    ch.close();
  }
}
