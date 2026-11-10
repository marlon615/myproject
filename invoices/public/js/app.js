/**
 * The invoice screen: one invoice at a time, saved on the phone as you type.
 * Routes: "#/" (or none) = invoice, "#/owner" = private owner dashboard (dashboard.js).
 */
import { init as initDb, invoices, products, settings } from "./db.js";
import {
  SELLER, UNITS, UNIT_NAMES, debounce, defaultUnitFor, h, invoiceNo, itemsMissingPrice, lineTotal, money,
  normalizeUnit, parseAmount, priceInputText, qtyText, storeKey, sumTotals, todayISO, uid, withTotals,
} from "./util.js";
import { choiceSheet, confirmSheet, toast } from "./ui.js";
import { SignaturePad } from "./signature.js";
import { invoiceToText, invoiceToUrl } from "./codec.js";
import { qrCanvas } from "./qr.js";
import { printInvoice } from "./printer.js";
import { shareInvoiceImage, shareInvoicePdf } from "./share.js";
import { hideDashboard, initDashboard, showDashboard } from "./dashboard.js";
import { Listener, canListen, dictate } from "./voice.js";
import { bestParse } from "./voice-parse.js";
import { reviewSpokenInvoice } from "./voice-review.js";

const $ = (id) => document.getElementById(id);
const el = {
  main: $("invoice-screen"), dash: $("dashboard"), no: $("invoice-no"), signedBadge: $("signed-badge"),
  store: $("store"), storeList: $("store-list"), address: $("address"), date: $("date"),
  list: $("prod-list"), addForm: $("prod-add"), addName: $("prod-add-name"),
  grandTotal: $("grand-total"), grandCount: $("grand-count"), grandAmount: $("grand-amount"),
  signCard: $("sign-card"), signCanvas: $("sign-canvas"), signStatus: $("sign-status"), signTip: $("sign-tip"), signClear: $("sign-clear"),
  qrBox: $("qr-box"), qrCaption: $("qr-caption"), qrToggle: $("qr-toggle"),
  print: $("print-btn"), sharePdf: $("share-pdf-btn"), shareImage: $("share-image-btn"),
  newBtn: $("new-btn"), saveStatus: $("save-status"),
  bar: $("total-bar"), barCount: $("bar-count"), barAmount: $("bar-amount"),
  update: $("update-banner"), updateBtn: $("update-btn"), brandBar: $("brand-bar"),
  mic: $("mic-btn"), micLabel: $("mic-label"), voicePanel: $("voice-panel"), voiceState: $("voice-state"),
  voiceMode: $("voice-mode"), voiceText: $("voice-text"), voiceTip: $("voice-tip"),
  install: $("install-card"), installIos: $("install-ios"), installAndroid: $("install-android"),
  installBtn: $("install-btn"), installDismiss: $("install-dismiss"),
};

const state = {
  products: [],       // the product list (visible products, in order)
  extra: [],          // products on this invoice that were later removed from the list: [{ id, name }]
  lines: new Map(),   // productId → { on, qty, price, name } — qty/price exactly as typed
  inv: { signature: null, signedAt: null }, // id, number, createdAt once saved
  nextNumber: 1,
  stores: [],
  qrMode: "link",
  savedAt: null,
};
const rows = new Map(); // productId → { li, cb, qty, price, total, detail, product }
let pad = null;

const itemsText = (n) => `${n} item${n === 1 ? "" : "s"}`;
const timeText = (d) => d.toLocaleTimeString([], { hour: "numeric", minute: "2-digit" });

// ── Startup ──────────────────────────────────────────────────────────────

async function start() {
  try {
    await initDb();
  } catch (e) {
    console.error(e);
    el.main.replaceChildren(h("p", { class: "fatal" }, e?.message || "This browser can't save invoices. Open the app in Safari or Chrome."));
    signalReady();
    return;
  }
  state.qrMode = (await settings.get("qrMode", "link")) === "text" ? "text" : "link";
  state.products = await products.all();
  pad = new SignaturePad(el.signCanvas, { onChange: onSigned });

  const currentId = await settings.get("currentId", null);
  const current = currentId ? await invoices.get(currentId) : null;
  if (current) await loadInvoice(current);
  else await newDraft();
  refreshStores();

  wireEvents();
  initDashboard(el.dash, hooks);
  window.addEventListener("hashchange", route);
  route();
  setupInstall();
  registerServiceWorker();
  watchTotalRow();
  signalReady();
}

