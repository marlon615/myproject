/**
 * Marlon Pro: Shelf Order — on the phone, offline like the rest of Marlon.
 *
 *   After a shelf photo, "Make an order" opens the order form, filled in from the shelf count. The rep sets a target for
 *   each product (e.g. 20 each) and Marlon works out how many to order: target minus what's on the shelf (never below 0).
 *   Any amount can be changed before saving. The store person placing the order types their name and signs; the order
 *   is saved with the store, their name, signature, date and time, numbered ORD-0001, ORD-0002… on this phone.
 *   Orders are Pending, Delivered or Cancelled. At delivery the driver opens the order (Orders button) and shows who
 *   ordered it, with their name and signature. "Delivered: make the invoice" turns it into an invoice in one tap.
 *   For a team, orders go to the boss dashboard with the team sync (team.js); a solo business sees them in its own
 *   dashboard. Share PDF sends the order (with the signature) to a driver on another phone.
 *
 *   openOrderForm(sheet, { store, address, found, shelfCheckId })   // from a shelf photo result (pro.js)
 *   openOrders()                                                   // the Orders button (pro.js)
 *   orderView(order), shareOrderPdf(order, button)                 // also used by the dashboard
 */
import { orders, orderQty, products, invoices, settings } from "./db.js";
import { business, h, orderNo, parseAmount, prettyDate, qtyText, qtyWithUnit, storeKey, tidy } from "./util.js";
import { SignaturePad } from "./signature.js";
import { alertSheet, choiceSheet, toast } from "./ui.js";
import { canvasToPdfBlob } from "./pdf.js";
import { deliverFile } from "./share.js";
import { LETTER_PT } from "./letter.js";

const TARGET_KEY = "orderTarget"; // the last target the rep used, offered next time
export const STATUS_TEXT = { pending: "Pending", delivered: "Delivered", cancelled: "Cancelled" };
let hooks = {}; // { sheet, icon, invoiceFromOrder(order) → { id, number }, onOrderSaved(order) }

export function setupOrders(h0) { hooks = h0; }

const timeText = (iso) => (iso ? new Date(iso).toLocaleString([], { day: "numeric", month: "short", year: "numeric", hour: "numeric", minute: "2-digit" }) : "");
const amountText = (n) => (n === null || n === undefined || Number.isNaN(n) ? "" : qtyText(n));

// ── The order form ───────────────────────────────────────────────────────

/**
 * Opens the order form. found: [{ name, count }] from the shelf photo (only the company's own products).
 * `from` is the shelf sheet the order was started from (it closes when the order is saved).
 */
