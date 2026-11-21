/**
 * Marlon Pay — the store's signed cash-payout book, on the counter's phone, tablet or laptop.
 *
 *   Suppliers (big buttons) → tap one → date, invoice number, amount paid → turn the device to the supplier → they sign
 *   → Done. The record locks: nobody can change or delete it; the owner can add a dated correction note.
 *   From Marlon: a rep's Marlon invoice page has "Record cash payment in Marlon Pay", which opens #/marlon?… here with
 *   the supplier, invoice number and total filled in; the supplier just signs.
 *   Everything saves on this device first (works offline) and syncs when there's signal (sync.js).
 *   The owner's link also opens the dashboard (owner.js).
 */
import { keepData, meta, notes, payouts, suppliers } from "./db.js";
import { onSync, startSync, syncNow, waitingCount } from "./sync.js";
import { SignaturePad } from "./signature.js";
import { centsText, h, money, nameKey, prettyDate, put, timeText, tidy, toCents, todayISO, uid } from "./util.js";
import { ownerDashboard, staffScreen } from "./owner.js";

const app = document.getElementById("app");
const state = { lic: null, draft: null, waiting: 0, showArchived: false, query: "" };
const go = (hash) => { if (location.hash === hash) route(); else location.hash = hash; };

// ── Small UI helpers ────────────────────────────────────────────────────────────────────────────────────────────
let toastTimer = null;
export function toast(text) {
  let t = document.getElementById("toast");
  if (!t) { t = h("div", { id: "toast", class: "toast", role: "status", "aria-live": "polite" }); document.body.append(t); }
  t.textContent = text; t.classList.add("is-on");
  clearTimeout(toastTimer); toastTimer = setTimeout(() => t.classList.remove("is-on"), 3200);
}
export function confirmSheet(title, text, yes = "Yes", danger = false) {
  return new Promise((resolve) => {
    const dlg = h("dialog", { class: "sheet-dlg" });
    const close = (v) => { dlg.close(); dlg.remove(); resolve(v); };
    put(dlg, h("h2", {}, title), text ? h("p", {}, text) : null,
      h("div", { class: "row" }, h("button", { type: "button", class: "btn", onclick: () => close(false) }, "Cancel"),
        h("button", { type: "button", class: danger ? "btn btn-danger" : "btn btn-primary", id: "confirm-yes", onclick: () => close(true) }, yes)));
    dlg.addEventListener("cancel", (e) => { e.preventDefault(); close(false); });
    document.body.append(dlg); dlg.showModal();
  });
}
const field = (label, input, hint) => h("label", { class: "field" }, h("span", { class: "field-label" }, label, hint ? h("small", {}, ` ${hint}`) : null), input);
const screen = (...nodes) => { put(app, ...nodes); window.scrollTo(0, 0); };

function header() {
  const lic = state.lic;
  const owner = lic?.role === "owner";
  const here = location.hash.split("/")[1] || "";
  const tab = (id, label, hash, active) => h("a", { href: hash, id, class: active ? "nav-btn is-on" : "nav-btn", "aria-current": active ? "page" : null }, label);
  return h("header", { class: "top" },
    h("div", { class: "top-row" },
      h("div", { class: "brand" }, h("span", { class: "brand-mark", "aria-hidden": "true" }, "M"), h("span", {}, h("strong", {}, "Marlon Pay"), h("small", {}, lic?.storeName || ""))),
      h("button", { type: "button", id: "sync-pill", class: `pill ${state.waiting ? "is-waiting" : "is-ok"}`, onclick: () => syncNow().then(() => refreshPill()) },
        state.waiting ? `${state.waiting} waiting to send` : "All saved ✓")),
    lic ? h("nav", { class: "nav", "aria-label": "Main" },
      tab("nav-pay", "Pay", "#/", here === "" || here === "pay" || here === "supplier" || here === "sign" || here === "done"),
      tab("nav-records", "Records", "#/records", here === "records" || here === "record"),
      owner ? tab("nav-owner", "Dashboard", "#/owner", here === "owner") : null,
      owner ? tab("nav-staff", "Staff", "#/staff", here === "staff") : null) : null);
}
async function refreshPill() {
  state.waiting = await waitingCount();
  const p = document.getElementById("sync-pill");
  if (p) { p.className = `pill ${state.waiting ? "is-waiting" : "is-ok"}`; p.textContent = state.waiting ? `${state.waiting} waiting to send${navigator.onLine === false ? " (offline)" : ""}` : "All saved ✓"; }
}

