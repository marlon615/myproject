/** Shared helpers for the invoice app: products, money, dates, ids, text and DOM. No dependencies. */

export const SELLER = "Marlon Williams";
export const APP_NAME = "Marlon Williams Invoices";

/**
 * The starting product list, in this exact order.
 * The index of each name is also its short code inside invoice QR codes (codec.js, payload v1):
 * never reorder, rename or remove entries here. New built-in products may only be appended,
 * and only together with a new codec payload version.
 */
export const DEFAULT_PRODUCTS = Object.freeze([
  "Beetroot Juice",
  "Cucumber Juice",
  "Pumpkin Punch",
  "Green Juice",
  "Mini Bammy",
  "Large Bammy",
  "Juicify Drink Grape",
  "Juicify Drink Fruit Punch",
  "Hot Pepper",
  "Shredded Callaloo",
  "Lemons",
  "Limes",
  "Grapefruit",
  "Okra",
]);

/** Stable id for built-in product i (0-based): p01 … p14. */
export const defaultProductId = (i) => `p${String(i + 1).padStart(2, "0")}`;

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

// ── Invoices ─────────────────────────────────────────────────────────────

/** 7 → "0007" */
export const invoiceNo = (n) => (n ? String(n).padStart(4, "0") : "—");

/**
 * Returns a copy of an invoice with each item's `total` and the invoice `total` recomputed.
 * Items keep their order. Use this before saving, printing, sharing or encoding.
 */
export function withTotals(inv) {
  const items = (inv.items || []).map((it) => ({
    productId: it.productId ?? null,
    name: String(it.name ?? ""),
    qty: parseAmount(it.qty),
    price: parseAmount(it.price),
    total: lineTotal(it.qty, it.price),
  }));
  return { ...inv, items, total: sumTotals(items) };
}

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

/** Safe file-name fragment: "Rose Hall Grocery" → "Rose-Hall-Grocery". */
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