export async function openOrderForm({ store = "", address = "", found = [], shelfCheckId = null, from = null } = {}) {
  const list = await products.all();
  if (!list.length) { await alertSheet({ title: "Add your products first", message: "Orders use your product list. Add products in the dashboard's Settings, then try again." }); return; }
  const stores = await invoices.knownStores();
  const lastTarget = parseAmount(await settings.get(TARGET_KEY, 20)) || 20;
  const s = hooks.sheet("Make an order", "Set how many of each product the store wants on the shelf. Marlon orders the difference.", "pro-order");
  const storeIn = h("input", { type: "text", id: "ord-store", autocomplete: "off", autocapitalize: "words", maxlength: "60", placeholder: "e.g. Hill Top Grocery", value: store });
  storeIn.setAttribute("list", "ord-stores");
  const addressIn = h("textarea", { id: "ord-address", rows: "2", maxlength: "120", autocapitalize: "words", placeholder: "Street and town" });
  const known = () => stores.find((x) => storeKey(x.name) === storeKey(storeIn.value));
  addressIn.value = address || known()?.address || "";
  storeIn.addEventListener("input", () => { if (known()?.address && !addressIn.value.trim()) addressIn.value = known().address; validate(); });

  const allTarget = h("input", { type: "text", id: "ord-all-target", inputmode: "decimal", autocomplete: "off", value: amountText(lastTarget), "aria-label": "Target for every product" });
  const lines = [];
  const linesBox = h("ul", { class: "ord-lines" });
  const why = h("p", { class: "ret-why" });
  const saveBtn = h("button", { type: "button", class: "btn btn-primary btn-block btn-tall", id: "ord-save", disabled: true }, "Save order");
  const totalOut = h("strong", { class: "num", id: "ord-count" }, "0 products");

  const addLine = ({ productId = "", onShelf = 0, target = lastTarget } = {}) => {
    const sel = h("select", { class: "review-select ord-product", "aria-label": "Product" },
      h("option", { value: "" }, "Choose a product"), list.map((p) => h("option", { value: p.id }, p.name)));
    const shelf = h("input", { type: "text", class: "ord-shelf", inputmode: "decimal", autocomplete: "off", "aria-label": "On the shelf", value: amountText(onShelf) });
    const tgt = h("input", { type: "text", class: "ord-target", inputmode: "decimal", autocomplete: "off", "aria-label": "Target", value: amountText(target) });
    const qty = h("input", { type: "text", class: "ord-qty", inputmode: "decimal", autocomplete: "off", "aria-label": "Order" });
    const unit = h("span", { class: "ord-unit" }, "");
    const line = { sel, shelf, tgt, qty, unit, manual: false };
    const recalc = () => { if (!line.manual) { const q = orderQty(tgt.value, shelf.value); qty.value = q === null ? "" : amountText(q); } validate(); };
    shelf.addEventListener("input", () => { line.manual = false; recalc(); });
    tgt.addEventListener("input", () => { line.manual = false; recalc(); });
    qty.addEventListener("input", () => { line.manual = true; validate(); }); // the rep's own amount wins until the target or shelf changes
    sel.addEventListener("change", () => { const p = list.find((x) => x.id === sel.value); unit.textContent = p && p.unit && p.unit !== "each" ? p.unit : ""; validate(); });
    const li = h("li", { class: "ord-line" },
      h("div", { class: "ret-line-top" }, sel,
        h("button", { type: "button", class: "btn btn-icon btn-ghost ord-remove", "aria-label": "Remove this product", onclick: () => { lines.splice(lines.indexOf(line), 1); li.remove(); validate(); } }, hooks.icon("close"))),
      h("div", { class: "ord-line-mid" },
        h("label", { class: "ret-mini" }, h("span", {}, "On shelf"), shelf),
        h("label", { class: "ret-mini" }, h("span", {}, "Target"), tgt),
        h("label", { class: "ret-mini ord-qty-label" }, h("span", {}, "Order"), h("span", { class: "ord-qty-wrap" }, qty, unit))));
    line.li = li;
    lines.push(line);
    linesBox.append(li);
    if (productId) { sel.value = productId; sel.dispatchEvent(new Event("change")); }
    recalc();
  };

  const signCanvas = h("canvas", { class: "sign-canvas", id: "ord-sign", role: "img", "aria-label": "Signature box. The person placing the order signs here with a finger." });
  const padBox = h("div", { class: "sign-pad ret-pad" }, h("div", { class: "sign-guide", "aria-hidden": "true" }, h("span", { class: "sign-x" }, "×"), h("span", { class: "sign-here" }, "Sign here to place the order")), signCanvas);
  const signer = h("input", { type: "text", id: "ord-signer", autocomplete: "off", autocapitalize: "words", maxlength: "60", placeholder: "Name of the person ordering" });
  signer.addEventListener("input", () => validate());
  const clearBtn = h("button", { type: "button", class: "btn btn-small", onclick: () => { pad.clear(); validate(); } }, "Clear");

  const read = () => lines.map((l) => {
    const p = list.find((x) => x.id === l.sel.value);
    return p ? { productId: p.id, name: p.name, unit: p.unit || "each", onShelf: parseAmount(l.shelf.value) ?? 0, target: parseAmount(l.tgt.value), qty: parseAmount(l.qty.value), line: l } : { line: l };
  });
  function validate() {
    const rows = read();
    const ordering = rows.filter((r) => r.name && r.qty > 0);
    totalOut.textContent = `${ordering.length} product${ordering.length === 1 ? "" : "s"}`;
    const ids = rows.filter((r) => r.name).map((r) => r.productId);
    const problem = !tidy(storeIn.value) ? "Type the store's name." : !rows.length ? "Add a product to order."
      : rows.some((r) => !r.name) ? "Choose each product." : new Set(ids).size !== ids.length ? "Each product only once, please."
      : rows.some((r) => r.qty === null || r.qty < 0) ? "Type how many to order (0 to leave a product out)." : !ordering.length ? "Order at least one product (an amount above 0)."
      : !tidy(signer.value) ? "The person ordering types their name." : pad?.isEmpty() !== false ? "The person ordering signs below." : "";
    why.textContent = problem;
    saveBtn.disabled = Boolean(problem);
  }

  allTarget.addEventListener("change", () => {
    const t = parseAmount(allTarget.value);
    if (t === null || t < 0) return;
    for (const l of lines) { l.tgt.value = amountText(t); l.manual = false; l.tgt.dispatchEvent(new Event("input")); }
  });

  s.body.append(
    h("section", { class: "review-card" },
      h("div", { class: "review-field" }, h("label", { class: "review-field-label", for: "ord-store" }, "Store"), storeIn, h("datalist", { id: "ord-stores" }, stores.map((x) => h("option", { value: x.name })))),
      h("div", { class: "review-field" }, h("label", { class: "review-field-label", for: "ord-address" }, "Address"), addressIn)),
    h("div", { class: "ord-all" }, h("label", { for: "ord-all-target" }, h("strong", {}, "Target for every product"), h("small", {}, "Change it here for all, or per product below.")), allTarget),
    h("h3", { class: "pro-h3" }, "Products"),
    found.length ? h("p", { class: "ord-hint" }, "Filled in from the shelf photo. Check the shelf count; Order = target − on shelf.") : null,
    linesBox,
    h("button", { type: "button", class: "btn review-add", id: "ord-add", onclick: () => addLine({ onShelf: 0, target: parseAmount(allTarget.value) ?? lastTarget }) }, hooks.icon("plus"), "Add another product"),
    h("div", { class: "ret-total" }, h("span", {}, "Ordering"), totalOut),
    h("h3", { class: "pro-h3" }, "Placed by"),
    h("div", { class: "card ret-sign" }, h("div", { class: "review-field" }, h("label", { class: "review-field-label", for: "ord-signer" }, "Name of the person ordering"), signer), padBox, h("div", { class: "ret-sign-foot" }, h("span", { class: "ord-sign-note" }, "They sign to place the order."), clearBtn)));
  s.foot.append(why, saveBtn);
  const pad = new SignaturePad(signCanvas, { onChange: validate });
  for (const f of found) {
    const p = (f.productId && list.find((x) => x.id === f.productId)) || list.find((x) => x.name.toLowerCase() === String(f.name).toLowerCase());
    if (p) addLine({ productId: p.id, onShelf: Number(f.count) || 0, target: lastTarget });
  }
  if (!lines.length) addLine({ onShelf: 0, target: lastTarget });
  validate();

  saveBtn.addEventListener("click", async () => {
    saveBtn.disabled = true;
    try {
      const t = parseAmount(allTarget.value);
      if (t !== null && t > 0) await settings.set(TARGET_KEY, t);
      const o = await orders.create({ store: storeIn.value, address: addressIn.value, lines: read(), signature: pad.toDataURL(), signerName: signer.value, shelfCheckId });
      from?.close?.();
      showSavedOrder(s, o);
    } catch (e) {
      saveBtn.disabled = false;
      toast(e?.message || "Couldn't save the order on this phone.");
    }
  });
}