// ── First open: the personal link, locked to this device ────────────────────────────────────────────────────────
function gate(title, text, extra = null) {
  screen(h("main", { class: "gate" }, h("span", { class: "brand-mark big", "aria-hidden": "true" }, "M"), h("h1", {}, title), h("p", {}, text), extra));
}
const isIOS = () => /iPhone|iPad|iPod/.test(navigator.userAgent) || (navigator.platform === "MacIntel" && navigator.maxTouchPoints > 1);
const standalone = () => window.matchMedia?.("(display-mode: standalone)").matches || navigator.standalone === true;

async function start() {
  const url = new URL(location.href);
  const k = url.searchParams.get("k");
  state.lic = await meta.get("license");
  let device = await meta.get("device");
  if (!device) device = await meta.set("device", Array.from(crypto.getRandomValues(new Uint8Array(16)), (b) => b.toString(16).padStart(2, "0")).join(""));
  if (k && /^[0-9a-f]{32}$/.test(k) && k !== state.lic?.key) {
    if (state.lic && (await waitingCount())) {
      gate("Send this device's records first", "This device has records waiting to be sent. Open Marlon Pay with signal so they send, then open the new link again.");
      return;
    }
    // iPhone: Safari and a Home Screen app keep separate storage, so add it to the Home Screen first (like Marlon).
    if (isIOS() && !standalone() && !url.searchParams.has("here")) {
      document.querySelector('link[rel="manifest"]')?.setAttribute("href", `/manifest.webmanifest?k=${k}`);
      gate("Add Marlon Pay to your Home Screen", "Tap the Share button, then “Add to Home Screen”, then open Marlon Pay from its new icon. Your link opens there, on this device only.",
        h("a", { class: "btn btn-ghost", href: `/?k=${k}&here=1` }, "Use it in Safari instead"));
      return;
    }
    if (navigator.onLine === false) { gate("Connect to the internet once", "The first time you open your link, Marlon Pay needs the internet to set up this device. After that it works offline."); return; }
    gate("Setting up this device…", "One moment.");
    let res;
    try { res = await fetch("/api/activate", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ key: k, device }) }); }
    catch { gate("No connection", "Connect to the internet and open your link again."); return; }
    const data = await res.json().catch(() => ({}));
    if (!res.ok || !data.ok) { gate("This link can't be used here", data.error || "Ask the store owner for your own link."); return; }
    state.lic = await meta.set("license", { key: k, device, role: data.role, storeName: data.store.name, staffName: data.staffName, at: new Date().toISOString() });
    history.replaceState(null, "", "/" + location.hash);
    keepData();
  }
  if (!state.lic) { gate("Open your personal link", "Marlon Pay opens from the link the store owner sent you. Each link works on one device."); return; }
  onSync((n) => { state.waiting = n; refreshPill(); });
  document.addEventListener("pay:blocked", (e) => {
    if (["off", "storeoff", "taken", "unknown"].includes(e.detail.reason)) gate("This device has been switched off", `${e.detail.error || "Ask the store owner."} Records already on this device are kept.`);
  });
  window.addEventListener("hashchange", () => route());
  window.addEventListener("online", refreshPill); window.addEventListener("offline", refreshPill);
  state.waiting = await waitingCount();
  route();
  startSync();
  window.__payReady = true;
}

// ── Routing ─────────────────────────────────────────────────────────────────────────────────────────────────────
async function route() {
  const hash = location.hash || "#/";
  const [path, query] = hash.slice(1).split("?");
  const parts = path.split("/").filter(Boolean);
  if (parts[0] === "marlon") return fromMarlon(new URLSearchParams(query || ""));
  if (parts[0] === "supplier") return supplierForm(parts[1] === "new" ? null : parts[1]);
  if (parts[0] === "pay") return payForm(parts[1]);
  if (parts[0] === "sign") return signScreen();
  if (parts[0] === "done") return doneScreen(parts[1]);
  if (parts[0] === "records") return recordsScreen();
  if (parts[0] === "record") return recordScreen(parts[1]);
  if (parts[0] === "owner" && state.lic.role === "owner") return screen(header(), await ownerDashboard({ openRecord: (id) => go(`#/record/${id}`) }));
  if (parts[0] === "staff" && state.lic.role === "owner") return screen(header(), await staffScreen());
  return home();
}

