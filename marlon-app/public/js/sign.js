/**
 * The buyer's signing page (/s/<secret>): no app, no login. It shows the invoice exactly as the seller sent it,
 * read-only: everything comes from the server's frozen copy, and the only things the buyer can send back are their
 * name and their signature (the server refuses anything else, and any copy that doesn't match). After signing: a
 * green checkmark, "Signed by … on …", and a PDF of the signed receipt. Opening the link again shows the signed copy.
 */
import { SignaturePad } from "./signature.js";
import { makeReceiptFile } from "./share.js";
import { h, invoiceNo, money, prettyDate, qtyWithUnit, signedByText, tidy, creditLabel } from "./util.js";

const root = document.getElementById("sg");
const token = (location.pathname.match(/^\/s\/([0-9a-f]{64})$/) || [])[1] || "";

async function post(path, body) {
  try {
    const res = await fetch(path, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
    return { ok: res.ok, status: res.status, data: await res.json().catch(() => ({})) };
  } catch { return { ok: false, status: 0, data: { error: "No internet connection. Check your signal and try again." } }; }
}

function message(title, text) {
  root.replaceChildren(h("section", { class: "sg-card sg-msg" }, h("h1", {}, title), h("p", {}, text)));
}

/** The invoice, read-only: seller, buyer, items, quantities, prices, total. Nothing here is a form field. */
function invoiceView(inv) {
  return h("section", { class: "sg-card sg-invoice", "aria-label": "Invoice" },
    h("div", { class: "sg-head" },
      h("div", {},
        h("p", { class: "sg-seller" }, tidy(inv.seller) || "Invoice"),
        inv.sellerAddress ? h("p", { class: "sg-small" }, tidy(inv.sellerAddress)) : null,
        inv.sellerPhone ? h("p", { class: "sg-small" }, tidy(inv.sellerPhone)) : null),
      h("div", { class: "sg-meta" }, h("p", {}, `Invoice No. ${invoiceNo(inv.number)}`), h("p", {}, prettyDate(inv.date)))),
    h("div", { class: "sg-to" }, h("p", { class: "sg-label" }, "For"), h("p", { class: "sg-buyer" }, tidy(inv.store)), inv.address ? h("p", { class: "sg-small" }, tidy(inv.address)) : null),
    h("table", { class: "sg-items" },
      h("thead", {}, h("tr", {}, h("th", { scope: "col" }, "Item"), h("th", { scope: "col", class: "n" }, "Qty"), h("th", { scope: "col", class: "n" }, "Price"), h("th", { scope: "col", class: "n" }, "Total"))),
      h("tbody", {}, ...inv.items.map((it) => h("tr", {}, h("td", {}, it.name), h("td", { class: "n" }, qtyWithUnit(it.qty, it.unit)), h("td", { class: "n" }, money(it.price)), h("td", { class: "n" }, money(it.total))))),
      h("tfoot", {},
        ...(inv.credit ? [h("tr", {}, h("th", { scope: "row", colspan: "3" }, "Subtotal"), h("td", { class: "n" }, money(inv.subtotal))),
          h("tr", { class: "sg-credit" }, h("th", { scope: "row", colspan: "3" }, creditLabel(inv.credit)), h("td", { class: "n" }, `-${money(inv.credit.amount)}`))] : []),
        h("tr", {}, h("th", { scope: "row", colspan: "3" }, "Total"), h("td", { class: "n sg-total" }, money(inv.total))))));
}

/** The invoice as the receipt/PDF code expects it, with the signature and who signed when. */
const signedInvoice = (r) => ({ ...r.invoice, signature: r.signature, signedAt: r.signedAt, signerName: r.signer });

async function downloadPdf(btn, inv) {
  btn.disabled = true; const label = btn.textContent; btn.textContent = "Making the PDF…";
  try {
    const file = await makeReceiptFile(inv, { kind: "letter" });
    const url = URL.createObjectURL(file);
    const a = h("a", { href: url, download: file.name });
    document.body.append(a); a.click(); a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 30000);
  } catch (e) { console.error(e); alert("Couldn't make the PDF. Please try again."); }
  btn.disabled = false; btn.textContent = label;
}

function checkmark() {
  const ns = "http://www.w3.org/2000/svg", el = (tag, attrs) => { const n = document.createElementNS(ns, tag); for (const [k, v] of Object.entries(attrs)) n.setAttribute(k, v); return n; };
  const svg = el("svg", { viewBox: "0 0 96 96", class: "sg-check", "aria-hidden": "true" });
  svg.append(el("circle", { class: "sg-disc", cx: "48", cy: "48", r: "44" }), el("circle", { class: "sg-ring", cx: "48", cy: "48", r: "44", transform: "rotate(-90 48 48)" }), el("path", { class: "sg-tick", d: "M30 49.5 42.5 62 67 35.5" }));
  return svg;
}