/** The saved order, with Share PDF and Done (Done sends it to the boss, or keeps it waiting for signal). */
function showSavedOrder(s, o) {
  s.dlg.classList.add("is-done");
  s.dlg.querySelector("h2").textContent = `Order ${orderNo(o.number)}`;
  s.dlg.querySelector(".pro-lead").textContent = `Saved for ${o.store}. Pending until it's delivered.`;
  s.body.replaceChildren(orderView(o));
  s.foot.replaceChildren(
    h("button", { type: "button", class: "btn btn-block", id: "ord-pdf", onclick: (e) => shareOrderPdf(o, e.currentTarget) }, "Share PDF"),
    h("button", { type: "button", class: "btn btn-primary btn-block btn-tall", id: "ord-done", onclick: () => { s.close(); hooks.onOrderSaved?.(o); } }, "Done"));
  toast(`Order ${orderNo(o.number)} saved`);
}

// ── Showing an order ─────────────────────────────────────────────────────

export function orderView(o) {
  return h("article", { class: `ord-card is-${o.status}`, dataset: { number: String(o.number), status: o.status } },
    h("div", { class: "cn-top" }, h("strong", { class: "cn-no num" }, orderNo(o.number)), h("span", { class: `ord-status is-${o.status}` }, STATUS_TEXT[o.status] || o.status)),
    h("p", { class: "cn-store" }, o.store), o.address ? h("p", { class: "cn-address" }, o.address) : null,
    h("p", { class: "ord-when" }, `Ordered ${timeText(o.signedAt || o.createdAt)}`),
    h("table", { class: "ord-table" },
      h("thead", {}, h("tr", {}, h("th", { scope: "col" }, "Product"), h("th", { scope: "col", class: "num" }, "Shelf"), h("th", { scope: "col", class: "num" }, "Target"), h("th", { scope: "col", class: "num" }, "Order"))),
      h("tbody", {}, o.lines.map((l) => h("tr", {}, h("td", {}, l.name), h("td", { class: "num" }, amountText(l.onShelf)), h("td", { class: "num" }, amountText(l.target)), h("td", { class: "num ord-q" }, qtyWithUnit(l.qty, l.unit)))))),
    h("figure", { class: "cn-sig ord-sig" },
      o.signature ? h("img", { src: o.signature, alt: `Signature of ${o.signerName}` }) : null,
      h("figcaption", {}, h("strong", {}, `Ordered by ${o.signerName}`), h("span", {}, ` for ${o.store} · ${timeText(o.signedAt || o.createdAt)}`))),
    o.status === "delivered" ? h("p", { class: "ord-after" }, `Delivered ${timeText(o.deliveredAt)}${o.invoiceNumber ? ` · invoice No. ${String(o.invoiceNumber).padStart(4, "0")}` : ""}`) : null,
    o.status === "cancelled" ? h("p", { class: "ord-after" }, `Cancelled ${timeText(o.cancelledAt)}`) : null);
}