// ── Home: the suppliers, as big buttons ─────────────────────────────────────────────────────────────────────────
async function home() {
  const all = await suppliers.all();
  const list = h("div", { class: "sup-list", id: "sup-list" });
  const search = h("input", { type: "search", id: "sup-search", class: "big-input", placeholder: "Find a supplier", autocomplete: "off", value: state.query, "aria-label": "Find a supplier" });
  const draw = () => {
    const q = nameKey(search.value);
    state.query = search.value;
    const shown = all.filter((s) => (state.showArchived || !s.archived) && (!q || nameKey(s.name).includes(q) || (s.phone || "").replace(/\D/g, "").includes(q.replace(/\D/g, "") || "~")));
    put(list, shown.length ? shown.map((s) => h("div", { class: `sup-item${s.archived ? " is-archived" : ""}` },
      h("button", { type: "button", class: "sup-btn", dataset: { id: s.id }, onclick: () => go(`#/pay/${s.id}`), disabled: s.archived || null },
        h("strong", {}, s.name), h("small", {}, [s.phone, s.archived ? "archived" : ""].filter(Boolean).join(" · ") || "Tap to pay")),
      h("button", { type: "button", class: "btn btn-small sup-edit", "aria-label": `Edit ${s.name}`, onclick: () => go(`#/supplier/${s.id}`) }, "Edit")))
      : h("p", { class: "empty" }, all.length ? "No supplier matches." : "No suppliers yet. Add the suppliers you pay in cash, once."));
  };
  search.addEventListener("input", draw);
  draw();
  const today = (await payouts.all()).filter((p) => p.date === todayISO());
  const mine = state.lic.role === "owner" ? today : today.filter((p) => !p.fromServer);
  screen(header(), h("main", { class: "wrap" },
    h("h1", { class: "title" }, "Pay a supplier"),
    search,
    h("button", { type: "button", class: "btn btn-primary btn-xl", id: "sup-add", onclick: () => go("#/supplier/new") }, "+ Add a supplier"),
    list,
    all.some((s) => s.archived) ? h("button", { type: "button", class: "btn btn-ghost", id: "sup-archived", onclick: () => { state.showArchived = !state.showArchived; draw(); } }, state.showArchived ? "Hide archived suppliers" : "Show archived suppliers") : null,
    h("section", { class: "card today", "aria-labelledby": "h-today" },
      h("h2", { id: "h-today" }, "Paid today", h("span", { class: "num" }, money(mine.reduce((t, p) => t + p.amountCents, 0)))),
      mine.length ? h("ul", { class: "rec-list" }, mine.map(recRow)) : h("p", { class: "empty" }, "Nothing paid out yet today."))));
  if (!all.length) search.hidden = true;
}

function recRow(p) {
  return h("li", {}, h("a", { class: "rec-row", href: `#/record/${p.id}`, dataset: { id: p.id } },
    h("span", {}, h("strong", {}, p.supplierName), h("small", {}, `${prettyDate(p.date)}${p.invoiceNo ? ` · Inv. ${p.invoiceNo}` : ""} · ${p.staffName || ""}${p.synced ? "" : p.rejected ? " · refused by the server" : " · waiting to send"}`)),
    h("strong", { class: "num" }, money(p.amountCents))));
}

