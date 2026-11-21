/**
 * Marlon Pro on the phone — shown only when the company has Pro switched on (license.js remembers it, so it works
 * offline too). Two buttons sit under "Speak the invoice":
 *
 *   Return       The rep logs returned goods: the store, each product with its quantity and reason (expired or
 *                damaged). The store signs, and a numbered credit note (CN-0001, CN-0002… on this phone) is created.
 *                Its amount comes off that store's next invoice automatically (db.js). Works fully offline.
 *   Shelf photo  The rep photographs a store shelf; Marlon shows which of the company's own products are on it and how
 *                many (counted by Google's Gemini on the free tier, through /api/pro/shelf). The photo is shrunk on the
 *                phone first (about 200 KB). With no signal it waits on the phone and is checked once back online.
 *                Each result has "Make an order" (Shelf Order, orders.js).
 *   Orders       Shelf orders taken on this phone: Pending, Delivered or Cancelled; open one at delivery.
 *
 *   setupPro({ bar, pro, getStore, getAddress, onCreditCreated, invoiceFromOrder, onOrderSaved })   // app.js, once
 */
import { credits, products, invoices, settings } from "./db.js";
import { business, creditNo, h, money, parseAmount, priceInputText, prettyDate, qtyWithUnit, storeKey, tidy, todayISO, withTotals, uid } from "./util.js";
import { SignaturePad } from "./signature.js";
import { alertSheet, toast } from "./ui.js";
import { canvasToPdfBlob } from "./pdf.js";
import { deliverFile } from "./share.js";
import { LETTER_PT } from "./letter.js";
import { openOrderForm, openOrders, setupOrders } from "./orders.js";
import { orders } from "./db.js";

const SHELF_QUEUE = "shelfQueue";     // photos taken offline, waiting to be checked: [{ id, at, store, image, products }]
const SHELF_HISTORY = "shelfChecks";  // the last checks on this phone: [{ id, at, store, found, unknown, missing, thumb }]
const REASONS = [["expired", "Expired"], ["damaged", "Damaged"]];
const reasonText = (r) => (r === "damaged" ? "Damaged" : "Expired");
let opts = {};
let isPro = false;

const icon = (d) => {
  const ns = "http://www.w3.org/2000/svg", svg = document.createElementNS(ns, "svg");
  svg.setAttribute("viewBox", "0 0 24 24"); svg.setAttribute("class", "icon"); svg.setAttribute("aria-hidden", "true");
  const p = document.createElementNS(ns, "path"); p.setAttribute("d", d); svg.append(p);
  return svg;
};
const ICON = {
  ret: "M9 14 4 9l5-5M4 9h10.5a5.5 5.5 0 0 1 0 11H11",
  camera: "M4 8.5A1.5 1.5 0 0 1 5.5 7h2l1.5-2.5h6L16.5 7h2A1.5 1.5 0 0 1 20 8.5v9a1.5 1.5 0 0 1-1.5 1.5h-13A1.5 1.5 0 0 1 4 17.5zM12 16.5a3.5 3.5 0 1 0 0-7 3.5 3.5 0 0 0 0 7z",
  close: "M6.5 6.5l11 11M17.5 6.5l-11 11",
  plus: "M12 5.5v13M5.5 12h13",
  orders: "M8 6h11M8 12h11M8 18h11M4 6h.01M4 12h.01M4 18h.01",
};

export function setupPro(o) {
  opts = o;
  setupOrders({ sheet, icon: (name) => icon(ICON[name]), invoiceFromOrder: (order) => opts.invoiceFromOrder(order),
    onOrderSaved: (order) => { document.dispatchEvent(new Event("pro:orders")); opts.onOrderSaved?.(order); } });
  document.addEventListener("pro:orders", () => { refreshOrderCount().catch(() => {}); });
  setPro(Boolean(o.pro));
  document.addEventListener("license:pro", (e) => {
    setPro(Boolean(e.detail?.pro));
    toast(e.detail?.pro ? "Marlon Pro is on for your company." : "Marlon Pro was switched off for your company.");
  });
  // The phone's check with the server starts before this runs: if it already changed Pro, pick that up now.
  settings.get("license", null).then((l) => { if (Boolean(l?.pro) !== isPro) setPro(Boolean(l?.pro)); }, () => {});
  window.addEventListener("online", () => { processShelfQueue().catch(() => {}); });
  processShelfQueue().catch(() => {});
}