function signalReady() {
  window.__appReady = true;
  document.dispatchEvent(new Event("app:ready"));
}

// ── Invoice state ────────────────────────────────────────────────────────

/** Starts a fresh invoice, optionally copying store, address and items from another one. */
async function newDraft(from = null) {
  state.inv = { signature: null, signedAt: null };
  state.lines = new Map();
  state.extra = [];
  el.store.value = from?.store || "";
  el.address.value = from?.address || "";
  el.date.value = todayISO();
  for (const it of from?.items || []) addLineFromItem(it);
  state.nextNumber = await invoices.peekNextNumber();
  state.savedAt = null;
  await settings.remove("currentId");
  pad.clear();
  renderAll();
  if (from) scheduleSave();
}

async function loadInvoice(inv) {
  state.inv = { id: inv.id, number: inv.number, createdAt: inv.createdAt, signature: inv.signature || null, signedAt: inv.signedAt || null };
  state.lines = new Map();
  state.extra = [];
  el.store.value = inv.store || "";
  el.address.value = inv.address || "";
  el.date.value = inv.date || todayISO();
  for (const it of inv.items || []) addLineFromItem(it);
  state.nextNumber = await invoices.peekNextNumber();
  state.savedAt = inv.updatedAt ? new Date(inv.updatedAt) : null;
  renderAll();
  await pad.fromDataURL(state.inv.signature);
}

function addLineFromItem(it) {
  let id = it.productId;
  if (!id || !state.products.some((p) => p.id === id)) {
    id = id && !state.extra.some((x) => x.id === id) ? id : uid("x_");
    state.extra.push({ id, name: it.name });
  }
  state.lines.set(id, { on: true, qty: qtyText(it.qty) || "1", unit: normalizeUnit(it.unit), price: priceInputText(it.price), name: it.name });
}

/** Ticked items in list order, with the names they had when ticked. */
function currentItems() {
  const items = [];
  for (const p of [...state.products, ...state.extra]) {
    const l = state.lines.get(p.id);
    if (l?.on) items.push({ productId: p.id, name: state.products.includes(p) ? p.name : l.name || p.name, qty: parseAmount(l.qty), unit: normalizeUnit(l.unit || defaultUnitFor(p)), price: parseAmount(l.price) });
  }
  return items;
}

/** The invoice as it stands now (number shown even before the first save). */
function draft() {
  return withTotals({
    ...state.inv,
    seller: SELLER,
    number: state.inv.number || state.nextNumber,
    store: el.store.value.trim(),
    address: el.address.value.trim(),
    date: el.date.value || todayISO(),
    items: currentItems(),
  });
}

const hasContent = (d) => Boolean(d.store || d.items.length);

// ── Saving ───────────────────────────────────────────────────────────────

let saveChain = Promise.resolve();
const scheduleSave = debounce(() => { saveChain = saveChain.then(saveNow, saveNow); }, 500);

async function saveNow() {
  const d = draft();
  if (!hasContent(d)) { renderSaveStatus(); return; }
  try {
    const saved = await invoices.put({ ...d, number: state.inv.number || undefined });
    Object.assign(state.inv, { id: saved.id, number: saved.number, createdAt: saved.createdAt });
    state.savedAt = new Date(saved.updatedAt);
    await settings.set("currentId", saved.id); // prices stay on this invoice only: the next one starts fresh
    renderNumber();
    renderSaveStatus();
  } catch (e) {
    console.error(e);
    el.saveStatus.textContent = "Couldn't save on this phone. Free up some space, then try again.";
  }
}

async function flushSave() {
  scheduleSave.flush();
  await saveChain;
}

function changed() {
  renderTotals();
  renderSaveStatus(true);
  scheduleSave();
  scheduleQr();
}

