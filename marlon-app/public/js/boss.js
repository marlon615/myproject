/**
 * The boss dashboard (/boss?b=<boss key>), for a team buyer's boss, on his own phone.
 *  - The boss link activates this phone (the boss key and a random phone id are kept on the phone).
 *  - The first time, the boss sets his own passcode; after that it asks for it (5 wrong tries per 15 minutes).
 *  - Shows every invoice from every rep: which rep, the customer, the products, the total, paid or not paid,
 *    with totals for today, this week (Monday to Sunday) and this month per rep and for the whole company.
 *  - The boss can tick any rep's invoice as paid ("Mark paid"); it then shows as paid on the rep's phone too.
 *    That's the only change the boss can make: no writing or editing invoices.
 *  - Refreshes every 30 seconds while open. Offline, it shows what it last loaded (and says when that was).
 */
const root = document.getElementById("boss");
const KEY = /^[0-9a-f]{32}$/;
const STORE = "marlon.boss";        // { boss, device } on this phone
const CACHE = "marlon.boss.data";   // the last data loaded, for offline
const TOKEN = "marlon.boss.token";  // signed in, this tab only
const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
const get = (k, store = localStorage) => { try { return JSON.parse(store.getItem(k) || "null"); } catch { return null; } };
const put = (k, v, store = localStorage) => { try { if (v === null) store.removeItem(k); else store.setItem(k, JSON.stringify(v)); } catch { /* private mode */ } };
const money = (n) => Number(n || 0).toLocaleString("en-US", { style: "currency", currency: "USD" });
const iso = (d) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
const dateText = (s) => { if (!s) return ""; const [y, m, d] = s.split("-").map(Number); return `${d} ${MONTHS[m - 1]} ${y}`; };
const qtyText = (q, unit) => (q === null || q === undefined ? "" : unit === "dozen" ? `${q} dozen` : unit === "lb" ? `${q} lb` : unit === "bag" ? `${q} bag${q === 1 ? "" : "s"}` : String(q));

function el(tag, props = {}, ...kids) {
  const n = document.createElement(tag);
  for (const [k, v] of Object.entries(props)) {
    if (v === null || v === undefined || v === false) continue;
    if (k.startsWith("on")) n.addEventListener(k.slice(2), v);
    else if (k === "class") n.className = v;
    else n.setAttribute(k, v === true ? "" : String(v));
  }
  for (const k of kids.flat()) if (k !== null && k !== undefined && k !== false) n.append(k instanceof Node ? k : document.createTextNode(String(k)));
  return n;
}
const show = (...nodes) => root.replaceChildren(...nodes.filter((n) => n !== null && n !== undefined && n !== false));

async function call(path, { method = "GET", body, auth = false } = {}) {
  const headers = { "content-type": "application/json" };
  if (auth) headers.Authorization = `Bearer ${get(TOKEN, sessionStorage) || ""}`;
  const res = await fetch(path, { method, headers, body: body ? JSON.stringify(body) : undefined, cache: "no-store" });
  let data = {};
  try { data = await res.json(); } catch { /* empty */ }
  return { ok: res.ok, status: res.status, data };
}

function blocked(title, text, contact) {
  show(el("div", { class: "card boss-card boss-gate", role: "alert", "data-reason": "blocked" },
    el("h1", {}, title), el("p", { class: "boss-lead" }, text),
    el("p", { class: "boss-error" }, contact ? `To get access, contact ${contact}.` : "To get access, contact the person who sold you Marlon."),
    el("button", { type: "button", class: "btn btn-primary", onclick: () => location.reload() }, "Try again")));
}

// ── Start: activate this phone, then the passcode ───────────────────────