function setPro(on) {
  isPro = on;
  const bar = opts.bar;
  if (!on) { bar.hidden = true; bar.replaceChildren(); return; }
  bar.replaceChildren(
    h("span", { class: "pro-tag" }, "Pro"),
    h("button", { type: "button", class: "btn pro-btn", id: "pro-return", onclick: () => openReturn() }, icon(ICON.ret), "Return"),
    h("button", { type: "button", class: "btn pro-btn", id: "pro-shelf", onclick: () => openShelf() }, icon(ICON.camera), "Shelf photo"),
    h("button", { type: "button", class: "btn pro-btn", id: "pro-orders", onclick: () => openOrders() }, icon(ICON.orders), "Orders", h("span", { class: "pro-count", id: "pro-order-count", hidden: true })));
  bar.hidden = false;
  refreshOrderCount().catch(() => {});
}

/** The number of pending orders, on the Orders button. */
async function refreshOrderCount() {
  const badge = document.getElementById("pro-order-count");
  if (!badge) return;
  const n = (await orders.all()).filter((x) => x.status === "pending").length;
  badge.textContent = String(n);
  badge.hidden = !n;
  badge.setAttribute("aria-label", `${n} pending`);
}

/** A full-screen sheet in the app's style. → { dlg, body, foot, close } */
function sheet(title, lead, cls) {
  const titleId = uid("t_");
  const dlg = h("dialog", { class: `pro-sheet ${cls || ""}`, "aria-labelledby": titleId });
  const body = h("div", { class: "pro-body" });
  const foot = h("div", { class: "pro-foot" });
  const close = () => { dlg.close(); dlg.remove(); };
  dlg.append(
    h("header", { class: "pro-head" },
      h("div", {}, h("p", { class: "pro-kicker" }, "Marlon Pro"), h("h2", { id: titleId, tabindex: "-1" }, title), lead ? h("p", { class: "pro-lead" }, lead) : null),
      h("button", { type: "button", class: "btn btn-icon btn-ghost pro-x", "aria-label": "Close", onclick: () => close() }, icon(ICON.close))),
    body, foot);
  dlg.addEventListener("cancel", (e) => { e.preventDefault(); close(); });
  document.body.append(dlg);
  dlg.showModal();
  dlg.querySelector("h2").focus();
  return { dlg, body, foot, close };
}

// ── Return → credit note ─────────────────────────────────────────────────

