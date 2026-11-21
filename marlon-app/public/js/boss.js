/**
 * The boss dashboard (/boss?b=<boss key>), for a team buyer's boss, on his own phone.
 *  - The boss link activates this phone (the boss key and a random phone id are kept on the phone).
 *  - The first time, the boss sets his own passcode; after that it asks for it (5 wrong tries per 15 minutes).
 *  - Shows every invoice from every rep: which rep, the customer, the products, the total, paid or not paid,
 *    with totals for today, this week (Monday to Sunday) and this month per rep and for the whole company.
 *  - The boss can tick any rep's invoice as paid ("Mark paid"); it then shows as paid on the rep's phone too.
 *    The boss can't write or edit invoices.
 *  - Reps: "Add rep" names one of the rep places the company paid for and gives its link (never more places);
 *    "Switch off" a rep (e.g. they left): their phone stops working, their invoices stay under their name, and the
 *    same link is free for a new rep ("Give to new rep").
 *  - Refreshes every 30 seconds while open. Offline, it shows what it last loaded (and says when that was).
 *  - Marlon Pro (when the company has Pro on): the accountant summary (by quarter and for the year, to download or
 *    print for the accountant), returns (credit notes) by store, by product and by rep, and shelf orders (Pending,
 *    Delivered, Cancelled) with who ordered; the orderer's signature is fetched only when "Show signature" is tapped.
 */
import { accountantSummary, reportYears, returnsBreakdown, summaryCsv } from "./pro-report.js";
import { myProductsSection } from "./myproducts.js";
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

/** The boss's reps: "Add rep" (only into the places the company paid for) and "Switch off" a rep (frees their link). */
function repsSection(data) {
  const slots = data.slots || [];
  if (!slots.length) return el("section", { class: "card boss-card", id: "boss-team" }, el("h2", {}, "Reps"),
    el("p", { class: "boss-note" }, "This team uses one shared rep link, so reps are added by the seller. Contact them to change your reps."));
  const inUse = slots.filter((x) => x.name || x.phone).length;
  const full = inUse >= slots.length;
  const add = el("button", { type: "button", class: "btn btn-primary boss-add-rep", disabled: full, onclick: () => addRep(data, null) }, "+ Add rep");
  const rows = slots.filter((x) => x.name || x.phone || x.used).map((x) => {
    const status = x.phone ? `${x.phone.off ? "Switched off" : "Active"} · ${x.phone.label} · since ${dateText((x.phone.since || "").slice(0, 10))}` : x.name ? "Link not opened yet" : "Free · this link is ready for a new rep";
    const copy = (x.name || x.phone) ? el("button", { type: "button", class: "btn btn-ghost boss-copy", onclick: (e) => copyText(x.link, e.currentTarget) }, "Copy link") : null;
    const share = (x.name || x.phone) && navigator.share ? el("button", { type: "button", class: "btn btn-ghost", onclick: () => navigator.share({ title: "Marlon", text: `Your Marlon link${x.name ? `, ${x.name}` : ""}`, url: x.link }).catch(() => {}) }, "Share") : null;
    const action = (x.name || x.phone)
      ? el("button", { type: "button", class: "btn btn-ghost boss-rep-off", onclick: () => repOff(data, x) }, "Switch off")
      : el("button", { type: "button", class: "btn boss-give", onclick: () => addRep(data, x.n) }, "Give to new rep");
    return el("li", { class: "boss-rep", "data-n": x.n },
      el("div", {}, el("strong", {}, `Rep ${x.n}${x.name ? ` · ${x.name}` : ""}`), el("span", { class: "boss-note" }, status)),
      el("div", { class: "boss-rep-actions" }, action, copy, share));
  });
  return el("section", { class: "card boss-card", id: "boss-team" },
    el("div", { class: "boss-rep-head" }, el("h2", {}, "Reps"), add),
    el("p", { class: "boss-note", id: "boss-places" }, `${inUse} of ${slots.length} rep places in use${full ? " — all the places your company paid for. Switch off a rep to free a place, or contact the seller to add more." : "."}`),
    el("div", { class: "boss-new-link", hidden: true }),
    rows.length ? el("ul", { class: "boss-reps" }, rows) : el("p", { class: "boss-note" }, "No reps yet. Tap “Add rep”, type their name, then send them their link."));
}