async function start() {
  let me = get(STORE);
  const fromUrl = new URL(location.href).searchParams.get("b");
  if (fromUrl && KEY.test(fromUrl) && me?.boss !== fromUrl) me = { boss: fromUrl, device: me?.device || randomId() };
  if (!me?.boss) { blocked("Open your boss link", "The boss dashboard opens only from the boss link you got with your team's Marlon. Open that link on this phone.", ""); return; }
  if (!me.device) me.device = randomId();
  put(STORE, me);
  // (The boss link stays in the address, so a Home Screen icon made from this page opens the same dashboard.)
  let r;
  try { r = await call("/api/boss/activate", { method: "POST", body: me }); } catch { r = null; }
  if (!r) { const cached = get(CACHE); if (cached) { render(cached, true); return; } blocked("Connect to the internet", "The boss dashboard needs the internet to load your team's invoices.", ""); return; }
  if (!r.ok) {
    if (r.data.reason === "full") blocked("This boss link is already in use", "This boss link is already open on all the phones it allows.", r.data.contact);
    else if (r.data.reason === "off") blocked("Switched off", "This phone's access to the boss dashboard has been switched off.", r.data.contact);
    else blocked("This link doesn't work", "This boss link isn't valid.", r.data.contact);
    return;
  }
  if (get(TOKEN, sessionStorage)) { load(); return; }
  gate(r.data.claimed, r.data.company);
}

function randomId() { return Array.from(crypto.getRandomValues(new Uint8Array(16)), (b) => b.toString(16).padStart(2, "0")).join(""); }

function gate(claimed, company, message = "") {
  const pass = el("input", { type: "password", id: "boss-pass", minlength: "6", autocomplete: claimed ? "current-password" : "new-password" });
  const again = claimed ? null : el("input", { type: "password", id: "boss-pass2", minlength: "6", autocomplete: "new-password" });
  const error = el("p", { class: "boss-error", role: "alert", hidden: !message }, message);
  const submit = el("button", { type: "submit", class: "btn btn-primary" }, claimed ? "Open the dashboard" : "Set passcode and open");
  show(el("form", { class: "card boss-card boss-gate", novalidate: true, onsubmit: async (e) => {
    e.preventDefault();
    error.hidden = true;
    if (pass.value.length < 6) { error.textContent = "The passcode needs at least 6 characters."; error.hidden = false; return; }
    if (!claimed && pass.value !== again.value) { error.textContent = "The two passcodes don't match."; error.hidden = false; return; }
    submit.disabled = true;
    const me = get(STORE);
    const r = await call(claimed ? "/api/boss/login" : "/api/boss/claim", { method: "POST", body: { ...me, passcode: pass.value } }).catch(() => ({ ok: false, data: { error: "No connection. Try again when you're online." } }));
    submit.disabled = false;
    if (r.ok && r.data.token) { put(TOKEN, r.data.token, sessionStorage); load(); return; }
    if (r.status === 409) { gate(true, company, r.data.error); return; }
    if (r.data.reason === "off") { blocked("Switched off", "This phone's access to the boss dashboard has been switched off.", r.data.contact); return; }
    error.textContent = r.data.error || "That didn't work. Please try again.";
    error.hidden = false;
  } },
  el("h1", {}, company || "Boss dashboard"),
  el("p", { class: "boss-lead" }, claimed ? "Enter your boss passcode." : "First time here: choose a passcode for your boss dashboard (at least 6 characters). Only someone with it can see your team's invoices."),
  el("label", {}, "Passcode", pass), again ? el("label", {}, "Type it again", again) : null, error, submit));
  pass.focus();
}

// ── The dashboard ────────────────────────────────────────────────────────