// ── Rendering ────────────────────────────────────────────────────────────

function renderAll() {
  renderList();
  renderNumber();
  renderTotals();
  renderSignState();
  renderSaveStatus();
  renderQr();
}

function renderNumber() {
  el.no.textContent = `No. ${invoiceNo(state.inv.number || state.nextNumber)}`;
}

function renderSaveStatus(pending = false) {
  if (pending) { el.saveStatus.textContent = "Saving…"; return; }
  el.saveStatus.textContent = state.savedAt ? `Saved on this phone · ${timeText(state.savedAt)}` : "Not saved yet";
}

function renderTotals() {
  const items = currentItems();
  const total = sumTotals(items);
  el.grandAmount.textContent = money(total);
  el.grandCount.textContent = items.length ? itemsText(items.length) : "No items yet";
  el.barAmount.textContent = money(total);
  el.barCount.textContent = itemsText(items.length);
  el.bar.classList.toggle("has-items", items.length > 0);
}

const CHECK_PATH = "M5.5 12.5 10 17l8.5-9.5";
function svgIcon(d, cls = "icon") {
  const ns = "http://www.w3.org/2000/svg";
  const svg = document.createElementNS(ns, "svg");
  svg.setAttribute("viewBox", "0 0 24 24");
  svg.setAttribute("class", cls);
  svg.setAttribute("aria-hidden", "true");
  const path = document.createElementNS(ns, "path");
  path.setAttribute("d", d);
  svg.append(path);
  return svg;
}

function renderList() {
  rows.clear();
  const all = [...state.products, ...state.extra.map((x) => ({ ...x, removed: true }))];
  el.list.replaceChildren(...all.map(buildRow));
}

function buildRow(p) {
  const l = state.lines.get(p.id);
  const id = `p-${p.id}`;
  const cb = h("input", { type: "checkbox", class: "prod-cb", id: `${id}-cb`, "aria-describedby": `${id}-total` });
  cb.checked = Boolean(l?.on);
  const qty = h("input", { type: "text", class: "qty-input num", inputmode: "decimal", autocomplete: "off", enterkeyhint: "next", "aria-label": `Quantity of ${p.name}` });
  const price = h("input", { type: "text", class: "price-input num", inputmode: "decimal", autocomplete: "off", enterkeyhint: "done", placeholder: "Add price", "aria-label": `Unit price of ${p.name}` });
  const unitNow = l?.unit || defaultUnitFor(p);
  const unit = h("select", { class: "unit-select", "aria-label": `Unit for ${p.name}` },
    UNITS.map((u) => h("option", { value: u }, UNIT_NAMES[u])));
  unit.value = unitNow;
  qty.value = l?.qty ?? "1";
  price.value = l?.price ?? "";
  const total = h("output", { class: "line-total num", id: `${id}-total` });
  const detail = h("div", { class: "prod-detail" },
    h("div", { class: "qty" },
      h("button", { type: "button", class: "qty-btn", dataset: { step: "-1" }, "aria-label": `One less ${p.name}` }, "−"),
      qty,
      h("button", { type: "button", class: "qty-btn", dataset: { step: "1" }, "aria-label": `One more ${p.name}` }, "+")),
    unit,
    h("span", { class: "price-wrap" },
      h("span", { class: "times", "aria-hidden": "true" }, "×"),
      h("label", { class: "price" }, h("span", { class: "price-cur", "aria-hidden": "true" }, "$"), price)),
    total);
  const li = h("li", { class: "prod-row", dataset: { id: p.id } },
    h("label", { class: "prod-check", for: `${id}-cb` },
      cb,
      h("span", { class: "prod-box", "aria-hidden": "true" }, svgIcon(CHECK_PATH)),
      h("span", { class: "prod-name" }, p.name, p.removed ? h("span", { class: "prod-removed" }, "removed from list") : null)),
    detail);
  rows.set(p.id, { li, cb, qty, unit, price, total, detail, product: p });
  updateRow(p.id);
  return li;
}