async function copyText(text, button) {
  try { await navigator.clipboard.writeText(text); } catch {
    const t = el("textarea", {}, text); document.body.append(t); t.select(); try { document.execCommand("copy"); } catch { /* fine */ } t.remove();
  }
  const was = button.textContent; button.textContent = "Copied"; setTimeout(() => { button.textContent = was; }, 1500);
}

async function addRep(data, n) {
  const name = (prompt(n ? `Give rep place ${n}'s link to a new rep. Their name:` : "The new rep's name:") || "").trim();
  if (!name) return;
  const r = await call("/api/boss/add-rep", { method: "POST", auth: true, body: { name, n } }).catch(() => null);
  if (!r) { alert("No connection. Try again when you're online."); return; }
  if (r.status === 401) { put(TOKEN, null, sessionStorage); start(); return; }
  if (!r.ok) { alert(r.data.error || "That didn't work. Please try again."); return; }
  data.slots = r.data.slots;
  put(CACHE, data);
  render(data, false);
  const box = document.querySelector(".boss-new-link");
  box.replaceChildren(el("p", {}, el("strong", {}, `${name}'s link (rep ${r.data.n}) — send it to ${name}:`)),
    el("input", { type: "text", readonly: true, value: r.data.link, class: "boss-link-input", onfocus: (e) => e.target.select() }),
    el("div", { class: "boss-rep-actions" },
      el("button", { type: "button", class: "btn btn-primary", onclick: (e) => copyText(r.data.link, e.currentTarget) }, "Copy link"),
      navigator.share ? el("button", { type: "button", class: "btn btn-ghost", onclick: () => navigator.share({ title: "Marlon", text: `Your Marlon link, ${name}`, url: r.data.link }).catch(() => {}) }, "Share") : null),
    el("p", { class: "boss-note" }, "It works on one phone only: the first phone that opens it."));
  box.hidden = false;
  box.scrollIntoView({ block: "nearest" });
}

async function repOff(data, slot) {
  const who = slot.name || `rep ${slot.n}`;
  if (!confirm(`Switch off ${who}?\n\n${slot.phone ? `${who}'s phone stops working (the next time it's online). ` : ""}Their invoices stay on your dashboard under their name, and this link is freed so you can give it to a new rep.`)) return;
  const r = await call("/api/boss/rep-off", { method: "POST", auth: true, body: { n: slot.n } }).catch(() => null);
  if (!r) { alert("No connection. Try again when you're online."); return; }
  if (r.status === 401) { put(TOKEN, null, sessionStorage); start(); return; }
  if (!r.ok) { alert(r.data.error || "That didn't work. Please try again."); return; }
  load();
}

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

const view = { rep: "all", status: "all", year: null, orders: "pending" };

// ── Marlon Pro ───────────────────────────────────────────────────────────
const cnNo = (n) => `CN-${String(n || 0).padStart(4, "0")}`;
const creditText = (c) => `${(c.notes || []).length > 1 ? "Credit notes" : "Credit note"} ${(c.notes || []).map((x) => cnNo(x.number)).join(", ")}`;