async function openReturn() {
  const list = await products.all();
  if (!list.length) { await alertSheet({ title: "Add your products first", message: "Returns use your product list. Add products in the dashboard's Settings, then try again." }); return; }
  const stores = await invoices.knownStores();
  const s = sheet("Return", "Log what the store is giving back. The store signs, and a numbered credit note comes off their next invoice automatically.", "pro-return");
  const storeIn = h("input", { type: "text", id: "ret-store", autocomplete: "off", autocapitalize: "words", maxlength: "60", placeholder: "e.g. Hill Top Grocery", value: opts.getStore?.() || "" });
  storeIn.setAttribute("list", "ret-stores"); // (an input's list can only be set as an attribute)
  const addressIn = h("textarea", { id: "ret-address", rows: "2", maxlength: "120", autocapitalize: "words", placeholder: "Street and town" });
  addressIn.value = opts.getAddress?.() || "";
  storeIn.addEventListener("input", () => {
    const known = stores.find((x) => storeKey(x.name) === storeKey(storeIn.value));
    if (known?.address && !addressIn.value.trim()) addressIn.value = known.address;
    validate();
  });
  const lines = [];
  const linesBox = h("ul", { class: "ret-lines" });
  const totalOut = h("strong", { class: "num ret-total-amount" }, money(0));
  const createBtn = h("button", { type: "button", class: "btn btn-primary btn-block btn-tall", id: "ret-create", disabled: true }, "Create credit note");
  const why = h("p", { class: "ret-why" });

  const addLine = (preset = {}) => {
    const sel = h("select", { class: "review-select ret-product", "aria-label": "Product" },
      h("option", { value: "" }, "Choose a product"), list.map((p) => h("option", { value: p.id }, p.name)));
    const qty = h("input", { type: "text", class: "ret-qty", inputmode: "decimal", autocomplete: "off", "aria-label": "Quantity", placeholder: "Qty" });
    const unit = h("span", { class: "ret-unit" }, "");
    const price = h("input", { type: "text", class: "ret-price", inputmode: "decimal", autocomplete: "off", "aria-label": "Price each", placeholder: "Price" });
    const line = { reason: "expired", sel, qty, price };
    const chips = REASONS.map(([v, label]) => h("button", { type: "button", class: `ret-chip${v === line.reason ? " is-on" : ""}`, "aria-pressed": String(v === line.reason), dataset: { reason: v }, onclick: (e) => {
      line.reason = v;
      for (const c of chips) { const on = c.dataset.reason === v; c.classList.toggle("is-on", on); c.setAttribute("aria-pressed", String(on)); }
      e.currentTarget.blur();
    } }, label));
    const lineTotal = h("span", { class: "num ret-line-total" }, "");
    const li = h("li", { class: "ret-line" },
      h("div", { class: "ret-line-top" }, sel,
        h("button", { type: "button", class: "btn btn-icon btn-ghost ret-remove", "aria-label": "Remove this product", onclick: () => { lines.splice(lines.indexOf(line), 1); li.remove(); validate(); } }, icon(ICON.close))),
      h("div", { class: "ret-line-mid" },
        h("label", { class: "ret-mini" }, h("span", {}, "Quantity"), h("span", { class: "ret-qty-wrap" }, qty, unit)),
        h("label", { class: "ret-mini" }, h("span", {}, "Price each"), h("span", { class: "review-money" }, "$", price)),
        lineTotal),
      h("div", { class: "ret-reasons", role: "group", "aria-label": "Reason" }, chips));
    sel.addEventListener("change", () => {
      const p = list.find((x) => x.id === sel.value);
      unit.textContent = p && p.unit && p.unit !== "each" ? p.unit : "";
      if (p && !price.value.trim() && p.price !== null && p.price !== undefined) price.value = priceInputText(p.price);
      if (p && !qty.value.trim()) qty.value = "1";
      validate();
    });
    qty.addEventListener("input", validate);
    price.addEventListener("input", validate);
    Object.assign(line, { li, lineTotal, unit });
    lines.push(line);
    linesBox.append(li);
    if (preset.productId) { sel.value = preset.productId; sel.dispatchEvent(new Event("change")); }
    validate();
  };

  const signCanvas = h("canvas", { class: "sign-canvas", id: "ret-sign", role: "img", "aria-label": "Signature box. The store signs here with a finger." });
  const padBox = h("div", { class: "sign-pad ret-pad" }, h("div", { class: "sign-guide", "aria-hidden": "true" }, h("span", { class: "sign-x" }, "×"), h("span", { class: "sign-here" }, "Store signs here")), signCanvas);
  const signer = h("input", { type: "text", id: "ret-signer", autocomplete: "off", autocapitalize: "words", maxlength: "60", placeholder: "Who is signing (optional)" });
  const clearBtn = h("button", { type: "button", class: "btn btn-small", onclick: () => { pad.clear(); validate(); } }, "Clear");

  const read = () => lines.map((l) => {
    const p = list.find((x) => x.id === l.sel.value);
    return p ? { productId: p.id, name: p.name, qty: parseAmount(l.qty.value), unit: p.unit || "each", price: parseAmount(l.price.value), reason: l.reason, line: l } : { line: l };
  });
  function validate() {
    const rows = read();
    let cents = 0;
    for (const r of rows) {
      const ok = r.name && r.qty > 0 && r.price !== null && r.price !== undefined;
      const t = ok ? withTotals({ items: [{ name: r.name, qty: r.qty, price: r.price }] }).total : null;
      r.line.lineTotal.textContent = t === null ? "" : money(t);
      if (t !== null) cents += Math.round(t * 100);
    }
    totalOut.textContent = money(cents / 100);
    const problem = !tidy(storeIn.value) ? "Type the store's name." : !rows.length ? "Add a returned product."
      : rows.some((r) => !r.name) ? "Choose each product." : rows.some((r) => !(r.qty > 0)) ? "Type each quantity." : rows.some((r) => r.price === null || r.price === undefined) ? "Type each price."
      : pad?.isEmpty() !== false ? "The store signs below." : "";
    why.textContent = problem;
    createBtn.disabled = Boolean(problem);
  }

  s.body.append(
    h("section", { class: "review-card" },
      h("div", { class: "review-field" }, h("label", { class: "review-field-label", for: "ret-store" }, "Store"), storeIn, h("datalist", { id: "ret-stores" }, stores.map((x) => h("option", { value: x.name })))),
      h("div", { class: "review-field" }, h("label", { class: "review-field-label", for: "ret-address" }, "Address"), addressIn)),
    h("h3", { class: "pro-h3" }, "Returned products"),
    linesBox,
    h("button", { type: "button", class: "btn review-add", id: "ret-add", onclick: () => addLine() }, icon(ICON.plus), "Add another product"),
    h("div", { class: "ret-total" }, h("span", {}, "Credit"), totalOut),
    h("h3", { class: "pro-h3" }, "Store signature"),
    h("div", { class: "card ret-sign" }, padBox, h("div", { class: "ret-sign-foot" }, signer, clearBtn)));
  s.foot.append(why, createBtn);
  const pad = new SignaturePad(signCanvas, { onChange: validate });
  addLine();
  storeIn.focus();

  createBtn.addEventListener("click", async () => {
    createBtn.disabled = true;
    try {
      const rows = read();
      const cn = await credits.create({ store: storeIn.value, address: addressIn.value, date: todayISO(), lines: rows, signature: pad.toDataURL(), signerName: signer.value });
      showCreditNote(s, cn);
      opts.onCreditCreated?.(cn);
    } catch (e) {
      createBtn.disabled = false;
      toast(e?.message || "Couldn't save the credit note on this phone.");
    }
  });
}