function updateRow(pid) {
  const r = rows.get(pid);
  if (!r) return;
  const l = state.lines.get(pid);
  const on = Boolean(l?.on);
  r.li.classList.toggle("is-on", on);
  r.cb.checked = on;
  r.detail.hidden = !on;
  if (!on) return;
  r.unit.value = l.unit || defaultUnitFor(r.product);
  const hasPrice = parseAmount(l.price) !== null;
  r.total.textContent = hasPrice ? money(lineTotal(l.qty, l.price)) : "—";
  r.li.classList.toggle("needs-price", !hasPrice);
}

function lineFor(pid) {
  let l = state.lines.get(pid);
  if (!l) {
    const r = rows.get(pid);
    l = { on: false, qty: r?.qty.value || "1", unit: r?.unit.value || "each", price: r?.price.value ?? "", name: r?.product.name || "" };
    state.lines.set(pid, l);
  }
  return l;
}

function setOn(pid, on) {
  const r = rows.get(pid);
  const l = lineFor(pid);
  l.on = on;
  l.name = r.product.name;
  l.unit = l.unit || defaultUnitFor(r.product);
  if (on && !(parseAmount(l.qty) > 0)) l.qty = "1";
  r.qty.value = l.qty;
  r.price.value = l.price;
  updateRow(pid);
  changed();
}

function step(pid, dir) {
  const r = rows.get(pid);
  const l = lineFor(pid);
  const q = parseAmount(l.qty) ?? 0;
  const next = Math.max(1, Math.round((q + dir) * 1000) / 1000);
  l.qty = qtyText(next);
  r.qty.value = l.qty;
  updateRow(pid);
  changed();
}

// ── QR code ──────────────────────────────────────────────────────────────

const scheduleQr = debounce(renderQr, 250);

function renderQr() {
  const d = draft();
  const textMode = state.qrMode === "text";
  el.qrToggle.textContent = textMode ? "Customer has internet? Use the link QR instead" : "Their phone has no internet? Use the text-only QR";
  el.qrCaption.textContent = textMode
    ? "Shows the whole invoice as plain text. Works with no internet at all."
    : "Customer: scan with your phone camera to see this invoice.";
  el.qrBox.replaceChildren();
  el.qrBox.classList.toggle("is-empty", !hasContent(d));
  if (!hasContent(d)) {
    el.qrBox.append(h("p", { class: "qr-empty" }, "Add a store and products to make the QR code."));
    return;
  }
  try {
    const canvas = textMode ? qrCanvas(invoiceToText(d), { px: 300, ecc: "L" }) : qrCanvas(invoiceToUrl(d), { px: 240 });
    canvas.setAttribute("role", "img");
    canvas.setAttribute("aria-label", textMode ? "QR code with this invoice as text" : "QR code that opens this invoice on the customer's phone");
    el.qrBox.append(canvas);
  } catch {
    el.qrBox.append(h("p", { class: "qr-empty" }, "This invoice is too long for one QR code. Use the link QR or share the PDF."));
  }
}

// ── Signature ────────────────────────────────────────────────────────────

function onSigned() {
  state.inv.signature = pad.toDataURL();
  state.inv.signedAt = state.inv.signature ? new Date().toISOString() : null;
  renderSignState();
  changed();
}

function clearSignature() {
  pad.clear();
  state.inv.signature = null;
  state.inv.signedAt = null;
  renderSignState();
  changed();
}

function renderSignState() {
  const signed = Boolean(state.inv.signature);
  el.signCard.classList.toggle("is-signed", signed);
  el.signedBadge.hidden = !signed;
  el.signClear.hidden = !signed;
  el.signStatus.textContent = signed ? `Signed ✓${state.inv.signedAt ? " " + timeText(new Date(state.inv.signedAt)) : ""}` : "Not signed yet";
  el.signTip.textContent = signed ? "Signed. Changing the invoice will ask first." : "Ask the customer to sign here with a finger.";
}

/** On a signed invoice, any change first asks; yes clears the signature. */
async function allowChange() {
  if (!state.inv.signature) return true;
  const ok = await confirmSheet({
    title: "Remove the signature?",
    message: "Changing the invoice removes the customer's signature. They'll need to sign again.",
    okText: "Change invoice",
    cancelText: "Keep it",
  });
  if (ok) clearSignature();
  return ok;
}

