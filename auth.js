// Sign-in with GitHub, through the hub's own auth (Supabase Auth, GitHub provider), PKCE in a tab.
// The extension opens GitHub's page in a tab; GitHub tells Supabase who the person is; Supabase sends a one-time
// code back to the sign-in page on the install site (hub.json "authPage", listed in the hub's allowed redirect
// URLs); the background sees that address appear in the tab, trades the code plus the verifier only it holds for
// the session, and closes the tab. The code alone opens nothing. The session is kept in extension storage and
// refreshed before it runs out; the hub calls carry its token, so comments are made by a verified GitHub account.
// (Not chrome.identity.launchWebAuthFlow: Firefox 156+ no longer catches its fake redirect address and the window
// ends on "server not found".)
const KEY = "session";
const PENDING = "signin"; // { verifier, tabId, at } while a sign-in tab is open

export function makeAuth(getConfig, onSignedIn) {
  async function saved() {
    return (await chrome.storage.local.get(KEY))[KEY] || null;
  }
  async function keep(session) {
    await chrome.storage.local.set({ [KEY]: session });
    return session;
  }
  /* the person in a session: handle, name, avatar, from GitHub's details on the account */
  function personOf(session) {
    const u = session?.user;
    if (!u) return null;
    const m = u.user_metadata || {};
    const handle = m.user_name || m.preferred_username || (u.email || "").split("@")[0] || u.id;
    return { id: u.id, handle, name: m.full_name || m.name || handle, avatar: m.avatar_url || null, email: u.email || null };
  }
  async function refresh(session) {
    const cfg = await getConfig();
    const r = await fetch(`${cfg.url}/auth/v1/token?grant_type=refresh_token`, { method: "POST", headers: { apikey: cfg.key, "Content-Type": "application/json" }, body: JSON.stringify({ refresh_token: session.refresh_token }) });
    if (!r.ok) {
      await chrome.storage.local.remove(KEY);
      return null;
    }
    const j = await r.json();
    return keep({ access_token: j.access_token, refresh_token: j.refresh_token, expires_at: Math.floor(Date.now() / 1000) + (j.expires_in || 3600), user: j.user || session.user });
  }
  /* PKCE: a random verifier, its SHA-256 as the challenge the hub keeps until the code comes back */
  const b64url = (bytes) => btoa(String.fromCharCode(...new Uint8Array(bytes))).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
  async function pkce() {
    const verifier = b64url(crypto.getRandomValues(new Uint8Array(48)));
    const challenge = b64url(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(verifier)));
    return { verifier, challenge };
  }
  const listeners = new Set(); // who wants to hear the sign-in finish (the popup, when still open)
  const tell = (result) => {
    for (const fn of [...listeners]) fn(result);
  };

  /* the code came back in the sign-in tab: trade it for the session, close the tab */
  async function finish(tabId, url) {
    const pending = (await chrome.storage.local.get(PENDING))[PENDING];
    if (!pending || pending.tabId !== tabId) return;
    const cfg = await getConfig();
    if (!url.startsWith(cfg.authPage)) return;
    const u = new URL(url);
    const q = u.searchParams, h = new URLSearchParams(u.hash.replace(/^#/, ""));
    const code = q.get("code");
    const error = q.get("error_description") || h.get("error_description") || q.get("error") || h.get("error");
    if (!code && !error) return;
    await chrome.storage.local.remove(PENDING);
    let result;
    try {
      if (error) throw new Error(error);
      const r = await fetch(`${cfg.url}/auth/v1/token?grant_type=pkce`, { method: "POST", headers: { apikey: cfg.key, "Content-Type": "application/json" }, body: JSON.stringify({ auth_code: code, code_verifier: pending.verifier }) });
      const j = await r.json().catch(() => ({}));
      if (!r.ok || !j.access_token) throw new Error(j.error_description || j.msg || j.error || `the hub answered ${r.status}`);
      const session = await keep({ access_token: j.access_token, refresh_token: j.refresh_token, expires_at: Math.floor(Date.now() / 1000) + Number(j.expires_in || 3600), user: j.user });
      result = { ok: true, person: personOf(session) };
      chrome.tabs.remove(tabId).catch(() => {});
      if (onSignedIn) await onSignedIn(result.person).catch((e) => console.warn("[review] after sign-in:", e.message));
    } catch (e) {
      result = { ok: false, error: String(e?.message || e) };
    }
    tell(result);
    return result;
  }
  // the sign-in tab's address changes are watched from the start, so the background wakes for them too
  chrome.tabs.onUpdated.addListener((tabId, info) => {
    if (info.url) finish(tabId, info.url);
  });
  chrome.tabs.onRemoved.addListener(async (tabId) => {
    const pending = (await chrome.storage.local.get(PENDING))[PENDING];
    if (pending?.tabId === tabId) {
      await chrome.storage.local.remove(PENDING);
      tell({ ok: false, error: "the GitHub tab was closed" });
    }
  });

  return {
    /* a valid session, refreshed when within two minutes of running out; null when signed out */
    async session() {
      let s = await saved();
      if (!s) return null;
      if (!s.expires_at || s.expires_at - Math.floor(Date.now() / 1000) < 120) s = await refresh(s);
      return s;
    },
    async token() {
      return (await this.session())?.access_token || null;
    },
    async person() {
      return personOf(await this.session());
    },
    /* the sign-in itself: GitHub's page in a new tab; resolves when the session is in, or when the tab is closed */
    async signIn() {
      const cfg = await getConfig();
      const { verifier, challenge } = await pkce();
      const url = `${cfg.url}/auth/v1/authorize?provider=github&redirect_to=${encodeURIComponent(cfg.authPage)}&code_challenge=${challenge}&code_challenge_method=s256`;
      const tab = await chrome.tabs.create({ url, active: true });
      await chrome.storage.local.set({ [PENDING]: { verifier, tabId: tab.id, at: Date.now() } });
      return new Promise((resolve) => {
        const fn = (r) => {
          listeners.delete(fn);
          resolve(r);
        };
        listeners.add(fn);
      });
    },
    /* a sign-in tab left open from before (the background may have slept meanwhile) */
    pending() {
      return chrome.storage.local.get(PENDING).then((s) => s[PENDING] || null);
    },
    async signOut() {
      const s = await saved();
      const cfg = await getConfig();
      if (s?.access_token) fetch(`${cfg.url}/auth/v1/logout`, { method: "POST", headers: { apikey: cfg.key, Authorization: `Bearer ${s.access_token}` } }).catch(() => {});
      await chrome.storage.local.remove(KEY);
    },
  };
}