/** The Orders button: every order on this phone, pending first. Tap one to open it (e.g. at delivery). */
export async function openOrders() {
  const s = hooks.sheet("Orders", "Shelf orders taken on this phone. Open one at delivery to show who ordered it.", "pro-orders");
  const filter = { status: "pending" };
  const listBox = h("div", { class: "ord-list" });
  const chips = ["pending", "delivered", "cancelled", "all"].map((st) => h("button", { type: "button", class: `ret-chip${st === filter.status ? " is-on" : ""}`, "aria-pressed": String(st === filter.status), dataset: { status: st },
    onclick: () => { filter.status = st; for (const c of chips) { const on = c.dataset.status === st; c.classList.toggle("is-on", on); c.setAttribute("aria-pressed", String(on)); } render(); } },
    st === "all" ? "All" : STATUS_TEXT[st]));
  async function render() {
    const all = await orders.all();
    const shown = all.filter((o) => filter.status === "all" || o.status === filter.status);
    for (const c of chips) { const st = c.dataset.status, n = st === "all" ? all.length : all.filter((o) => o.status === st).length; c.textContent = `${st === "all" ? "All" : STATUS_TEXT[st]} (${n})`; }
    listBox.replaceChildren(...(shown.length ? shown.map((o) => h("button", { type: "button", class: "ord-row", dataset: { id: o.id }, onclick: () => openOrder(o.id, render) },
      h("span", {}, h("strong", {}, `${orderNo(o.number)} · ${o.store}`), h("small", {}, `${timeText(o.signedAt || o.createdAt)} · ${o.lines.length} product${o.lines.length === 1 ? "" : "s"} · by ${o.signerName}`)),
      h("span", { class: `ord-status is-${o.status}` }, STATUS_TEXT[o.status])))
      : [h("p", { class: "ord-empty" }, all.length ? "No orders here." : "No orders yet. Take a shelf photo, then tap “Make an order”.")]));
  }
  s.body.append(h("div", { class: "ret-reasons ord-filter", role: "group", "aria-label": "Show" }, chips), listBox);
  s.foot.replaceChildren(h("button", { type: "button", class: "btn btn-block", onclick: () => s.close() }, "Close"));
  await render();
}

