/**
 * Customer viewer (/v#…): shows an invoice decoded entirely from the link the customer scanned.
 * Nothing is loaded from any server except this page itself; the invoice is in the part after "#".
 */
import { parseInvoiceHash } from "./codec.js";
import { h, invoiceNo, money, prettyDate, qtyText } from "./util.js";

const root = document.getElementById("view");

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
        h("p", { class: "kicker" }, "Delivery invoice"),
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
      h("button", { type: "button", class: "btn btn-primary", onclick: () => window.print() }, "Save or print")));
}

window.addEventListener("hashchange", render);
render();