/** The one change the boss can make: tick a rep's invoice as paid (it then shows as paid on the rep's phone too). */
async function markPaid(inv, rep, button, data) {
  const what = `No. ${String(inv.number || "").padStart(4, "0")} · ${inv.store || "no customer name"} · ${money(inv.total)}`;
  if (!confirm(`Mark this invoice as paid?\n\n${what}\nby ${rep || "a rep"}\n\nIt will show as paid on ${rep || "the rep"}'s phone too.`)) return;
  button.disabled = true;
  let r;
  try { r = await call("/api/boss/paid", { method: "POST", body: { id: inv.id }, auth: true }); } catch { r = null; }
  if (!r) { button.disabled = false; alert("No connection. Try again when you're online."); return; }
  if (r.status === 401) { put(TOKEN, null, sessionStorage); start(); return; }
  if (r.status === 403) { put(TOKEN, null, sessionStorage); blocked("Switched off", "This phone's access to the boss dashboard has been switched off.", r.data.contact); return; }
  if (!r.ok) { button.disabled = false; alert(r.data.error || "That didn't work. Please try again."); return; }
  const i = data.invoices.findIndex((x) => x.id === inv.id);
  if (i >= 0) data.invoices[i] = { ...data.invoices[i], payment: r.data.invoice.payment };
  put(CACHE, data);
  render(data, false);
}

let refreshTimer = 0;
async function load() {
  clearTimeout(refreshTimer);
  let r;
  try { r = await call("/api/boss/data", { auth: true }); } catch { r = null; }
  if (!r) { const cached = get(CACHE); if (cached) render(cached, true); else show(el("p", { class: "boss-error" }, "No connection. Try again when you're online.")); }
  else if (r.status === 401) { put(TOKEN, null, sessionStorage); start(); return; }
  else if (r.status === 403) { put(TOKEN, null, sessionStorage); blocked("Switched off", "This phone's access to the boss dashboard has been switched off.", r.data.contact); return; }
  else if (r.ok) { const data = { ...r.data, loadedAt: new Date().toISOString() }; put(CACHE, data); render(data, false); }
  refreshTimer = setTimeout(load, 30000);
}

const view = { rep: "all", status: "all" };

function periods(now = new Date()) {
  const today = iso(now);
  const monday = new Date(now); monday.setDate(now.getDate() - ((now.getDay() + 6) % 7));
  return { today, week: iso(monday), month: today.slice(0, 8) + "01" };
}