/** Sales by quarter and for the year (to 31 December), ready for the accountant: download (CSV) or print / PDF. */
function accountantSection(data, repName, offline) {
  const credits = data.credits || [];
  const years = reportYears(data.invoices, credits);
  const year = years.includes(view.year) ? view.year : years[0];
  const s = accountantSummary({ invoices: data.invoices, credits, year });
  const yearSel = el("select", { id: "boss-acct-year", "aria-label": "Year", onchange: (e) => { view.year = Number(e.target.value); render(data, offline); } },
    years.map((y) => el("option", { value: String(y) }, `Year ${y}`)));
  yearSel.value = String(year);
  const card = (title, sub, q, big = false) => el("div", { class: `boss-q${big ? " is-year" : ""}`, "data-q": title },
    el("div", { class: "boss-q-head" }, el("strong", {}, title), el("span", {}, sub)),
    el("p", { class: "boss-q-net num" }, money(q.net)), el("p", { class: "boss-q-label" }, "Net sales"),
    el("dl", { class: "boss-q-rows" },
      el("dt", {}, "Gross sales"), el("dd", { class: "num" }, money(q.gross)),
      el("dt", {}, "Returns"), el("dd", { class: "num" }, q.returns ? `−${money(q.returns)}` : money(0)),
      el("dt", {}, "Received"), el("dd", { class: "num" }, money(q.received)),
      el("dt", {}, "Not yet paid"), el("dd", { class: "num" }, money(q.unpaid)),
      el("dt", {}, "Invoices"), el("dd", { class: "num" }, String(q.invoices))));
  const csv = () => summaryCsv({ company: data.company, year, invoices: data.invoices, credits, repName: (k) => repName.get(k) || "" });
  return el("section", { class: "card boss-card boss-pro-card", id: "boss-accountant" },
    el("div", { class: "boss-rep-head" }, el("h2", {}, "Accountant summary"), yearSel),
    el("p", { class: "boss-note" }, `${data.company} · sales for ${year}, by quarter and for the year ending 31 December ${year}.`),
    el("div", { class: "boss-quarters" }, s.quarters.map((q) => card(q.q, q.months, q)), card(`Year ${year}`, "Jan – Dec", s.total, true)),
    el("p", { class: "boss-acct-note", role: "note" }, "Prepared by Marlon from your reps' invoices and credit notes. Your accountant still needs to check it before you file your taxes."),
    el("div", { class: "boss-actions boss-no-print" },
      el("button", { type: "button", class: "btn btn-primary", id: "boss-csv", onclick: () => downloadText(csv(), `${slug(data.company)}-sales-${year}.csv`, "text/csv") }, "Download for accountant (CSV)"),
      el("button", { type: "button", class: "btn", id: "boss-print", onclick: () => printOnly("boss-accountant") }, "Print / Save as PDF")));
}