/** The finished credit note, with Share PDF. */
function showCreditNote(s, cn) {
  s.dlg.classList.add("is-done");
  s.dlg.querySelector("h2").textContent = `Credit note ${creditNo(cn.number)}`;
  s.dlg.querySelector(".pro-lead").textContent = `${money(cn.total)} comes off ${cn.store}'s next invoice automatically.`;
  s.body.replaceChildren(creditNoteView(cn));
  s.foot.replaceChildren(
    h("button", { type: "button", class: "btn btn-block", id: "cn-pdf", onclick: (e) => shareCreditNotePdf(cn, e.currentTarget) }, "Share PDF"),
    h("button", { type: "button", class: "btn btn-primary btn-block btn-tall", id: "cn-done", onclick: () => s.close() }, "Done"));
  toast(`Credit note ${creditNo(cn.number)} saved`);
}

export function creditNoteView(cn) {
  return h("article", { class: "cn-card", dataset: { number: String(cn.number) } },
    h("div", { class: "cn-top" }, h("strong", { class: "cn-no num" }, creditNo(cn.number)), h("span", {}, prettyDate(cn.date))),
    h("p", { class: "cn-store" }, cn.store), cn.address ? h("p", { class: "cn-address" }, cn.address) : null,
    h("ul", { class: "cn-lines" }, cn.lines.map((l) => h("li", {},
      h("div", {}, h("strong", {}, l.name), h("span", { class: "cn-meta" }, `${qtyWithUnit(l.qty, l.unit)} × ${money(l.price)} · ${reasonText(l.reason)}`)),
      h("span", { class: "num" }, money(l.total))))),
    h("div", { class: "cn-total" }, h("span", {}, "Credit"), h("strong", { class: "num" }, money(cn.total))),
    cn.signature ? h("figure", { class: "cn-sig" }, h("img", { src: cn.signature, alt: "Store's signature" }), h("figcaption", {}, `Signed for ${cn.store}${cn.signerName ? ` by ${cn.signerName}` : ""}`)) : null);
}

