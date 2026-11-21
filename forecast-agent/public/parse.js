/**
 * Reading a sales spreadsheet (in the browser; the raw file never leaves the computer — only monthly totals do).
 *
 *   parseCSV(text) → string[][]                (quotes, commas or semicolons or tabs, a BOM)
 *   detectColumns(header, rows) → { date, product, value, kind }   best guesses (column indexes; product may be -1)
 *   dateOrderOf(rows, col) → "dmy" | "mdy" | "ymd" | null(ambiguous)
 *   toMonthly(rows, map) → { months, products, used, skipped, firstDate, lastDate }
 *
 * Understands: 2025-01-31, 31/01/2025, 01/31/2025, 31-01-2025, 31.01.2025, Jan 2025, January 31 2025, 2025-01, Excel
 * serial numbers and real dates from .xlsx; money like $1,234.50, 1.234,50, (120) for −120.
 */
export function parseCSV(text) {
  text = String(text).replace(/^﻿/, "");
  const first = text.split(/\r\n|\r|\n/, 1)[0] || ""; // also old Mac files, whose lines end with a lone "\r"
  const delim = [",", ";", "\t"].map((d) => [d, first.split(d).length]).sort((a, b) => b[1] - a[1])[0][0];
  const rows = [];
  let row = [], field = "", q = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (q) {
      if (c === '"') { if (text[i + 1] === '"') { field += '"'; i++; } else q = false; }
      else field += c;
    } else if (c === '"') q = true;
    else if (c === delim) { row.push(field); field = ""; }
    else if (c === "\n" || c === "\r") { if (c === "\r" && text[i + 1] === "\n") i++; row.push(field); rows.push(row); row = []; field = ""; }
    else field += c;
  }
  if (field !== "" || row.length) { row.push(field); rows.push(row); }
  return rows.filter((r) => r.some((v) => String(v).trim() !== ""));
}

export function parseNumber(v) {
  if (typeof v === "number") return Number.isFinite(v) ? v : null;
  let s = String(v ?? "").trim();
  if (!s) return null;
  let neg = false;
  if (/^\(.*\)$/.test(s)) { neg = true; s = s.slice(1, -1); }
  s = s.replace(/[^\d.,\-]/g, "");
  if (s.startsWith("-")) { neg = !neg; s = s.slice(1); }
  if (!/\d/.test(s)) return null;
  const lastDot = s.lastIndexOf("."), lastComma = s.lastIndexOf(",");
  if (lastDot >= 0 && lastComma >= 0) s = lastComma > lastDot ? s.replace(/\./g, "").replace(",", ".") : s.replace(/,/g, "");
  else if (lastComma >= 0) s = /,\d{1,2}$/.test(s) && (s.match(/,/g) || []).length === 1 ? s.replace(",", ".") : s.replace(/,/g, "");
  const n = Number(s);
  return Number.isFinite(n) ? (neg ? -n : n) : null;
}

const MON = { jan: 1, feb: 2, mar: 3, apr: 4, may: 5, jun: 6, jul: 7, aug: 8, sep: 9, sept: 9, oct: 10, nov: 11, dec: 12 };
const ok = (y, m, d = 1) => y >= 1900 && y <= 2100 && m >= 1 && m <= 12 && d >= 1 && d <= 31;
const ym = (y, m) => `${y}-${String(m).padStart(2, "0")}`;

/** → "YYYY-MM" or null. order matters only for a/b/yyyy dates. */
export function toYearMonth(v, order = "dmy") {
  if (v instanceof Date && !isNaN(v)) return ym(v.getFullYear(), v.getMonth() + 1);
  if (typeof v === "number") {
    if (v > 20000 && v < 80000) { const d = new Date(Date.UTC(1899, 11, 30) + v * 86400000); return ym(d.getUTCFullYear(), d.getUTCMonth() + 1); } // Excel serial
    return null;
  }
  const s = String(v ?? "").trim();
  if (!s) return null;
  let m;
  if ((m = /^(\d{4})[-/.](\d{1,2})(?:[-/.](\d{1,2}))?(?:[ T].*)?$/.exec(s))) return ok(+m[1], +m[2], +(m[3] || 1)) ? ym(+m[1], +m[2]) : null;
  if ((m = /^(\d{1,2})[-/.](\d{1,2})[-/.](\d{2,4})(?:[ T].*)?$/.exec(s))) {
    let y = +m[3]; if (y < 100) y += 2000;
    const [a, b] = [+m[1], +m[2]];
    const [mo, d] = order === "mdy" ? [a, b] : [b, a];
    return ok(y, mo, d) ? ym(y, mo) : null;
  }
  if ((m = /^(\d{1,2})?\s*([A-Za-z]{3,9})\.?,?\s*(\d{1,2})?(?:st|nd|rd|th)?,?\s*(\d{4})$/.exec(s))) {
    const mo = MON[m[2].slice(0, 4).toLowerCase()] || MON[m[2].slice(0, 3).toLowerCase()];
    return mo && ok(+m[4], mo) ? ym(+m[4], mo) : null;
  }
  if (/^\d{5}(\.\d+)?$/.test(s)) return toYearMonth(Number(s));
  const d = new Date(s);
  return isNaN(d) ? null : ym(d.getFullYear(), d.getMonth() + 1);
}