/** Returns (credit notes) by store, by product and by rep, and every credit note. */
function returnsSection(data, repName) {
  const credits = [...(data.credits || [])].sort((a, b) => (b.date || "").localeCompare(a.date || "") || (b.number || 0) - (a.number || 0));
  const rb = returnsBreakdown(credits, (k) => repName.get(k) || "a rep");
  const table = (id, head, rows) => el("table", { class: "boss-table", id }, el("thead", {}, el("tr", {}, head.map((x) => el("th", {}, x)))), el("tbody", {}, rows));
  return el("section", { class: "card boss-card boss-pro-card", id: "boss-returns" },
    el("h2", {}, "Returns"),
    el("p", { class: "boss-note" }, credits.length ? `${rb.notes} credit note${rb.notes === 1 ? "" : "s"} · ${money(rb.total)} credited. Each one comes off that store's next invoice automatically.` : "No returns yet. When a rep logs a return, the store signs and a numbered credit note appears here."),
    credits.length ? [
      el("h3", { class: "boss-h3" }, "By store"),
      table("boss-ret-store", ["Store", "Credit notes", "Amount"], rb.byStore.map((x) => el("tr", {}, el("td", {}, x.store), el("td", { class: "num" }, String(x.notes)), el("td", { class: "num" }, money(x.amount))))),
      el("h3", { class: "boss-h3" }, "By product"),
      table("boss-ret-product", ["Product", "Returned", "Amount"], rb.byProduct.map((x) => el("tr", {}, el("td", {}, x.name),
        el("td", { class: "num" }, x.qtyText, el("small", { class: "boss-sub" }, [x.expired ? `${x.expired} expired` : "", x.damaged ? `${x.damaged} damaged` : ""].filter(Boolean).join(", "))), el("td", { class: "num" }, money(x.amount))))),
      el("h3", { class: "boss-h3" }, "By rep"),
      table("boss-ret-rep", ["Rep", "Credit notes", "Amount"], rb.byRep.map((x) => el("tr", {}, el("td", {}, x.rep), el("td", { class: "num" }, String(x.notes)), el("td", { class: "num" }, money(x.amount))))),
      el("details", { class: "boss-cn-list" }, el("summary", {}, `All credit notes (${credits.length})`),
        el("ul", { class: "boss-list" }, credits.map((c) => el("li", { class: "boss-inv boss-cn", "data-id": c.id },
          el("div", { class: "boss-inv-head" }, el("strong", {}, `${cnNo(c.number)} · ${c.store || "No store name"}`), el("strong", { class: "num" }, money(c.total))),
          el("p", { class: "boss-inv-meta" }, `${dateText(c.date)} · by ${repName.get(c.rep) || "a rep"} · ${c.signed ? `signed${c.signer ? ` by ${c.signer}` : ""}` : "not signed"}`),
          el("ul", { class: "boss-items" }, (c.lines || []).map((l) => el("li", {}, el("span", {}, `${qtyText(l.qty, l.unit)} × ${l.name} · ${l.reason === "damaged" ? "damaged" : "expired"}`), el("span", { class: "num" }, money(l.total))))),
          el("p", { class: "boss-note" }, c.applied >= c.total ? "Fully taken off invoices." : c.applied ? `${money(c.applied)} taken off invoices so far · ${money(c.total - c.applied)} still to come off.` : "Comes off this store's next invoice.")))))] : null);
}

/** My Products (Pro): the boss adds, edits and deletes the company's products; every rep phone gets them by itself.
 *  Made once and kept across the 30-second refreshes, so a product being typed isn't wiped. */
let productsBox = null;
function productsSection() {
  if (!productsBox) {
    productsBox = myProductsSection({
      load: async () => { const r = await call("/api/pro/products", { method: "POST", auth: true, body: {} }).catch(() => null); return r?.ok && r.data.pro ? r.data : null; },
      api: (sub, body) => call(`/api/pro/products${sub}`, { method: "POST", auth: true, body }),
    });
    productsBox.classList.add("card", "boss-card", "boss-pro-card");
  }
  return productsBox;
}