/** One order, full screen: who ordered it (name and signature), what, and what happens next. */
export async function openOrder(id, after = null) {
  const o = await orders.get(id);
  if (!o) { toast("That order no longer exists."); return; }
  const s = hooks.sheet(`Order ${orderNo(o.number)}`, `${STATUS_TEXT[o.status]} · ${o.store}`, "pro-order-view");
  s.body.append(orderView(o));
  const pdf = h("button", { type: "button", class: "btn btn-block", id: "ord-view-pdf", onclick: (e) => shareOrderPdf(o, e.currentTarget) }, "Share PDF");
  if (o.status !== "pending") { s.foot.replaceChildren(pdf, h("button", { type: "button", class: "btn btn-block", onclick: () => s.close() }, "Close")); return; }
  const deliver = h("button", { type: "button", class: "btn btn-primary btn-block btn-tall", id: "ord-deliver", onclick: async () => {
    deliver.disabled = true;
    try {
      const inv = await hooks.invoiceFromOrder(o);
      await orders.setStatus(o.id, "delivered", { invoiceId: inv.id, invoiceNumber: inv.number });
      s.close();
      document.querySelectorAll("dialog.pro-orders").forEach((d) => { d.close(); d.remove(); });
      hooks.onOrderSaved?.(o);
      toast(`Order ${orderNo(o.number)} delivered. Invoice No. ${String(inv.number).padStart(4, "0")} is ready: check it, then the store signs.`, { ms: 4200 });
    } catch (e) {
      deliver.disabled = false;
      toast(e?.message || "Couldn't make the invoice. Please try again.");
    }
  } }, "Delivered: make the invoice");
  const cancel = h("button", { type: "button", class: "btn btn-block btn-ghost ord-cancel", id: "ord-cancel", onclick: async () => {
    const yes = await choiceSheet({ title: `Cancel order ${orderNo(o.number)}?`, message: `${o.store}'s order will show as Cancelled. It can't be undone.`,
      choices: [{ label: "Keep it", value: false }, { label: "Cancel the order", value: true, primary: true }] });
    if (!yes) return;
    await orders.setStatus(o.id, "cancelled");
    s.close();
    hooks.onOrderSaved?.(o);
    after?.();
    toast(`Order ${orderNo(o.number)} cancelled`);
  } }, "Cancel order");
  s.foot.replaceChildren(deliver, pdf, cancel);
}

// ── PDF (for a driver on another phone, or the store) ────────────────────