/** Signed (just now, or opened again later): the thank-you, the signed copy, and the PDF. */
function showSigned(r, { fresh }) {
  const inv = signedInvoice(r);
  const pdf = h("button", { type: "button", class: "btn btn-primary sg-pdf", onclick: () => downloadPdf(pdf, inv) }, "Download PDF copy");
  root.replaceChildren(
    h("section", { class: `sg-card sg-done${fresh ? " is-fresh" : ""}`, role: "status" },
      checkmark(),
      h("h1", {}, fresh ? `Thank you, ${tidy(r.signer)}` : "This invoice is signed"),
      h("p", { class: "sg-signed-by" }, signedByText(inv)),
      h("p", { class: "sg-small" }, fresh ? `${tidy(inv.seller) || "The seller"} has your signed copy. You don't need to send anything back.` : "This link has been used. It only shows the signed copy now."),
      pdf),
    invoiceView(inv),
    h("section", { class: "sg-card" }, h("p", { class: "sg-label" }, "Signature"), h("img", { class: "sg-sig-img", src: r.signature, alt: `Signature of ${tidy(r.signer)}` }), h("p", { class: "sg-small" }, signedByText(inv))));
  if (fresh) navigator.vibrate?.(30);
}

function showToSign(r) {
  const inv = r.invoice;
  const name = h("input", { id: "sg-name", class: "sg-input", type: "text", autocomplete: "name", autocapitalize: "words", maxlength: "80", placeholder: "Your full name", value: "" });
  const canvas = h("canvas", { class: "sg-canvas", "aria-label": "Signature box: sign here with your finger" });
  const clear = h("button", { type: "button", class: "btn btn-ghost sg-clear" }, "Clear");
  const go = h("button", { type: "button", class: "btn btn-primary sg-go", disabled: true }, "Sign and confirm");
  const err = h("p", { class: "sg-err", role: "alert", hidden: true });
  let inked = false;
  const ready = () => { go.disabled = !(inked && name.value.trim().length >= 2); };
  root.replaceChildren(
    h("section", { class: "sg-card sg-intro" },
      h("h1", {}, `${tidy(inv.seller) || "The seller"} sent you this invoice to sign`),
      h("p", { class: "sg-small" }, "Check it, then type your name and sign below. The invoice is locked: only the seller can change it, by sending you a new link.")),
    invoiceView(inv),
    h("section", { class: "sg-card sg-form", "aria-label": "Sign" },
      h("label", { class: "sg-label", for: "sg-name" }, "Your name"), name,
      h("p", { class: "sg-label" }, "Your signature"),
      h("div", { class: "sg-pad" }, canvas, h("span", { class: "sg-pad-hint", "aria-hidden": "true" }, "Sign here")),
      h("div", { class: "sg-row" }, clear),
      err, go,
      h("p", { class: "sg-small" }, "By tapping “Sign and confirm” you confirm this invoice. The date and time are saved with your signature.")));
  const pad = new SignaturePad(canvas, { onChange: () => { inked = true; root.querySelector(".sg-pad").classList.add("is-inked"); ready(); } });
  clear.onclick = () => { pad.clear(); inked = false; root.querySelector(".sg-pad").classList.remove("is-inked"); ready(); };
  name.oninput = ready;
  go.onclick = async () => {
    err.hidden = true; go.disabled = true; go.textContent = "Signing…";
    const res = await post("/api/sign/submit", { token, name: name.value.trim(), signature: pad.toDataURL(), digest: r.digest });
    if (res.ok && res.data.state === "signed") { window.scrollTo(0, 0); return showSigned(res.data, { fresh: !res.data.already }); }
    if (res.data.state && res.data.state !== "changed") return message("This link can't be signed", res.data.error);
    err.textContent = res.data.error || "That didn't work. Please try again."; err.hidden = false;
    go.textContent = "Sign and confirm"; ready();
  };
}

(async () => {
  if (!token) return message("This link isn't complete", "Check you have the whole link, or ask the seller to send it again.");
  const r = await post("/api/sign/view", { token });
  if (r.ok && r.data.state === "open") return showToSign(r.data);
  if (r.ok && r.data.state === "signed") return showSigned(r.data, { fresh: false });
  const titles = { expired: "This link has expired", replaced: "There's a newer link", cancelled: "This link was cancelled", unknown: "Link not found" };
  message(titles[r.data.state] || "Couldn't open the invoice", r.data.error || "Please try again in a moment.");
})();