// ── Suppliers ───────────────────────────────────────────────────────────────────────────────────────────────────
async function supplierForm(id) {
  const s = id ? await suppliers.get(id) : null;
  if (id && !s) return go("#/");
  const name = h("input", { type: "text", id: "sf-name", class: "big-input", maxlength: "120", autocapitalize: "words", autocomplete: "off", value: s?.name || "" });
  const phone = h("input", { type: "tel", id: "sf-phone", class: "big-input", maxlength: "40", autocomplete: "off", value: s?.phone || "", placeholder: "Optional" });
  const notesIn = h("textarea", { id: "sf-notes", rows: "3", maxlength: "500", placeholder: "Optional, e.g. delivers Tuesdays" });
  notesIn.value = s?.notes || "";
  const err = h("p", { class: "error", role: "alert", hidden: true });
  const save = async (extra = {}) => {
    const n = tidy(name.value);
    if (!n) { err.textContent = "Type the supplier's name."; err.hidden = false; name.focus(); return; }
    const dupe = (await suppliers.all()).find((x) => x.id !== s?.id && nameKey(x.name) === nameKey(n));
    if (dupe) { err.textContent = `You already have a supplier called ${dupe.name}.`; err.hidden = false; return; }
    await suppliers.save({ id: s?.id || uid("su_"), name: n, phone: tidy(phone.value), notes: notesIn.value.trim(), archived: s?.archived || false, ...extra });
    syncNow().finally(refreshPill);
    toast(extra.archived === true ? `${n} archived` : extra.archived === false ? `${n} is back in the list` : `${n} saved`);
    go("#/");
  };
  screen(header(), h("main", { class: "wrap" },
    h("a", { class: "back", href: "#/" }, "‹ Suppliers"),
    h("h1", { class: "title" }, s ? `Edit ${s.name}` : "New supplier"),
    h("form", { class: "card form", onsubmit: (e) => { e.preventDefault(); save(); } },
      field("Name", name), field("Phone", phone, "(optional)"), field("Notes", notesIn, "(optional)"), err,
      h("button", { type: "submit", class: "btn btn-primary btn-xl", id: "sf-save" }, "Save supplier")),
    s ? h("button", { type: "button", class: "btn btn-ghost", id: "sf-archive", onclick: async () => {
      if (!s.archived && !(await confirmSheet(`Archive ${s.name}?`, "They leave the supplier list. Their signed records are kept, and you can bring them back any time.", "Archive"))) return;
      save({ archived: !s.archived });
    } }, s.archived ? "Bring back to the list" : "Archive this supplier") : null));
  name.focus();
}

// ── Paying: date, invoice number, amount → the supplier signs ──────────────────────────────────────────────────
async function payForm(supplierId, preset = null) {
  const s = await suppliers.get(supplierId);
  if (!s) return go("#/");
  const fromMarlon = preset?.fromMarlon || null;
  const date = h("input", { type: "date", id: "pf-date", class: "big-input", value: preset?.date || todayISO(), max: todayISO() });
  const inv = h("input", { type: "text", id: "pf-invoice", class: "big-input", maxlength: "60", autocomplete: "off", inputmode: "text", value: preset?.invoiceNo || "", readOnly: Boolean(fromMarlon) || null });
  const amount = h("input", { type: "text", id: "pf-amount", class: "big-input amount", inputmode: "decimal", autocomplete: "off", placeholder: "0.00", value: preset?.amountCents ? centsText(preset.amountCents) : "" });
  const err = h("p", { class: "error pf-error", role: "alert", hidden: true });
  const next = () => {
    const cents = toCents(amount.value);
    const fail = (t, el) => { err.textContent = t; err.hidden = false; el?.focus(); };
    if (!date.value) return fail("Choose the date.", date);
    if (date.value > todayISO()) return fail("The date can't be in the future.", date);
    if (!tidy(inv.value)) return fail("Type the invoice number.", inv);
    if (!cents) return fail("Type the amount paid, like 250 or 1,250.50.", amount);
    state.draft = { supplierId: s.id, supplierName: s.name, date: date.value, invoiceNo: tidy(inv.value), amountCents: cents, fromMarlon };
    go("#/sign");
  };
  screen(header(), h("main", { class: "wrap" },
    h("a", { class: "back", href: "#/" }, "‹ Suppliers"),
    h("h1", { class: "title" }, `Pay ${s.name}`),
    fromMarlon ? h("p", { class: "note from-marlon" }, h("strong", {}, "From Marlon: "), `invoice ${preset.invoiceNo} from ${fromMarlon.seller}, total ${money(fromMarlon.totalCents)}. Check the amount you're paying, then hand over to sign.`) : null,
    h("form", { class: "card form", onsubmit: (e) => { e.preventDefault(); next(); } },
      field("Date", date), field("Invoice number", inv), field("Amount paid in cash", amount), err,
      h("button", { type: "submit", class: "btn btn-primary btn-xl", id: "pf-next" }, "Next: supplier signs ›"))));
  (fromMarlon ? amount : inv).focus();
}