/** Shelf orders from the reps' phones: Pending first; who ordered, with their signature on demand. */
const ordNo = (n) => `ORD-${String(n || 0).padStart(4, "0")}`;
const ORDER_STATUS = { pending: "Pending", delivered: "Delivered", cancelled: "Cancelled" };
const whenText = (isoTime) => (isoTime ? new Date(isoTime).toLocaleString([], { day: "numeric", month: "short", hour: "numeric", minute: "2-digit" }) : "");
function ordersSection(data, repName, offline) {
  const all = [...(data.orders || [])].sort((a, b) => (b.signedAt || "").localeCompare(a.signedAt || "") || (b.number || 0) - (a.number || 0));
  const count = (st) => all.filter((o) => o.status === st).length;
  const shown = all.filter((o) => view.orders === "all" || o.status === view.orders);
  const sel = el("select", { id: "boss-ord-status", "aria-label": "Which orders", onchange: (e) => { view.orders = e.target.value; render(data, offline); } },
    ["pending", "delivered", "cancelled", "all"].map((st) => el("option", { value: st }, st === "all" ? `All (${all.length})` : `${ORDER_STATUS[st]} (${count(st)})`)));
  sel.value = view.orders;
  const showSig = async (o, box, button) => {
    button.disabled = true;
    let r; try { r = await call("/api/boss/order-signature", { method: "POST", auth: true, body: { id: o.id } }); } catch { r = null; }
    button.disabled = false;
    if (!r?.ok) { box.replaceChildren(el("p", { class: "boss-error" }, r ? r.data.error || "The signature couldn't be loaded." : "No connection. The signature loads when you're online.")); return; }
    box.replaceChildren(el("figure", { class: "boss-ord-sig" }, r.data.signature ? el("img", { src: r.data.signature, alt: `Signature of ${r.data.signer}` }) : null,
      el("figcaption", {}, `Ordered by ${r.data.signer || "—"} for ${o.store} · ${whenText(r.data.signedAt || o.signedAt)}`)));
    button.remove();
  };
  return el("section", { class: "card boss-card boss-pro-card", id: "boss-orders" },
    el("div", { class: "boss-rep-head" }, el("h2", {}, "Shelf orders"), all.length ? sel : null),
    el("p", { class: "boss-note" }, all.length ? `${count("pending")} pending · ${count("delivered")} delivered · ${count("cancelled")} cancelled. Orders come from your reps' shelf photos; the store person signs each one.`
      : "No orders yet. When a rep takes a shelf photo and makes an order, it appears here with who ordered it."),
    shown.length ? el("ul", { class: "boss-list" }, shown.map((o) => {
      const sigBox = el("div", { class: "boss-ord-sigbox" });
      return el("li", { class: "boss-inv boss-ord", "data-id": o.id, "data-status": o.status },
        el("div", { class: "boss-inv-head" }, el("strong", {}, `${ordNo(o.number)} · ${o.store || "No store name"}`), el("span", { class: `boss-badge boss-ord-${o.status}` }, ORDER_STATUS[o.status] || o.status)),
        el("p", { class: "boss-inv-meta" }, `${whenText(o.signedAt)} · by ${repName.get(o.rep) || "a rep"} · ordered by ${o.signer || "—"}`),
        el("ul", { class: "boss-items" }, (o.lines || []).map((l) => el("li", {}, el("span", {}, `${l.name} · shelf ${l.onShelf ?? 0}, target ${l.target ?? "—"}`), el("strong", { class: "num" }, `order ${qtyText(l.qty, l.unit)}`)))),
        o.status === "delivered" ? el("p", { class: "boss-note" }, `Delivered ${whenText(o.deliveredAt)}${o.invoiceNumber ? ` · invoice No. ${String(o.invoiceNumber).padStart(4, "0")}` : ""}`) : null,
        o.status === "cancelled" ? el("p", { class: "boss-note" }, `Cancelled ${whenText(o.cancelledAt)}`) : null,
        o.signed ? [sigBox, el("button", { type: "button", class: "btn boss-ord-show", onclick: (e) => showSig(o, sigBox, e.currentTarget) }, "Show signature")] : null);
    })) : all.length ? el("p", { class: "boss-note" }, "No orders here.") : null);
}

