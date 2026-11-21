/** Shared helpers for the invoice app: business, products, money, dates, ids, text and DOM. No dependencies. */

/** The product. Every business that uses it sets up its own name, address, phone and products — on its own phone. */
export const APP_NAME = "Marlon";

/**
 * The business using this phone, from its setup (settings "business"). Filled in at startup and whenever it's
 * edited; invoices keep their own copy (seller, sellerAddress, sellerPhone) from when they were written.
 */
export const business = { name: "", address: "", phone: "" };
export function setBusiness(b) {
  business.name = tidy(b?.name || "").replace(/\n/g, " ");
  business.address = tidy(b?.address || "");
  business.phone = tidy(b?.phone || "").replace(/\n/g, " ");
  return business;
}

/** No built-in products: each business adds its own (with an optional price and unit). */
export const DEFAULT_PRODUCTS = Object.freeze([]);

/** Random id with an optional prefix, e.g. uid("inv_"). */
export function uid(prefix = "") {
  const bytes = crypto.getRandomValues(new Uint8Array(10));
  return prefix + Array.from(bytes, (b) => (b % 36).toString(36)).join("");
}

// ── Money ────────────────────────────────────────────────────────────────

/** Whole cents for a number, rounding half away from zero without float drift (1.005 → 101). */
export function toCents(n) {
  const x = Number(n);
  if (!Number.isFinite(x)) return 0;
  return Math.round(Number((x * 100).toFixed(4)));
}

/** Rounds to 2 decimals the same way toCents does. */
export const round2 = (n) => toCents(n) / 100;

/**
 * Reads a typed amount: "1,250.50", "$350", " 12 " → number. Empty or invalid → null.
 * Negative amounts are not allowed (null).
 */
export function parseAmount(v) {
  if (v === null || v === undefined) return null;
  if (typeof v === "number") return Number.isFinite(v) && v >= 0 ? v : null;
  const s = String(v).replace(/[$,\s]/g, "").replace(/^J(?=\d)/i, "");
  if (!s || !/^\d*\.?\d*$/.test(s) || s === ".") return null;
  const n = Number(s);
  return Number.isFinite(n) && n >= 0 ? n : null;
}

/** Line total for a quantity and unit price; 0 when either is missing. */
export function lineTotal(qty, price) {
  const q = parseAmount(qty), p = parseAmount(price);
  if (q === null || p === null) return 0;
  return toCents(q * p) / 100;
}

/** Sum of line totals, added in whole cents. */
export function sumTotals(items) {
  return items.reduce((c, it) => c + toCents(lineTotal(it.qty, it.price)), 0) / 100;
}