/** One letter page: the business, CREDIT NOTE CN-…, the store, returned products with reasons, the credit, the signature. */
export async function shareCreditNotePdf(cn, button) {
  if (button) button.disabled = true;
  try {
    const W = 1275, H = 1650, m = 90, c = document.createElement("canvas");
    c.width = W; c.height = H;
    const x = c.getContext("2d");
    x.fillStyle = "#fff"; x.fillRect(0, 0, W, H);
    const SANS = '-apple-system, BlinkMacSystemFont, "Helvetica Neue", Helvetica, Arial, sans-serif';
    const t = (s, size, px, py, { weight = 400, align = "left", color = "#111" } = {}) => { x.font = `${weight} ${size}px ${SANS}`; x.fillStyle = color; x.textAlign = align; x.fillText(String(s), px, py); };
    let y = m + 30;
    t(cn.seller || business.name || "", 38, m, y, { weight: 800 }); y += 34;
    if (business.address) for (const l of String(business.address).split("\n")) { t(l, 22, m, y, { color: "#555" }); y += 28; }
    if (business.phone) { t(`Tel: ${business.phone}`, 22, m, y, { color: "#555" }); y += 28; }
    t("CREDIT NOTE", 30, W - m, m + 30, { weight: 800, align: "right" });
    t(creditNo(cn.number), 26, W - m, m + 66, { weight: 700, align: "right" });
    t(prettyDate(cn.date), 22, W - m, m + 98, { align: "right", color: "#555" });
    y = Math.max(y, m + 130) + 30;
    t("CREDIT FOR", 18, m, y, { weight: 700, color: "#777" }); y += 32;
    t(cn.store, 28, m, y, { weight: 700 }); y += 32;
    if (cn.address) for (const l of String(cn.address).split("\n")) { t(l, 22, m, y, { color: "#555" }); y += 28; }
    y += 24;
    x.fillStyle = "#f1f1f1"; x.fillRect(m, y, W - 2 * m, 44);
    const col = { qty: m + 560, price: m + 760, reason: m + 800, total: W - m - 12 };
    t("RETURNED PRODUCT", 17, m + 12, y + 29, { weight: 700, color: "#555" });
    t("AMOUNT", 17, col.qty, y + 29, { weight: 700, color: "#555", align: "right" });
    t("PRICE", 17, col.price, y + 29, { weight: 700, color: "#555", align: "right" });
    t("REASON", 17, col.reason, y + 29, { weight: 700, color: "#555" });
    t("CREDIT", 17, col.total, y + 29, { weight: 700, color: "#555", align: "right" });
    y += 44;
    for (const l of cn.lines) {
      y += 40;
      t(l.name.length > 34 ? `${l.name.slice(0, 33)}…` : l.name, 22, m + 12, y);
      t(qtyWithUnit(l.qty, l.unit), 22, col.qty, y, { align: "right" });
      t(money(l.price), 22, col.price, y, { align: "right" });
      t(reasonText(l.reason), 22, col.reason, y);
      t(money(l.total), 22, col.total, y, { align: "right" });
      y += 14; x.fillStyle = "#ddd"; x.fillRect(m, y, W - 2 * m, 1);
    }
    y += 56;
    t("CREDIT", 30, col.price, y, { weight: 800, align: "right" });
    t(money(cn.total), 30, col.total, y, { weight: 800, align: "right" });
    y += 40;
    t("This amount comes off your next invoice.", 21, W - m, y, { align: "right", color: "#555" });
    y += 70;
    t("Store signature", 18, m, y, { weight: 700, color: "#777" }); y += 12;
    if (cn.signature) {
      const img = await new Promise((ok, no) => { const i = new Image(); i.onload = () => ok(i); i.onerror = no; i.src = cn.signature; }).catch(() => null);
      if (img) { const w = 480, hh = Math.round(w * (img.naturalHeight / img.naturalWidth || 1 / 3)); x.drawImage(img, m, y, w, hh); y += hh; }
    }
    x.fillStyle = "#999"; x.fillRect(m, y + 4, 480, 2);
    y += 34;
    t(`Signed for ${cn.store}${cn.signerName ? ` by ${cn.signerName}` : ""}`, 20, m, y, { color: "#555" });
    const blob = await canvasToPdfBlob(c, { page: LETTER_PT, title: `Credit note ${creditNo(cn.number)}` });
    await deliverFile(new File([blob], `credit-note-${creditNo(cn.number)}.pdf`, { type: "application/pdf" }), `Credit note ${creditNo(cn.number)}`);
  } catch (e) {
    console.error(e);
    toast("Couldn't make the PDF. Please try again.");
  } finally { if (button) button.disabled = false; }
}