export async function shareOrderPdf(o, button) {
  if (button) button.disabled = true;
  try {
    const W = 1275, H = 1650, m = 90, c = document.createElement("canvas");
    c.width = W; c.height = H;
    const x = c.getContext("2d");
    x.fillStyle = "#fff"; x.fillRect(0, 0, W, H);
    const SANS = '-apple-system, BlinkMacSystemFont, "Helvetica Neue", Helvetica, Arial, sans-serif';
    const t = (s, size, px, py, { weight = 400, align = "left", color = "#111" } = {}) => { x.font = `${weight} ${size}px ${SANS}`; x.fillStyle = color; x.textAlign = align; x.fillText(String(s), px, py); };
    let y = m + 30;
    t(business.name || "", 38, m, y, { weight: 800 }); y += 34;
    if (business.address) for (const l of String(business.address).split("\n")) { t(l, 22, m, y, { color: "#555" }); y += 28; }
    if (business.phone) { t(`Tel: ${business.phone}`, 22, m, y, { color: "#555" }); y += 28; }
    t("ORDER", 30, W - m, m + 30, { weight: 800, align: "right" });
    t(orderNo(o.number), 26, W - m, m + 66, { weight: 700, align: "right" });
    t(`${STATUS_TEXT[o.status]} · ${prettyDate(o.date)}`, 22, W - m, m + 98, { align: "right", color: "#555" });
    y = Math.max(y, m + 130) + 30;
    t("ORDER FOR", 18, m, y, { weight: 700, color: "#777" }); y += 32;
    t(o.store, 28, m, y, { weight: 700 }); y += 32;
    if (o.address) for (const l of String(o.address).split("\n")) { t(l, 22, m, y, { color: "#555" }); y += 28; }
    y += 24;
    x.fillStyle = "#f1f1f1"; x.fillRect(m, y, W - 2 * m, 44);
    const col = { shelf: m + 700, target: m + 880, qty: W - m - 12 };
    t("PRODUCT", 17, m + 12, y + 29, { weight: 700, color: "#555" });
    t("ON SHELF", 17, col.shelf, y + 29, { weight: 700, color: "#555", align: "right" });
    t("TARGET", 17, col.target, y + 29, { weight: 700, color: "#555", align: "right" });
    t("ORDER", 17, col.qty, y + 29, { weight: 700, color: "#555", align: "right" });
    y += 44;
    for (const l of o.lines) {
      y += 40;
      t(l.name.length > 40 ? `${l.name.slice(0, 39)}…` : l.name, 22, m + 12, y);
      t(amountText(l.onShelf), 22, col.shelf, y, { align: "right" });
      t(amountText(l.target), 22, col.target, y, { align: "right" });
      t(qtyWithUnit(l.qty, l.unit), 22, col.qty, y, { align: "right", weight: 700 });
      y += 14; x.fillStyle = "#ddd"; x.fillRect(m, y, W - 2 * m, 1);
    }
    y += 70;
    t("Ordered by", 18, m, y, { weight: 700, color: "#777" }); y += 12;
    if (o.signature) {
      const img = await new Promise((ok, no) => { const i = new Image(); i.onload = () => ok(i); i.onerror = no; i.src = o.signature; }).catch(() => null);
      if (img) { const w = 480, hh = Math.round(w * (img.naturalHeight / img.naturalWidth || 1 / 3)); x.drawImage(img, m, y, w, hh); y += hh; }
    }
    x.fillStyle = "#999"; x.fillRect(m, y + 4, 480, 2);
    y += 34;
    t(`${o.signerName} for ${o.store} · ${timeText(o.signedAt || o.createdAt)}`, 20, m, y, { color: "#555" });
    const blob = await canvasToPdfBlob(c, { page: LETTER_PT, title: `Order ${orderNo(o.number)}` });
    await deliverFile(new File([blob], `order-${orderNo(o.number)}.pdf`, { type: "application/pdf" }), `Order ${orderNo(o.number)}`);
  } catch (e) {
    console.error(e);
    toast("Couldn't make the PDF. Please try again.");
  } finally { if (button) button.disabled = false; }
}
