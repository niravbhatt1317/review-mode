// The extension's list page: the same panel as the page view on the dev server, for one project. It sets what the
// overlay needs, loads it, and stands in for the bridge (content scripts do not run on extension pages).
const project = new URLSearchParams(location.search).get("project") || "";
window.addEventListener("message", (e) => {
  if (e.source !== window || e.data?.type !== "review-api-request") return;
  const { id, path, query, method, body } = e.data;
  chrome.runtime.sendMessage({ type: "review-api", path, query, method, body, origin: `ext:${project}` }, (res) => {
    window.postMessage({ type: "review-api-reply", id, ok: !!res?.ok, status: res?.status || 500, body: res?.body ?? { error: chrome.runtime.lastError?.message || "no answer" } }, "*");
  });
});
chrome.storage.local.get(["who", "sites"]).then((saved) => {
  const site = Object.entries(saved.sites || {}).find(([, s]) => s.project === project);
  document.title = `Review · ${project}`;
  const back = document.querySelector("#back");
  if (site) back.href = site[0];
  else back.remove();
  const s = document.createElement("script");
  s.src = "overlay.js";
  s.dataset.project = project;
  window.__reviewExt = { project, who: saved.who || "", listUrl: location.pathname + `?project=${encodeURIComponent(project)}`, siteOrigin: site ? site[0] : null };
  document.body.appendChild(s);
});