// ── Shelf photo ──────────────────────────────────────────────────────────

/** Shrinks a photo on the phone: longest side at most `max` px, JPEG. → { data (base64), thumb (small data URL) } */
async function shrink(file, max = 1280) {
  const url = URL.createObjectURL(file);
  try {
    const img = await new Promise((ok, no) => { const i = new Image(); i.onload = () => ok(i); i.onerror = () => no(new Error("That photo couldn't be opened.")); i.src = url; });
    const draw = (limit, q) => {
      const k = Math.min(1, limit / Math.max(img.naturalWidth, img.naturalHeight));
      const c = document.createElement("canvas");
      c.width = Math.max(1, Math.round(img.naturalWidth * k)); c.height = Math.max(1, Math.round(img.naturalHeight * k));
      c.getContext("2d").drawImage(img, 0, 0, c.width, c.height);
      return c.toDataURL("image/jpeg", q);
    };
    const full = draw(max, 0.72);
    return { data: full.slice(full.indexOf(",") + 1), thumb: draw(240, 0.6) };
  } finally { URL.revokeObjectURL(url); }
}

/** Sends one photo to the server. → { found } | throws Error(message) ; error.offline when there's no connection. */
async function checkPhoto(image, names) {
  const lic = await settings.get("license", null);
  let res;
  try {
    res = await fetch("/api/pro/shelf", { method: "POST", headers: { "content-type": "application/json" }, cache: "no-store",
      body: JSON.stringify({ key: lic?.key, device: lic?.device, image, mime: "image/jpeg", products: names }) });
  } catch { const e = new Error("No connection."); e.offline = true; throw e; }
  const data = await res.json().catch(() => ({}));
  if (!res.ok) { const e = new Error(data.error || "The photo couldn't be checked. Try again."); e.status = res.status; throw e; }
  return data;
}

async function saveCheck(entry) {
  const list = (await settings.get(SHELF_HISTORY, [])) || [];
  await settings.set(SHELF_HISTORY, [entry, ...list.filter((x) => x.id !== entry.id)].slice(0, 30));
}

/** The company's products not seen on the shelf. list: [{ id, name }] (older queued photos: names only). */
const missingFrom = (found, list) => list.map((p) => (typeof p === "string" ? { id: null, name: p } : p))
  .filter((p) => !found.some((f) => (p.id && f.productId === p.id) || f.name === p.name)).map((p) => p.name);

