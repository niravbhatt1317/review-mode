/* REVIEW MODE, the in-page half (Nirav, 2026-10-19). Local dev only.
 *
 *   Hold Option (Alt) and move: whatever is under the cursor gets an outline.
 *   Option + click it: a numbered pin drops and a small box asks for the comment. Enter saves, Esc cancels.
 *   On save the tab is photographed as it is right now, the pin and the outline drawn on the picture,
 *   and picture + route + element + text go to .review/sessions/<today>/ through the dev server.
 *   Shift + Option + R: sticky mode (no need to hold Option; every click is a comment) until Esc.
 *
 * Pictures: the first save asks once to share this tab (pick the highlighted tab, "Share"); after that every
 * save grabs a true frame. Decline it and the page is rendered to a canvas instead (close, not pixel exact). */

/* PAGE MODE: served at /__review/, the same panel as the whole page; no app under it, so no pins, no hover, no
   capture. "Go to" leaves for the app with the comment's id in the hash, and the app's overlay opens it on load. */
/* TWO HOSTS. On the console the dev server's collector serves this script and answers /__review/… . Anywhere else
   the browser extension injects it with window.__reviewExt = { project, who, listUrl } and answers the same
   requests through its bridge (rv() below), with pictures as signed links from the hub. */
const EXT = window.__reviewExt || null;
const PAGE_MODE = location.pathname.startsWith("/__review") || (EXT && /-extension:$/.test(location.protocol)); // chrome-extension:, moz-extension:
if (!EXT) {
  /* which session: ?session=_xxx on any page (the page view or the app), kept for the tab so the app's own
     route changes do not drop it. Nothing given means main, the real review. Until 2026-10-21 only the page view
     read it, so drives meant for _test wrote into main. */
  const q = new URLSearchParams(location.search);
  let s = q.get("session");
  try {
    if (s) sessionStorage.setItem("review.session", s);
    else s = sessionStorage.getItem("review.session");
  } catch {}
  if (s && /^_[a-z0-9-]+$/.test(s)) window.__reviewSession = s;
  if (PAGE_MODE) window.__reviewView = q.get("view") === "resolved" ? "resolved" : "open";
} else if (PAGE_MODE) window.__reviewView = new URLSearchParams(location.search).get("view") === "resolved" ? "resolved" : "open";
/* one call, either host: a Response-like answer with json() and text() */
let rvSeq = 0;
const rvWaiting = new Map();
if (EXT) window.addEventListener("message", (e) => {
  if (e.source !== window || e.data?.type !== "review-api-reply") return;
  const w = rvWaiting.get(e.data.id);
  if (!w) return;
  rvWaiting.delete(e.data.id);
  w(e.data);
});
/* the two guarded moves, approving and removing, need the signer's GitHub session (hub/roles.sql): on the dev server
   they go through the extension, which holds it; a test session stays local */
function rv(path, init = {}, viaExt = false) {
  if (!EXT && !(viaExt && extHere() && !window.__reviewSession)) return fetch(path, init);
  const id = ++rvSeq;
  const [p, qs] = String(path).split("?");
  return new Promise((resolve) => {
    rvWaiting.set(id, resolve);
    window.postMessage({ type: "review-api-request", id, path: p, query: qs || "", method: init.method || "GET", body: init.body || null }, "*");
    setTimeout(() => {
      if (rvWaiting.delete(id)) {
        resolve({ ok: false, status: 504, body: { error: "the extension did not answer" } });
        /* an extension that was reloaded or updated no longer hears this page: say so, once */
        if (!window.__reviewStale) {
          window.__reviewStale = true;
          try {
            toast("Review mode was updated: reload this page", true);
          } catch {}
        }
      }
    }, /\/(save|thumb|links)$/.test(p) ? 90_000 : 8_000); // an upload may take a while; a list should not
  }).then((r) => {
    if (r.status === 503 && /reloaded/.test(r.body?.error || "") && !window.__reviewStale) {
      window.__reviewStale = true;
      try {
        toast("Review mode was updated: reload this page", true);
      } catch {}
    }
    return { ok: !!r.ok, status: r.status || (r.ok ? 200 : 500), json: async () => r.body, text: async () => (typeof r.body === "string" ? r.body : JSON.stringify(r.body)) };
  });
}
/* the modifier's name on this machine: ⌥ on a Mac, Alt elsewhere */
const MOD = /Mac|iPhone|iPad/.test(navigator.platform || "") ? "⌥" : "Alt";
const HIDE_KEY = MOD === "⌥" ? "⌥⇧H" : "Alt+Shift+H"; // shows or hides the whole review layer
/* STATUS (2026-10-21): open -> progress (picked up) -> approval (done, for the reviewer) -> approved. Reopen and
   send back move it back. Approved comments leave the pins and the open list. */
const STATUS = { open: "Open", progress: "In progress", approval: "For approval", approved: "Approved" };
/* two kinds (Nirav, 2026-10-23): Fix and Question. Comments made with the old four keep them on the hub and read as
   the new two: Must fix and Should fix are Fix, Idea is a Question */
const SEVERITIES = [
  ["fix", "Fix"],
  ["question", "Question"],
];
const kindOf = (k) => (k === "question" || k === "idea" ? "question" : "fix");

const state = {
  q: "", // the search box at the top of the list
  type: "all", // all, fix, question: the type pill beside it
  status: null, // the status filter (Nirav, 2026-10-23): a Set of open, progress, approval; empty = all; set per persona below
  alt: false,
  sticky: false,
  mouse: { x: -1, y: -1 },
  hover: null,
  pending: null, // { el, rect }
  stream: null,
  video: null,
  comments: [], // the server's list for this session, the open ones (resolved ones live in `done`)
  done: [], // resolved comments: off the pins and the drawer, on the page's Resolved tab
  pinEls: new Map(), // comment id -> resolved element
  pinSeen: new Map(), // comment id -> last visibility check
  declined: false, // the tab share was refused this page load: fall back without asking again
  trail: [], // the clicks (and the hovers that opened something) on this page since the last route change
  lastHover: null, // the app element under the pointer (what a hover card would be hanging from)
  lastClickAt: 0,
  trailRoute: location.pathname,
  flash: null, // { id, until }: the pin to pulse after a go-to
  showPins: (() => { try { return localStorage.getItem("review.pins") !== "off"; } catch { return true; } })(),
  off: (() => { try { return localStorage.getItem("review.on") === "off"; } catch { return false; } })(), // review hidden: nothing on screen, no ⌥-click
  count: 0,
  lastN: 0,
  route: location.pathname,
  capturing: false,
};

/* ---------- host + styles (shadow DOM so the app's CSS and ours never meet) ---------- */
const host = document.createElement("div");
host.id = "__review-host";
/* the UA's popover styles are overridden here (inline beats them): the host is a manual popover so it lives in the
   browser's top layer, above a page's modal <dialog> or popover, which no z-index can reach */
host.style.cssText = "position:fixed;inset:0;z-index:2147483000;pointer-events:none;margin:0;border:0;padding:0;width:auto;height:auto;background:transparent;color:inherit;overflow:visible;";
/* the card's hover strip grows inside the card and makes room once the pointer rests on the card for a moment (the
   default since 2026-10-24, "pushpause"); ?strip=push opens it at once, ?strip=float floats it over the cards below
   (tried, not kept); the choice is remembered */
{
  let strip = new URLSearchParams(location.search).get("strip");
  try {
    if (strip === "push" || strip === "float" || strip === "pushpause") localStorage.setItem("review.strip", strip);
    else strip = localStorage.getItem("review.strip");
  } catch {}
  host.dataset.strip = strip === "float" || strip === "push" ? strip : "pushpause";
}
document.body.appendChild(host);
/* THE TOP LAYER. A page's modal <dialog> (showModal) sits in the browser's top layer, above everything, and makes
   the rest of the page inert: the review layer would be blurred under the backdrop and deaf to clicks (a design
   system's drawer, 2026-10-22). Re-showing a popover does not get above a modal dialog in Chrome, so while a modal
   is open the host moves INSIDE it (a child of the dialog is neither inert nor behind it); it goes back to the body
   when the dialog closes. Outside modals the host is a manual popover, in the top layer above z-index-heavy pages
   and non-modal popovers. Fixed positioning inside a dialog is still the viewport's unless the dialog is
   transformed (a slide-in mid-animation): a frame or two off, then right. */
function asPopover(on) {
  if (!host.showPopover) return;
  try {
    if (on) {
      host.setAttribute("popover", "manual");
      if (!host.matches(":popover-open")) host.showPopover();
    } else {
      if (host.matches(":popover-open")) host.hidePopover();
      host.removeAttribute("popover");
    }
  } catch {}
}
asPopover(true);
/* a dialog with a transform (a drawer slid in), a filter or containment is the reference box for everything fixed
   inside it, and its overflow then clips our layer: those are switched off on the dialog while we are inside, and
   put back when we leave. The dialog is already where its animation left it, so nothing moves. */
const CB_PROPS = { transform: "none", filter: "none", perspective: "none", contain: "none", "will-change": "auto", "backdrop-filter": "none" };
function pinTo(dlg) {
  const cs = getComputedStyle(dlg);
  const kept = {};
  for (const [prop, off] of Object.entries(CB_PROPS)) {
    const v = cs.getPropertyValue(prop);
    if (v && v !== "none" && v !== "auto" && v !== "normal") {
      kept[prop] = [dlg.style.getPropertyValue(prop), dlg.style.getPropertyPriority(prop)];
      dlg.style.setProperty(prop, off, "important");
    }
  }
  dlg.__reviewKept = kept;
}
function unpin(dlg) {
  for (const [prop, [v, prio]] of Object.entries(dlg.__reviewKept || {})) {
    if (v) dlg.style.setProperty(prop, v, prio);
    else dlg.style.removeProperty(prop);
  }
  delete dlg.__reviewKept;
}
/* every open modal dialog, in the page and inside open shadow roots (a web component's drawer keeps its <dialog>
   in its own shadow); the newest one is on top */
const modalSeen = new WeakMap();
let modalSeq = 0;
function modalsIn(root, out, pops) {
  for (const d of root.querySelectorAll("dialog[open]")) if (d.matches(":modal")) out.push(d);
  if (pops) for (const el of root.querySelectorAll(":popover-open")) if (el !== host) pops.push(el);
  for (const el of root.querySelectorAll("*")) if (el.shadowRoot && el !== host) modalsIn(el.shadowRoot, out, pops);
  return out;
}
const popSeen = new WeakSet();
setInterval(() => {
  let modal = null;
  const pops = [];
  for (const d of modalsIn(document, [], pops)) {
    if (d.contains(host)) continue;
    if (!modalSeen.has(d)) modalSeen.set(d, ++modalSeq);
    if (!modal || modalSeen.get(d) > modalSeen.get(modal)) modal = d;
  }
  if (host.parentNode?.matches?.("dialog[open]") && host.parentNode.matches(":modal") && (!modal || modalSeen.get(host.parentNode) >= (modalSeen.get(modal) || 0))) modal = null; // already in the topmost
  const inside = host.parentNode !== document.body;
  if (modal) {
    asPopover(false);
    if (host.parentNode?.__reviewKept) unpin(host.parentNode);
    modal.appendChild(host);
    pinTo(modal);
  } else if (inside && !(host.parentNode?.matches?.("dialog[open]:modal"))) {
    if (host.parentNode?.__reviewKept) unpin(host.parentNode);
    document.body.appendChild(host);
    asPopover(true);
  } else if (!inside && host.showPopover && !host.matches(":popover-open")) asPopover(true); // closed by a page's hidePopover-all: back
  /* a page popover (a menu, a select's list) that opened after us is above us: shown again, we are above it */
  let newer = false;
  for (const el of pops) if (!popSeen.has(el)) { popSeen.add(el); newer = true; }
  if (newer && !inside && host.showPopover) {
    asPopover(false);
    asPopover(true);
  }
}, 500);
const root = host.attachShadow({ mode: "open" });
root.innerHTML = `
<style>
  :host { all: initial;
    /* THEME (Nirav, 2026-10-23): the drawer, the cards, the menus and the page follow the computer's light or dark
       setting, or the switch in the drawer's head (Auto, Light, Dark); the bar, the comment box and the pin cards stay
       dark in both. Both sets are the design system's own values (light :root, dark [data-theme="dark"]), fixed here so a page's theme never leaks in. */
    --rv-surface: #fff; --rv-ink: #1d2b3e; --rv-ink-2: #5b6b85; --rv-ink-3: #8fa0bd;
    --rv-chip: #fff; --rv-chip-ink: #5b6b85; --rv-chip-line: #dbe3ef;
    --rv-st-new: #6626A6; --rv-st-new-dot: #A64DFF; --rv-st-prog: #994200; --rv-st-prog-dot: #FF6F00; --rv-st-appr: #1F7A71; --rv-st-appr-dot: #31BFB0; --rv-st-done: #1B6540; --rv-st-done-dot: #2BA66B; /* the system's purple, orange and teal: 60 for the dots, the text steps for the words (Nirav, 2026-10-23) */
    --rv-fill: #ecf1f9; --rv-line: #e4eaf3; --rv-line-2: #dbe3ef; --rv-hover: #f7fafc; --rv-page: #f6f8fb;
    --rv-bg: 0 0% 100%; --rv-n10: 210 50% 98%; --rv-n20: 217 52% 95%;
    --rv-n30: 220 34.7% 91.9%; --rv-n50: 218 26% 65%; --rv-n70: 216 24% 52%;
    --rv-n90: 218 23% 41%; --rv-n130: 214 36% 18%;
    --rv-ok-bg: 140 52% 91%; --rv-ok-ink: 135 59% 32%;
    --rv-danger-bg: 353 82% 94%; --rv-warn-bg: 40 100% 94%; --rv-warn-ink: 36 95% 32%;
    --tag-must-ink: #b51225; --tag-must-dot: #d92638; --tag-must-fill: #fce3e6;
    --tag-should-ink: #9f6404; --tag-should-dot: #fdb13f; --tag-should-fill: #fff3d6;
    --tag-idea-ink: #1d4ed8; --tag-idea-dot: #2f6fe4; --tag-idea-fill: #e6f1ff;
    --tag-question-ink: #1d4ed8; --tag-question-dot: #2f6fe4; --tag-question-fill: #e6f1ff;
    --tag-fix-ink: #b51225; --tag-fix-dot: #d92638; --tag-fix-fill: #fce3e6;
  }
  /* dark: the design system's own dark theme (@mtdt/nextgen-design-system, [data-theme="dark"]) */
  :host([data-theme="dark"]) {
    --rv-surface: hsl(217.5 63.16% 7.45%); --rv-ink: hsl(220 36.59% 91.96%); --rv-ink-2: hsl(217.83 25.56% 64.71%); --rv-ink-3: hsl(216.67 22.13% 52.16%);
    --rv-st-new: #CC99FF; --rv-st-new-dot: #A64DFF; --rv-st-prog: #FF8629; --rv-st-prog-dot: #FF6F00; --rv-st-appr: #64CEC3; --rv-st-appr-dot: #31BFB0; --rv-st-done: #4CCD8E; --rv-st-done-dot: #2BA66B;
    --rv-chip: hsl(216.36 36.26% 17.84%); --rv-chip-ink: hsl(217.83 25.56% 64.71%); --rv-chip-line: hsl(217.33 23.81% 37.06%);
    --rv-fill: hsl(216.36 36.26% 17.84%); --rv-line: hsl(216.36 36.26% 17.84%); --rv-line-2: hsl(217.33 23.81% 37.06%); --rv-hover: hsl(216.77 40.26% 15.1%); --rv-page: hsl(217.5 63.16% 7.45%);
    --rv-bg: 217.5 63.16% 7.45%; --rv-n10: 216.43 56% 9.8%; --rv-n20: 216.36 36.26% 17.84%; --rv-n30: 216.77 40.26% 15.1%; --rv-n50: 216.67 22.13% 52.16%;
    --rv-n70: 216.67 22.13% 52.16%; --rv-n90: 217.83 25.56% 64.71%; --rv-n130: 217.5 29.27% 83.92%;
    --rv-ok-bg: 181.18 54.84% 18.24%; --rv-ok-ink: 157 59.41% 60.39%; --rv-danger-bg: 332.5 23.08% 20.39%; --rv-warn-bg: 27 19% 21%; --rv-warn-ink: 35 73% 59%;
    --tag-must-ink: #f17a73; --tag-must-dot: #ec5b5b; --tag-must-fill: #402833;
    --tag-should-ink: #e3a44a; --tag-should-dot: #fad100; --tag-should-fill: #40352c;
    --tag-idea-ink: #7fb2e0; --tag-idea-dot: #008cff; --tag-idea-fill: #1d3754;
    --tag-question-ink: #7fb2e0; --tag-question-dot: #008cff; --tag-question-fill: #1d3754;
    --tag-fix-ink: #f17a73; --tag-fix-dot: #ec5b5b; --tag-fix-fill: #402833;
    color-scheme: dark;
  }
  * { box-sizing: border-box; }
  .ui { font: 12px/1.4 -apple-system, BlinkMacSystemFont, "Segoe UI", system-ui, sans-serif; color: #1d2b3e; }
  .hover { position: fixed; pointer-events: none; border: 2px solid #e11d48; border-radius: 4px; box-shadow: 0 0 0 1px #fff, inset 0 0 0 1px #fff; display: none; transition: top .04s, left .04s, width .04s, height .04s; }
  .hover.on { display: block; }
  .hover .tag { position: absolute; left: -2px; top: -24px; background: #1d2b3e; color: #fff; font: 500 11px/20px -apple-system, system-ui, sans-serif; padding: 0 7px; border-radius: 4px 4px 0 0; white-space: nowrap; max-width: 60vw; overflow: hidden; text-overflow: ellipsis; }
  .hover.flip .tag { top: auto; bottom: -24px; border-radius: 0 0 4px 4px; }
  :host([data-composing]) .hover .tag { display: none; } /* the pin's label says it; the outline stays */
  .pin { position: fixed; pointer-events: auto; cursor: default; width: 22px; height: 22px; border-radius: 50%; background: #e11d48; color: #fff; font: 700 11px/22px -apple-system, system-ui, sans-serif; text-align: center; box-shadow: 0 0 0 2px #fff, 0 2px 6px rgba(0,0,0,.25); transform: translate(-8px, -8px); }
  .pin.faded { opacity: .55; }
  .pin-wrap { position: fixed; inset: 0; pointer-events: none; }
  .pin-wrap.ghost .pin-box { border-style: dotted; opacity: .5; }
  .pin-wrap.ghost .pin { opacity: .6; }
  .pin-box { position: fixed; pointer-events: none; border: 1px dashed rgba(225,29,72,.55); border-radius: 4px; }
  .pin:hover { opacity: 1; }
  .pin.flash { opacity: 1; animation: rv-pulse 1s ease-out 3; }
  .pin-box.flash { border: 2px solid #e11d48; animation: rv-pulse 1s ease-out 3; }
  @keyframes rv-pulse { 0% { box-shadow: 0 0 0 0 rgba(225,29,72,.55); } 100% { box-shadow: 0 0 0 14px rgba(225,29,72,0); } }
  .card-n.out { cursor: pointer; }
  .card-n.out:hover { background: var(--rv-ink); color: var(--rv-surface); }
  /* the pin's card: the comment under its pin, dressed like the composer (the same dark surface, the same tag pill,
     the same well for the text). At rest it is the tag and the comment. The hover brings the other tags into the
     pill, the list arrow and the actions row, each fading or sliding in so nothing already shown moves. */
  .pin-tip { position: fixed; pointer-events: auto; z-index: 1; width: 300px; background: hsl(216 36% 18%); color: #fff; border-radius: 10px; padding: 12px; font: 13px/1.45 -apple-system, system-ui, sans-serif; box-shadow: 0 16px 40px rgba(0,0,0,.35); display: none; }
  .pin-tip.on { display: block; }
  .pin-tip .tip-head { display: flex; align-items: center; gap: 8px; margin-bottom: 10px; }
  /* the tag pill (the composer's): the picked one named and first, the other three slide in after it on hover; a
     switch puts the new one first at once (Nirav, 2026-10-21: this over a fixed order and over a glide) */
  .pin-tip .tip-sev { display: inline-flex; align-items: center; gap: 2px; padding: 2px; border-radius: 999px; background: hsl(218 61% 7% / .45); margin-right: auto; }
  .pin-tip .tip-sev button { position: relative; height: 24px; width: 24px; padding: 0; margin: 0; border: 0; border-radius: 999px; background: transparent; color: #fff; font: 500 11px/24px -apple-system, system-ui, sans-serif; display: inline-flex; align-items: center; justify-content: center; cursor: pointer; white-space: nowrap; transition: width .18s ease, opacity .18s ease, margin .18s ease, padding .2s ease, background-color .2s ease; }
  /* the name unfolds beside the dot of the picked one and folds away on the one just left, so a switch glides */
  .pin-tip .tip-sev button .lbl { display: block; max-width: 0; margin-left: 0; overflow: hidden; opacity: 0; transition: max-width .2s ease, margin .2s ease, opacity .15s ease; }
  .pin-tip .tip-sev button.on { order: -1; width: auto; padding: 0 10px 0 8px; background: rgba(255,255,255,.16); cursor: default; }
  .pin-tip .tip-sev button.on .lbl { max-width: 90px; margin-left: 6px; opacity: 1; }
  .pin-tip .tip-sev button:not(.on) { width: 0; margin-left: -2px; opacity: 0; pointer-events: none; }
  .pin-tip:hover .tip-sev button:not(.on), .pin-tip.held .tip-sev button:not(.on) { width: 24px; margin-left: 0; opacity: 1; pointer-events: auto; }
  .pin-tip .tip-sev button:not(.on):hover { background: rgba(255,255,255,.08); }
  .pin-tip .tip-sev button:not(.on):hover .scope-tip { opacity: 1; }
  .pin-tip .tip-sev .dot { width: 8px; height: 8px; border-radius: 50%; flex: 0 0 auto; }
  .pin-tip .tip-sev button[data-k="must"] .dot { background: var(--tag-must-dot); } .pin-tip .tip-sev button[data-k="should"] .dot { background: var(--tag-should-dot); } .pin-tip .tip-sev button[data-k="idea"] .dot { background: var(--tag-idea-dot); } .pin-tip .tip-sev button[data-k="question"] .dot { background: var(--tag-question-dot); }
  .pin-tip .tip-sev button[data-k="fix"] .dot { background: var(--tag-fix-dot); }
  /* the list arrow keeps its slot at rest and fades in */
  .pin-tip .tip-open { width: 24px; height: 24px; padding: 0; margin-right: -4px; border: 0; border-radius: 6px; background: transparent; color: hsl(216 30% 80%); display: inline-flex; align-items: center; justify-content: center; cursor: pointer; opacity: 0; transition: opacity .18s ease; }
  .pin-tip:hover .tip-open, .pin-tip.held .tip-open { opacity: 1; }
  .pin-tip .tip-open:hover { background: rgba(255,255,255,.1); color: #fff; }
  /* the text in the composer's well */
  .pin-tip .tip-text { white-space: pre-wrap; border: 1px solid rgba(255,255,255,.08); border-radius: 8px; padding: 6px 10px; background: hsl(218 61% 7% / .45); cursor: text; outline: none; transition: border-color .12s, box-shadow .12s; }
  .pin-tip .tip-text:hover { border-color: rgba(255,255,255,.18); }
  .pin-tip .tip-note { margin-top: 6px; padding: 4px 10px; border-left: 2px solid hsl(36 95% 32% / .8); font-size: 12px; line-height: 1.4; color: hsl(216 30% 88%); white-space: pre-wrap; overflow-wrap: anywhere; }
  .pin-tip .tip-text[contenteditable="true"] { border-color: hsl(214 98% 44%); box-shadow: 0 0 0 1px hsl(214 98% 44%); }
  /* the actions row unfolds under the text */
  .pin-tip .tip-acts { display: grid; grid-template-rows: 0fr; transition: grid-template-rows .18s ease; }
  .pin-tip:hover .tip-acts, .pin-tip.held .tip-acts { grid-template-rows: 1fr; }
  .pin-tip .tip-acts-in { min-height: 0; overflow: hidden; display: flex; justify-content: flex-end; align-items: center; gap: 4px; }
  .pin-tip .tip-acts button { height: 28px; margin-top: 10px; border: 0; border-radius: 8px; padding: 0 12px; background: transparent; color: hsl(216 30% 80%); font: 500 12px/28px -apple-system, system-ui, sans-serif; cursor: pointer; }
  .pin-tip .tip-acts button:hover { color: #fff; }
  .pin-tip .tip-acts .tip-ok { background: hsl(214 98% 44%); color: #fff; padding: 0 14px; border-radius: 999px; }
  .pin-tip .tip-acts .tip-ok:hover { filter: brightness(1.08); }
  .pin-tip .tip-acts .tip-rm.sure { background: #e11d48; color: #fff; border-radius: 999px; }
  .pin { cursor: pointer; }
  /* the card the pin pointed at, once the list opens on it */
  .card.spot { animation: rv-spot 1.1s ease-out 2; }
  @keyframes rv-spot { 0% { box-shadow: 0 0 0 0 hsl(214 98% 44% / .6); } 100% { box-shadow: 0 0 0 10px hsl(214 98% 44% / 0); } }
  /* the comment box, dark, on the product's own surfaces: the number a pin above it; the place a faint small line;
     the tags first, then the text on a darker well with the info-blue ring; Cancel plain, Save the info-blue pill */
  .composer { position: fixed; pointer-events: auto; width: 320px; background: hsl(216 36% 18%); color: #fff; border-radius: 10px; box-shadow: 0 16px 40px rgba(0,0,0,.35); padding: 12px 12px 12px; display: none; }
  .composer.on { display: block; }
  /* the pin's row, above the box: the blue number, then the place as a small dark label beside it */
  .composer .pin-row { position: absolute; top: -34px; left: 0; display: flex; align-items: center; gap: 6px; max-width: 100%; }
  .composer .num { width: 26px; height: 26px; border-radius: 50%; background: hsl(214 98% 44%); color: #fff; font-weight: 700; font-size: 12px; line-height: 26px; text-align: center; box-shadow: 0 2px 6px rgba(0,0,0,.3), 0 0 0 2px #fff; flex: 0 0 auto; }
  .composer .what { height: 22px; padding: 0 8px; border-radius: 6px; background: hsl(216 36% 18%); color: hsl(216 30% 80%); font: 400 11px/22px -apple-system, system-ui, sans-serif; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; min-width: 0; box-shadow: 0 2px 6px rgba(0,0,0,.25); }
  .composer .what b { font-weight: 600; color: #fff; }
  /* the tags (the Agent Fleet trial's form): the picked one carries its name, the others are dots, named on hover */
  .composer .sev { margin: 0 0 8px; display: inline-flex; gap: 2px; padding: 2px; border-radius: 999px; background: hsl(218 61% 7% / .45); }
  .composer .sev button { position: relative; height: 24px; width: 24px; padding: 0; display: inline-flex; align-items: center; justify-content: center; gap: 6px; border: 0; border-radius: 999px; background: transparent; font: 500 11px/24px -apple-system, system-ui, sans-serif; color: #fff; cursor: pointer; white-space: nowrap; transition: width .15s, padding .15s; }
  .composer .sev button .lbl { display: none; }
  .composer .sev button.on { width: auto; padding: 0 10px 0 8px; background: rgba(255,255,255,.16); }
  .composer .sev button.on .lbl { display: inline; }
  .composer .sev button:not(.on):hover { background: rgba(255,255,255,.08); }
  .composer .sev button:not(.on) .scope-tip { top: calc(100% + 6px); }
  .composer .sev button:not(.on):hover .scope-tip { opacity: 1; }
  .composer .sev .dot { width: 8px; height: 8px; border-radius: 50%; flex: 0 0 auto; }
  .composer .sev button[data-k="must"] .dot { background: var(--tag-must-dot); } .composer .sev button[data-k="should"] .dot { background: var(--tag-should-dot); } .composer .sev button[data-k="idea"] .dot { background: var(--tag-idea-dot); } .composer .sev button[data-k="question"] .dot { background: var(--tag-question-dot); }
  .composer .sev button[data-k="fix"] .dot { background: var(--tag-fix-dot); }
  .composer textarea { width: 100%; min-height: 72px; resize: vertical; border: 1px solid rgba(255,255,255,.08); border-radius: 8px; padding: 8px 10px; background: hsl(218 61% 7% / .45); font: 13px/1.45 -apple-system, system-ui, sans-serif; color: #fff; outline: none; box-sizing: border-box; transition: border-color .12s, box-shadow .12s; }
  .composer textarea::placeholder { color: hsl(216 25% 65%); }
  .composer textarea:focus { border-color: hsl(214 98% 44%); box-shadow: 0 0 0 1px hsl(214 98% 44%); }
  .actions { display: flex; justify-content: flex-end; gap: 4px; align-items: center; margin-top: 10px; }
  .btn { height: 28px; border: 0; background: transparent; color: hsl(216 30% 80%); border-radius: 8px; padding: 0 12px; font: 500 12px/28px -apple-system, system-ui, sans-serif; cursor: pointer; }
  .btn:hover { color: #fff; }
  .btn.primary { background: hsl(214 98% 44%); color: #fff; padding: 0 14px; border-radius: 999px; }
  .btn.primary:hover { filter: brightness(1.08); }
  .btn:disabled { opacity: .5; cursor: default; }
  .bar { position: fixed; left: 0; top: 0; pointer-events: auto; touch-action: none; cursor: grab; user-select: none; display: flex; align-items: center; gap: 6px; height: 38px; background: #1d2b3e; color: #fff; border-radius: 999px; padding: 0 8px 0 14px; box-shadow: 0 6px 20px rgba(0,0,0,.28); white-space: nowrap; }
  .bar.dragging { cursor: grabbing; box-shadow: 0 10px 28px rgba(0,0,0,.35); }
  .bar.hidden { display: none; }
  .bar .dot { width: 8px; height: 8px; border-radius: 50%; background: #e11d48; margin-right: 2px; border: 0; padding: 0; cursor: pointer; }
  .bar .brand { display: inline-flex; align-items: center; gap: 6px; }
  .bar button { position: relative; } /* anchors each tooltip and the count badge */
  /* docked at an edge: a round button with the comment glyph, the status dot and the count */
  .bar-mini { position: fixed; left: 0; top: 0; width: 40px; height: 40px; border-radius: 50%; border: 0; background: #1d2b3e; color: #fff; display: none; align-items: center; justify-content: center; box-shadow: 0 6px 20px rgba(0,0,0,.28); pointer-events: auto; cursor: pointer; touch-action: none; user-select: none; padding: 0; }
  .bar-mini.on { display: inline-flex; animation: rv-pop .28s cubic-bezier(.34,1.56,.64,1); }
  @keyframes rv-pop { from { transform: scale(.5); opacity: 0; } to { transform: none; opacity: 1; } }
  /* the glyph lives a little: the sparkle turns and breathes now and then, and under the pointer; the lines settle in */
  .bar-mini .glyph { overflow: visible; }
  .bar-mini .spark { transform-box: fill-box; transform-origin: center; animation: rv-twinkle 6s ease-in-out infinite; }
  .bar-mini:hover .spark { animation: rv-twinkle 1.2s ease-in-out infinite; }
  @keyframes rv-twinkle { 0%, 78%, 100% { transform: scale(1) rotate(0deg); opacity: 1; } 86% { transform: scale(1.35) rotate(25deg); opacity: .85; } 93% { transform: scale(.85) rotate(45deg); opacity: 1; } }
  .bar-mini .l1, .bar-mini .l2, .bar-mini .l3 { stroke-dasharray: 20; stroke-dashoffset: 0; }
  .bar-mini.on .l1 { animation: rv-draw .5s ease-out both; } .bar-mini.on .l2 { animation: rv-draw .5s .08s ease-out both; } .bar-mini.on .l3 { animation: rv-draw .5s .16s ease-out both; }
  .bar-mini:hover .l1 { animation: rv-draw .4s ease-out both; } .bar-mini:hover .l2 { animation: rv-draw .4s .06s ease-out both; } .bar-mini:hover .l3 { animation: rv-draw .4s .12s ease-out both; }
  @keyframes rv-draw { from { stroke-dashoffset: 20; } to { stroke-dashoffset: 0; } }
  .bar-mini:hover { background: #26364d; }
  .bar-mini .mini-dot { position: absolute; top: 2px; right: 2px; width: 10px; height: 10px; border-radius: 50%; background: #e11d48; box-shadow: 0 0 0 2px #1d2b3e; }
  .bar-mini .mini-dot.live { background: #22c55e; }
  .bar-mini .mini-n { position: absolute; bottom: -4px; right: -4px; min-width: 16px; height: 16px; padding: 0 4px; border-radius: 999px; background: #fff; color: #1d2b3e; font: 600 10px/16px -apple-system, system-ui, sans-serif; text-align: center; box-shadow: 0 1px 3px rgba(0,0,0,.3); display: none; }
  .bar-mini .mini-n.on { display: block; }
  .bar .dot.live { background: #22c55e; cursor: default; }
  .bar b { font-weight: 600; font-size: 12px; }
  .bar .k { color: #9fb0c9; font-size: 12px; margin-left: 4px; }
  /* Pins and List as their own discs beside the bar (Nirav, 2026-10-23), in the satellites' look but always shown:
     the bar itself is only the transparent row; its dark pill is .bar-main */
  .bar { background: transparent; box-shadow: none; padding: 0; gap: 8px; }
  .bar.dragging { box-shadow: none; }
  .bar.dragging .bar-main, .bar.dragging .disc { box-shadow: 0 10px 28px rgba(0,0,0,.35); }
  .bar .bar-main { display: inline-flex; align-items: center; gap: 6px; height: 38px; padding: 0 16px 0 14px; background: #1d2b3e; border-radius: 999px; box-shadow: 0 6px 20px rgba(0,0,0,.28); }
  /* the hide eye and the minimise: their own round discs left of the pill, the eye nearest, floating out only while
     the Review pill is hovered (Nirav, 2026-10-23), sliding and fading in and out; an invisible reach on the pill's
     left lets the pointer cross the gap to them */
  .bar .sat { position: absolute; top: 50%; z-index: 1; width: 30px; height: 30px; margin-top: -15px; padding: 0; border: 0; border-radius: 50%; background: #1d2b3e; color: #cfd8e6; box-shadow: 0 6px 20px rgba(0,0,0,.28); display: inline-flex; align-items: center; justify-content: center; cursor: pointer; opacity: 0; pointer-events: none; transition: opacity .16s ease, transform .22s cubic-bezier(.32,.72,0,1), background-color .12s; }
  .bar .sat.off { right: calc(100% + 8px); transform: translateX(10px) scale(.85); }
  .bar .sat.dock { right: calc(100% + 44px); transform: translateX(46px) scale(.85); }
  .bar:has(.bar-main:hover, .sat:hover, .sat:focus-visible) .sat { opacity: 1; transform: none; pointer-events: auto; }
  .bar .sat:hover::before { content: ""; position: absolute; inset: -10px; border-radius: 50%; } /* bridges the gaps between the discs and the pill */
  .bar .sat:hover { background: #26364d; color: #fff; }
  .bar .bar-main:hover::before { content: ""; position: absolute; top: -8px; bottom: -8px; right: 100%; width: 82px; }
  .bar .sat .scope-tip { top: auto; bottom: calc(100% + 8px); left: 0; transform: none; }
  .bar .sat:hover .scope-tip { opacity: 1; }
  .bar button.disc { width: 38px; height: 38px; padding: 0; border-radius: 50%; background: #1d2b3e; color: #cfd8e6; box-shadow: 0 6px 20px rgba(0,0,0,.28); display: inline-flex; align-items: center; justify-content: center; }
  .bar button.disc:hover { background: #26364d; color: #fff; }
  .bar button.disc.on { background: #fff; color: #1d2b3e; }
  .bar .disc .bi { width: 17px; height: 17px; }
  .bar .disc .scope-tip { top: auto; bottom: calc(100% + 8px); }
  .bar .disc:hover .scope-tip { opacity: 1; }
  .bar .list .count { position: absolute; top: -4px; right: -6px; min-width: 18px; height: 18px; padding: 0 5px; box-sizing: border-box; border-radius: 9px; background: #fff; color: #1d2b3e; font: 600 11px/18px -apple-system, system-ui, sans-serif; text-align: center; box-shadow: 0 0 0 2px #1d2b3e; }
  .bar .list .count:empty { display: none; }
  .bar .list.on .count { background: #1d2b3e; color: #fff; box-shadow: 0 0 0 2px #fff; }
  .bar .sep { width: 1px; height: 18px; background: rgba(255,255,255,.18); margin: 0 4px; }
  .bar button { border: 0; background: transparent; color: #cfd8e6; border-radius: 999px; height: 26px; padding: 0 10px; font: 500 12px/26px -apple-system, system-ui, sans-serif; cursor: pointer; }
  .bar button:hover { background: rgba(255,255,255,.1); color: #fff; }
  .bar button.on { background: #fff; color: #1d2b3e; }
  .bar button.min { width: 28px; padding: 0; display: inline-flex; align-items: center; justify-content: center; color: #9fb0c9; }
  .bar button.min:hover { color: #fff; background: rgba(255,255,255,.1); }
  .bar button.sticky.on { background: #e11d48; color: #fff; }
  .bar button.share { color: #fff; background: #e11d48; }
  .bar button.share.live { background: transparent; color: #9fb0c9; }
  .bar button.share.live::before { content: ""; display: inline-block; width: 6px; height: 6px; border-radius: 50%; background: #22c55e; margin-right: 6px; vertical-align: 1px; }
  .toast { position: fixed; left: 50%; bottom: 62px; transform: translateX(-50%); pointer-events: none; background: #1d2b3e; color: #fff; border-radius: 8px; padding: 6px 12px; opacity: 0; transition: opacity .15s; }
  .toast.on { opacity: 1; }
  .toast.busy::before { content: ""; display: inline-block; width: 10px; height: 10px; border: 2px solid rgba(255,255,255,.35); border-top-color: #fff; border-radius: 50%; margin-right: 10px; vertical-align: -1px; animation: rv-spin .8s linear infinite; }
  @keyframes rv-spin { to { transform: rotate(360deg); } }
  /* the product's drawer: a veil over the page, the sheet sliding in from the right */
  .panel-veil { position: fixed; inset: 0; background: hsl(218 61% 7% / .25); pointer-events: auto; opacity: 0; visibility: hidden; transition: opacity .2s ease-out, visibility 0s linear .2s; z-index: 1; }
  .panel-veil.on { opacity: 1; visibility: visible; transition: opacity .2s ease-out; }
  .panel { position: fixed; top: 0; right: 0; bottom: 0; width: 520px; max-width: 100vw; background: var(--rv-surface); color: var(--rv-ink); box-shadow: -12px 0 32px rgba(29,43,62,.18); pointer-events: auto; display: flex; flex-direction: column; z-index: 2; transform: translateX(100%); visibility: hidden; transition: transform .22s cubic-bezier(.32,.72,0,1), visibility 0s linear .22s; }
  .panel.on { transform: none; visibility: visible; transition: transform .22s cubic-bezier(.32,.72,0,1); }
  .panel-head { position: relative; z-index: 6; display: flex; align-items: center; gap: 8px; padding: 14px 16px 6px; }
  /* the title opens the panel as a page: on hover a dotted underline and the arrow beside it, with the instant tooltip */
  .panel-title { position: relative; display: inline-flex; align-items: center; gap: 5px; margin-right: auto; font-size: 14px; font-weight: 600; color: inherit; text-decoration: none; cursor: pointer; }
  .panel-title .txt { text-decoration: underline dotted transparent; text-underline-offset: 3px; text-decoration-thickness: 1px; transition: text-decoration-color .12s; }
  .panel-title svg { color: hsl(var(--rv-n70)); opacity: 0; transition: opacity .12s; }
  .panel-title:hover .txt { text-decoration-color: hsl(var(--rv-n90)); }
  .panel-title:hover svg { opacity: 1; }
  .panel-title .scope-tip { left: 0; transform: none; }
  .panel-title:hover .scope-tip { opacity: 1; }
  :host([data-page]) .panel-title { pointer-events: none; }
  :host([data-page]) .panel-title svg { display: none; }
  /* the two copy buttons: the products' own marks (Claude's from simple-icons, Loop's own favicon) in a bordered
     square, so they read as buttons; the instant tooltip names what each does */
  .panel-copy { position: relative; display: inline-flex; align-items: center; justify-content: center; width: 26px; height: 26px; padding: 0; border: 1px solid hsl(var(--rv-n30)); border-radius: 6px; background: var(--rv-surface); cursor: pointer; }
  .panel-copy:hover { border-color: hsl(var(--rv-n90)); background: hsl(var(--rv-n10)); }
  /* the marks rest in the panel's grey and take their own colours on hover */
  .panel-copy .logo-claude { fill: hsl(var(--rv-n70)); transition: fill .12s; }
  .panel-copy:hover .logo-claude, .panel-copy.busy .logo-claude, .panel-copy.done .logo-claude { fill: #D97757; }
  .panel-copy .logo-loop-rest { fill: hsl(var(--rv-n70)); }
  .panel-copy .logo-loop { display: none; }
  .panel-copy:hover .logo-loop-rest, .panel-copy.busy .logo-loop-rest, .panel-copy.done .logo-loop-rest { display: none; }
  .panel-copy:hover .logo-loop, .panel-copy.busy .logo-loop, .panel-copy.done .logo-loop { display: block; }
  .panel-copy:hover .scope-tip, .panel-copy.done .scope-tip { opacity: 1; }
  .panel-copy.busy .scope-tip { opacity: 0; }
  .panel-copy .scope-tip { left: auto; right: 0; transform: none; }
  /* while it copies: the border itself is the loading state, a dash in the product's colour running round the square */
  .panel-copy .ring { position: absolute; inset: -1px; width: calc(100% + 2px); height: calc(100% + 2px); display: none; fill: none; stroke: var(--ring); stroke-width: 1.5; stroke-dasharray: 28 72; stroke-linecap: round; animation: rv-ring .9s linear infinite; }
  .panel-copy.busy { pointer-events: none; border-color: hsl(var(--rv-n20)); }
  .panel-copy.busy .ring { display: block; }
  .panel-copy[data-kind="prompt"], .panel-copy[data-kind="send"] { --ring: #D97757; }
  /* the plane: flies off and back in while sending, a tick once Claude has it (Nirav, 2026-10-26) */
  .panel-copy[data-kind="send"] .ring { display: none !important; }
  .send-clip { position: relative; display: grid; place-items: center; width: 24px; height: 24px; margin: -3px; overflow: hidden; border-radius: 6px; } /* room to lift without clipping its nose */
  .send-clip svg { grid-area: 1 / 1; }
  .panel-copy .logo-send { color: hsl(var(--rv-n70)); transition: color .12s, opacity .2s; }
  .panel-copy:hover .logo-send, .panel-copy.busy .logo-send { color: #D97757; }
  /* flying: the plane bobs with three booster lines streaming behind it; sent: it shoots off, the lines stretch, a tick */
  .send-clip .boost { position: absolute; left: 3px; top: 3px; fill: none; stroke: #D97757; stroke-width: 1.6; stroke-linecap: round; opacity: 0; }
  .send-clip .boost path { stroke-dasharray: 5; stroke-dashoffset: 5; }
  .panel-copy.busy .logo-send { animation: rv-lift .35s cubic-bezier(.3,1.4,.5,1) forwards, rv-bob .5s ease-in-out .35s infinite alternate; }
  .panel-copy.busy .boost { opacity: 1; animation: rv-lift .35s cubic-bezier(.3,1.4,.5,1) forwards, rv-bob .5s ease-in-out .35s infinite alternate; } /* the lines go up with it */
  .panel-copy.busy .boost path { animation: rv-boost .42s linear infinite; }
  .panel-copy.busy .boost path:nth-child(2) { animation-delay: .14s; }
  .panel-copy.busy .boost path:nth-child(3) { animation-delay: .28s; }
  @keyframes rv-lift { from { transform: none; } to { transform: translate(1.5px, -1.5px); } } /* takes off: up and to the right */
  @keyframes rv-bob { from { transform: translate(1px, -1px); } to { transform: translate(2px, -2px); } }
  @keyframes rv-boost { 0% { stroke-dashoffset: 5; opacity: 0; } 25% { opacity: 1; } 100% { stroke-dashoffset: -5; opacity: 0; } } /* each line streams out behind, in turn */
  .panel-copy.sent .logo-send { animation: rv-away .38s cubic-bezier(.5,0,.9,.5) forwards; }
  .panel-copy.sent .logo-send { color: #D97757; } /* stays orange as it leaves */
  .panel-copy.sent .boost { opacity: 1; animation: rv-away-trail .38s ease-out forwards; }
  .panel-copy.sent .boost path { stroke-dashoffset: 0; animation: none; } /* the lines streak out with it */
  @keyframes rv-away { 0% { transform: translate(2px, -2px); opacity: 1; } 100% { transform: translate(18px, -18px) scale(.6); opacity: 0; } } /* flies away from where it hovered */
  @keyframes rv-away-trail { 0% { transform: translate(2px, -2px); opacity: 1; } 60% { transform: translate(9px, -9px) scale(1.35); opacity: .8; } 100% { transform: translate(15px, -15px); opacity: 0; } }
  .sent-tick { color: var(--rv-st-done-dot); opacity: 0; }
  .sent-tick path { stroke-dasharray: 1; stroke-dashoffset: 1; }
  .panel-copy.sent .sent-tick { opacity: 1; transition: opacity .1s .3s; }
  .panel-copy.sent .sent-tick path { animation: rv-tick-draw .35s cubic-bezier(.4,0,.2,1) .34s forwards; }
  /* the send sheet, under the head */
  .claude-sheet { flex: 0 0 auto; display: grid; grid-template-rows: 0fr; transition: grid-template-rows .26s cubic-bezier(.22,1,.36,1); }
  .claude-sheet.on { grid-template-rows: 1fr; }
  .claude-sheet > .cs-card { min-height: 0; overflow: hidden; margin: 0 16px; }
  .claude-sheet.on > .cs-card { margin: 12px 16px 2px; padding: 12px 14px; border-radius: 10px; background: var(--rv-surface); box-shadow: 0 0 0 1px hsl(var(--rv-n20)), 0 4px 14px -6px rgba(29,43,62,.18); }
  .cs-head { display: flex; align-items: center; gap: 8px; }
  .cs-head b { flex: 1; font: 600 13px/1.3 -apple-system, system-ui, sans-serif; color: var(--rv-ink); }
  .cs-close { width: 22px; height: 22px; border: 0; border-radius: 6px; background: none; color: var(--rv-ink-3); font-size: 16px; line-height: 1; cursor: pointer; }
  .cs-close:hover { background: hsl(var(--rv-n10)); color: var(--rv-ink); }
  .cs-card p { margin: 6px 0 0 28px; font-size: 12px; line-height: 1.5; color: var(--rv-ink-2); }
  .cs-card .cs-sub { color: var(--rv-ink-3); }
  .cs-spin { width: 18px; height: 18px; flex: 0 0 auto; border-radius: 50%; border: 2px solid hsl(var(--rv-n20)); border-top-color: #D97757; animation: rv-spin .8s linear infinite; }
  .cs-ok { display: grid; place-items: center; width: 20px; height: 20px; flex: 0 0 auto; border-radius: 50%; background: var(--rv-st-done-dot); animation: rv-bulb .35s cubic-bezier(.3,1.5,.5,1) both; }
  .cs-warn { display: grid; place-items: center; width: 20px; height: 20px; flex: 0 0 auto; border-radius: 50%; background: hsl(36 100% 92%); color: hsl(28 90% 40%); font: 700 12px/1 -apple-system, system-ui, sans-serif; }
  :host([data-theme="dark"]) .cs-warn { background: hsl(36 60% 20%); color: hsl(36 100% 70%); }
  .cs-row { display: flex; align-items: center; gap: 8px; margin: 10px 0 0 28px; }
  .cs-row .cs-again { flex: 0 0 auto; height: 32px; }
  .cs-cmd { flex: 1; min-width: 0; display: flex; align-items: center; gap: 6px; padding: 4px 4px 4px 10px; border-radius: 8px; background: hsl(var(--rv-n10)); box-shadow: inset 0 0 0 1px hsl(var(--rv-n20)); }
  .cs-cmd code { flex: 1; min-width: 0; overflow-x: auto; white-space: nowrap; font: 500 11px/1.6 ui-monospace, Menlo, monospace; color: var(--rv-ink); scrollbar-width: none; }
  .cs-copy { display: inline-flex; align-items: center; gap: 4px; flex: 0 0 auto; height: 24px; padding: 0 8px; border: 0; border-radius: 6px; background: var(--rv-surface); box-shadow: 0 0 0 1px hsl(var(--rv-n20)); color: var(--rv-ink-2); font: 500 11px/1 -apple-system, system-ui, sans-serif; cursor: pointer; }
  .cs-copy:hover { color: var(--rv-ink); }
  .cs-copy.done { color: var(--rv-st-done); }
  .cs-acts { display: flex; justify-content: flex-end; margin-top: 10px; }
  .cs-again { height: 26px; padding: 0 12px; border: 0; border-radius: 6px; background: hsl(var(--rv-n20)); color: var(--rv-ink); font: 500 12px/1 -apple-system, system-ui, sans-serif; cursor: pointer; }
  .cs-again:hover { background: hsl(var(--rv-n30)); }
  .claude-pick { position: absolute; z-index: 20; width: 280px; padding: 6px; border-radius: 10px; background: var(--rv-surface); box-shadow: 0 0 0 1px hsl(var(--rv-n20)), 0 12px 28px -8px rgba(29,43,62,.3); }
  .claude-pick .cp-title { padding: 6px 8px 4px; font: 600 11px/1.3 -apple-system, system-ui, sans-serif; color: var(--rv-ink-3); }
  .claude-pick button { display: flex; flex-direction: column; align-items: flex-start; gap: 2px; width: 100%; padding: 7px 8px; border: 0; border-radius: 7px; background: none; text-align: left; cursor: pointer; }
  .claude-pick button:hover, .claude-pick button:focus-visible { background: hsl(var(--rv-n10)); outline: none; }
  .claude-pick b { font: 500 12px/1.3 -apple-system, system-ui, sans-serif; color: var(--rv-ink); }
  .claude-pick span { max-width: 100%; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; font-size: 11px; color: var(--rv-ink-3); }
  .panel-copy[data-kind="loop"] { --ring: #7B3FE4; }
  @keyframes rv-ring { to { stroke-dashoffset: -100; } }
  .panel-copy.done { border-color: hsl(136 53% 43%); box-shadow: 0 0 0 2px hsl(136 53% 43% / .18); }
  .panel-copy .more { position: absolute; top: -3px; right: -4px; display: none; padding: 0 3px; border-radius: 6px; background: #1d2b3e; color: #fff; font: 600 9px/12px -apple-system, system-ui, sans-serif; font-style: normal; }
  .panel-copy .more:not(:empty) { display: block; }
  /* the head is one plane: title and filter together, white, a soft edge below it that deepens once the list scrolls */
  .panel-bar { display: flex; align-items: center; gap: 10px; padding: 6px 16px 12px; border-bottom: 1px solid hsl(var(--rv-n20)); position: relative; z-index: 5; background: var(--rv-surface); transition: box-shadow .15s, border-color .15s; }
  /* the edge and the shadow only once something has gone under the head (the scope band's divider rule) */
  .panel[data-scrolled] .panel-bar { box-shadow: 0 6px 16px -8px rgba(29,43,62,.18); }
  .panel[data-pinned] .panel-bar { box-shadow: none; } /* a group heading pinned under the head brings its own edge (Nirav, 2026-10-24) */
  /* status shapes (Nirav, 2026-10-23): New a circle, In progress a diamond, For approval a square, all the same weight */
  .panel-filter { align-items: center; }
  .group-switch { display: inline-flex; align-items: center; gap: 2px; padding-left: 4px; transition: padding .2s cubic-bezier(.32,.72,0,1); } /* air on the left at rest, where the pill's curve meets the icon */
  .group-switch:hover, .group-switch:has(.side:focus-visible) { padding-left: 0; }
  .status-switch .gs-rule { width: 1px; height: 14px; margin: 0 3px; background: color-mix(in srgb, var(--rv-ink) 14%, transparent); flex: 0 0 auto; }
  .group-switch .side { transition: width .2s cubic-bezier(.32,.72,0,1), margin .2s cubic-bezier(.32,.72,0,1), opacity .15s ease, background-color .12s, color .12s; }
  .group-switch .side:not([aria-pressed="true"]) { width: 0; margin-left: -2px; opacity: 0; pointer-events: none; }
  .group-switch:hover .side, .group-switch:has(.side:focus-visible) .side { width: 24px; margin-left: 0; opacity: 1; pointer-events: auto; }
  .group-switch .side .scope-tip { left: auto; right: 0; transform: none; }
  /* quiet at rest (Nirav, 2026-10-23): the picked grouping is a grey icon, no white lift; the lift comes back while
     the three are open under the pointer */
  .status-switch .group-switch .side[aria-pressed="true"] { background: transparent; box-shadow: none; color: var(--rv-ink-3); }
  .status-switch .group-switch:hover .side[aria-pressed="true"], .status-switch .group-switch:has(.side:focus-visible) .side[aria-pressed="true"] { background: hsl(var(--rv-bg)); box-shadow: 0 1px 2px rgba(29,43,62,.12); color: var(--rv-ink); }
  .group-switch .side svg { stroke-width: 1.7; }
  .status-switch .tag[data-s="progress"] .dot, .card-status[data-s="progress"]::before, .gh-shape[data-s="progress"] { border-radius: 1.5px; transform: rotate(45deg) scale(.91); } /* .91: the diamond looks as big as the square and the circle (Nirav, 2026-10-24) */
  .status-switch .tag[data-s="approval"] .dot, .card-status[data-s="approval"]::before, .gh-shape[data-s="approval"] { border-radius: 2px; }
  .status-switch .all-mark { flex: 0 0 auto; color: var(--rv-ink-2); }
  .status-switch .tag[data-s="all"][aria-pressed="true"] .all-mark { color: var(--rv-ink); }
  .status-switch .tag.quiet[aria-pressed="false"] { opacity: .6; }
  .gh-shape { display: inline-block; width: 7px; height: 7px; border-radius: 50%; margin-right: 7px; flex: 0 0 auto; }
  .gh-shape[data-s="open"] { background: var(--rv-st-new-dot); } .gh-shape[data-s="progress"] { background: var(--rv-st-prog-dot); } .gh-shape[data-s="approval"] { background: var(--rv-st-appr-dot); }
  .list-group { display: flex; align-items: center; width: calc(100% + 4px); margin: 4px -2px 8px; padding: 4px 6px 4px 4px; border: 0; border-radius: 6px; background: transparent; font: 600 11px/1.3 -apple-system, system-ui, sans-serif; color: var(--rv-ink-2); cursor: pointer; text-align: left; }
  .panel-body > .list-sec:first-of-type > .list-group { margin-top: -8px; } /* the first heading sits where the first card would, not lower */
  .panel-body > .join-box + .list-sec > .list-group { margin-top: 4px; } /* under the waiting list the first heading keeps its place, so its ground band does not cover the box's edge and shadow */
  /* pinned while its group scrolls by (Nirav, 2026-10-24); the next group's heading pushes it out */
  .list-group { position: sticky; top: -16px; z-index: 2; background: hsl(var(--rv-n10)); box-shadow: 0 -10px 0 hsl(var(--rv-n10)), 0 6px 8px -6px hsl(var(--rv-n10)); } /* flush with the top edge (the list has 16 px padding), the ground carried up and a soft fade under it */
  .list-group:hover { background: color-mix(in srgb, var(--rv-ink) 5%, hsl(var(--rv-n10))); }
  .list-group:hover { color: var(--rv-ink); }
  .list-group { transition: margin .22s cubic-bezier(.32,.72,0,1), padding .22s cubic-bezier(.32,.72,0,1), border-radius .22s, box-shadow .22s; }
  .list-group.pinned { margin-left: -16px; margin-right: -16px; width: calc(100% + 32px); padding-left: 18px; padding-right: 22px; border-radius: 0; box-shadow: 0 -10px 0 hsl(var(--rv-n10)), 0 1px 0 var(--rv-line), 0 6px 12px -8px rgba(29,43,62,.18); } /* the ground stays solid: a pinned heading must hide what scrolls under it */
  .list-group .lg-chev { flex: 0 0 auto; margin-left: auto; color: var(--rv-ink-3); transition: transform .18s ease; }
  .list-group.folded .lg-chev { transform: rotate(90deg); }
  .list-group.folded + .list-group { margin-top: 0; }
  .gh-type { display: inline-block; width: 7px; height: 7px; border-radius: 50%; margin-right: 7px; }
  .gh-type[data-k="fix"] { background: var(--tag-fix-dot); } .gh-type[data-k="question"] { background: var(--tag-question-dot); }
  .list-group .av { width: 14px; height: 14px; margin: 0 6px 0 0; }
  .list-sec + .list-sec > .list-group { margin-top: 6px; }
  .status-switch .tag[data-s="all"] .dot { background: transparent; box-shadow: inset 0 0 0 2px var(--rv-ink-3); }
  .status-switch .tag[data-s="all"][aria-pressed="true"] .dot { box-shadow: inset 0 0 0 2px var(--rv-ink); }
  .status-switch .tag[data-s="open"] .dot { background: var(--rv-st-new-dot); }
  .status-switch .tag[data-s="progress"] .dot { background: var(--rv-st-prog-dot); }
  .status-switch .tag[data-s="approval"] .dot { background: var(--rv-st-appr-dot); }
  .status-switch .tag[aria-pressed="true"] b { color: var(--rv-ink); }
  .panel-scope { position: relative; flex: 0 0 auto; display: inline-flex; align-items: center; }
  /* the Organizations page's switcher (the scope band's variant a): a 28 pill on neutral-20, two words, the picked
     one lifted white in the primary ink; then the crumb: a 16 mark, the word, a chevron, dotted underline on hover.
     The library's tokens reach the shadow root (custom properties inherit), with fallbacks for safety. */
  .scope-switch { display: inline-flex; align-items: center; height: 28px; padding: 2px; gap: 2px; border-radius: 999px; background: hsl(var(--rv-n20)); flex: 0 0 auto; box-sizing: border-box; }
  .scope-switch .side { position: relative; width: 24px; height: 24px; padding: 0; display: inline-flex; align-items: center; justify-content: center; border: 0; border-radius: 999px; background: transparent; color: hsl(var(--rv-n70)); cursor: pointer; }
  .scope-tip { position: absolute; top: calc(100% + 6px); left: 50%; transform: translateX(-50%); background: #1d2b3e; color: #fff; font: 500 11px/16px -apple-system, system-ui, sans-serif; padding: 4px 8px; border-radius: 4px; white-space: nowrap; pointer-events: none; opacity: 0; transition: opacity .08s; z-index: 3; }
  .scope-switch .side:hover .scope-tip { opacity: 1; }
  /* hover on any side: the white ground without the pressed side's lift, and the ink darkens */
  .scope-switch .side:hover { background: hsl(var(--rv-bg) / .7); color: hsl(var(--rv-n130)); }
  .scope-switch .side[aria-pressed="true"]:hover { background: hsl(var(--rv-bg)); }
  .tag-switch .tag:hover b { color: hsl(var(--rv-n130)); }
  .tag-switch .tag:disabled { cursor: default; background: transparent; }
  .tag-switch .tag:disabled .dot { opacity: .3; }
  .tag-switch .tag:disabled b { color: hsl(var(--rv-n50)); }
  .tag-switch .tag:disabled .scope-tip { display: none; }
  .scope-switch .side[aria-pressed="true"] { background: hsl(var(--rv-bg)); color: var(--rv-ink); box-shadow: 0 1px 2px rgba(29,43,62,.12); }
  /* the crumb: its own pill on the neutral-20 ground, 28 like the switcher, no edge at rest; the edge and the darker
     ink under the pointer or while open. Between the two, the breadcrumb's own "›" in the faint ink */
  .scope-sep { display: inline-flex; align-items: center; color: hsl(var(--rv-n70)); margin: 0 4px; flex: 0 0 auto; }
  .scope-crumb { display: inline-flex; align-items: center; gap: 5px; height: 28px; padding: 0 10px; border: 1px solid transparent; border-radius: 999px; background: hsl(var(--rv-n20)); color: hsl(var(--rv-n90)); font: 500 12px/1 -apple-system, system-ui, sans-serif; cursor: pointer; white-space: nowrap; box-sizing: border-box; }
  .scope-crumb b { font-weight: 500; color: hsl(var(--rv-n70)); }
  .scope-crumb:hover, .scope-crumb[aria-expanded="true"] { border-color: hsl(var(--rv-n90)); color: hsl(var(--rv-n130)); }
  .scope-crumb > svg:last-child { color: hsl(var(--rv-n70)); }
  .scope-menu { position: absolute; top: calc(100% + 6px); left: 76px; width: 300px; max-height: min(360px, calc(100vh - 160px)); overflow: auto; background: var(--rv-surface); border: 1px solid var(--rv-line-2); border-radius: 10px; box-shadow: 0 12px 32px rgba(29,43,62,.18); padding: 6px; z-index: 2; }
  .scope-item { display: flex; align-items: center; justify-content: space-between; gap: 12px; padding: 6px 10px; border-radius: 6px; font-size: 12px; cursor: pointer; color: var(--rv-ink); outline: none; }
  .scope-item b { font-weight: 500; color: var(--rv-ink-3); flex: 0 0 auto; }
  .scope-item:hover, .scope-item:focus { background: var(--rv-hover); }
  .scope-item.on { background: var(--rv-fill); }
  /* the two views, drawn as a distinct two-line block above the places */
  .scope-view { height: 44px; padding: 4px 8px; }
  .scope-view .lines { display: flex; flex-direction: column; gap: 1px; min-width: 0; }
  .scope-view .sub { font-size: 11px; color: var(--rv-ink-3); white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
  .scope-view .mark { width: 26px; height: 26px; border-radius: 6px; background: var(--rv-fill); color: var(--rv-ink); display: inline-flex; align-items: center; justify-content: center; margin-right: 8px; flex: 0 0 auto; }
  /* on the picked row the tile would sink into the row's own fill: it goes dark, the glyph white (the scope list's
     inverted view tiles) */
  .scope-view.on .mark { background: var(--rv-ink); color: var(--rv-surface); }
  .scope-view:hover .mark { background: var(--rv-surface); box-shadow: 0 0 0 1px var(--rv-line); }
  .scope-view.on:hover .mark { background: var(--rv-ink); box-shadow: none; }
  .scope-view .lead { display: flex; align-items: center; min-width: 0; }
  .scope-rule { height: 1px; background: var(--rv-fill); margin: 6px -6px; }
  .scope-group { font-weight: 600; margin-top: 2px; }
  .scope-page { padding-left: 22px; }
  .panel-filter { display: flex; flex-wrap: nowrap; gap: 6px; flex: 0 0 auto; margin-left: auto; }
  .tag-switch .tag { width: auto; padding: 0 9px 0 8px; gap: 5px; font: 500 12px/24px -apple-system, system-ui, sans-serif; color: hsl(var(--rv-n90)); }
  .tag-switch .tag b { font-weight: 500; color: hsl(var(--rv-n70)); }
  .tag-switch .tag[aria-pressed="true"] b { color: hsl(var(--rv-n130)); }
  .tag-switch .dot { width: 8px; height: 8px; border-radius: 50%; background: var(--rv-ink-3); flex: 0 0 auto; }
  /* TRIAL (Nirav, 2026-10-20): once a tag is pressed, the ones left out go quiet: dot and count at half strength */
  .tag-switch[data-narrowed] .tag[aria-pressed="false"] .dot { opacity: .4; }
  .tag-switch[data-narrowed] .tag[aria-pressed="false"] b { color: hsl(var(--rv-n50)); }
  .tag-switch[data-narrowed] .tag[aria-pressed="false"]:hover .dot { opacity: 1; }
  .tag-switch[data-narrowed] .tag[aria-pressed="false"]:hover b { color: hsl(var(--rv-n90)); }
  .tag-switch .tag[data-k="all"] .dot { background: transparent; box-shadow: inset 0 0 0 2px var(--rv-ink-3); }
  .tag-switch .tag[data-k="all"][aria-pressed="true"] .dot { box-shadow: inset 0 0 0 2px var(--rv-ink); }
  .tag-switch .tag[data-k="must"] .dot { background: var(--tag-must-dot); } .tag-switch .tag[data-k="should"] .dot { background: var(--tag-should-dot); } .tag-switch .tag[data-k="idea"] .dot { background: var(--tag-idea-dot); } .tag-switch .tag[data-k="question"] .dot { background: var(--tag-question-dot); }
  .tag-switch .tag[data-k="fix"] .dot { background: var(--tag-fix-dot); }
  /* the list is a well: the neutral-10 ground, the cards white on it */
  .panel-body { position: relative; z-index: 1; overflow: auto; padding: 16px 16px 72px; /* the last line clears the bar's band at the end of the list */ flex: 1; background: hsl(var(--rv-n10)); }
  /* the list's bar (Nirav, 2026-10-23, iOS style): floating at the bottom of the drawer in frosted-glass capsules; the
     type words on the left, a round search on the right that opens across the bar when tapped (the type capsule
     steps aside) and folds back when left empty */
  .panel-tools { position: absolute; left: 16px; right: 16px; bottom: 16px; z-index: 3; display: flex; align-items: center; justify-content: space-between; gap: 8px; pointer-events: none; }
  .panel-tools > * { pointer-events: auto; }
  .panel-tools { transition: transform .32s cubic-bezier(.32,.72,0,1), opacity .22s ease; }
  .panel-tools.away { transform: translateY(calc(100% + 24px)); opacity: 0; }
  /* a soft fade of the list's well behind the bar while it shows, so the cards dissolve under it (Nirav, 2026-10-23) */
  .panel-tools::before { content: ""; position: absolute; left: -16px; right: -16px; bottom: -16px; height: 76px; z-index: -1; pointer-events: auto; background: linear-gradient(to bottom, hsl(var(--rv-n10) / 0) 0%, hsl(var(--rv-n10) / .3) 22%, hsl(var(--rv-n10) / .7) 42%, hsl(var(--rv-n10) / .93) 62%, hsl(var(--rv-n10)) 80%); -webkit-backdrop-filter: blur(6px); backdrop-filter: blur(6px); -webkit-mask-image: linear-gradient(to bottom, transparent, #000 45%); mask-image: linear-gradient(to bottom, transparent, #000 45%); }
  /* dark: the earlier plain fade (Nirav, 2026-10-23: the blurred one looked odd), a touch longer at the top */
  :host([data-theme="dark"]) .panel-tools::before { background: linear-gradient(to bottom, hsl(var(--rv-n10) / 0), hsl(var(--rv-n10) / .5) 30%, hsl(var(--rv-n10) / .85) 60%, hsl(var(--rv-n10))); -webkit-backdrop-filter: none; backdrop-filter: none; -webkit-mask-image: none; mask-image: none; }
  .panel-tools.away > * { pointer-events: none; }
  .panel-tools.away::before { pointer-events: none; } /* the faded band takes the pointer only while it shows: nothing under it opens by accident */
  .glass { height: 30px; border-radius: 999px; background: color-mix(in srgb, var(--rv-surface) 72%, transparent); -webkit-backdrop-filter: blur(18px) saturate(1.6); backdrop-filter: blur(18px) saturate(1.6); border: 1px solid rgba(29,43,62,.09); box-shadow: 0 6px 18px rgba(29,43,62,.14), 0 1px 2px rgba(29,43,62,.06), inset 0 1px 0 rgba(255,255,255,.35); }
  :host([data-theme="dark"]) .glass { background: color-mix(in srgb, hsl(217 40% 16%) 70%, transparent); border-color: rgba(255,255,255,.1); box-shadow: 0 8px 22px rgba(0,0,0,.4); } /* one edge only: no inner highlight in dark */
  .pt-search { flex: 0 0 auto; width: 84px; display: flex; align-items: center; gap: 6px; padding: 0 0 0 10px; color: var(--rv-ink-2); cursor: pointer; overflow: hidden; transition: width .3s cubic-bezier(.32,.72,0,1), flex-grow .3s; }
  .pt-search svg:first-child { flex: 0 0 auto; width: 13px; height: 13px; }
  .pt-search:hover { color: var(--rv-ink); }
  .pt-search input { flex: 1; min-width: 0; height: 100%; border: 0; outline: none; background: transparent; color: var(--rv-ink); font: 12px/1 -apple-system, system-ui, sans-serif; cursor: pointer; }
  .pt-search input::placeholder { color: var(--rv-ink-2); }
  .pt-search input::-webkit-search-cancel-button { display: none; }
  .panel-tools:has(.pt-search:focus-within) .pt-search, .panel-tools.has-q .pt-search { flex: 1 1 auto; width: 100%; cursor: text; padding-right: 6px; }
  .panel-tools:has(.pt-search:focus-within) .pt-search input, .panel-tools.has-q .pt-search input { cursor: text; }
  /* the shortcut in the search's instant tooltip, not in the pill (the pill clips, so the tip sits on the bar) */
  .panel-tools .pt-tip { top: auto; bottom: calc(100% + 8px); left: 0; transform: none; display: inline-flex; align-items: center; gap: 6px; }
  .panel-tools .pt-tip kbd { display: inline-flex; align-items: center; justify-content: center; min-width: 15px; height: 15px; padding: 0 3px; border: 1px solid rgba(255,255,255,.35); border-radius: 4px; font: 500 10px/1 -apple-system, system-ui, sans-serif; }
  .panel-tools:has(.pt-search:hover):not(:has(.pt-search:focus-within)):not(.has-q) .pt-tip { opacity: 1; }
  .pt-clear { display: none; flex: 0 0 auto; width: 20px; height: 20px; padding: 0; border: 0; border-radius: 50%; background: transparent; color: var(--rv-ink-3); align-items: center; justify-content: center; cursor: pointer; }
  .pt-clear:hover { background: var(--rv-fill); color: var(--rv-ink); }
  .panel-tools.has-q .pt-clear { display: inline-flex; }
  .type-pick { display: inline-flex; align-items: center; gap: 0; padding: 0 3px; flex: 0 1 auto; min-width: 0; overflow: hidden; transition: opacity .2s, max-width .3s cubic-bezier(.32,.72,0,1), padding .3s; max-width: 320px; }
  .panel-tools:has(.pt-search:focus-within) .type-pick, .panel-tools.has-q .type-pick { max-width: 0; padding: 0; opacity: 0; border-width: 0; }
  .type-pick .tp { display: inline-flex; align-items: center; gap: 5px; height: 24px; padding: 0 9px; border: 0; border-radius: 999px; background: transparent; color: var(--rv-ink-2); font: 400 12px/1 -apple-system, system-ui, sans-serif; cursor: pointer; white-space: nowrap; transition: background-color .15s, color .15s; }
  /* the capsule with words only (Nirav, 2026-10-23): no dots, no icons; the picked one on a soft fill */
  .type-pick .tp[aria-pressed="true"][data-k="fix"] .ti { color: var(--tag-fix-dot); }
  .type-pick .tp[aria-pressed="true"][data-k="question"] .ti { color: var(--tag-question-dot); }
  .type-pick .tp b { font-weight: 400; color: var(--rv-ink-3); opacity: .8; }
  .type-pick .tp:hover:not(:disabled) { background: color-mix(in srgb, var(--rv-ink) 5%, transparent); color: var(--rv-ink); }
  .type-pick .tp:hover:not(:disabled) b { color: var(--rv-ink-2); }
  .type-pick .tp[aria-pressed="true"] { background: color-mix(in srgb, var(--rv-ink) 9%, transparent); color: var(--rv-ink); }
  .type-pick .tp[aria-pressed="true"] b { color: var(--rv-ink); opacity: 1; }
  .type-pick .tp:disabled { opacity: .4; cursor: default; }
  .panel-empty { color: var(--rv-ink-3); padding: 24px 8px; text-align: center; }
  .card { border: 1px solid var(--rv-fill); border-radius: 10px; padding: 9px 14px 9px; margin-bottom: 16px; background: var(--rv-surface); }
  .card.here { border-color: var(--rv-line-2); }
  .card-n { width: 22px; height: 22px; border-radius: 50%; background: var(--rv-surface); box-shadow: 0 1px 2px rgba(29,43,62,.06); color: var(--rv-ink); font-weight: 600; font-size: 11px; line-height: 22px; text-align: center; flex: 0 0 auto; }
  .card-n.away { color: var(--rv-ink-3); }
  .card-sev { font-size: 11px; font-weight: 600; padding: 2px 8px; border-radius: 999px; background: var(--rv-fill); color: var(--rv-ink-2); cursor: pointer; border: 0; }
  .card-sev[data-k="must"] { background: var(--tag-must-fill); color: var(--tag-must-ink); } .card-sev[data-k="should"] { background: var(--tag-should-fill); color: var(--tag-should-ink); } .card-sev[data-k="idea"] { background: var(--tag-idea-fill); color: var(--tag-idea-ink); } .card-sev[data-k="question"] { background: var(--tag-question-fill); color: var(--tag-question-ink); }
  .card-sev[data-k="fix"] { background: var(--tag-fix-fill); color: var(--tag-fix-ink); }
  .card-text { font-size: 14px; line-height: 1.5; color: var(--rv-ink); margin: 0 0 10px; white-space: pre-wrap; border-radius: 6px; padding: 2px 4px; margin-left: -4px; box-shadow: 0 0 0 1px transparent; }
  .card-text.ro, .card-text.ro:hover { cursor: default; background: transparent; box-shadow: none; }
  .card-text:hover { background: hsl(var(--rv-n10)); box-shadow: 0 0 0 1px var(--rv-line); }
  .card-text[contenteditable="true"] { background: var(--rv-surface); outline: 2px solid #2563eb; outline-offset: 0; }
  .card-shot { display: block; width: 100%; border: 1px solid var(--rv-fill); border-radius: 6px; cursor: zoom-in; }
  .card-c { position: relative; margin-left: 32px; }
  .card-c .card-pic { position: relative; container-type: inline-size; }
  /* the picture's slot while it loads (Nirav, 2026-10-25) */
  .card-c .card-pic:not(.ready) { aspect-ratio: var(--ar, 16 / 10); border-radius: 6px; overflow: hidden; background: linear-gradient(100deg, hsl(var(--rv-n10)) 30%, hsl(var(--rv-n20)) 50%, hsl(var(--rv-n10)) 70%) 0 0 / 300% 100%; animation: rv-shimmer 1.3s ease-in-out infinite; }
  .card-c .card-pic:not(.ready) .card-shot { opacity: 0; }
  .card-c .card-pic.ready .card-shot { animation: rv-fx-fade .3s ease-out; }
  .card-c .card-pic.broken { animation: none; background: hsl(var(--rv-n10)); display: grid; place-items: center; }
  .card-c .card-pic.broken::after { content: ""; width: 22px; height: 22px; opacity: .45; background: no-repeat center / contain url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 24 24' fill='none' stroke='%238a96a8' stroke-width='1.8' stroke-linecap='round' stroke-linejoin='round'%3E%3Crect x='3' y='4' width='18' height='16' rx='2.5'/%3E%3Ccircle cx='9' cy='10' r='1.6'/%3E%3Cpath d='M21 16l-5-5-8 9'/%3E%3C/svg%3E"); }
  .card-c .card-pic.broken .card-shot { display: none; }
  @keyframes rv-shimmer { from { background-position: 100% 0; } to { background-position: 0 0; } }
  @keyframes rv-fx-fade { from { opacity: 0; } to { opacity: 1; } }
  /* loading placeholders and empty states */
  .list-more .skel-card { margin-top: 0; }
  .skel-card { display: flex; flex-direction: column; gap: 9px; margin: 0 0 16px 32px; padding: 14px; border-radius: 10px; background: var(--rv-surface); box-shadow: 0 1px 2px rgba(29,43,62,.06); }
  .sk { display: block; border-radius: 6px; background: linear-gradient(100deg, hsl(var(--rv-n10)) 30%, hsl(var(--rv-n20)) 50%, hsl(var(--rv-n10)) 70%) 0 0 / 300% 100%; animation: rv-shimmer 1.3s ease-in-out infinite; }
  .sk-line { height: 11px; }
  .sk-pic { height: 120px; margin-top: 2px; }
  .sk-foot { display: flex; align-items: center; gap: 8px; margin-top: 2px; }
  .sk-dot { width: 16px; height: 16px; border-radius: 50%; flex: 0 0 auto; }
  .sk-foot .sk-line { height: 9px; }
  .empty-state { display: flex; flex-direction: column; align-items: center; gap: 6px; padding: 48px 24px 32px; text-align: center; }
  .empty-state .empty-art { overflow: visible; margin-bottom: 10px; --art-fill: var(--rv-surface); --art-line: hsl(var(--rv-n50)); --art-soft: hsl(var(--rv-n20)); --art-ink: #1d2b3e; animation: rv-art-in .5s cubic-bezier(.22,1,.36,1) both; }
  :host([data-theme="dark"]) .empty-state .empty-art { --art-fill: hsl(var(--rv-n10)); --art-line: hsl(var(--rv-n50)); --art-soft: hsl(var(--rv-n20)); --art-ink: #e6edf7; }
  @keyframes rv-art-in { from { opacity: 0; transform: translateY(6px); } to { opacity: 1; transform: none; } }
  /* an empty view stays: its extras keep going, gently, and the face blinks now and then (Nirav, 2026-10-25) */
  .empty-state :is(.f-sparkle, .f-star3, .f-heart, .f-glimmer, .f-twinkle) { animation-duration: 2.6s; animation-iteration-count: infinite; }
  .empty-state .f-confetti { animation-duration: 3.2s; animation-iteration-count: infinite; }
  .empty-state .f-blink { animation: rv-blink-idle 4.5s ease-in-out 1s infinite; }
  @keyframes rv-blink-idle { 0%, 94%, 100% { transform: none; } 97% { transform: scaleY(.1); } }
  .empty-state b { font: 600 14px/1.3 -apple-system, system-ui, sans-serif; color: var(--rv-ink); }
  .empty-state span { font-size: 12px; line-height: 1.5; color: var(--rv-ink-3); max-width: 260px; }
  /* the number, drawn live over the picture at the badge's own spot (the same geometry the baked ones had, so it
     covers them exactly); sized in container units so it scales with the picture */
  .pic-n { position: absolute; transform: translate(-50%, -50%); border-radius: 50%; background: #e11d48; color: #fff; font-weight: 700; text-align: center; box-shadow: 0 0 0 0.15em #fff; pointer-events: none; display: flex; align-items: center; justify-content: center; }
  /* the tag on the picture: a 22 pill holding the tag's dot; it grows to show its name under the pointer, and a click
     still cycles it */
  /* the type marker on the picture, small and quiet (Nirav, 2026-10-23): a 16 px pill, a 6 px dot, a hairline */
  .card-c .card-sev.on-pic { position: absolute; top: 6px; right: 6px; display: inline-flex; align-items: center; height: 16px; padding: 0 5px; font-size: 10px; border-radius: 999px; box-shadow: 0 0 0 1px rgba(29,43,62,.08); background: var(--rv-surface); transition: padding .15s; }
  .card-c .card-by-pic { position: absolute; top: 6px; left: 6px; display: inline-flex; align-items: center; height: 18px; padding: 0 1px; border-radius: 999px; background: var(--rv-surface); box-shadow: 0 0 0 1px rgba(29,43,62,.08); color: var(--rv-ink-2); font: 500 10px/1 -apple-system, system-ui, sans-serif; transition: padding .15s; cursor: default; }
  .card-c .card-by-pic .av { width: 16px; height: 16px; margin: 0; vertical-align: 0; }
  .card-c .card-by-pic .by-clock { margin: 0 3px; color: var(--rv-ink-3); }
  .card-c .card-by-pic .lbl { max-width: 0; overflow: hidden; white-space: nowrap; opacity: 0; margin-left: 0; transition: max-width .18s ease, opacity .12s ease, margin-left .18s ease; }
  .card-c .card-by-pic:hover { padding: 0 7px 0 1px; }
  .card-c .card-by-pic:hover .lbl { max-width: 180px; opacity: 1; margin-left: 5px; }
  .card-c .card-sev.on-pic .dot { width: 6px; height: 6px; border-radius: 50%; flex: 0 0 auto; }
  .card-c .card-sev.on-pic .lbl { max-width: 0; overflow: hidden; white-space: nowrap; opacity: 0; margin-left: 0; transition: max-width .18s ease, opacity .12s ease, margin-left .18s ease; }
  .card-c .card-sev.on-pic:hover { padding: 0 7px 0 5px; }
  .card-c .card-sev.on-pic:hover .lbl { max-width: 96px; opacity: 1; margin-left: 4px; }
  .card-c .card-sev.on-pic[data-k="must"] { background: var(--tag-must-fill); } .card-c .card-sev.on-pic[data-k="must"] .dot { background: var(--tag-must-dot); }
  .card-c .card-sev.on-pic[data-k="fix"] { background: var(--tag-fix-fill); } .card-c .card-sev.on-pic[data-k="fix"] .dot { background: var(--tag-fix-dot); }
  .card-c .card-sev.on-pic[data-k="should"] { background: var(--tag-should-fill); } .card-c .card-sev.on-pic[data-k="should"] .dot { background: var(--tag-should-dot); }
  .card-c .card-sev.on-pic[data-k="idea"] { background: var(--tag-idea-fill); } .card-c .card-sev.on-pic[data-k="idea"] .dot { background: var(--tag-idea-dot); }
  .card-c .card-sev.on-pic[data-k="question"] { background: var(--tag-question-fill); } .card-c .card-sev.on-pic[data-k="question"] .dot { background: var(--tag-question-dot); }
  .card-medium .card-text { font-weight: 500; line-height: 1.35; }
  /* a corner accent in the tag's colour: a fine arc hugging the top-left corner whose two legs fade out,
     over a faint wash of the same colour in the corner */
  .card-c.card-rail { --accent: var(--rv-ink-3); }
  .card-c.card-rail[data-k="must"] { --accent: var(--tag-must-dot); } .card-c.card-rail[data-k="should"] { --accent: var(--tag-should-dot); } .card-c.card-rail[data-k="idea"] { --accent: var(--tag-idea-dot); } .card-c.card-rail[data-k="question"] { --accent: var(--tag-question-dot); }
  .card-c.card-rail[data-k="fix"] { --accent: var(--tag-fix-dot); }
  /* the arc is a tapered shape (2px at the corner, nothing at the ends) cut out of the accent colour by an SVG
     mask that also fades it along both legs */
  .card-c.card-rail::before { content: ""; position: absolute; top: -1px; left: -1px; width: 56px; height: 56px; pointer-events: none; background: var(--accent); -webkit-mask: url("data:image/svg+xml,<svg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 56 56'><defs><linearGradient id='g' gradientUnits='userSpaceOnUse' x1='0' y1='0' x2='30' y2='30'><stop offset='0' stop-color='%23fff'/><stop offset='1' stop-color='%23fff' stop-opacity='0'/></linearGradient></defs><path d='M0 56 V10 A10 10 0 0 1 10 0 H56 L10 2.2 A7.8 7.8 0 0 0 2.2 10 Z' fill='url(%23g)'/></svg>") no-repeat 0 0 / 56px 56px; mask: url("data:image/svg+xml,<svg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 56 56'><defs><linearGradient id='g' gradientUnits='userSpaceOnUse' x1='0' y1='0' x2='30' y2='30'><stop offset='0' stop-color='%23fff'/><stop offset='1' stop-color='%23fff' stop-opacity='0'/></linearGradient></defs><path d='M0 56 V10 A10 10 0 0 1 10 0 H56 L10 2.2 A7.8 7.8 0 0 0 2.2 10 Z' fill='url(%23g)'/></svg>") no-repeat 0 0 / 56px 56px; }
  .card-c.card-rail::after { content: ""; position: absolute; top: -1px; left: -1px; width: 96px; height: 52px; pointer-events: none; border-top-left-radius: 10px; background: radial-gradient(ellipse 96px 52px at 0 0, color-mix(in srgb, var(--accent) 11%, transparent) 0, transparent 100%); }
  .card-c.card-rail-right::before { left: auto; right: -1px; transform: scaleX(-1); }
  /* mirrored with scaleX(-1), so the element's top-LEFT radius lands on the card's top-right corner */
  .card-c.card-rail-right::after { left: auto; right: -1px; border-top-left-radius: 10px; transform: scaleX(-1); }
  .card.card-fill, .card.here.card-fill { border-color: transparent; background: var(--rv-surface); box-shadow: 0 1px 2px rgba(29,43,62,.06); }
  /* dark only: a hairline in the design system's border colour, so the cards stand off the dark well (Nirav, 2026-10-23) */
  :host([data-theme="dark"]) .card.card-fill { border-color: hsl(216.77 40.26% 15.1%); }
  :host([data-theme="dark"]) .card.card-fill:not(.picked):not(.failed) { box-shadow: none; }
  :host([data-theme="dark"]) .card.card-fill.picked { box-shadow: 0 0 0 2px hsl(214 98% 44% / .45); }
  .card-fill .card-shot { border-color: var(--rv-line); }
  .card-fill .card-rm { background: transparent; }
  .card-c .card-line { margin-bottom: 10px; }
  /* TRY (Nirav, 2026-10-23): under the pointer the card grows a light strip at its foot with who raised it and where;
     the foot keeps the status and the actions. To go back: the face on the picture (byPicHtml) and the where in footHtml */
  .card-foot .where { display: none; }
  /* THE STRIP FLOATS (Nirav, 2026-10-24, after Google's cards): it hangs below the card over the cards under it, so a
     hover never moves the list; the card's bottom corners square off while it is out, so the two read as one */
  /* two ways, the first the default: the strip grows inside the card and pushes the list; ?strip=float floats it over the
     cards below (tried 2026-10-24, not kept); the choice is remembered (localStorage review.strip) */
  /* closing: the words fade out first, then the strip folds, so they never slide up under the status or the note
     (Nirav, 2026-10-24); opening: the strip grows, then the words fade in */
  .card-meta { display: grid; grid-template-rows: 0fr; border-radius: 0 0 10px 10px; transition: grid-template-rows .32s cubic-bezier(.4,0,.2,1) .05s, margin .32s cubic-bezier(.4,0,.2,1) .05s; } /* a gentle in-out over a third of a second (Nirav, 2026-10-24: smoother) */
  .card:is(:hover, :focus-visible, :has(:focus-visible), .menu-open, .hist-open) .card-meta { grid-template-rows: 1fr; transition: grid-template-rows .32s cubic-bezier(.4,0,.2,1), margin .32s cubic-bezier(.4,0,.2,1); }
  .card:is(:hover, :focus-visible, :has(:focus-visible), .menu-open, .hist-open) .card-meta-in { opacity: 1; padding: 9px 15px; transform: none; transition: opacity .24s ease .1s, padding .32s cubic-bezier(.4,0,.2,1), transform .32s cubic-bezier(.4,0,.2,1) .06s; }
  :host([data-strip="float"]) .card-meta { position: absolute; left: -1px; right: -1px; top: 100%; pointer-events: none; }
  :host([data-strip="float"]) .card:is(:hover, :focus-visible, :has(:focus-visible), .menu-open, .hist-open) { z-index: 3; border-bottom-left-radius: 0; border-bottom-right-radius: 0; }
  :host([data-strip="float"]) .card:is(:hover, :focus-visible, :has(:focus-visible), .menu-open, .hist-open) .card-meta { pointer-events: auto; }
  /* one outline round the card and its strip while it floats (Nirav, 2026-10-24: the near-white strip blended into the
     card under it): the card's sides and top, the strip's sides and bottom, nothing where they meet */
  :host([data-strip="float"]:not([data-theme="dark"])) .card.card-fill:is(:hover, :focus-visible, :has(:focus-visible), .menu-open, .hist-open) { border-color: var(--rv-line-2); border-bottom-color: transparent; }
  :host([data-strip="float"]:not([data-theme="dark"])) .card-meta-in { box-shadow: inset 1px 0 0 var(--rv-line-2), inset -1px 0 0 var(--rv-line-2), inset 0 -1px 0 var(--rv-line-2), 0 16px 32px -6px rgba(29,43,62,.2), 0 3px 8px -2px rgba(29,43,62,.08); } /* a deeper shadow, the strip's own colour kept (Nirav, 2026-10-24) */ /* lifted a little off the cards under it (Nirav, 2026-10-24); the negative spread keeps it below, off the card */
  :host([data-strip="float"][data-theme="dark"]) .card-meta-in { box-shadow: inset 1px 0 0 hsl(216.77 40.26% 15.1%), inset -1px 0 0 hsl(216.77 40.26% 15.1%), inset 0 -1px 0 hsl(216.77 40.26% 15.1%), 0 12px 22px -8px rgba(0,0,0,.6); } /* the card's own edge, so the strip does not melt into the card under it (dark keeps its drawn edge) */
  :host([data-strip="float"]) .list-group.pinned { z-index: 5; } /* a pinned heading stays over a floating strip; the others go under it */
  /* the old way: inside the card, out over its padding and edge, the list making room */
  :host(:not([data-strip="float"])) .card-meta { margin: 0 -15px 0; }
  :host(:not([data-strip="float"])) .card:is(:hover, :focus-visible, :has(:focus-visible), .menu-open, .hist-open) .card-meta { margin-top: 9px; margin-bottom: -10px; }
  :host(:not([data-strip="float"])) .list-spacer { transition: height .32s cubic-bezier(.4,0,.2,1) .05s; } /* in step with the strip folding */
  :host(:not([data-strip="float"])) .panel-body:has(.card:hover, .card:focus-visible, .card.menu-open, .card :focus-visible) .list-spacer { height: 0; transition-delay: 0s; } /* no :has() inside :has(): that voids the whole rule */
  /* ?strip=pushpause (Nirav, 2026-10-24): the same push, but only once the pointer rests on a card for a moment, so
     running the mouse down the list does not open and shut every card it passes; it closes at once. Keyboard focus,
     an open menu or history open without waiting */
  :host([data-strip="pushpause"]) .card:hover .card-meta { transition-delay: .45s, .45s; }
  :host([data-strip="pushpause"]) .card:hover .card-meta-in { transition-delay: .55s, .45s, .51s; } /* the words a beat after the strip */
  :host([data-strip="pushpause"]) .panel-body:has(.card:hover) .list-spacer { transition-delay: .45s; }
  :host([data-strip="pushpause"]) .card:is(:focus-visible, :has(:focus-visible), .menu-open, .hist-open) .card-meta { transition-delay: 0s, 0s; }
  :host([data-strip="pushpause"]) .card:is(:focus-visible, :has(:focus-visible), .menu-open, .hist-open) .card-meta-in { transition-delay: .1s, 0s, .06s; }
  .card-meta-in { min-height: 0; overflow: hidden; display: flex; align-items: center; gap: 10px; padding: 0 14px; background: hsl(var(--rv-n10)); border-radius: 0 0 10px 10px; font-size: 11px; color: var(--rv-ink-3); opacity: 0; transform: translateY(-3px); transition: opacity .14s ease, padding .32s cubic-bezier(.4,0,.2,1) .05s, transform .2s ease; } /* the words drift a few pixels as they fade */
  :host([data-theme="dark"]) .card-meta-in { box-shadow: inset 1px 0 0 hsl(216.77 40.26% 15.1%), inset -1px 0 0 hsl(216.77 40.26% 15.1%), inset 0 -1px 0 hsl(216.77 40.26% 15.1%); } /* the card's dark edge carried round the strip */
  .card-meta .cm-by { display: inline-flex; align-items: center; gap: 5px; flex: 0 0 auto; }
  .card-meta .cm-by .by-who { display: inline-flex; align-items: center; color: var(--rv-ink-2); font-weight: 500; }
  .card-meta .cm-by .av { margin-left: 0; }
  .list-spacer { height: var(--strip-h, 33px); pointer-events: none; transition: height .22s cubic-bezier(.32,.72,0,1); } /* room for the last card's floating strip */
  .card-meta .cm-type { font-weight: 500; }
  .card-meta .cm-type[data-k="fix"] { color: var(--tag-fix-ink); }
  .card-meta .cm-type[data-k="question"] { color: var(--tag-question-ink); }
  .card-more-wrap { position: relative; display: inline-flex; }
  .card-more { width: 28px; height: 26px; padding: 0; border: 0; border-radius: 8px; background: var(--rv-fill); color: var(--rv-ink-2); display: inline-flex; align-items: center; justify-content: center; cursor: pointer; transition: background-color .12s, color .12s; }
  .card-more:hover, .card-more-wrap.open .card-more { background: color-mix(in srgb, var(--rv-ink) 12%, var(--rv-fill)); color: var(--rv-ink); }
  .card-menu { position: absolute; right: 0; bottom: calc(100% + 6px); z-index: 4; display: none; flex-direction: column; min-width: 190px; padding: 5px; border: 1px solid var(--rv-line); border-radius: 12px; background: var(--rv-surface); box-shadow: 0 12px 32px rgba(29,43,62,.14), 0 2px 6px rgba(29,43,62,.06); }
  .card-more-wrap.open .card-menu { display: flex; }
  .card-menu .card-mi { display: flex; align-items: center; gap: 10px; width: 100%; text-align: left; padding: 7px 10px; border: 0; border-radius: 7px; background: transparent; color: var(--rv-ink); font: 400 13px/1.3 -apple-system, system-ui, sans-serif; cursor: pointer; white-space: nowrap; }
  .card-menu .mi-ico { flex: 0 0 auto; color: var(--rv-ink); }
  .card-menu .card-mi:hover { background: var(--rv-hover); }
  .card-menu .hand-title { display: block; padding: 6px 10px 4px; font-size: 11px; color: var(--rv-ink-3); }
  .card-menu .hand-list { display: flex; flex-direction: column; max-height: 240px; overflow: auto; }
  .card-menu .hand-wait { display: block; padding: 6px 10px 8px; font-size: 12px; color: var(--rv-ink-3); }
  .card-menu .hand-to .av { width: 18px; height: 18px; margin: 0; }
  .card-menu-sep { display: block; height: 1px; margin: 4px -5px; background: var(--rv-line); opacity: .7; }
  .card-menu .card-rm.card-mi, .card-menu .card-rm.card-mi .mi-ico { color: hsl(353 84% 47%); }
  .card-menu .card-rm.card-mi:hover:not(.sure) { background: hsl(var(--rv-danger-bg)); } /* Remove hovers light red (Nirav, 2026-10-23) */
  .card-menu .card-rm.card-mi.sure { background: hsl(353 84% 47%); color: #fff; }
  .card-menu .card-rm.card-mi.sure .mi-ico { color: #fff; }
  .card.menu-open .card-foot .acts { opacity: 1; }
  .card-meta .cm-hist { height: 22px; margin: -4px 0 -4px -7px; padding: 0 7px; border: 0; border-radius: 11px; background: transparent; font: inherit; color: var(--rv-ink-3); cursor: pointer; }
  .card-meta .cm-hist:hover, .card-meta .cm-hist:focus-visible { background: hsl(var(--rv-n20)); color: var(--rv-ink-2); outline: none; }
  .card-meta .cm-hist[aria-expanded="true"] { color: var(--rv-ink-2); }
  /* under the pointer (and while open) the face turns into the history mark, laid over it so nothing moves */
  .card-meta .cm-hist { position: relative; }
  .card-meta .cm-hico { position: absolute; left: 7px; top: 50%; width: 16px; height: 16px; margin-top: -8px; display: flex; align-items: center; justify-content: center; color: var(--rv-ink); opacity: 0; transition: opacity .15s ease; }
  .card-meta .cm-hist .by-who .av { transition: opacity .15s ease; }
  /* the count after the time, unfolding under the pointer (Nirav, 2026-10-24); at the end, so nothing before it moves */
  .card-meta .cm-steps { display: inline-flex; align-items: center; gap: 5px; max-width: 0; margin-left: -5px; overflow: hidden; white-space: nowrap; opacity: 0; transition: max-width .22s cubic-bezier(.32,.72,0,1), margin .22s cubic-bezier(.32,.72,0,1), opacity .15s ease; } /* no gap at rest */
  .card-meta .cm-hist:is(:hover, :focus-visible, [aria-expanded="true"]) .cm-steps { max-width: 80px; margin-left: 0; opacity: 1; }
  .card-meta .cm-hist.no-face .cm-hico { position: static; margin: 0; opacity: 1; color: var(--rv-ink-3); } /* no author, no face to swap: the mark stays in line */
  .card-meta .cm-hist:is(:hover, :focus-visible, [aria-expanded="true"]) .cm-hico { opacity: 1; }
  .card-meta .cm-hist:is(:hover, :focus-visible, [aria-expanded="true"]) .by-who .av { opacity: 0; }
  .card.hist-open .card-meta-in { flex-wrap: wrap; row-gap: 0; }
  .card-hist { position: relative; flex: 0 0 100%; margin-top: 12px; padding: 0 0 2px; }
  .card-hist::before { content: ""; position: absolute; left: 7.5px; top: -10px; height: 15px; width: 1px; background: hsl(var(--rv-n30)); } /* the thread starts at the author's face in the strip */
  .hs-list { list-style: none; margin: 0; padding: 0; }
  .hs-step { position: relative; display: flex; align-items: flex-start; gap: 0; padding: 0 0 8px; font-size: 12px; line-height: 1.4; color: var(--rv-ink-2); }
  .hs-step:last-child { padding-bottom: 0; }
  .hs-step::before { content: ""; position: absolute; left: 7.5px; top: 13px; bottom: -1px; width: 1px; background: hsl(var(--rv-n30)); } /* the thread from one step to the next */
  .hs-step:last-child::before { display: none; }
  .hs-step .gh-shape { margin: 5px 10px 0 4.5px; position: relative; } /* centred under the author's 16 px face */
  .gh-shape[data-s="approved"] { background: var(--rv-st-done-dot); border-radius: 2px; }
  .hs-body { flex: 1; min-width: 0; display: flex; flex-direction: column; gap: 1px; }
  .hs-line b { font-weight: 500; color: var(--rv-ink); }
  .hs-face { flex: 0 0 auto; display: flex; margin: 1.5px 5px 0 0; } /* 14 px in a 17 px line: centred on the first line */
  .hs-face .av { display: block; width: 14px; height: 14px; margin: 0; }
  .hs-face .av-i { display: flex; align-items: center; justify-content: center; font-size: 8px; line-height: 1; }
  .hs-words { color: var(--rv-ink); white-space: pre-wrap; overflow-wrap: anywhere; }
  .hs-more { display: inline-flex; align-items: flex-start; border: 0; padding: 0; background: none; font: inherit; color: var(--rv-ink-2); cursor: pointer; }
  .hs-more:hover, .hs-more:focus-visible { color: var(--rv-ink); outline: none; }
  .hs-fold-ic { position: relative; display: flex; align-items: center; justify-content: center; width: 13px; height: 13px; margin: 2px 7.5px 0 1.5px; border-radius: 50%; background: hsl(var(--rv-n10)); color: var(--rv-ink-3); } /* centred on the thread, covering it */
  .hs-more:hover .hs-fold-ic, .hs-more:focus-visible .hs-fold-ic { color: var(--rv-ink); }
  .hs-more:hover { color: var(--rv-ink); }
  .hs-when { flex: 0 0 auto; margin-left: 10px; font-size: 11px; color: var(--rv-ink-3); white-space: nowrap; }
  .card-meta .cm-place { text-decoration: underline dotted; text-decoration-color: currentColor; text-underline-offset: 3px; text-decoration-thickness: 1px; cursor: default; } /* dotted: there is more under the pointer */
  .card-meta .cm-place:hover { color: var(--rv-ink-2); }
  .place-tip { position: fixed; z-index: 2147483647; left: 0; top: 0; max-width: 320px; background: #1d2b3e; color: #fff; font: 500 11px/16px -apple-system, system-ui, sans-serif; padding: 4px 8px; border-radius: 4px; pointer-events: none; opacity: 0; visibility: hidden; }
  .place-tip.on { opacity: 1; visibility: visible; }
  /* the waiting list: who asks to join (the approver), and the quiet screen of someone waiting */
  .join-box { margin: 0 0 16px; /* from the number circles' edge to the cards' right edge (Nirav, 2026-10-24) */ padding: 10px 14px 6px; border-radius: 10px; background: var(--rv-surface); box-shadow: 0 1px 2px rgba(29,43,62,.06); }
  :host([data-theme="dark"]) .join-box { box-shadow: inset 0 0 0 1px hsl(216.77 40.26% 15.1%); }
  .join-title { display: flex; align-items: center; width: 100%; padding: 0; margin-bottom: 4px; border: 0; background: none; font: 600 11px/1.3 -apple-system, system-ui, sans-serif; color: var(--rv-ink-2); cursor: pointer; text-align: left; }
  .join-title .lg-chev { margin-left: auto; color: var(--rv-ink-3); transition: transform .2s ease; }
  .join-box.folded { padding-bottom: 10px; }
  .join-box.folded .join-title { margin-bottom: 0; }
  .join-box.folded .lg-chev { transform: rotate(90deg); } /* as the group headings fold */
  .join-more { display: block; margin: 2px 0 4px 28px; padding: 0; border: 0; background: none; font: 500 11px/1.6 -apple-system, system-ui, sans-serif; color: var(--rv-ink-3); cursor: pointer; }
  .join-more:hover { color: var(--rv-ink); }
  .join-row { position: relative; display: flex; align-items: center; gap: 8px; padding: 6px 0; font-size: 12px; color: var(--rv-ink-2); }
  .join-row + .join-row::before { content: ""; position: absolute; top: 0; left: 28px; right: 0; height: 1px; background: linear-gradient(to right, hsl(var(--rv-n20)), hsl(var(--rv-n20) / 0)); } /* from the name, lighter, fading out to the right (Nirav, 2026-10-24) */
  .join-row .av { width: 20px; height: 20px; margin: 0; }
  .join-row.busy > button:not(.loading) { opacity: .4; pointer-events: none; }
  .join-who { flex: 1; min-width: 0; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
  .join-who b { font-weight: 500; color: var(--rv-ink); }
  .join-h { color: var(--rv-ink-3); }
  .join-no { border: 0; background: none; padding: 3px 6px; font: 500 11px/1.2 -apple-system, system-ui, sans-serif; color: var(--rv-ink-3); cursor: pointer; border-radius: 6px; }
  .join-no:hover { color: var(--rv-ink); background: hsl(var(--rv-n10)); }
  .join-no { opacity: 0; pointer-events: none; transition: opacity .15s ease; } /* Refuse only under the pointer (Nirav, 2026-10-24); its place is kept, so Let in does not move */
  .join-row:is(:hover, :focus-within) .join-no { opacity: 1; pointer-events: auto; }
  .wait-screen { display: flex; flex-direction: column; align-items: center; gap: 8px; padding: 56px 24px; text-align: center; color: var(--rv-ink-3); }
  .wait-screen b { font: 600 14px/1.3 -apple-system, system-ui, sans-serif; color: var(--rv-ink); }
  .wait-screen span { font-size: 12px; line-height: 1.5; max-width: 260px; }
  .card-meta .cm-where { flex: 1; min-width: 0; text-align: right; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
  .card-by { display: flex; align-items: center; gap: 5px; min-height: 18px; margin: 0 0 10px; font-size: 11px; color: var(--rv-ink-3); }
  .card-by:empty { display: none; }
  .card-by .by-who { display: inline-flex; align-items: center; color: var(--rv-ink-2); font-weight: 500; }
  .card-by .by-who .av { margin-left: 0; }
  .card-by .by-sep { opacity: .7; }
  /* SELECTION (Nirav, 2026-10-21): a check at the card's top-right, seen on hover or once picked; the copies then
     take the picked cards only. The picked card wears a soft info ring. The count sits in the head, by the copy
     buttons it narrows. */
  .card-c .card-line { padding-right: 30px; } /* room for the check at the top-right, so the text never runs under it */
  .card-pick { position: absolute; z-index: 1; right: 12px; top: 11px; width: 18px; height: 18px; padding: 0; border-radius: 50%; border: 1.5px solid hsl(var(--rv-n70)); background: var(--rv-surface); box-shadow: 0 0 0 2px var(--rv-surface); color: #fff; display: inline-flex; align-items: center; justify-content: center; cursor: pointer; opacity: 0; transition: opacity .12s, background-color .12s, border-color .12s; }
  .card:hover .card-pick, .card.picked .card-pick { opacity: 1; }
  .card-pick:hover { border-color: hsl(214 98% 44%); }
  .card.picked .card-pick { background: hsl(214 98% 44%); border-color: hsl(214 98% 44%); }
  .card-pick svg { opacity: 0; transition: opacity .12s; }
  .card.picked .card-pick svg { opacity: 1; }
  .card:focus { outline: none; }
  .card:focus-visible { outline: 2px solid hsl(214 98% 44% / .55); outline-offset: 2px; }
  .card:focus-visible .card-pick { opacity: 1; }
  .panel.picking, .panel.picking * { user-select: none; cursor: default; }
  .card.card-fill.picked { box-shadow: 0 0 0 2px hsl(214 98% 44% / .45), 0 1px 2px rgba(29,43,62,.06); }
  /* what the list is doing: "Checking…" on open, "Up to date" for a moment, "2 new" until they are seen */
  .panel-sync { position: absolute; left: 50%; top: 108px; transform: translate(-50%, -6px); z-index: 3; display: inline-flex; align-items: center; gap: 7px; height: 26px; padding: 0 12px; border-radius: 999px; background: var(--rv-chip); color: var(--rv-chip-ink); border: 1px solid var(--rv-chip-line); font-size: 12px; font-weight: 500; box-shadow: 0 4px 12px rgba(29,43,62,.08); opacity: 0; transition: opacity .18s ease, transform .18s ease; pointer-events: none; white-space: nowrap; }
  .panel-sync.on { opacity: 1; transform: translate(-50%, 0); }
  .panel-sync.new { background: hsl(214 98% 44%); color: #fff; border-color: transparent; pointer-events: auto; cursor: pointer; }
  .panel-sync .ring { display: none; width: 10px; height: 10px; border: 1.5px solid currentColor; border-color: currentColor currentColor transparent transparent; border-radius: 50%; animation: rv-spin .7s linear infinite; }
  .panel-sync.checking .ring { display: block; }
  :host([data-page]) .panel-sync { position: fixed; top: 120px; }
  /* not seen yet: the number disc in blue, back to its own colour once the card has been in view a moment */
  .card-n { transition: background-color .5s ease, color .5s ease, box-shadow .5s ease; }
  .card.unread .card-n { background: hsl(214 98% 44%); color: #fff; box-shadow: 0 0 0 3px hsl(214 98% 44% / .18); }
  .pin.unread { box-shadow: 0 0 0 3px hsl(214 98% 44% / .35), 0 1px 3px rgba(0,0,0,.25); }
  .panel-pick { display: inline-flex; align-items: center; height: 26px; padding: 0 4px 0 10px; gap: 6px; margin-right: 4px; border-radius: 999px; background: hsl(214 98% 44% / .1); color: hsl(214 98% 44%); font-weight: 600; font-size: 12px; flex: 0 0 auto; }
  .panel-pick .x { position: relative; width: 20px; height: 20px; padding: 0; border: 0; border-radius: 50%; background: transparent; color: inherit; display: inline-flex; align-items: center; justify-content: center; cursor: pointer; }
  .panel-pick .x:hover { background: hsl(214 98% 44% / .15); }
  .panel-pick .x:hover .scope-tip { opacity: 1; }
  .card-c .card-line .card-text { margin: 0 0 0 -4px; padding: 2px 4px; }
  .card-c .card-n.out { position: absolute; left: -32px; top: 12px; }
  .card-foot { display: flex; align-items: center; gap: 8px; margin-top: 8px; font-size: 11px; color: var(--rv-ink-2); min-height: 24px; }
  /* the actions show only while the card is under the pointer (or holds the focus) */
  .card-foot .acts { display: inline-flex; gap: 6px; flex: 0 0 auto; margin-left: auto; opacity: 0; transition: opacity .12s; } /* at the right end of the line (Nirav, 2026-10-23) */
  .card:hover .card-foot .acts, .card:focus-visible .card-foot .acts, .card:has(:focus-visible) .card-foot .acts { opacity: 1; } /* keyboard focus, not a click that left focus behind */
  .card-ok { border: 1px solid var(--rv-line-2); background: var(--rv-surface); color: var(--rv-ink-2); border-radius: 6px; padding: 3px 9px; font: 500 11px/1.2 -apple-system, system-ui, sans-serif; cursor: pointer; }
  .card-ok:hover { border-color: hsl(136 53% 43%); color: hsl(var(--rv-ok-ink)); background: hsl(var(--rv-ok-bg)); }
  .card-ok.alt:hover { border-color: hsl(var(--rv-n70)); color: var(--rv-ink); background: hsl(var(--rv-n10)); }
  /* where it stands, after the place: a dot in the status colour and the words */
  .card-status { display: none; align-items: center; gap: 5px; flex: 0 0 auto; font-size: 11px; font-weight: 500; white-space: nowrap; }
  .card-status::before { content: ""; flex: 0 0 auto; width: 6px; height: 6px; margin-right: 3px; border-radius: 50%; background: currentColor; } /* a little air between the shape and the face (Nirav, 2026-10-24) */
  .card-status[data-s="progress"]::before { transform: rotate(45deg) scale(1); } /* at 6 px on the card the diamond needs its full size to look as big as the square (Nirav, 2026-10-24); the pill keeps .91 */
  .card-status[data-s="open"]::before { background: var(--rv-st-new-dot); } .card-status[data-s="progress"]::before { background: var(--rv-st-prog-dot); } .card-status[data-s="approval"]::before { background: var(--rv-st-appr-dot); } /* the dots in the bright step, the words in the dark one */
  .card-status { flex: 0 1 auto; min-width: 0; }
  .card-status .st-s { min-width: 0; overflow: hidden; white-space: nowrap; text-overflow: ellipsis; }
  .card-status .st-k { font-weight: 500; color: inherit; }
  .card-status .st-who { color: var(--rv-ink); font-weight: 500; }
  .card-status .st-rest { color: var(--rv-ink-2); font-weight: 400; }
  .card-status .av { margin: 0 4px 0 0; vertical-align: middle; position: relative; top: -1px; }
  .card-note .nt-head .av { vertical-align: middle; position: relative; top: -1px; }
  /* a reply on a question is talk, not a warning: a quiet box, the answer's teal (the asker's follow-up in New's purple) */
  .card-note:has(.nt-reply) { background: hsl(var(--rv-n10)); border-left-color: var(--rv-st-appr-dot); }
  .card-note:has(.nt-reply[data-ask="true"]) { border-left-color: var(--rv-st-new-dot); }
  .av { width: 16px; height: 16px; border-radius: 50%; vertical-align: -3px; margin: 0 4px 0 1px; background: var(--rv-line); object-fit: cover; }
  .av-i { display: inline-flex; align-items: center; justify-content: center; font: 700 9px/1 -apple-system, system-ui, sans-serif; color: var(--rv-ink); background: hsl(var(--rv-n30)); }
  .pin-tip .av-i { color: var(--rv-ink); }
  .card-status .av { margin-left: 0; }
  .pin-tip .av { width: 14px; height: 14px; vertical-align: -2px; }
  /* the three live states in one colour each, on the cards and in the filter (Nirav, 2026-10-23): New purple, In
     progress orange, For approval teal */
  .card-status[data-s="open"] { display: inline-flex; color: var(--rv-st-new); }
  .card-status[data-s="progress"] { display: inline-flex; color: var(--rv-st-prog); }
  .card-status[data-s="approval"] { display: inline-flex; color: var(--rv-st-appr); }
  .card-status[data-s="approved"] { display: inline-flex; color: var(--rv-st-done); }
  .card-status[data-s="approved"]::before { width: 9px; height: 9px; border-radius: 2.5px; background: var(--rv-st-done-dot) url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 12 12'%3E%3Cpath d='M2.6 6.3l2.2 2.2 4.6-4.8' fill='none' stroke='%23fff' stroke-width='2.4' stroke-linecap='round' stroke-linejoin='round'/%3E%3C/svg%3E") center / 8px no-repeat; }
  .card.resolved { opacity: .85; }
  .card.resolved .card-text { color: var(--rv-ink-2); }
  .card.resolved .card-n.out { background: hsl(var(--rv-ok-bg)); color: hsl(var(--rv-ok-ink)); }
  .panel-end { display: flex; align-items: center; justify-content: center; gap: 8px; color: var(--rv-ink-2); font-size: 12px; padding: 14px 0 6px; }
  .panel-end.hub-line { display: block; text-align: center; }
  .panel-end b { font-weight: 600; color: var(--rv-ink); }
  /* approved, the last step of the status shapes (New circle, In progress diamond, For approval square): the square,
     finished, green with a tick (Nirav, 2026-10-24) */
  .panel-end .end-ok { display: inline-flex; align-items: center; justify-content: center; width: 14px; height: 14px; border-radius: 3.5px; background: var(--rv-st-done-dot); }
  .panel-end .end-word { color: var(--rv-st-done); font-weight: 500; }
  .panel-end a { color: var(--rv-ink-2); text-decoration: underline dotted; text-underline-offset: 3px; }
  .panel-end a:hover { color: var(--rv-ink); text-decoration-style: solid; }
  .panel-view { display: none; }
  /* on the page the Open / Resolved switch sits in the middle of the head, whatever is on either side */
  :host([data-page]) .panel-view { display: inline-flex; position: absolute; left: 50%; top: 50%; transform: translate(-50%, calc(-50% + 4px)); }
  .scope-switch.panel-view .side { width: auto; height: 24px; padding: 0 10px; font: 500 12px/24px -apple-system, system-ui, sans-serif; color: hsl(var(--rv-n90)); }
  .scope-switch.panel-view .side b { font-weight: 500; color: hsl(var(--rv-n70)); margin-left: 4px; }
  .scope-switch.panel-view .side[aria-pressed="true"] b { color: hsl(var(--rv-n130)); }
  .card-foot .where { flex: 1; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
  /* a button at work: a small ring where its label was, the width kept; its neighbours quiet meanwhile */
  .card-ok, .card-rm, .tip-acts button { position: relative; transition: opacity .15s ease, border-color .12s, background-color .12s, color .12s; }
  .card-ok.loading, .card-rm.loading, .note-go.loading, .tip-acts button.loading { color: transparent !important; pointer-events: none; }
  .card-ok.loading::after, .card-rm.loading::after, .note-go.loading::after, .tip-acts button.loading::after { content: ""; position: absolute; left: 50%; top: 50%; width: 10px; height: 10px; margin: -6px 0 0 -6px; border: 1.5px solid currentColor; border-color: #5b6b85 #5b6b85 transparent transparent; border-radius: 50%; animation: rv-spin .7s linear infinite; }
  .tip-acts button.loading::after { border-color: #fff #fff transparent transparent; }
  @keyframes rv-spin { to { transform: rotate(360deg); } }
  .acts.busy > :not(.loading), .tip-acts-in.busy > :not(.loading) { opacity: .4; pointer-events: none; }
  .card.card-c .card-foot .acts.busy { opacity: 1; }
  /* the hub's answer arriving: the chip and the buttons fade out, change, fade in */
  .card-status { transition: opacity .14s ease, transform .14s ease; }
  .card-status.swap { opacity: 0 !important; transform: translateY(3px); }
  .card-foot .acts.swap { opacity: 0 !important; }
  /* on its way up: the picture shimmers */
  .card.sending .card-pic::after { content: ""; position: absolute; inset: 0; border-radius: 6px; background: linear-gradient(100deg, transparent 30%, rgba(255,255,255,.55) 50%, transparent 70%); background-size: 250% 100%; animation: rv-shimmer 1.3s linear infinite; pointer-events: none; }
  .card.sending .card-pic { position: relative; }
  @keyframes rv-shimmer { from { background-position: 120% 0; } to { background-position: -130% 0; } }
  .card-sending { font-size: 11px; color: var(--rv-ink-3); flex: 0 0 auto; }
  .card.failed { box-shadow: 0 0 0 1px hsl(353 84% 47% / .5), 0 1px 2px rgba(29,43,62,.06); }
  .card-foot .acts.on { opacity: 1; }
  /* the reason a comment came back, under the foot, in the warning ink with a thin rule on its left */
  .card-note { margin-top: 8px; padding: 6px 10px;  font-size: 12px; line-height: 1.4; color: var(--rv-ink); background: hsl(var(--rv-warn-bg) / .55); border-radius: 8px; border-left: 2px solid hsl(var(--rv-warn-ink) / .5); /* a curved border: it follows the 8 px corners */ white-space: pre-wrap; overflow-wrap: anywhere; }
  .card-note .nt-head, .tip-note .nt-head { color: var(--rv-ink-2); }
  .card-note .nt-head b { font-weight: 500; font-size: 11px; color: var(--rv-ink); }
  .card-note .av { width: 14px; height: 14px; vertical-align: -3px; margin: 0 4px 0 0; } /* smaller in the note than on the status line (Nirav, 2026-10-23) */
  .card-note .av-i { font-size: 8px; }
  .card-status .st-claude { margin-left: -7px; box-shadow: 0 0 0 1.5px var(--rv-surface); } /* Claude's mark tucked beside the person's face */
  .av-claude { display: inline-flex; align-items: center; justify-content: center; font: 700 8px/1 -apple-system, system-ui, sans-serif; color: #fff; background: #D97757; } /* Claude's mark where a face would be */
  .tip-note .nt-head { color: inherit; opacity: .75; }
  .tip-note .nt-head b { font-weight: 600; }
  /* the one-line ask in the foot when a comment goes back */
  /* THE NOTE BOX (Nirav, 2026-10-24: the button was small beside a tall field): one control, the button inside the
     field at its right end, one height */
  .card-foot .note-box { flex: 1; min-width: 0; display: flex; align-items: center; gap: 4px; height: 26px; box-sizing: border-box; padding: 0 2px 0 0; border: 1px solid var(--rv-line-2); border-radius: 7px; /* 26: the height of the row of buttons it replaces, so the card does not grow */ background: var(--rv-surface); transition: border-color .12s, box-shadow .12s; }
  .card-foot .note-box:focus-within { border-color: hsl(214 98% 44%); box-shadow: 0 0 0 1px hsl(214 98% 44%); }
  .card-foot .note-in { flex: 1; min-width: 0; height: 100%; border: 0; padding: 0 0 0 10px; font: 12px/1.2 -apple-system, system-ui, sans-serif; color: var(--rv-ink); background: transparent; outline: none; }
  .card-foot .note-in::placeholder { color: var(--rv-ink-3); }
  .card-foot .note-go { position: relative; flex: 0 0 auto; height: 20px; padding: 0 9px; border: 0; border-radius: 5px; background: hsl(var(--rv-n20)); color: var(--rv-ink); font: 500 11px/20px -apple-system, system-ui, sans-serif; cursor: pointer; transition: background-color .12s; }
  .card-foot .note-go:hover { background: hsl(var(--rv-n30)); }
  :host([data-theme="dark"]) .card-foot .note-go:hover { background: hsl(var(--rv-n20) / .7); }
  .card-rm { border: 1px solid var(--rv-line-2); background: var(--rv-surface); color: var(--rv-ink-2); border-radius: 6px; padding: 3px 9px; font: 500 11px/1.2 -apple-system, system-ui, sans-serif; cursor: pointer; flex: 0 0 auto; }
  .card-rm:hover { border-color: hsl(353 84% 47%); color: hsl(353 84% 47%); background: hsl(var(--rv-danger-bg)); }
  .card-rm.sure { border-color: hsl(353 84% 47%); color: #fff; background: hsl(353 84% 47%); }
  .lightbox { position: fixed; inset: 0; pointer-events: auto; background: rgba(12,20,32,.8); display: none; align-items: center; justify-content: center; z-index: 4; user-select: none; -webkit-user-select: none; }
  .lightbox.on { display: flex; }
  /* the frame is exactly as wide as the picture: caption and foot share its edges */
  .lb-frame { display: flex; flex-direction: column; max-width: calc(100vw - 64px); max-height: calc(100vh - 48px); }
  .lb-top { display: flex; align-items: center; gap: 10px; padding: 0 0 10px; color: #fff; font-size: 13px; min-height: 32px; }
  .lb-n { width: 22px; height: 22px; border-radius: 50%; background: #fff; color: #1d2b3e; font-weight: 700; font-size: 11px; line-height: 22px; text-align: center; flex: 0 0 auto; }
  .lb-sev { font-size: 11px; font-weight: 600; padding: 2px 8px; border-radius: 999px; background: var(--rv-fill); color: var(--rv-ink-2); flex: 0 0 auto; }
  .lb-sev[data-k="must"] { background: var(--tag-must-fill); color: var(--tag-must-ink); } .lb-sev[data-k="should"] { background: var(--tag-should-fill); color: var(--tag-should-ink); } .lb-sev[data-k="idea"] { background: var(--tag-idea-fill); color: var(--tag-idea-ink); } .lb-sev[data-k="question"] { background: var(--tag-question-fill); color: var(--tag-question-ink); }
  .lb-sev[data-k="fix"] { background: var(--tag-fix-fill); color: var(--tag-fix-ink); }
  .lb-text { flex: 1; min-width: 0; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; font-weight: 500; }
  .lb-count { color: #9fb0c9; font-size: 12px; margin-right: 2px; flex: 0 0 auto; }
  .lb-top button { flex: 0 0 auto; display: inline-flex; align-items: center; justify-content: center; border: 0; background: rgba(255,255,255,.12); color: #fff; width: 30px; height: 30px; border-radius: 8px; cursor: pointer; padding: 0; }
  .lb-top button:hover { background: rgba(255,255,255,.22); }
  .lb-top button:disabled { opacity: .3; cursor: default; }
  .lb-top .lb-close { margin-left: 6px; }
  .lb-pic { position: relative; container-type: inline-size; display: flex; justify-content: center; min-height: 0; }
  .lb-img { display: block; width: 100%; max-width: 100%; max-height: calc(100vh - 48px - 42px - 36px); width: auto; height: auto; object-fit: contain; border-radius: 8px; box-shadow: 0 24px 64px rgba(0,0,0,.5); background: #fff; }
  .lb-foot { display: flex; align-items: center; justify-content: space-between; gap: 16px; padding: 10px 0 0; color: #9fb0c9; font-size: 12px; min-height: 36px; }
  .lb-where { color: #cfd8e6; }
  :host([data-page]) .bar, :host([data-page]) .hover, :host([data-page]) .pins, :host([data-page]) .pin-tip, :host([data-page]) .composer { display: none !important; }
  :host([data-page]) .panel-veil { display: none; }
  /* the Done moment */
  .fx-done { position: absolute; z-index: 5; display: inline-flex; align-items: center; gap: 5px; height: 26px; box-sizing: border-box; padding: 0 10px 0 3px; border-radius: 13px; background: var(--rv-surface); box-shadow: 0 0 0 1px hsl(var(--rv-n20)), 0 6px 16px -6px rgba(29,43,62,.25); font: 500 11px/1 -apple-system, system-ui, sans-serif; /* the height of the card's buttons, Done and ⋯ (Nirav, 2026-10-25) */ color: var(--rv-ink); white-space: nowrap; pointer-events: none; transform: translateY(-50%); animation: rv-done-in .38s cubic-bezier(.22,1.4,.36,1) both; }
  :host([data-theme="dark"]) .fx-done { box-shadow: 0 0 0 1px hsl(var(--rv-n20)), 0 8px 20px -6px rgba(0,0,0,.6); }
  @keyframes rv-done-in { from { opacity: 0; transform: translateY(-50%) scale(.7); } to { opacity: 1; transform: translateY(-50%) scale(1); } }
  .fx-done.below { transform: none; transform-origin: 85% 100%; animation-name: rv-done-in-below; } /* "below" by name: above the pin card */
  .fx-done.pin-add { position: fixed; z-index: 3; transform: none; transform-origin: 0 50%; animation: rv-pin-pill .4s cubic-bezier(.22,1.4,.36,1) .3s both; background: hsl(216 36% 18%); color: #fff; box-shadow: 0 0 0 1px hsl(0 0% 100% / .1), 0 8px 20px -6px rgba(0,0,0,.55); }
  @keyframes rv-pin-pill { from { opacity: 0; transform: scale(.7); } to { opacity: 1; transform: none; } }
  .fx-done.below { background: hsl(216 36% 18%); color: #fff; box-shadow: 0 0 0 1px hsl(0 0% 100% / .1), 0 8px 20px -6px rgba(0,0,0,.55); } /* the pin card's own colour (Nirav, 2026-10-25) */
  @keyframes rv-done-in-below { from { opacity: 0; transform: translateY(6px) scale(.7); } to { opacity: 1; transform: none; } }
  :is(.fx-done, .empty-state) .f-face { flex: 0 0 auto; overflow: visible; }
  :is(.fx-done, .empty-state) .f-face * { transform-box: fill-box; transform-origin: 50% 50%; }
  :is(.fx-done, .empty-state) .f-draw { stroke-dasharray: 1; stroke-dashoffset: 1; animation: rv-tick-draw .34s cubic-bezier(.4,0,.2,1) .22s forwards; }
  :is(.fx-done, .empty-state) .f-blink { animation: rv-blink .22s ease-in-out .9s; }
  @keyframes rv-blink { 50% { transform: scaleY(.1); } }
  :is(.fx-done, .empty-state) .f-wink { animation: rv-wink .5s ease-in-out .55s both; }
  @keyframes rv-wink { 30%, 70% { transform: scaleY(.12); } }
  :is(.fx-done, .empty-state) .f-pulse { animation: rv-pulse .5s ease-in-out .3s 2; }
  @keyframes rv-pulse { 50% { transform: scale(1.3); } }
  :is(.fx-done, .empty-state) .f-twinkle { animation: rv-twinkle2 .7s ease-in-out .3s 2; }
  @keyframes rv-twinkle2 { 50% { transform: scale(1.25) rotate(20deg); } }
  :is(.fx-done, .empty-state) .f-shades { animation: rv-shades .45s cubic-bezier(.3,1.4,.5,1) .2s both; }
  @keyframes rv-shades { from { transform: translateY(-9px); opacity: 0; } to { transform: none; opacity: 1; } }
  :is(.fx-done, .empty-state) .f-look { animation: rv-look 1s ease-in-out .3s both; }
  @keyframes rv-look { 25%, 55% { transform: translateX(1.6px); } 80% { transform: translateX(-.6px); } }
  :is(.fx-done, .empty-state) .f-sparkle { animation: rv-sparkle .8s ease-in-out .25s 2 both; }
  @keyframes rv-sparkle { 0%, 100% { transform: scale(.3) rotate(0deg); opacity: 0; } 50% { transform: scale(1.35) rotate(45deg); opacity: 1; } }
  :is(.fx-done, .empty-state) .f-sparkle.s2 { animation-delay: .5s; }
  :is(.fx-done, .empty-state) .f-confetti { opacity: 0; animation: rv-confetti .9s cubic-bezier(.2,.8,.3,1) calc(.2s + var(--d)) both; }
  @keyframes rv-confetti { 0% { opacity: 0; transform: translate(calc(var(--x) * -1.4), calc(var(--y) * -1.4)) scale(.4) rotate(0deg); } 25% { opacity: 1; } 75% { opacity: 1; } 100% { opacity: 0; transform: translate(var(--x), var(--y)) scale(1.1) rotate(var(--r)); } }
  :is(.fx-done, .empty-state) .f-whoosh path { animation: rv-whoosh .5s ease-out .15s 2 both; }
  :is(.fx-done, .empty-state) .f-whoosh path:nth-child(2) { animation-delay: .22s; }
  @keyframes rv-whoosh { from { transform: translateX(3px); opacity: 0; } 50% { opacity: 1; } to { transform: translateX(-3px); opacity: 0; } }
  :is(.fx-done, .empty-state) .f-heart { animation: rv-heart 1.1s ease-out .3s both; }
  @keyframes rv-heart { 0% { opacity: 0; transform: translateY(4px) scale(.5); } 30% { opacity: 1; transform: scale(1.25); } 100% { opacity: 0; transform: translateY(-8px) scale(1); } }
  :is(.fx-done, .empty-state) .f-heart.h2 { animation-delay: .5s; }
  :is(.fx-done, .empty-state) .f-glint { opacity: 0; animation: rv-glint .55s ease-in-out .6s both; }
  @keyframes rv-glint { 0% { opacity: 0; transform: skewX(-20deg) translateX(0); } 30% { opacity: .95; } 100% { opacity: 0; transform: skewX(-20deg) translateX(9px); } }
  :is(.fx-done, .empty-state) .f-bang { transform-origin: 50% 100%; animation: rv-bang .5s cubic-bezier(.3,1.6,.5,1) .35s both; }
  @keyframes rv-bang { 0% { opacity: 0; transform: translateY(4px) scale(.3); } 60% { opacity: 1; transform: translateY(-1px) scale(1.15); } 100% { opacity: 1; transform: none; } }
  :is(.fx-done, .empty-state) .f-arcs path { animation: rv-arcs .45s ease-in-out .3s 2 both; }
  @keyframes rv-arcs { 0%, 100% { opacity: 0; } 50% { opacity: 1; } }
  /* the added pin's own */
  :is(.fx-done, .empty-state) .f-peek { animation: rv-peek 1s ease-in-out .35s both; }
  @keyframes rv-peek { 30%, 60% { transform: translate(-.8px, -.4px); } }
  :is(.fx-done, .empty-state) .f-blush { opacity: 0; animation: rv-blush .5s ease-out .3s forwards; }
  @keyframes rv-blush { to { opacity: 1; } }
  :is(.fx-done, .empty-state) .f-glasses { animation: rv-glasses .4s cubic-bezier(.3,1.4,.5,1) .15s both; }
  @keyframes rv-glasses { from { transform: translateY(-6px); opacity: 0; } to { transform: none; opacity: 1; } }
  :is(.fx-done, .empty-state) .f-glimmer { animation: rv-glimmer .7s ease-in-out .3s 2; }
  @keyframes rv-glimmer { 50% { transform: scale(1.35) rotate(45deg); } } /* the star in each eye twinkles */
  :is(.fx-done, .empty-state) .f-monocle { animation: rv-monocle .4s cubic-bezier(.3,1.6,.5,1) .2s both; }
  @keyframes rv-monocle { from { transform: scale(.2); opacity: 0; } to { transform: none; opacity: 1; } }
  :is(.fx-done, .empty-state) .f-tongue { transform-origin: 50% 0; animation: rv-tongue .5s ease-in-out .35s 2; }
  @keyframes rv-tongue { 50% { transform: scaleY(1.35); } }
  :is(.fx-done, .empty-state) .f-o { animation: rv-o .5s ease-in-out .3s 2; }
  @keyframes rv-o { 50% { transform: scale(1.35); } }
  :is(.fx-done, .empty-state) .f-bulb { animation: rv-bulb .5s cubic-bezier(.3,1.5,.5,1) .2s both; }
  @keyframes rv-bulb { from { transform: scale(.3); opacity: 0; } to { transform: none; opacity: 1; } }
  :is(.fx-done, .empty-state) .f-rays { opacity: 0; animation: rv-rays .5s ease-out .55s 2 alternate both; }
  @keyframes rv-rays { from { opacity: 0; } to { opacity: 1; } }
  :is(.fx-done, .empty-state) .f-flag { transform-origin: 0 100%; animation: rv-bulb .45s cubic-bezier(.3,1.5,.5,1) .2s both; }
  :is(.fx-done, .empty-state) .f-cloth { transform-origin: 0 50%; animation: rv-wave .4s ease-in-out .5s 3 alternate; }
  :is(.fx-done, .empty-state) .f-widen { transform-origin: 50% 40%; animation: rv-widen .5s cubic-bezier(.3,1.5,.5,1) .6s both; }
  @keyframes rv-widen { 0% { transform: none; } 50% { transform: scale(1.22, 1.15); } 100% { transform: scale(1.1, 1.06); } }
  @keyframes rv-wave { to { transform: skewY(-8deg) scaleX(.9); } }
  :is(.fx-done, .empty-state) .f-check { stroke-dasharray: 1; stroke-dashoffset: 1; animation: rv-tick-draw .35s cubic-bezier(.4,0,.2,1) .35s forwards; }
  :is(.fx-done, .empty-state) .f-star3 { opacity: 0; animation: rv-sparkle .7s ease-in-out calc(.25s + var(--d)) 2 both; }
  :is(.fx-done, .empty-state) .f-mag { transform-origin: 100% 100%; animation: rv-mag .7s cubic-bezier(.3,1.3,.5,1) .2s both; }
  @keyframes rv-mag { 0% { transform: rotate(-50deg) scale(.4); opacity: 0; } 60% { transform: rotate(12deg) scale(1.05); opacity: 1; } 100% { transform: none; opacity: 1; } }
  :is(.fx-done, .empty-state) .f-target { animation: rv-bulb .45s cubic-bezier(.3,1.5,.5,1) .25s both, rv-pulse .4s ease-in-out .8s; }
  :is(.fx-done, .empty-state) .f-bubble { transform-origin: 20% 100%; animation: rv-bulb .45s cubic-bezier(.3,1.5,.5,1) .3s both; }
  :is(.fx-done, .empty-state) .f-beat { animation: rv-beat .5s ease-in-out .75s 2; }
  @keyframes rv-beat { 30% { transform: scale(1.25); } 60% { transform: scale(.95); } }
  :is(.fx-done, .empty-state) .f-pinmark { transform-origin: 50% 100%; animation: rv-pinmark .7s cubic-bezier(.3,1.6,.5,1) .2s both; }
  @keyframes rv-pinmark { 0% { transform: translateY(-7px) scale(.6); opacity: 0; } 50% { transform: none; opacity: 1; } 70% { transform: translateY(-2px); } 100% { transform: none; opacity: 1; } }
  :is(.fx-done, .empty-state) .f-bounce { animation: rv-bounce .5s cubic-bezier(.3,1.6,.5,1) .3s 2; }
  @keyframes rv-bounce { 50% { transform: translateY(-2.5px); } }
  :is(.fx-done, .empty-state) .f-nod { transform-origin: 50% 90%; animation: rv-nod .45s ease-in-out .3s 2; }
  @keyframes rv-nod { 50% { transform: rotate(9deg); } }
  .fx-done span { animation: rv-done-text .3s ease-out .12s both; }
  @keyframes rv-done-text { from { opacity: 0; transform: translateX(-4px); } to { opacity: 1; transform: none; } }
  .pin-tip.fx-pick-glow { box-shadow: 0 0 0 2px hsl(26 100% 50% / .55), 0 10px 26px -10px hsl(26 100% 50% / .5); }
  .pin-tip.fx-done-glow { box-shadow: 0 0 0 2px hsl(174 59% 47% / .6), 0 10px 26px -10px hsl(174 59% 47% / .55); }
  .card.fx-pick-glow { box-shadow: 0 0 0 2px hsl(26 100% 50% / .4), 0 8px 22px -10px hsl(26 100% 50% / .45) !important; transition: box-shadow .3s ease; }
  .card.fx-done-glow { box-shadow: 0 0 0 2px hsl(174 59% 47% / .45), 0 8px 22px -10px hsl(174 59% 47% / .5) !important; transition: box-shadow .3s ease; }
  /* the approval: corner brackets lock on, a line scans down, the Approve button closes into a green check */
  .fx-lock { position: absolute; inset: -1px; pointer-events: none; z-index: 4; }
  .fx-lock .br { position: absolute; width: 14px; height: 14px; border: 2px solid var(--rv-st-done-dot); opacity: 0; animation: rv-lock .24s cubic-bezier(.22,1,.36,1) forwards; }
  .fx-lock .tl { left: 0; top: 0; border-right: 0; border-bottom: 0; border-top-left-radius: 8px; --x: -12px; --y: -12px; }
  .fx-lock .tr { right: 0; top: 0; border-left: 0; border-bottom: 0; border-top-right-radius: 8px; --x: 12px; --y: -12px; }
  .fx-lock .bl { left: 0; bottom: 0; border-right: 0; border-top: 0; border-bottom-left-radius: 8px; --x: -12px; --y: 12px; }
  .fx-lock .br2 { right: 0; bottom: 0; border-left: 0; border-top: 0; border-bottom-right-radius: 8px; --x: 12px; --y: 12px; }
  @keyframes rv-lock { from { opacity: 0; transform: translate(var(--x), var(--y)); } to { opacity: 1; transform: none; } }
  .fx-lock .scan { position: absolute; left: 6px; right: 6px; top: 0; height: 2px; border-radius: 2px; background: linear-gradient(90deg, transparent, var(--rv-st-done-dot), transparent); box-shadow: 0 0 8px var(--rv-st-done-dot); opacity: 0; animation: rv-scan .38s cubic-bezier(.45,0,.25,1) .14s forwards; }
  @keyframes rv-scan { 0% { top: 0; opacity: 0; } 15% { opacity: 1; } 85% { opacity: 1; } 100% { top: calc(100% - 2px); opacity: 0; } }
  .fx-lock .stp { position: absolute; width: 0; height: 0; }
  .fx-lock .stp::before { content: ""; position: absolute; left: calc(var(--w) / -2); top: calc(var(--h) / -2); width: var(--w); height: var(--h); border-radius: 7px; background: var(--rv-st-done-dot); animation: rv-stp-close .26s cubic-bezier(.22,1,.36,1) forwards; }
  @keyframes rv-stp-close { to { left: -13px; top: -13px; width: 26px; height: 26px; border-radius: 50%; } }
  .fx-lock .stp svg { position: absolute; left: -8px; top: -8px; }
  .fx-lock .stp .ring { position: absolute; left: 50%; top: 50%; width: 26px; height: 26px; margin: -13px; border-radius: 50%; border: 2px solid var(--rv-st-done-dot); opacity: 0; animation: rv-ring .5s cubic-bezier(.22,1,.36,1) .2s forwards; }
  @keyframes rv-ring { 0% { opacity: .7; transform: scale(1); } 100% { opacity: 0; transform: scale(2.6); } }
  .fx-lock .stp-tick { stroke-dasharray: 1; stroke-dashoffset: 1; animation: rv-tick-draw .22s cubic-bezier(.4,0,.2,1) .2s forwards; }
  @keyframes rv-tick-draw { to { stroke-dashoffset: 0; } } /* not rv-draw: that one is the bar's, from 20 */
  .page-back { position: fixed; left: 16px; top: 12px; z-index: 10; font: 12px/1.4 -apple-system, system-ui, sans-serif; color: var(--rv-ink-3); text-decoration: none; }
  .page-back:hover { color: var(--rv-ink); }
  :host([data-page]) .panel { transform: none; visibility: visible; transition: none; position: relative; width: min(880px, 100%); height: 100vh; margin: 0 auto; box-shadow: none; border-left: 1px solid hsl(var(--rv-n20)); border-right: 1px solid hsl(var(--rv-n20)); }
  :host([data-page]) .panel-head { padding-top: 18px; }
  :host([data-page]) .panel-back { display: inline-flex; }
  /* the way back to the console, on the page only: a line button at the start of the head, the arrow and the tooltip */
  .panel-back { position: relative; display: none; align-items: center; justify-content: center; width: 26px; height: 26px; margin-right: 2px; border: 1px solid hsl(var(--rv-n30)); border-radius: 6px; background: var(--rv-surface); color: hsl(var(--rv-n70)); cursor: pointer; text-decoration: none; }
  .panel-back:hover { border-color: hsl(var(--rv-n90)); background: hsl(var(--rv-n10)); color: hsl(var(--rv-n130)); }
  /* the theme switch (Nirav, 2026-10-23): the product's switch, folded to the picked side at rest; under the pointer
     all three show, always in the same order (Auto, Light, Dark), so a click never reshuffles them */
  .theme-switch { margin-right: 2px; }
  /* tucked away (Nirav, 2026-10-23): most people stay on Auto, so the switch only fades in while the pointer is over
     the drawer's head; at rest it takes no room, the copy buttons sit where they always did */
  .theme-switch { max-width: 0; padding-left: 0; padding-right: 0; margin-right: -8px; opacity: 0; pointer-events: none; transition: max-width .22s cubic-bezier(.32,.72,0,1), padding .22s cubic-bezier(.32,.72,0,1), margin .22s cubic-bezier(.32,.72,0,1), opacity .16s ease; }
  .panel-head:hover .theme-switch, .theme-switch:has(.side:focus-visible) { max-width: 90px; padding-left: 2px; padding-right: 2px; margin-right: 2px; opacity: 1; pointer-events: auto; }
  .theme-switch .side { transition: width .2s cubic-bezier(.32,.72,0,1), margin .2s cubic-bezier(.32,.72,0,1), opacity .15s ease, background-color .12s, color .12s; }
  .theme-switch .side:not([aria-pressed="true"]) { width: 0; margin-left: -2px; opacity: 0; pointer-events: none; }
  .theme-switch:hover .side, .theme-switch:has(.side:focus-visible) .side { width: 24px; margin-left: 0; opacity: 1; pointer-events: auto; }
  .theme-switch .side .scope-tip { left: auto; right: 0; transform: none; }
  /* the switch between light and dark (Nirav, 2026-10-23): a crossfade where the browser offers one (switchTheme);
     otherwise the big surfaces ease their colours, text untouched so it never shimmers */
  :host([data-theming]) .panel, :host([data-theming]) .panel-bar, :host([data-theming]) .panel-body, :host([data-theming]) .card, :host([data-theming]) .scope-switch, :host([data-theming]) .scope-crumb, :host([data-theming]) .panel-copy, :host([data-theming]) .theme-switch, :host([data-theming]) .panel-back { transition: background-color .3s ease, border-color .3s ease !important; }
  @media (prefers-reduced-motion: reduce) { :host([data-theming]) * { transition: none !important; } .theme-switch .side { transition: none; } }
  .panel-back .scope-tip { left: 0; transform: none; }
  .panel-back:hover .scope-tip { opacity: 1; }
  :host([data-capturing]) * { visibility: hidden !important; }
  :host([data-hit]) * { pointer-events: none !important; } /* while targetAt measures what is under a point */
  /* review hidden (${HIDE_KEY} or the bar's eye button): nothing on screen but the toast that says how to bring it back */
  :host([data-off]) .bar, :host([data-off]) .bar-mini, :host([data-off]) .hover, :host([data-off]) .pins, :host([data-off]) .pin-tip, :host([data-off]) .composer, :host([data-off]) .panel-veil, :host([data-off]) .panel, :host([data-off]) .lightbox { display: none !important; }
</style>
<div class="hover ui"><span class="tag"></span></div>
<div class="pins"></div>
<div class="pin-tip ui"></div>
<div class="composer ui">
  <div class="pin-row"><span class="num">1</span><span class="what"></span></div>
  <div class="sev scope-switch"></div>
  <textarea placeholder="What should change here?" rows="3"></textarea>
  <div class="actions"><button class="btn cancel">Cancel</button><button class="btn primary save">Save</button></div>
</div>
<div class="bar ui"><button class="sat dock" aria-label="Minimise to the edge"><svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="4" width="18" height="16" rx="2.5"/><rect x="12" y="12" width="6" height="5" rx="1" fill="currentColor" stroke="none"/></svg><span class="scope-tip">Minimise to the edge</span></button><button class="sat off" aria-label="Turn off review"><svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 3v9"/><path d="M6.3 6.8a8 8 0 1 0 11.4 0"/></svg><span class="scope-tip">Turn off review · ${HIDE_KEY} turns it on</span></button><span class="bar-main"><span class="brand"><button class="dot" title="Pictures: off. Click to share this tab (or load the review extension for silent pictures)"></button><b>Review${window.__reviewSession ? ` · ${window.__reviewSession}` : ""}</b></span><span class="k"></span></span><button class="pins-toggle on disc" aria-label="Pins"><svg class="bi" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M15 4.5l-4 4-4 1.5-1.5 1.5 7 7 1.5-1.5 1.5-4 4-4"/><path d="M9 15l-4.5 4.5"/><path d="M14.5 4l5.5 5.5"/></svg><span class="scope-tip">Show or hide the pins</span></button><button class="list disc" aria-label="Comments"><svg class="bi" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><rect x="3" y="4" width="18" height="16" rx="2.5"/><path d="M14.5 4v16"/></svg><span class="count"></span><span class="scope-tip">Comments, in a side panel</span></button></div>
<div class="panel-veil"></div>
<aside class="panel ui" aria-label="Review comments" role="dialog" aria-modal="true">
  <div class="panel-head"><a class="panel-back" href="/" aria-label="Back to the console"><svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M19 12H5M12 19l-7-7 7-7"/></svg><span class="scope-tip">Back to the console</span></a><a class="panel-title" href="/__review/" target="_blank" aria-label="Open as a page"><span class="txt">Comments</span><svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M7 17L17 7M9 7h8v8"/></svg><span class="scope-tip">Open as a page</span></a><div class="scope-switch panel-view" role="group"><button type="button" class="side" data-v="open">Open<b></b></button><button type="button" class="side" data-v="resolved">Approved<b></b></button></div><div class="scope-switch theme-switch" role="group" aria-label="Theme"><button type="button" class="side" data-t="auto" aria-pressed="false" aria-label="Auto, follows your computer"><svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="8.5"/><path d="M12 3.5a8.5 8.5 0 0 1 0 17z" fill="currentColor" stroke="none"/></svg><span class="scope-tip">Auto, follows your computer</span></button><button type="button" class="side" data-t="light" aria-pressed="false" aria-label="Light"><svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="4"/><path d="M12 2.5v2M12 19.5v2M4.6 4.6l1.4 1.4M18 18l1.4 1.4M2.5 12h2M19.5 12h2M4.6 19.4L6 18M18 6l1.4-1.4"/></svg><span class="scope-tip">Light</span></button><button type="button" class="side" data-t="dark" aria-pressed="false" aria-label="Dark"><svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M20 14.5A8 8 0 0 1 9.5 4a8 8 0 1 0 10.5 10.5z"/></svg><span class="scope-tip">Dark</span></button></div><button class="panel-copy" data-kind="prompt" aria-label="Copy a brief for Claude"><svg class="logo-claude" width="15" height="15" viewBox="0 0 24 24" aria-hidden="true"><path d="m4.7144 15.9555 4.7174-2.6471.079-.2307-.079-.1275h-.2307l-.7893-.0486-2.6956-.0729-2.3375-.0971-2.2646-.1214-.5707-.1215-.5343-.7042.0546-.3522.4797-.3218.686.0608 1.5179.1032 2.2767.1578 1.6514.0972 2.4468.255h.3886l.0546-.1579-.1336-.0971-.1032-.0972L6.973 9.8356l-2.55-1.6879-1.3356-.9714-.7225-.4918-.3643-.4614-.1578-1.0078.6557-.7225.8803.0607.2246.0607.8925.686 1.9064 1.4754 2.4893 1.8336.3643.3035.1457-.1032.0182-.0728-.164-.2733-1.3539-2.4467-1.445-2.4893-.6435-1.032-.17-.6194c-.0607-.255-.1032-.4674-.1032-.7285L6.287.1335 6.6997 0l.9957.1336.419.3642.6192 1.4147 1.0018 2.2282 1.5543 3.0296.4553.8985.2429.8318.091.255h.1579v-.1457l.1275-1.706.2368-2.0947.2307-2.6957.0789-.7589.3764-.9107.7468-.4918.5828.2793.4797.686-.0668.4433-.2853 1.8517-.5586 2.9021-.3643 1.9429h.2125l.2429-.2429.9835-1.3053 1.6514-2.0643.7286-.8196.85-.9046.5464-.4311h1.0321l.759 1.1293-.34 1.1657-1.0625 1.3478-.8804 1.1414-1.2628 1.7-.7893 1.36.0729.1093.1882-.0183 2.8535-.607 1.5421-.2794 1.8396-.3157.8318.3886.091.3946-.3278.8075-1.967.4857-2.3072.4614-3.4364.8136-.0425.0304.0486.0607 1.5482.1457.6618.0364h1.621l3.0175.2247.7892.522.4736.6376-.079.4857-1.2142.6193-1.6393-.3886-3.825-.9107-1.3113-.3279h-.1822v.1093l1.0929 1.0686 2.0035 1.8092 2.5075 2.3314.1275.5768-.3218.4554-.34-.0486-2.2039-1.6575-.85-.7468-1.9246-1.621h-.1275v.17l.4432.6496 2.3436 3.5214.1214 1.0807-.17.3521-.6071.2125-.6679-.1214-1.3721-1.9246L14.38 17.959l-1.1414-1.9428-.1397.079-.674 7.2552-.3156.3703-.7286.2793-.6071-.4614-.3218-.7468.3218-1.4753.3886-1.9246.3157-1.53.2853-1.9004.17-.6314-.0121-.0425-.1397.0182-1.4328 1.9672-2.1796 2.9446-1.7243 1.8456-.4128.164-.7164-.3704.0667-.6618.4008-.5889 2.386-3.0357 1.4389-1.882.929-1.0868-.0062-.1579h-.0546l-6.3385 4.1164-1.1293.1457-.4857-.4554.0608-.7467.2307-.2429 1.9064-1.3114Z"/></svg><svg class="ring" viewBox="0 0 28 28" aria-hidden="true"><rect x="1" y="1" width="26" height="26" rx="7" pathLength="100"/></svg><span class="scope-tip">Copy a brief for Claude</span></button><button class="panel-copy" data-kind="loop" aria-label="Copy a checklist for Loop"><svg class="logo-loop-rest" width="16" height="16" viewBox="0 0 24 24" aria-hidden="true"><path d="M12 2A10 10 0 0 0 2 12v10h10a10 10 0 0 0 0-20Zm0 6.5a3.5 3.5 0 1 1 0 7H8.5V12A3.5 3.5 0 0 1 12 8.5Z"/></svg><svg class="logo-loop" width="16" height="16" viewBox="0 0 24 24" fill="none" aria-hidden="true"> <path d="M12 2A10 10 0 0 0 2 12v10h10a10 10 0 0 0 0-20Zm0 6.5a3.5 3.5 0 1 1 0 7H8.5V12A3.5 3.5 0 0 1 12 8.5Z" fill="url(#rv-loop-a)"/> <path d="M22 12a10 10 0 0 1-10 10H2a6.5 6.5 0 0 1 6.5-6.5H12a3.5 3.5 0 0 0 3.5-3.5H22Z" fill="url(#rv-loop-b)"/> <path d="M22 12a10 10 0 0 1-10 10H2a6.5 6.5 0 0 1 6.5-6.5H12a3.5 3.5 0 0 0 3.5-3.5H22Z" fill="url(#rv-loop-c)" fill-opacity=".56"/> <path d="M22 12a10 10 0 0 1-10 10H2a6.5 6.5 0 0 1 6.5-6.5H12a3.5 3.5 0 0 0 3.5-3.5H22Z" fill="url(#rv-loop-d)" fill-opacity=".15"/> <path d="M12 2A10 10 0 0 0 2 12v10a6.5 6.5 0 0 0 6.5-6.48l.02-.02H8.5V12a3.5 3.5 0 0 1 6-2.46l4.6-4.58A9.97 9.97 0 0 0 12 2Z" fill="url(#rv-loop-e)"/> <path d="M12 2A10 10 0 0 0 2 12v10a6.5 6.5 0 0 0 6.5-6.48l.02-.02H8.5V12a3.5 3.5 0 0 1 6-2.46l4.6-4.58A9.97 9.97 0 0 0 12 2Z" fill="url(#rv-loop-f)"/> <defs> <radialGradient id="rv-loop-c" cx="0" cy="0" r="1" gradientUnits="userSpaceOnUse" gradientTransform="matrix(4 2.75 -4.83318 7.0301 5.5 17.75)"> <stop/> <stop offset=".7" stop-opacity="0"/> </radialGradient> <radialGradient id="rv-loop-d" cx="0" cy="0" r="1" gradientUnits="userSpaceOnUse" gradientTransform="matrix(7.4 4.6 -8.08463 13.0057 4.3 17)"> <stop offset=".33"/> <stop offset=".6" stop-opacity="0"/> </radialGradient> <radialGradient id="rv-loop-f" cx="0" cy="0" r="1" gradientUnits="userSpaceOnUse" gradientTransform="matrix(13.40004 -2.3 6.04701 35.2304 .3 8.2)"> <stop stop-color="#6D05E8"/> <stop offset="1" stop-color="#6D05E8" stop-opacity="0"/> </radialGradient> <linearGradient id="rv-loop-a" x1="14.2" y1="9.1" x2="10.9" y2="22.6" gradientUnits="userSpaceOnUse"> <stop stop-color="#9237E3"/> <stop offset="1" stop-color="#48E6F3"/> </linearGradient> <linearGradient id="rv-loop-b" x1="8.5" y1="20.5" x2="17.3" y2="18.5" gradientUnits="userSpaceOnUse"> <stop stop-color="#51E6FF"/> <stop offset="1" stop-color="#71D4FF" stop-opacity="0"/> </linearGradient> <linearGradient id="rv-loop-e" x1="6.1" y1="12.7" x2="11.2" y2="5.5" gradientUnits="userSpaceOnUse"> <stop stop-color="#6E06E9"/> <stop offset="1" stop-color="#AB5ADD" stop-opacity="0"/> </linearGradient> </defs> </svg><svg class="ring" viewBox="0 0 28 28" aria-hidden="true"><rect x="1" y="1" width="26" height="26" rx="7" pathLength="100"/></svg><span class="scope-tip">Copy a checklist for Loop</span><i class="more"></i></button></div>
  <div class="panel-bar"><div class="panel-scope"></div><div class="panel-filter"></div></div>
  <div class="panel-sync" hidden><span class="ring"></span><span class="txt"></span></div>
  <div class="panel-body"></div>
</aside>
<div class="lightbox ui" role="dialog" aria-label="Picture">
  <div class="lb-frame">
    <div class="lb-top"><span class="lb-n"></span><span class="lb-sev"></span><span class="lb-text"></span><span class="lb-count"></span><button class="lb-prev" title="Previous (←)"><svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M15 18l-6-6 6-6"/></svg></button><button class="lb-next" title="Next (→)"><svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M9 18l6-6-6-6"/></svg></button><button class="lb-close" title="Close (Esc)"><svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M18 6L6 18M6 6l12 12"/></svg></button></div>
    <div class="lb-pic"><img class="lb-img" alt=""></div>
    <div class="lb-foot"><span class="lb-where"></span><span class="lb-hint">Esc closes · ← → other pictures</span></div>
  </div>
</div>
<button class="bar-mini ui" title="Review (click to expand)"><svg class="glyph" width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path class="l1" d="M4 7h14"/><path class="l2" d="M4 12h9"/><path class="l3" d="M4 17h6"/><path class="spark" d="M17 11.5l1.1 2.6 2.6 1.1-2.6 1.1L17 19l-1.1-2.7-2.6-1.1 2.6-1.1z" fill="currentColor" stroke="none"/></svg><span class="mini-dot"></span><span class="mini-n"></span></button>
<div class="toast ui"></div>
`;
const $ = (s) => root.querySelector(s);
/* a page may not open an extension page itself (Chrome blocks the link): the extension opens it in a new tab */
function openExtPage(url) {
  window.postMessage({ type: "review-open", url }, "*");
}
if (EXT) {
  /* the extension's own list page stands in for /__review/ */
  const t = $(".panel-title");
  if (t) {
    t.href = EXT.listUrl;
    t.addEventListener("click", (e) => {
      e.preventDefault();
      openExtPage(EXT.listUrl);
    });
  }
  if (PAGE_MODE) $(".panel-back")?.remove();
}
const hoverBox = $(".hover");
const hoverTag = $(".hover .tag");
const pinsEl = $(".pins");
const composer = $(".composer");
const ta = $("textarea");
const sevEl = $(".sev");
const bar = $(".bar");
const dot = $(".bar .dot");
const countEl = $(".bar .count");
const toastEl = $(".toast");
let severity = "fix";

for (const [k, label] of SEVERITIES) {
  const b = document.createElement("button");
  b.type = "button";
  b.dataset.k = k;
  b.innerHTML = `<span class="dot"></span><span class="lbl">${label}</span><span class="scope-tip">${label}</span>`;
  b.setAttribute("aria-label", label);
  b.className = k === severity ? "on" : "";
  b.addEventListener("click", () => {
    severity = k;
    for (const x of sevEl.children) x.classList.toggle("on", x.dataset.k === k);
    ta.focus();
  });
  sevEl.appendChild(b);
}

/* nothing that happens inside the composer may reach the app: its shortcuts read Shift+letter, and a
   drawer or popover closes itself when a click or the focus lands outside it (Radix DismissableLayer) */
for (const t of ["keydown", "keyup", "keypress", "pointerdown", "mousedown", "pointerup", "mouseup", "click", "touchstart", "touchend", "focusin", "focusout"])
  host.addEventListener(t, (e) => e.stopPropagation());
/* ...and an open drawer's scroll lock (react-remove-scroll) cancels any wheel or touch event that is not inside the
   drawer, which would freeze the panel's own scrolling: those events stop at the window before the lock sees them
   (propagation only; the scroll itself is the default action and still happens) */
for (const t of ["wheel", "touchmove"])
  window.addEventListener(
    t,
    (e) => {
      if (e.composedPath().includes(host)) e.stopImmediatePropagation();
    },
    { capture: true, passive: true }
  );
/* ...and a focus trap (Radix FocusScope on a modal drawer) watches the document for focus leaving it, then pulls it
   back; that leaves our textarea without focus and Enter lands on the drawer's close button. Hide the move from it. */
for (const t of ["focusin", "focusout", "focus", "blur"])
  window.addEventListener(
    t,
    (e) => {
      if (e.composedPath().includes(host) || e.relatedTarget === host) e.stopImmediatePropagation();
    },
    true
  );

/* ---------- describing what was clicked ---------- */
const txt = (el) => (el ? (el.textContent || "").replace(/\s+/g, " ").trim() : "");
const KIND = { button: "Button", a: "Link", input: "Field", textarea: "Field", select: "Select", td: "Cell", th: "Column header", tr: "Row", li: "Item", h1: "Heading", h2: "Heading", h3: "Heading", h4: "Heading", img: "Image", svg: "Icon", label: "Label", nav: "Navigation", table: "Table", p: "Text", menuitem: "Menu item", option: "Option", tab: "Tab", checkbox: "Checkbox", radio: "Radio", switch: "Switch", dialog: "Dialog", combobox: "Select", menu: "Menu", tooltip: "Tooltip", link: "Link", listbox: "List", row: "Row", cell: "Cell", columnheader: "Column header", tabpanel: "Tab panel", group: "Group", region: "Section" };
/* what was pointed at, in words: the kind of thing and its label; a plain box with text is just its text */
function describe(el) {
  const role = el.getAttribute("role");
  const tag = el.tagName.toLowerCase();
  const kind = KIND[role] || KIND[tag] || "";
  /* the label: the first visible line (a card's title, not its title run into its subtitle) */
  const firstLine = (el.innerText || txt(el)).split("\n").map((l) => l.trim()).find(Boolean) || "";
  const label = el.getAttribute("aria-label") || el.getAttribute("title") || el.getAttribute("placeholder") || el.getAttribute("alt") || firstLine.slice(0, 48);
  if (kind && label) return `${kind} "${label}"`;
  if (kind) return kind;
  return label ? `"${label}"` : "Area";
}
/* closest() that climbs out of shadow roots too (a drawer's content lives inside its component) */
function closestDeep(el, sel) {
  for (let cur = el, n = 0; cur && n < 20; n++) {
    const hit = cur.closest?.(sel);
    if (hit) return hit;
    if (cur.assignedSlot) cur = cur.assignedSlot; // slotted content: its place is inside the component
    else {
      const rootNode = cur.getRootNode();
      cur = rootNode instanceof ShadowRoot ? rootNode.host : null;
    }
  }
  return null;
}
/* "Drawer or dialog: Editing policy from storage.objectsDocs" and "Drawer or dialog: Editing policy from
   storage.objects" are the same dialog: the first words of the title decide, not what a header link adds */
function sameDialog(a, b) {
  const key = (t) => String(t || "").replace(/^Drawer or dialog:\s*/, "").toLowerCase().replace(/[^a-z0-9]+/g, " ").trim().split(" ").slice(0, 4).join(" ");
  return key(a) === key(b);
}
function contextOf(el) {
  const dlg = closestDeep(el, "[role=dialog],[role=alertdialog],dialog[open]"); // a native <dialog> too, in a shadow root too
  if (dlg) {
    const h = dlg.querySelector("h1,h2,h3,[id$=title],[class*=title]");
    return `Drawer or dialog: ${txt(h).slice(0, 60) || "untitled"}`;
  }
  if (closestDeep(el, "[data-radix-popper-content-wrapper],[role=menu],[role=listbox],[role=tooltip],[role=combobox],:popover-open,[popover]")) return "Popover or menu";
  if (el.closest("header")) return "Page header";
  if (el.closest("nav")) return "Navigation";
  const cell = el.closest("td,th");
  if (cell) {
    const table = cell.closest("table");
    const idx = Array.from(cell.parentElement.children).indexOf(cell);
    const head = table?.querySelectorAll("thead th")[idx];
    return `Table${head ? `, column "${txt(head).slice(0, 30)}"` : ""}`;
  }
  const sec = el.closest("section,article,[role=region],[role=tabpanel]");
  if (sec) {
    const h = sec.querySelector("h1,h2,h3,h4");
    if (h) return `Section: ${txt(h).slice(0, 60)}`;
  }
  return "Page";
}
function cssPath(el) {
  const parts = [];
  let cur = el;
  while (cur && cur !== document.body && parts.length < 5) {
    let s = cur.tagName.toLowerCase();
    if (cur.id) s += `#${cur.id}`;
    else if (cur.classList.length) s += "." + Array.from(cur.classList).slice(0, 3).join(".");
    parts.unshift(s);
    cur = cur.parentElement;
  }
  return parts.join(" > ");
}
/* a selector that finds the same element again after a reload or when a drawer reopens: ids are used only
   when stable (Radix ids like radix-:r1: change on every mount), else tag + nth-of-type up the tree */
/* an id a framework made up (Radix, Headless UI, MUI, React Aria, Vue, Ember…) changes every mount: not an address */
const stableId = (id) => !/:/.test(id) && !/^(radix-|headlessui-|react-aria|mui-|cdk-|mat-|v-\d|ember\d|rc_|rc-|ant-|chakra-|downshift-|tippy-)/i.test(id) && !/^[_:]?r[_:]?[0-9a-z]{1,4}[_:]?$/i.test(id);
/* a selector for one tree; an element inside a web component's shadow root gets "host >>> inner", host first */
function selectorFor(el) {
  const parts = [];
  let cur = el;
  while (cur && cur !== document.body && parts.length < 12) {
    if (cur.id && stableId(cur.id)) {
      parts.unshift(`#${CSS.escape(cur.id)}`);
      break;
    }
    let s = cur.tagName.toLowerCase();
    const sibs = cur.parentElement ? Array.from(cur.parentElement.children).filter((c) => c.tagName === cur.tagName) : [];
    if (sibs.length > 1) s += `:nth-of-type(${sibs.indexOf(cur) + 1})`;
    parts.unshift(s);
    if (!cur.parentElement) {
      const rootNode = cur.getRootNode();
      if (rootNode instanceof ShadowRoot && rootNode.host) return `${selectorFor(rootNode.host)} >>> ${parts.join(" > ")}`;
    }
    cur = cur.parentElement;
  }
  return parts.join(" > ");
}
/* querySelectorAll for such a selector: each ">>>" steps into the matched hosts' shadow roots */
function queryDeep(selector, root = document) {
  const [head, ...rest] = String(selector).split(" >>> ");
  const hits = Array.from(root.querySelectorAll(head));
  if (!rest.length) return hits;
  const out = [];
  for (const h of hits) if (h.shadowRoot) out.push(...queryDeep(rest.join(" >>> "), h.shadowRoot));
  return out;
}
/* the module: the left nav's group label above the active row ("Operations"), and the row itself ("Agent Fleet");
   for routes the nav is not showing (or older comments) a map of the console's sections */
const GROUPS = {
  "People & Access": ["users", "service-accounts", "teams", "roles", "access-profiles"],
  Administration: ["organizations", "my-organization", "client-organizations", "organization"],
  Customization: ["user-attributes", "organization-attributes"],
  Operations: ["agent-fleet", "collector-fleet", "collectors"],
  Discovery: ["credential-profiles", "secret-stores", "discovery-profiles", "discovery-runs"],
};
function moduleOf(route) {
  const seg = (route || location.pathname).split("?")[0].split("/").filter(Boolean)[0] || "";
  const on = document.querySelector('.snv-row[data-on="true"]');
  if (on && (!route || route.split("?")[0] === location.pathname)) {
    let lab = on.previousElementSibling;
    while (lab && !lab.classList.contains("snv-label")) lab = lab.previousElementSibling;
    return { group: lab ? txt(lab) : "", item: txt(on.querySelector(".snv-lbl")) || txt(on), seg };
  }
  const group = Object.keys(GROUPS).find((g) => GROUPS[g].includes(seg)) || "";
  return { group, item: seg.replace(/-/g, " ").replace(/^\w/, (ch) => ch.toUpperCase()), seg };
}
/* the page's name: its heading; without one, the first piece of the tab's title ("review_comments | Table Editor |
   Design Review | Supabase" is the page, a section and the site) */
function pageTitle() {
  const h = document.querySelector("main h1, h1");
  const fromH = txt(h).slice(0, 80);
  if (fromH) return fromH;
  const piece = document.title.split(/\s+[|–—·»›]\s+|\s+-\s+|:\s+/).map((p) => p.trim()).find(Boolean) || document.title;
  return piece.slice(0, 80);
}

/* ---------- hover outline ---------- */
function targetAt(x, y) {
  /* An open Select or menu (Radix) puts pointer-events: none on the body and its layers, so a plain
     elementFromPoint hits a backdrop or nothing. Make everything hittable for the measurement (never our
     own host), then dig through any layer that covers the whole screen: a backdrop is not a target. */
  const lift = document.createElement("style");
  lift.textContent = "* { pointer-events: auto !important } #__review-host { pointer-events: none !important }";
  document.head.appendChild(lift);
  host.setAttribute("data-hit", ""); // our own pins, tip and bar step aside too (a page stylesheet cannot reach them)
  const hidden = [];
  let el = null;
  try {
    for (let i = 0; i < 6; i++) {
      el = document.elementFromPoint(x, y);
      if (!el || el === document.documentElement || el === document.body) {
        el = null;
        break;
      }
      const r = el.getBoundingClientRect();
      const layer = r.width * r.height >= 0.85 * window.innerWidth * window.innerHeight;
      if (!layer) break;
      hidden.push([el, el.style.getPropertyValue("pointer-events"), el.style.getPropertyPriority("pointer-events")]);
      el.style.setProperty("pointer-events", "none", "important");
      el = null;
    }
  } finally {
    for (const [e, v, pr] of hidden) (v ? e.style.setProperty("pointer-events", v, pr) : e.style.removeProperty("pointer-events"));
    lift.remove();
    host.removeAttribute("data-hit");
  }
  if (!el) return null;
  /* a web component: hit-testing stops at its boundary; the real element is inside its shadow root */
  for (let depth = 0; depth < 6 && el.shadowRoot && el !== host; depth++) {
    const inner = el.shadowRoot.elementFromPoint(x, y);
    if (!inner || inner === el) break;
    el = inner;
  }
  /* a shape inside an icon means the icon's owner: the button, link or cell it sits in */
  if (el.namespaceURI === "http://www.w3.org/2000/svg") {
    const svg = el.closest("svg");
    el = svg?.closest("button,a,[role],label,td,th") || svg?.parentElement || el;
  }
  return el;
}
function showHover(el) {
  state.hover = el;
  if (!el) {
    hoverBox.classList.remove("on");
    return;
  }
  const r = el.getBoundingClientRect();
  hoverBox.style.left = `${r.left - 2}px`;
  hoverBox.style.top = `${r.top - 2}px`;
  hoverBox.style.width = `${r.width + 4}px`;
  hoverBox.style.height = `${r.height + 4}px`;
  hoverBox.classList.toggle("flip", r.top < 28);
  hoverTag.textContent = `${describe(el)} · ${contextOf(el)}`;
  hoverBox.classList.add("on");
}
const armed = () => (state.alt || state.sticky) && !state.pending && !state.capturing && !state.off;

window.addEventListener(
  "mousemove",
  (e) => {
    state.mouse = { x: e.clientX, y: e.clientY };
    state.alt = e.altKey;
    if (!e.composedPath().includes(host) && e.target instanceof Element && !e.target.closest("[data-radix-popper-content-wrapper],[role=tooltip]")) state.lastHover = e.target;
    if (armed()) showHover(targetAt(e.clientX, e.clientY));
    else if (state.hover && !state.pending) showHover(null);
  },
  true
);
window.addEventListener(
  "keydown",
  (e) => {
    if (e.key === "Alt") {
      state.alt = true;
      if (armed()) showHover(targetAt(state.mouse.x, state.mouse.y));
    }
    /* the one shortcut that works while review is hidden: it brings it back */
    if (e.shiftKey && e.altKey && e.code === "KeyH" && !PAGE_MODE) {
      e.preventDefault();
      e.stopImmediatePropagation();
      setReview(state.off);
      return;
    }
    if (state.off) return;
    if (lightbox.classList.contains("on")) {
      if (e.key === "Escape" || e.key === "ArrowLeft" || e.key === "ArrowRight") {
        e.stopPropagation();
        e.preventDefault();
        if (e.key === "Escape") closeLightbox();
        else stepLightbox(e.key === "ArrowLeft" ? -1 : 1);
      }
      return;
    }
    /* "/" opens the list's search while the drawer is open (Nirav, 2026-10-23), unless a field anywhere has the keys */
    if (e.key === "/" && !e.metaKey && !e.ctrlKey && !e.altKey && panel.classList.contains("on") && !state.pending && !state.asking) {
      const inField = e.composedPath().some((n) => n instanceof HTMLElement && (n.matches("input, textarea, select") || n.isContentEditable));
      if (!inField) {
        e.preventDefault();
        e.stopPropagation();
        tools.classList.remove("away");
        toolsIn.focus();
        return;
      }
    }
    if (e.key === "Escape") {
      const typing = e.composedPath().some((n) => n instanceof HTMLElement && n.getRootNode() === root && (n.matches("input, textarea") || n.isContentEditable));
      if (state.pending) {
        e.stopPropagation();
        e.preventDefault();
        closeComposer();
      } else if (state.asking) {
        e.stopPropagation();
        e.preventDefault();
        cancelAsk();
      } else if (typing) {
        /* a field of ours (an in-place edit) takes its own Esc; the panel stays */
      } else if (panel.classList.contains("on") && state.selected.size) {
        /* a selection goes first; the next Esc closes the drawer */
        e.stopPropagation();
        e.preventDefault();
        for (const x of panelBody.querySelectorAll(".card.picked")) setPicked(x, false);
        state.selected.clear();
        renderPickPill();
        refreshCopyLabels();
      } else if (panel.classList.contains("on")) {
        openPanel(false);
      } else if (state.sticky) {
        setSticky(false);
      }
    }
    if (e.shiftKey && e.altKey && (e.code === "KeyR" || e.key.toLowerCase() === "r" || e.key === "‰")) {
      e.preventDefault();
      setSticky(!state.sticky);
    }
  },
  true
);
window.addEventListener(
  "keyup",
  (e) => {
    if (e.key === "Alt") {
      state.alt = false;
      if (!state.sticky && !state.pending) showHover(null);
    }
  },
  true
);
window.addEventListener("blur", () => {
  state.alt = false;
  if (!state.sticky && !state.pending) showHover(null);
});

/* swallow the whole click while armed so the app never sees it (Radix would close its popover on pointerdown) */
for (const t of ["pointerdown", "mousedown", "pointerup", "mouseup", "click", "auxclick", "contextmenu"]) {
  window.addEventListener(
    t,
    (e) => {
      if (e.composedPath().includes(host)) return;
      if (!(state.alt || e.altKey || state.sticky) || state.pending || state.capturing || state.off) return;
      e.preventDefault();
      e.stopImmediatePropagation();
      if (t === "click") beginComment(targetAt(e.clientX, e.clientY));
    },
    true
  );
}

/* a hover card or tooltip closes when the pointer leaves it; while a comment is being written the app
   must not hear about the pointer leaving (React builds its leave/enter from these). The same while a pin's
   card is up: a pin on a tooltip (comment 21) would vanish with the tooltip the moment the pointer steps from
   the pin onto the card. So the step from the app onto our pin or card is not told (the out/leave whose other
   side is us), nor is the pointer's movement over us (Radix watches document pointermove for its grace area);
   the step back onto the app passes, and the app closes its tooltip as usual. */
const onUs = () => $(".pin-tip").classList.contains("on");
for (const t of ["pointerover", "pointerout", "mouseover", "mouseout", "pointerenter", "pointerleave", "mouseenter", "mouseleave"])
  window.addEventListener(
    t,
    (e) => {
      const path = e.composedPath();
      const leaving = /out|leave/.test(t);
      if (state.pending && !path.includes(host)) e.stopImmediatePropagation();
      else if (onUs() && (path.includes(host) || (leaving && e.relatedTarget === host))) e.stopImmediatePropagation();
    },
    true
  );
window.addEventListener(
  "pointermove",
  (e) => {
    if (onUs() && e.composedPath().includes(host)) e.stopImmediatePropagation();
  },
  true
);

/* ---------- composer ---------- */
async function beginComment(el) {
  if (!el || state.pending || busy) return;
  if (EXT && state.hub && state.hub.signedIn === false) {
    toast("Sign in first: the Review icon in the toolbar, then Sign in with GitHub", true);
    return;
  }
  /* not sharing yet: the picker would steal the focus and close what was pointed at. Ask now, comment next click. */
  if (!extHere() && !(state.stream && state.stream.active) && !state.declined && navigator.mediaDevices?.getDisplayMedia) {
    showHover(null);
    const ok = await ensureStream();
    if (ok) toast(`Tab shared. Now ${MOD} + click again to comment.`);
    else {
      state.declined = true;
      toast(`Not shared: pictures will be a rough render. ${MOD} + click again to comment.`);
    }
    return;
  }
  const r0 = el.getBoundingClientRect();
  const rect = { x: r0.left, y: r0.top, w: r0.width, h: r0.height };
  state.pending = { el, rect, shot: null, how: "none" };
  /* the number first (from the server, so it matches whatever was removed meanwhile), then the picture:
     taken NOW, before the box appears, so it is exactly what was pointed at (a hover card, an open menu) */
  await loadComments();
$(".bar .k").textContent = `${MOD} + click to comment`;
  const n = state.lastN + 1;
  try {
    state.capturing = true;
    host.setAttribute("data-capturing", "");
    const shot = await grabFrame();
    drawMarker(shot.canvas, shot.sx, shot.sy, rect, n);
    state.pending.shot = shot.canvas.toDataURL("image/png");
    state.pending.how = shot.how;
    /* the box in picture pixels, and the picture's size: the live number is placed from these */
    state.pending.mark = { x: rect.x * shot.sx, y: rect.y * shot.sy, w: rect.w * shot.sx, h: rect.h * shot.sy, cw: shot.canvas.width, ch: shot.canvas.height, s: shot.sx };
  } catch (e) {
    console.warn("[review] no picture:", e);
  } finally {
    host.removeAttribute("data-capturing");
    state.capturing = false;
  }
  if (!state.pending) return; // cancelled meanwhile
  showHover(el);
  $(".composer .num").textContent = n;
  const what = $(".composer .what");
  what.innerHTML = "<b></b><span></span>";
  what.querySelector("b").textContent = describe(el);
  what.querySelector("span").textContent = ` · ${pageTitle()} · ${contextOf(el)}${state.pending.shot ? "" : " · no picture"}`;
  ta.value = "";
  const W = 320;
  const H = 230;
  let left = Math.min(Math.max(8, rect.x), window.innerWidth - W - 8);
  let top = rect.y + rect.h + 44; // room for the pin above the box
  if (top + H > window.innerHeight - 8) top = Math.max(42, rect.y - H - 10);
  if (rect.h > window.innerHeight * 0.7) {
    /* a huge target (whole page or drawer): float the box beside the cursor instead */
    left = Math.min(state.mouse.x + 12, window.innerWidth - W - 8);
    top = Math.min(state.mouse.y + 12, window.innerHeight - H - 8);
  }
  composer.style.left = `${left}px`;
  composer.style.top = `${top}px`;
  composer.classList.add("on");
  host.setAttribute("data-composing", "");
  setTimeout(() => ta.focus(), 0);
}
function closeComposer() {
  state.pending = null;
  composer.classList.remove("on");
  host.removeAttribute("data-composing");
  showHover(null);
}
$(".cancel").addEventListener("click", closeComposer);
$(".save").addEventListener("click", save);
ta.addEventListener("keydown", (e) => {
  if (e.key === "Enter" && !e.shiftKey) {
    e.preventDefault();
    save();
  }
  if (e.key === "Escape") {
    e.preventDefault();
    closeComposer();
  }
});

/* ---------- pictures ---------- */
async function ensureStream() {
  if (state.stream && state.stream.active) return state.stream;
  if (!navigator.mediaDevices?.getDisplayMedia) return null;
  try {
    const stream = await navigator.mediaDevices.getDisplayMedia({
      video: { displaySurface: "browser", frameRate: 30, cursor: "never" },
      audio: false,
      preferCurrentTab: true,
      selfBrowserSurface: "include",
      surfaceSwitching: "exclude",
      monitorTypeSurfaces: "exclude",
    });
    const video = document.createElement("video");
    video.muted = true;
    video.playsInline = true;
    video.srcObject = stream;
    video.style.cssText = "position:fixed;width:1px;height:1px;opacity:0;pointer-events:none;left:-10px;top:-10px";
    document.body.appendChild(video);
    await video.play();
    await new Promise((r) => (video.videoWidth ? r() : (video.onloadedmetadata = r)));
    state.stream = stream;
    state.video = video;
    stream.getVideoTracks()[0].addEventListener("ended", () => {
      state.stream = null;
      video.remove();
      state.video = null;
      dot.classList.remove("live");
      dot.title = "Pictures: off. Click to share this tab";
    });
    dot.classList.add("live");
    dot.title = "Pictures: on (sharing this tab)";
    return stream;
  } catch {
    return null;
  }
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const twoFrames = () => new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)));

/* the dev extension (next-gen-ui/review-extension), when loaded: a silent, pixel-exact picture of the tab, no picker */
const extHere = () => document.documentElement.hasAttribute("data-review-ext");
function extCapture() {
  return new Promise((resolve) => {
    const id = Math.random().toString(36).slice(2);
    const t = setTimeout(() => {
      window.removeEventListener("message", on);
      console.warn("[review] extension did not answer in time");
      toast("The extension did not answer in time", true);
      resolve(null);
    }, 2500);
    const on = (e) => {
      if (e.source !== window || e.data?.type !== "review-capture-reply" || e.data.id !== id) return;
      clearTimeout(t);
      window.removeEventListener("message", on);
      if (!e.data.ok) {
        console.warn("[review] extension could not take the picture:", e.data.error);
        toast(`The extension could not take the picture: ${e.data.error || "no reply"}`, true);
      }
      resolve(e.data.ok ? e.data.dataUrl : null);
    };
    window.addEventListener("message", on);
    window.postMessage({ type: "review-capture-request", id }, "*");
  });
}
async function grabFrame() {
  if (extHere()) {
    await twoFrames(); // the hide is painted
    const url = await extCapture();
    if (url) {
      const img = new Image();
      await new Promise((res, rej) => {
        img.onload = res;
        img.onerror = rej;
        img.src = url;
      });
      const c = document.createElement("canvas");
      c.width = img.naturalWidth;
      c.height = img.naturalHeight;
      c.getContext("2d").drawImage(img, 0, 0);
      return { canvas: c, sx: c.width / window.innerWidth, sy: c.height / window.innerHeight, how: "ext" };
    }
  }
  /* true frame of the tab, if the user let us */
  const had = !!(state.stream && state.stream.active);
  const stream = await ensureStream();
  if (stream && state.video?.videoWidth) {
    if (!had) await sleep(400); // let the picker close and the page settle
    await twoFrames();
    const v = state.video;
    /* the frame must be newer than the moment our overlay was hidden: twoFrames() above painted the hide,
       so accept only a video frame captured after that instant (requestVideoFrameCallback metadata), or
       two fresh callbacks when the capture time is not reported; a time cap in case the tab sits idle */
    await new Promise((done) => {
      const t0 = performance.now();
      let seen = 0;
      const cap = setTimeout(done, 600);
      const tick = (now, meta) => {
        seen++;
        const captured = meta?.captureTime ?? meta?.receiveTime ?? now;
        if (captured >= t0 || seen >= 2) {
          clearTimeout(cap);
          done();
        } else v.requestVideoFrameCallback(tick);
      };
      if (v.requestVideoFrameCallback) v.requestVideoFrameCallback(tick);
      else setTimeout(done, 250);
    });
    const c = document.createElement("canvas");
    c.width = v.videoWidth;
    c.height = v.videoHeight;
    c.getContext("2d").drawImage(v, 0, 0);
    return { canvas: c, sx: c.width / window.innerWidth, sy: c.height / window.innerHeight, how: "tab" };
  }
  /* else render the DOM with html2canvas: close, not exact (text sits low and clips a little) */
  const scale = Math.min(2, window.devicePixelRatio || 1);
  const W = window.innerWidth, H = window.innerHeight;
  const load = (src) =>
    new Promise((res, rej) => {
      const el = document.createElement("script");
      el.src = src;
      el.onload = res;
      el.onerror = rej;
      document.head.appendChild(el);
    });
  if (!window.html2canvas) await load("https://cdnjs.cloudflare.com/ajax/libs/html2canvas/1.4.1/html2canvas.min.js");
  /* html2canvas cannot read color(...) values (the library's newer tokens compute to them): hand the clone
     every colour as plain rgb, converted through a canvas */
  const COLOR_PROPS = ["color", "background-color", "border-top-color", "border-right-color", "border-bottom-color", "border-left-color", "outline-color", "text-decoration-color", "fill", "stroke", "caret-color"];
  const STRING_PROPS = ["box-shadow", "background-image", "text-shadow"];
  const cv = document.createElement("canvas").getContext("2d");
  const toRgb = (v) => {
    if (!v || !/color\(|lab\(|lch\(|oklab\(|oklch\(|color-mix\(/.test(v)) return null;
    cv.fillStyle = "#000";
    cv.fillStyle = v; // canvas resolves color-mix and friends, but keeps the color(srgb ...) form
    const out = cv.fillStyle;
    const m = /^color\(srgb\s+([\d.]+)\s+([\d.]+)\s+([\d.]+)(?:\s*\/\s*([\d.]+%?))?\)$/.exec(out);
    if (!m) return out;
    const ch = (x) => Math.round(Math.min(1, Math.max(0, parseFloat(x))) * 255);
    const a = m[4] == null ? 1 : m[4].endsWith("%") ? parseFloat(m[4]) / 100 : parseFloat(m[4]);
    return `rgba(${ch(m[1])}, ${ch(m[2])}, ${ch(m[3])}, ${a})`;
  };
  const fixString = (v) => (v && /color\(|lab\(|lch\(|oklab\(|oklch\(|color-mix\(/.test(v) ? v.replace(/(?:color|lab|lch|oklab|oklch|color-mix)\((?:[^()]|\([^()]*\))*\)/g, (m) => toRgb(m) || "rgba(0,0,0,0)") : null);
  const live = Array.from(document.querySelectorAll("*"));
  live.forEach((e, i) => e.setAttribute("data-rv-i", i));
  const onclone = (doc) => {
    for (const ce of doc.querySelectorAll("[data-rv-i]")) {
      const le = live[+ce.getAttribute("data-rv-i")];
      if (!le) continue;
      const cs = getComputedStyle(le);
      for (const p of COLOR_PROPS) {
        const r = toRgb(cs.getPropertyValue(p));
        if (r) ce.style.setProperty(p, r, "important");
      }
      for (const p of STRING_PROPS) {
        const r = fixString(cs.getPropertyValue(p));
        if (r) ce.style.setProperty(p, r, "important");
      }
      ce.removeAttribute("data-rv-i");
    }
  };
  let c;
  try {
    c = await window.html2canvas(document.documentElement, {
    onclone,
    scale,
    useCORS: true,
    logging: false,
    x: window.scrollX,
    y: window.scrollY,
    width: W,
    height: H,
    windowWidth: W,
    windowHeight: H,
    ignoreElements: (el) => el === host || el === state.video,
    });
  } finally {
    for (const e of live) e.removeAttribute("data-rv-i");
  }
  return { canvas: c, sx: scale, sy: scale, how: "dom" };
}

function drawMarker(canvas, sx, sy, rect, n, withNumber = false) {
  const g = canvas.getContext("2d");
  g.setTransform(1, 0, 0, 1, 0, 0); // html2canvas leaves its context scaled
  const x = rect.x * sx, y = rect.y * sy, w = rect.w * sx, h = rect.h * sy;
  const lw = Math.max(2, 2 * sx);
  g.lineJoin = "round";
  /* white halo, then the red */
  g.strokeStyle = "rgba(255,255,255,.95)";
  g.lineWidth = lw + 2 * sx;
  g.strokeRect(x - lw, y - lw, w + 2 * lw, h + 2 * lw);
  g.strokeStyle = "#e11d48";
  g.lineWidth = lw;
  g.strokeRect(x - lw, y - lw, w + 2 * lw, h + 2 * lw);
  if (!withNumber) return;
  /* the number badge, top-left, outside the box */
  const r = 11 * sx;
  let cx = x - lw - r * 0.3, cy = y - lw - r * 0.3;
  if (cy - r < 0) cy = y + r + lw;
  if (cx - r < 0) cx = x + r + lw;
  g.beginPath();
  g.arc(cx, cy, r + 1.5 * sx, 0, Math.PI * 2);
  g.fillStyle = "#fff";
  g.fill();
  g.beginPath();
  g.arc(cx, cy, r, 0, Math.PI * 2);
  g.fillStyle = "#e11d48";
  g.fill();
  g.fillStyle = "#fff";
  g.font = `700 ${Math.round(12 * sx)}px -apple-system, system-ui, sans-serif`;
  g.textAlign = "center";
  g.textBaseline = "middle";
  g.fillText(String(n), cx, cy + 0.5 * sx);
}

/* the scroll positions that put the target where it is: the window and every scrolling ancestor */
function scrollsOf(el) {
  const out = [{ selector: "window", top: window.scrollY, left: window.scrollX }];
  let nearest = true;
  for (let cur = el.parentElement; cur && cur !== document.body; cur = cur.parentElement) {
    const cs = getComputedStyle(cur);
    const scrolls = /(auto|scroll)/.test(cs.overflowY + cs.overflowX) && (cur.scrollHeight > cur.clientHeight + 2 || cur.scrollWidth > cur.clientWidth + 2);
    if (!scrolls) continue;
    /* the nearest pane always (a ghost pin follows it later, scrolled or not); farther ones when scrolled */
    if (nearest || cur.scrollTop || cur.scrollLeft) out.push({ selector: selectorFor(cur), top: cur.scrollTop, left: cur.scrollLeft, pane: nearest || undefined });
    nearest = false;
  }
  return out;
}
/* the app's own remembered choices (org view, theme, sidebar...) at the time of the comment */
function appSnapshot() {
  const out = {};
  try {
    for (let i = 0; i < localStorage.length; i++) {
      const k = localStorage.key(i);
      if (k && k.startsWith("merged-ui.") && !/session|toast|onboarding/.test(k)) out[k] = localStorage.getItem(k);
    }
  } catch {}
  return out;
}

/* ---------- save ---------- */
let busy = false;
async function save() {
  if (busy || !state.pending) return;
  const text = ta.value.trim();
  if (!text) {
    ta.focus();
    return;
  }
  busy = true;
  $(".save").disabled = true;
  const { el, rect } = state.pending;
  const meta = {
    route: location.pathname + location.search,
    pageTitle: pageTitle(),
    module: moduleOf(),
    docTitle: document.title,
    theme: document.documentElement.getAttribute("data-theme") || "light",
    element: describe(el),
    context: contextOf(el),
    path: cssPath(el),
    selector: selectorFor(el),
    textKey: txt(el).slice(0, 80),
    rect,
    viewport: { w: window.innerWidth, h: window.innerHeight, dpr: window.devicePixelRatio },
    severity,
    text,
    trail: state.trail.slice(-20),
    overlay: host.parentNode !== document.body || !!closestDeep(el, "dialog[open],:popover-open,[popover],[role=dialog],[role=alertdialog],[role=menu],[role=listbox],[role=tooltip],[data-radix-popper-content-wrapper]"),
    mark: state.pending.mark || null,
    scrolls: scrollsOf(el),
    app: appSnapshot(),
  };
  const png = state.pending.shot;
  const how = state.pending.how;
  /* the comment is on the page the moment Save is pressed: a pin with its number and a card with the picture
     already on screen, shimmering while the picture goes up; the hub's record replaces it when it arrives */
  const tmp = { id: `tmp-${Date.now().toString(36)}`, n: state.lastN + 1, ts: Date.now(), by: state.me, ...meta, shotHow: how, status: "open", shot: png ? "pending" : null, thumb: null, localShot: png, pending: true, resolved: false };
  state.comments.push(tmp);
  state.dropPin = { id: tmp.id, t0: performance.now() }; // its landing (renderPins)
  state.pinMoment = { id: tmp.id, t0: performance.now(), pill: addPill("add") }; // and its pill beside the number
  state.count = state.comments.length;
  state.lastN = tmp.n;
  state.pinEls.set(tmp.id, el);
  updateBar();
  closeComposer();
  busy = false;
  $(".save").disabled = false;
  renderPanel();
  sendComment(tmp, el);
}
async function sendComment(tmp, el) {
  const { id, n, localShot, pending, resolved, ...meta } = tmp;
  try {
    const thumb = localShot ? await makeThumb(localShot).catch(() => null) : null;
    const res = await rv("/__review/save", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ ...meta, shot: undefined, png: localShot, thumb, session: window.__reviewSession }) });
    const j = await res.json();
    if (!j.ok) throw new Error(j.error || "save failed");
    state.pinEls.delete(id);
    state.pinEls.set(j.entry.id, el);
    if (state.dropPin?.id === id) state.dropPin.id = j.entry.id; // the landing carries on under its real id
    if (state.pinMoment?.id === id) state.pinMoment.id = j.entry.id;
    state.mine.add(j.entry.id);
    state.comments = state.comments.filter((c) => c.id !== id);
    listSeen = "";
    listSig = ""; // ask for the whole list again
    await loadComments();
    toast(`Saved #${j.entry.n}${localShot ? "" : " (no picture)"}`);
    const card = panelBody.querySelector(`.card[data-id="${id}"]`);
    if (card) renderPanel();
  } catch (e) {
    tmp.failed = e.message;
    toast(`Could not save #${n}: ${e.message}`);
    renderPanel();
  }
}

/* ---------- pins: every comment of this session, on its element, wherever it is on screen ---------- */
/* the list, with the fingerprint of the last one seen: an unchanged list answers { same: true } (Nirav, 2026-10-25) */
let listSig = "";
const listUrl = () => `/__review/list?light=1&since=${encodeURIComponent(listSig)}${window.__reviewSession ? `&session=${window.__reviewSession}` : ""}`;
/* the approved ones, asked for only when the Approved view opens (Nirav, 2026-10-25) */
let doneSig = "";
async function loadDone() {
  try {
    const r = JSON.parse(await (await rv(`/__review/list?light=1&approved=1&since=${encodeURIComponent(doneSig)}${window.__reviewSession ? `&session=${window.__reviewSession}` : ""}`)).text());
    if (r.same) return false;
    doneSig = r.sig || "";
    if (r.faces) state.faces = { ...(state.faces || {}), ...r.faces };
    state.done = (r.list || []).map((c) => ({ ...c, severity: kindOf(c.severity) }));
    state.doneCount = state.done.length;
    return true;
  } catch {
    return false;
  }
}
let listSeen = ""; // the last list as text: a poll that brings the same thing changes nothing
state.known = null; // ids the page has had; null until the first list
state.mine = new Set(); // ids this page created: never "new"
state.unread = new Set(); // arrived from others, not yet seen in the list
let syncTimer = null;
/* the pill over the list */
function syncNote(kind, text) {
  const el = $(".panel-sync");
  clearTimeout(syncTimer);
  if (!kind) {
    el.classList.remove("on");
    return;
  }
  el.hidden = false;
  el.className = `panel-sync on ${kind}`;
  el.querySelector(".txt").textContent = text;
  if (kind === "fresh") syncTimer = setTimeout(() => el.classList.remove("on"), 1400);
}
function updateUnread() {
  const n = state.unread.size;
  if (n) syncNote("new", `${n} new`);
  else if ($(".panel-sync").classList.contains("new")) syncNote(null);
  for (const card of panelBody.querySelectorAll(".card")) card.classList.toggle("unread", state.unread.has(card.dataset.id));
  watchUnread();
}
/* a card that has been in view for a moment is seen */
const seenTimers = new Map();
const unreadWatch = new IntersectionObserver((entries) => {
  for (const e of entries) {
    const id = e.target.dataset.id;
    if (e.intersectionRatio >= 0.6 && state.unread.has(id)) {
      if (!seenTimers.has(id)) seenTimers.set(id, setTimeout(() => {
        seenTimers.delete(id);
        state.unread.delete(id);
        updateUnread();
      }, 900));
    } else if (seenTimers.has(id)) {
      clearTimeout(seenTimers.get(id));
      seenTimers.delete(id);
    }
  }
}, { threshold: [0, 0.6, 1] });
function watchUnread() {
  unreadWatch.disconnect();
  for (const card of panelBody.querySelectorAll(".card.unread")) unreadWatch.observe(card);
}
window.__reviewWhy = (id) => { /* read-only, for drives: why a pin is or is not drawn */
  const c = state.comments.find((x) => x.id === id);
  if (!c) return "no such comment";
  const here = location.pathname;
  const el = resolve(c, performance.now(), true);
  const r = el?.getBoundingClientRect();
  const out = { onRoute: (c.route || "").split("?")[0] === here, resolved: !!el, tag: el?.tagName, rect: r && [r.left, r.top, r.width, r.height].map(Math.round), ghost: !el && !!(c.rect && ghostRect(c)), context: c.context };
  if (el) {
    state.pinSeen.delete(c.id);
    out.visible = visible(c, el, r, performance.now());
    const cx = r.left + r.width / 2, cy = r.top + r.height / 2;
    const hit = targetAt(cx, cy);
    out.hit = hit && (hit.id || hit.tagName);
    out.clip = clipFor(portalOf(el));
  }
  return out;
};
window.__reviewPeek = () => ({ known: state.known?.size, unread: [...state.unread], mine: [...state.mine], comments: state.comments.map((c) => c.id), tick: lastCheck, persona: state.persona, approver: isApprover(), sign: canSign() }); // read-only, for drives
$(".panel-sync").addEventListener("click", () => {
  const first = panelBody.querySelector(".card.unread");
  if (first) first.scrollIntoView({ block: "center", behavior: "smooth" });
});
let loadComments = async function () {
  try {
    const reply = JSON.parse(await (await rv(listUrl())).text());
    const recovered = state.loadError;
    state.loaded = true; // the first answer ends the loading placeholders
    state.loadError = false;
    if (reply && reply.same) return recovered; // nothing moved: nothing sent, nothing redrawn
    const all = Array.isArray(reply) ? reply : reply.list; // an older server sends the bare list
    if (!Array.isArray(reply)) listSig = reply.sig || "";
    const text = Array.isArray(reply) ? JSON.stringify(reply) : listSig;
    const changed = text !== listSeen || recovered;
    listSeen = text;
    for (const c of all) c.severity = kindOf(c.severity);
    if (state.known) {
      for (const c of all) if (!state.known.has(c.id) && !state.mine.has(c.id) && c.status !== "approved") state.unread.add(c.id);
    }
    state.known = new Set(all.map((c) => c.id));
    for (const id of [...state.unread]) if (!state.known.has(id)) state.unread.delete(id);
    const light = !Array.isArray(reply) && typeof reply.doneCount === "number";
    if (reply.faces) state.faces = { ...(state.faces || {}), ...reply.faces }; // the people's pictures, once
    if (light) state.doneCount = reply.doneCount; // approved: counted here, the list only when its view opens
    else {
      state.done = all.filter((c) => c.status === "approved"); // an older server: everything came
      state.doneCount = state.done.length;
    }
    const l = all.filter((c) => c.status !== "approved");
    for (const c of state.comments) if (c.pending) l.push(c); // still on their way to the hub: kept until they arrive
    state.comments = l;
    state.count = l.length;
    state.lastN = Math.max(all.length ? Math.max(...all.map((c) => c.n)) : 0, l.length + (state.doneCount || 0)); // numbers run over open and approved
    for (const id of state.pinEls.keys()) if (!l.some((c) => c.id === id)) state.pinEls.delete(id);
    updateBar();
    return changed;
  } catch {
    /* server away: keep what we have; the first miss is shown (no list yet: "Can't reach the hub") */
    const first = !state.loadError;
    state.loadError = true;
    return first && !state.loaded;
  }
};
/* following the others: the list is asked for every 10 seconds while the tab is visible, and the panel is
   redrawn only when something actually changed and nobody is mid-edit in it (a note being typed, a text being
   edited, a "sure?" pending, a menu open) */
/* every 10 s while something on screen follows the list (the drawer open, or pins showing on the page); once a
   minute otherwise, for the count on the bar; not at all in a background tab or while review is hidden */
/* SMART TIMING (Nirav, 2026-10-25: near-live, for any number of comments and people): a check costs a few bytes, so
   while you are using the page with the drawer open (or pins showing) it checks every 2.5 s; stepped away, every 10 s;
   drawer shut, once a minute; a hidden tab not at all, and once at once when it comes back. For 30 s after a change
   arrives it stays quick, a conversation is likely going on. */
state.lastActive = Date.now();
let quickUntil = 0;
for (const ev of ["pointermove", "pointerdown", "keydown", "wheel", "scroll"]) window.addEventListener(ev, () => (state.lastActive = Date.now()), { passive: true, capture: true });
async function checkNow() {
  const before = state.unread.size;
  const changed = await loadComments(); // redraws only when the list changed and nobody is mid-edit
  if (changed) quickUntil = Date.now() + 30_000;
  if (PAGE_MODE && window.__reviewView === "resolved" && state.doneLoaded && (await loadDone()) && !panelBusy()) renderPanel(); // the Approved view keeps up too
  if (state.unread.size !== before) {
    if (panel.classList.contains("on")) updateUnread();
    else toast(`${state.unread.size} new comment${state.unread.size > 1 ? "s" : ""}`);
  }
}
function nextCheckIn() {
  const watching = panel.classList.contains("on") || state.showPins || PAGE_MODE;
  if (!watching) return 60_000;
  const active = Date.now() - state.lastActive < 30_000 || Date.now() < quickUntil;
  return active ? 2_500 : 10_000;
}
let checkTimer = 0, lastCheck = 0;
async function checkLoop() {
  clearTimeout(checkTimer);
  if (!document.hidden && !state.off && Date.now() - lastCheck >= nextCheckIn() - 50) {
    lastCheck = Date.now();
    await checkNow().catch(() => {});
  }
  checkTimer = setTimeout(checkLoop, document.hidden ? 5_000 : Math.min(2_500, nextCheckIn()));
}
checkTimer = setTimeout(checkLoop, 2_500);
document.addEventListener("visibilitychange", () => {
  if (!document.hidden) {
    lastCheck = 0; // back on the tab: look at once
    checkLoop();
  }
});
/* where the comments live: on the hub (shared) or on this machine; the page view shows the hub's meter */
state.hub = null;
/* a rule changed in Supabase: the open drawer redraws (unless someone is in the middle of something) */
setInterval(() => panel.classList.contains("on") && loadRules().then((changed) => changed && !panelBusy() && renderPanel()), 60_000);
/* THE WAITING LIST (Nirav, 2026-10-24): someone from outside the team who signs in waits until an approver lets them
   in. The approver sees who waits at the top of the list; the person waiting sees a quiet screen, which opens by itself
   once they are let in (asked again every minute) */
state.joiners = [];
const sessQ = () => (window.__reviewSession ? `?session=${window.__reviewSession}` : "");
async function loadJoiners() {
  if (!state.hub?.approver) return false;
  const list = await rv(`/__review/members${sessQ()}`).then((r) => r.json()).catch(() => null);
  if (!Array.isArray(list)) return false;
  const changed = JSON.stringify(list) !== JSON.stringify(state.joiners);
  state.joiners = list;
  return changed;
}
const isWaiting = () => state.hub?.role === "waiting" || state.hub?.role === "refused";
setInterval(async () => {
  if (document.hidden) return;
  if (isWaiting()) {
    const h = await rv(`/__review/hub${sessQ()}`).then((r) => r.json()).catch(() => null);
    if (h && h.role !== state.hub.role) {
      state.hub = h;
      if (!isWaiting()) toast("You are in: welcome to the review");
      loadComments().then(() => renderPanel());
    }
  } else if (panel.classList.contains("on") && (await loadJoiners()) && !panelBusy()) renderPanel();
}, 60_000);
function waitScreenHtml() {
  const refused = state.hub?.role === "refused";
  return `<div class="wait-screen"><svg width="28" height="28" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${refused ? '<circle cx="12" cy="12" r="9"/><path d="M8 8l8 8"/>' : '<circle cx="12" cy="12" r="9"/><path d="M12 7v5l3 2"/>'}</svg><b>${refused ? "You are not on this team's list" : "You are on the waiting list"}</b><span>${refused ? "An approver did not let this account in. If that is a mistake, ask them." : "An approver lets new people in. As soon as they do, the comments show up here."}</span></div>`;
}
/* many at once (Nirav, 2026-10-24): three rows, then "Show 47 more"; the title folds the whole box to one line,
   remembered until someone new asks */
state.joinAll = false;
const joinKey = () => state.joiners.map((p) => p.handle).sort().join(",");
const joinFolded = () => {
  try {
    return localStorage.getItem("review.join.folded") === joinKey();
  } catch {
    return false;
  }
};
function joinHtml() {
  const folded = joinFolded();
  const many = state.joiners.length > 3;
  const list = folded ? [] : many && !state.joinAll ? state.joiners.slice(0, 3) : state.joiners;
  const rows = list.map((p) => {
    const face = p.avatar ? `<img class="av" src="${esc(p.avatar)}" alt="" data-i="${esc(String(p.name)[0].toUpperCase())}">` : `<span class="av av-i">${esc(String(p.name)[0].toUpperCase())}</span>`;
    return `<div class="join-row" data-h="${esc(p.handle)}" data-name="${esc(p.name)}">${face}<span class="join-who"><b>${esc(p.name)}</b> <span class="join-h">@${esc(p.handle)}</span></span><button type="button" class="join-no">Refuse</button><button type="button" class="card-ok join-go">Let in</button></div>`;
  });
  const more = !folded && many ? `<button type="button" class="join-more">${state.joinAll ? "Show fewer" : `Show ${state.joiners.length - 3} more`}</button>` : "";
  return `<div class="join-box${folded ? " folded" : ""}"><button type="button" class="join-title" aria-expanded="${!folded}">Waiting to join · ${state.joiners.length}<svg class="lg-chev" width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.6" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M6 9l6 6 6-6"/></svg></button>${rows.join("")}${more}</div>`;
}
/* ?as=team / ?as=approver, read at load: the app may redirect and drop the query before the hub answers */
{
  const asQ = new URLSearchParams(location.search).get("as");
  if (asQ) try { sessionStorage.setItem("review.as", asQ); } catch {}
}
rv(`/__review/hub${window.__reviewSession ? `?session=${window.__reviewSession}` : ""}`).then((r) => r.json()).then((h) => {
  state.hub = h;
  state.me = h.who || "";
  loadRules().then((changed) => changed && renderPanel()); // the rules table, once the hub has answered
  loadJoiners().then((changed) => changed && renderPanel()); // who waits to be let in (approvers)
  /* who is looking (Nirav, 2026-10-23): the approver, or the team. ?as=team / ?as=approver tries the other view; the
     test session shows the team's by default, so both can be seen from one machine */
  let asWas = null;
  try { asWas = sessionStorage.getItem("review.as"); } catch {}
  const persona = asWas === "team" || asWas === "approver" ? asWas : window.__reviewSession ? "team" : h.approver ? "approver" : "team";
  if (state.persona !== persona) {
    state.persona = persona;
    let saved = null;
    try { saved = JSON.parse(localStorage.getItem(`review.statuses.${persona}`) || "null"); } catch {}
    state.status = new Set(Array.isArray(saved) ? saved : persona === "approver" ? ["approval", "progress"] : ["open", "progress"]);
    let g = null, f = null;
    try { g = localStorage.getItem(`review.group.${persona}`); f = JSON.parse(localStorage.getItem(`review.folded.${persona}`) || "null"); } catch {}
    state.groupBy = g || (persona === "approver" ? "status" : "none");
    state.folded = new Set(Array.isArray(f) ? f : []);
    renderGroupPick?.();
  }
  if (PAGE_MODE) renderPanel();
}).catch(() => {});
let lastResolve = 0;
function resolve(c, now, force) {
  const cached = state.pinEls.get(c.id);
  if (cached && cached.isConnected) {
    const cr = cached.getBoundingClientRect();
    if (cr.width || cr.height) return cached;
    state.pinEls.delete(c.id); // still in the page but not shown (a closed modal's content): find it afresh
  }
  if (!c.selector || (!force && now - (c._tried || 0) < 500)) return null;
  c._tried = now;
  let found = [];
  try {
    found = queryDeep(c.selector);
  } catch {
    return null;
  }
  /* the same selector can land on another element once portals reorder: ask for the same text, a similar size,
     and the same kind of place (a drawer comment resolves inside a drawer, a menu comment inside a menu) */
  const near = (a, b) => Math.abs(a - b) <= Math.max(40, 0.4 * Math.max(a, b));
  const norm = (t) => String(t || "").toLowerCase().replace(/\s+/g, " ").trim();
  const sameText = (e) => {
    if (!c.textKey) return true;
    const a = norm(txt(e).slice(0, 80)), b = norm(c.textKey);
    if (a === b) return true;
    /* a live figure in the text (a counter "25/63", a time, a count): the first words decide */
    return b.length >= 24 && a.slice(0, 24) === b.slice(0, 24) && /\d/.test(b);
  };
  const fits = (e) => {
    if (!sameText(e)) return false;
    const r = e.getBoundingClientRect();
    if (!r.width && !r.height) return false;
    /* about the same size; a wide block (a form row, a section) follows its container's width, so only its
       height counts, and a window of another size is not a different element */
    if (c.rect) {
      const wide = c.rect.w > 400;
      if (!near(r.height, c.rect.h)) return false;
      if (!wide && !near(r.width, c.rect.w)) return false;
    }
    if (/^Drawer or dialog/.test(c.context || "")) {
      /* the same dialog, not a lookalike: "Adding new policy" and "Editing policy" share one form */
      if (!closestDeep(e, "[role=dialog],[role=alertdialog],dialog[open]")) return false;
      if (!sameDialog(contextOf(e), c.context)) return false;
    }
    if (/^Popover or menu/.test(c.context || "") && !closestDeep(e, "[data-radix-popper-content-wrapper],[role=menu],[role=listbox],[role=tooltip],[role=combobox],:popover-open")) return false;
    return true;
  };
  let el = found.find(fits) || null;
  if (!el && c.textKey) {
    /* the address failed (an id that changed, a layer rebuilt): the same kind of element with the same words and
       about the same size, anywhere on the page, open shadow roots included */
    const tag = (c.selector.split(/[\s>]+/).pop() || "*").replace(/[:#.[].*$/, "") || "*";
    const walk = (root, out, depth) => {
      for (const e of root.querySelectorAll(tag)) if (e !== host && fits(e)) out.push(e);
      if (depth < 4) for (const e of root.querySelectorAll("*")) if (e.shadowRoot && e !== host) walk(e.shadowRoot, out, depth + 1);
      return out;
    };
    el = walk(document, [], 0)[0] || null;
  }
  if (el) state.pinEls.set(c.id, el);
  return el;
}
/* the body-level root an element lives in: the app's #root, or the portal a Radix layer was rendered into */
function portalOf(el) {
  let e = el;
  while (e && e.parentElement && e.parentElement !== document.body) e = e.parentElement;
  return e;
}
/* LAYERING. Every pin is drawn in our one layer above the app, so a pin on the page would float over an open
   popover, menu or drawer that covers its spot. Layers rendered later into the body (portals) sit above
   everything before them, so a pin is clipped by the surfaces of every portal after its own: it shows where the
   page shows, and a pin inside the popover is clipped by nothing. */
function surfacesOf(node, out, depth) {
  /* the fixed or absolute boxes a portal paints: the popper wrapper, a dialog's overlay and its content */
  for (const ch of node.children) {
    if (ch === host) continue;
    const r = ch.getBoundingClientRect();
    if (!r.width || !r.height) {
      if (depth < 4) surfacesOf(ch, out, depth + 1);
      continue;
    }
    const pos = getComputedStyle(ch).position;
    if (pos === "fixed" || pos === "absolute") out.push(r);
    else if (depth < 4) surfacesOf(ch, out, depth + 1);
  }
}
let layersAt = 0, layersCache = [];
function layersAbove(portal) {
  const now = performance.now();
  if (now - layersAt > 120) {
    layersAt = now;
    layersCache = [];
    for (const ch of document.body.children) {
      if (ch === host || ch.tagName === "SCRIPT" || ch.tagName === "STYLE") continue;
      const out = [];
      const r = ch.getBoundingClientRect();
      const pos = r.width && r.height ? getComputedStyle(ch).position : "";
      if (pos === "fixed" || pos === "absolute") out.push(r); // the layer is the body child itself (a popper wrapper)
      else surfacesOf(ch, out, 0);
      layersCache.push({ el: ch, rects: out });
    }
  }
  const i = layersCache.findIndex((l) => l.el === portal);
  return layersCache.slice(i + 1).flatMap((l) => l.rects);
}
/* rects as a set that does not overlap (a grid over their edges), so an evenodd polygon can cut them all out */
function disjoint(rects) {
  const xs = [...new Set(rects.flatMap((r) => [r.left, r.right]))].sort((a, b) => a - b);
  const ys = [...new Set(rects.flatMap((r) => [r.top, r.bottom]))].sort((a, b) => a - b);
  const out = [];
  for (let i = 0; i < xs.length - 1; i++)
    for (let j = 0; j < ys.length - 1; j++) {
      const cx = (xs[i] + xs[i + 1]) / 2, cy = (ys[j] + ys[j + 1]) / 2;
      if (rects.some((r) => cx > r.left && cx < r.right && cy > r.top && cy < r.bottom)) out.push({ left: xs[i], right: xs[i + 1], top: ys[j], bottom: ys[j + 1] });
    }
  return out;
}
function clipFor(portal) {
  const holes = layersAbove(portal);
  if (!holes.length) return "";
  const W = window.innerWidth, H = window.innerHeight;
  const cells = disjoint(holes.map((r) => ({ left: Math.max(0, r.left), right: Math.min(W, r.right), top: Math.max(0, r.top), bottom: Math.min(H, r.bottom) })).filter((r) => r.right > r.left && r.bottom > r.top));
  if (!cells.length) return "";
  const pt = (x, y) => `${x}px ${y}px`;
  const ring = cells.map((r) => `${pt(r.left, r.top)},${pt(r.right, r.top)},${pt(r.right, r.bottom)},${pt(r.left, r.bottom)},${pt(r.left, r.top)}`);
  return `polygon(evenodd, 0 0, ${W}px 0, ${W}px ${H}px, 0 ${H}px, 0 0, ${ring.join(",")})`;
}
function visible(c, el, r, now) {
  const seen = state.pinSeen.get(c.id);
  if (seen && now - seen.at < 250) return seen.ok;
  const cx = Math.min(window.innerWidth - 1, Math.max(0, r.left + r.width / 2));
  const cy = Math.min(window.innerHeight - 1, Math.max(0, r.top + r.height / 2));
  const hit = targetAt(cx, cy);
  const ok = !!hit && (el === hit || el.contains(hit) || hit.contains(el));
  state.pinSeen.set(c.id, { at: now, ok });
  return ok;
}
const tip = $(".pin-tip");
/* where a comment's element was, in today's viewport: its box at capture, moved by how far the page has scrolled
   since (the window only; an inner scroller is not followed) */
/* the page's main scrolling pane, for comments made before panes were recorded: the tallest scroller that fills
   most of the window (the window itself when it is the one that scrolls); looked up twice a second */
let mainPane = { at: 0, el: null };
function mainScroller() {
  if (performance.now() - mainPane.at < 500) return mainPane.el;
  let best = null;
  const se = document.scrollingElement;
  if (se && se.scrollHeight > se.clientHeight + 2) best = null; // the window scrolls: nothing inner to follow
  else {
    for (const el of document.querySelectorAll("main, [class*=scroll], [style*=overflow], div")) {
      if (el.clientHeight < window.innerHeight * 0.5 || el.scrollHeight <= el.clientHeight + 2) continue;
      const cs = getComputedStyle(el);
      if (!/(auto|scroll)/.test(cs.overflowY)) continue;
      if (!best || el.scrollHeight > best.scrollHeight) best = el;
    }
  }
  mainPane = { at: performance.now(), el: best };
  return best;
}
function ghostRect(c) {
  /* only for things of the page itself: inside a drawer, dialog, menu or hover card the element is simply not
     open right now, and a ghost would float over nothing */
  if (c.overlay || /drawer|dialog|menu|popover|hover|tooltip|dropdown/i.test(c.context || "")) return null;
  if (/dialog|modal|drawer|popover|menu|dropdown|tooltip|sheet/i.test(c.path || "")) return null; // older comments: the path names the layer
  if (!(c.rect.w > 8 && c.rect.h > 8) || (c.rect.x === 0 && c.rect.y === 0)) return null;
  const win = (c.scrolls || []).find((s) => s.selector === "window") || { top: 0, left: 0 };
  let dx = (win.left || 0) - window.scrollX;
  let dy = (win.top || 0) - window.scrollY;
  let clip = null;
  const inner = (c.scrolls || []).filter((s) => s.selector !== "window");
  let followed = false;
  for (const sc of inner) {
    let el = null;
    try {
      el = queryDeep(sc.selector)[0] || null;
    } catch {}
    if (!el) continue;
    dx += (sc.left || 0) - el.scrollLeft;
    dy += (sc.top || 0) - el.scrollTop;
    if (sc.pane || !clip) clip = el.getBoundingClientRect();
    followed = true;
  }
  if (!followed) {
    /* no pane on record (an older comment): the page's main pane, taken as sitting at the top when the picture was made */
    const el = mainScroller();
    if (el) {
      dx -= el.scrollLeft;
      dy -= el.scrollTop;
      clip = el.getBoundingClientRect();
    }
  }
  const left = c.rect.x + dx;
  const top = c.rect.y + dy;
  if (top + c.rect.h < -200 || top > window.innerHeight + 200) return null; // far off screen: nothing to show
  if (clip && (top + c.rect.h < clip.top || top > clip.bottom)) return null; // scrolled out of its pane
  return { left, top, width: c.rect.w, height: c.rect.h, right: left + c.rect.w, bottom: top + c.rect.h, clip };
}
function renderPins() {
  pinsEl.innerHTML = "";
  const now = performance.now();
  const here = location.pathname;
  let over = null;
  /* pins hidden: only the one a go-to just landed on is drawn, until the next click on the app clears it */
  const only = state.showPins ? null : state.flash?.id;
  if (!state.showPins && !only) {
    tip.classList.remove("on");
    return;
  }
  const rects = new Map(); // comment id -> its pin's anchor this frame, for the tip that stays open
  for (const c of state.comments) {
    if (only && c.id !== only) continue;
    if ((c.route || "").split("?")[0] !== here) continue;
    const el = resolve(c, now);
    /* the element is gone or changed (a chart redrawn, a figure that moved on): the pin where it was taken,
       dimmed and dashed, so the place is still shown and the comment still reachable */
    const ghost = !el && c.rect && ghostRect(c);
    if (!el && !ghost) continue;
    const r = el ? el.getBoundingClientRect() : ghost;
    if (!r.width && !r.height) continue;
    if (el && !visible(c, el, r, now)) continue;
    rects.set(c.id, { c, r });
    const wrap = document.createElement("div");
    wrap.className = "pin-wrap" + (ghost ? " ghost" : "");
    if (el) wrap.style.clipPath = clipFor(portalOf(el));
    else if (ghost.clip) wrap.style.clipPath = `inset(${Math.max(0, ghost.clip.top)}px ${Math.max(0, window.innerWidth - ghost.clip.right)}px ${Math.max(0, window.innerHeight - ghost.clip.bottom)}px ${Math.max(0, ghost.clip.left)}px)`;
    pinsEl.appendChild(wrap);
    const box = document.createElement("div");
    box.className = "pin-box";
    box.style.left = `${r.left - 2}px`;
    box.style.top = `${r.top - 2}px`;
    box.style.width = `${r.width + 4}px`;
    box.style.height = `${r.height + 4}px`;
    wrap.appendChild(box);
    const d = document.createElement("div");
    const hot = state.flash && state.flash.id === c.id && now < state.flash.until;
    d.className = "pin ui" + (hot ? " flash" : " faded") + (state.unread.has(c.id) ? " unread" : "");
    if (hot) box.classList.add("flash");
    d.style.left = `${r.left}px`;
    d.style.top = `${r.top}px`;
    d.textContent = c.n;
    d.dataset.id = c.id;
    wrap.appendChild(d);
    /* A NEW PIN LANDS (Nirav, 2026-10-25): it drops onto its place with a small bounce (the ring that spread from it
       and the box's flash were taken out the same day). Pins are redrawn every frame, so the moment is worked out from the time, not a CSS animation */
    if (state.dropPin?.id === c.id && !calm()) {
      const k = (now - state.dropPin.t0) / 750;
      if (k < 1) {
        const fall = Math.min(1, k / 0.45);
        const bounce = k < 0.45 ? 0 : Math.sin(((k - 0.45) / 0.55) * Math.PI) * Math.exp(-((k - 0.45) / 0.55) * 3);
        d.style.translate = `0 ${-(1 - fall) * (1 - fall) * 22 - bounce * 6}px`;
        d.style.scale = String(k < 0.45 ? 0.6 + 0.4 * fall : 1 + bounce * 0.12);
        d.style.opacity = String(Math.min(1, k / 0.2));
      }
      else state.dropPin = null;
    }
    /* A PIN'S MOMENT (Nirav, 2026-10-25): added, picked up or done, the pill shows beside the number and follows the
       pin, the pin card stays shut ("just the pill beside the pin number") */
    if (state.pinMoment?.id === c.id) {
      const pill = state.pinMoment.pill;
      if (pill) {
        /* right of the number when it fits, else to its left; never past the window's edge (Nirav, 2026-10-25) */
        const w = pill.offsetWidth || 160;
        const right = r.left + 30;
        const x = right + w <= window.innerWidth - 8 ? right : Math.max(8, r.left - w - 8);
        pill.style.left = `${x}px`;
        pill.style.top = `${Math.max(8, r.top - 2)}px`;
        pill.style.transformOrigin = x < r.left ? "100% 50%" : "0 50%";
        pill.style.visibility = "visible";
      }
      if (now - state.pinMoment.t0 > 2600) state.pinMoment = null;
    }
    /* the tip follows the mouse, not events: pins are redrawn every frame, so a "mouse left" would never fire */
    const { x, y } = state.mouse;
    if (x >= r.left - 9 && x <= r.left + 15 && y >= r.top - 9 && y <= r.top + 15) over = { c, r };
    /* just arrived by go-to: the comment reads itself out for the flash's time, no hover needed */
    if (hot && !over) over = { c, r };
    if (state.pinMoment?.id === c.id && over?.c.id === c.id) over = null; // no pin card while its pill shows
  }
  /* the tip already up stays while something is pending on it (an edit, a "sure?") or the pointer is on it */
  if (!over && tip.classList.contains("on") && rects.has(tip.dataset.id)) {
    const t = tip.getBoundingClientRect();
    const { x, y } = state.mouse;
    if (tipHold === tip.dataset.id || (x >= t.left - 8 && x <= t.right + 8 && y >= t.top - 10 && y <= t.bottom + 8)) over = rects.get(tip.dataset.id);
  }
  if (over && !state.pending && !$(".panel").classList.contains("on")) {
    if (tip.dataset.id !== over.c.id) buildTip(over.c);
    if (tipHold === over.c.id) tip.classList.add("held");
    tip.style.left = `${Math.min(over.r.left, window.innerWidth - 310)}px`;
    /* below the pin when it fits, else above it, so a pin near the bottom never opens a card cut off by the window
       (Nirav, 2026-10-25) */
    const th = tip.offsetHeight || 140;
    tip.style.top = `${over.r.top + 18 + th <= window.innerHeight - 8 ? over.r.top + 18 : Math.max(8, over.r.top - th - 6)}px`;
    tip.classList.add("on");
  } else {
    tip.classList.remove("on", "held");
    delete tip.dataset.id;
    tipHold = null;
  }
}
let tipHold = null; // the comment id whose tip must stay up whatever the pointer does
function buildTip(c) {
  tip.dataset.id = c.id;
  const sev = SEVERITIES.map(([k, label]) => `<button type="button" data-k="${k}" class="${k === c.severity ? "on" : ""}" aria-label="${label}"><span class="dot"></span><span class="lbl">${label}</span><span class="scope-tip">${label}</span></button>`).join("");
  tip.innerHTML = `<div class="tip-head"><span class="tip-sev">${sev}</span><button class="tip-open" title="Show it in the list" aria-label="Show it in the list"><svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M4 6h16M4 12h10M4 18h7"/><path d="M15 15l3 3 3-3M18 11v7"/></svg></button></div><div class="tip-text" aria-label="Comment, click to edit"></div>${hasNote(c) ? '<div class="tip-note"></div>' : ""}<div class="tip-acts"><div class="tip-acts-in">${canRemove(c) ? '<button class="tip-rm">Remove</button>' : ""}${(() => { if (isQ(c)) return ""; /* a question is answered in the list */ const to = c.status === "progress" ? "approval" : c.status === "approval" ? "approved" : "progress"; return can(moveOf(c, to), c) ? `<button class="tip-ok" data-to="${to}">${c.status === "progress" ? "Done" : c.status === "approval" ? "Approve" : "Pick up"}</button>` : ""; })()}</div></div>`;
  tip.querySelector(".tip-text").textContent = c.text;
  if (hasNote(c)) tip.querySelector(".tip-note").innerHTML = noteHtml(c);
}
tip.addEventListener("click", async (e) => {
  const c = state.comments.find((x) => x.id === tip.dataset.id);
  if (!c) return;
  const t = e.target.closest("button, .tip-text");
  if (!t) return;
  if (c.pending && !t.classList.contains("tip-open")) return; // still on its way to the hub: nothing to act on yet
  tip.classList.add("held"); // keep the hover state through the reload the action causes
  setTimeout(() => tip.classList.remove("held"), 800);
  if (t.classList.contains("tip-open")) return showInList(c);
  if (t.closest(".tip-sev")) {
    const k = t.dataset.k;
    if (k === c.severity) return;
    /* the pill changes at once, the save follows */
    for (const b of tip.querySelectorAll(".tip-sev button")) b.classList.toggle("on", b.dataset.k === k);
    c.severity = k;
    await applyUpdate({ id: c.id, severity: k });
    return;
  }
  if (t.classList.contains("tip-ok")) {
    const to = t.dataset.to;
    const was = c.status;
    const ok = await applyUpdate({ id: c.id, status: to }, t);
    if (ok && to === "approved") await tipGoodbye("ok").catch(() => {}); // its lock, as in the list
    /* picked up or done from the pin card: the same happy moment, on the pin card (Nirav, 2026-10-25) */
    const moment = ok && !isQ(ok) ? (was === "open" && ok.status === "progress" ? "pick" : was === "progress" && ok.status === "approval" ? "done" : null) : null;
    if (moment) {
      /* the pin card closes and the pill shows beside the pin's number, as for a new pin (Nirav, 2026-10-25) */
      tip.classList.remove("on");
      delete tip.dataset.id;
      tipHold = null;
      state.pinMoment = { id: c.id, t0: performance.now(), pill: addPill(moment) };
      toast(`#${c.n} ${statusToast[to]}`);
      return;
    }
    const fresh = state.comments.find((x) => x.id === c.id);
    if (fresh) buildTip(fresh);
    else {
      tip.classList.remove("on");
      delete tip.dataset.id;
      tipHold = null;
    }
    toast(`#${c.n} ${statusToast[to]}`);
    return;
  }
  if (t.classList.contains("tip-rm")) {
    if (!t.classList.contains("sure")) {
      t.classList.add("sure");
      t.textContent = "Remove, sure?";
      tipHold = c.id;
      setTimeout(() => {
        t.classList.remove("sure");
        t.textContent = "Remove";
        if (tipHold === c.id && t.isConnected) tipHold = null;
      }, 2500);
      return;
    }
    const done = await api("delete", { id: c.id }).catch((e) => ({ error: String(e?.message || e) }));
    if (!done?.ok) return toast(done?.error || "Could not remove it", true);
    {
      /* its dust, on the pin card and on its card in the list when that is open */
      const inList = panelBody.querySelector(`.card[data-id="${c.id}"]`);
      await Promise.all([tipGoodbye("rm").catch(() => {}), inList ? removeFx(inList).catch(() => {}) : null]);
    }
    await loadComments();
    tip.classList.remove("on");
    delete tip.dataset.id;
    tipHold = null;
    renderPanel();
    toast(`Removed #${c.n}`);
    return;
  }
  if (t.classList.contains("tip-text") && t.contentEditable !== "true" && canEdit(c)) {
    tipHold = c.id;
    editInPlace(t, c, () => {
      tipHold = null;
      const fresh = state.comments.find((x) => x.id === c.id);
      if (fresh) buildTip(fresh); // the saved text, the tip still up under the pointer
      renderPanel();
    });
  }
});
/* a click on a pin opens the list on that comment. Pins are redrawn every frame, so the pressed element may be
   gone by the release and no click would fire: the press is noted, the release on the same pin acts. */
let pinDown = null;
pinsEl.addEventListener("pointerdown", (e) => {
  pinDown = e.target.closest(".pin")?.dataset.id || null;
});
pinsEl.addEventListener("pointerup", (e) => {
  const up = e.target.closest(".pin")?.dataset.id;
  const c = pinDown && up === pinDown && state.comments.find((x) => x.id === pinDown);
  pinDown = null;
  if (c) showInList(c);
});
/* the list, opened and scrolled to one comment; a scope or tag that would hide it is widened first */
async function showInList(c) {
  if (state.filter.size && !state.filter.has(c.severity)) state.filter.clear();
  const sc = state.scope;
  const group = (c.module && c.module.group) || moduleOf(c.route).group || "Other";
  if ((sc.kind === "route" && sc.route !== (c.route || "").split("?")[0]) || (sc.kind === "group" && sc.group !== group)) state.scope = { kind: "all" }; // "here" follows the page and needs no widening
  state.spot = { id: c.id, until: performance.now() + 2400 };
  if (state.status?.size && !state.status.has(c.status)) state.status = new Set(); // the card must be in the filter
  tip.classList.remove("on");
  delete tip.dataset.id;
  tipHold = null;
  openPanel(true);
}
/* edit a comment's text where it stands: Enter or a click elsewhere keeps it, Escape puts the old text back */
function editInPlace(el, c, after) {
  el.contentEditable = "true";
  el.focus();
  /* a caret at the end: inside a shadow root, focus() alone leaves the editable without one */
  try {
    const range = document.createRange();
    range.selectNodeContents(el);
    range.collapse(false);
    const sel = window.getSelection();
    sel.removeAllRanges();
    sel.addRange(range);
  } catch {}
  let finished = false;
  const done = async (keep) => {
    if (finished) return;
    finished = true;
    window.removeEventListener("pointerdown", outside, true);
    el.contentEditable = "false";
    const text = el.textContent.trim();
    if (keep && text && text !== c.text) {
      await applyUpdate({ id: c.id, text });
      toast(`#${c.n} updated`);
    } else el.textContent = c.text; // dropped or unchanged: the saved words back
    after();
  };
  /* a click anywhere else ends the edit (the focus guard above keeps blur from reaching us) */
  const outside = (ev) => {
    if (!ev.composedPath().includes(el)) done(true);
  };
  window.addEventListener("pointerdown", outside, true);
  el.addEventListener("blur", () => done(true), { once: true });
  el.addEventListener("keydown", (ev) => {
    if (ev.key === "Enter" && !ev.shiftKey) {
      ev.preventDefault();
      done(true);
    }
    if (ev.key === "Escape") {
      ev.stopPropagation();
      el.textContent = c.text;
      done(false);
    }
  });
}
/* keep the pins on their elements through any layout change, not only scroll and resize */
(function track() {
  if (!state.capturing && !state.off) renderPins();
  requestAnimationFrame(track);
})();
function setPins(on) {
  if (on && !state.showPins) loadComments().then(() => { if (state.unread.size && !panel.classList.contains("on")) toast(`${state.unread.size} new comment${state.unread.size > 1 ? "s" : ""}`); }); // fresh the moment they come back
  state.showPins = on;
  $(".pins-toggle").classList.toggle("on", on);
  tip.classList.remove("on");
  try {
    localStorage.setItem("review.pins", on ? "on" : "off");
  } catch {}
}
$(".pins-toggle").addEventListener("click", () => setPins(!state.showPins));
setPins(state.showPins);

function setSticky(on) {
  state.sticky = on;
  $(".bar .k").textContent = on ? "every click comments · Esc stops" : `${MOD} + click to comment`;
  if (!on) showHover(null);
  else showHover(targetAt(state.mouse.x, state.mouse.y));
}
/* the whole review layer on or off: off hides the bar, the pins, the panel and the composer, and ⌥-click goes back to
   the app. Remembered across reloads; the shortcut is the way back since nothing is left on screen. */
function setReview(on, quiet) {
  state.off = !on;
  host.toggleAttribute("data-off", !on);
  if (!on) {
    if (state.pending) closeComposer();
    if (panel.classList.contains("on")) openPanel(false);
    if (lightbox.classList.contains("on")) closeLightbox();
    if (state.sticky) setSticky(false);
    showHover(null);
    tip.classList.remove("on");
  }
  try {
    localStorage.setItem("review.on", on ? "on" : "off");
  } catch {}
  if (!quiet) toast(on ? "Review is on" : `Review is off · ${HIDE_KEY} turns it on`, on ? 2200 : 4000);
}
$(".bar .off").addEventListener("click", () => setReview(false));

$(".bar .dot").addEventListener("click", async () => {
  if (extHere() || state.stream?.active) return toast("Pictures are on");
  toast("The review extension is not in this page. Loaded in chrome://extensions? Then reload this tab. Asking to share instead…", true);
  await sleep(1800);
  state.declined = false;
  const ok = await ensureStream();
  toast(ok ? "Pictures on: every save grabs a true frame" : "Not shared: pictures fall back to a rough render");
});
const markExt = () => {
  if (!extHere()) return;
  dot.classList.add("live");
  dot.title = "Pictures: on (review extension)";
};
window.addEventListener("message", (e) => {
  if (e.source === window && e.data?.type === "review-ext-ready") markExt();
});
markExt();
let updateBar = function () {
  countEl.textContent = state.count ? String(state.count) : "";
};
let toastTimer;
function toast(msg, hold) {
  /* hold: true keeps the toast up (busy, until the next toast); a number keeps it that many ms */
  toastEl.textContent = msg;
  toastEl.classList.toggle("busy", hold === true);
  toastEl.classList.add("on");
  clearTimeout(toastTimer);
  if (hold !== true) toastTimer = setTimeout(() => toastEl.classList.remove("on"), typeof hold === "number" ? hold : 2200);
}

loadComments();
$(".bar .k").textContent = `${MOD} + click to comment`;

/* where the number sits on a picture, as fractions of the picture: drawMarker's badge geometry. New comments carry
   the box in picture pixels (mark); older ones are placed from the picture's own size, the way they were baked. */
function badgeSpot(c, natW, natH) {
  let x, y, s, cw, ch;
  if (c.mark) ({ x, y, s, cw, ch } = c.mark);
  else {
    const v = c.viewport || { w: 1920, h: 1080 };
    const r = c.rect || { x: 0, y: 0 };
    s = natW / v.w;
    cw = natW;
    ch = natH;
    x = r.x * s;
    y = r.y * s;
  }
  const lw = Math.max(2, 2 * s), rad = 11 * s;
  let cx = x - lw - rad * 0.3, cy = y - lw - rad * 0.3;
  if (cy - rad < 0) cy = y + rad + lw;
  if (cx - rad < 0) cx = x + rad + lw;
  return { left: (cx / cw) * 100, top: (cy / ch) * 100, size: ((2 * rad) / cw) * 100 };
}
function liveBadge(c, img) {
  const el = document.createElement("span");
  el.className = "pic-n";
  el.textContent = c.n;
  const place = () => {
    if (!c.mark && !(img && img.naturalWidth)) return;
    const b = badgeSpot(c, img?.naturalWidth || 0, img?.naturalHeight || 0);
    el.style.left = `${b.left}%`;
    el.style.top = `${b.top}%`;
    el.style.width = `${b.size}cqw`;
    el.style.height = `${b.size}cqw`;
    el.style.fontSize = `${b.size * 0.55}cqw`;
    el.style.visibility = "visible";
  };
  el.style.visibility = "hidden";
  if (img && !img.complete) img.addEventListener("load", place, { once: true });
  place();
  return el;
}

/* ---------- the panel: every comment so far, editable, removable ---------- */
const panel = $(".panel");
const panelBody = $(".panel-body");
/* the list's own toolbar (Nirav, 2026-10-23): a search and the Fix / Question pill at the top of the list, not in the
   head. It scrolls with the cards, slides away as the list scrolls down and comes back the moment it scrolls up. One
   element for the life of the drawer, so a redraw never takes the focus or the half-typed words from the search. */
const tools = document.createElement("div");
tools.className = "panel-tools";
tools.innerHTML = `<label class="pt-search glass"><svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><circle cx="11" cy="11" r="7"/><path d="M20 20l-3.5-3.5"/></svg><input type="search" placeholder="Search" aria-label="Search comments"><button type="button" class="pt-clear" aria-label="Clear the search"><svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round"><path d="M18 6L6 18M6 6l12 12"/></svg></button></label><span class="type-pick glass" role="group" aria-label="Type"></span><span class="scope-tip pt-tip">Search <kbd>/</kbd></span>`;
const toolsIn = tools.querySelector("input");
let toolsT = 0;
toolsIn.addEventListener("input", () => {
  clearTimeout(toolsT);
  toolsT = setTimeout(() => {
    state.q = toolsIn.value.trim();
    tools.classList.toggle("has-q", !!state.q);
    renderPanel();
  }, 140);
});
/* Esc: the first clears what is typed, the next one closes the search back to its circle (the drawer stays) */
toolsIn.addEventListener("keydown", (e) => {
  if (e.key !== "Escape") return;
  e.stopPropagation();
  e.preventDefault();
  if (toolsIn.value) {
    toolsIn.value = "";
    state.q = "";
    tools.classList.remove("has-q");
    renderPanel();
  } else toolsIn.blur();
});
tools.querySelector(".pt-clear").addEventListener("click", () => {
  toolsIn.value = "";
  state.q = "";
  tools.classList.remove("has-q");
  toolsIn.focus();
  renderPanel();
});
/* the group choice is drawn with the head (renderPanel); kept as a name for the persona code */
function renderGroupPick() {}
/* clears the list but keeps the toolbar where it is */
/* the empty views: a simple line drawing with one touch of colour, a title, a kind line (Nirav, 2026-10-25: "simple line
   illustrations instead of the faces") */
const ART = (() => {
  /* production-grade empty-state art (Nirav, 2026-10-25: "make it production grade"): a soft tinted circle behind, a
     faint shadow under, objects in the surface colour with a crisp outline, one accent as a light fill and a few
     small details. 128 x 96, drawn at 120 x 90. */
  const bg = (a) => `<circle cx="64" cy="46" r="40" fill="${a}" opacity=".09"/><ellipse cx="64" cy="86" rx="34" ry="3.2" fill="#1d2b3e" opacity=".07"/>`;
  const S = `fill="var(--art-fill)" stroke="var(--art-line)" stroke-width="1.6" stroke-linejoin="round"`;
  const L = `fill="none" stroke="var(--art-line)" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"`;
  const soft = `fill="var(--art-soft)"`;
  const spark = (x, y, r, a) => `<path d="M${x} ${y - r} Q${x} ${y} ${x + r} ${y} Q${x} ${y} ${x} ${y + r} Q${x} ${y} ${x - r} ${y} Q${x} ${y} ${x} ${y - r} Z" fill="${a}"/>`;
  return {
    /* a page with a comment bubble and a cursor clicking */
    none: (a) => `${bg(a)}<rect x="30" y="20" width="58" height="56" rx="7" ${S}/><path d="M30 31 H88" ${L}/><circle cx="37" cy="25.5" r="1.6" ${soft}/><circle cx="42.5" cy="25.5" r="1.6" ${soft}/><circle cx="48" cy="25.5" r="1.6" ${soft}/><rect x="38" y="39" width="30" height="4" rx="2" ${soft}/><rect x="38" y="48" width="40" height="4" rx="2" ${soft}/><rect x="38" y="57" width="22" height="4" rx="2" ${soft}/><path d="M84 8 H106 A6 6 0 0 1 112 14 V26 A6 6 0 0 1 106 32 H96 L89 38 V32 H84 A6 6 0 0 1 78 26 V14 A6 6 0 0 1 84 8 Z" fill="var(--art-fill)"/><path d="M84 8 H106 A6 6 0 0 1 112 14 V26 A6 6 0 0 1 106 32 H96 L89 38 V32 H84 A6 6 0 0 1 78 26 V14 A6 6 0 0 1 84 8 Z" fill="${a}" fill-opacity=".16" stroke="${a}" stroke-width="1.6" stroke-linejoin="round"/><circle cx="88" cy="20" r="1.8" fill="${a}"/><circle cx="95" cy="20" r="1.8" fill="${a}"/><circle cx="102" cy="20" r="1.8" fill="${a}"/><path d="M72 58 L72 80 L77.5 74.5 L82 84 L86 82 L81.5 72.8 L89 72.5 Z" fill="var(--art-ink)" stroke="var(--art-fill)" stroke-width="1.6" stroke-linejoin="round"/>`,
    /* a checklist, every row ticked, sparkles */
    allDone: (a) => `${bg(a)}<rect x="40" y="18" width="52" height="62" rx="7" ${S} transform="rotate(6 66 49)" opacity=".55"/><rect x="34" y="16" width="54" height="64" rx="7" ${S}/>${[30, 46, 62].map((y) => `<circle cx="46" cy="${y}" r="5.5" fill="${a}"/><path d="M43.4 ${y} L45.4 ${y + 2} L48.8 ${y - 1.8}" fill="none" stroke="#fff" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"/><rect x="56" y="${y - 2}" width="${y === 46 ? 18 : 24}" height="4" rx="2" ${soft}/>`).join("")}${spark(100, 22, 5, a)}${spark(24, 58, 3.5, a)}${spark(104, 64, 3, "#ffc83d")}`,
    /* an open archive box, empty */
    resolved: (a) => `${bg(a)}<path d="M28 40 H100 L94 78 A5 5 0 0 1 89 82 H39 A5 5 0 0 1 34 78 Z" ${S}/><path d="M24 30 H104 A3 3 0 0 1 107 33 V40 H21 V33 A3 3 0 0 1 24 30 Z" ${S}/><rect x="52" y="50" width="24" height="9" rx="4.5" fill="${a}" fill-opacity=".16" stroke="${a}" stroke-width="1.4"/><path d="M58 54.5 L62 57 L70 52" fill="none" stroke="${a}" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"/><path d="M40 22 L46 28 M64 16 V26 M88 22 L82 28" ${L} opacity=".6"/>`,
    /* an empty inbox tray, all caught up */
    open: (a) => `${bg(a)}<path d="M26 52 L36 24 A5 5 0 0 1 41 20 H87 A5 5 0 0 1 92 24 L102 52 V74 A6 6 0 0 1 96 80 H32 A6 6 0 0 1 26 74 Z" ${S}/><path d="M26 52 H48 L53 60 H75 L80 52 H102" ${L}/><path d="M26 52 H48 L53 60 H75 L80 52 H102 V74 A6 6 0 0 1 96 80 H32 A6 6 0 0 1 26 74 Z" fill="${a}" fill-opacity=".1"/><path d="M57 36 L62 41 L71 31" fill="none" stroke="${a}" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"/>`,
    /* a coffee mug on a saucer, steam rising: a quiet moment */
    progress: (a) => `${bg(a)}<ellipse cx="62" cy="78" rx="30" ry="5" ${S}/><path d="M38 40 H82 V64 A14 14 0 0 1 68 78 H52 A14 14 0 0 1 38 64 Z" ${S}/><path d="M82 46 H88 A8 8 0 0 1 88 62 H81" ${L}/><path d="M38 40 H82 V46 H38 Z" fill="${a}" fill-opacity=".16"/><path d="M55.5 58 L60 62.5 L64.5 58 A2.8 2.8 0 1 0 60 54.6 A2.8 2.8 0 1 0 55.5 58 Z" fill="${a}"/><path d="M50 30 Q46 25 50 20 Q54 15 50 10 M60 30 Q56 25 60 20 Q64 15 60 10 M70 30 Q66 25 70 20 Q74 15 70 10" fill="none" stroke="${a}" stroke-width="1.8" stroke-linecap="round" opacity=".8"/>`,
    /* a stamp resting beside its mark: nothing to approve */
    stampRest: (a) => `${bg(a)}<rect x="22" y="58" width="38" height="20" rx="4" fill="${a}" fill-opacity=".12" stroke="${a}" stroke-width="1.6" stroke-dasharray="3 3"/><path d="M33 68 L38 72.5 L49 63" fill="none" stroke="${a}" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/><path d="M78 20 A9 9 0 0 1 96 20 V34 H78 Z" ${S}/><path d="M80 34 H94 V44 H80 Z" ${S}/><path d="M68 44 H106 A4 4 0 0 1 110 48 V58 H64 V48 A4 4 0 0 1 68 44 Z" ${S}/><rect x="64" y="58" width="46" height="7" rx="2" fill="${a}" fill-opacity=".5" stroke="var(--art-line)" stroke-width="1.6"/>`,
    /* a paper plane on its way, a dashed loop behind */
    plane: (a) => `${bg(a)}<path d="M18 70 Q34 54 26 44 Q20 36 32 34" fill="none" stroke="${a}" stroke-width="1.8" stroke-linecap="round" stroke-dasharray="3.5 4.5"/><path d="M36 46 L104 18 L84 72 L68 56 Z" ${S}/><path d="M104 18 L68 56 L66 74 L76 62" ${S}/><path d="M104 18 L68 56 L84 72 Z" fill="${a}" fill-opacity=".16"/><path d="M104 18 L68 56" ${L}/><circle cx="100" cy="66" r="2" fill="${a}" opacity=".6"/><circle cx="108" cy="54" r="1.4" fill="${a}" opacity=".5"/>`,
    /* a funnel with the three status shapes above it */
    statuses: (a) => `${bg(a)}<path d="M28 30 H100 A3 3 0 0 1 102 35 L74 60 V76 A3 3 0 0 1 70 79 L60 75 A3 3 0 0 1 58 72 V60 L26 35 A3 3 0 0 1 28 30 Z" ${S}/><path d="M34 38 H94" ${L} opacity=".5"/><circle cx="48" cy="16" r="5" fill="#A64DFF"/><rect x="60" y="11" width="9" height="9" rx="1.6" fill="#FF6F00" transform="rotate(45 64.5 15.5)"/><rect x="77" y="11" width="9.5" height="9.5" rx="2" fill="#31BFB0"/>`,
    /* a magnifying glass over a card, nothing found */
    search: (a) => `${bg(a)}<rect x="22" y="22" width="58" height="50" rx="7" ${S}/><rect x="31" y="33" width="30" height="4" rx="2" ${soft}/><rect x="31" y="42" width="38" height="4" rx="2" ${soft}/><rect x="31" y="51" width="22" height="4" rx="2" ${soft}/><circle cx="78" cy="52" r="17" fill="var(--art-fill)" stroke="var(--art-line)" stroke-width="2.2"/><circle cx="78" cy="52" r="17" fill="${a}" fill-opacity=".12"/><path d="M90.5 64.5 L104 78" stroke="var(--art-line)" stroke-width="5" stroke-linecap="round"/><path d="M72.5 47.5 A5.5 5.5 0 1 1 80.5 52.5 Q78 53.6 78 57" fill="none" stroke="${a}" stroke-width="2" stroke-linecap="round"/><circle cx="78" cy="61.5" r="1.5" fill="${a}"/>`,
    /* two tags, one tinted */
    type: (a) => `${bg(a)}<path d="M40 22 H66 A5 5 0 0 1 70 24 L96 50 A5 5 0 0 1 96 57 L77 76 A5 5 0 0 1 70 76 L44 50 A5 5 0 0 1 42 46 V26 A4 4 0 0 1 40 22 Z" ${S} transform="rotate(-14 66 50)" opacity=".55"/><path d="M34 24 H60 A5 5 0 0 1 64 26 L90 52 A5 5 0 0 1 90 59 L71 78 A5 5 0 0 1 64 78 L38 52 A5 5 0 0 1 36 48 V28 A4 4 0 0 1 34 24 Z" ${S}/><path d="M34 24 H60 A5 5 0 0 1 64 26 L90 52 A5 5 0 0 1 90 59 L71 78 A5 5 0 0 1 64 78 L38 52 A5 5 0 0 1 36 48 V28 A4 4 0 0 1 34 24 Z" fill="${a}" fill-opacity=".1"/><circle cx="47" cy="36" r="4.5" fill="var(--art-fill)" stroke="var(--art-line)" stroke-width="1.6"/>`,
    /* a cloud and a plug pulled out */
    error: (a) => `${bg(a)}<path d="M38 58 A14 14 0 0 1 36 30 A22 22 0 0 1 78 24 A16 16 0 0 1 90 58 Z" ${S}/><path d="M52 58 V68 Q52 74 46 74 H30" ${L}/><path d="M76 58 V64 Q76 70 82 70 H86" ${L}/><rect x="86" y="64" width="12" height="12" rx="3" ${S}/><path d="M98 67 H103 M98 73 H103" ${L}/><rect x="40" y="52" width="24" height="0" fill="none"/><path d="M64 34 L58 46 H66 L60 58" fill="none" stroke="${a}" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"/>${spark(102, 22, 4, a)}`,
  };
})();
function emptyHtml(kind) {
  const appr = state.persona === "approver";
  const typeLabel = (SEVERITIES.find(([k]) => k === state.type)?.[1] || "comment").toLowerCase();
  const E = {
    none: ["none", "#A64DFF", "No comments yet", `Hold ${MOD} and click anything to leave one.`],
    page: ["none", "#A64DFF", "Nothing here yet", `Hold ${MOD} and click anything to leave one.`],
    allDone: ["allDone", "#2BA66B", "Everything is approved", "Nothing left open. Nice work, everyone."],
    resolved: ["resolved", "#2BA66B", "Nothing approved yet", "Approved comments gather here."],
    "st-open": ["open", "#A64DFF", appr ? "Nothing new" : "Nothing new to pick up", "All caught up. New comments show up here."],
    "st-progress": ["progress", "#FF6F00", "Nothing in progress", "Pick something up and it shows here."],
    "st-approval": appr ? ["stampRest", "#31BFB0", "Nothing waiting for you", "Sit back. Work for your approval lands here."] : ["plane", "#31BFB0", "Nothing waiting for approval", "Work sent for approval shows here."],
    statuses: ["statuses", "#8a96a8", "Nothing in these statuses", "Try another status above."],
    search: ["search", "#3d9bff", "No match", "Try other words, a #number or a name."],
    type: ["type", "#8a96a8", `No ${typeLabel}s here`, "Switch the filter to see the rest."],
    error: ["error", "#e11d48", "Can't reach the hub", "Keeping what is here and trying again."],
  };
  const [art, accent, title, line] = E[kind] || E.page;
  return `<div class="empty-state"><svg class="empty-art" width="120" height="90" viewBox="0 0 128 96" aria-hidden="true">${ART[art](accent)}</svg><b>${esc(title)}</b><span>${esc(line)}</span></div>`;
}
/* pictures load as their card nears the screen (this page's at once); the next batch is built as its placeholder
   comes near (Nirav, 2026-10-25) */
const picSeen = new IntersectionObserver((entries) => {
  for (const e of entries) {
    if (!e.isIntersecting) continue;
    const img = e.target;
    if (img.dataset.src) {
      img.src = img.dataset.src;
      delete img.dataset.src;
    }
    picSeen.unobserve(img);
  }
}, { root: panelBody, rootMargin: "600px 0px" });
const moreSeen = new IntersectionObserver((entries) => {
  if (!entries.some((e) => e.isIntersecting)) return;
  moreSeen.disconnect();
  state.renderLimit = (state.renderLimit || 40) + 40;
  if (!panelBusy()) renderPanel();
}, { root: panelBody, rootMargin: "800px 0px" });
/* three placeholder cards while the list loads */
function skeletonHtml() {
  const one = (pic) => `<div class="skel-card"><span class="sk sk-line" style="width:78%"></span><span class="sk sk-line" style="width:52%"></span>${pic ? '<span class="sk sk-pic"></span>' : ""}<span class="sk-foot"><span class="sk sk-dot"></span><span class="sk sk-line" style="width:38%"></span></span></div>`;
  return one(true) + one(false) + one(true);
}
function clearBody() {
  for (const ch of [...panelBody.childNodes]) if (ch !== tools) ch.remove();
  if (tools.parentNode !== panel) panel.appendChild(tools);
}
/* a comment matches the search by its words, its number, its page or place, or a person on it */
function matchesQ(c, q) {
  if (!q) return true;
  const hay = [c.text, `#${c.n}`, String(c.n), c.pageTitle, c.route, c.context, c.assignee, c.doneBy, c.approvedBy, c.by, c.note?.text].filter(Boolean).join(" \n ").toLowerCase();
  return q.toLowerCase().split(/\s+/).every((w) => hay.includes(w));
}
const shotUrl = (c) => c.localShot || c.urls?.shot || `/__review/shot/${c.shot}${window.__reviewSession ? `?session=${window.__reviewSession}` : ""}`;
/* THUMBNAILS (2026-10-21): the list shows a small JPEG (720 wide), the full PNG is fetched only for the lightbox and
   the copies. Made in the browser at save time; older comments get theirs the first time the list shows them. */
const thumbUrl = (c) => (c.localShot ? c.localShot : c.urls?.thumb ? c.urls.thumb : c.thumb ? `/__review/shot/${c.thumb}${window.__reviewSession ? `?session=${window.__reviewSession}` : ""}` : shotUrl(c));
async function makeThumb(src, maxW = 720) {
  const img = await loadImage(src);
  const scale = Math.min(1, maxW / img.naturalWidth);
  const cv = document.createElement("canvas");
  cv.width = Math.round(img.naturalWidth * scale);
  cv.height = Math.round(img.naturalHeight * scale);
  const g = cv.getContext("2d");
  g.fillStyle = "#fff";
  g.fillRect(0, 0, cv.width, cv.height);
  g.drawImage(img, 0, 0, cv.width, cv.height);
  return cv.toDataURL("image/jpeg", 0.82);
}
let thumbing = false;
async function backfillThumbs() {
  if (thumbing) return;
  thumbing = true;
  try {
    const built = new Set([...panelBody.querySelectorAll(".card")].map((x) => x.dataset.id)); // only cards on screen, not all
    for (const c of [...state.comments, ...state.done]) {
      if (c.thumb || !c.shot || !built.has(c.id)) continue;
      const jpg = await makeThumb(shotUrl(c));
      const r = await api("thumb", { id: c.id, jpg });
      if (r.ok) c.thumb = `${c.id}.t.jpg`;
    }
  } catch {
    /* next time */
  } finally {
    thumbing = false;
  }
}
/* a write's answer put straight into what we hold and onto the card, so a button answers at once; the list is
   fetched again only when the comment changes list (to or from Approved) */
function applyEntry(entry) {
  if (!entry?.id) return false;
  const wasDone = state.done.some((c) => c.id === entry.id);
  const isDone = entry.status === "approved";
  state.comments = state.comments.filter((c) => c.id !== entry.id);
  state.done = state.done.filter((c) => c.id !== entry.id);
  (isDone ? state.done : state.comments).push(entry);
  if (wasDone !== isDone) state.doneCount = Math.max(0, (state.doneCount || 0) + (isDone ? 1 : -1));
  state.comments.sort((a, b) => a.n - b.n);
  state.done.sort((a, b) => a.n - b.n);
  state.count = state.comments.length;
  updateBar();
  return wasDone !== isDone; // crossed between the lists: the panel needs a rebuild
}
function refreshCard(c, animate = false) {
  const card = panelBody.querySelector(`.card[data-id="${c.id}"]`);
  if (!card) return false;
  card.querySelector(".card-text").textContent = c.text;
  const sev = card.querySelector(".card-sev");
  const sevLabel = SEVERITIES.find(([k]) => k === c.severity)?.[1] || c.severity;
  if (sev) {
    sev.dataset.k = c.severity;
    sev.setAttribute("aria-label", sevLabel);
    const lbl = sev.querySelector(".lbl");
    if (lbl) lbl.textContent = sevLabel;
    else sev.textContent = sevLabel;
  }
  const rail = c.severity === "question"; // the exception carries the mark (Nirav, 2026-10-23: most comments are fixes)
  card.classList.toggle("card-rail", rail);
  card.classList.toggle("card-rail-right", rail);
  if (rail) card.dataset.k = c.severity;
  else delete card.dataset.k;
  const st = card.querySelector(".card-status");
  const acts = card.querySelector(".card-foot .acts");
  const chip = () => {
    st.dataset.s = shownStatus(c);
    st.innerHTML = statusHtml(c);
  };
  const buttons = () => {
    if (acts && !c.pending) acts.innerHTML = actsHtml(c);
  };
  if (!st || state.asking?.id === c.id) {
    /* the box is in the foot: the words are kept in state and shown when it closes */
  } else if (animate && (st.textContent.trim() !== statusLine(c).trim() || st.dataset.s !== shownStatus(c))) {
    swapIn(st, chip);
    swapIn(acts, buttons);
  } else {
    chip();
    buttons();
  }
  let note = card.querySelector(".card-note");
  if (hasNote(c)) {
    if (!note) {
      note = document.createElement("div");
      note.className = "card-note";
      card.insertBefore(note, card.querySelector(".card-meta")); // above the hover strip, which stays the card's last line
    }
    note.innerHTML = noteHtml(c);
  } else note?.remove();
  histSync(card, c);
  return true;
}
/* one write; the pressed button shows it is working and its neighbours go quiet; the hub's answer then crossfades
   into the chip and the buttons. A refusal puts the buttons back and says so. A rebuild only when the comment
   changed list (to or from Approved). */
async function applyUpdate(body, btn) {
  const card = panelBody.querySelector(`.card[data-id="${body.id}"]`);
  const was = (state.comments.find((x) => x.id === body.id) || state.done.find((x) => x.id === body.id))?.status;
  const acts = btn?.closest(".acts, .tip-acts-in");
  btn?.classList.add("loading");
  acts?.classList.add("busy");
  let r = null;
  try {
    r = await api("update", body);
  } catch {}
  btn?.classList.remove("loading");
  acts?.classList.remove("busy");
  if (!r?.entry) {
    /* a rule of the hub's ("Already picked up by Pranjal") is said as it is, and the list catches up with what won */
    const said = r?.error || "the hub did not answer";
    toast(/picked up|approver|not allowed/i.test(said) ? said : `Could not save that: ${said}`, true);
    if (/picked up/i.test(said)) loadComments().then(() => renderPanel());
    return null;
  }
  if (r.entry.status === "approved" && body.status === "approved" && card && !PAGE_MODE_RESOLVED()) await approveFx(card).catch((e) => console.warn("[review] approval effect:", e)); // its moment before it leaves; an effect that fails never stops the approval
  if (applyEntry(r.entry) || !refreshCard(r.entry, !!card)) renderPanel();
  /* Done or picked up by your own hand: a small happy moment for you */
  const moment = isQ(r.entry) ? null : was === "progress" && r.entry.status === "approval" && body.status === "approval" ? "done" : was === "open" && r.entry.status === "progress" && body.status === "progress" ? "pick" : null;
  if (moment) {
    const now = panelBody.querySelector(`.card[data-id="${body.id}"]`);
    if (now) doneFx(now, moment).catch(() => {});
  }
  return r.entry;
}
/* GOODBYES (Nirav, 2026-10-24, picked from many trials): a removed card turns to dust, the Infinity War snap, the ash
   taking over while a hint of the card stays; an approved one is locked on, HUD corner brackets and a scan line, then
   the Approve button closes into Stripe's green check. Then it folds away and the list closes the gap. Nothing moves
   for someone who asked the system for less motion. */
const calm = () => matchMedia("(prefers-reduced-motion: reduce)").matches;
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
/* the card folds away: height, margin and padding to nothing, so the cards below glide up */
async function foldAway(card, ms = 240) {
  const h = card.offsetHeight;
  const mb = getComputedStyle(card).marginBottom;
  card.style.overflow = "hidden";
  await card.animate([{ height: `${h}px`, marginBottom: mb, paddingTop: getComputedStyle(card).paddingTop, paddingBottom: getComputedStyle(card).paddingBottom }, { height: "0px", marginBottom: "0px", paddingTop: "0px", paddingBottom: "0px" }], { duration: ms, easing: "cubic-bezier(.65,0,.35,1)", fill: "forwards" }).finished.catch(() => {});
}
async function removeFx(card) {
  if (!card?.isConnected || calm()) return;
  card.classList.remove("menu-open");
  card.querySelector(".card-more-wrap.open")?.classList.remove("open");
  await snapAway(card);
  await foldAway(card);
}
/* THE SNAP (Nirav, 2026-10-24: "Avengers: Infinity War kinda dust"): the card crumbles into ash from the left and blows
   away up and to the right. Two dozen copies of the card each keep a random scatter of 3 px specks (a mask drawn on a
   canvas); the specks on the left belong to the early copies, so the crumbling sweeps across; each copy drifts,
   turns a little and fades, one after another */
async function snapAway(card) {
  /* the real card stays solid and a soft edge eats it from left to right; ash appears only where the edge has passed
     and blows away up and to the right (Nirav, 2026-10-24: "some part of the card still looks, then turns to dust") */
  const rect = card.getBoundingClientRect();
  const w = rect.width, h = rect.height;
  const K = 24, CELL = 2, STEP = 32; // the edge crosses in about 0.8 s (Nirav, 2026-10-24: a bit faster)
  const cw = Math.ceil(w / CELL), ch = Math.ceil(h / CELL);
  const imgs = Array.from({ length: K }, () => new ImageData(cw, ch));
  for (let y = 0; y < ch; y++)
    for (let x = 0; x < cw; x++) {
      const k = Math.min(K - 1, Math.floor(((x / cw) * 0.88 + Math.random() * 0.12) * K)); // in step with the edge, a little ragged
      const d = imgs[k].data, i = (y * cw + x) * 4;
      d[i] = d[i + 1] = d[i + 2] = d[i + 3] = 255;
    }
  const urls = imgs.map((im) => {
    const cv = document.createElement("canvas");
    cv.width = cw;
    cv.height = ch;
    cv.getContext("2d").putImageData(im, 0, 0);
    return `url(${cv.toDataURL()})`;
  });
  /* the ash floats above everything, at the card's place on the screen */
  const layer = document.createElement("div");
  layer.style.cssText = `position:fixed;left:${rect.left}px;top:${rect.top}px;width:${w}px;height:${h}px;pointer-events:none;z-index:20;`;
  const pieces = urls.map((url) => {
    const piece = card.cloneNode(true);
    piece.classList.remove("menu-open", "hist-open", "picked");
    piece.style.cssText = `position:absolute;inset:0;margin:0;width:100%;height:100%;box-sizing:border-box;-webkit-mask-image:${url};mask-image:${url};-webkit-mask-size:100% 100%;mask-size:100% 100%;`;
    layer.appendChild(piece);
    return piece;
  });
  root.appendChild(layer);
  /* the edge: the card masked away from the left, as the ash leaves */
  const T = K * STEP, t0 = performance.now();
  /* a wide, soft edge and the card itself fading as the ash takes over (Nirav, 2026-10-24: mostly the dust, a hint of
     the solid card before it goes) */
  const edge = (p) => `linear-gradient(to right, transparent ${p - 20}%, #000 ${p + 20}%)`;
  card.animate([{ opacity: 1 }, { offset: 0.35, opacity: 0.85 }, { opacity: 0 }], { duration: T, easing: "ease-in", fill: "forwards" });
  const sweep = new Promise((done) => {
    const step = (now) => {
      const p = Math.min(125, ((now - t0) / T) * 145 - 20);
      card.style.webkitMaskImage = card.style.maskImage = edge(p);
      if (p < 125 && card.isConnected) requestAnimationFrame(step);
      else done();
    };
    requestAnimationFrame(step);
  });
  const blown = Promise.all(
    pieces.map((piece, k) => {
      const dx = 70 + Math.random() * 110, dy = -(35 + Math.random() * 85), r = (Math.random() - 0.4) * 22;
      return piece.animate([{ opacity: 1, transform: "none", filter: "blur(0)" }, { offset: 0.3, opacity: 0.95 }, { opacity: 0, transform: `translate(${dx}px, ${dy}px) rotate(${r}deg)`, filter: "blur(1.2px)" }], { duration: 760, delay: k * STEP, easing: "cubic-bezier(.3,.1,.6,1)", fill: "both" }).finished.catch(() => {}); // grain on the whole card from the start
    }),
  );
  await sweep;
  card.style.visibility = "hidden";
  card.style.webkitMaskImage = card.style.maskImage = "";
  blown.then(() => layer.remove()); // the last ash drifts on while the list already closes the gap
}
async function approveFx(card, btn = card?.querySelector(".card-foot .acts > .card-st, .card-foot .acts > button"), fold = true) {
  if (!card?.isConnected || calm()) return;
  const cr = card.getBoundingClientRect();
  const layer = document.createElement("div");
  layer.className = "fx-lock";
  layer.innerHTML = `<b class="br tl"></b><b class="br tr"></b><b class="br bl"></b><b class="br br2"></b><span class="scan"></span>`;
  card.appendChild(layer);
  if (btn) {
    await wait(380); // as the scan ends
    const br = btn.getBoundingClientRect();
    btn.style.visibility = "hidden";
    layer.insertAdjacentHTML("beforeend", `<span class="stp" style="left:${br.left - cr.left + br.width / 2}px;top:${br.top - cr.top + br.height / 2}px;--w:${br.width}px;--h:${br.height}px"><i class="ring"></i><svg width="16" height="16" viewBox="0 0 16 16" aria-hidden="true"><path d="M3.5 8.3l3 3 6-6.3" fill="none" stroke="#fff" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round" pathLength="1" class="stp-tick"/></svg></span>`);
    await wait(480);
  } else await wait(640);
  await card.animate([{ opacity: 1, transform: "none" }, { opacity: 0, transform: "scale(.99)" }], { duration: 200, easing: "cubic-bezier(.4,0,1,1)", fill: "forwards" }).finished.catch(() => {});
  if (fold) await foldAway(card);
}
/* the pin card's goodbye (Nirav, 2026-10-25): a copy of it plays the dust or the lock where it stands while the real
   one closes, so the real one is never left half-animated for its next use */
async function tipGoodbye(kind) {
  if (calm() || !tip.classList.contains("on")) return;
  const ghost = tip.cloneNode(true);
  ghost.classList.add("on");
  ghost.style.pointerEvents = "none";
  tip.parentNode.appendChild(ghost);
  tip.classList.remove("on");
  try {
    if (kind === "rm") await snapAway(ghost);
    else await approveFx(ghost, ghost.querySelector(".tip-ok"), false);
  } finally {
    ghost.remove();
  }
}
/* A FEEL-GOOD MOMENT FOR DONE (Nirav, 2026-10-24): whoever marks their work Done gets a small bubble where the button
   was, a teal face whose smile draws itself and whose eyes blink, and a word of praise with their name; the card
   glows softly; then it floats away. The card stays, now for approval. */
/* each line has its own face and its own little animation (Nirav, 2026-10-25: "not only the smile, different ones") */
const PRAISE = [ // each with a bold extra (Nirav, 2026-10-25: "same as the confetti and sparkles for the rest")
  { w: "Nice one", eyes: "wink", mouth: "smile", extra: "sparkle1" },
  { w: "Done and dusted", eyes: "dots", mouth: "grin", extra: "sparkle" },
  { w: "Great work", eyes: "hearts", mouth: "smile", extra: "hearts" },
  { w: "That's a wrap", eyes: "happy", mouth: "grin", extra: "confetti" },
  { w: "Another one down", eyes: "shades", mouth: "smirk", extra: "glint" },
  { w: "Smooth", eyes: "happy", mouth: "smile", move: "bounce", extra: "sparkle" },
];
const CHEER = [ // picking up (Nirav, 2026-10-24: "that for the pick moment too")
  { w: "You've got this", eyes: "dots", mouth: "grin", extra: "sparkle" },
  { w: "On it", eyes: "look", mouth: "smile", extra: "bang" },
  { w: "Let's go", eyes: "dots", mouth: "open", extra: "whoosh" },
  { w: "All yours", eyes: "happy", mouth: "smile", extra: "hearts" },
  { w: "Game on", eyes: "stars", mouth: "grin", extra: "confetti" },
  { w: "Here we go", eyes: "dots", mouth: "smile", move: "nod", extra: "arcs" },
];
/* a small face, drawn flat (Nirav, 2026-10-25: the flat style was the best; a shaded, emoji-like try was dropped the
   same day): the circle in the moment's colour, white eyes and mouth, and a little extra outside it */
function faceSvg(f, fill) {
  const W = "#fff";
  const EYES = {
    dots: `<g class="f-blink"><circle cx="7" cy="8" r="1.3" fill="${W}"/><circle cx="13" cy="8" r="1.3" fill="${W}"/></g>`,
    wink: `<circle cx="7" cy="8" r="1.3" fill="${W}"/><g class="f-wink"><circle cx="13" cy="8" r="1.3" fill="${W}"/></g>`,
    happy: `<path d="M5.4 8.7 Q7 6.9 8.6 8.7 M11.4 8.7 Q13 6.9 14.6 8.7" fill="none" stroke="${W}" stroke-width="1.4" stroke-linecap="round"/>`,
    hearts: `<g class="f-pulse"><path d="M7 9.6 L5.4 8 a1 1 0 0 1 1.6 -1.2 a1 1 0 0 1 1.6 1.2 Z M13 9.6 L11.4 8 a1 1 0 0 1 1.6 -1.2 a1 1 0 0 1 1.6 1.2 Z" fill="${W}"/></g>`,
    stars: `<g class="f-twinkle"><path d="M7 5.9 L7.6 7.4 L9.1 8 L7.6 8.6 L7 10.1 L6.4 8.6 L4.9 8 L6.4 7.4 Z M13 5.9 L13.6 7.4 L15.1 8 L13.6 8.6 L13 10.1 L12.4 8.6 L10.9 8 L12.4 7.4 Z" fill="${W}"/></g>`,
    shades: `<g class="f-shades"><rect x="4.2" y="6.6" width="11.6" height="1.2" rx=".6" fill="#1d2b3e"/><rect x="4.6" y="6.9" width="4.6" height="3.1" rx="1.2" fill="#1d2b3e"/><rect x="10.8" y="6.9" width="4.6" height="3.1" rx="1.2" fill="#1d2b3e"/></g>`,
    look: `<g class="f-look"><circle cx="7" cy="8" r="1.3" fill="${W}"/><circle cx="13" cy="8" r="1.3" fill="${W}"/></g>`,
    big: `<g class="f-blink"><circle cx="6.8" cy="7.2" r="2.3" fill="${W}"/><circle cx="13.2" cy="7.2" r="2.3" fill="${W}"/><circle class="f-peek" cx="7.2" cy="7.6" r="1.1" fill="#1d2b3e"/><circle class="f-peek" cx="13.6" cy="7.6" r="1.1" fill="#1d2b3e"/></g>`,
    blush: `<circle cx="7" cy="8" r="1.3" fill="${W}"/><circle cx="13" cy="8" r="1.3" fill="${W}"/><ellipse class="f-blush" cx="4.7" cy="11.3" rx="1.9" ry="1.1" fill="#ffc2d1"/><ellipse class="f-blush" cx="15.3" cy="11.3" rx="1.9" ry="1.1" fill="#ffc2d1"/>`,
    glasses: `<g class="f-glasses"><g fill="none" stroke="#1d2b3e" stroke-width="1.3"><circle cx="6.7" cy="8.2" r="2.5"/><circle cx="13.3" cy="8.2" r="2.5"/><path d="M9.2 8.2 H10.8"/></g><circle cx="6.7" cy="8.2" r="1" fill="${W}"/><circle cx="13.3" cy="8.2" r="1" fill="${W}"/></g>`,
    /* a clear gap between eyes and mouth (Nirav, 2026-10-25): smaller eyes, set higher */
    sparkly: `<circle cx="6.9" cy="7.3" r="2.1" fill="${W}"/><circle cx="13.1" cy="7.3" r="2.1" fill="${W}"/>${[6.9, 13.1].map((x) => `<path class="f-glimmer" d="M${x} 5.9 L${x + 0.4} 6.9 L${x + 1.4} 7.3 L${x + 0.4} 7.7 L${x} 8.7 L${x - 0.4} 7.7 L${x - 1.4} 7.3 L${x - 0.4} 6.9 Z" fill="${fill}"/>`).join("")}`,
    monocle: `<circle cx="7" cy="8" r="1.35" fill="${W}"/><circle cx="13.1" cy="8" r="1.35" fill="${W}"/><g class="f-monocle"><circle cx="13.1" cy="8" r="2.75" fill="hsl(48 100% 85% / .25)" stroke="#ffc83d" stroke-width="1.2"/><path d="M15.3 9.8 Q16.8 12.8 15.6 15.6" fill="none" stroke="#ffc83d" stroke-width=".7" stroke-linecap="round"/></g>`,
    aim: `<path d="M5.3 8.2 Q7 7.2 8.7 8.2" fill="none" stroke="${W}" stroke-width="1.5" stroke-linecap="round"/><g class="f-blink"><circle cx="13" cy="8" r="1.45" fill="${W}"/></g>`,
    joy: `<path d="M5.2 8.9 Q7 6.4 8.8 8.9 M11.2 8.9 Q13 6.4 14.8 8.9" fill="none" stroke="${W}" stroke-width="1.6" stroke-linecap="round"/>`,
    squint: `<path d="M5.1 6.9 L7.7 8.4 L5.1 9.9 M14.9 6.9 L12.3 8.4 L14.9 9.9" fill="none" stroke="${W}" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"/>`,
  };
  const MOUTH = {
    smile: `<path class="f-draw" d="M6 11.6 Q10 15.4 14 11.6" fill="none" stroke="${W}" stroke-width="1.6" stroke-linecap="round" pathLength="1"/>`,
    grin: `<path d="M5.8 11.2 Q10 16.8 14.2 11.2 Z" fill="${W}"/>`,
    smirk: `<path class="f-draw" d="M7 12.6 Q11 14.4 14 11.4" fill="none" stroke="${W}" stroke-width="1.6" stroke-linecap="round" pathLength="1"/>`,
    open: `<ellipse cx="10" cy="13.2" rx="2.1" ry="2" fill="${W}"/>`,
    wide: `<path d="M5.8 11.7 H14.2 Q13.8 16.9 10 16.9 Q6.2 16.9 5.8 11.7 Z" fill="${W}"/><path d="M7.6 15.6 Q10 14.3 12.4 15.6 Q11.5 16.7 10 16.7 Q8.5 16.7 7.6 15.6 Z" fill="#ff8fab"/>`,
    cat: `<path class="f-draw" d="M6.4 12 Q8.2 14.4 10 12 Q11.8 14.4 13.6 12" fill="none" stroke="${W}" stroke-width="1.5" stroke-linecap="round" pathLength="1"/>`,
    calm: `<path class="f-draw" d="M7.2 12.8 Q10 14.4 12.8 12.8" fill="none" stroke="${W}" stroke-width="1.5" stroke-linecap="round" pathLength="1"/>`,
    tongue: `<path d="M6 11.6 Q10 15.4 14 11.6" fill="none" stroke="${W}" stroke-width="1.6" stroke-linecap="round"/><path class="f-tongue" d="M8.8 13.5 Q10 17 11.2 13.5 Z" fill="#ff8fab"/>`,
    o: `<circle class="f-o" cx="10" cy="13.4" r="1.7" fill="none" stroke="${W}" stroke-width="1.5"/>`,
    ooh: `<ellipse class="f-o" cx="10" cy="13.4" rx="1.6" ry="1.95" fill="${W}"/>`,
    beam: `<path d="M6.7 12.3 Q10 16.5 13.3 12.3 Z" fill="${W}" stroke="${W}" stroke-width=".8" stroke-linejoin="round"/>`,
    soft: `<g class="f-widen"><path class="f-draw" d="M6.9 12.3 Q10 15 13.1 12.3" fill="none" stroke="${W}" stroke-width="1.6" stroke-linecap="round" pathLength="1"/></g>`,
    side: `<path class="f-draw" d="M7.2 12.7 Q10.4 14.6 13 12.1" fill="none" stroke="${W}" stroke-width="1.6" stroke-linecap="round" pathLength="1"/>`,
    teeth: `<rect x="6.3" y="11.4" width="7.4" height="3.6" rx="1.7" fill="${W}"/><path d="M6.5 13.2 H13.5 M8.8 11.5 V15 M11.2 11.5 V15" stroke="${fill}" stroke-width=".6"/>`,
  };
  const EXTRA = {
    sparkle: `<path class="f-sparkle" d="M21 -3 L22.1 0.2 L25.3 1.3 L22.1 2.4 L21 5.6 L19.9 2.4 L16.7 1.3 L19.9 0.2 Z" fill="#ffc83d"/><path class="f-sparkle s2" d="M-2 15 L-1.4 16.6 L0.2 17.2 L-1.4 17.8 L-2 19.4 L-2.6 17.8 L-4.2 17.2 L-2.6 16.6 Z" fill="#ffc83d"/>`,
    sparkle1: `<path class="f-sparkle" d="M21 -3 L22.1 0.2 L25.3 1.3 L22.1 2.4 L21 5.6 L19.9 2.4 L16.7 1.3 L19.9 0.2 Z" fill="#ffc83d"/>`,
    confetti: [[-3, -2, "#ff6b8a", 0], [23, -2, "#ffc83d", 1], [-4, 14, "#4dabff", 1], [24, 15, "#a77bff", 0], [10, -5, "#2bd47d", 1], [3, 24, "#ff9f43", 0], [18, 24, "#ff6b8a", 1], [-5, 6, "#2bd47d", 0]].map(([x, y, c, strip], i) => (strip ? `<rect class="f-confetti" style="--x:${(x - 10) * 0.55}px;--y:${(y - 10) * 0.55}px;--d:${i * 25}ms;--r:${i % 2 ? 60 : -50}deg" x="${x - 1.6}" y="${y - 0.7}" width="3.2" height="1.4" rx=".5" fill="${c}"/>` : `<circle class="f-confetti" style="--x:${(x - 10) * 0.55}px;--y:${(y - 10) * 0.55}px;--d:${i * 25}ms;--r:0deg" cx="${x}" cy="${y}" r="1.6" fill="${c}"/>`)).join(""),
    whoosh: `<g class="f-whoosh" stroke="${fill}" stroke-width="2" stroke-linecap="round"><path d="M-6 5 H-0.5"/><path d="M-8 10 H-1"/><path d="M-6 15 H-0.5"/></g>`,
    hearts: `<path class="f-heart" d="M20 5 L17.4 2.4 a1.6 1.6 0 0 1 2.6 -2 a1.6 1.6 0 0 1 2.6 2 Z" fill="#ff5277"/><path class="f-heart h2" d="M1 4 L-1.2 1.8 a1.35 1.35 0 0 1 2.2 -1.7 a1.35 1.35 0 0 1 2.2 1.7 Z" fill="#ff8fab"/>`,
    glint: `<rect class="f-glint" x="4" y="6.4" width="2" height="4" rx="1" fill="#fff" opacity=".9" transform="skewX(-20)"/><path class="f-sparkle" d="M21 -3 L22.1 0.2 L25.3 1.3 L22.1 2.4 L21 5.6 L19.9 2.4 L16.7 1.3 L19.9 0.2 Z" fill="#ffc83d"/>`,
    bang: `<g class="f-bang"><rect x="19.2" y="-4" width="2.4" height="6" rx="1.2" fill="#ff5277"/><circle cx="20.4" cy="4.4" r="1.3" fill="#ff5277"/></g>`,
    arcs: `<g class="f-arcs" fill="none" stroke="${fill}" stroke-width="1.6" stroke-linecap="round"><path d="M22.5 5 Q25 10 22.5 15"/><path d="M-2.5 5 Q-5 10 -2.5 15"/></g>`,
    bulb: `<g class="f-bulb"><circle cx="21" cy="-0.5" r="2.7" fill="#ffd84d"/><rect x="19.8" y="2" width="2.4" height="1.8" rx=".5" fill="#c9a227"/><g class="f-rays" stroke="#ffd84d" stroke-width="1.1" stroke-linecap="round"><path d="M21 -5.2 V-4.2"/><path d="M25.6 -0.5 H24.6"/><path d="M16.4 -0.5 H17.4"/><path d="M24.3 -3.8 L23.6 -3.1"/><path d="M17.7 -3.8 L18.4 -3.1"/></g></g>`,
    check: `<path class="f-check" d="M20.9 0.2 L22.5 1.8 L25.4 -1.6" fill="none" stroke="#2bd47d" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" pathLength="1"/>`, // smaller, with a gap from the head (Nirav, 2026-10-25)
    stars3: [[22, -2, 0], [-2.5, -1, 1], [10, -5, 2]].map(([x, y, i]) => `<path class="f-star3" style="--d:${i * 180}ms" d="M${x} ${y - 2.4} L${x + 0.8} ${y - 0.8} L${x + 2.4} ${y} L${x + 0.8} ${y + 0.8} L${x} ${y + 2.4} L${x - 0.8} ${y + 0.8} L${x - 2.4} ${y} L${x - 0.8} ${y - 0.8} Z" fill="#ffc83d"/>`).join(""),
    magnifier: `<g class="f-mag"><circle cx="21.5" cy="0" r="2.8" fill="hsl(200 100% 85% / .45)" stroke="#8a96a8" stroke-width="1.4"/><path d="M23.5 2 L25.9 4.4" stroke="#8a96a8" stroke-width="1.8" stroke-linecap="round"/></g>`,
    /* a bigger, clear map pin in blue, so it stands apart from the red face (Nirav, 2026-10-25: "this pin looks small and odd") */
    target: `<g class="f-target"><circle cx="21.4" cy="-0.6" r="3.3" fill="#3d9bff"/><circle cx="21.4" cy="-0.6" r="2.15" fill="#fff"/><circle cx="21.4" cy="-0.6" r="1.05" fill="#3d9bff"/></g>`,
    bubble: `<g class="f-bubble"><path d="M18.2 -5.6 H25 A1.6 1.6 0 0 1 26.6 -4 V-0.6 A1.6 1.6 0 0 1 25 1 H20.4 L18.6 2.8 L18.9 1 H18.2 A1.6 1.6 0 0 1 16.6 -0.6 V-4 A1.6 1.6 0 0 1 18.2 -5.6 Z" fill="#fff" stroke="#8a96a8" stroke-width=".6"/><path class="f-beat" d="M21.6 0.2 L19.2 -2.2 a1.2 1.2 0 0 1 2.4 -1.75 a1.2 1.2 0 0 1 2.4 1.75 Z" fill="#ff3d6e"/></g>`, // a bigger heart that beats (Nirav, 2026-10-25)
  };
  return `<svg class="f-face${f.move ? ` f-${f.move}` : ""}" width="22" height="22" viewBox="-4 -4 28 28" aria-hidden="true"><circle cx="10" cy="10" r="10" fill="${fill}"/>${EYES[f.eyes] || EYES.dots}${MOUTH[f.mouth] || MOUTH.smile}${f.extra ? EXTRA[f.extra] : ""}</svg>`;
}
/* a new pin's pill: beside its number, in the pin card's colour, a red face and a word of thanks (Nirav, 2026-10-25) */
const ADDED = [ // faces of their own, none borrowed from Pick up or Done (Nirav, 2026-10-25)
  { w: "Good catch", eyes: "big", mouth: "wide", extra: "bulb" },
  { w: "Sharp eye", eyes: "aim", mouth: "side", extra: "target" }, // in place of "Pinned it" (Nirav, 2026-10-25)
  { w: "Noted", eyes: "glasses", mouth: "calm", extra: "check" },
  { w: "Nice find", eyes: "sparkly", mouth: "beam", extra: "stars3" }, // no tongue, clearer eyes (Nirav, 2026-10-25)
  { w: "Spotted", eyes: "monocle", mouth: "ooh", extra: "magnifier" }, // a solid "ooh", a gold monocle (Nirav, 2026-10-25)
  { w: "Thanks for this", eyes: "joy", mouth: "soft", extra: "bubble" }, // in place of "On the map" (Nirav, 2026-10-25)
];
function addPill(kind = "add") {
  if (calm()) return null;
  const words = kind === "pick" ? CHEER : kind === "done" ? PRAISE : ADDED;
  const face = words[Math.floor(Math.random() * words.length)];
  const name = String(state.me || "").split(/\s+/)[0];
  const b = document.createElement("div");
  b.className = "fx-done pin-add";
  b.style.visibility = "hidden"; // until its pin is drawn
  b.innerHTML = `${faceSvg(face, kind === "pick" ? "#FF6F00" : kind === "done" ? "#31BFB0" : "#e11d48")}<span>${esc(face.w)}${name ? `, ${esc(name)}` : ""}</span>`;
  root.appendChild(b);
  setTimeout(async () => {
    await b.animate([{ opacity: 1, transform: "none" }, { opacity: 0, transform: "translateY(-8px)" }], { duration: 260, easing: "ease-in", fill: "forwards" }).finished.catch(() => {});
    b.remove();
  }, 2300);
  return b;
}
async function doneFx(card, kind = "done") {
  if (!card?.isConnected || calm()) return;
  const name = String(state.me || "").split(/\s+/)[0];
  const words = kind === "pick" ? CHEER : PRAISE;
  const face = words[Math.floor(Math.random() * words.length)];
  const line = face.w;
  const foot = card.querySelector(".card-foot, .tip-acts"); // a list card's foot, or the pin card's buttons
  const cr = card.getBoundingClientRect(), fr = (foot || card).getBoundingClientRect();
  const b = document.createElement("div");
  const below = card.classList.contains("pin-tip"); // on the pin card: above it, so its buttons stay clear (Nirav, 2026-10-25: "at the top")
  b.className = `fx-done${kind === "pick" ? " pick" : ""}${below ? " below" : ""}`;
  b.style.cssText = below ? "right:0;top:auto;bottom:calc(100% + 8px);" : `right:14px;top:${fr.top - cr.top + fr.height / 2}px;`;
  b.innerHTML = `${faceSvg(face, kind === "pick" ? "#FF6F00" : "#31BFB0")}<span>${esc(line)}${name ? `, ${esc(name)}` : ""}</span>`;
  card.appendChild(b);
  card.classList.add(kind === "pick" ? "fx-pick-glow" : "fx-done-glow");
  await wait(1700);
  const y = below ? "0px" : "-50%"; // floats up and away either way
  await b.animate([{ opacity: 1, transform: `translateY(${y})` }, { opacity: 0, transform: `translateY(calc(${y} - 10px))` }], { duration: 260, easing: "ease-in", fill: "forwards" }).finished.catch(() => {});
  b.remove();
  card.classList.remove("fx-done-glow", "fx-pick-glow");
}
/* a part of the card fades out, changes, fades in */
function swapIn(el, change) {
  if (!el) return;
  el.classList.add("swap");
  setTimeout(() => {
    change();
    el.classList.remove("swap");
  }, 140);
}
const PAGE_MODE_RESOLVED = () => PAGE_MODE && window.__reviewView === "resolved"; // the approved list keeps it
const guarded = (path, body) => path === "delete" || (path === "update" && ((body?.status === "approved" && !body?.resolve) || !!body?.assignTo)); // a question's Got it is not an approval
const api = (path, body) => rv(`/__review/${path}${window.__reviewSession ? `?session=${window.__reviewSession}` : ""}`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) }, guarded(path, body)).then((r) => r.json());
let teamCache = { at: 0, list: [] };
async function teamList() {
  if (Date.now() - teamCache.at < 60_000 && teamCache.list.length) return teamCache.list;
  const list = await rv(`/__review/people${window.__reviewSession ? `?session=${window.__reviewSession}` : ""}`).then((r) => r.json()).catch(() => []);
  teamCache = { at: Date.now(), list: Array.isArray(list) ? list : [] };
  return teamCache.list;
}
/* WHO MAY DO WHAT comes from the hub's rules table (hub/roles.sql, review_rules; Nirav, 2026-10-24): change a row in
   Supabase and every drawer follows within a minute, no new extension. These defaults are the same rows, used until
   the table answers (or where it does not exist). An approver may always do everything; a signed rule also needs the
   GitHub sign-in (the extension, or a local test session). ?as=team shows the team's view. */
const RULES_DEFAULT = [
  { action: "pick_up", who: "anyone", statuses: ["open"], signed: false },
  { action: "put_back", who: "assignee", statuses: ["progress"], signed: false },
  { action: "done", who: "assignee", statuses: ["progress"], signed: false },
  { action: "approve", who: "approver", statuses: null, signed: true },
  { action: "send_back", who: "approver", statuses: ["approval"], signed: true },
  { action: "take_back", who: "assignee", statuses: ["approval"], signed: false },
  { action: "answer", who: "anyone", statuses: null, signed: false },
  { action: "follow_up", who: "author", statuses: null, signed: false },
  { action: "resolve", who: "author", statuses: ["open", "progress", "approval"], signed: false },
  { action: "reopen", who: "approver", statuses: ["approved"], signed: true },
  { action: "hand_over", who: "assignee", statuses: ["progress"], signed: true },
  { action: "assign", who: "approver", statuses: ["open"], signed: true },
  { action: "edit", who: "author", statuses: null, signed: false },
  { action: "change_type", who: "anyone", statuses: null, signed: false },
  { action: "remove", who: "author", statuses: ["open"], signed: true },
];
state.rules = RULES_DEFAULT;
let rulesAt = 0;
async function loadRules() {
  if (Date.now() - rulesAt < 55_000) return false;
  rulesAt = Date.now();
  const rows = await rv(`/__review/rules${window.__reviewSession ? `?session=${window.__reviewSession}` : ""}`).then((r) => r.json()).catch(() => null);
  if (!Array.isArray(rows) || !rows.length) return false;
  const changed = JSON.stringify(rows) !== JSON.stringify(state.rules);
  state.rules = rows;
  return changed;
}
const canSign = () => (window.__reviewSession ? true : EXT ? !!state.hub?.signedIn : extHere());
const isApprover = () => !!state.hub?.approver && state.persona !== "team";
const isMe = (name) => !!name && !!state.me && (name === state.me || name.split(/\s+/)[0] === state.me);
const isMine = (c) => isMe(c.by);
function can(action, c) {
  const rows = state.rules.filter((r) => r.action === action);
  if (!rows.length) return isApprover(); // an action nobody wrote a rule for: the approver's
  if (rows.some((r) => r.signed) && !canSign()) return false;
  if (isApprover()) return true;
  return rows.some((r) => (!r.statuses || r.statuses.includes(c.status)) && (r.who === "anyone" || r.who === "member" || (r.who === "author" && isMine(c)) || (r.who === "assignee" && isMe(c.assignee))));
}
/* the move a button makes, as a rule's action */
const moveOf = (c, to) => (to === "approved" ? "approve" : c.status === "approved" ? "reopen" : c.status === "approval" ? "send_back" : c.status === "progress" ? (to === "approval" ? "done" : "put_back") : "pick_up");
const canEdit = (c) => can("edit", c);
const canRemove = (c) => can("remove", c);
state.filter = new Set(); // the tags pressed; none pressed = every tag
state.selected = new Set(); // comment ids picked in the list; while any shown one is picked, the copies take those only
state.scope = { kind: "all" };
let scopeAway = null; // the scope menu's outside-click listener, one at a time
/* the scope: { kind: "all" } | { kind: "group", group } | { kind: "route", route, title } (a place picked from the
   list, fixed) | { kind: "here" } ("This page": whatever page the app is on when the list is drawn) */
const scopeNow = () => (state.scope.kind === "here" ? { kind: "route", route: location.pathname, title: pageTitle(), here: true } : state.scope);
/* the foot's buttons for where a comment stands: the next step first, the way back second */
/* the card's actions (Nirav, 2026-10-23: one button, the rest in a menu): the next step as the only button, then ⋯
   with the other moves, the type change and Remove */
function actsHtml(c) {
  const all = isQ(c) ? [] : (statusActions(c).match(/<button[^>]*>[^<]*<\/button>/g) || []).filter((x) => can(moveOf(c, (x.match(/data-to="(\w+)"/) || [])[1]), c)); // each move by the rules
  let main = all.find((x) => !/ alt"/.test(x)) || all[0] || "";
  /* the product's popover (Nirav, 2026-10-23): an icon before every item */
  const I = (d) => `<svg class="mi-ico" width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${d}</svg>`;
  const ICO = {
    approved: I('<circle cx="12" cy="12" r="9"/><path d="M8.5 12.5l2.5 2.5 4.5-5"/>'),
    open: I('<path d="M9 14L4 9l5-5"/><path d="M4 9h10.5a5.5 5.5 0 0 1 0 11H11"/>'),
    progress: I('<path d="M9 14L4 9l5-5"/><path d="M4 9h10.5a5.5 5.5 0 0 1 0 11H11"/>'),
    approval: I('<rect x="4" y="4" width="16" height="16" rx="3"/><path d="M8.5 12.5l2.5 2.5 4.5-5"/>'),
    fix: I('<path d="M14.7 6.3a4 4 0 0 0-5.4 5.4L3.5 17.5a1.8 1.8 0 0 0 2.5 2.5l5.8-5.8a4 4 0 0 0 5.4-5.4l-2.5 2.5-2.1-.4-.4-2.1z"/>'),
    question: I('<circle cx="12" cy="12" r="9"/><path d="M9.6 9.3a2.5 2.5 0 0 1 4.8.9c0 1.7-2.4 2.2-2.4 3.6"/><path d="M12 17h.01"/>'),
    remove: I('<path d="M4 7h16M10 11v6M14 11v6M6 7l1 12a2 2 0 0 0 2 2h6a2 2 0 0 0 2-2l1-12M9 7V4h6v3"/>'),
    hand: I('<circle cx="9" cy="8" r="3.2"/><path d="M3.5 19c.6-3 2.8-4.6 5.5-4.6 1.4 0 2.6.4 3.6 1.2"/><path d="M15 15h6M18.5 12.5L21 15l-2.5 2.5"/>'),
    take: I('<path d="M9 14L4 9l5-5"/><path d="M4 9h10.5a5.5 5.5 0 0 1 0 11H11"/>'),
    reply: I('<path d="M20 12a8 8 0 0 1-11.6 7.1L4 20l1-4.2A8 8 0 1 1 20 12z"/>'),
    claude: I('<path d="M12 3l1.8 5.2L19 10l-5.2 1.8L12 17l-1.8-5.2L5 10l5.2-1.8z"/><path d="M19 16l.7 1.8 1.8.7-1.8.7L19 21l-.7-1.8-1.8-.7 1.8-.7z"/>'),
  };
  const rest = all.filter((x) => x !== main).map((x) => x.replace('class="card-ok card-st alt"', 'class="card-st card-mi"').replace(/data-to="(\w+)">/, (m, to) => `data-to="${to}">${ICO[to] || ""}`));
  const other = SEVERITIES.find(([k]) => k !== c.severity);
  /* hand over (in progress: the person on it or the approver) or assign (New: the approver) */
  const handLabel = c.status === "progress" && can("hand_over", c) ? "Hand over to…" : c.status === "open" && can("assign", c) ? "Assign to…" : "";
  if (handLabel && !isQ(c)) rest.push(`<button class="card-hand card-mi">${ICO.hand}${handLabel}</button>`);
  /* A QUESTION'S BUTTONS (Nirav, 2026-10-24): Answer while it is asked (not for the asker); Got it once answered (the
     asker, or an approver); the asker adds a detail or follows up; anyone may hand it to Claude */
  if (isQ(c)) {
    const asker = isMine(c), done = c.status === "approved", answered = c.status === "approval";
    const item = (cls, ico, label) => `<button class="${cls} card-mi">${ICO[ico]}${label}</button>`;
    if (!done && (asker || isApprover()) && answered && can("resolve", c)) main = `<button class="card-ok card-resolve">Got it</button>`;
    else if (!done && !asker && !answered && can("answer", c)) main = `<button class="card-ok card-reply">Answer</button>`;
    if (asker && can("follow_up", c)) rest.push(item("card-reply", "reply", answered || done ? "Follow up" : "Add a detail"));
    else if (!asker && (answered || done) && can("answer", c)) rest.push(item("card-reply", "reply", "Add to the answer"));
    if (!done && !answered && can("resolve", c)) rest.push(item("card-resolve", "approved", "Close it"));
    if (!done) rest.push(item("card-claude", "claude", "Ask Claude"));
  }
  /* TAKE BACK (Nirav, 2026-10-24, backlog 7): whoever did it pulls it back to In progress while it waits for approval,
     no reason asked; the approver has Send back instead */
  if (c.status === "approval" && !isApprover() && can("take_back", c)) rest.unshift(`<button class="card-take card-mi">${ICO.take}Take back</button>`);
  /* in groups, a rule between them: where it goes, what it is, and Remove on its own */
  const groups = [rest.join(""), other && can("change_type", c) ? `<button class="card-type card-mi" data-k="${other[0]}">${ICO[other[0]]}Make it a ${esc(other[1].toLowerCase())}</button>` : "", canRemove(c) ? `<button class="card-rm card-mi">${ICO.remove}<span class="mi-l">Remove</span></button>` : ""].filter(Boolean);
  const items = groups.join(`<span class="card-menu-sep" role="separator"></span>`);
  return `${main}<span class="card-more-wrap"><button class="card-more" aria-label="More" aria-haspopup="menu"><svg width="14" height="14" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true"><circle cx="5" cy="12" r="1.8"/><circle cx="12" cy="12" r="1.8"/><circle cx="19" cy="12" r="1.8"/></svg></button><span class="card-menu" role="menu">${items}</span></span>`;
}
function statusActions(c) {
  const b = (to, label, alt) => `<button class="card-ok card-st${alt ? " alt" : ""}" data-to="${to}">${label}</button>`;
  if (c.status === "progress") return b("approval", "Done") + b("open", "Put back", true);
  if (c.status === "approval") return b("approved", "Approve") + b("progress", "Send back", true);
  if (c.status === "approved") return b("open", "Reopen", true);
  return b("progress", "Pick up") + b("approved", "Approve", true);
}
/* "In progress · Nirav", "For approval · Pranjal", "Approved · Nirav"; nothing while open */
/* a name with its picture before it, when the hub knows one: a 16 px circle, the name after */
function personHtml(c, name) {
  if (!name) return "";
  const url = (c.avatars && c.avatars[name]) || state.faces?.[name]; // the light list brings the pictures once, as a map
  const initial = esc(String(name).trim()[0].toUpperCase());
  return url ? `<img class="av" src="${esc(url)}" alt="" data-i="${initial}">${esc(name)}` : `<span class="av av-i">${initial}</span>${esc(name)}`;
}
/* how long ago, short: "just now", "5 min ago", "3 h ago", "yesterday", "4 days ago", then the date */
function agoText(ts) {
  if (!ts) return "";
  const m = Math.round((Date.now() - ts) / 60000);
  if (m < 1) return "just now";
  if (m < 60) return `${m} min ago`;
  const h = Math.round(m / 60);
  if (h < 24) return `${h} h ago`;
  const d = Math.round(h / 24);
  if (d === 1) return "yesterday";
  if (d < 7) return `${d} days ago`;
  return new Date(ts).toLocaleDateString(undefined, { day: "numeric", month: "short" });
}
/* who added it and when, under the comment (Nirav, 2026-10-23): their picture and name ("You" for your own), then the
   time; comments from before sign-in carry no author and show the time alone */
function byHtml(c, keepFace) {
  const when = agoText(c.ts);
  const whenHtml = when ? `<span class="by-when" title="${esc(new Date(c.ts).toLocaleString())}">${esc(when)}</span>` : "";
  if (!c.by) return whenHtml;
  const statusWho = c.status === "progress" ? c.assignee : c.status === "approval" ? c.doneBy : c.status === "approved" ? c.approvedBy : null;
  const sameFace = !keepFace && ((!!statusWho && statusWho === c.by) || (!!c.note?.text && c.note.by === c.by)); // already on the status line or the note: the name only here (the history's start keeps it)
  const mine = !!state.me && (c.by === state.me || c.by.split(/\s+/)[0] === state.me); // "Nirav Bhatt" from before the first-name list is still you
  const full = personHtml(c, c.by), named = esc(c.by);
  const person = (sameFace ? "" : full.slice(0, full.length - named.length)) + (mine ? "You" : named); // the picture (unless the status line shows it), then the name or "You"
  return `<span class="by-who${mine ? " mine" : ""}">${person}</span>${whenHtml ? `<span class="by-sep">·</span>${whenHtml}` : ""}`;
}
/* the same on the picture, at its top-left, mirroring the type marker on the right (Nirav, 2026-10-23): the face at rest,
   the name and the time unfolding under the pointer; a comment with no author shows a clock */
function byPicHtml(c) {
  const when = agoText(c.ts);
  const mine = !!c.by && !!state.me && (c.by === state.me || c.by.split(/\s+/)[0] === state.me);
  const name = c.by ? (mine ? "You" : c.by) : "";
  const url = c.by && ((c.avatars && c.avatars[c.by]) || state.faces?.[c.by]);
  const face = c.by ? (url ? `<img class="av" src="${esc(url)}" alt="" data-i="${esc(c.by.trim()[0].toUpperCase())}">` : `<span class="av av-i">${esc(c.by.trim()[0].toUpperCase())}</span>`) : `<svg class="by-clock" width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><circle cx="12" cy="12" r="9"/><path d="M12 7v5l3 2"/></svg>`;
  const words = [name, when].filter(Boolean).join(" · ");
  return `<span class="card-by-pic" title="${esc(c.ts ? new Date(c.ts).toLocaleString() : "")}">${face}<span class="lbl">${esc(words)}</span></span>`;
}
/* a card's picture: its slot shimmers until it arrives, then it fades in; one that fails leaves a calm box (Nirav,
   2026-10-25) */
root.addEventListener("load", (e) => {
  if (e.target?.classList?.contains("card-shot")) e.target.closest(".card-pic")?.classList.add("ready");
}, true);
root.addEventListener("error", (e) => {
  if (e.target?.classList?.contains("card-shot")) e.target.closest(".card-pic")?.classList.add("broken");
}, true);
/* a picture that fails to load becomes the initial (no inline handlers: a page's CSP may forbid them) */
root.addEventListener("error", (e) => {
  const img = e.target;
  /* GitHub's picture server misses now and then: try twice more (1 s, then 4 s) before settling for the initial, so a
     redraw at a slow moment does not leave letters where faces were (Nirav's "avatars turn into initials" bug) */
  if (img?.classList?.contains("av") && img.tagName === "IMG" && (Number(img.dataset.tries) || 0) < 2) {
    const tries = (Number(img.dataset.tries) || 0) + 1;
    img.dataset.tries = String(tries);
    const src = img.getAttribute("src");
    setTimeout(() => {
      if (!img.isConnected) return;
      img.src = src + (src.includes("?") ? "&" : "?") + "r=" + tries;
    }, tries === 1 ? 1000 : 4000);
    return;
  }
  if (img?.classList?.contains("av") && img.tagName === "IMG") {
    const sp = document.createElement("span");
    sp.className = "av av-i";
    sp.textContent = img.dataset.i || "?";
    img.replaceWith(sp);
  }
}, true);
/* the status as a sentence with the person's face (Nirav, 2026-10-23): "Pranjal is working on it", "You sent it for
   approval", "Approved by Nirav", "New, waiting for someone to pick it up"; the status words keep the status colour,
   the rest is in the quiet ink */
const isQ = (c) => c.severity === "question" || c.severity === "idea";
/* the shape and colour of the status line: an old question someone had picked up is asked, so New's circle */
const shownStatus = (c) => (isQ(c) && c.status === "progress" ? "open" : c.status);
/* who spoke last on a question, as shown: "Claude" when Claude answered */
const replyBy = (c) => (c.note?.kind === "reply" && c.note.via === "claude" ? "Claude" : c.note?.kind === "reply" ? c.note.by : c.doneBy);
function statusHtml(c) {
  if (isQ(c)) return qStatusHtml(c);
  const who = c.status === "progress" ? c.assignee : c.status === "approval" ? c.doneBy : c.status === "approved" ? c.approvedBy : null;
  const mine = !!who && !!state.me && (who === state.me || who.split(/\s+/)[0] === state.me);
  const face = (name) => {
    const full = personHtml(c, name), named = esc(name);
    return full.slice(0, full.length - named.length);
  };
  const k = (t) => `<b class="st-k">${esc(t)}</b>`;
  /* CLAUDE ON THE CARD (2026-10-26): work moved with Claude (npx review --claude) shows both, the person and Claude's mark */
  const claude = c.withClaude && (c.status === "progress" || c.status === "approval");
  const person = who ? `${face(who)}${claude ? '<span class="av av-claude st-claude">✦</span>' : ""}<span class="st-who">${mine ? "You" : esc(who)}${claude ? " and Claude" : ""}</span>` : "";
  const line = (h) => `<span class="st-s">${h}</span>`; // one inline run, so the spaces between the words stay
  if (c.status === "open") return line(`${k("New")}<span class="st-rest">, waiting for someone to pick it up</span>`);
  if (c.status === "progress") return who ? line(`${person}<span class="st-rest">${mine || claude ? " are" : " is"}</span> ${k("working on it")}`) : k("In progress");
  if (c.status === "approval") return who ? line(`${person}<span class="st-rest"> sent it</span> ${k("for approval")}`) : k("Waiting for approval");
  if (c.status === "approved") return who ? line(`${k("Approved")}<span class="st-rest"> by</span> ${person}`) : k("Approved");
  return "";
}
/* a question's line (Nirav, 2026-10-24): "Asked, waiting for an answer", "Zeni answered, over to you", "Resolved by
   Kishan"; an old question someone had picked up reads as asked */
function qStatusHtml(c) {
  const k = (t) => `<b class="st-k">${esc(t)}</b>`;
  const line = (h) => `<span class="st-s">${h}</span>`;
  const person = (name) => {
    if (!name) return "";
    if (name === "Claude") return `<span class="av av-claude">✦</span><span class="st-who">Claude</span>`;
    const full = personHtml(c, name), named = esc(name);
    return `${full.slice(0, full.length - named.length)}<span class="st-who">${isMe(name) ? "You" : named}</span>`;
  };
  if (c.status === "approval") {
    /* the answer's words and its writer are in the note below; the line says where it stands */
    const who = replyBy(c);
    if (c.note?.kind === "reply") return line(`${k("Answered")}${isMine(c) && !isMe(who) ? `<span class="st-rest">, over to you</span>` : ""}`);
    return line(`${who ? `${person(who)} ` : ""}${k(who ? "answered" : "Answered")}${isMine(c) && !isMe(who) ? `<span class="st-rest">, over to you</span>` : ""}`);
  }
  if (c.status === "approved") return c.approvedBy ? line(`${k("Resolved")}<span class="st-rest"> by</span> ${person(c.approvedBy)}`) : k("Resolved");
  return line(`${k("Asked")}<span class="st-rest">, waiting for an answer</span>`);
}
const hasNote = (c) => !!(c.note?.text || c.note?.kind === "hand");
function noteHtml(c) {
  if (!hasNote(c)) return "";
  /* a sentence and the words (Nirav, 2026-10-23): "Nirav sent it back", then what they said on its own line */
  const verb = c.note.from === "approved" ? "reopened it" : c.note.to === "open" ? "put it back" : "sent it back";
  const by = c.note.by;
  const mine = !!by && !!state.me && (by === state.me || by.split(/\s+/)[0] === state.me);
  /* one face per person per card (Nirav, 2026-10-23): the note shows its writer's face unless the status line already
     shows that same person */
  const statusWho = isQ(c) && c.note.kind === "reply" ? null : c.status === "progress" ? c.assignee : c.status === "approval" ? c.doneBy : c.status === "approved" ? c.approvedBy : null; // a question's line shows nobody: the face is here
  let face = "";
  if (by && by !== statusWho) {
    const full = personHtml(c, by), named = esc(by);
    face = full.slice(0, full.length - named.length);
  }
  const who = by ? `${face}<b>${mine ? "You" : esc(by)}</b> ` : "";
  if (c.note.kind === "reply") {
    /* the latest word on a question: "Zeni answered: “…”", "You followed up: “…”", "Claude answered: “…”" */
    const claude = c.note.via === "claude";
    const ask = !claude && c.note.by === c.by;
    const head = claude ? `<span class="av av-claude">✦</span><b>Claude</b> answered` : `${who}${ask ? "followed up" : "answered"}`;
    return `<span class="nt-head nt-reply" data-ask="${ask}">${head}:</span> <span class="nt-text">“${esc(c.note.text)}”</span>`;
  }
  if (c.note.kind === "hand") {
    /* "Pranjal handed it to Kishan", and the reason when there is one */
    const to = c.note.toWho;
    const toTxt = to ? (isMe(to) ? "you" : esc(to)) : "someone";
    const line = `${by ? who : ""}${by ? "handed it to" : "Handed to"} <b>${toTxt}</b>`;
    return c.note.text ? `<span class="nt-head">${line}:</span> <span class="nt-text">“${esc(c.note.text)}”</span>` : `<span class="nt-head">${line}</span>`;
  }
  const head = by ? `${who}${esc(verb)}` : esc(verb[0].toUpperCase() + verb.slice(1));
  return `<span class="nt-head">${head}:</span> <span class="nt-text">“${esc(c.note.text)}”</span>`; // one line; long words wrap under
}
/* HISTORY ON THE CARD (Nirav, 2026-10-24, backlog 6): every round, not only the last note. "History · 4" in the hover
   strip opens the comment's story above it, latest first (Nirav, 2026-10-24): each move as a sentence with its face,
   its time and the words that rode with it ("Nirav sent it back: “…”"), down to who added it. Only when there is more
   than the status line and the note already say (two moves or more). Open cards are kept in state, so a redraw leaves
   them open. The face sits in a column of its own, so the words line up under the name. */
state.histOpen = new Set();
state.histAll = new Set(); // long ones unfolded
const hasHist = (c) => Array.isArray(c.history) && c.history.length >= 2;
function histHtml(c) {
  const face = (name) => {
    if (!name) return "";
    if (name === "Claude") return `<span class="av av-claude">✦</span>`;
    const full = personHtml(c, name), named = esc(name);
    return full.slice(0, full.length - named.length);
  };
  const row = (st, by, line, at, words) =>
    `<li class="hs-step"><span class="gh-shape" data-s="${st}"></span>${by ? `<span class="hs-face">${face(by)}</span>` : ""}<span class="hs-body"><span class="hs-line">${by ? `<b>${isMe(by) ? "You" : esc(by)}</b> ` : ""}${line}</span>${words ? `<span class="hs-words">“${esc(words)}”</span>` : ""}</span><span class="hs-when"${at ? ` title="${esc(new Date(at).toLocaleString())}"` : ""}>${esc(agoText(at))}</span></li>`;
  const cap = (h, name) => (name ? h : h[0].toUpperCase() + h.slice(1)); // "Picked it up" when nobody is named
  const out = []; // who added it is the strip's own line, where the thread starts
  let was = "open";
  for (const s of c.history) {
    const from = s.from || was; // steps from before 2026-10-24 carry no "from": the one before tells
    let verb;
    if (s.kind === "hand") {
      const to = s.toWho ? (isMe(s.toWho) ? "you" : esc(s.toWho)) : "someone";
      verb = `${from === "open" ? "assigned" : "handed"} it to <b>${to}</b>`;
    } else if (s.kind === "take") verb = "took it back";
    else if (s.kind === "reply") verb = s.via !== "claude" && s.by === c.by ? "followed up" : "answered";
    else if (s.kind === "to_fix") verb = "made it a fix";
    else if (isQ(c) && s.status === "approved") verb = "marked it resolved";
    else if (s.status === "progress") verb = from === "approval" ? "sent it back" : from === "approved" ? "reopened it" : "picked it up";
    else if (s.status === "approval") verb = "sent it for approval";
    else if (s.status === "approved") verb = "approved it";
    else verb = from === "approved" ? "reopened it" : "put it back";
    const by = s.via === "claude" ? "Claude" : s.by; // Claude's answers under its own mark
    out.push(row(s.status, by, cap(verb, by) + (s.via === "claude" && s.kind !== "reply" ? ", with Claude" : ""), s.at, s.note));
    was = s.status;
  }
  /* in order, down from the author's face (Nirav, 2026-10-24); a long story folds: "Show 90 earlier", then the latest five */
  /* the fold on the thread itself: chevrons apart to show, chevrons together to hide again (Nirav, 2026-10-24) */
  if (out.length > 6) {
    const hidden = out.length - 5, all = state.histAll.has(c.id);
    const ic = all ? '<path d="M7 20l5-5 5 5"/><path d="M7 4l5 5 5-5"/>' : '<path d="M7 15l5 5 5-5"/><path d="M7 9l5-5 5 5"/>';
    const fold = `<li class="hs-step hs-fold"><button type="button" class="hs-more" aria-expanded="${all}"><span class="hs-fold-ic" aria-hidden="true"><svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round">${ic}</svg></span>${all ? "Hide" : "Show"} ${hidden} earlier</button></li>`;
    if (all) out.unshift(fold);
    else out.splice(0, hidden, fold);
  }
  return `<ol class="hs-list">${out.join("")}</ol>`;
}
/* the author line in the hover strip is the history's button (Nirav, 2026-10-24: one thing, not two): "Pranjal · 2 h
   ago" as before; under the pointer (and while open) the face turns into a history mark, a click opens it. Without a
   history it stays plain words */
function byLineHtml(c) {
  if (!hasHist(c)) return `<span class="cm-by">${byHtml(c)}</span>`;
  const open = state.histOpen.has(c.id);
  return `<button type="button" class="cm-by cm-hist${c.by ? "" : " no-face"}" aria-expanded="${open}" title="${open ? "Hide the history" : `History, ${c.history.length} steps`}"><span class="cm-hico" aria-hidden="true"><svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><path d="M3 12a9 9 0 1 0 3-6.7L3 8"/><path d="M3 3v5h5"/><path d="M12 7v5l3 2"/></svg></span>${byHtml(c, true)}<span class="cm-steps"><span class="by-sep">·</span>${c.history.length} ${c.history.length === 1 ? "step" : "steps"}</span></button>`;
}
/* the history block and its button, matched to the comment (after a redraw or a move) */
function histSync(card, c) {
  const open = hasHist(c) && state.histOpen.has(c.id);
  if (!open) setTimeout(roomBack, 0);
  card.classList.toggle("hist-open", open);
  const by = card.querySelector(".cm-by");
  if (by) by.outerHTML = byLineHtml(c);
  let box = card.querySelector(".card-hist");
  if (open) {
    if (!box) {
      box = document.createElement("div");
      box.className = "card-hist";
      card.querySelector(".card-meta-in")?.appendChild(box); // inside the hover strip, under its line (Nirav, 2026-10-24)
    }
    box.innerHTML = histHtml(c);
  } else box?.remove();
}
function statusLine(c) {
  if (c.status === "progress") return `${STATUS.progress}${c.assignee ? ` · ${c.assignee}` : ""}`;
  if (c.status === "approval") return `${STATUS.approval}${c.doneBy ? ` · ${c.doneBy}` : ""}`;
  if (c.status === "approved") return `${STATUS.approved}${c.approvedBy ? ` · ${c.approvedBy}` : ""}`;
  return "";
}
const statusToast = { progress: "picked up", approval: "done, for approval", approved: "approved", open: "reopened" };
const backToast = { progress: "sent back", open: "put back" };
/* "Sent back · Nirav: the hover colour is still the old one"; the reason a comment came back, under the foot */
function noteLine(c) {
  if (c.note?.kind === "hand") return `Handed to ${c.note.toWho || "someone"}${c.note.by ? ` by ${c.note.by}` : ""}${c.note.text ? `: ${c.note.text}` : ""}`;
  if (!c.note?.text) return "";
  const what = c.note.from === "approved" ? "Reopened" : c.note.to === "open" ? "Put back" : "Sent back";
  return `${what}${c.note.by ? ` · ${c.note.by}` : ""}: ${c.note.text}`;
}
/* a move back (Send back, Put back, Reopen) asks why, in the card's foot: one line, Enter sends, Esc keeps the comment
   where it is. The box is state (state.asking), so a redraw of the list puts it back with the words typed so far;
   it closes on Esc, on a click outside the card, or when sent. The reason travels with the status. */
state.asking = null; // { id, to, label, text, focused }
function askNote(card, c, to, label) {
  if (state.asking?.id === c.id) return;
  state.asking = { id: c.id, to, label, text: "", focused: true };
  mountAsk(card, c);
}
/* the box grows out of the button that opened it (the foot's right end) and folds back into it when sent or let go
   (Nirav, 2026-10-24); the foot's own line fades back in after it */
const BOX_EASE = { duration: 220, easing: "cubic-bezier(.32,.72,0,1)" };
function boxFrom(box) {
  const go = box.querySelector(".note-go");
  return `inset(0 0 0 ${Math.max(0, box.offsetWidth - (go?.offsetWidth || 60) - 6)}px round 7px)`;
}
function openBox(box) {
  if (!box?.animate) return;
  box.animate([{ clipPath: boxFrom(box), opacity: 0.4 }, { clipPath: "inset(0 0 0 0 round 7px)", opacity: 1 }], BOX_EASE);
}
function closeBox(foot, then) {
  const box = foot?.querySelector(".note-box");
  const back = () => {
    then();
    foot?.animate?.([{ opacity: 0 }, { opacity: 1 }], { duration: 160, easing: "ease-out" });
  };
  if (!box?.animate) return back();
  const a = box.animate([{ clipPath: "inset(0 0 0 0 round 7px)", opacity: 1 }, { clipPath: boxFrom(box), opacity: 0 }], { ...BOX_EASE, duration: 180, fill: "forwards" });
  a.onfinish = back;
}
function cancelAsk() {
  const a = state.asking;
  if (!a) return;
  state.asking = null;
  const card = panelBody.querySelector(`.card[data-id="${a.id}"]`);
  const c = state.comments.find((x) => x.id === a.id) || state.done.find((x) => x.id === a.id);
  if (card && c) {
    const foot = card.querySelector(".card-foot");
    closeBox(foot, () => {
      if (!state.asking || state.asking.id !== a.id) foot.innerHTML = footHtml(c);
    });
  }
  if (state.stale && !panelBusy()) {
    state.stale = false;
    renderPanel(); // what arrived while the box was open
  }
}
function mountAsk(card, c) {
  const a = state.asking;
  const foot = card.querySelector(".card-foot");
  if (!a || !foot) return;
  foot.innerHTML = `<span class="note-box"><input class="note-in" type="text" maxlength="${a.reply ? 1200 : 600}" placeholder="${a.reply ? esc(a.ph) : a.assignTo ? `A note for ${esc(isMe(a.toName) ? "yourself" : a.toName)}? (optional) Enter hands it over` : "Why? Enter sends it, Esc keeps it here"}"><button class="note-go">${a.label}</button></span>`;
  const input = foot.querySelector(".note-in");
  const btn = foot.querySelector(".note-go");
  if (!a.shown) openBox(foot.querySelector(".note-box")); // only the first time: a redraw puts it back still
  a.shown = true;
  input.value = a.text;
  input.addEventListener("input", () => (a.text = input.value));
  const go = async () => {
    if (state.asking !== a) return;
    const note = input.value.trim();
    if (a.reply && !note) return input.focus(); // an answer needs words
    input.disabled = true;
    btn.classList.add("loading");
    const r = await api("update", a.reply ? { id: c.id, reply: note } : a.assignTo ? { id: c.id, assignTo: a.assignTo, note } : { id: c.id, status: a.to, note }).catch(() => null);
    if (state.asking === a) state.asking = null;
    if (!r?.entry) {
      input.disabled = false;
      btn.classList.remove("loading");
      state.asking = a;
      toast(`Could not save that: ${r?.error || "the hub did not answer"}`);
      return;
    }
    const crossed = applyEntry(r.entry);
    if (crossed) renderPanel();
    else
      closeBox(foot, () => {
        foot.innerHTML = footHtml(r.entry);
        settle(card, r.entry);
      });
    if (a.reply) return toast(`#${c.n} ${isMine(c) ? "followed up" : "answered"}`);
    toast(a.assignTo ? `#${c.n} handed to ${isMe(a.toName) ? "you" : a.toName}` : `#${c.n} ${a.to === "open" && c.status === "approved" ? "reopened" : backToast[a.to]}${note ? " with a note" : ""}`);
  };
  input.addEventListener("keydown", (e) => {
    e.stopPropagation();
    if (e.key === "Enter") go();
    if (e.key === "Escape") cancelAsk();
  });
  btn.addEventListener("click", (e) => {
    e.stopPropagation();
    go();
  });
  if (a.focused) input.focus({ preventScroll: true });
}
/* a click outside the card with the box closes it */
window.addEventListener("pointerdown", (e) => {
  if (!state.asking) return;
  const card = panelBody.querySelector(`.card[data-id="${state.asking.id}"]`);
  if (card && !e.composedPath().includes(card)) cancelAsk();
}, true);
const esc = (t) => String(t ?? "").replace(/[&<>"]/g, (ch) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[ch]);
/* the foot's normal content: where, the status chip, the actions */
function footHtml(c) {
  return `<span class="where">${esc(`${c.pageTitle || c.route} · ${c.context || "Page"}${c.shot ? "" : " · no picture"}`)}</span><span class="card-status" data-s="${shownStatus(c)}">${statusHtml(c)}</span>${c.pending ? (c.failed ? `<span class="acts on"><button class="card-ok card-retry">Retry</button><button class="card-rm card-drop">Drop</button></span>` : `<span class="card-sending">Saving…</span>`) : `<span class="acts">${actsHtml(c)}</span>`}`;
}
/* the note under the foot, added, changed or removed to match the comment */
function settle(card, c) {
  let note = card.querySelector(".card-note");
  if (hasNote(c)) {
    if (!note) {
      note = document.createElement("div");
      note.className = "card-note";
      card.insertBefore(note, card.querySelector(".card-meta")); // above the hover strip
    }
    note.innerHTML = noteHtml(c);
  } else note?.remove();
  histSync(card, c);
}
function renderPanel() {
  if (!panel.classList.contains("on")) return;
  if (renderPanel.skipWhileMenu && $(".scope-menu")) return; // a background refresh never rebuilds an open menu
  if (state.asking) state.asking.focused = !!root.activeElement?.classList?.contains("note-in"); // before the rebuild takes it
  const scrollWas = panelBody.scrollTop;
  const focusWas = root.activeElement?.classList?.contains("card") ? root.activeElement.dataset.id : null;
  const view = PAGE_MODE ? window.__reviewView || "open" : "open";
  for (const b of $(".panel-view").querySelectorAll("button")) {
    b.setAttribute("aria-pressed", b.dataset.v === view ? "true" : "false");
    b.querySelector("b").textContent = b.dataset.v === "open" ? state.comments.length : state.doneCount ?? state.done.length;
  }
  const pool = view === "resolved" ? state.done : state.comments;
  /* the status filter (Nirav, 2026-10-23), in the place and the look of the old tag pill: All, New, In progress, For
     approval, Approved, each a coloured dot and its count, one picked at a time; the counts follow the scope */
  {
    const inScopeT = (c) => { const s2 = scopeNow(); const r = (c.route || "").split("?")[0]; const g = (c.module && c.module.group) || moduleOf(c.route).group || "Other"; return s2.kind === "route" ? r === s2.route : s2.kind === "group" ? g === s2.group : true; };
    const live = state.comments.filter(inScopeT), done = state.done.filter(inScopeT);
    const cnt = (k) => live.filter((c) => c.status === k).length;
    const ST = { open: ["open", "New", cnt("open")], progress: ["progress", "In progress", cnt("progress")], approval: ["approval", pool.some((c) => isQ(c) && c.status === "approval") ? "For approval or answered" : "For approval", cnt("approval")] };
    const approver = state.persona === "approver";
    const TABS = [["all", "All", live.length], ...(approver ? [ST.approval, ST.progress, ST.open] : [ST.open, ST.progress, ST.approval])];
    const quietK = approver ? "open" : "approval"; // the one this person rarely needs: last, and quieter
    const filt = $(".panel-filter");
    filt.innerHTML = "";
    const pillS = document.createElement("div");
    pillS.className = "scope-switch tag-switch status-switch";
    pillS.setAttribute("role", "group");
    pillS.setAttribute("aria-label", "Status");
    for (const [k, label, n] of TABS) {
      const t = document.createElement("button");
      t.type = "button";
      t.className = "side tag";
      t.dataset.s = k;
      const sel = state.status || new Set();
      t.setAttribute("aria-pressed", String(k === "all" ? !sel.size : sel.has(k)));
      if (k === quietK) t.classList.add("quiet");
      t.setAttribute("aria-label", `${label} · ${n}`);
      t.innerHTML = `<span class="dot"></span><b>${n}</b><span class="scope-tip"></span>`;
      t.querySelector(".scope-tip").textContent = k === "all" ? `Everything not yet approved · ${n}` : `${label} · ${n}`;
      t.addEventListener("click", () => {
        /* several at once: a click adds or drops one; All clears them; the choice is remembered for this person */
        const set = new Set(state.status || []);
        if (k === "all") set.clear();
        else if (set.has(k)) set.delete(k);
        else set.add(k);
        state.status = set;
        try { localStorage.setItem(`review.statuses.${state.persona}`, JSON.stringify([...set])); } catch {}
        panelBody.scrollTop = 0;
        renderPanel();
      });
      pillS.appendChild(t);
    }
    if (view === "open") {
      /* how the list is grouped (Nirav, 2026-10-23): None, Status, Person, folded to the picked one like the theme
         switch; the other two slide out under the pointer */
      const GI = {
        none: '<path d="M8 6h12M8 12h12M8 18h12"/><circle cx="4" cy="6" r="1" fill="currentColor"/><circle cx="4" cy="12" r="1" fill="currentColor"/><circle cx="4" cy="18" r="1" fill="currentColor"/>',
        status: '<rect x="3" y="4" width="18" height="6" rx="2"/><rect x="3" y="14" width="18" height="6" rx="2"/>',
        person: '<circle cx="12" cy="8" r="3.5"/><path d="M5 20c.8-3.6 3.6-5.5 7-5.5s6.2 1.9 7 5.5"/>',
      };
      const GL = { none: "No groups", status: "Group by status", person: "Group by person" };
      /* one pill (Nirav, 2026-10-23): the group choice is its first part, a thin rule, then the statuses */
      const gs = document.createElement("span");
      gs.className = "group-switch";
      gs.setAttribute("role", "group");
      gs.setAttribute("aria-label", "Group the list");
      for (const k of ["none", "status", "person"]) {
        const gb = document.createElement("button");
        gb.type = "button";
        gb.className = "side";
        gb.dataset.g = k;
        gb.setAttribute("aria-pressed", String((state.groupBy || "none") === k));
        gb.setAttribute("aria-label", GL[k]);
        gb.innerHTML = `<svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${GI[k]}</svg><span class="scope-tip">${GL[k]}</span>`;
        gb.addEventListener("click", () => {
          if ((state.groupBy || "none") === k) return;
          state.groupBy = k;
          try { localStorage.setItem(`review.group.${state.persona}`, k); } catch {}
          panelBody.scrollTop = 0;
          renderPanel();
        });
        gs.appendChild(gb);
      }
      const rule = document.createElement("span");
      rule.className = "gs-rule";
      pillS.prepend(gs, rule);
      filt.appendChild(pillS);
    }
  }
  const here = location.pathname;
  const groupOf = (c) => (c.module && c.module.group) || moduleOf(c.route).group || "Other";
  const routeOf = (c) => (c.route || "").split("?")[0];
  const sc = scopeNow();
  const inScope = (c) => (sc.kind === "route" ? routeOf(c) === sc.route : sc.kind === "group" ? groupOf(c) === sc.group : true);
  const scoped = pool.filter(inScope);
  /* the scope: everywhere, a module picked from a list of every group and page that has comments, this page */
  const tree = new Map(); // group -> Map(route -> { title, n })
  for (const c of pool) {
    const g = groupOf(c);
    if (!tree.has(g)) tree.set(g, new Map());
    const pages = tree.get(g);
    const r = routeOf(c);
    if (!pages.has(r)) pages.set(r, { title: c.pageTitle || r, n: 0 });
    pages.get(r).n++;
  }
  const scopeEl = $(".panel-scope");
  const wasOpen = !!scopeEl.querySelector(".scope-menu");
  scopeEl.innerHTML = "";
  const closeMenu = () => {
    scopeEl.querySelector(".scope-menu")?.remove();
    scopeEl.querySelector("[aria-haspopup]")?.setAttribute("aria-expanded", "false");
    if (scopeAway) window.removeEventListener("pointerdown", scopeAway, true);
    scopeAway = null;
  };
  const pick = (scope) => {
    state.scope = scope;
    closeMenu();
    renderPanel();
  };
  const svg = (path) => `<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">${path}</svg>`;
  const LAYERS = '<path d="M12 3l9 5-9 5-9-5 9-5z"/><path d="M3 13l9 5 9-5"/>';
  const PAGE = '<rect x="3" y="4" width="18" height="16" rx="2"/><path d="M3 9h18"/>';
  const pill = document.createElement("div");
  pill.className = "scope-switch";
  pill.setAttribute("role", "group");
  /* icons on the pill (variant c's sides on variant a's pill), a compressed tip on hover */
  const GLOBE = '<circle cx="12" cy="12" r="9"/><path d="M3 12h18M12 3a15 15 0 0 1 0 18M12 3a15 15 0 0 0 0 18"/>';
  const word = (icon, tip, pressed, onClick) => {
    const b = document.createElement("button");
    b.type = "button";
    b.className = "side";
    b.innerHTML = svg(icon) + `<span class="scope-tip"></span>`;
    b.querySelector(".scope-tip").textContent = tip;
    b.setAttribute("aria-label", tip);
    b.setAttribute("aria-pressed", pressed ? "true" : "false");
    b.addEventListener("click", onClick);
    pill.appendChild(b);
    return b;
  };
  word(GLOBE, `Everywhere · ${pool.length}`, sc.kind === "all", () => pick({ kind: "all" }));
  word(PAGE, sc.kind === "all" ? (PAGE_MODE ? "A place" : `This page · ${pool.filter((c) => routeOf(c) === here).length}`) : "A place", sc.kind !== "all", () => {
    if (sc.kind !== "all") return;
    if (PAGE_MODE) {
      /* no "this page" here: open the list of places instead */
      const first = [...tree.entries()][0];
      if (first) pick({ kind: "group", group: first[0] });
      return;
    }
    pick({ kind: "here" });
  });
  scopeEl.appendChild(pill);
  let crumb = null;
  if (sc.kind !== "all") {
    crumb = document.createElement("button");
    crumb.type = "button";
    crumb.className = "scope-crumb";
    crumb.setAttribute("aria-haspopup", "listbox");
    crumb.setAttribute("aria-expanded", "false");
    const label = sc.kind === "group" ? sc.group : sc.here || (sc.route === here && !PAGE_MODE) ? "This page" : sc.title;
    crumb.innerHTML = `<span class="lbl"></span><b>${scoped.length}</b><svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M7 15l5 5 5-5M7 9l5-5 5 5"/></svg>`;
    crumb.querySelector(".lbl").textContent = label;
    const sep = document.createElement("span");
    sep.className = "scope-sep";
    sep.innerHTML = '<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M9 18l6-6-6-6"/></svg>';
    scopeEl.appendChild(sep);
    scopeEl.appendChild(crumb);
  }
  let openT, closeT;
  const openMenu = () => {
    if (scopeEl.querySelector(".scope-menu")) return;
    const m = document.createElement("div");
    m.className = "scope-menu";
    m.setAttribute("role", "listbox");
    const item = (cls, html, on, onPick) => {
      const d = document.createElement("div");
      d.className = `scope-item ${cls}` + (on ? " on" : "");
      d.setAttribute("role", "option");
      d.tabIndex = -1;
      d.innerHTML = html;
      d.addEventListener("click", onPick);
      m.appendChild(d);
      return d;
    };
    const ico = (path) => `<span class="mark"><svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">${path}</svg></span>`;
    const hereN = pool.filter((c) => routeOf(c) === here).length;
    if (!PAGE_MODE) item("scope-view", `<span class="lead">${ico('<rect x="3" y="4" width="18" height="16" rx="2"/><path d="M3 9h18"/>')}<span class="lines"><span>This page</span><span class="sub"></span></span></span><b>${hereN}</b>`, sc.kind === "route" && sc.route === here, () => pick({ kind: "here" })).querySelector(".sub").textContent = pageTitle();
    if (tree.size && !PAGE_MODE) {
      const rule = document.createElement("div");
      rule.className = "scope-rule";
      m.appendChild(rule);
    }
    for (const [g, pages] of [...tree.entries()].sort((x, y) => x[0].localeCompare(y[0]))) {
      const gn = [...pages.values()].reduce((a, p) => a + p.n, 0);
      item("scope-group", `<span></span><b>${gn}</b>`, sc.kind === "group" && sc.group === g, () => pick({ kind: "group", group: g })).querySelector("span").textContent = g;
      for (const [r, p] of [...pages.entries()].sort((x, y) => x[1].title.localeCompare(y[1].title)))
        item("scope-page", `<span></span><b>${p.n}</b>`, sc.kind === "route" && sc.route === r, () => pick({ kind: "route", route: r, title: p.title })).querySelector("span").textContent = p.title;
    }
    /* keyboard: arrows walk the rows, Enter picks, Esc closes */
    m.addEventListener("keydown", (e) => {
      const rows = Array.from(m.querySelectorAll(".scope-item"));
      const i = rows.indexOf(m.shadowRoot?.activeElement || root.activeElement);
      if (e.key === "ArrowDown" || e.key === "ArrowUp") {
        e.preventDefault();
        rows[Math.max(0, Math.min(rows.length - 1, i + (e.key === "ArrowDown" ? 1 : -1)))]?.focus();
      } else if (e.key === "Home" || e.key === "End") {
        e.preventDefault();
        rows[e.key === "Home" ? 0 : rows.length - 1]?.focus();
      } else if (e.key === "Enter" || e.key === " ") {
        e.preventDefault();
        (root.activeElement?.classList.contains("scope-item") ? root.activeElement : rows[0])?.click();
      } else if (e.key === "Escape") {
        e.stopPropagation();
        closeMenu();
        crumb.focus();
      }
    });
    m.addEventListener("mouseenter", () => clearTimeout(closeT));
    m.addEventListener("mouseleave", () => (closeT = setTimeout(closeMenu, 180)));
    scopeEl.appendChild(m);
    crumb?.setAttribute("aria-expanded", "true");
    /* one outside-click listener at a time: a stale one from an earlier copy of the menu would close this one */
    if (scopeAway) window.removeEventListener("pointerdown", scopeAway, true);
    scopeAway = (ev) => {
      if (!ev.composedPath().includes(m) && !(crumb && ev.composedPath().includes(crumb))) closeMenu();
    };
    setTimeout(() => scopeAway && window.addEventListener("pointerdown", scopeAway, true), 0);
  };
  if (crumb) {
  crumb.addEventListener("mouseenter", () => {
    clearTimeout(closeT);
    openT = setTimeout(openMenu, 120);
  });
  crumb.addEventListener("mouseleave", () => {
    clearTimeout(openT);
    closeT = setTimeout(closeMenu, 180);
  });
  crumb.addEventListener("click", () => (scopeEl.querySelector(".scope-menu") ? closeMenu() : openMenu()));
  crumb.addEventListener("keydown", (e) => {
    if (e.key === "ArrowDown" || e.key === "Enter" || e.key === " ") {
      e.preventDefault();
      openMenu();
      scopeEl.querySelector(".scope-item.on, .scope-item")?.focus();
    }
  });
  }
  if (wasOpen && crumb) openMenu();
  /* no tag filter any more (Nirav, 2026-10-23: the status is what people sort by); the tag still shows on each card */
  state.filter.clear();
  const sel = state.status || new Set();
  const inTab = view === "resolved" ? scoped : scoped.filter((c) => !sel.size || sel.has(c.status));
  /* the type pill in the list's toolbar: All, Fix, Question, with their counts in the current status and scope */
  {
    const tp = tools.querySelector(".type-pick");
    tp.innerHTML = "";
    const n = { all: inTab.length, fix: inTab.filter((c) => c.severity === "fix").length, question: inTab.filter((c) => c.severity === "question").length };
    if (state.type !== "all" && !n[state.type]) state.type = "all";
    /* not a switch (Nirav, 2026-10-23): two quiet words with their dots at the end of the search field; a click shows
       only that type, a second click shows both again */
    for (const [k, label] of SEVERITIES) {
      const b = document.createElement("button");
      b.type = "button";
      b.className = "tp";
      b.dataset.k = k;
      b.setAttribute("aria-pressed", String(state.type === k));
      /* icons, not coloured dots (Nirav, 2026-10-23): red already means For approval up top; the picked one takes its colour */
      const ICON = { fix: '<path d="M14.7 6.3a4 4 0 0 0-5.4 5.4L3.5 17.5a1.8 1.8 0 0 0 2.5 2.5l5.8-5.8a4 4 0 0 0 5.4-5.4l-2.5 2.5-2.1-.4-.4-2.1z"/>', question: '<circle cx="12" cy="12" r="9"/><path d="M9.6 9.3a2.5 2.5 0 0 1 4.8.9c0 1.7-2.4 2.2-2.4 3.6"/><path d="M12 17h.01"/>' };
      b.innerHTML = `<span class="w"></span><b>${n[k]}</b>`; // words only (Nirav, 2026-10-23); ICON kept for a later try
      b.querySelector(".w").textContent = label;
      b.setAttribute("aria-label", state.type === k ? `Showing ${label.toLowerCase()} only, click to show all` : `Only ${label.toLowerCase()}`); // no native title: the hover state says it
      if (!n[k]) b.disabled = true;
      b.addEventListener("click", (e) => {
        e.preventDefault();
        state.type = state.type === k ? "all" : k;
        renderPanel();
      });
      tp.appendChild(b);
    }
  }
  clearBody();
  if (isWaiting()) {
    panelBody.insertAdjacentHTML("beforeend", waitScreenHtml());
    return;
  }
  /* LOADING (Nirav, 2026-10-25): until the first answer, three placeholder cards shimmer; if the hub does not answer,
     a friendly face says so */
  if (!state.loaded) {
    panelBody.insertAdjacentHTML("beforeend", state.loadError ? emptyHtml("error") : skeletonHtml());
    return;
  }
  /* the Approved view asks for its list the first time it opens, placeholders meanwhile */
  if (view === "resolved" && !state.doneLoaded) {
    if (!state.doneAsked) {
      state.doneAsked = true;
      loadDone().finally(() => {
        state.doneLoaded = true;
        renderPanel();
      });
    }
    panelBody.insertAdjacentHTML("beforeend", skeletonHtml());
    return;
  }
  if (isApprover() && state.joiners.length && view === "open") panelBody.insertAdjacentHTML("beforeend", joinHtml());
  const shown = inTab.filter((c) => (state.type === "all" || c.severity === state.type) && matchesQ(c, state.q));
  if (!shown.length) {
    /* FRIENDLY EMPTY STATES (Nirav, 2026-10-25): a face, a title and a kind line for every empty view */
    const one = sel.size === 1 ? [...sel][0] : null;
    const kind = state.q ? "search" : state.type !== "all" ? "type" : !pool.length ? (view === "resolved" ? "resolved" : state.doneCount ? "allDone" : "none") : scoped.length && one ? `st-${one}` : scoped.length && sel.size ? "statuses" : "page";
    panelBody.insertAdjacentHTML("beforeend", emptyHtml(kind));
    if (view === "open" && !sel.size && state.doneCount) panelBody.appendChild(endLine());
    return;
  }
  /* GROUPS (Nirav, 2026-10-23): the list grouped by status, person, page or type, or not at all (the Group capsule in
     the bottom bar; the approver starts on status, the team on none). Status puts what waits for approval first and
     splits In progress by the person on it. Each heading folds its group away and back; folds are remembered. */
  let list = shown, heads = new Map();
  const groupBy = view === "open" && ["status", "person"].includes(state.groupBy) ? state.groupBy : "none";
  if (groupBy !== "none" && shown.length) {
    const SHAPE = (k) => `<span class="gh-shape" data-s="${k}"></span>`;
    const face = (c, who) => { const full = personHtml(c, who), named = esc(who); return full.slice(0, full.length - named.length); };
    const isMe = (who) => !!state.me && !!who && (who === state.me || who.split(/\s+/)[0] === state.me);
    const groups = []; // { key, label, items }
    const add = (key, label, items) => items.length && groups.push({ key, label, items });
    if (groupBy === "status") {
      /* a question reads in its own words (Nirav, 2026-10-24): asked ones sit with New, answered ones in their own
         group, never under For approval (they wait for the asker, not the approver) */
      const key = (c) => (isQ(c) ? (c.status === "approval" ? "answered" : c.status === "approved" ? "approved" : "open") : c.status);
      const by = (k) => shown.filter((c) => key(c) === k);
      const order = state.persona === "approver" ? ["approval", "progress", "open", "answered"] : ["open", "progress", "answered", "approval"];
      for (const k of order) {
        const cs = by(k);
        if (k === "answered") {
          add("answered", `${SHAPE("approval")}Answered · ${cs.length}`, cs);
          continue;
        }
        if (k === "progress") {
          const ppl = new Map();
          for (const c of cs) { const w = c.assignee || "Someone"; if (!ppl.has(w)) ppl.set(w, []); ppl.get(w).push(c); }
          for (const [w, xs] of ppl) add(`progress:${w}`, `${SHAPE("progress")}${face(xs[0], w)}${isMe(w) ? "You" : esc(w)} · working on ${xs.length}`, xs);
        } else add(k, `${SHAPE(k)}${k === "approval" ? (state.persona === "approver" ? "Waiting for you" : "For approval") : "New"} · ${cs.length}`, cs);
      }
    } else if (groupBy === "person") {
      const ppl = new Map();
      for (const c of shown) {
        const w = c.status === "progress" ? c.assignee : c.status === "approval" ? c.doneBy : null;
        const k = w || "";
        if (!ppl.has(k)) ppl.set(k, []);
        ppl.get(k).push(c);
      }
      for (const [w, xs] of [...ppl].sort((x, y) => (x[0] === "" ? 1 : y[0] === "" ? -1 : x[0].localeCompare(y[0]))))
        add(`person:${w}`, w ? `${face(xs[0], w)}${isMe(w) ? "You" : esc(w)} · ${xs.length}` : `Not picked up · ${xs.length}`, xs);
    }
    list = [];
    for (const g of groups) {
      heads.set(g.items[0].id, g);
      list.push(...g.items);
    }
  }
  const folded = state.folded || new Set();
  let foldedNow = false;
  let into = panelBody; // each group in its own section, so its heading stays pinned while its cards scroll by
  /* IN BATCHES (Nirav, 2026-10-25): the first 40 cards are built, more as the list nears its end; the cards of the page
     you are on are always in the first batch (up to 150), and so is a card a pin just opened. Counts, filters, copying
     and select-all use the whole list. */
  state.shownList = list;
  const lastHere = list.reduce((m, c, i) => ((c.route || "").split("?")[0] === here ? i : m), -1);
  const spotAt = state.spot ? list.findIndex((c) => c.id === state.spot.id) : -1;
  const limit = Math.min(list.length, Math.max(state.renderLimit || 40, Math.min(lastHere + 1, 150), spotAt + 1));
  let cut = false;
  for (const [i, c] of list.entries()) {
    if (i >= limit) {
      cut = true;
      break;
    }
    if (heads.has(c.id)) {
      const g = heads.get(c.id);
      foldedNow = folded.has(g.key);
      into = document.createElement("section");
      into.className = "list-sec";
      panelBody.appendChild(into);
      into.insertAdjacentHTML("beforeend", `<button type="button" class="list-group${foldedNow ? " folded" : ""}" data-g="${esc(g.key)}" aria-expanded="${!foldedNow}">${g.label}<svg class="lg-chev" width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.6" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M6 9l6 6 6-6"/></svg></button>`);
    }
    if (foldedNow) continue;
    /* THE CARD (Nirav, 2026-10-19, picked from seven trials): a soft fill, no border; the number outside in the
       left gutter; the note first, 500, tight; the tag riding on the picture's top-right; a corner accent in the
       tag's colour on the top-right for Must fix and Should fix only; the foot: where it was, and Remove */
    const onPage = (c.route || "").split("?")[0] === here;
    const card = document.createElement("div");
    card.className = "card card-c card-fill card-medium" + (onPage ? " here" : "") + (c.resolved ? " resolved" : "") + (state.selected.has(c.id) ? " picked" : "") + (c.pending ? (c.failed ? " failed" : " sending") : "") + (state.unread.has(c.id) ? " unread" : "");
    if (c.severity === "question") { // the corner mark on questions only: most comments are fixes
      card.classList.add("card-rail", "card-rail-right");
      card.dataset.k = c.severity;
    }
    card.dataset.id = c.id;
    card.tabIndex = 0; // the keyboard walks the cards (↑ ↓, Space selects)
    const sevLabel = SEVERITIES.find(([k]) => k === c.severity)?.[1] || c.severity;
    card.innerHTML = `
      <div class="card-line"><span class="card-n out${onPage ? "" : " away"}" title="Show it on the page">${c.n}</span><div class="card-text${canEdit(c) ? "" : " ro"}"${canEdit(c) ? ' title="Click to edit"' : ""}></div></div>
      ${"" /* TRY 2026-10-23 (hover strip): was c.shot ? "" : the card-by line */}
      <button class="card-pick" aria-label="Select for copying" aria-pressed="${state.selected.has(c.id)}"><svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="3" stroke-linecap="round" stroke-linejoin="round"><path d="M5 12l5 5L20 7"/></svg></button>
      ${c.shot ? `<div class="card-pic"${c.viewport?.w && c.viewport?.h ? ` style="--ar:${c.viewport.w} / ${c.viewport.h}"` : ""}><img class="card-shot" data-id="${c.id}" ${onPage ? "src" : "data-src"}="${thumbUrl(c)}" alt=""></div>` /* TRY 2026-10-23: byPicHtml(c) was here */ : ""}
      <div class="card-foot">${footHtml(c)}</div>${hasNote(c) ? `<div class="card-note"></div>` : ""}
      <div class="card-meta"><div class="card-meta-in"><span class="cm-by">${byHtml(c)}</span><span class="cm-where"></span></div></div>`;
    card.querySelector(".card-text").textContent = c.text;
    /* quiet on the right (Nirav, 2026-10-24): the kind and the page only; the place on the page and "no picture" in the
       tooltip */
    const where = card.querySelector(".cm-where");
    where.innerHTML = `<b class="cm-type" data-k="${c.severity}">${esc(sevLabel)}</b> · <span class="cm-place" data-tip="${esc(`${c.context || "Page"}${c.shot ? "" : " · no picture"}`)}">${esc(c.pageTitle || c.route)}</span>`;
    if (hasNote(c)) card.querySelector(".card-note").innerHTML = noteHtml(c);
    histSync(card, c);
    if (c.shot && c.rect) card.querySelector(".card-pic").appendChild(liveBadge(c, card.querySelector(".card-shot")));
    into.appendChild(card);
    if (state.asking?.id === c.id) mountAsk(card, c); // the note box back, once the card is on the page
  }
  if (cut) {
    /* the next batch's placeholder: when it comes near, the next 40 are built */
    into.insertAdjacentHTML("beforeend", `<div class="list-more">${skeletonHtml().split("</div>")[0]}</div></div>`);
    moreSeen.observe(into.lastElementChild);
  }
  if (!cut && view === "open" && (!sel.size || state.persona === "approver") && state.doneCount) panelBody.appendChild(endLine());
  if (!cut && PAGE_MODE && state.hub?.on) panelBody.appendChild(hubLine());
  for (const img of panelBody.querySelectorAll("img.card-shot[data-src]")) picSeen.observe(img);
  if (scrollWas) panelBody.scrollTop = scrollWas; // a redraw is not a reason to move
  /* a spacer at the very end that gives back exactly what a card's hover strip takes, so the list's height never
     changes on hover; at the bottom of the list the scroll then has nothing to jump for (the last card shook) */
  panelBody.insertAdjacentHTML("beforeend", `<div class="list-spacer" aria-hidden="true"></div>`);
  for (const id of state.histOpen) {
    const open = panelBody.querySelector(`.card[data-id="${id}"]`);
    if (open) roomFor(open, true); // a redraw keeps an open history's room
  }
  renderPickPill();
  if (focusWas) panelBody.querySelector(`.card[data-id="${focusWas}"]`)?.focus({ preventScroll: true });
  markPinned();
  watchUnread();
  backfillThumbs();
  /* opened from a pin: that card scrolled into view once and ringed for a moment (a refresh keeps the ring) */
  if (state.spot && performance.now() < state.spot.until) {
    const card = panelBody.querySelector(`.card[data-id="${state.spot.id}"]`);
    if (card) {
      card.classList.add("spot");
      /* centred on every render in that moment (the list is rebuilt once the comments reload), and again as the
         pictures above it load and push it down; the user's own scroll ends it */
      const spot = state.spot;
      card.scrollIntoView({ block: "center" });
      for (const img of panelBody.querySelectorAll(".card-shot"))
        if (!img.complete)
          img.addEventListener("load", () => {
            if (state.spot === spot && performance.now() < spot.until && card.isConnected) card.scrollIntoView({ block: "center" });
          }, { once: true });
    }
  }
  refreshCopyLabels();
}
/* the selection pill in the bar: how many of the shown cards are picked, and a clear */
function renderPickPill() {
  const head = $(".panel-head");
  const n = panelBody.querySelectorAll(".card.picked").length;
  let pick = head.querySelector(".panel-pick");
  if (!n) {
    pick?.remove();
    return;
  }
  if (!pick) {
    pick = document.createElement("span");
    pick.className = "panel-pick";
    pick.innerHTML = `<span class="n"></span><button type="button" class="x" aria-label="Clear the selection"><svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round"><path d="M18 6L6 18M6 6l12 12"/></svg><span class="scope-tip">Clear the selection</span></button>`;
    pick.querySelector(".x").addEventListener("click", () => {
      state.selected.clear();
      for (const card of panelBody.querySelectorAll(".card.picked")) {
        card.classList.remove("picked");
        card.querySelector(".card-pick")?.setAttribute("aria-pressed", "false");
      }
      renderPickPill();
      refreshCopyLabels();
    });
    head.insertBefore(pick, head.querySelector(".panel-copy"));
  }
  pick.querySelector(".n").textContent = `${n} selected`;
}
/* the drawer's last line: how many are resolved, and where to see them */
/* "Shared on the hub · next-gen-console · pictures 120 MB of 1 GB" */
function hubLine() {
  const d = document.createElement("div");
  d.className = "panel-end hub-line";
  const u = state.hub.usage;
  const mb = (b) => (b >= 1024 * 1024 * 1024 ? `${+(b / 1024 / 1024 / 1024).toFixed(2)} GB` : `${Math.max(1, Math.round(b / 1024 / 1024))} MB`);
  d.textContent = `Shared on the hub · ${state.hub.project}${u ? ` · pictures ${mb(u.bytes)}${u.total !== u.bytes ? ` (${mb(u.total)} with other projects)` : ""} of ${mb(u.limit)}, kept 14 days after approval` : ""}`;
  return d;
}
/* the end of the list (Nirav, 2026-10-23: simpler than a row of numbers): a check, how many are approved, and a link
   to see them; on the page the link switches to the Approved tab */
function endLine() {
  const d = document.createElement("div");
  d.className = "panel-end";
  const n = state.doneCount ?? state.done.length;
  const href = EXT ? `${EXT.listUrl}&view=resolved` : `/__review/?view=resolved${window.__reviewSession ? `&session=${window.__reviewSession}` : ""}`;
  d.innerHTML = `<span class="end-ok" aria-hidden="true"><svg width="9" height="9" viewBox="0 0 12 12" fill="none" stroke="#fff" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><path d="M2.6 6.3l2.2 2.2 4.6-4.8"/></svg></span><span><b>${n}</b> <span class="end-word">approved</span></span><a href="${PAGE_MODE ? "#" : href}" target="_blank">View</a>`;
  d.querySelector("a").addEventListener("click", (e) => {
    if (PAGE_MODE) {
      e.preventDefault();
      window.__reviewView = "resolved";
      panelBody.scrollTop = 0;
      renderPanel();
    } else if (EXT) {
      e.preventDefault();
      openExtPage(href);
    }
  });
  return d;
}
for (const t of ["wheel", "touchmove"]) panelBody.addEventListener(t, () => (state.spot = null), { passive: true });
let toolsLast = 0, toolsRest = 0;
/* a group heading pinned at the top grows to the drawer's full width, and eases back once it lets go (Nirav, 2026-10-24) */
function markPinned() {
  const top = panelBody.getBoundingClientRect().top;
  for (const h of panelBody.querySelectorAll(".list-group")) {
    const sec = h.parentElement.getBoundingClientRect();
    h.classList.toggle("pinned", sec.top < top - 1 && sec.bottom > top + h.offsetHeight);
  }
  panel.toggleAttribute("data-pinned", !!panelBody.querySelector(".list-group.pinned"));
}
panelBody.addEventListener("scroll", () => {
  markPinned();
  const y = panelBody.scrollTop;
  toolsLast = y;
  /* the bar (Nirav, 2026-10-23): slips down and fades while the list is scrolling, back a moment after it stops;
     never while the search is in use */
  if (!(root.activeElement === toolsIn || state.q)) tools.classList.add("away");
  clearTimeout(toolsRest);
  toolsRest = setTimeout(() => tools.classList.remove("away"), 420);
  if (panelBody.scrollTop > 4) panel.setAttribute("data-scrolled", "");
  else panel.removeAttribute("data-scrolled");
});
function openPanel(on) {
  panel.classList.toggle("on", on);
  $(".panel-veil").classList.toggle("on", on && !PAGE_MODE);
  $(".list").classList.toggle("on", on);
  if (on) {
    renderPanel();
    syncNote("checking", "Checking…");
    loadComments().then(() => {
      renderPanel();
      if (state.unread.size) updateUnread();
      else syncNote("fresh", "Up to date");
    }).catch(() => syncNote(null));
  } else syncNote(null);
}
$(".list").addEventListener("click", () => openPanel(!panel.classList.contains("on")));
for (const b of $(".panel-view").querySelectorAll("button"))
  b.addEventListener("click", () => {
    window.__reviewView = b.dataset.v;
    renderPanel();
  });
$(".panel-veil").addEventListener("click", () => openPanel(false));
/* an instant tip for the place on the page (Nirav, 2026-10-24: the browser's own title waits a second); one element
   at the top of the shadow root, so the card's clipped hover strip cannot cut it */
const placeTip = document.createElement("div");
placeTip.className = "place-tip";
root.appendChild(placeTip);
panelBody.addEventListener("pointerover", (e) => {
  const el = e.target.closest?.(".cm-place");
  if (!el) return;
  placeTip.textContent = el.dataset.tip;
  const r = el.getBoundingClientRect();
  placeTip.classList.add("on");
  const w = placeTip.offsetWidth;
  placeTip.style.left = `${Math.max(8, Math.min(innerWidth - w - 8, r.left + r.width / 2 - w / 2))}px`;
  placeTip.style.top = `${r.top - placeTip.offsetHeight - 6}px`;
});
panelBody.addEventListener("pointerout", (e) => {
  if (e.target.closest?.(".cm-place")) placeTip.classList.remove("on");
});
panelBody.addEventListener("scroll", () => placeTip.classList.remove("on"), { passive: true });
/* an open history closes when the pointer moves on to another card, and that card goes back to normal (Nirav,
   2026-10-24) */
/* the history slides open and shut instead of jumping (Nirav, 2026-10-24) */
const HIST_EASE = { duration: 240, easing: "cubic-bezier(.32,.72,0,1)" };
function slideHist(box, open, then) {
  if (!box) return then?.();
  const h = box.offsetHeight;
  box.style.overflow = "hidden";
  const shut = { height: "0px", marginTop: "0px", opacity: 0 }, full = { height: `${h}px`, marginTop: "12px", opacity: 1 };
  const a = box.animate(open ? [shut, full] : [full, shut], HIST_EASE);
  a.onfinish = a.oncancel = () => {
    box.style.overflow = "";
    then?.();
  };
}
/* a floating strip near the end of the list (the last card's history) gets room under it and scrolls into view above
   the bottom bar (Nirav, 2026-10-24); a closed history gives the room back */
function roomFor(card, still) {
  const spacer = panelBody.querySelector(".list-spacer");
  if (!spacer || host.dataset.strip !== "float") return;
  const meta = card.querySelector(".card-meta");
  if (!meta) return;
  const bar = (tools.offsetHeight || 56) + 12;
  spacer.style.transition = "none"; // the room is there at once, so the scroll below is not cut short
  spacer.style.height = "";
  const need = meta.getBoundingClientRect().bottom + bar - spacer.getBoundingClientRect().bottom;
  if (need > 0) spacer.style.height = `${spacer.offsetHeight + need}px`;
  spacer.offsetHeight;
  spacer.style.transition = "";
  if (still) return;
  const over = meta.getBoundingClientRect().bottom - (panelBody.getBoundingClientRect().bottom - bar);
  if (over > 0) panelBody.scrollBy({ top: over, behavior: "smooth" });
}
function roomBack() {
  if (state.histOpen.size) return;
  const spacer = panelBody.querySelector(".list-spacer");
  if (spacer?.style.height) spacer.style.height = "";
}
/* while something above folds, the card under the pointer stays where it is (its own scrolling still moves it) */
function holdStill(el, ms) {
  let top = el.getBoundingClientRect().top, scroll = panelBody.scrollTop;
  const end = performance.now() + ms;
  const tick = () => {
    if (!el.isConnected) return;
    const shift = el.getBoundingClientRect().top - top + (panelBody.scrollTop - scroll); // what the layout moved, less any scroll
    if (shift) panelBody.scrollTop += shift;
    top = el.getBoundingClientRect().top;
    scroll = panelBody.scrollTop;
    if (performance.now() < end) requestAnimationFrame(tick);
  };
  requestAnimationFrame(tick);
}
panelBody.addEventListener("pointerover", (e) => {
  if (!state.histOpen.size) return;
  const over = e.target.closest?.(".card");
  if (!over) return;
  let closing = false;
  for (const id of [...state.histOpen]) {
    if (id === over.dataset.id) continue;
    state.histOpen.delete(id);
    state.histAll.delete(id);
    closing = true;
    const card = panelBody.querySelector(`.card[data-id="${id}"]`);
    const c = state.comments.find((x) => x.id === id) || state.done.find((x) => x.id === id);
    if (!card || !c) continue;
    /* one fold, not two (Nirav, 2026-10-24): the history lives inside the hover strip, so letting the strip close folds
       both together; the history leaves the page once the strip is shut */
    const btn = card.querySelector(".cm-hist");
    btn?.blur();
    btn?.setAttribute("aria-expanded", "false");
    card.classList.remove("hist-open");
    setTimeout(() => {
      if (!state.histOpen.has(id)) histSync(card, c);
    }, 260);
  }
  if (closing) holdStill(over, HIST_EASE.duration + 300);
});
panelBody.addEventListener("click", async (e) => {
  if (e.target.closest(".join-title")) {
    try {
      if (joinFolded()) localStorage.removeItem("review.join.folded");
      else localStorage.setItem("review.join.folded", joinKey());
    } catch {}
    renderPanel();
    return;
  }
  if (e.target.closest(".join-more")) {
    state.joinAll = !state.joinAll;
    renderPanel();
    return;
  }
  const join = e.target.closest(".join-go, .join-no");
  if (join) {
    /* let in or refuse: the approver's sign-in decides, so it goes through the extension */
    const row = join.closest(".join-row");
    const role = join.classList.contains("join-go") ? "member" : "refused";
    /* letting in needs your GitHub sign-in, which only the extension holds (Nirav, 2026-10-26: "Sign in first") */
    if (!EXT && (!extHere() || window.__reviewSession)) return toast("Letting people in needs your sign-in, which the Review mode extension holds: switch the extension on for this site (or use Open as a page from it), then try again.", true);
    join.classList.add("loading");
    row.classList.add("busy");
    const r = await rv(`/__review/members${sessQ()}`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ handle: row.dataset.h, role }) }, true).then(async (x) => ({ ok: x.ok, body: await x.json() })).catch(() => null);
    if (!r?.ok || !Array.isArray(r.body)) {
      join.classList.remove("loading");
      row.classList.remove("busy");
      const said = r?.body?.error || "";
      return toast(/did not answer/.test(said) ? "The extension did not answer. If it updated itself while this page was open, reload the page and try again." : said || "Could not save that: the hub did not answer", true);
    }
    state.joiners = r.body;
    teamCache.at = 0; // the hand-over list takes them in
    toast(role === "member" ? `${row.dataset.name} is in` : `${row.dataset.name} was refused`);
    renderPanel();
    return;
  }
  const head = e.target.closest(".list-group");
  if (head) {
    const set = new Set(state.folded || []);
    const k = head.dataset.g;
    if (set.has(k)) set.delete(k);
    else set.add(k);
    state.folded = set;
    try { localStorage.setItem(`review.folded.${state.persona}`, JSON.stringify([...set])); } catch {}
    /* folding a heading that was pinned (scrolled past its own start): after the redraw the list starts at that heading,
       so the next group's first comment comes right below it, not halfway down (Nirav, 2026-10-24) */
    const pinned = head.parentElement.getBoundingClientRect().top < panelBody.getBoundingClientRect().top;
    renderPanel();
    if (pinned) {
      const again = [...panelBody.querySelectorAll(".list-group")].find((h) => h.dataset.g === k);
      if (again) panelBody.scrollTop = Math.max(0, again.parentElement.offsetTop - panelBody.offsetTop - 8);
    }
    return;
  }
  const card = e.target.closest(".card");
  if (!card) return;
  const c = state.comments.find((x) => x.id === card.dataset.id) || state.done.find((x) => x.id === card.dataset.id);
  if (!c) return;
  if (e.target.closest(".hs-more")) {
    if (state.histAll.has(c.id)) state.histAll.delete(c.id);
    else state.histAll.add(c.id);
    histSync(card, c);
    roomFor(card);
    return;
  }
  if (e.target.closest(".cm-hist")) {
    if (state.histOpen.has(c.id)) {
      state.histOpen.delete(c.id);
      state.histAll.delete(c.id);
      card.querySelector(".cm-hist")?.setAttribute("aria-expanded", "false");
      slideHist(card.querySelector(".card-hist"), false, () => {
        histSync(card, c);
        card.querySelector(".cm-hist")?.focus({ preventScroll: true });
      });
    } else {
      state.histOpen.add(c.id);
      histSync(card, c);
      roomFor(card); // measured before the slide starts: the strip's full height
      slideHist(card.querySelector(".card-hist"), true);
      card.querySelector(".cm-hist")?.focus({ preventScroll: true });
    }
    return;
  }
  if (e.target.classList.contains("card-retry")) {
    delete c.failed;
    renderPanel();
    sendComment(c, state.pinEls.get(c.id));
    return;
  }
  if (e.target.classList.contains("card-drop")) {
    state.comments = state.comments.filter((x) => x.id !== c.id);
    state.pinEls.delete(c.id);
    state.count = state.comments.length;
    updateBar();
    renderPanel();
    return;
  }
  const btn = e.target.closest("button"); // a click on an item's icon still means its button
  if (btn?.classList.contains("card-st")) {
    const to = btn.dataset.to;
    card.querySelector(".card-more-wrap.open")?.classList.remove("open");
    card.classList.remove("menu-open");
    const order = ["open", "progress", "approval", "approved"];
    if (order.indexOf(to) < order.indexOf(c.status)) return askNote(card, c, to, btn.textContent.trim());
    await applyUpdate({ id: c.id, status: to }, btn);
    toast(`#${c.n} ${statusToast[to]}`);
    return;
  }
  if (btn?.classList.contains("card-reply")) {
    card.querySelector(".card-more-wrap.open")?.classList.remove("open");
    card.classList.remove("menu-open");
    if (state.asking?.id === c.id) return;
    const asker = isMine(c);
    state.asking = { id: c.id, reply: true, label: asker ? "Send" : "Answer", ph: asker ? "Add a detail or ask again. Enter sends it" : "Your answer. Enter sends it, Esc keeps it here", text: "", focused: true };
    mountAsk(card, c);
    return;
  }
  if (btn?.classList.contains("card-resolve")) {
    card.querySelector(".card-more-wrap.open")?.classList.remove("open");
    card.classList.remove("menu-open");
    await applyUpdate({ id: c.id, status: "approved", resolve: true }, btn);
    toast(`#${c.n} resolved`);
    return;
  }
  if (btn?.classList.contains("card-claude")) {
    card.querySelector(".card-more-wrap.open")?.classList.remove("open");
    card.classList.remove("menu-open");
    /* CLAUDE ANSWERS (Nirav, 2026-10-24): a brief to paste into a Claude session in the project; Claude reads the code
       the question points at and answers on the hub with the review command (marked as Claude's answer) */
    const talk = (c.history || []).filter((h) => h.kind === "reply").map((h) => `  ${h.via === "claude" ? "Claude" : h.by}: ${h.note}`).join("\n");
    const brief = [
      `Answer this design-review question from the code, then post the answer on the review hub.`,
      ``,
      `#${c.n} (${c.id}), asked by ${c.by || "someone"}: "${c.text}"`,
      `Where: ${c.pageTitle || c.route} (${c.route})${c.context ? `, ${c.context}` : ""}${typeof c.element === "string" && c.element ? `, on ${c.element}` : ""}`,
      talk ? `So far:\n${talk}` : "",
      ``,
      `Run \`npx review show ${c.id}\` for the element, the trail and the picture. Answer in one or two plain sentences, as you`,
      `would to a designer, and post it: npx review reply ${c.id} --claude "<your answer>"`,
      `If the answer is that something should change, say so; the asker can make it a fix.`,
    ].filter((l, i, xs) => l || xs[i - 1]).join("\n");
    try {
      await navigator.clipboard.writeText(brief);
      toast(`#${c.n} copied for Claude: paste it into a Claude session`);
    } catch {
      toast("Could not copy: the browser said no", true);
    }
    return;
  }
  if (btn?.classList.contains("card-take")) {
    card.querySelector(".card-more-wrap.open")?.classList.remove("open");
    card.classList.remove("menu-open");
    await applyUpdate({ id: c.id, status: "progress", take: true }, btn);
    toast(`#${c.n} taken back`);
    return;
  }
  if (e.target.closest(".card-more")) {
    let wrap = e.target.closest(".card-more-wrap");
    const open = !wrap.classList.contains("open");
    /* a picker left half-way (the team list) comes back as the menu */
    if (open && wrap.querySelector(".hand-list")) {
      const acts = card.querySelector(".card-foot .acts");
      acts.innerHTML = actsHtml(c);
      wrap = acts.querySelector(".card-more-wrap");
    }
    root.querySelectorAll(".card-more-wrap.open").forEach((w) => w.classList.remove("open"));
    wrap.classList.toggle("open", open);
    card.classList.toggle("menu-open", open);
    return;
  }
  if (e.target.closest(".card-hand")) {
    const menu = card.querySelector(".card-menu");
    menu.innerHTML = `<span class="hand-title">${c.status === "open" ? "Assign to" : "Hand over to"}</span><span class="hand-list"><span class="hand-wait">Loading the team…</span></span>`;
    const team = await teamList();
    const list = menu.querySelector(".hand-list");
    const pickable = team.filter((p) => p.name !== c.assignee);
    list.innerHTML = pickable.length ? pickable.map((p) => `<button class="card-mi hand-to" data-h="${esc(p.handle)}" data-n="${esc(p.name)}">${p.avatar ? `<img class="av" src="${esc(p.avatar)}" alt="" data-i="${esc(p.name[0])}">` : `<span class="av av-i">${esc(p.name[0])}</span>`}${isMe(p.name) ? "You" : esc(p.name)}</button>`).join("") : `<span class="hand-wait">Nobody else on the team yet</span>`;
    return;
  }
  if (e.target.closest(".hand-to")) {
    const b = e.target.closest(".hand-to");
    card.querySelector(".card-more-wrap")?.classList.remove("open");
    card.classList.remove("menu-open");
    state.asking = { id: c.id, to: "progress", label: "Hand over", text: "", focused: true, assignTo: b.dataset.h, toName: b.dataset.n };
    mountAsk(card, c);
    return;
  }
  if (e.target.closest(".card-type")) {
    const k = e.target.closest(".card-type").dataset.k;
    card.querySelector(".card-more-wrap")?.classList.remove("open");
    card.classList.remove("menu-open");
    await applyUpdate({ id: c.id, severity: k });
    return;
  }
  if (e.target.closest(".card-pick")) {
    if (pickDrag.handled) return (pickDrag.handled = false); // the pointer already did it
    if (e.shiftKey && pickDrag.anchor) return pickRange(pickDrag.anchor, c.id, true);
    setPicked(card, !state.selected.has(c.id));
    pickDrag.anchor = c.id;
    return;
  }
  if (e.target.classList.contains("card-shot")) {
    openLightbox(c.id);
    return;
  }
  if (e.target.classList.contains("card-n")) {
    goTo(c);
    return;
  }
  if (e.target.closest(".card-sev")) {
    const i = SEVERITIES.findIndex(([k]) => k === c.severity);
    const next = SEVERITIES[(i + 1) % SEVERITIES.length][0];
    await applyUpdate({ id: c.id, severity: next });
    return;
  }
  if (btn?.classList.contains("card-rm")) {
    const lbl = btn.querySelector(".mi-l") || btn;
    if (!btn.classList.contains("sure")) {
      btn.classList.add("sure");
      lbl.textContent = "Remove, sure?";
      setTimeout(() => {
        btn.classList.remove("sure");
        lbl.textContent = "Remove";
      }, 2500);
      return;
    }
    const done = await api("delete", { id: c.id }).catch((e) => ({ error: String(e?.message || e) }));
    if (!done?.ok) return toast(done?.error || "Could not remove it", true);
    await removeFx(card).catch((e) => console.warn("[review] removal effect:", e)); // its goodbye, then the list closes the gap; a failing effect never stops it
    await loadComments();
$(".bar .k").textContent = `${MOD} + click to comment`;
    renderPanel();
    toast(`Removed #${c.n}`);
    return;
  }
  if (e.target.classList.contains("card-text") && e.target.contentEditable !== "true" && canEdit(c)) editInPlace(e.target, c, () => {});
});
/* SELECTING (Nirav, 2026-10-24): one click on the circle, Shift-click for a range, a drag across the circles to paint
   many (starting on a picked card unpicks), and the keyboard: ↑ ↓ walk the cards, Space picks, Shift with an arrow
   extends, ⌘A takes every card shown, Esc lets them all go. All in place: no rebuild, the pictures stay. */
function setPicked(card, on) {
  const id = card.dataset.id;
  if (on) state.selected.add(id);
  else state.selected.delete(id);
  card.classList.toggle("picked", on);
  card.querySelector(".card-pick")?.setAttribute("aria-pressed", String(on));
  renderPickPill();
  refreshCopyLabels();
}
const shownCards = () => [...panelBody.querySelectorAll(".card")];
function pickRange(fromId, toId, on) {
  const cards = shownCards();
  const a = cards.findIndex((x) => x.dataset.id === fromId), b = cards.findIndex((x) => x.dataset.id === toId);
  if (a < 0 || b < 0) return;
  for (const card of cards.slice(Math.min(a, b), Math.max(a, b) + 1)) if (state.selected.has(card.dataset.id) !== on) setPicked(card, on);
}
const pickDrag = { on: false, mode: true, anchor: null, handled: false, y: 0, raf: 0 };
panelBody.addEventListener("pointerdown", (e) => {
  const pick = e.target.closest(".card-pick");
  if (!pick || e.button !== 0 || e.shiftKey) return;
  const card = pick.closest(".card");
  e.preventDefault();
  pickDrag.on = true;
  pickDrag.mode = !state.selected.has(card.dataset.id);
  pickDrag.anchor = card.dataset.id;
  pickDrag.handled = true;
  pickDrag.y = e.clientY;
  setPicked(card, pickDrag.mode);
  panel.classList.add("picking");
  const edge = () => {
    if (!pickDrag.on) return;
    const r = panelBody.getBoundingClientRect();
    const d = pickDrag.y < r.top + 48 ? -1 : pickDrag.y > r.bottom - 48 ? 1 : 0;
    if (d) {
      panelBody.scrollTop += d * 14;
      paintAt(pickDrag.y);
    }
    pickDrag.raf = requestAnimationFrame(edge);
  };
  pickDrag.raf = requestAnimationFrame(edge);
});
function paintAt(y) {
  for (const card of shownCards()) {
    const r = card.getBoundingClientRect();
    if (y >= r.top && y <= r.bottom) {
      if (state.selected.has(card.dataset.id) !== pickDrag.mode) setPicked(card, pickDrag.mode);
      break;
    }
  }
}
window.addEventListener("pointermove", (e) => {
  if (!pickDrag.on) return;
  pickDrag.y = e.clientY;
  paintAt(e.clientY);
}, true);
window.addEventListener("pointerup", () => {
  if (!pickDrag.on) return;
  pickDrag.on = false;
  cancelAnimationFrame(pickDrag.raf);
  panel.classList.remove("picking");
  setTimeout(() => (pickDrag.handled = false), 0);
}, true);
/* into the list straight away (Nirav, 2026-10-24): with the drawer open and the focus not yet in it, Tab lands on the first
   card, ↓ on the first card in view and ↑ on the last one in view; a field being typed in keeps its keys */
window.addEventListener("keydown", (e) => {
  if (!panel.classList.contains("on") || state.off || lightbox.classList.contains("on") || $(".scope-menu")) return;
  if (e.metaKey || e.ctrlKey || e.altKey) return;
  const tab = e.key === "Tab" && !e.shiftKey, down = e.key === "ArrowDown", up = e.key === "ArrowUp";
  if (!tab && !down && !up) return;
  const act = root.activeElement;
  if (e.composedPath().some((n) => n instanceof HTMLElement && (n.matches("input, textarea, select") || n.isContentEditable))) return;
  if (act?.classList?.contains("card") || (act && panelBody.contains(act))) return; // the list's own keys take over
  if (tab && act && panel.contains(act)) return; // already walking the head: Tab goes on as usual
  const cards = shownCards();
  if (!cards.length) return;
  const r = panelBody.getBoundingClientRect();
  const inView = cards.filter((c) => { const b = c.getBoundingClientRect(); return b.bottom > r.top + 8 && b.top < r.bottom - 60; });
  const target = up ? (inView.at(-1) || cards.at(-1)) : (tab ? cards[0] : inView[0] || cards[0]);
  e.preventDefault();
  e.stopPropagation();
  target.focus({ preventScroll: !tab });
  if (tab) target.scrollIntoView({ block: "nearest" });
}, true);
panelBody.addEventListener("keydown", (e) => {
  const card = e.target.classList?.contains("card") ? e.target : null;
  const cards = shownCards();
  if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "a" && (card || e.target === panelBody)) {
    e.preventDefault();
    for (const c of state.shownList || []) state.selected.add(c.id); // every shown comment, built or not yet
    for (const x of cards) if (!x.classList.contains("picked")) setPicked(x, true);
    return;
  }
  if (e.key === "Escape" && state.selected.size && card) {
    e.preventDefault();
    e.stopPropagation();
    for (const x of cards) if (state.selected.has(x.dataset.id)) setPicked(x, false);
    state.selected.clear();
    renderPickPill();
    refreshCopyLabels();
    return;
  }
  if (!card) return;
  const i = cards.indexOf(card);
  if (e.key === "ArrowDown" || e.key === "ArrowUp") {
    e.preventDefault();
    const next = cards[i + (e.key === "ArrowDown" ? 1 : -1)];
    if (!next) return;
    if (e.shiftKey) {
      if (!state.selected.has(card.dataset.id)) setPicked(card, true);
      setPicked(next, true);
    }
    next.focus();
    next.scrollIntoView({ block: "nearest" });
  } else if (e.key === " " || e.key === "x") {
    e.preventDefault();
    setPicked(card, !state.selected.has(card.dataset.id));
    pickDrag.anchor = card.dataset.id;
  }
}, true);
/* keep the panel current when comments come and go (never rebuilding a menu that is open under the pointer) */
const _load = loadComments;
/* nobody is in the middle of something in the panel: a note being typed, a text edited, a "sure?" pending, a menu */
const panelBusy = () => !!(state.asking || root.querySelector('[contenteditable="true"]') || $(".card-rm.sure") || $(".scope-menu") || $(".card-more-wrap.open") || state.pending);
/* a click anywhere else closes an open card menu */
window.addEventListener("pointerdown", (e) => {
  if (e.composedPath().some((n) => n.classList?.contains?.("card-more-wrap"))) return;
  root.querySelectorAll(".card-more-wrap.open").forEach((w) => {
    w.classList.remove("open");
    w.closest(".card")?.classList.remove("menu-open");
  });
}, true);
loadComments = async function () {
  const changed = await _load();
  if (changed && panelBusy()) state.stale = true; // drawn once the panel is free again
  else if (changed || (state.stale && !panelBusy())) {
    state.stale = false;
    renderPanel.skipWhileMenu = true;
    try {
      renderPanel();
    } finally {
      renderPanel.skipWhileMenu = false;
    }
  }
  return changed;
};

/* ---------- copying: a brief for Claude, a checklist for Loop ---------- */
function shownComments() {
  /* what the panel shows right now: the scope and the tags applied, open or resolved as the view says; and when
     some of those are picked, those only */
  const shown = state.shownList || []; // the whole shown list, not only the cards built so far
  const picked = shown.filter((c) => state.selected.has(c.id));
  return picked.length ? picked : shown;
}
const loadImage = (src) =>
  new Promise((res, rej) => {
    const img = new Image();
    if (/^https?:/.test(src)) img.crossOrigin = "anonymous"; // a picture from the hub: the canvas may read it back
    img.onload = () => res(img);
    img.onerror = rej;
    img.src = src;
  });
/* the picture with its number drawn on, at full size (for the export) or downsized (for the clipboard) */
async function numberedPicture(c, maxW) {
  const img = await loadImage(shotUrl(c));
  const scale = maxW && img.naturalWidth > maxW ? maxW / img.naturalWidth : 1;
  const cv = document.createElement("canvas");
  cv.width = Math.round(img.naturalWidth * scale);
  cv.height = Math.round(img.naturalHeight * scale);
  const g = cv.getContext("2d");
  g.fillStyle = "#fff";
  g.fillRect(0, 0, cv.width, cv.height);
  g.drawImage(img, 0, 0, cv.width, cv.height);
  if (c.rect) {
    const b = badgeSpot(c, img.naturalWidth, img.naturalHeight);
    const cx = (b.left / 100) * cv.width, cy = (b.top / 100) * cv.height, r = ((b.size / 100) * cv.width) / 2;
    g.beginPath();
    g.arc(cx, cy, r * 1.14, 0, Math.PI * 2);
    g.fillStyle = "#fff";
    g.fill();
    g.beginPath();
    g.arc(cx, cy, r, 0, Math.PI * 2);
    g.fillStyle = "#e11d48";
    g.fill();
    g.fillStyle = "#fff";
    g.font = `700 ${Math.round(r * 1.1)}px -apple-system, system-ui, sans-serif`;
    g.textAlign = "center";
    g.textBaseline = "middle";
    g.fillText(String(c.n), cx, cy + r * 0.05);
  }
  return cv;
}
const sevName = (k) => SEVERITIES.find(([x]) => x === k)?.[1] || k;
const trailWords = (c) =>
  (c.trail || [])
    .filter((t) => !/^(html|body)$/.test(t.selector || "") && !/[{};]|^import /.test(t.textKey || ""))
    .map((t) => (t.kind === "hover" ? `hover "${(t.textKey || "").slice(0, 30)}"` : t.kind === "type" ? `type "${t.value}"` : t.kind === "key" ? `press ${t.key}` : `click "${(t.textKey || "").slice(0, 30)}"`))
    .join(" > ");
const groupBy = (list) => {
  const m = new Map();
  for (const c of list) {
    const g = (c.module && c.module.group) || moduleOf(c.route).group || "Other";
    const pg = c.pageTitle || c.route;
    const k = `${g} · ${pg}`;
    if (!m.has(k)) m.set(k, []);
    m.get(k).push(c);
  }
  return m;
};
async function buildPrompt(list) {
  /* THE BRIEF (2026-10-26): pasted into a Claude session in the project, it works the hub on its own: picks the
     comments up as you (marked as made with Claude), fixes them group by group, asks you before marking them done,
     answers the questions, and ends with a summary. Nothing in it is particular to one project. */
  const project = state.hub?.project || EXT?.project || location.host;
  const me = state.hub?.handle || ""; // the GitHub handle the hub knows
  const env = [EXT ? `REVIEW_PROJECT=${project}` : "", window.__reviewSession ? `REVIEW_SESSION=${window.__reviewSession}` : ""].filter(Boolean).join(" ");
  const cmd = (rest) => `${env ? env + " " : ""}npx review ${rest}${me ? ` --as ${me}` : ""}`;
  const lines = [];
  lines.push(`# Design review: ${list.length} comment${list.length === 1 ? "" : "s"} on ${project}`);
  lines.push("");
  lines.push(`The app runs at ${location.origin}${EXT ? "" : " (the dev server)"}. Each comment points at one thing on one page; its picture shows the page as it was seen, with a red box round the element and the comment's number beside it. Open the pictures with Read.${me ? ` You act as ${me}: every command below says so.` : ""}`);
  lines.push("");
  /* STEP 0 (2026-10-26): the project may not have Review mode yet; Claude checks, asks, sets it up, then works */
  lines.push("Step 0, before anything else: make sure this project has Review mode.");
  lines.push(`- Check: \`${cmd("list --open")}\`. If it lists comments, run \`npx review init\` once (it refreshes the review skill to the latest, nothing else changes), then go on.`);
  lines.push(`- If \`npx review\` is not found: tell me it is missing and ask "Set up Review mode here? It adds a dev dependency, review.config.json, .review/vite.config.js, a dev:review script, .gitignore lines and the review skill." On my yes, run \`npm install --save-dev github:niravbhatt1317/review-mode\`, then \`npx review init${project.startsWith("_") ? "" : ` ${project}`}\`, check again, and go on. On my no, work from this brief alone and tell me the statuses to set by hand.`);
  lines.push("- Then use the `review` skill (.claude/skills/review) for the rest.");
  lines.push("");
  lines.push("How to work through them:");
  lines.push(`1. Read every comment and its picture first${EXT ? " (each Picture line is a curl command: run it, then open the saved file)" : ""}. Group the ones that share a cause (the same component, rule or copy pattern) and tell me the groups before changing anything. Leave a comment someone else is working on (its "Who has it" line names them).`);
  lines.push(`2. A comment with a "Sent back" note came back from approval: do what the note says first.`);
  lines.push(`3. For each group: pick its comments up (\`${cmd("status <id> progress --claude")}\`; if it answers "Already picked up by …", leave that one and tell me), make the change, then say which numbers it closes and what moved.`);
  lines.push(`4. Show me the change and ask: "Mark #… as done?" Only on my yes, set them for approval (\`${cmd("status <id> approval --claude")}\`). Never approve: that is the reviewer's.`);
  lines.push(`5. A Question is answered, not worked: read the code it points at and answer in one or two plain sentences (\`${cmd('reply <id> --claude "<answer>"')}\`). If the honest answer is that something should change, say so; the asker can make it a fix. Never set a question's status.`);
  lines.push("6. Follow the project's own rules (its CLAUDE.md, its design system). Never remove functionality. If a comment is unclear, ask with its number rather than guessing.");
  lines.push("7. When you finish, end with a short table: number, what changed, where it stands now (in progress, waiting for approval, answered, left for someone else).");
  lines.push("");
  lines.push("```sh");
  lines.push(`${cmd("list --open")}            # every open comment, with who has it`);
  lines.push(`${cmd("list --open --mine")}     # the ones you have`);
  lines.push(`${cmd("show <id>")}              # one comment in full (element, trail, conversation)`);
  lines.push("```");
  lines.push("");
  /* links to the full pictures, good for seven days: from any machine, no repo needed */
  let links = {};
  try {
    const r = await (await rv("/__review/links", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ ids: list.map((c) => c.id), days: 7 }) })).json();
    if (r && !r.error) links = r;
  } catch {}
  let i = 0;
  for (const [k, items] of groupBy(list)) {
    lines.push(`## ${k}`);
    lines.push("");
    for (const c of items) {
      i++;
      let pic = "";
      if (c.shot && EXT) pic = links[c.id] ? `curl -sL -o review-${String(c.n).padStart(2, "0")}.png "${links[c.id]}"   # saves the picture (link good for 7 days), then read the file` : "on the hub, no link right now";
      else if (c.shot) {
        try {
          const cv = await numberedPicture(c);
          const r = await (await rv(`/__review/export${window.__reviewSession ? `?session=${window.__reviewSession}` : ""}`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ id: c.id, n: c.n, png: cv.toDataURL("image/png") }) })).json();
          pic = r.path || "";
        } catch {}
      }
      lines.push(`### ${c.n} · ${sevName(c.severity)}${c.status !== "open" ? ` · ${statusLine(c)}` : ""}`);
      lines.push(c.text);
      lines.push("");
      lines.push(`- Id: ${c.id}`);
      const has = c.status === "progress" ? c.assignee : c.status === "approval" ? c.doneBy : null;
      if (has) lines.push(`- Who has it: ${isMe(has) ? "you" : has}${c.withClaude ? " (with Claude)" : ""}`);
      if (c.note?.text && !isQ(c)) lines.push(`- ${noteLine(c)}`);
      if (isQ(c)) {
        const talk = (c.history || []).filter((h) => h.kind === "reply");
        if (talk.length) lines.push(`- So far: ${talk.map((h) => `${h.via === "claude" ? "Claude" : h.by}: "${h.note}"`).join(" / ")}`);
      }
      lines.push(`- Where: ${c.pageTitle || c.route} · ${c.context || "Page"} · route ${c.route}`);
      if (c.element) lines.push(`- Element: ${c.element}`);
      const tw = trailWords(c);
      if (tw) lines.push(`- How to get there: ${tw}`);
      if (c.theme && c.theme !== "light") lines.push(`- Theme: ${c.theme}`);
      if (pic) lines.push(`- Picture: ${pic}`);
      if (!EXT && links[c.id]) lines.push(`- Picture link (7 days, from any machine): ${links[c.id]}`);
      lines.push("");
    }
  }
  return lines.join("\n");
}
async function buildLoop(list) {
  /* the shapes Loop itself puts on the clipboard (read back through the paste inspector): a checklist is a <ul> with a
     scriptor-listid whose items carry scriptor-listItem-marker-value-unchecked; a paragraph is a scriptor-paragraph
     div; an empty one is the gap between points. Loop keeps <b> and <i>, and drops sizes and margins.
     Loop takes about 16 MB in one paste and drops whatever comes after (the last picture of a 19-comment review went
     missing), so the review is cut into parts of at most PART MB, each pasted on its own; the pictures stay full size. */
  const PART = 12 * 1048576;
  const esc = (t) => String(t ?? "").replace(/[&<>"]/g, (ch) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[ch]);
  const uuid = () => (crypto.randomUUID ? crypto.randomUUID() : Math.random().toString(16).slice(2) + "-" + Date.now().toString(16));
  const para = (inner) => `<div class="scriptor-paragraph"><span>${inner}</span></div>`;
  /* one empty line between points: an empty paragraph; with a <br> inside, Loop showed it as two lines */
  const gap = () => `<div class="scriptor-paragraph"><span></span></div>`;
  /* the module heading in Loop's own Blue (its font colour menu), read back from a paste */
  const heading = (k) => `<h3><span style="color: var(--ms-themeColorPaletteFontColorBlue, #006cbf);">${esc(k)}</span></h3>`;
  const open = "<meta charset='utf-8'><html><head></head><body><span><!--ScriptorStartFragment-->";
  const close = "<!--ScriptorEndFragment--></span></body></html>";
  const parts = [];
  let html = [], text = [], size = 0, group = null;
  const start = (first) => {
    html = [open]; text = []; size = open.length + close.length;
    /* no title of its own: the page in Loop has one. A later part is pasted right under the one before, so it
       continues without repeating the module heading */
    size += html.join("").length;
  };
  /* Loop drops the last picture of a paste on import (seen on 2026-10-20, confirmed with a two-comment trial), so the
     last gap of each part carries a 1 px picture instead: that is the one it loses */
  const decoy = () => { const dot = document.createElement("canvas"); dot.width = dot.height = 1; return `<div class="scriptor-paragraph"><img alt="" width="1" height="1" src="${dot.toDataURL("image/png")}" style="display: block;"></div>`; };
  const finish = () => { if (html[html.length - 1] === gap()) html[html.length - 1] = decoy(); html.push(close); parts.push({ html: html.join(""), text: text.join("\n"), size }); };
  start(true);
  for (const [k, items] of groupBy(list)) {
    group = k;
    html.push(heading(k)); text.push(`## ${k}`, ""); size += heading(k).length;
    for (const c of items) {
      const lid = `list!list-${uuid()}`;
      /* Loop's own shapes, read back from a paste: the item's text as styled spans; under it, paragraphs indented
         with margin-left: 27px; the picture crisp at its full size but shown at the width/height it carries */
      const chunk = [`<ul class="" scriptor-listid="${lid}"><li class="scriptor-listItem${lid} scriptor-listItem-marker-value-unchecked" placeholder="placeholder!addItem"><span style="font-weight: 600;">${c.n} · ${esc(c.text)}</span></li></ul>`];
      if (c.shot) {
        try {
          /* the picture at its full capture size, PNG, shown at 560 wide. Width and height both given, from the
             picture's own proportions: a frame that agrees with its content. Loop draws an 8 px rest under every
             picture inside its frame, its own shapes included (nine variants measured on 2026-10-20, all the same);
             nothing in this markup changes that. */
          const cv = await numberedPicture(c);
          const w = 560, h = Math.round((cv.height / cv.width) * 560);
          chunk.push(`<div class="scriptor-paragraph" style="margin-left: 27px;"><img alt="Comment ${c.n}" width="${w}" height="${h}" src="${cv.toDataURL("image/png")}" style="display: block;"></div>`);
        } catch {}
      }
      /* the place line, with the tag, in Loop's own Gray (its font colour menu), read back from a paste; Loop drops <small> */
      chunk.push(`<div class="scriptor-paragraph" style="margin-left: 27px;"><span style="font-style: italic; color: var(--ms-themeColorPaletteFontColorGray, #757575);">${esc(c.pageTitle || c.route)} · ${esc(c.context || "Page")} · ${esc(sevName(c.severity))}</span></div>`);
      chunk.push(gap());
      const len = chunk.join("").length;
      if (size + len > PART && size > open.length + close.length + 400) { finish(); start(false); }
      html.push(...chunk); size += len;
      text.push(`- [ ] ${c.n} · ${c.text}`);
      text.push(`  ${c.pageTitle || c.route} · ${c.context || "Page"} · ${sevName(c.severity)}`, "");
    }
  }
  finish();
  return parts;
}
/* the parts of the last Loop copy: pressed again, the button hands out the next one */
let loopParts = null;
/* the copy buttons' tooltips say what a press takes: the comments shown, with the scope and tags that narrow them */
function copyLabel(kind) {
  const shown = state.shownList || [];
  const n = shown.length; // the whole shown list, built or not yet
  const picked = shown.filter((c) => state.selected.has(c.id)).length;
  const what = kind === "prompt" ? "Copy a brief for Claude" : kind === "send" ? "Send to Claude" : "Copy a checklist for Loop";
  if (picked) return `${what} · ${picked} selected`;
  const narrow = [];
  if (state.scope.kind === "group") narrow.push(state.scope.group);
  if (scopeNow().kind === "route") narrow.push(scopeNow().title || scopeNow().route);
  if (state.filter.size) narrow.push([...state.filter].map(sevName).join(", "));
  return `${what} · ${n} shown${narrow.length ? ` (${narrow.join(" · ")})` : ""}`;
}
function refreshCopyLabels() {
  for (const b of root.querySelectorAll(".panel-copy")) if (!b.classList.contains("busy") && !b.classList.contains("done")) b.querySelector(".scope-tip").textContent = copyLabel(b.dataset.kind);
}
async function copyOut(kind, btn) {
  const list = shownComments();
  if (!list.length) return toast("Nothing shown to copy");
  btn.classList.add("busy");
  const tip = btn.querySelector(".scope-tip");
  const label = copyLabel(kind);
  tip.textContent = "Working…";
  try {
    if (kind === "prompt") {
      const md = await buildPrompt(list);
      await navigator.clipboard.writeText(md);
      toast(`Copied a brief for ${list.length} comment${list.length === 1 ? "" : "s"}, pictures written to .review/sessions/${window.__reviewSession || "main"}/export`);
    } else {
      /* the same list again while parts remain: the next part; anything else starts over from part 1 */
      const key = list.map((c) => `${c.id}:${c.status}`).join(",");
      if (!loopParts || loopParts.key !== key || loopParts.next >= loopParts.parts.length) loopParts = { key, parts: await buildLoop(list), next: 0 };
      const { parts } = loopParts;
      const i = loopParts.next++;
      const { html, text } = parts[i];
      await navigator.clipboard.write([new ClipboardItem({ "text/html": new Blob([html], { type: "text/html" }), "text/plain": new Blob([text], { type: "text/plain" }) })]);
      if (parts.length === 1) toast(`Copied ${list.length} comment${list.length === 1 ? "" : "s"} for Loop, pictures included`);
      else if (i + 1 < parts.length) toast(`Part ${i + 1} of ${parts.length} copied. Paste it in Loop, then press Loop again for part ${i + 2}.`, 6000);
      else toast(`Part ${i + 1} of ${parts.length} copied, the last one. Paste it under the others.`, 6000);
    }
    btn.classList.add("done");
    tip.textContent = "Copied";
    setTimeout(() => {
      btn.classList.remove("done");
      const more = kind === "loop" && loopParts && loopParts.next < loopParts.parts.length;
      tip.textContent = more ? `Copy part ${loopParts.next + 1} of ${loopParts.parts.length} for Loop` : label;
      if (kind === "loop") btn.querySelector(".more").textContent = more ? `${loopParts.next + 1}/${loopParts.parts.length}` : "";
    }, 1800);
  } catch (e) {
    toast(`Could not copy: ${e.message}`);
    tip.textContent = label;
  } finally {
    btn.classList.remove("busy");
  }
}
/* SEND TO CLAUDE (2026-10-26): the brief goes straight into an open Claude Code session (the review MCP server,
   mcp/server.mjs, started with channels on); one session is sent to at once, several bring a small picker; no session,
   or one not listening, falls back to the copy */
$('.panel-copy[data-kind="prompt"]').insertAdjacentHTML("afterend", `<button class="panel-copy" data-kind="send" aria-label="Send to Claude"><span class="send-clip"><svg class="boost" width="18" height="18" viewBox="0 0 18 18" aria-hidden="true"><path d="M3.5 11.5 L1 14" /><path d="M6 13.2 L3.2 16" /><path d="M2 9.2 L0 11.2" /></svg><svg class="logo-send" width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M21 3L10 14"/><path d="M21 3l-7 18-4-7-7-4z"/></svg><svg class="sent-tick" width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.6" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M5 12.5l4.5 4.5L19 7.5" pathLength="1"/></svg></span><span class="scope-tip">Send to Claude</span></button>`);
const CHANNEL_HINT = "claude --dangerously-load-development-channels server:review";
/* THE SEND SHEET (Nirav, 2026-10-26: "better, a copy icon, inside the drawer"): a small panel under the head that says
   where a send stands, with the start command to copy when Claude is not listening */
const sheet = document.createElement("div");
sheet.className = "claude-sheet";
panelBody.before(sheet);
const COPY_ICO = `<svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><rect x="9" y="9" width="12" height="12" rx="2.5"/><path d="M5 15V5a2 2 0 0 1 2-2h10"/></svg>`;
const cmdBox = (cmd, again) => `<div class="cs-row"><div class="cs-cmd"><code>${esc(cmd)}</code><button type="button" class="cs-copy" data-copy="${esc(cmd)}" aria-label="Copy the command">${COPY_ICO}<span>Copy</span></button></div>${again ? '<button type="button" class="cs-again">Check again</button>' : ""}</div>`;
let sheetTimer = 0;
function showSheet(kind, o = {}) {
  clearTimeout(sheetTimer);
  const ICON = {
    wait: `<span class="cs-spin"></span>`,
    ok: `<span class="cs-ok"><svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="#fff" stroke-width="3.2" stroke-linecap="round" stroke-linejoin="round"><path d="M5 12.5l4.5 4.5L19 7.5"/></svg></span>`,
    warn: `<span class="cs-warn">!</span>`,
  };
  const n = o.count ? `${o.count} comment${o.count === 1 ? "" : "s"}` : "";
  const body = {
    none: [ICON.warn, "Start Claude to send directly", `<p>Run this once in a terminal, in your project folder. From then on, the plane sends comments straight to that Claude, and it works through them for you. Until then the brief is on your clipboard: paste it into any Claude chat.</p>${cmdBox(CHANNEL_HINT, true)}`],
    sent: [ICON.wait, `Sent ${n} to Claude`, `<p class="cs-sub">${esc(o.label || "")} · waiting for Claude to confirm…</p>${o.hint ? `<p>If the session asks to use the review tools, allow them (choose "don't ask again").</p>` : ""}`],
    ok: [ICON.ok, `Claude has the ${o.count === 1 ? "comment" : "comments"}`, `<p class="cs-sub">${esc(o.label || "")} · it is starting on them</p>`],
    late: [ICON.warn, "Sent, but Claude has not confirmed", `<p>Look at that Claude session: it may be asking to allow the review tools, or still busy. If it shows nothing at all, it was not started with push on. The brief is on your clipboard too.</p>${cmdBox(CHANNEL_HINT)}`],
    fail: [ICON.warn, "Could not send", `<p>${esc(o.error || "The session did not answer.")} The brief is on your clipboard.</p>`],
  }[kind];
  sheet.innerHTML = `<div class="cs-card cs-is-${kind}"><div class="cs-head">${body[0]}<b>${body[1]}</b><button type="button" class="cs-close" aria-label="Close">×</button></div>${body[2]}</div>`;
  sheet.classList.add("on");
  if (kind === "ok") sheetTimer = setTimeout(hideSheet, 3500);
}
function hideSheet() {
  clearTimeout(sheetTimer);
  sheet.classList.remove("on");
}
sheet.addEventListener("click", async (e) => {
  if (e.target.closest(".cs-close")) return hideSheet();
  const cp = e.target.closest(".cs-copy");
  if (cp) {
    await navigator.clipboard.writeText(cp.dataset.copy).catch(() => {});
    cp.querySelector("span").textContent = "Copied";
    cp.classList.add("done");
    setTimeout(() => {
      cp.querySelector("span").textContent = "Copy";
      cp.classList.remove("done");
    }, 1600);
    return;
  }
  if (e.target.closest(".cs-again")) {
    hideSheet();
    sendToClaude($('.panel-copy[data-kind="send"]'));
  }
});
async function sendToClaude(btn) {
  const list = shownComments();
  if (!list.length) return toast("Nothing shown to send");
  btn.classList.add("busy");
  const done = () => {
    btn.classList.remove("busy");
    refreshCopyLabels();
  };
  const q = window.__reviewSession ? `?session=${window.__reviewSession}` : "";
  const sessions = await rv(`/__review/claude/sessions${q}`).then((r) => r.json()).catch(() => []);
  const md = await buildPrompt(list);
  if (!Array.isArray(sessions) || !sessions.length) {
    done();
    await navigator.clipboard.writeText(md).catch(() => {});
    return showSheet("none");
  }
  const pick = sessions.length === 1 ? sessions[0] : await pickSession(btn, sessions);
  if (!pick) return done();
  const r = await rv(`/__review/claude/send${q}`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ port: pick.port, text: md, count: list.length }) })
    .then((x) => x.json())
    .catch(() => null);
  done();
  if (!r?.ok) {
    await navigator.clipboard.writeText(md).catch(() => {});
    return showSheet("fail", { error: r?.error });
  }
  btn.classList.add("busy"); // the plane keeps flying until Claude says it has it
  showSheet("sent", { count: list.length, label: pick.label });
  /* Claude says it has it (review_ack); the first time, Claude Code may ask to allow the review tools, so a minute */
  for (let i = 0; i < 60; i++) {
    await new Promise((res) => setTimeout(res, 1000));
    if (!sheet.classList.contains("on")) return btn.classList.remove("busy"); // closed: stop watching
    if (i === 15) showSheet("sent", { count: list.length, label: pick.label, hint: true });
    const st = await rv(`/__review/claude/status${q}${q ? "&" : "?"}port=${pick.port}&id=${r.id}`).then((x) => x.json()).catch(() => null);
    if (st?.acked) {
      btn.classList.remove("busy");
      btn.classList.add("sent");
      setTimeout(() => btn.classList.remove("sent"), 2200);
      return showSheet("ok", { count: list.length, label: pick.label });
    }
  }
  btn.classList.remove("busy");
  await navigator.clipboard.writeText(md).catch(() => {});
  showSheet("late");
}
/* several sessions: a small menu under the button */
function pickSession(btn, sessions) {
  return new Promise((resolve) => {
    root.querySelector(".claude-pick")?.remove();
    const m = document.createElement("div");
    m.className = "claude-pick";
    m.innerHTML = `<div class="cp-title">Send to which Claude?</div>${sessions.map((s, i) => `<button type="button" data-i="${i}"><b>${esc(s.label)}</b><span>${esc(s.cwd)}</span></button>`).join("")}`;
    btn.parentElement.appendChild(m);
    const r = btn.getBoundingClientRect(), pr = btn.parentElement.getBoundingClientRect();
    m.style.top = `${r.bottom - pr.top + 6}px`;
    m.style.right = `${pr.right - r.right}px`;
    const close = (v) => {
      m.remove();
      window.removeEventListener("pointerdown", away, true);
      resolve(v);
    };
    const away = (e) => !e.composedPath().includes(m) && close(null);
    window.addEventListener("pointerdown", away, true);
    m.addEventListener("click", (e) => {
      const b = e.target.closest("button[data-i]");
      if (b) close(sessions[Number(b.dataset.i)]);
    });
  });
}
for (const b of root.querySelectorAll(".panel-copy")) b.addEventListener("click", () => (b.dataset.kind === "send" ? sendToClaude(b) : copyOut(b.dataset.kind, b)));

/* ---------- the picture viewer ---------- */
const lightbox = $(".lightbox");
let lbId = null;
function openLightbox(id) {
  const withPics = state.comments.filter((c) => c.shot);
  const i = withPics.findIndex((c) => c.id === id);
  if (i < 0) return;
  const c = withPics[i];
  lbId = id;
  $(".lb-n").textContent = c.n;
  const sev = $(".lb-sev");
  sev.dataset.k = c.severity;
  sev.textContent = SEVERITIES.find(([k]) => k === c.severity)?.[1] || c.severity;
  $(".lb-text").textContent = c.text;
  $(".lb-count").textContent = `${i + 1} of ${withPics.length}`;
  $(".lb-where").textContent = `${c.pageTitle || c.route} · ${c.context || "Page"}`;
  $(".lb-prev").disabled = i === 0;
  $(".lb-next").disabled = i === withPics.length - 1;
  $(".lb-img").src = shotUrl(c);
  $(".lb-pic").querySelector(".pic-n")?.remove();
  if (c.rect) $(".lb-pic").appendChild(liveBadge(c, $(".lb-img")));
  lightbox.classList.add("on");
}
function closeLightbox() {
  lightbox.classList.remove("on");
  $(".lb-img").removeAttribute("src");
  lbId = null;
}
function stepLightbox(d) {
  const withPics = state.comments.filter((c) => c.shot);
  const i = withPics.findIndex((c) => c.id === lbId);
  const next = withPics[i + d];
  if (next) openLightbox(next.id);
}
/* the frame is as wide as the picture, the picture as big as the window allows (never above its own size): the
   caption and the foot follow its width, not the other way round */
function fitLightbox() {
  const img = $(".lb-img");
  if (!img.naturalWidth) return;
  const maxW = innerWidth - 64, maxH = innerHeight - 48 - 42 - 36;
  const scale = Math.min(1, maxW / img.naturalWidth, maxH / img.naturalHeight);
  $(".lb-frame").style.width = `${Math.max(320, Math.round(img.naturalWidth * scale))}px`;
}
$(".lb-img").addEventListener("load", fitLightbox);
addEventListener("resize", () => lightbox.classList.contains("on") && fitLightbox());
$(".lb-close").addEventListener("click", closeLightbox);
$(".lb-prev").addEventListener("click", () => stepLightbox(-1));
$(".lb-next").addEventListener("click", () => stepLightbox(1));
lightbox.addEventListener("click", (e) => {
  if (e.target === lightbox) closeLightbox(); // the backdrop closes; the picture itself stays put
});

/* ---------- go to a comment: its page, its state (the recorded clicks replayed), its pin pulsing ---------- */
window.addEventListener(
  "pointerdown",
  (e) => {
    /* record how a state is reached: plain clicks on the app (the review's own clicks never get here).
       At pointerdown, not click: Radix opens on pointerdown and then cuts pointer events on the body, so by
       the time the click arrives its target is the html element */
    if (e.composedPath().includes(host) || e.button !== 0 || state.alt || state.sticky) return;
    if (!state.showPins) state.flash = null; // the go-to pin shown over hidden pins goes on the next click
    if (location.pathname !== state.trailRoute) {
      state.trailRoute = location.pathname;
      state.trail = [];
    }
    const el = e.target instanceof Element ? e.target.closest("button,a,[role],tr,td,th,label,summary,input,select,li") || e.target : null;
    if (!el || el === document.body || el === document.documentElement) return;
    state.lastClickAt = performance.now();
    pushStep({ kind: "click", selector: selectorFor(el), textKey: txt(el).slice(0, 80) });
  },
  true
);
const pushStep = (step) => {
  if (location.pathname !== state.trailRoute) {
    state.trailRoute = location.pathname;
    state.trail = [];
  }
  const last = state.trail.at(-1);
  /* typing into the same field: keep one step with the final value */
  if (step.kind === "type" && last && last.kind === "type" && last.selector === step.selector) last.value = step.value;
  else state.trail.push(step);
  if (state.trail.length > 20) state.trail.shift();
};
const fieldOf = (t) => (t instanceof Element ? t.closest("input, textarea, select, [contenteditable=true]") : null);
/* typing: the field and what it ends up holding */
window.addEventListener(
  "input",
  (e) => {
    if (e.composedPath().includes(host)) return;
    const f = fieldOf(e.target);
    if (!f) return;
    const value = f.isContentEditable ? f.textContent : f.type === "checkbox" || f.type === "radio" ? String(f.checked) : f.value;
    pushStep({ kind: f.tagName === "SELECT" ? "select" : "type", selector: selectorFor(f), textKey: f.getAttribute("placeholder") || f.getAttribute("aria-label") || f.name || "", value });
  },
  true
);
/* keys that do something: shortcuts (with ⌘ or Ctrl), and Enter / Escape / arrows / Tab anywhere */
window.addEventListener(
  "keydown",
  (e) => {
    if (e.composedPath().includes(host) || state.pending) return;
    const chord = e.metaKey || e.ctrlKey;
    const special = ["Enter", "Escape", "ArrowDown", "ArrowUp", "ArrowLeft", "ArrowRight", "Tab", " ", "Home", "End", "PageDown", "PageUp"].includes(e.key);
    if (!chord && !special) return;
    if (["Alt", "Meta", "Control", "Shift"].includes(e.key)) return;
    const t = e.target instanceof Element && e.target !== document.body ? e.target : null;
    pushStep({ kind: "key", key: e.key, code: e.code, meta: e.metaKey, ctrl: e.ctrlKey, shift: e.shiftKey, alt: e.altKey, selector: t ? selectorFor(t) : "", textKey: t ? txt(t).slice(0, 80) : "" });
  },
  true
);
for (const kind of ["contextmenu", "dblclick"])
  window.addEventListener(
    kind,
    (e) => {
      if (e.composedPath().includes(host) || state.alt || state.sticky) return;
      const el = e.target instanceof Element ? e.target.closest("button,a,[role],tr,td,th,label,li,input,textarea") || e.target : null;
      if (!el || el === document.body) return;
      state.lastClickAt = performance.now();
      pushStep({ kind, selector: selectorFor(el), textKey: txt(el).slice(0, 80) });
    },
    true
  );
/* a popover that appears with no click just before it was opened by hovering: record its trigger as a hover step */
new MutationObserver((muts) => {
  for (const m of muts)
    for (const n of m.addedNodes) {
      if (!(n instanceof Element)) continue;
      const pop = n.matches("[data-radix-popper-content-wrapper],[role=tooltip]") ? n : n.querySelector("[data-radix-popper-content-wrapper],[role=tooltip]");
      if (!pop || performance.now() - state.lastClickAt < 400 || !state.lastHover?.isConnected) continue;
      const trig = state.lastHover.closest("button,a,[role],td,th,[data-state],label,span") || state.lastHover;
      if (host.contains(trig)) continue;
      const last = state.trail.at(-1);
      const step = { kind: "hover", selector: selectorFor(trig), textKey: txt(trig).slice(0, 80) };
      if (last && last.kind === "hover" && last.selector === step.selector) continue;
      pushStep(step);
    }
}).observe(document.body, { childList: true, subtree: true });
setInterval(() => {
  if (location.pathname !== state.trailRoute) {
    state.trailRoute = location.pathname;
    state.trail = [];
    if (state.scope.kind === "here" && panel.classList.contains("on") && !panelBusy()) renderPanel();
  }
}, 250);
const waitFor = async (fn, ms) => {
  const end = performance.now() + ms;
  for (;;) {
    const v = fn();
    if (v) return v;
    if (performance.now() > end) return null;
    await sleep(80);
  }
};
function findStep(step) {
  let found = [];
  const diag = { byAddress: 0, byText: 0, first: "" };
  findStep.last = diag;
  try {
    found = queryDeep(step.selector);
  } catch (e) {
    diag.first = "bad address";
  }
  diag.byAddress = found.length;
  /* visible AND hittable: a docked, clipped copy of a button has a size but cannot be clicked. What comes back is
     the thing to click: the element, or the invisible layer a page stretches over a row to make it clickable
     (Supabase's div.absolute over each policy row), since that is what a real click would land on. */
  const clickable = (e) => {
    let r = e.getBoundingClientRect();
    if (!(r.width > 0 && r.height > 0)) return null;
    if (r.bottom < 0 || r.top > window.innerHeight || r.right < 0 || r.left > window.innerWidth) {
      /* there, but scrolled away (a row far down a table): brought into view, then checked */
      try {
        e.scrollIntoView({ block: "center", inline: "nearest" });
      } catch {}
      r = e.getBoundingClientRect();
    }
    const hit = targetAt(r.left + r.width / 2, r.top + r.height / 2);
    if (!hit) return null;
    if (e === hit || e.contains(hit) || hit.contains(e)) return e;
    const h = hit.getBoundingClientRect();
    const covers = h.left <= r.left + 1 && h.top <= r.top + 1 && h.right >= r.right - 1 && h.bottom >= r.bottom - 1;
    return covers ? hit : null;
  };
  const vis = (e) => !!clickable(e);
  const norm = (t) => String(t || "").toLowerCase().replace(/\s+/g, " ").trim();
  const same = (e) => !step.textKey || norm(txt(e).slice(0, 80)) === norm(step.textKey);
  const byPath = found.find((e) => same(e) && vis(e));
  if (byPath) return clickable(byPath);
  /* the structure moved (a banner, a wrapper), or the address now points at a neighbour (a list reordered): find it
     by its text among the clickable things, or the text itself inside something clickable (a name in a row); the
     bare address only when there is no text to go by */
  if (!step.textKey || step.textKey.length < 3) {
    const bare = found.find(vis);
    return bare ? clickable(bare) : null;
  }
  const tag = (step.selector.split(">").pop() || "").trim().split(":")[0].split(".")[0].split("#")[0] || "*";
  const pool = Array.from(document.querySelectorAll(`${tag}, button, a, [role], tr, td, th, li, label, summary, p, span, div`));
  const texted = pool.filter(same);
  diag.byText = texted.length;
  if (texted[0]) {
    const r = texted[0].getBoundingClientRect();
    const h = r.width && r.height ? targetAt(r.left + r.width / 2, r.top + r.height / 2) : null;
    diag.first = `${texted[0].tagName.toLowerCase()} ${Math.round(r.width)}×${Math.round(r.height)} at ${Math.round(r.top)}, hit ${h ? h.tagName.toLowerCase() + (h.className && typeof h.className === "string" ? "." + h.className.split(" ")[0].slice(0, 16) : "") : "nothing"}`;
  }
  const hit = texted.find(vis) || null;
  if (!hit) return null;
  const target = clickable(hit);
  if (target !== hit) return target; // the layer over it
  return hit.matches("p, span") ? hit.closest("button, a, [role=button], [role=menuitem], tr, [role=row], li, td") || hit : hit;
}
function realHover(el) {
  const r = el.getBoundingClientRect();
  const o = { bubbles: true, cancelable: true, composed: true, clientX: r.left + r.width / 2, clientY: r.top + r.height / 2, pointerId: 1, isPrimary: true, pointerType: "mouse" };
  el.dispatchEvent(new PointerEvent("pointerover", o));
  el.dispatchEvent(new PointerEvent("pointerenter", { ...o, bubbles: false }));
  el.dispatchEvent(new MouseEvent("mouseover", o));
  el.dispatchEvent(new MouseEvent("mouseenter", { ...o, bubbles: false }));
  el.dispatchEvent(new PointerEvent("pointermove", o));
  el.dispatchEvent(new MouseEvent("mousemove", o));
}
/* React only hears a value set through the native setter, then an input event */
function realType(el, value) {
  if (el.isContentEditable) {
    el.focus();
    el.textContent = value;
    el.dispatchEvent(new InputEvent("input", { bubbles: true, composed: true, inputType: "insertText", data: value }));
    return;
  }
  const proto = el.tagName === "TEXTAREA" ? HTMLTextAreaElement.prototype : el.tagName === "SELECT" ? HTMLSelectElement.prototype : HTMLInputElement.prototype;
  if (el.type === "checkbox" || el.type === "radio") {
    if (String(el.checked) !== value) el.click();
    return;
  }
  el.focus();
  Object.getOwnPropertyDescriptor(proto, "value").set.call(el, value);
  el.dispatchEvent(new Event("input", { bubbles: true, composed: true }));
  el.dispatchEvent(new Event("change", { bubbles: true, composed: true }));
}
function realKey(step, el) {
  const target = el || document.activeElement || document.body;
  const o = { bubbles: true, cancelable: true, composed: true, key: step.key, code: step.code, metaKey: !!step.meta, ctrlKey: !!step.ctrl, shiftKey: !!step.shift, altKey: !!step.alt };
  target.dispatchEvent(new KeyboardEvent("keydown", o));
  target.dispatchEvent(new KeyboardEvent("keyup", o));
}
/* a replayed click must never change data for the reviewer: a submit, or anything named like a destructive act */
const RISKY = /\b(delete|remove|revoke|suspend|offboard|disable|reset|wipe|purge|destroy|submit|send|approve|reject|deploy|rollout|roll out|upgrade now|push)\b/i;
/* a step that would change data: a submit button in a form, or an action control (button, menu item, link that
   acts) whose label IS a destructive phrase: "Remove", "Delete monitor…". A row or a name that merely contains
   such a word ("review shots: team remove") is a thing to open, not an action. */
const risky = (el) => {
  if (el.matches?.("button[type=submit]") && el.closest("form")) return true;
  const label = txt(el).slice(0, 80).trim();
  if (!RISKY.test(label)) return false;
  const control = el.matches?.("button, [role=button], [role=menuitem], input[type=button], input[type=submit], a[href='#'], a:not([href])") || !!el.closest?.("button, [role=button], [role=menuitem]");
  const short = label.split(/\s+/).length <= 3;
  return control && short;
};
function realClick(el) {
  const r = el.getBoundingClientRect();
  const o = { bubbles: true, cancelable: true, composed: true, clientX: r.left + r.width / 2, clientY: r.top + r.height / 2, button: 0, buttons: 1, pointerId: 1, isPrimary: true, pointerType: "mouse", detail: 1 }; // detail 1: a mouse click, not a keyboard one (some handlers ignore detail 0)
  el.dispatchEvent(new PointerEvent("pointermove", { ...o, buttons: 0 })); // a Radix item wants the pointer on it first
  el.dispatchEvent(new PointerEvent("pointerdown", o));
  el.dispatchEvent(new MouseEvent("mousedown", o));
  el.dispatchEvent(new PointerEvent("pointerup", { ...o, buttons: 0 }));
  el.dispatchEvent(new MouseEvent("mouseup", { ...o, buttons: 0 }));
  el.dispatchEvent(new MouseEvent("click", { ...o, buttons: 0 }));
}
/* every open dialog on the page (in open shadow roots too) */
function openDialogs() {
  const out = [];
  const walk = (root, depth) => {
    for (const d of root.querySelectorAll("[role=dialog],[role=alertdialog],dialog[open]")) if (d.getBoundingClientRect().width > 0) out.push(d);
    if (depth < 4) for (const e of root.querySelectorAll("*")) if (e.shadowRoot && e !== host) walk(e.shadowRoot, depth + 1);
  };
  walk(document, 0);
  return out;
}
/* a popover comment with no recorded trigger: the popover's own text names what it hangs from (an id like
   maria-32-0031, a name), so find that row, then hover its likely triggers until the popover appears; a menu
   that only opens on a click gets a click on the things that declare a popup, never on anything risky */
async function guessPopover(c, here) {
  const text = `${c.textKey || ""} ${c.element || ""}`;
  const ids = [...new Set(text.match(/[a-z]+-\d+(?:-\d+)*|\b\d{2,}(?:\.\d+)+\b/gi) || [])];
  let scopes = [];
  const rows = Array.from(document.querySelectorAll("tr, li, [role=row], article, section, [role=listitem]"));
  for (const id of ids) {
    /* the text may run the id straight into the next figure (node-32-0029 + 75%): shed trailing digits until a row has it */
    for (let probe = id; probe.length >= 6 && /\d$/.test(probe); probe = probe.slice(0, -1)) {
      const hit = rows.filter((e) => txt(e).includes(probe));
      if (hit.length) {
        scopes.push(...hit);
        break;
      }
    }
  }
  scopes = scopes.filter((e, i, a) => a.indexOf(e) === i && !a.some((o) => o !== e && o.contains(e)));
  const hittable = (e) => {
    const r = e.getBoundingClientRect();
    if (!(r.width > 0 && r.height > 0)) return false;
    const h = targetAt(r.left + r.width / 2, r.top + r.height / 2);
    return !!h && (e === h || e.contains(h) || h.contains(e));
  };
  let cands = [];
  let menuFirst = false;
  if (scopes.length) {
    for (const sc of scopes) cands.push(...Array.from(sc.querySelectorAll("[data-state], [aria-haspopup], button, a, [role=button]")).filter(hittable));
  } else {
    /* no id to anchor on (a menu, a plain popover): its trigger is a control whose label is in the popover's
       text, or the chevron beside such a control (a split button) */
    const low = (c.textKey || "").toLowerCase();
    /* never a tab or a link: those change the page instead of opening something */
    const all = Array.from(document.querySelectorAll("[aria-haspopup], [data-state], button, [role=button]")).filter((e) => !host.contains(e) && !e.matches("[role=tab], a[href], [role=tab] *") && hittable(e));
    const label = (e) => txt(e).slice(0, 40).toLowerCase();
    /* the popover's text usually begins with its trigger's label (a menu repeats its button's name first) */
    const leads = all.filter((e) => label(e).length >= 3 && low.startsWith(label(e)));
    const whole = all.filter((e) => label(e).length >= 3 && new RegExp(`(^|[^a-z0-9])${label(e).replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}([^a-z0-9]|$)`).test(low));
    const beside = [];
    for (const e of leads) for (const sib of Array.from(e.parentElement?.children || [])) if (sib !== e && sib.matches("[aria-haspopup], [data-state], button") && hittable(sib)) beside.push(sib);
    cands = [...beside, ...leads, ...all.filter((e) => e.matches("[aria-haspopup]")), ...whole].filter((e, i, a) => a.indexOf(e) === i);
    menuFirst = true;
  }
  if (!cands.length) return null;
  const leave = (t) => {
    const r = t.getBoundingClientRect();
    const o = { bubbles: true, composed: true, clientX: r.left - 40, clientY: r.top - 40, pointerId: 1, pointerType: "mouse" };
    t.dispatchEvent(new PointerEvent("pointerout", o));
    t.dispatchEvent(new PointerEvent("pointerleave", { ...o, bubbles: false }));
    t.dispatchEvent(new MouseEvent("mouseout", o));
    t.dispatchEvent(new MouseEvent("mouseleave", { ...o, bubbles: false }));
  };
  const tryHover = async (t) => {
    t.scrollIntoView({ block: "center" });
    await sleep(100);
    realHover(t);
    const el = await waitFor(here, 1400);
    if (!el) leave(t);
    return el;
  };
  const tryClick = async (t) => {
    if (risky(t)) return null;
    realClick(t);
    const el = await waitFor(here, 1200);
    if (!el) {
      realKey({ key: "Escape", code: "Escape" });
      await sleep(150);
    }
    return el;
  };
  const clickable = (e) => e.matches("[aria-haspopup], [data-state], button, [role=button]");
  const deadline = performance.now() + 10000; // ten seconds of guessing, then an honest answer
  const left = () => performance.now() < deadline;
  if (menuFirst) for (const t of cands.filter(clickable).slice(0, 10)) { if (!left()) break; const el = await tryClick(t); if (el) return el; }
  for (const t of cands.slice(0, 14)) { if (!left()) break; const el = await tryHover(t); if (el) return el; }
  if (!menuFirst) for (const t of cands.filter(clickable).slice(0, 8)) { if (!left()) break; const el = await tryClick(t); if (el) return el; }
  return null;
}
let going = false;
let goRun = 0; // each go-to gets a number; an older run stops at its next wait once a newer one has started
async function goTo(c) {
  if (PAGE_MODE && EXT) {
    /* the extension's list page: over to the site, the comment's id in the hash for the overlay there */
    if (!EXT.siteOrigin) return toast("Switch the site on first, then come back here");
    location.href = `${EXT.siteOrigin}${(c.route || "/").split("#")[0]}#review-goto=${c.id}`;
    return;
  }
  if (PAGE_MODE) {
    /* over to the app: it opens the comment once it has loaded (sessionStorage survives a login redirect) */
    try {
      sessionStorage.setItem("review.goto", c.id);
    } catch {}
    location.href = (c.route || "/").split("#")[0];
    return;
  }
  const run = ++goRun;
  const stale = () => run !== goRun;
  going = true;
  try {
    openPanel(false);
    toast(`Opening #${c.n}…`, true);
    const route = (c.route || "").split("?")[0];
    if (EXT && location.pathname !== route) {
      /* another site's router will not hear a history push: a real navigation, the id in the hash */
      going = false;
      location.href = `${(c.route || "/").split("#")[0]}#review-goto=${c.id}`;
      return;
    }
    if (location.pathname !== route) {
      toast(`Opening #${c.n}: going to ${c.pageTitle || route}…`, true);
      history.pushState(null, "", c.route);
      window.dispatchEvent(new PopStateEvent("popstate"));
      await waitFor(() => location.pathname === route, 2000);
      await sleep(500);
      if (stale()) return;
    }
    const here = () => resolve(c, performance.now(), true);
    const restoreScrolls = () => {
      for (const sc of c.scrolls || []) {
        if (sc.selector === "window") window.scrollTo(sc.left, sc.top);
        else {
          let e = null;
          try {
            e = queryDeep(sc.selector)[0] || null;
          } catch {}
          if (e) {
            e.scrollTop = sc.top;
            e.scrollLeft = sc.left;
          }
        }
      }
    };
    restoreScrolls();
    let el = await waitFor(here, 600);
    if (stale()) return;
    /* not on the page as it is, but its place is known: there, without guessing (a chart redrawn, a figure moved) */
    if (!el && c.rect && ghostRect(c)) {
      const win = (c.scrolls || []).find((x) => x.selector === "window");
      if (win) window.scrollTo({ left: win.left || 0, top: win.top || 0, behavior: "smooth" });
      state.flash = { id: c.id, until: performance.now() + 3200 };
      toast(`#${c.n}: the element has changed since; shown where it was`);
      return;
    }
    const skipped = [];
    const junk = (step) => /^(html|body)$/.test(step.selector || "") || /[{};]|^import /.test(step.textKey || "");
    const stepName = (step) => {
      const label = junk(step) ? "" : (step.textKey || "").slice(0, 24).trim();
      const q = label ? ` "${label}${(step.textKey || "").length > 24 ? "…" : ""}"` : "";
      if (step.kind === "key") return `pressing ${[step.meta && "⌘", step.ctrl && "Ctrl", step.shift && "⇧", step.alt && "⌥"].filter(Boolean).join("")}${step.key === " " ? "Space" : step.key}`;
      if (step.kind === "type" || step.kind === "select") return `entering "${step.value}"`;
      if (step.kind === "hover") return label ? `hovering${q}` : "hovering the trigger";
      if (step.kind === "contextmenu") return `right-clicking${q}`;
      if (step.kind === "dblclick") return `double-clicking${q}`;
      return label ? `clicking${q}` : "clicking a button";
    };
    /* one step of the trail: find its target, act, see whether the comment's element appeared */
    const tried = []; // what the replay did, for an honest answer when it fails
    const runStep = async (step, patience) => {
      if (junk(step)) return null; // a stray step on the page itself: nothing to do
      toast(`Opening #${c.n}: ${stepName(step)}…`, true);
      if (step.kind === "key") {
        const t = step.selector ? await waitFor(() => findStep(step), 300) : null;
        realKey(step, t);
        return waitFor(here, 900);
      }
      const t = await waitFor(() => findStep(step), patience);
      if (!t) {
        const d = findStep.last || {};
        tried.push(`could not find ${stepName(step)}: ${d.byAddress} by address, ${d.byText} by text${d.first ? `, first ${d.first}` : ""}`);
        return null; // not there: the app already took this step for us (a remembered selection)
      }
      if (step.kind === "hover") {
        t.scrollIntoView({ block: "center" });
        await sleep(100);
        realHover(t);
        return waitFor(here, 2200); // hover cards open after a delay
      }
      if (step.kind === "type" || step.kind === "select") {
        realType(t, step.value);
        return waitFor(here, 1200);
      }
      if (step.kind === "contextmenu" || step.kind === "dblclick") {
        const r = t.getBoundingClientRect();
        const o = { bubbles: true, cancelable: true, composed: true, clientX: r.left + r.width / 2, clientY: r.top + r.height / 2, button: step.kind === "contextmenu" ? 2 : 0 };
        if (step.kind === "dblclick") {
          realClick(t);
          realClick(t);
        }
        t.dispatchEvent(new MouseEvent(step.kind, o));
        return waitFor(here, 1200);
      }
      if (risky(t)) {
        skipped.push(txt(t).slice(0, 30) || "a submit");
        return null;
      }
      const dialogsBefore = openDialogs().length;
      realClick(t);
      /* a moment for the element; if a dialog did appear, more time for its content to load (another site's drawer
         fills itself after opening); if nothing at all appeared, on to the alternatives quickly */
      let got = await waitFor(here, 1500);
      if (!got && openDialogs().length > dialogsBefore) got = await waitFor(here, EXT ? 3000 : 1000);
      if (!got && openDialogs().length === dialogsBefore) {
        /* nothing happened: some rows answer only a real click on their content, or the keyboard. The text
           itself, then the row around it, then Enter on whatever can take focus. */
        const r = t.getBoundingClientRect();
        const inner = document.elementsFromPoint(r.left + Math.min(40, r.width / 2), r.top + r.height / 2).find((e) => e !== t && !t.contains(e) && !host.contains(e) && e.getRootNode() === document && txt(e).length);
        const row = t.closest("tr, [role=row], li, [role=listitem]") || inner?.closest("tr, [role=row], li, [role=listitem]");
        for (const alt of [inner, row].filter(Boolean)) {
          realClick(alt);
          got = await waitFor(here, 1500);
          if (got || openDialogs().length > dialogsBefore) break;
        }
        if (!got && openDialogs().length === dialogsBefore) {
          const focusable = [t, inner, row].find((e) => e && (e.tabIndex >= 0 || e.matches("a, button, [role=button], [role=link]")));
          if (focusable) {
            focusable.focus();
            realKey({ key: "Enter", code: "Enter" }, focusable);
            got = await waitFor(here, 1500);
          }
        }
      }
      if (!got) {
        const now = openDialogs();
        const titles = now.map((d) => contextOf(d.querySelector("h1,h2,h3,[id$=title],[class*=title]") || d)).join(" / ");
        tried.push(`${stepName(step)} ${now.length > dialogsBefore ? `opened "${titles}" but #${c.n}'s element was not in it` : "did nothing I could see"}`);
      }
      return got;
    };
    const trail = c.trail || [];
    if (!el && trail.length) {
      /* the last step is usually the one that opens the thing: if its target is on screen, that is the whole job;
         else the last two, then three, in order, before everything from the start (which would replay the
         opening of other things seen on the way) */
      for (let k = 1; k <= 3 && !el && k <= trail.length; k++) {
        const tail = trail.slice(-k);
        if (tail[0].kind === "key" || !findStep(tail[0])) continue;
        for (const step of tail) {
          el = await runStep(step, 0);
          if (stale()) return;
          if (!el && step !== tail[tail.length - 1]) continue;
        }
      }
    }
    if (!el && trail.length) {
      /* otherwise from the start; a missing step waits briefly, the first one longer (the page may be loading) */
      let first = true;
      for (const step of trail) {
        el = await runStep(step, first ? (EXT ? 6000 : 1500) : EXT ? 1200 : 500);
        if (stale()) return;
        first = false;
        if (el) {
          restoreScrolls();
          break;
        }
      }
    }
    if (!el && /^Popover or menu/.test(c.context || "")) toast(`Opening #${c.n}: finding what opens it…`, true);
    if (!el && /^Popover or menu/.test(c.context || "")) el = await guessPopover(c, here);
    if (stale()) return;
    if (!el) {
      /* no trail, or it did not get there: a drawer nearly always opens from a button carrying its name */
      const m = /^Drawer or dialog: (.+)$/.exec(c.context || "");
      if (m) {
        const name = m[1].trim().toLowerCase();
        const opener = () => {
          const e = Array.from(document.querySelectorAll("button, a, [role=button]")).find((b) => txt(b).toLowerCase() === name);
          return e ? findStep({ selector: "button, a, [role=button]", textKey: txt(e).slice(0, 80) }) : null; // the hittable copy
        };
        const t = await waitFor(opener, 1500);
        if (t) {
          realClick(t);
          el = await waitFor(here, 1800);
        }
      }
    }
    if (stale()) return;
    if (!el) {
      toast(skipped.length ? `#${c.n}: stopped before "${skipped[0]}", a step that would change data. Open the rest by hand.` : `#${c.n} is on this page, but its state must be opened by hand: ${c.context || "see the picture"}${tried.length ? ` (${tried.join("; ")})` : ""}`);
      return;
    }
    el.scrollIntoView({ block: "center", behavior: "smooth" });
    state.flash = { id: c.id, until: performance.now() + 3200 };
    /* the surroundings: a different org view, theme or window size changes what the picture shows */
    const notes = [];
    const snap = appSnapshot();
    for (const k of ["merged-ui.orgview", "merged-ui.scenario.admin"]) if (c.app && c.app[k] != null && snap[k] !== c.app[k]) notes.push("a different org view");
    if (c.theme && c.theme !== (document.documentElement.getAttribute("data-theme") || "light")) notes.push(`the ${c.theme} theme`);
    if (c.viewport && Math.abs(c.viewport.w - window.innerWidth) > c.viewport.w * 0.3) notes.push(`a ${c.viewport.w}px wide window`);
    toast(notes.length ? `#${c.n}: here. It was made in ${[...new Set(notes)].join(", ")}.` : `#${c.n}: here`);
  } finally {
    going = false;
  }
}

/* page mode: a paste inspector (?inspect=1): paste something copied from Loop, its clipboard HTML is saved for study */
if (PAGE_MODE && new URLSearchParams(location.search).get("inspect")) {
  const box = document.createElement("div");
  box.className = "ui";
  box.style.cssText = "position:fixed;left:50%;top:40%;transform:translate(-50%,-50%);width:520px;background:#fff;border-radius:12px;box-shadow:0 12px 32px rgba(29,43,62,.25);padding:16px;z-index:9;pointer-events:auto;font:13px/1.5 -apple-system,system-ui,sans-serif;color:#1d2b3e";
  box.innerHTML = `<b>Paste inspector</b><p style="margin:6px 0 10px;color:#5b6b85">Copy a one-item Checklist in Loop, click below, press ⌘V.</p><div class="sink" contenteditable="true" style="min-height:90px;border:1px dashed #cfd8e6;border-radius:8px;padding:10px;outline:none"></div><p class="out" style="margin:10px 0 0;color:#5b6b85"></p><p style="margin:12px 0 0;display:flex;gap:8px;flex-wrap:wrap"><button class="trial" style="font:inherit;padding:6px 12px;border:1px solid #cfd8e6;border-radius:8px;background:#fff;cursor:pointer">Copy picture trial (9 variants)</button><button class="endtrial" data-decoy="0" style="font:inherit;padding:6px 12px;border:1px solid #cfd8e6;border-radius:8px;background:#fff;cursor:pointer">Copy end trial 1 (plain)</button><button class="endtrial" data-decoy="1" style="font:inherit;padding:6px 12px;border:1px solid #cfd8e6;border-radius:8px;background:#fff;cursor:pointer">Copy end trial 2 (decoy at the end)</button></p>`;
  host.shadowRoot.appendChild(box);
  /* the end trial: two comments exactly as the real copy writes them; trial 2 adds a 1 px picture at the very end,
     to learn whether Loop drops the last picture of a paste whatever it is */
  for (const b of box.querySelectorAll(".endtrial")) b.addEventListener("click", async () => {
    const out = box.querySelector(".out");
    const list = (await (await rv(`/__review/list${location.search.includes("session=") ? location.search : ""}`)).json()).filter((x) => x.shot && !x.resolved).slice(0, 2);
    if (list.length < 2) return (out.textContent = "Needs two open comments with pictures.");
    out.textContent = "Working…";
    const [part] = await buildLoop(list);
    let html = part.html;
    if (b.dataset.decoy === "1") {
      const dot = document.createElement("canvas"); dot.width = dot.height = 1;
      html = html.replace("<!--ScriptorEndFragment-->", `<div class="scriptor-paragraph"><img alt="" width="1" height="1" src="${dot.toDataURL("image/png")}" style="display: block;"></div><!--ScriptorEndFragment-->`);
    }
    await navigator.clipboard.write([new ClipboardItem({ "text/html": new Blob([html], { type: "text/html" }), "text/plain": new Blob([part.text], { type: "text/plain" }) })]);
    out.textContent = `End trial ${b.dataset.decoy === "1" ? 2 : 1} copied: comments ${list.map((c) => c.n).join(" and ")}. Paste into Loop; does the second picture show?`;
  });
  /* the trial: one picture written five ways, labelled, so one paste into Loop shows which frame is clean */
  box.querySelector(".trial").addEventListener("click", async (e) => {
    const out = box.querySelector(".out");
    const list = await (await rv(`/__review/list${location.search.includes("session=") ? location.search : ""}`)).json();
    const c = (list.comments || list).find((x) => x.shot);
    if (!c) return (out.textContent = "No comment with a picture.");
    out.textContent = "Working…";
    const full = await numberedPicture(c);
    const half = await numberedPicture(c, 1120);
    const small = await numberedPicture(c, 560);
    const ratio = full.height / full.width;
    const h560 = Math.round(ratio * 560);
    const png = (cv) => cv.toDataURL("image/png");
    const para = (inner) => `<div class="scriptor-paragraph"><span>${inner}</span></div>`;
    const pic = (attrs, cv) => `<div class="scriptor-paragraph"><span></span><img ${attrs} src="${png(cv)}" style="display: block;"><span></span></div>`;
    const variants = [
      ["A: as today. alt, width 560, height 265, full pixels", pic(`alt="A" width="560" height="${h560}"`, full)],
      ["B: no alt, width 560, height 265, full pixels", pic(`width="560" height="${h560}"`, full)],
      ["C: no alt, attributes equal to the pixels, half size (1120 wide)", pic(`width="${half.width}" height="${half.height}"`, half)],
      ["D: no alt, attributes equal to the pixels, exactly 560 wide", pic(`width="${small.width}" height="${small.height}"`, small)],
      ["E: no alt, attributes equal to the pixels, full size", pic(`width="${full.width}" height="${full.height}"`, full)],
      /* shapes that may make Loop file the picture as a block instead of an inline image (its frame then has no text line under it) */
      ["F: picture alone, not inside any paragraph", `<img width="560" height="${h560}" src="${png(full)}" style="display: block;">`],
      ["G: picture inside Loop's own scriptor-image block", `<div class="scriptor-paragraph"><div class="scriptor-image scriptor-block" style="display: block; width: 560px;"><img class="scriptor-image-element" width="560" height="${h560}" src="${png(full)}"></div></div>`],
      ["H: picture in a figure", `<figure style="margin: 0;"><img width="560" height="${h560}" src="${png(full)}" style="display: block;"></figure>`],
      ["I: picture in a p, display block", `<p style="line-height: 0;"><img width="560" height="${h560}" src="${png(full)}" style="display: block; vertical-align: top;"></p>`],
    ];
    const html = `<meta charset='utf-8'><html><head></head><body><span><!--ScriptorStartFragment-->${variants.map(([t, p]) => para(`<b>${t}</b>`) + p + para("<br>")).join("")}<!--ScriptorEndFragment--></span></body></html>`;
    const text = variants.map(([t]) => t).join("\n");
    await navigator.clipboard.write([new ClipboardItem({ "text/html": new Blob([html], { type: "text/html" }), "text/plain": new Blob([text], { type: "text/plain" }) })]);
    out.textContent = `Copied 9 variants of comment ${c.n}. Paste into Loop, click each picture, note which have the strip.`;
  });
  box.querySelector(".sink").addEventListener("paste", async (e) => {
    e.preventDefault();
    const html = e.clipboardData.getData("text/html");
    const text = e.clipboardData.getData("text/plain");
    /* a picture on the clipboard (a screenshot) is kept too, as a data URL */
    const file = [...e.clipboardData.files].find((f) => f.type.startsWith("image/"));
    const image = file ? await new Promise((ok) => { const fr = new FileReader(); fr.onload = () => ok(fr.result); fr.readAsDataURL(file); }) : "";
    const r = await (await rv("/__review/paste", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ html, text, image }) })).json();
    box.querySelector(".out").textContent = r.ok ? `Saved: ${r.htmlLength} characters of HTML${r.image ? " and a picture" : ""}. You can close this.` : "Could not save.";
    box.querySelector(".sink").textContent = text.slice(0, 200);
  });
}
/* the theme: Auto follows the computer's setting (and changes with it), Light and Dark are kept for this site in
   localStorage; the switch in the drawer's head goes Auto, Light, Dark */
const THEMES = { auto: 1, light: 1, dark: 1 };
const darkMq = window.matchMedia ? window.matchMedia("(prefers-color-scheme: dark)") : null;
let themePick = (() => { try { return localStorage.getItem("review.theme") || "auto"; } catch { return "auto"; } })();
if (!THEMES[themePick]) themePick = "auto";
let themingTimer = 0;
function applyTheme(animate) {
  const dark = themePick === "dark" || (themePick === "auto" && !!darkMq?.matches);
  if (animate === true && host.getAttribute("data-theme") !== (dark ? "dark" : "light")) {
    host.setAttribute("data-theming", "");
    clearTimeout(themingTimer);
    themingTimer = setTimeout(() => host.removeAttribute("data-theming"), 420);
  }
  host.setAttribute("data-theme", dark ? "dark" : "light");
  root.querySelectorAll(".theme-switch .side").forEach((b) => b.setAttribute("aria-pressed", String(b.dataset.t === themePick)));
  if (PAGE_MODE) {
    if (animate === true) document.documentElement.style.transition = document.body.style.transition = "background-color .35s ease";
    document.documentElement.style.background = dark ? "hsl(217.5 63.16% 7.45%)" : "";
    document.body.style.background = dark ? "hsl(217.5 63.16% 7.45%)" : "";
    document.documentElement.style.colorScheme = dark ? "dark" : "";
  }
}
/* the change itself: where the browser can (View Transitions), it crossfades a picture of the old look into the new
   one, so no text is repainted mid-fade and nothing moves; elsewhere the colours ease across */
const reduceMq = window.matchMedia ? window.matchMedia("(prefers-reduced-motion: reduce)") : null;
/* the ripple (Nirav, 2026-10-23): the new theme spreads as a circle from the switch over the drawer. The page's own
   view transitions are left alone: our rules apply only while <html> carries rv-theme-vt. */
function rippleStyle() {
  if (document.getElementById("rv-theme-vt")) return;
  const st = document.createElement("style");
  st.id = "rv-theme-vt";
  st.textContent = ":root.rv-theme-vt::view-transition-old(root), :root.rv-theme-vt::view-transition-new(root) { animation: none; mix-blend-mode: normal; } :root.rv-theme-vt::view-transition-new(root) { z-index: 2147483647; }";
  (document.head || document.documentElement).appendChild(st);
}
function switchTheme(from) {
  if (reduceMq?.matches) return applyTheme(false);
  if (typeof document.startViewTransition === "function") {
    try {
      const b = (from || $(".theme-switch .side[aria-pressed='true']"))?.getBoundingClientRect();
      const x = b && b.width ? b.left + b.width / 2 : innerWidth - 40;
      const y = b && b.width ? b.top + b.height / 2 : 30;
      /* as far as the drawer's farthest corner (the page itself does not change), the window's when it is closed */
      const pr = $(".panel")?.getBoundingClientRect();
      const box = pr && pr.width && $(".panel").classList.contains("on") ? pr : { left: 0, top: 0, right: innerWidth, bottom: innerHeight };
      const r = Math.hypot(Math.max(x - box.left, box.right - x), Math.max(y - box.top, box.bottom - y));
      rippleStyle();
      document.documentElement.classList.add("rv-theme-vt");
      const vt = document.startViewTransition(() => applyTheme(false));
      vt.ready.then(() => document.documentElement.animate({ clipPath: [`circle(0px at ${x}px ${y}px)`, `circle(${r}px at ${x}px ${y}px)`] }, { duration: 620, easing: "cubic-bezier(.4,0,.2,1)", pseudoElement: "::view-transition-new(root)" })).catch(() => {});
      vt.finished.finally(() => document.documentElement.classList.remove("rv-theme-vt"));
      return;
    } catch {
      document.documentElement.classList.remove("rv-theme-vt");
    }
  }
  applyTheme(true);
}
root.querySelectorAll(".theme-switch .side").forEach((b) =>
  b.addEventListener("click", () => {
    if (b.dataset.t === themePick) return;
    themePick = b.dataset.t;
    try { localStorage.setItem("review.theme", themePick); } catch {}
    switchTheme(b); /* the ripple starts at the side clicked */
  }),
);
darkMq?.addEventListener?.("change", () => switchTheme());
applyTheme();
/* page mode: the panel is the page; "go to" hands over to the app */
if (PAGE_MODE) {
  host.setAttribute("data-page", "");
  host.style.position = "static";
  host.style.pointerEvents = "auto";
  document.title = "Review comments";
  openPanel(true);
  /* the extension's list page: "Back to the site" lives here, in the overlay, because the overlay sits in the
     browser's top layer and covers anything the page itself draws (the old link showed but could not be clicked) */
  const site = window.__reviewExt?.siteOrigin;
  if (site) {
    const back = document.createElement("a");
    back.className = "page-back";
    back.href = site;
    back.textContent = "← Back to the site";
    root.appendChild(back);
  }
}
/* the app, arriving from the page with a comment to open */
const pendingGoto = (() => {
  /* from the extension's list page or a route change on a site: the id rides in the hash */
  const m = location.hash.match(/#review-goto=([a-z0-9-]+)/i);
  if (m) {
    try {
      history.replaceState(null, "", location.pathname + location.search);
    } catch {}
    return m[1];
  }
  try {
    const id = sessionStorage.getItem("review.goto");
    if (id) sessionStorage.removeItem("review.goto");
    return id;
  } catch {
    return null;
  }
})();
if (!PAGE_MODE && pendingGoto) {
  const id = pendingGoto;
  const tryOpen = async (n) => {
    await loadComments();
$(".bar .k").textContent = `${MOD} + click to comment`;
    const c = state.comments.find((x) => x.id === id);
    if (c) goTo(c);
    else if (n > 0) setTimeout(() => tryOpen(n - 1), 500);
  };
  setTimeout(() => tryOpen(10), 1200);
}

/* ---------- the bar: draggable, docks at an edge as a round button, click to expand ---------- */
const mini = $(".bar-mini");
const BAR_KEY = "review.bar";
const barPos = (() => {
  try {
    return JSON.parse(localStorage.getItem(BAR_KEY) || "null") || { x: null, y: null, dock: null, along: 0.5 };
  } catch {
    return { x: null, y: null, dock: null, along: 0.5 };
  }
})();
const saveBar = () => {
  try {
    localStorage.setItem(BAR_KEY, JSON.stringify(barPos));
  } catch {}
};
const EDGE = 28; // this close to an edge on drop: dock
function placeBar() {
  if (PAGE_MODE) return;
  const W = window.innerWidth, H = window.innerHeight;
  if (barPos.dock) {
    bar.classList.add("hidden");
    mini.classList.add("on");
    const m = 40, gap = 10;
    let x, y;
    if (barPos.dock === "left" || barPos.dock === "right") {
      y = Math.min(H - m - gap, Math.max(gap, barPos.along * H - m / 2));
      x = barPos.dock === "left" ? gap : W - m - gap;
    } else {
      x = Math.min(W - m - gap, Math.max(gap, barPos.along * W - m / 2));
      y = barPos.dock === "top" ? gap : H - m - gap;
    }
    mini.style.left = `${x}px`;
    mini.style.top = `${y}px`;
    return;
  }
  mini.classList.remove("on");
  bar.classList.remove("hidden");
  const r = bar.getBoundingClientRect();
  let x = barPos.x, y = barPos.y;
  if (x == null || y == null) {
    x = (W - r.width) / 2;
    y = H - r.height - 12;
  }
  x = Math.min(W - r.width - 4, Math.max(4, x));
  y = Math.min(H - r.height - 4, Math.max(4, y));
  bar.style.left = `${x}px`;
  bar.style.top = `${y}px`;
}
function dockFor(x, y, w, h) {
  const W = window.innerWidth, H = window.innerHeight;
  const d = { left: x, right: W - (x + w), top: y, bottom: H - (y + h) };
  const [edge, dist] = Object.entries(d).sort((a, b) => a[1] - b[1])[0];
  return dist <= EDGE ? edge : null;
}
function dragify(el, onDrop) {
  let start = null;
  el.addEventListener("pointerdown", (e) => {
    if (e.button !== 0 || e.target.closest("button:not(.bar-mini), a")) return;
    const r = el.getBoundingClientRect();
    start = { x: e.clientX, y: e.clientY, left: r.left, top: r.top, w: r.width, h: r.height, moved: false };
    el.setPointerCapture(e.pointerId);
  });
  el.addEventListener("pointermove", (e) => {
    if (!start) return;
    const dx = e.clientX - start.x, dy = e.clientY - start.y;
    if (!start.moved && Math.hypot(dx, dy) < 4) return;
    start.moved = true;
    el.classList.add("dragging");
    el.style.left = `${start.left + dx}px`;
    el.style.top = `${start.top + dy}px`;
  });
  const end = (e) => {
    if (!start) return;
    const s = start;
    start = null;
    el.classList.remove("dragging");
    try {
      el.releasePointerCapture(e.pointerId);
    } catch {}
    onDrop(s.moved, parseFloat(el.style.left), parseFloat(el.style.top), s.w, s.h);
  };
  el.addEventListener("pointerup", end);
  el.addEventListener("pointercancel", end);
}
dragify(bar, (moved, x, y, w, h) => {
  if (!moved) return;
  const edge = dockFor(x, y, w, h);
  if (edge) {
    barPos.dock = edge;
    barPos.along = edge === "left" || edge === "right" ? (y + h / 2) / window.innerHeight : (x + w / 2) / window.innerWidth;
  } else {
    barPos.dock = null;
    barPos.x = x;
    barPos.y = y;
  }
  saveBar();
  placeBar();
});
dragify(mini, (moved, x, y, w, h) => {
  if (!moved) {
    /* a click: expand beside the edge it was docked at */
    const edge = barPos.dock;
    barPos.dock = null;
    const r = bar.getBoundingClientRect();
    const W = window.innerWidth, H = window.innerHeight;
    bar.classList.remove("hidden");
    const bw = bar.getBoundingClientRect().width || r.width, bh = bar.getBoundingClientRect().height || r.height;
    if (edge === "left") (barPos.x = 12), (barPos.y = y + h / 2 - bh / 2);
    else if (edge === "right") (barPos.x = W - bw - 12), (barPos.y = y + h / 2 - bh / 2);
    else if (edge === "top") (barPos.x = x + w / 2 - bw / 2), (barPos.y = 12);
    else (barPos.x = x + w / 2 - bw / 2), (barPos.y = H - bh - 12);
    saveBar();
    placeBar();
    return;
  }
  const edge = dockFor(x, y, w, h);
  if (edge) {
    barPos.dock = edge;
    barPos.along = edge === "left" || edge === "right" ? (y + h / 2) / window.innerHeight : (x + w / 2) / window.innerWidth;
  } else {
    /* dropped away from every edge: it becomes the full bar there */
    barPos.dock = null;
    barPos.x = x;
    barPos.y = y;
  }
  saveBar();
  placeBar();
});
$(".bar .dock").addEventListener("click", () => {
  const r = bar.getBoundingClientRect();
  const W = window.innerWidth, H = window.innerHeight;
  const cx = r.left + r.width / 2, cy = r.top + r.height / 2;
  const d = { left: cx, right: W - cx, top: cy, bottom: H - cy };
  const edge = Object.entries(d).sort((a, b) => a[1] - b[1])[0][0];
  barPos.dock = edge;
  barPos.along = edge === "left" || edge === "right" ? cy / H : cx / W;
  saveBar();
  placeBar();
});
window.addEventListener("resize", placeBar);
/* the mini mirrors the dot and the count */
const syncMini = () => {
  mini.querySelector(".mini-dot").classList.toggle("live", dot.classList.contains("live"));
  const n = mini.querySelector(".mini-n");
  n.textContent = state.count ? String(state.count) : "";
  n.classList.toggle("on", !!state.count);
};
new MutationObserver(syncMini).observe(dot, { attributes: true, attributeFilter: ["class"] });
const _updateBar = updateBar;
updateBar = function () {
  _updateBar();
  syncMini();
};
placeBar();
syncMini();
if (!PAGE_MODE) setReview(!state.off, true);

/* for drives and debugging from the console */
window.__review = { grabFrame, drawMarker, state, goTo, realType, realKey, realClick, realHover, setReview };