const NUM2 = new Intl.NumberFormat("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 });

/** 1250.5 → "1,250.50" */
export const plainMoney = (n) => NUM2.format(round2(Number(n) || 0));
/** 1250.5 → "$1,250.50" */
export const money = (n) => "$" + plainMoney(n);

/** Quantity for display: 12 → "12", 1.5 → "1.5", 0.125 → "0.125". */
export function qtyText(n) {
  const q = parseAmount(n);
  if (q === null) return "";
  return String(Number(q.toFixed(3)));
}

/** A price for an input box: 350 → "350", 12.5 → "12.50". */
export function priceInputText(n) {
  const p = parseAmount(n);
  if (p === null) return "";
  return Number.isInteger(p) ? String(p) : p.toFixed(2);
}

// ── Units ────────────────────────────────────────────────────────────────

/** How a line is counted: by the piece (default), by the dozen, by the bag, or by weight in pounds. */
export const UNITS = Object.freeze(["each", "dozen", "bag", "lb"]);
export const UNIT_NAMES = Object.freeze({ each: "each", dozen: "dozen", bag: "bag", lb: "lb" });
export const normalizeUnit = (u) => (UNITS.includes(u) ? u : "each");

/** How a product is usually sold, as set up by the business (each, dozen, bag or lb). */
export const defaultUnitFor = (product) => normalizeUnit(product?.unit);

/**
 * The unit of an amount said with no unit: the product's own (pounds, bags), except for a product sold by the
 * dozen, where a bare count is that many items ("30 eggs" is 30 eggs, not 30 dozen; "2 dozen eggs" says so).
 */
export const spokenUnitFor = (product) => { const u = defaultUnitFor(product); return u === "dozen" ? "each" : u; };

/**
 * When no price was said, fills a line's price from the product's usual price (typed at setup or in Settings):
 * the same unit gets that price; items of a product sold by the dozen become whole dozens when they divide evenly,
 * otherwise get the price per item (to the cent). Changes `line` in place; true if it filled a price.
 */
export function fillUsualPrice(line, product) {
  if (!product || product.price === null || product.price === undefined) return false;
  if (line.price !== null && line.price !== undefined) return false;
  const unit = defaultUnitFor(product), lineUnit = normalizeUnit(line.unit);
  if (unit === "dozen" && lineUnit === "each") {
    if (line.qty === null || line.qty === undefined || line.qty % 12 === 0) {
      if (line.qty) line.qty = line.qty / 12;
      line.unit = "dozen";
      line.saidAs = "";
      line.price = product.price;
    } else {
      line.price = Math.round(Math.round(product.price * 100) / 12) / 100;
    }
  } else if (lineUnit === unit) {
    line.price = product.price;
  } else {
    return false; // priced per something else: left for the owner to price
  }
  line.priceFrom = "list";
  return true;
}

/** Quantity with its unit for receipts: "12" (each), "2 dozen", "1 bag", "3 bags", "50 lb". */
export function qtyWithUnit(qty, unit) {
  const q = qtyText(qty) || "0";
  switch (normalizeUnit(unit)) {
    case "dozen": return `${q} dozen`;
    case "bag": return `${q} ${parseAmount(qty) === 1 ? "bag" : "bags"}`;
    case "lb": return `${q} lb`;
    default: return q;
  }
}

// ── Invoices ─────────────────────────────────────────────────────────────

/** 7 → "0007" */
export const invoiceNo = (n) => (n ? String(n).padStart(4, "0") : "—");

/** "Nov 18, 2026, 2:26 PM" in this phone's own time. */
export const signedOnText = (iso) => { const d = new Date(iso); return Number.isNaN(d.getTime()) ? "" : d.toLocaleString("en-US", { month: "short", day: "numeric", year: "numeric", hour: "numeric", minute: "2-digit" }); };
/** "Signed by Jada Brown on Nov 18, 2026, 2:26 PM" for an invoice signed through a link (else ""). */
export const signedByText = (inv) => (inv?.signerName && inv?.signedAt ? `Signed by ${String(inv.signerName).trim()} on ${signedOnText(inv.signedAt)}` : "");

/**
 * Returns a copy of an invoice with each item's `total` and the invoice `total` recomputed.
 * Items keep their order. Use this before saving, printing, sharing or encoding.
 */
export function withTotals(inv) {
  // (seller, sellerAddress, sellerPhone travel with the invoice untouched)
  const items = (inv.items || []).map((it) => ({
    productId: it.productId ?? null,
    name: String(it.name ?? ""),
    qty: parseAmount(it.qty),
    unit: normalizeUnit(it.unit),
    price: parseAmount(it.price),
    total: lineTotal(it.qty, it.price),
  }));
  const subtotal = sumTotals(items);
  // Marlon Pro: a credit from credit notes (returned goods) comes off the items' subtotal, never below zero.
  const credit = cleanCreditOn(inv.credit, subtotal);
  if (!credit) { const out = { ...inv, items, total: subtotal }; delete out.credit; delete out.subtotal; return out; }
  return { ...inv, items, subtotal, credit, total: (toCents(subtotal) - toCents(credit.amount)) / 100 };
}

/** { amount, notes: [{ id, number, amount }] } capped at the subtotal, or null when there's no credit. */
export function cleanCreditOn(raw, subtotal) {
  if (!raw || typeof raw !== "object") return null;
  const notes = (Array.isArray(raw.notes) ? raw.notes : []).map((n) => ({ id: String(n?.id ?? ""), number: Number(n?.number) || null, amount: Math.max(0, toCents(n?.amount) / 100) }))
    .filter((n) => n.amount > 0);
  const cents = Math.min(notes.reduce((t, n) => t + toCents(n.amount), 0), toCents(subtotal));
  return cents > 0 ? { amount: cents / 100, notes } : null;
}

/**
 * The one rule for how credit comes off an invoice: credit notes in the order given (oldest first), each up to what's
 * left on it, never more than the subtotal. available: [{ id, number, left }] → { amount, notes } | null.
 */
export function allocateCredit(available, subtotal) {
  let need = toCents(subtotal);
  const notes = [];
  for (const c of available || []) {
    if (need <= 0) break;
    const take = Math.min(toCents(c.left), need);
    if (take <= 0) continue;
    notes.push({ id: c.id, number: c.number, amount: take / 100 });
    need -= take;
  }
  return notes.length ? { amount: notes.reduce((t, n) => t + toCents(n.amount), 0) / 100, notes } : null;
}

/** "CN-0007" — a credit note's number. */
export const creditNo = (n) => `CN-${String(Math.max(0, Math.floor(Number(n) || 0))).padStart(4, "0")}`;
/** "ORD-0001" — a Marlon Pro shelf order's number. */
export const orderNo = (n) => `ORD-${String(Math.max(0, Math.floor(Number(n) || 0))).padStart(4, "0")}`;
/** "Credit note CN-0003" or "Credit notes CN-0003, CN-0004" — the line shown above the total. */
export const creditLabel = (credit) => {
  const nums = (credit?.notes || []).map((n) => creditNo(n.number)).filter((x) => x !== "CN-0000");
  return nums.length > 1 ? `Credit notes ${nums.join(", ")}` : `Credit note${nums.length ? ` ${nums[0]}` : ""}`;
};

/** Items that are ticked but have no unit price yet. */
export const itemsMissingPrice = (inv) => (inv.items || []).filter((it) => parseAmount(it.price) === null);

// ── Dates (always local calendar dates, stored as "YYYY-MM-DD") ─────────

/** Today's local date as "YYYY-MM-DD". */
export function todayISO(d = new Date()) {
  const z = new Date(d.getTime() - d.getTimezoneOffset() * 60000);
  return z.toISOString().slice(0, 10);
}

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
const MONTHS_LONG = ["January", "February", "March", "April", "May", "June", "July", "August", "September", "October", "November", "December"];

/** "2026-11-10" → { y: 2026, m: 11, d: 10 } or null. */
export function parseISODate(iso) {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(iso || ""));
  if (!m) return null;
  const y = +m[1], mo = +m[2], d = +m[3];
  if (mo < 1 || mo > 12 || d < 1 || d > 31) return null;
  return { y, m: mo, d };
}