// ── Events ───────────────────────────────────────────────────────────────

function wireEvents() {
  // Signed-invoice guard for typing: ask before the first keystroke can land.
  el.main.addEventListener("focusin", (e) => {
    const t = e.target;
    if (!state.inv.signature || !t.matches("input, textarea, select") || t === el.addName) return; // adding is guarded on submit
    if (t.closest(".sign-card")) return;
    t.blur();
    allowChange().then((ok) => { if (ok) t.focus(); });
  });

  // Ticks and steppers (guarded on a signed invoice).
  el.list.addEventListener("click", (e) => {
    const stepBtn = e.target.closest(".qty-btn");
    const check = e.target.closest(".prod-check");
    if (!stepBtn && !check) return;
    const pid = e.target.closest(".prod-row")?.dataset.id;
    if (!pid) return;
    if (state.inv.signature) {
      // Stop the tick (or the label forwarding its click) until they confirm.
      e.preventDefault();
      allowChange().then((ok) => {
        if (!ok) return;
        if (stepBtn) step(pid, Number(stepBtn.dataset.step));
        else setOn(pid, !state.lines.get(pid)?.on);
      });
      return;
    }
    if (stepBtn) step(pid, Number(stepBtn.dataset.step));
  });
  el.list.addEventListener("change", (e) => {
    if (e.target.matches(".unit-select")) {
      const pid = e.target.closest(".prod-row").dataset.id;
      const r = rows.get(pid), l = lineFor(pid);
      l.unit = normalizeUnit(e.target.value); // the price box is now per this unit
      updateRow(pid);
      changed();
      return;
    }
    if (!e.target.matches(".prod-cb")) return;
    setOn(e.target.closest(".prod-row").dataset.id, e.target.checked);
  });
  el.list.addEventListener("input", (e) => {
    const t = e.target;
    const pid = t.closest(".prod-row")?.dataset.id;
    if (!pid) return;
    const l = lineFor(pid);
    if (t.matches(".qty-input")) l.qty = t.value;
    else if (t.matches(".price-input")) l.price = t.value;
    else return;
    updateRow(pid);
    changed();
  });
  el.list.addEventListener("focusout", (e) => {
    const t = e.target;
    const pid = t.closest(".prod-row")?.dataset.id;
    const l = pid && state.lines.get(pid);
    if (!l) return;
    if (t.matches(".price-input")) {
      const v = parseAmount(t.value);
      t.value = l.price = v === null ? (t.value.trim() ? t.value : "") : priceInputText(v);
    } else if (t.matches(".qty-input") && parseAmount(t.value) === null) {
      t.value = l.qty = "1";
      updateRow(pid);
      changed();
    }
  });

  // Customer fields.
  el.store.addEventListener("input", () => {
    const known = state.stores.find((s) => storeKey(s.name) === storeKey(el.store.value));
    if (known?.address && !el.address.value.trim()) {
      el.address.value = known.address;
      toast("Address filled in from last time");
    }
    changed();
  });
  el.address.addEventListener("input", changed);
  el.date.addEventListener("change", () => { if (!el.date.value) el.date.value = todayISO(); changed(); });

  // Add a product (it joins the list for good, ticked on this invoice).
  el.addForm.addEventListener("submit", async (e) => {
    e.preventDefault();
    const name = el.addName.value.trim();
    if (!name) { el.addName.focus(); return; }
    if (!(await allowChange())) return;
    try {
      const p = await products.add(name);
      state.products = await products.all();
      state.extra = state.extra.filter((x) => x.name.toLowerCase() !== p.name.toLowerCase());
      renderList();
      el.addName.value = "";
      setOn(p.id, true);
      toast(`${p.name} added to your products`);
      rows.get(p.id)?.price.focus();
    } catch (err) {
      toast(err?.message || "Couldn't add that product.");
    }
  });

  // Signature.
  el.signClear.addEventListener("click", clearSignature);

  // Voice entry: one tap starts listening, the next tap stops.
  el.mic.addEventListener("click", onMic);

  // QR mode.
  el.qrToggle.addEventListener("click", () => {
    state.qrMode = state.qrMode === "text" ? "link" : "text";
    settings.set("qrMode", state.qrMode);
    renderQr();
  });

  // Print and share — called straight from the tap so Bluetooth/share keep the user's gesture.
  el.print.addEventListener("click", (e) => output(e.currentTarget, printInvoice));
  el.sharePdf.addEventListener("click", (e) => output(e.currentTarget, shareInvoicePdf));
  el.shareImage.addEventListener("click", (e) => output(e.currentTarget, shareInvoiceImage));

  el.newBtn.addEventListener("click", async () => {
    await flushSave();
    await newDraft();
    refreshStores();
    window.scrollTo({ top: 0, behavior: "smooth" });
    toast(`New invoice No. ${invoiceNo(state.nextNumber)}`);
  });

  // Never lose typing when the app is closed or switched away from.
  document.addEventListener("visibilitychange", () => {
    if (document.visibilityState !== "hidden") return;
    flushSave();
    if (voice.listener?.active) finishListening(); // phone locked or app switched: keep what was heard
  });
  window.addEventListener("pagehide", () => { flushSave(); });
}