function render(data, offline) {
  const p = periods();
  const repName = new Map(data.reps.map((r) => [r.device, r.name]));
  const isPaid = (inv) => inv.payment?.status === "paid";
  const sum = (list) => list.reduce((n, inv) => n + Math.round((inv.total || 0) * 100), 0) / 100;
  const inRange = (from) => (inv) => inv.date && inv.date >= from && inv.date <= p.today;
  const all = [...data.invoices].sort((a, b) => (b.date || "").localeCompare(a.date || "") || (b.number || 0) - (a.number || 0));
  const row = (label, list) => el("tr", {}, el("td", {}, label),
    el("td", { class: "num" }, money(sum(list.filter(inRange(p.today))))), el("td", { class: "num" }, money(sum(list.filter(inRange(p.week))))),
    el("td", { class: "num" }, money(sum(list.filter(inRange(p.month))))));
  const reps = data.reps.map((r) => ({ ...r, list: all.filter((inv) => inv.rep === r.device) }));
  const unpaid = all.filter((inv) => !isPaid(inv));

  const shown = all.filter((inv) => (view.rep === "all" || inv.rep === view.rep) && (view.status === "all" || (view.status === "paid") === isPaid(inv)));
  const repSel = el("select", { "aria-label": "Rep", id: "boss-rep", onchange: (e) => { view.rep = e.target.value; render(data, offline); } },
    el("option", { value: "all" }, "All reps"), data.reps.map((r) => el("option", { value: r.device }, r.name)));
  repSel.value = view.rep;
  const statusSel = el("select", { "aria-label": "Paid or not", id: "boss-status", onchange: (e) => { view.status = e.target.value; render(data, offline); } },
    el("option", { value: "all" }, "Paid and not paid"), el("option", { value: "unpaid" }, "Not paid"), el("option", { value: "paid" }, "Paid"));
  statusSel.value = view.status;

  show(
    el("div", {}, el("h1", {}, data.company), el("p", { class: "boss-lead" }, `${all.length} invoice${all.length === 1 ? "" : "s"} from ${data.reps.length} rep${data.reps.length === 1 ? "" : "s"}`)),
    offline ? el("p", { class: "boss-error" }, `No connection: showing what was loaded at ${new Date(data.loadedAt).toLocaleString()}.`) : null,
    el("div", { class: "boss-tiles" },
      el("div", { class: "card boss-tile" }, el("p", { class: "boss-tile-label" }, "Today"), el("p", { class: "boss-tile-value num", "data-total": "today" }, money(sum(all.filter(inRange(p.today)))))),
      el("div", { class: "card boss-tile" }, el("p", { class: "boss-tile-label" }, "This week"), el("p", { class: "boss-tile-value num", "data-total": "week" }, money(sum(all.filter(inRange(p.week)))))),
      el("div", { class: "card boss-tile" }, el("p", { class: "boss-tile-label" }, "This month"), el("p", { class: "boss-tile-value num", "data-total": "month" }, money(sum(all.filter(inRange(p.month))))))),
    el("p", { class: "boss-note" }, `Not paid: ${money(sum(unpaid))} on ${unpaid.length} invoice${unpaid.length === 1 ? "" : "s"}. Weeks run Monday to Sunday.`),
    el("section", { class: "card boss-card" }, el("h2", {}, "By rep"),
      el("table", { class: "boss-table", id: "boss-reps" },
        el("thead", {}, el("tr", {}, el("th", {}, "Rep"), el("th", {}, "Today"), el("th", {}, "This week"), el("th", {}, "This month"))),
        el("tbody", {}, reps.map((r) => row(r.off ? `${r.name} (switched off)` : r.name, r.list))),
        el("tfoot", {}, row("Whole company", all)))),
    el("section", { "aria-labelledby": "boss-h-inv" }, el("h2", { id: "boss-h-inv" }, "Invoices"),
      el("div", { class: "boss-filters" }, repSel, statusSel),
      shown.length ? el("ul", { class: "boss-list" }, shown.map((inv) => el("li", { class: "card boss-inv", "data-id": inv.id },
        el("div", { class: "boss-inv-head" }, el("strong", {}, inv.store || "No customer name"), el("strong", { class: "num" }, money(inv.total))),
        el("p", { class: "boss-inv-meta" }, `No. ${String(inv.number || "").padStart(4, "0")} · ${dateText(inv.date)} · by ${repName.get(inv.rep) || "a rep"}`),
        el("ul", { class: "boss-items" }, inv.items.map((it) => el("li", {}, el("span", {}, `${qtyText(it.qty, it.unit)} × ${it.name}`), el("span", { class: "num" }, it.price === null ? "no price" : money(it.total))))),
        el("div", { class: "boss-pay" },
          el("span", { class: `boss-badge ${isPaid(inv) ? "is-paid" : "is-unpaid"}` }, isPaid(inv) ? (inv.payment?.markedBy === "boss" ? "Paid · marked by you" : "Paid") : inv.payment?.dueDate ? `Not paid · due ${dateText(inv.payment.dueDate)}` : "Not paid"),
          isPaid(inv) ? null : el("button", { type: "button", class: "btn boss-mark-paid", onclick: (e) => markPaid(inv, repName.get(inv.rep), e.currentTarget, data) }, "Mark paid"))))) :
        el("p", { class: "boss-note" }, all.length ? "No invoices match." : "No invoices yet. They appear here as soon as your reps' phones are online.")),
    el("p", { class: "boss-note" }, `Updated ${new Date(data.loadedAt).toLocaleTimeString([], { hour: "numeric", minute: "2-digit" })}. New invoices appear within about a minute of a rep's phone being online.`),
    el("div", { class: "boss-actions" },
      el("button", { type: "button", class: "btn", onclick: () => load() }, "Refresh"),
      el("button", { type: "button", class: "btn btn-ghost", onclick: async () => { await call("/api/boss/logout", { method: "POST", auth: true }).catch(() => {}); put(TOKEN, null, sessionStorage); put(CACHE, null); start(); } }, "Lock")));
}

start();
window.__boss = { ready: true };
if ("serviceWorker" in navigator) navigator.serviceWorker.register("/sw.js").catch(() => {});