/** "2026-11-10" → "10 Nov 2026" (unambiguous on receipts). */
export function prettyDate(iso) {
  const p = parseISODate(iso);
  return p ? `${p.d} ${MONTHS[p.m - 1]} ${p.y}` : String(iso || "");
}

/** "2026-11" → "November 2026" */
export function monthLabel(ym) {
  const [y, m] = String(ym).split("-").map(Number);
  return m ? `${MONTHS_LONG[m - 1]} ${y}` : String(ym);
}

/** Monday-start week key for a "YYYY-MM-DD" date: the ISO date of that week's Monday. */
export function weekStartISO(iso) {
  const p = parseISODate(iso);
  if (!p) return "";
  const dt = new Date(Date.UTC(p.y, p.m - 1, p.d));
  const dow = (dt.getUTCDay() + 6) % 7; // Monday = 0
  dt.setUTCDate(dt.getUTCDate() - dow);
  return dt.toISOString().slice(0, 10);
}

// ── Text ─────────────────────────────────────────────────────────────────

/** Folds text to printable ASCII for thermal printers: "Café – “Best”" → "Cafe - \"Best\"". */
export function asciiFold(s) {
  return String(s ?? "")
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .replace(/[‘’ʼ]/g, "'")
    .replace(/[“”]/g, '"')
    .replace(/[–—]/g, "-")
    .replace(/…/g, "...")
    .replace(/ /g, " ")
    .replace(/[^\x20-\x7e\n]/g, "?");
}

/** Collapses runs of spaces and trims; keeps single newlines (for addresses). */
export const tidy = (s) => String(s ?? "").replace(/[ \t]+/g, " ").replace(/\s*\n\s*/g, "\n").trim();

/** Case- and space-insensitive key for matching store names. */
export const storeKey = (s) => tidy(s).toLowerCase();

/** The last line of every customer copy: "Thank you, Bay Market" (or "Thank you!" with no store name). */
export function thankYouText(store) {
  const name = tidy(store).replace(/\n/g, " ");
  return name ? `Thank you, ${name}` : "Thank you!";
}

/** Safe file-name fragment: "Hill Top Grocery" → "Hill-Top-Grocery". */
export const fileSafe = (s) => asciiFold(s).replace(/[^A-Za-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 40) || "invoice";

// ── DOM ──────────────────────────────────────────────────────────────────

/**
 * Builds an element safely (text is never parsed as HTML).
 * h("button", { class: "btn", onclick: fn, "aria-label": "Add" }, "Add", h("span", {}, "!"))
 * Props starting with "on" become listeners; `class`, `style` (string), `dataset` (object) and
 * aria-/data- attributes are supported; true/false toggle boolean attributes.
 */
export function h(tag, props = {}, ...children) {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(props || {})) {
    if (v === null || v === undefined || v === false) continue;
    if (k.startsWith("on") && typeof v === "function") el.addEventListener(k.slice(2).toLowerCase(), v);
    else if (k === "class") el.className = v;
    else if (k === "dataset") Object.assign(el.dataset, v);
    else if (k === "style" && typeof v === "string") el.setAttribute("style", v);
    else if (k in el && !k.includes("-") && typeof v !== "boolean") el[k] = v;
    else el.setAttribute(k, v === true ? "" : String(v));
  }
  for (const c of children.flat(Infinity)) {
    if (c === null || c === undefined || c === false) continue;
    el.append(c instanceof Node ? c : document.createTextNode(String(c)));
  }
  return el;
}

/** Runs fn at most once per `ms` of quiet. The returned function has .flush() and .cancel(). */
export function debounce(fn, ms) {
  let t = null, lastArgs = null;
  const run = () => { t = null; const a = lastArgs; lastArgs = null; fn(...a); };
  const d = (...args) => { lastArgs = args; clearTimeout(t); t = setTimeout(run, ms); };
  d.flush = () => { if (t) { clearTimeout(t); run(); } };
  d.cancel = () => { clearTimeout(t); t = null; lastArgs = null; };
  return d;
}

/** Loads an image from a data: or blob: URL. */
export function loadImage(src) {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.onload = () => resolve(img);
    img.onerror = () => reject(new Error("Could not load image"));
    img.src = src;
  });
}