async function output(button, action) {
  if (button.getAttribute("aria-busy") === "true") return;
  const d = draft();
  if (!d.items.length) { toast("Tick at least one product first."); return; }
  const missing = itemsMissingPrice(d);
  if (missing.length) {
    const ok = await confirmSheet({
      title: `${missing.length} ${missing.length === 1 ? "item has" : "items have"} no price`,
      message: "They'll show as “(no price)” and $0.00 on the receipt.",
      okText: "Continue anyway",
      cancelText: "Add prices",
    });
    if (!ok) { rows.get(missing[0].productId)?.price.focus(); return; }
  }
  const run = action(d); // first thing after the tap: Bluetooth and share need the tap's permission
  button.setAttribute("aria-busy", "true");
  flushSave();
  try { await run; } finally { button.removeAttribute("aria-busy"); }
}

// ── Voice entry: tap the mic, say the whole invoice, tap again, check, done ─

const voice = { listener: null, busy: false };

function showListening(on) {
  el.mic.classList.toggle("is-listening", on);
  el.mic.setAttribute("aria-pressed", String(on));
  el.micLabel.textContent = on ? "Stop listening" : "Speak the invoice";
}

function onMic() {
  if (voice.listener?.active) { finishListening(); return; }
  if (voice.busy) return;
  if (!canListen()) { typedInvoice("unsupported", ""); return; }
  startListening();
}

function startListening() {
  const listener = new Listener({
    onText: (text) => { el.voiceText.textContent = text || "…"; el.voiceText.classList.toggle("is-hint", !text); },
    onFail: (code, text) => { if (voice.listener === listener) voice.listener = null; showListening(false); el.voicePanel.hidden = true; typedInvoice(code, text); },
  });
  voice.listener = listener;
  el.voiceState.textContent = "Listening…";
  el.voiceMode.textContent = "";
  el.voiceText.textContent = "Say the store, the address, then each product with its amount and price.";
  el.voiceText.classList.add("is-hint");
  el.voiceTip.textContent = "Tap the mic again when you're done.";
  el.voicePanel.hidden = false;
  el.voicePanel.classList.remove("is-working");
  showListening(true);
  listener.start().then(({ mode, downloading }) => {
    if (mode === "on-device") el.voiceMode.textContent = "On this phone · works offline";
    else if (downloading) el.voiceMode.textContent = "Offline speech is downloading for next time";
  }).catch((e) => {
    if (voice.listener === listener) voice.listener = null;
    showListening(false);
    el.voicePanel.hidden = true;
    typedInvoice(e?.code || "error", "");
  });
}

async function finishListening() {
  const listener = voice.listener;
  voice.listener = null;
  voice.busy = true;
  showListening(false);
  el.voiceState.textContent = "Working it out…";
  el.voiceTip.textContent = "";
  el.voicePanel.classList.add("is-working");
  try {
    const { text, candidates } = await listener.stop();
    el.voicePanel.hidden = true;
    if (!text) { toast("I didn't hear anything. Tap the mic and try again."); return; }
    await reviewAndApply(candidates);
  } finally {
    voice.busy = false;
    el.voicePanel.hidden = true;
  }
}