/** For a/b/yyyy dates: dmy if any first part is over 12, mdy if any second part is; null if it can't be told. */
export function dateOrderOf(rows, col) {
  let first = false, second = false, seen = false;
  for (const r of rows) {
    const m = /^(\d{1,2})[-/.](\d{1,2})[-/.]\d{2,4}/.exec(String(r[col] ?? "").trim());
    if (!m) continue;
    seen = true;
    if (+m[1] > 12) first = true;
    if (+m[2] > 12) second = true;
  }
  if (!seen) return "ymd";
  if (first && !second) return "dmy";
  if (second && !first) return "mdy";
  return null;
}

/** Best guesses for the date, product and sales columns (by name first, then by what's in them). */
export function detectColumns(header, rows) {
  const h = header.map((x) => String(x ?? "").trim().toLowerCase());
  const sample = rows.slice(0, 200);
  const share = (col, test) => { let ok = 0, n = 0; for (const r of sample) { if (r[col] === undefined || String(r[col]).trim() === "") continue; n++; if (test(r[col])) ok++; } return n ? ok / n : 0; };
  const byName = (re) => h.findIndex((x) => re.test(x));
  let date = byName(/^(date|day|month|period|order date|invoice date|sale date|transaction date|week)\b|date/);
  if (date < 0 || share(date, (v) => toYearMonth(v, "dmy") || toYearMonth(v, "mdy")) < 0.6) {
    date = h.map((_, i) => i).sort((a, b) => share(b, (v) => toYearMonth(v)) - share(a, (v) => toYearMonth(v)))[0];
  }
  let value = byName(/^(sales|revenue|amount|total|net sales|gross sales|value|sales amount|turnover|income)\b|revenue|sales|amount/);
  let kind = "money";
  if (value < 0 || value === date || share(value, (v) => parseNumber(v) !== null) < 0.6) {
    const q = byName(/^(qty|quantity|units|units sold|volume|cases|count)\b|qty|quantity|units/);
    if (q >= 0 && q !== date) { value = q; kind = "units"; }
    else value = h.map((_, i) => i).filter((i) => i !== date).sort((a, b) => share(b, (v) => parseNumber(v) !== null) - share(a, (v) => parseNumber(v) !== null))[0] ?? -1;
  } else if (/qty|quantity|units|volume|cases/.test(h[value])) kind = "units";
  let product = byName(/^(product|item|sku|product name|item name|description|category|product line|service)\b|product|item|sku/);
  if (product === date || product === value) product = -1;
  if (product < 0) {
    const textCols = h.map((_, i) => i).filter((i) => i !== date && i !== value && share(i, (v) => parseNumber(v) === null && !toYearMonth(v)) > 0.8);
    product = textCols[0] ?? -1;
  }
  return { date, product, value, kind };
}

/** Optional columns for multi-location data: store/warehouse/location, region, and a quantity column next to sales. */
export function detectExtra(header, used = []) {
  const h = header.map((x) => String(x ?? "").trim().toLowerCase());
  const find = (re) => h.findIndex((x, i) => !used.includes(i) && re.test(x));
  const location = find(/^(store|location|branch|shop|warehouse|site|outlet|depot|plant)\b|store|location|warehouse|branch|outlet/);
  const region = find(/^(region|area|territory|state|province|district|zone|market|country)\b|region|territory|province/);
  const units = find(/^(qty|quantity|units|units sold|volume|cases|count)\b|qty|quantity|units/);
  return { location, region, units };
}

/** Adds up sales by month and product. Months with no sales in between count as 0. */
export function toMonthly(rows, { date, product, value, order = "dmy" }) {
  const byProduct = new Map(), monthsSeen = new Set();
  let used = 0, skipped = 0;
  for (const r of rows) {
    const m = toYearMonth(r[date], order);
    const v = parseNumber(r[value]);
    if (!m || v === null) { skipped++; continue; }
    const name = product >= 0 ? String(r[product] ?? "").trim() || "(no name)" : "All sales";
    if (!byProduct.has(name)) byProduct.set(name, new Map());
    const pm = byProduct.get(name);
    pm.set(m, (pm.get(m) || 0) + v);
    monthsSeen.add(m);
    used++;
  }
  if (!monthsSeen.size) return { months: [], products: {}, used, skipped };
  const sorted = [...monthsSeen].sort();
  const months = [];
  for (let cur = sorted[0]; cur <= sorted[sorted.length - 1]; ) {
    months.push(cur);
    const [y, mo] = cur.split("-").map(Number);
    cur = mo === 12 ? `${y + 1}-01` : `${y}-${String(mo + 1).padStart(2, "0")}`;
  }
  const products = {};
  for (const [name, pm] of byProduct) products[name] = months.map((m) => Math.round((pm.get(m) || 0) * 100) / 100);
  return { months, products, used, skipped };
}