/** Photos taken offline: checked one by one once there's a connection. */
let draining = false;
export async function processShelfQueue() {
  if (draining || !isPro || navigator.onLine === false) return;
  draining = true;
  try {
    let queue = (await settings.get(SHELF_QUEUE, [])) || [];
    while (queue.length) {
      const q = queue[0];
      try {
        const r = await checkPhoto(q.image, q.products);
        await saveCheck({ id: q.id, at: q.at, checkedAt: new Date().toISOString(), store: q.store, found: r.found, unknown: r.unknown || [], missing: missingFrom(r.found, q.list || q.products), thumb: q.thumb });
        toast(`Shelf photo${q.store ? ` at ${q.store}` : ""} checked: ${r.found.length} of your products seen.`, { ms: 3600 });
      } catch (e) {
        if (e.offline || e.status === 429 || e.status >= 500) break; // try again later
        await saveCheck({ id: q.id, at: q.at, store: q.store, error: e.message, found: [], missing: [], thumb: q.thumb });
      }
      queue = ((await settings.get(SHELF_QUEUE, [])) || []).filter((x) => x.id !== q.id);
      await settings.set(SHELF_QUEUE, queue);
    }
  } finally { draining = false; document.dispatchEvent(new Event("pro:shelf")); }
}

function resultView(entry, from = null) {
  if (entry.error) return h("div", { class: "shelf-result is-error" }, h("p", {}, entry.error));
  const orderBtn = h("button", { type: "button", class: "btn btn-primary btn-block shelf-order", dataset: { check: entry.id },
    onclick: () => openOrderForm({ store: entry.store || "", found: entry.found, shelfCheckId: entry.id, from }) }, "Make an order");
  const total = entry.found.reduce((n, f) => n + f.count, 0);
  return h("div", { class: "shelf-result" },
    h("p", { class: "shelf-summary" }, entry.found.length ? `${entry.found.length} of your products seen · ${total} unit${total === 1 ? "" : "s"}` : "None of your products were seen in this photo."),
    entry.found.length ? h("ul", { class: "shelf-found" }, entry.found.map((f) => h("li", {}, h("span", {}, f.name), h("strong", { class: "num" }, `× ${f.count}`)))) : null,
    entry.unknown?.length ? h("ul", { class: "shelf-found shelf-unknown" }, entry.unknown.map((u) => h("li", {},
      h("span", {}, "Unknown product", u.description ? h("small", {}, ` · ${u.description}`) : null), h("strong", { class: "num" }, `× ${u.count}`)))) : null,
    entry.unknown?.length ? h("p", { class: "shelf-missing" }, "Unknown products aren't in My Products, so they can't be ordered. Add them in My Products if you sell them.") : null,
    entry.missing?.length ? h("p", { class: "shelf-missing" }, h("strong", {}, "Not seen: "), entry.missing.join(", ")) : null,
    h("p", { class: "shelf-note" }, "Counted by AI from the photo. Check the shelf before relying on it."),
    isPro ? orderBtn : null);
}