/** The fallback when listening isn't possible: the keyboard's microphone (or typing). */
async function typedInvoice(reason, text) {
  voice.busy = true;
  try {
    const said = await dictate({ reason, text });
    if (said) await reviewAndApply([said]);
  } finally {
    voice.busy = false;
  }
}

async function reviewAndApply(candidates) {
  const parsed = bestParse(candidates, { products: state.products, stores: state.stores, today: todayISO() });
  const result = await reviewSpokenInvoice(parsed, {
    products: state.products,
    currentDate: el.date.value || todayISO(),
    onSpeakAgain: () => { voice.busy = false; if (canListen()) startListening(); else typedInvoice("unsupported", ""); },
  });
  if (result) await applyVoice(result);
}

/** Puts the reviewed lines on the invoice: ticks the products and fills amount, unit and price. */
async function applyVoice(result) {
  if (!(await allowChange())) return;
  const had = currentItems().length;
  let mode = "replace";
  if (had) {
    mode = await choiceSheet({
      title: "This invoice already has products",
      message: `Replace the ${had} product${had === 1 ? "" : "s"} on it with what you said, or add to them?`,
      choices: [{ label: "Cancel", value: null }, { label: "Add to them", value: "add" }, { label: "Replace", value: "replace", primary: true }],
    });
    if (!mode) return;
  }
  if (result.date) el.date.value = result.date;
  if (result.store) el.store.value = result.store;
  if (result.address) el.address.value = result.address;
  else {
    const known = state.stores.find((x) => storeKey(x.name) === storeKey(el.store.value));
    if (known?.address && !el.address.value.trim()) el.address.value = known.address;
  }
  if (mode === "replace") for (const l of state.lines.values()) l.on = false;
  for (const line of result.lines) {
    const p = state.products.find((x) => x.id === line.productId);
    if (!p) continue;
    const l = lineFor(p.id);
    const sameUnit = normalizeUnit(l.unit || defaultUnitFor(p)) === line.unit;
    l.qty = qtyText(mode === "add" && l.on && sameUnit ? (parseAmount(l.qty) || 0) + line.qty : line.qty);
    l.on = true;
    l.unit = line.unit;
    l.name = p.name;
    if (line.price !== null) l.price = priceInputText(line.price); // this invoice only — never saved as a standing price
    else if (!(mode === "add" && sameUnit)) l.price = "";
  }
  renderList();
  changed();
  el.list.closest(".block").scrollIntoView({ behavior: "smooth", block: "start" });
  toast("Filled in from your voice. Check it, then ask the customer to sign.", { ms: 4200 });
}

// ── Stores ───────────────────────────────────────────────────────────────

async function refreshStores() {
  state.stores = await invoices.knownStores();
  el.storeList.replaceChildren(...state.stores.map((s) => h("option", { value: s.name })));
}

// ── Dashboard hooks and routing ──────────────────────────────────────────

const hooks = {
  async openInvoice(id) {
    const inv = await invoices.get(id);
    if (!inv) { toast("That invoice no longer exists."); return; }
    await flushSave();
    await loadInvoice(inv);
    await settings.set("currentId", inv.id);
    go("#/");
  },
  async duplicateInvoice(id) {
    const inv = await invoices.get(id);
    if (!inv) { toast("That invoice no longer exists."); return; }
    await flushSave();
    await newDraft({ ...inv, items: inv.items.map((it) => ({ ...it })) });
    go("#/");
    toast(`Copied into new invoice No. ${invoiceNo(state.nextNumber)}`);
  },
  async newInvoice() {
    await flushSave();
    await newDraft();
    go("#/");
  },
  async onProductsChanged() {
    state.products = await products.all();
    // Ticked products that were removed from the list stay on this invoice (shown at the end).
    for (const [pid, l] of state.lines) {
      if (l.on && !state.products.some((p) => p.id === pid) && !state.extra.some((x) => x.id === pid)) state.extra.push({ id: pid, name: l.name });
    }
    state.extra = state.extra.filter((x) => !state.products.some((p) => p.id === x.id));
    renderList();
    renderTotals();
    scheduleQr();
  },
  close() { go("#/"); },
};

