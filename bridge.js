// The bridge between a page's overlay and the extension: the page posts a request, the reply comes back the same
// way. Two kinds: a picture (review-capture-request) and a hub call (review-api-request, the collector's endpoints
// answered by background.js). On load the page asks whether its site is switched on; if so the overlay is injected.
// After the extension is reloaded or updated, a page that was already open keeps an orphaned copy of this script:
// every call then fails with "Extension context invalidated", which is answered as an error so the overlay can say
// "reload this page" instead of waiting.
let gone = false; // the extension was reloaded or updated: this copy of the bridge is orphaned
const GONE = "the extension was reloaded: reload this page";
function alive() {
  if (gone) return false;
  try {
    if (!chrome.runtime?.id) gone = true;
  } catch {
    gone = true;
  }
  return !gone;
}
function send(msg, cb) {
  if (!alive()) return cb(null, GONE);
  try {
    chrome.runtime.sendMessage(msg, (res) => {
      let err = null;
      try {
        err = chrome.runtime.lastError?.message || null;
      } catch {
        gone = true;
        err = GONE;
      }
      try {
        cb(res, err);
      } catch {}
    });
  } catch (e) {
    gone = gone || /invalidated|undefined/.test(String(e?.message));
    try {
      cb(null, gone ? GONE : String(e?.message || e));
    } catch {}
  }
}
window.addEventListener("message", (e) => {
  if (e.source !== window || !e.data?.type) return;
  if (e.data.type === "review-capture-request") {
    send({ type: "review-capture" }, (res, err) => {
      window.postMessage({ type: "review-capture-reply", id: e.data.id, ok: !!res?.ok, dataUrl: res?.dataUrl || null, error: res?.error || err || null }, "*");
    });
  } else if (e.data.type === "review-open") {
    send({ type: "review-open", url: e.data.url }, () => {});
  } else if (e.data.type === "review-api-request") {
    const { id, path, query, method, body } = e.data;
    send({ type: "review-api", path, query, method, body }, (res, err) => {
      window.postMessage({ type: "review-api-reply", id, ok: !!res?.ok, status: res?.status || (err ? 503 : 500), body: res?.body ?? { error: err || "no answer" } }, "*");
    });
  }
});
// let the overlay know the extension is here
document.documentElement.setAttribute("data-review-ext", "1");
window.postMessage({ type: "review-ext-ready" }, "*");
// is this site on? (the console's dev server carries its own overlay: then only pictures are wanted)
send({ type: "review-host?", devServer: !!document.querySelector('script[src^="/__review/overlay.js"]') }, () => {});
