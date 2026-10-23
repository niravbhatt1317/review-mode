// The toolbar popup: switch this site on with a project name (suggested from the address, or picked from the
// hub's existing projects), open its list, or switch it off.
const $ = (s) => document.querySelector(s);
/* the tab this is about: the active one, or, when the popup itself is a tab, the web tab used last */
const tabs = await chrome.tabs.query({ currentWindow: true });
let tab = tabs.find((t) => t.active);
if (!tab || !/^https?:/.test(tab.url || "")) tab = tabs.filter((t) => /^https?:/.test(t.url || "")).sort((a, b) => (b.lastAccessed || 0) - (a.lastAccessed || 0))[0] || tab;
const url = tab?.url || "";
const ok = /^https?:/.test(url);
const origin = ok ? new URL(url).origin : null;
const saved = await chrome.storage.local.get(["who", "sites"]);
const sites = saved.sites || {};
const me = await new Promise((res) => chrome.runtime.sendMessage({ type: "review-whoami" }, (r) => res(r || null)));
if (ok && !me?.signedIn) {
  /* not signed in: that comes first, whatever the site's state */
  $("#authPanel").hidden = false;
  $("#signIn").addEventListener("click", () => {
    $("#signIn").classList.add("busy");
    $("#signIn").querySelector(".lbl").textContent = "Opening GitHub…";
    $("#authErr").textContent = "";
    chrome.runtime.sendMessage({ type: "review-sign-in" }, (r) => {
      if (r?.ok) location.reload();
      else {
        $("#signIn").classList.remove("busy");
        $("#signIn").querySelector(".lbl").textContent = "Sign in with GitHub";
        $("#authErr").textContent = `Could not sign in: ${r?.error || "no answer"}`;
      }
    });
  });
}
$("#opts").addEventListener("click", (e) => { e.preventDefault(); chrome.runtime.openOptionsPage(); });
$("#signOut").addEventListener("click", (e) => { e.preventDefault(); chrome.runtime.sendMessage({ type: "review-sign-out" }, () => location.reload()); });
/* the person's picture, or their initial in a circle when there is none or it fails to load */
function showAvatar(el, me) {
  const initial = (me.name || me.handle || "?").trim()[0].toUpperCase();
  if (!me.avatar) return (el.textContent = initial);
  const img = document.createElement("img");
  img.className = "av";
  img.alt = "";
  img.src = me.avatar;
  img.onerror = () => { el.textContent = initial; };
  el.replaceWith(img);
  img.id = "pav";
}
if (me?.signedIn) {
  $("#whoLine").hidden = false;
  $("#who").textContent = me.name || me.handle;
  $("#handle").textContent = `@${me.handle}`;
  showAvatar($("#pav"), me);
}
$("#ver").textContent = chrome.runtime.getManifest().version;
if (!ok) {
  $("#na").hidden = false;
  $("#site").hidden = true;
} else {
  $("#siteName").textContent = new URL(origin).host;
  $("#site").classList.toggle("on", !!sites[origin] && !!me?.signedIn);
  if (!me?.signedIn) {
    /* the sign-in panel is up; the rest waits */
  } else if (sites[origin]) {
    $("#onPanel").hidden = false;
    /* the project rides on the chip when it is not simply the site's own name */
    if (sites[origin].project !== new URL(origin).host && sites[origin].project !== new URL(origin).hostname) $("#siteProj").textContent = ` · ${sites[origin].project}`;
    $("#list").addEventListener("click", () => chrome.tabs.create({ url: chrome.runtime.getURL(`list.html?project=${encodeURIComponent(sites[origin].project)}`) }));
    $("#off").addEventListener("click", async () => {
      delete sites[origin];
      await chrome.storage.local.set({ sites });
      chrome.action.setBadgeText({ tabId: tab.id, text: "" });
      chrome.tabs.reload(tab.id);
      window.close();
    });
  } else {
    $("#offPanel").hidden = false;
    const input = $("#project");
    input.value = suggest(url);
    chrome.runtime.sendMessage({ type: "review-projects" }, (names) => {
      for (const n of names || []) {
        const o = document.createElement("option");
        o.value = n;
        $("#projects").appendChild(o);
      }
    });
    const go = async () => {
      const project = input.value.trim().toLowerCase().replace(/[^a-z0-9._-]+/g, "-").replace(/^-|-$/g, "");
      if (!project) return input.focus();
      try {
        const granted = await chrome.permissions.request({ origins: [`${origin}/*`] });
        if (!granted) return;
      } catch {}
      sites[origin] = { project };
      await chrome.storage.local.set({ sites });
      chrome.runtime.sendMessage({ type: "review-switch-on", tabId: tab.id, origin }, () => window.close());
    };
    $("#on").addEventListener("click", go);
    input.addEventListener("keydown", (e) => e.key === "Enter" && go());
    input.focus();
    input.select();
  }
}
/* a name from the address: the console's project on its dev server, the repo for GitHub Pages, host:port for local
   and internal addresses, the host name for everything else */
function suggest(u) {
  const x = new URL(u);
  if (x.host === "localhost:4178") return "next-gen-console";
  if (/\.github\.io$/.test(x.hostname)) return x.pathname.split("/").filter(Boolean)[0] || x.hostname.split(".")[0];
  if (/^(localhost|127\.0\.0\.1|10\.|192\.168\.|172\.(1[6-9]|2\d|3[01])\.)/.test(x.host)) return x.host.replace(/[:.]/g, "-");
  return x.hostname.replace(/^www\./, "");
}