function go(hash) {
  if (location.hash === hash || (hash === "#/" && !location.hash)) route();
  else location.hash = hash;
}

async function route() {
  const owner = location.hash === "#/owner";
  if (owner && voice.listener) { voice.listener.abort(); voice.listener = null; showListening(false); el.voicePanel.hidden = true; }
  el.main.hidden = owner;
  el.brandBar.hidden = owner;
  if (owner) {
    await flushSave();
    showDashboard();
    return;
  }
  hideDashboard();
  // The open invoice may have been deleted from the dashboard.
  if (state.inv.id && !(await invoices.get(state.inv.id))) {
    await newDraft();
    refreshStores();
  } else {
    state.nextNumber = await invoices.peekNextNumber();
    renderNumber();
  }
}

// ── Sticky total bar (shown while the real total row is off screen) ──────

function watchTotalRow() {
  if (!("IntersectionObserver" in window)) return;
  new IntersectionObserver(([entry]) => {
    el.bar.classList.toggle("is-near", entry.isIntersecting || entry.boundingClientRect.top < 0);
  }).observe(el.grandTotal);
  el.bar.addEventListener("click", () => el.grandTotal.scrollIntoView({ behavior: "smooth", block: "center" }));
}

// ── Install prompts ──────────────────────────────────────────────────────

function setupInstall() {
  const standalone = matchMedia("(display-mode: standalone)").matches || navigator.standalone === true;
  let dismissed = false;
  try { dismissed = localStorage.getItem("installDismissed") === "1"; } catch { /* private mode */ }
  if (standalone || dismissed) return;
  const isIOS = /iPhone|iPad|iPod/.test(navigator.userAgent) || (navigator.platform === "MacIntel" && navigator.maxTouchPoints > 1);
  if (isIOS) { el.installIos.hidden = false; el.install.hidden = false; }
  let deferred = null;
  window.addEventListener("beforeinstallprompt", (e) => {
    e.preventDefault();
    deferred = e;
    el.installAndroid.hidden = false;
    el.installBtn.hidden = false;
    el.install.hidden = false;
  });
  el.installBtn.addEventListener("click", async () => {
    if (!deferred) return;
    deferred.prompt();
    try { await deferred.userChoice; } catch { /* ignore */ }
    deferred = null;
    el.install.hidden = true;
  });
  el.installDismiss.addEventListener("click", () => {
    el.install.hidden = true;
    try { localStorage.setItem("installDismissed", "1"); } catch { /* private mode */ }
  });
  window.addEventListener("appinstalled", () => { el.install.hidden = true; });
}

// ── Offline + updates ────────────────────────────────────────────────────

function registerServiceWorker() {
  if (!("serviceWorker" in navigator)) return;
  const hadController = Boolean(navigator.serviceWorker.controller); // false on the very first visit
  let reloading = false;
  navigator.serviceWorker.addEventListener("controllerchange", () => {
    if (!hadController || reloading) return; // first install: this page already is the newest version
    if (document.getElementById("splash")) {
      // Still on the splash, so nothing is being typed: swap in the new version unseen (without a second splash).
      reloading = true;
      try { sessionStorage.setItem("skipSplashOnce", "1"); } catch { /* private mode */ }
      location.reload();
      return;
    }
    // Mid-work: offer it. The next launch uses the new version anyway.
    el.update.hidden = false;
    el.updateBtn.onclick = () => {
      reloading = true;
      el.updateBtn.disabled = true;
      flushSave().finally(() => location.reload());
    };
  });
  navigator.serviceWorker.register("/sw.js").then((reg) => {
    document.addEventListener("visibilitychange", () => { if (document.visibilityState === "visible") reg.update().catch(() => {}); });
  }).catch((e) => console.warn("Offline mode isn't available:", e));
}

start();
