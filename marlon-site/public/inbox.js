/* Private inbox for the contact form. The first visit sets the passcode; after that it signs in. */
(() => {
  const $ = (id) => document.getElementById(id);
  const KEY = "marlon.inbox";
  let token = null;
  try { token = sessionStorage.getItem(KEY); } catch {}
  const save = (t) => { token = t; try { t ? sessionStorage.setItem(KEY, t) : sessionStorage.removeItem(KEY); } catch {} };
  const api = async (path, body) => {
    const res = await fetch(path, body === undefined ? { headers: token ? { Authorization: `Bearer ${token}` } : {} }
      : { method: "POST", headers: { "Content-Type": "application/json", ...(token ? { Authorization: `Bearer ${token}` } : {}) }, body: JSON.stringify(body) });
    return { ok: res.ok, status: res.status, data: await res.json().catch(() => ({})) };
  };
  const el = (tag, attrs = {}, ...kids) => {
    const n = document.createElement(tag);
    for (const [k, v] of Object.entries(attrs)) { if (k === "class") n.className = v; else if (k.startsWith("on")) n.addEventListener(k.slice(2), v); else n.setAttribute(k, v); }
    for (const k of kids.flat()) if (k !== null && k !== undefined) n.append(k);
    return n;
  };
  let claimed = true;
  async function showGate() {
    $("inbox-loading").hidden = true; $("inbox-main").hidden = true; $("inbox-gate").hidden = false;
    const s = await api("/api/inbox/state");
    claimed = Boolean(s.data.claimed);
    $("inbox-gate-title").textContent = claimed ? "Sign in" : "Choose the inbox passcode";
    $("inbox-gate-help").textContent = claimed ? "Type the inbox passcode." : "First visit: choose a passcode of at least 10 characters. Only this passcode will open the inbox.";
    $("inbox-pass2-wrap").hidden = claimed;
    $("inbox-pass").autocomplete = claimed ? "current-password" : "new-password";
    $("inbox-go").textContent = claimed ? "Sign in" : "Set passcode and open";
    $("inbox-pass").focus();
  }
  async function showInbox() {
    const r = await api("/api/inbox/messages");
    if (r.status === 401) { save(null); return showGate(); }
    $("inbox-loading").hidden = true; $("inbox-gate").hidden = true; $("inbox-main").hidden = false;
    const list = r.data.messages || [];
    const open = list.filter((m) => !m.done).length;
    $("inbox-count").textContent = list.length ? `${list.length} message${list.length === 1 ? "" : "s"} · ${open} not handled yet` : "No messages yet.";
    $("inbox-list").replaceChildren(...list.map((m) => el("article", { class: m.done ? "msg done" : "msg" },
      el("div", { class: "msg-head" }, el("b", {}, `${m.name} · ${m.company}`), el("span", { class: "fine" }, new Date(m.created).toLocaleString())),
      el("div", { class: "msg-meta" }, `${m.topic} · ${m.reps}${m.role ? ` · ${m.role}` : ""} · `, el("a", { href: `mailto:${m.email}` }, m.email)),
      el("div", { class: "msg-body" }, m.message),
      el("div", { class: "msg-actions" },
        el("a", { class: "btn btn-primary", href: `mailto:${m.email}?subject=${encodeURIComponent(`Re: ${m.topic} (Marlon)`)}` }, "Reply by email"),
        el("button", { class: "btn btn-ghost", type: "button", onclick: async () => { await api("/api/inbox/mark", { id: m.id, done: !m.done }); showInbox(); } }, m.done ? "Mark not handled" : "Mark handled"),
        el("button", { class: "btn btn-danger", type: "button", onclick: async () => { if (confirm(`Delete the message from ${m.name}? This can't be undone.`)) { await api("/api/inbox/delete", { id: m.id }); showInbox(); } } }, "Delete")))));
  }
  $("inbox-form").addEventListener("submit", async (e) => {
    e.preventDefault();
    const p = $("inbox-pass").value, msg = $("inbox-msg");
    msg.textContent = "";
    if (!claimed) {
      if (p.length < 10) { msg.textContent = "Choose a passcode of at least 10 characters."; return; }
      if (p !== $("inbox-pass2").value) { msg.textContent = "The two passcodes don't match."; return; }
    }
    $("inbox-go").disabled = true;
    const r = await api(claimed ? "/api/inbox/login" : "/api/inbox/claim", { passcode: p });
    $("inbox-go").disabled = false;
    if (!r.ok) { msg.textContent = r.data.error || "That didn't work."; if (r.status === 409) showGate(); return; }
    save(r.data.token); $("inbox-pass").value = ""; $("inbox-pass2").value = "";
    showInbox();
  });
  $("inbox-refresh").addEventListener("click", showInbox);
  $("inbox-out").addEventListener("click", async () => { await api("/api/inbox/logout", {}); save(null); showGate(); });
  (token ? showInbox() : showGate()).catch(() => { $("inbox-loading").textContent = "No connection. Reload to try again."; });
})();