const slug = (s) => String(s || "marlon").toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "") || "marlon";
async function downloadText(text, name, type) {
  const file = new File([text], name, { type });
  if (navigator.canShare?.({ files: [file] }) && /iPhone|iPad|Android/i.test(navigator.userAgent)) {
    try { await navigator.share({ files: [file], title: name }); return; } catch (e) { if (e?.name === "AbortError") return; }
  }
  const url = URL.createObjectURL(file);
  const a = el("a", { href: url, download: name, style: "display:none" });
  document.body.append(a); a.click(); a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 60000);
}
/** Prints just one section (the phone's print sheet can also "Save as PDF"). */
function printOnly(id) {
  document.body.dataset.print = id;
  const done = () => { delete document.body.dataset.print; window.removeEventListener("afterprint", done); };
  window.addEventListener("afterprint", done);
  window.print();
  setTimeout(done, 1500);
}

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
    el("div", {}, el("h1", {}, data.company, data.pro ? el("span", { class: "boss-pro-tag" }, "Pro") : null), el("p", { class: "boss-lead" }, `${all.length} invoice${all.length === 1 ? "" : "s"} from ${data.reps.length} rep${data.reps.length === 1 ? "" : "s"}`)),
    offline ? el("p", { class: "boss-error" }, `No connection: showing what was loaded at ${new Date(data.loadedAt).toLocaleString()}.`) : null,
    el("div", { class: "boss-tiles" },
      el("div", { class: "card boss-tile" }, el("p", { class: "boss-tile-label" }, "Today"), el("p", { class: "boss-tile-value num", "data-total": "today" }, money(sum(all.filter(inRange(p.today)))))),
      el("div", { class: "card boss-tile" }, el("p", { class: "boss-tile-label" }, "This week"), el("p", { class: "boss-tile-value num", "data-total": "week" }, money(sum(all.filter(inRange(p.week)))))),
      el("div", { class: "card boss-tile" }, el("p", { class: "boss-tile-label" }, "This month"), el("p", { class: "boss-tile-value num", "data-total": "month" }, money(sum(all.filter(inRange(p.month))))))),
    el("p", { class: "boss-note" }, `Not paid: ${money(sum(unpaid))} on ${unpaid.length} invoice${unpaid.length === 1 ? "" : "s"}. Weeks run Monday to Sunday.`),
    repsSection(data),
    data.pro ? productsSection() : null,
    data.pro ? accountantSection(data, repName, offline) : null,
    data.pro ? returnsSection(data, repName) : null,
    data.pro ? ordersSection(data, repName, offline) : null,
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
        el("ul", { class: "boss-items" }, inv.items.map((it) => el("li", {}, el("span", {}, `${qtyText(it.qty, it.unit)} × ${it.name}`), el("span", { class: "num" }, it.price === null ? "no price" : money(it.total)))),
          inv.credit ? el("li", { class: "boss-credit" }, el("span", {}, creditText(inv.credit)), el("span", { class: "num" }, `−${money(inv.credit.amount)}`)) : null),
        el("div", { class: "boss-pay" },
          el("span", { class: `boss-badge ${isPaid(inv) ? "is-paid" : "is-unpaid"}` }, isPaid(inv) ? (inv.payment?.markedBy === "boss" ? "Paid · marked by you" : "Paid") : inv.payment?.dueDate ? `Not paid · due ${dateText(inv.payment.dueDate)}` : "Not paid"),
          isPaid(inv) ? null : el("button", { type: "button", class: "btn boss-mark-paid", onclick: (e) => markPaid(inv, repName.get(inv.rep), e.currentTarget, data) }, "Mark paid"))))) :
        el("p", { class: "boss-note" }, all.length ? "No invoices match." : "No invoices yet. They appear here as soon as your reps' phones are online.")),
    el("p", { class: "boss-note" }, `Updated ${new Date(data.loadedAt).toLocaleTimeString([], { hour: "numeric", minute: "2-digit" })}. New invoices appear within about a minute of a rep's phone being online.`),
    el("p", { class: "boss-note boss-no-print" }, el("a", { href: "/terms", target: "_blank", rel: "noopener" }, "Terms and conditions (including Marlon Pro)")),
    el("div", { class: "boss-actions" },
      el("button", { type: "button", class: "btn", onclick: () => load() }, "Refresh"),
      el("button", { type: "button", class: "btn btn-ghost", onclick: async () => { await call("/api/boss/logout", { method: "POST", auth: true }).catch(() => {}); put(TOKEN, null, sessionStorage); put(CACHE, null); productsBox = null; start(); } }, "Lock")));
}

start();
window.__boss = { ready: true };
if ("serviceWorker" in navigator) navigator.serviceWorker.register("/sw.js").catch(() => {});
