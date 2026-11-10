/**
 * Customer viewer (/v#…): shows an invoice decoded entirely from the link the customer scanned.
 * Nothing is loaded from any server except this page itself; the invoice is in the part after "#".
 * "Save PDF" makes the branded receipt PDF right here on the customer's phone; "Print" opens the phone's
 * print sheet.
 */
import { parseInvoiceHash } from "./codec.js";
import { h, invoiceNo, money, prettyDate, qtyText } from "./util.js";
import { WORDMARK } from "./wordmark.js";
import { deliverFile, makeReceiptFile } from "./share.js";
import { toast } from "./ui.js";

const root = document.getElementById("view");

/** The "Marlon" wordmark as an inline SVG (same outlines as the app's splash and brand bar). */
function wordmark() {
  const ns = "http://www.w3.org/2000/svg";
  const svg = document.createElementNS(ns, "svg");
  svg.setAttribute("viewBox", WORDMARK.viewBox.join(" "));
  svg.setAttribute("class", "brand-wordmark");
  svg.setAttribute("role", "img");
  svg.setAttribute("aria-label", "Marlon");
  const path = document.createElementNS(ns, "path");
  path.setAttribute("d", WORDMARK.d);
  path.setAttribute("fill", "currentColor");
  svg.append(path);
  return svg;
}

function render() {
  const inv = parseInvoiceHash(location.hash);
  if (!inv) {
    document.title = "Invoice";
    root.replaceChildren(h("section", { class: "sheet sheet-empty" },
      h("h1", {}, "No invoice here"),
      h("p", {}, "This link doesn't contain an invoice. Ask for a new QR code.")));
    return;
  }
  document.title = `Invoice ${invoiceNo(inv.number)} · ${inv.seller}`;
  const n = inv.items.length;
  const mismatch = Math.abs(inv.computedTotal - inv.total) >= 0.005;
  root.replaceChildren(
    h("article", { class: "sheet" },
      h("header", { class: "sheet-head" },
        h("div", { class: "brand" }, wordmark(), h("p", { class: "brand-tag" }, "Delivery Invoices")),
        h("h1", { class: "seller" }, inv.seller),
        h("p", { class: "meta num" }, `Invoice No. ${invoiceNo(inv.number)}`, h("span", { "aria-hidden": "true" }, " · "), prettyDate(inv.date))),
      h("section", { class: "billed", "aria-label": "Delivered to" },
        h("p", { class: "label" }, "Delivered to"),
        h("p", { class: "store" }, inv.store || "—"),
        inv.address ? h("p", { class: "address" }, inv.address) : null),
      h("ul", { class: "items", "aria-label": "Items" },
        n ? inv.items.map((it) => h("li", { class: "item" },
          h("span", { class: "item-name" }, it.name),
          h("span", { class: "item-calc num" }, `${qtyText(it.qty) || "0"} × ${it.price === null ? "(no price)" : money(it.price)}`),
          h("span", { class: "item-amt num" }, money(it.total))))
          : h("li", { class: "item item-none" }, "No items")),
      h("div", { class: "total" },
        h("span", { class: "total-label" }, "Total", h("small", {}, `${n} item${n === 1 ? "" : "s"}`)),
        h("strong", { class: "total-amt num" }, money(inv.total))),
      mismatch ? h("p", { class: "note" }, `The items add up to ${money(inv.computedTotal)}. The total above is the one on the invoice, so please check with ${inv.seller}.`) : null,
      h("p", { class: `signed ${inv.signed ? "is-yes" : "is-no"}` }, inv.signed ? "✓ Signed by the customer" : "Not signed"),
      h("footer", { class: "sheet-foot" }, `Shared by QR code by ${inv.seller}. The details come from the code itself and are never sent to a server.`)),
    h("div", { class: "view-actions" },
      h("button", { type: "button", class: "btn btn-primary", onclick: (e) => savePdf(e.currentTarget, inv) }, icon("download"), "Save PDF"),
      h("button", { type: "button", class: "btn", onclick: () => window.print() }, icon("printer"), "Print")));
}

const ICONS = {
  download: "M12 3v12M7 10l5 5 5-5M5 21h14",
  printer: "M7 9V3h10v6M7 17H5a2 2 0 0 1-2-2v-4a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2v4a2 2 0 0 1-2 2h-2M7 14h10v7H7z",
};
function icon(name) {
  const ns = "http://www.w3.org/2000/svg";
  const svg = document.createElementNS(ns, "svg");
  svg.setAttribute("viewBox", "0 0 24 24");
  svg.setAttribute("class", "view-icon");
  svg.setAttribute("aria-hidden", "true");
  const path = document.createElementNS(ns, "path");
  path.setAttribute("d", ICONS[name]);
  svg.append(path);
  return svg;
}

/** The decoded invoice in the shape the receipt maker expects (customer copies carry the "signed" mark only). */
const asInvoice = (inv) => ({
  seller: inv.seller, number: inv.number, date: inv.date, store: inv.store, address: inv.address,
  items: inv.items.map(({ name, qty, price }) => ({ name, qty, price })), signature: null, signed: inv.signed,
});

async function savePdf(button, inv) {
  if (button.getAttribute("aria-busy") === "true") return;
  button.setAttribute("aria-busy", "true");
  try {
    const file = await makeReceiptFile(asInvoice(inv), { kind: "pdf", paper: 80 });
    await deliverFile(file, `Invoice ${invoiceNo(inv.number)} · ${inv.seller}`);
  } catch (e) {
    console.error(e);
    toast("Couldn't make the PDF. Please try again.");
  } finally {
    button.removeAttribute("aria-busy");
  }
}

window.addEventListener("hashchange", render);
render();
