/**
 * Invoice ⇄ QR payload.
 *
 * Link QR (payload v1): `${origin}/v#` + payload. Everything travels after "#", which browsers never send to a
 * server, so the customer's phone shows the invoice from the link alone. Grammar (see SPEC.md):
 *   payload = "1" ~ seller ~ number ~ YYYYMMDD ~ store ~ address ~ items ~ total ~ flags
 *   items   = item *( "*" item ),  item = ( "@" index | text ) "," qty [unit] "," price
 *   unit    = "d" (dozen) | "b" (bag) | "p" (pounds); none = each (so links made before units still read)
 *   flags   = "" | "s" (signed by the customer)
 * Built-in products travel as "@index" into DEFAULT_PRODUCTS (only on an exact name match), which keeps
 * the QR small. Text QR: invoiceToText() — a plain-text invoice for phones with no internet.
 */
import { DEFAULT_PRODUCTS, SELLER, invoiceNo, lineTotal, money, normalizeUnit, parseISODate, prettyDate, qtyWithUnit, sumTotals, withTotals } from "./util.js";

export const PAYLOAD_VERSION = "1";

const MAX_PAYLOAD = 20000;
const MAX_TEXT = 300;
const MAX_ITEMS = 300;

/** encodeURIComponent, then "+" for spaces, and ~ * ! ' ( ) escaped so they can't clash with the separators. */
const enc = (s) => encodeURIComponent(String(s ?? ""))
  .replace(/%20/g, "+")
  .replace(/[~*!'()]/g, (c) => "%" + c.charCodeAt(0).toString(16).toUpperCase());

/** Undoes enc(); throws on a bad escape or an over-long field. */
function dec(s) {
  const v = decodeURIComponent(s.replace(/\+/g, " "));
  if (v.length > MAX_TEXT) throw new Error("field too long");
  return v;
}

/** Shortest decimal form: 12 → "12", 1.5 → "1.5"; missing → "". */
function num(n) {
  if (n === null || n === undefined || n === "") return "";
  const x = Number(n);
  if (!Number.isFinite(x) || x < 0) return "";
  return String(Number(x.toFixed(4)));
}

/** A strictly formatted non-negative decimal, or undefined if malformed. */
const strictNum = (s) => (/^\d{1,12}(\.\d{1,4})?$/.test(s) ? Number(s) : undefined);
const UNIT_CODE = { dozen: "d", bag: "b", lb: "p" };
const CODE_UNIT = { d: "dozen", b: "bag", p: "lb" };

/** The payload part of the link (after "#"). */
export function encodePayload(inv) {
  const t = withTotals(inv);
  const items = t.items.map((it) => {
    const i = DEFAULT_PRODUCTS.indexOf(it.name);
    const unit = it.qty === null ? "" : UNIT_CODE[normalizeUnit(it.unit)] || "";
    return `${i >= 0 ? "@" + i : enc(it.name)},${num(it.qty)}${unit},${num(it.price)}`;
  }).join("*");
  return [
    PAYLOAD_VERSION,
    enc(t.seller || SELLER),
    String(Math.max(0, Math.floor(Number(t.number) || 0))),
    String(t.date || "").replace(/-/g, ""),
    enc(t.store),
    enc(t.address),
    items,
    num(t.total) || "0",
    t.signature ? "s" : "",
  ].join("~");
}

/** Full link for the customer's QR code. */
export function invoiceToUrl(inv, origin = location.origin) {
  return `${origin}/v#${encodePayload(inv)}`;
}

/**
 * Reads "#1~…" (or "1~…") back into a view model, or null if it isn't a valid invoice. Never throws.
 * → { v, seller, number, date, store, address, items: [{ name, qty, price, total }], total, computedTotal, signed }
 */
export function parseInvoiceHash(hash) {
  try {
    let s = String(hash ?? "");
    if (s.startsWith("#")) s = s.slice(1);
    if (!s || s.length > MAX_PAYLOAD) return null;
    const f = s.split("~");
    if (f.length !== 9 || f[0] !== PAYLOAD_VERSION) return null;

    const seller = dec(f[1]) || SELLER;
    if (!/^\d{1,9}$/.test(f[2])) return null;
    const number = Number(f[2]);
    const d = /^(\d{4})(\d{2})(\d{2})$/.exec(f[3]);
    if (!d) return null;
    const date = `${d[1]}-${d[2]}-${d[3]}`;
    if (!parseISODate(date)) return null;
    const store = dec(f[4]);
    const address = dec(f[5]);

    const items = [];
    if (f[6]) {
      const parts = f[6].split("*");
      if (parts.length > MAX_ITEMS) return null;
      for (const part of parts) {
        const q = part.split(",");
        if (q.length !== 3) return null;
        let name;
        if (q[0].startsWith("@")) {
          if (!/^@\d{1,3}$/.test(q[0])) return null;
          name = DEFAULT_PRODUCTS[Number(q[0].slice(1))];
          if (!name) return null;
        } else {
          name = dec(q[0]);
        }
        const qm = /^(\d{1,12}(?:\.\d{1,4})?)([dbp]?)$/.exec(q[1]);
        if (q[1] !== "" && !qm) return null;
        const qty = qm ? Number(qm[1]) : null;
        const unit = qm ? CODE_UNIT[qm[2]] || "each" : "each";
        const price = q[2] === "" ? null : strictNum(q[2]);
        if (price === undefined) return null;
        items.push({ name, qty, unit, price, total: lineTotal(qty, price) });
      }
    }
    const total = strictNum(f[7]);
    if (total === undefined) return null;
    if (f[8] !== "" && f[8] !== "s") return null;
    return { v: 1, seller, number, date, store, address, items, total, computedTotal: sumTotals(items), signed: f[8] === "s" };
  } catch {
    return null;
  }
}

/** Plain-text invoice for the text-only QR (readable by any camera, no internet needed anywhere). */
export function invoiceToText(inv) {
  const t = withTotals(inv);
  const rule = "--------------------";
  const lines = [`INVOICE No. ${invoiceNo(t.number)}`, t.seller || SELLER, `Date: ${prettyDate(t.date)}`];
  if (t.store) lines.push(`Store: ${t.store}`);
  const address = String(t.address || "").split("\n").map((s) => s.trim()).filter(Boolean).join(", ");
  if (address) lines.push(`Address: ${address}`);
  lines.push(rule);
  for (const it of t.items) {
    lines.push(it.name, `  ${qtyWithUnit(it.qty, it.unit)} x ${it.price === null ? "(no price)" : money(it.price)} = ${money(it.total)}`);
  }
  if (!t.items.length) lines.push("(no items)");
  lines.push(rule, `TOTAL: ${money(t.total)}`);
  lines.push(`${t.items.length} item${t.items.length === 1 ? "" : "s"} - Signed by customer: ${t.signature ? "Yes" : "No"}`);
  return lines.join("\n");
}
