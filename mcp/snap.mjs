/* BEFORE AND AFTER (step 3, Nirav 2026-11-05): the same spot of a comment's page, as it is now (staging) and as it is on
   Claude's live preview. A hidden Chrome opens both, signs in the way the project says (previewLogin), replays the
   clicks the comment recorded (its trail: a drawer opened, a tab picked), finds the element the comment is pinned to,
   and takes the same-sized picture of it, with some room around it, on both pages.
   snap({ before, after, comment, login }) -> { before, after: jpeg bytes, found: { before, after }, w, h } */
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
const PAD = 48; // room around the element, so it is seen in place

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
  window.__snapFind = (step) => {
    const key = norm(step.textKey).slice(0, 80);
    const hits = step.selector ? queryDeep(step.selector).filter(seen) : [];
    const same = hits.find((e) => !key || txt(e) === key);
    if (same) return same;
    if (key.length >= 3) {
      const pool = Array.from(document.querySelectorAll("button, a, [role], tr, td, th, li, label, summary, input, p, span, div, h1, h2, h3, h4"));
      const byText = pool.filter((e) => seen(e) && txt(e) === key);
      if (byText.length) return byText.sort((a, b) => a.getBoundingClientRect().width * a.getBoundingClientRect().height - b.getBoundingClientRect().width * b.getBoundingClientRect().height)[0];
    }
    return hits[0] || null;
  };
  window.__snapBox = (step) => {
    const e = window.__snapFind(step);
    if (!e) return null;
    e.scrollIntoView({ block: "center", inline: "nearest" });
    const r = e.getBoundingClientRect();
    return { x: r.left + scrollX, y: r.top + scrollY, w: r.width, h: r.height, cx: r.left + r.width / 2, cy: r.top + r.height / 2 };
  };
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
  return { send, ev, close: () => ws.close() };
}
/* the page as the comment saw it: its size, signed in, its clicks replayed */
async function open(t, url, c, login) {
  const vw = Math.min(Math.max(c.viewport?.w || 1440, 360), 1920), vh = Math.min(Math.max(c.viewport?.h || 900, 480), 1200);
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
  for (const s of (c.trail || []).slice(-12)) {
    const b = await t.ev(`JSON.stringify(window.__snapBox(${JSON.stringify(s)}))`).then((v) => (v ? JSON.parse(v) : null));
    if (s.kind === "key") {
      await t.send("Input.dispatchKeyEvent", { type: "keyDown", key: s.key, code: s.code });
      await t.send("Input.dispatchKeyEvent", { type: "keyUp", key: s.key, code: s.code });
    } else if (!b) continue; // a step that is not on this page (any more): the next
    else if (s.kind === "click" || s.kind === "dblclick" || s.kind === "contextmenu") {
      await mouse("mouseMoved", b.cx, b.cy);
      await mouse("mousePressed", b.cx, b.cy);
      await mouse("mouseReleased", b.cx, b.cy);
    } else if (s.kind === "hover") await mouse("mouseMoved", b.cx, b.cy);
    else if (s.kind === "type" || s.kind === "select")
      await t.ev(`(() => { const e = window.__snapFind(${JSON.stringify(s)}); if (!e) return; e.focus?.(); const set = Object.getOwnPropertyDescriptor(e.constructor.prototype, "value")?.set; if (set) set.call(e, ${JSON.stringify(String(s.value ?? ""))}); e.dispatchEvent(new Event("input", { bubbles: true })); e.dispatchEvent(new Event("change", { bubbles: true })); })()`);
    if (process.env.REVIEW_SNAP_DEBUG) console.error(`[snap] ${s.kind} "${String(s.textKey || s.key || "").slice(0, 30)}": ${b ? `at ${Math.round(b.cx)},${Math.round(b.cy)}` : "not found"}`);
    await wait(700);
  }
  await wait(600);
  const box = await t.ev(`JSON.stringify(window.__snapBox(${JSON.stringify({ selector: c.selector, textKey: c.textKey })}))`).then((v) => (v ? JSON.parse(v) : null));
  return { box, vw, vh };
}
export async function snap({ before, after, comment: c, login, timeout = 90_000 }) {
  const ch = await chrome();
  const timer = setTimeout(() => ch.close(), timeout);
  try {
    /* one page after the other: a hidden tab in the back does not take clicks reliably */
    const tb = await tab(ch.port);
    await tb.send("Page.bringToFront");
    const b = await open(tb, before, c, login);
    const ta = await tab(ch.port);
    await ta.send("Page.bringToFront");
    const a = await open(ta, after, c, login);
    /* the same size on both: the larger of the two boxes, with room around; the whole window when the element is gone */
    const w = Math.min(b.vw, Math.ceil(Math.max(b.box?.w || 0, a.box?.w || 0) + PAD * 2));
    const h = Math.min(b.vh, Math.ceil(Math.max(b.box?.h || 0, a.box?.h || 0) + PAD * 2));
    const clip = (r, vw, vh) => {
      if (!r) return { x: 0, y: 0, width: vw, height: vh, scale: 1 };
      const x = Math.max(0, r.x - (w - r.w) / 2), y = Math.max(0, r.y - (h - r.h) / 2);
      return { x, y, width: Math.max(w, 120), height: Math.max(h, 80), scale: 1 };
    };
    const shoot = async (t, r, vw, vh) => Buffer.from((await t.send("Page.captureScreenshot", { format: "jpeg", quality: 88, captureBeyondViewport: true, clip: clip(r, vw, vh) })).result.data, "base64");
    await tb.send("Page.bringToFront");
    const shotB = await shoot(tb, b.box, b.vw, b.vh);
    await ta.send("Page.bringToFront");
    const out = { before: shotB, after: await shoot(ta, a.box, a.vw, a.vh), found: { before: !!b.box, after: !!a.box }, w: b.box || a.box ? Math.max(w, 120) : b.vw, h: b.box || a.box ? Math.max(h, 80) : b.vh };
    tb.close();
    ta.close();
    return out;
  } finally {
    clearTimeout(timer);
    ch.close();
  }
}