function signScreen() {
  const d = state.draft;
  if (!d) return go("#/");
  const canvas = h("canvas", { id: "sign-canvas", class: "sign-canvas", role: "img", "aria-label": "Signature box: the supplier signs here with a finger" });
  const doneBtn = h("button", { type: "button", class: "btn btn-primary btn-xl", id: "sign-done", disabled: true }, "Done");
  screen(h("main", { class: "sign-screen" },
    h("p", { class: "sign-kicker" }, "Please read and sign"),
    h("h1", {}, money(d.amountCents)),
    h("p", { class: "sign-what" }, `I, ${d.supplierName}, received this cash payment for invoice ${d.invoiceNo}, dated ${prettyDate(d.date)}, from ${state.lic.storeName}.`),
    h("div", { class: "sign-pad" }, canvas, h("span", { class: "sign-x", "aria-hidden": "true" }, "×  Sign here")),
    h("div", { class: "row" },
      h("button", { type: "button", class: "btn", id: "sign-clear", onclick: () => { pad.clear(); doneBtn.disabled = true; } }, "Clear"),
      h("button", { type: "button", class: "btn btn-ghost", id: "sign-cancel", onclick: () => history.back() }, "Back")),
    doneBtn,
    h("p", { class: "sign-foot" }, "Once signed, this record is locked: it can't be changed or deleted.")));
  const pad = new SignaturePad(canvas, { onChange: () => { doneBtn.disabled = pad.isEmpty(); } });
  doneBtn.addEventListener("click", async () => {
    if (pad.isEmpty()) return;
    doneBtn.disabled = true;
    try {
      const rec = await payouts.create({ id: uid("po_"), supplierId: d.supplierId, supplierName: d.supplierName, date: d.date, invoiceNo: d.invoiceNo, amountCents: d.amountCents,
        staffName: state.lic.staffName, signedAt: new Date().toISOString(), signature: pad.toDataURL(), fromMarlon: d.fromMarlon });
      state.draft = null;
      if (navigator.vibrate) navigator.vibrate(30);
      refreshPill();
      syncNow().finally(refreshPill);
      history.replaceState(null, "", `#/done/${rec.id}`);
      route();
    } catch (e) { doneBtn.disabled = false; toast(e.message || "Couldn't save. Please try again."); }
  });
}

async function doneScreen(id) {
  const p = await payouts.get(id);
  if (!p) return go("#/");
  screen(header(), h("main", { class: "wrap" },
    h("div", { class: "done-tick", "aria-hidden": "true" }, "✓"),
    h("h1", { class: "title center" }, "Saved and locked"),
    h("p", { class: "center muted" }, navigator.onLine === false ? "Saved on this device. It sends itself when there's signal." : "Saved. It's the store's proof that the supplier was paid."),
    recordCard(p, await notesFor(p.id)),
    h("button", { type: "button", class: "btn btn-primary btn-xl", id: "done-back", onclick: () => go("#/") }, "Back to suppliers")));
}

// ── Records ─────────────────────────────────────────────────────────────────────────────────────────────────────
const notesFor = async (id) => (await notes.all()).filter((n) => n.payoutId === id);
function recordCard(p, ns = []) {
  return h("article", { class: "card rec-card", dataset: { id: p.id } },
    h("div", { class: "rec-top" }, h("strong", {}, p.supplierName), h("strong", { class: "num rec-amt" }, money(p.amountCents))),
    h("dl", { class: "rec-dl" },
      h("dt", {}, "Invoice"), h("dd", {}, p.invoiceNo || "—"),
      h("dt", {}, "Date"), h("dd", {}, prettyDate(p.date)),
      h("dt", {}, "Signed"), h("dd", {}, `${prettyDate(p.signedAt.slice(0, 10))}, ${timeText(p.signedAt)}`),
      h("dt", {}, "Paid by"), h("dd", {}, p.staffName || "—"),
      p.fromMarlon ? [h("dt", {}, "From Marlon"), h("dd", {}, `${p.fromMarlon.seller}, invoice total ${money(p.fromMarlon.totalCents)}`)] : null,
      h("dt", {}, "Status"), h("dd", { class: "rec-status" }, p.synced ? "Saved to the store ✓" : p.rejected ? `Refused by the server (${p.rejected}). Kept on this device.` : "Waiting to send (kept on this device)")),
    h("figure", { class: "rec-sig" }, p.signature ? h("img", { src: p.signature, alt: `Signature of ${p.supplierName}` }) : h("p", { class: "muted sig-loading" }, "Loading the signature…"),
      h("figcaption", {}, `Signed by ${p.supplierName}`)),
    h("p", { class: "rec-lock" }, "🔒 Locked: this record can't be changed or deleted."),
    ns.length ? h("div", { class: "rec-notes" }, h("h3", {}, "Correction notes"), ns.map((n) => h("p", { class: "rec-note" }, h("strong", {}, `${prettyDate(n.createdAt.slice(0, 10))}: `), n.text, n.synced ? null : h("small", {}, " (waiting to send)")))) : null);
}