async function openShelf() {
  const list = await products.all();
  const names = list.map((p) => p.name);
  if (!names.length) { await alertSheet({ title: "Add your products first", message: "Shelf photo looks for your own products. Add them in the dashboard's Settings, then try again." }); return; }
  const s = sheet("Shelf photo", "Take a photo of the shelf. Marlon shows which of your products are there, and how many.", "pro-shelf");
  const storeIn = h("input", { type: "text", id: "shelf-store", autocomplete: "off", autocapitalize: "words", maxlength: "60", placeholder: "Store (optional)", value: opts.getStore?.() || "" });
  const file = h("input", { type: "file", id: "shelf-file", accept: "image/*", capture: "environment", class: "visually-hidden", tabindex: "-1" });
  const preview = h("div", { class: "shelf-preview", hidden: true });
  const result = h("div", { class: "shelf-out", "aria-live": "polite" });
  const takeBtn = h("button", { type: "button", class: "btn btn-primary btn-block btn-tall", id: "shelf-take", onclick: () => file.click() }, icon(ICON.camera), "Take photo");
  const history = h("div", { class: "shelf-history" });
  let photo = null;

  const renderHistory = async () => {
    const [done, waiting] = await Promise.all([settings.get(SHELF_HISTORY, []), settings.get(SHELF_QUEUE, [])]);
    history.replaceChildren(
      (waiting || []).length ? h("p", { class: "shelf-waiting" }, `${waiting.length} photo${waiting.length === 1 ? "" : "s"} waiting for a connection to be checked.`) : null,
      (done || []).length ? h("h3", { class: "pro-h3" }, "Recent shelf photos") : null,
      ...(done || []).slice(0, 10).map((e) => h("details", { class: "shelf-past" },
        h("summary", {}, e.thumb ? h("img", { src: e.thumb, alt: "" }) : null,
          h("span", {}, h("strong", {}, e.store || "Shelf photo"), h("small", {}, `${new Date(e.at).toLocaleString([], { day: "numeric", month: "short", hour: "numeric", minute: "2-digit" })} · ${e.error ? "couldn't be checked" : `${e.found.length} product${e.found.length === 1 ? "" : "s"} seen`}`))),
        resultView(e, s))));
  };
  document.addEventListener("pro:shelf", renderHistory);
  s.dlg.addEventListener("close", () => document.removeEventListener("pro:shelf", renderHistory));

  file.addEventListener("change", async () => {
    const f = file.files?.[0];
    file.value = "";
    if (!f) return;
    result.replaceChildren(h("p", { class: "shelf-busy" }, "Getting the photo ready…"));
    try { photo = await shrink(f); } catch (e) { result.replaceChildren(h("p", { class: "shelf-result is-error" }, e.message)); return; }
    preview.replaceChildren(h("img", { src: `data:image/jpeg;base64,${photo.data}`, alt: "The shelf photo" }));
    preview.hidden = false;
    takeBtn.lastChild.textContent = "Take another photo";
    await runCheck();
  });

  async function runCheck() {
    if (!photo) return;
    const entry = { id: uid("sh_"), at: new Date().toISOString(), store: tidy(storeIn.value), image: photo.data, thumb: photo.thumb, products: names, list: list.map((p) => ({ id: p.id, name: p.name })) };
    if (navigator.onLine === false) return queueIt(entry);
    result.replaceChildren(h("p", { class: "shelf-busy" }, "Checking the shelf…"));
    try {
      const r = await checkPhoto(entry.image, names);
      const done = { id: entry.id, at: entry.at, checkedAt: new Date().toISOString(), store: entry.store, found: r.found, unknown: r.unknown || [], missing: missingFrom(r.found, entry.list), thumb: entry.thumb };
      await saveCheck(done);
      result.replaceChildren(resultView(done, s));
      renderHistory();
    } catch (e) {
      if (e.offline) return queueIt(entry);
      result.replaceChildren(h("div", { class: "shelf-result is-error" }, h("p", {}, e.message)));
    }
  }
  async function queueIt(entry) {
    const queue = (await settings.get(SHELF_QUEUE, [])) || [];
    await settings.set(SHELF_QUEUE, [...queue, entry].slice(-20));
    result.replaceChildren(h("div", { class: "shelf-result is-waiting" }, h("p", {}, "No connection right now. The photo is saved on this phone and will be checked as soon as you're back online.")));
    renderHistory();
  }

  s.body.append(
    h("section", { class: "review-card" }, h("div", { class: "review-field" }, h("label", { class: "review-field-label", for: "shelf-store" }, "Store"), storeIn)),
    file, takeBtn, preview, result, history);
  s.foot.replaceChildren(h("button", { type: "button", class: "btn btn-block", onclick: () => s.close() }, "Close"));
  renderHistory();
}

window.__pro = { processShelfQueue }; // (used by the tests)
