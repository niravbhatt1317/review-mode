// Sign-in with GitHub, through the hub's own auth (Supabase Auth, GitHub provider). The browser opens GitHub's page,
// GitHub tells Supabase who the person is, Supabase sends the session back to the extension's redirect address
// (https://<id>.chromiumapp.org/ in Chrome and Edge, https://<id>.extensions.allizom.org/ in Firefox; both are
// listed in the hub's allowed redirect URLs). The session is kept in extension storage and refreshed before it
// runs out; the hub calls carry its token, so comments are made by a verified GitHub account.
const KEY = "session";

export function makeAuth(getConfig) {
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
    /* the sign-in itself: GitHub's page in a small window, the session back through the redirect address */
    async signIn() {
      const cfg = await getConfig();
      const redirect = chrome.identity.getRedirectURL();
      const url = `${cfg.url}/auth/v1/authorize?provider=github&redirect_to=${encodeURIComponent(redirect)}`;
      const back = await chrome.identity.launchWebAuthFlow({ url, interactive: true });
      const hash = new URL(back).hash.replace(/^#/, "");
      const q = new URLSearchParams(hash);
      const access = q.get("access_token");
      if (!access) throw new Error(q.get("error_description") || q.get("error") || "no session came back");
      const u = await fetch(`${cfg.url}/auth/v1/user`, { headers: { apikey: cfg.key, Authorization: `Bearer ${access}` } });
      const user = u.ok ? await u.json() : null;
      const session = await keep({ access_token: access, refresh_token: q.get("refresh_token"), expires_at: Math.floor(Date.now() / 1000) + Number(q.get("expires_in") || 3600), user });
      return personOf(session);
    },
    async signOut() {
      const s = await saved();
      const cfg = await getConfig();
      if (s?.access_token) fetch(`${cfg.url}/auth/v1/logout`, { method: "POST", headers: { apikey: cfg.key, Authorization: `Bearer ${s.access_token}` } }).catch(() => {});
      await chrome.storage.local.remove(KEY);
    },
  };
}