async function recordsScreen() {
  const owner = state.lic.role === "owner";
  const all = (await payouts.all()).filter((p) => owner || !p.fromServer);
  const q = h("input", { type: "search", id: "rec-search", class: "big-input", placeholder: "Supplier, invoice number or date", autocomplete: "off", "aria-label": "Search records" });
  const list = h("ul", { class: "rec-list", id: "rec-list" });
  const draw = () => {
    const t = nameKey(q.value);
    const shown = all.filter((p) => !t || nameKey(p.supplierName).includes(t) || nameKey(p.invoiceNo).includes(t) || p.date.includes(t) || nameKey(prettyDate(p.date)).includes(t));
    put(list, shown.length ? shown.map(recRow) : h("li", { class: "empty" }, all.length ? "No records match." : "No records yet."));
  };
  q.addEventListener("input", draw);
  draw();
  screen(header(), h("main", { class: "wrap" }, h("h1", { class: "title" }, owner ? "All records" : "My records"), q, list));
}

async function recordScreen(id) {
  const p = await payouts.get(id);
  if (!p) return go("#/records");
  const owner = state.lic.role === "owner";
  const ns = await notesFor(id);
  const noteIn = h("textarea", { id: "note-text", rows: "3", maxlength: "500", placeholder: "e.g. Supplier says the invoice number is 1043, not 1034." });
  const err = h("p", { class: "error", role: "alert", hidden: true });
  screen(header(), h("main", { class: "wrap" },
    h("a", { class: "back", href: "#/records" }, "‹ Records"),
    recordCard(p, ns),
    owner ? h("section", { class: "card form" }, h("h2", {}, "Add a correction note"),
      h("p", { class: "muted" }, "The record itself never changes. A note is added under it with today's date, and can't be removed."), noteIn, err,
      h("button", { type: "button", class: "btn btn-primary", id: "note-add", onclick: async () => {
        const t = noteIn.value.trim();
        if (!t) { err.textContent = "Type the note first."; err.hidden = false; return; }
        if (!(await confirmSheet("Add this note?", "It's dated today and can't be changed or removed.", "Add note"))) return;
        await notes.add(p.id, t);
        syncNow().finally(refreshPill);
        toast("Correction note added");
        route();
      } }, "Add note")) : null));
  if (!p.signature && owner) {
    try {
      const res = await fetch("/api/signatures", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ key: state.lic.key, device: state.lic.device, ids: [p.id] }) });
      const sig = (await res.json()).signatures?.[p.id];
      if (sig) { await payouts.cacheSignature(p.id, sig); const fig = app.querySelector(".rec-sig"); fig?.querySelector(".sig-loading")?.replaceWith(h("img", { src: sig, alt: `Signature of ${p.supplierName}` })); }
    } catch { app.querySelector(".sig-loading") && (app.querySelector(".sig-loading").textContent = "The signature shows when you're online."); }
  }
}

// ── From Marlon: the rep's invoice, filled in ───────────────────────────────────────────────────────────────────
async function fromMarlon(q) {
  const seller = tidy(q.get("s")).slice(0, 120), number = tidy(q.get("n")).slice(0, 60), totalCents = toCents(q.get("t")), date = /^\d{4}-\d{2}-\d{2}$/.test(q.get("d") || "") ? q.get("d") : todayISO();
  if (!seller || !number || !totalCents) { toast("That Marlon invoice link is incomplete. Enter the invoice by hand."); return go("#/"); }
  let sup = (await suppliers.all()).find((s) => nameKey(s.name) === nameKey(seller));
  if (!sup) { sup = await suppliers.save({ id: uid("su_"), name: seller, phone: tidy(q.get("p")).slice(0, 40), notes: "Added from a Marlon invoice", archived: false }); syncNow(); }
  else if (sup.archived) sup = await suppliers.save({ ...sup, archived: false });
  history.replaceState(null, "", `#/pay/${sup.id}`);
  payForm(sup.id, { invoiceNo: number, amountCents: totalCents, date: date > todayISO() ? todayISO() : date, fromMarlon: { seller, totalCents } });
}

if ("serviceWorker" in navigator) navigator.serviceWorker.register("/sw.js").catch(() => {});
start().catch((e) => { console.error(e); gate("Something went wrong", "Reload the page. Records saved on this device are kept."); });
