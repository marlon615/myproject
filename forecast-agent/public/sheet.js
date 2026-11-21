/**
 * Reading a sales spreadsheet in the browser and turning it into monthly series (product × store × region), with a
 * sales amount and/or quantity per month. Used by the one-time demo page (the main app has its own copy of this flow).
 */
import { parseCSV, detectColumns, detectExtra, dateOrderOf, toYearMonth, parseNumber } from "/parse.js";
export { detectColumns, detectExtra, dateOrderOf };

let xlsxReady = null;
const loadXLSX = () => (xlsxReady ||= new Promise((ok, fail) => {
  const s = document.createElement("script");
  s.src = "/vendor/xlsx.full.min.js";
  s.onload = () => ok(window.XLSX);
  s.onerror = () => fail(new Error("The Excel reader didn't load. Check your connection, or save the file as CSV."));
  document.head.appendChild(s);
}));
export function decodeText(buf) {
  try { return new TextDecoder("utf-8", { fatal: true }).decode(buf); } catch { return new TextDecoder("windows-1252").decode(buf); }
}
export async function readFile(file) {
  if (file.size > 40 * 1024 * 1024) throw new Error("That file is over 40 MB. Save just the columns you need and try again.");
  if (/\.(xlsx|xls)$/i.test(file.name)) {
    const XLSX = await loadXLSX();
    const wb = XLSX.read(await file.arrayBuffer(), { type: "array", cellDates: true });
    const best = wb.SheetNames.map((n) => XLSX.utils.sheet_to_json(wb.Sheets[n], { header: 1, raw: true, defval: "" })).sort((a, b) => b.length - a.length)[0] || [];
    return best.filter((r) => r.some((v) => String(v).trim() !== ""));
  }
  return parseCSV(decodeText(await file.arrayBuffer()));
}
export function headerAndBody(rows) {
  let header = rows[0].map((h, i) => String(h ?? "").trim() || `Column ${i + 1}`), body = rows.slice(1);
  if (rows[0].some((v) => v instanceof Date || /^\d{1,4}[-/.]\d{1,2}[-/.]\d{1,4}/.test(String(v)))) { header = rows[0].map((_, i) => `Column ${i + 1}`); body = rows; }
  const width = Math.max(...rows.slice(0, 50).map((r) => r.length));
  while (header.length < width) header.push(`Column ${header.length + 1}`);
  return { header, body };
}
/** c = { date, product, value, units, location, region } (column numbers, -1 = none); order "dmy"|"mdy"|"ymd". */
export function buildSeries(rows, c, order, valueIsUnits, maxMonths = 120) {
  const groups = new Map(), seen = new Set();
  let used = 0, skipped = 0;
  for (const r of rows) {
    const ym = toYearMonth(r[c.date], order === "ymd" ? "dmy" : order);
    const v = parseNumber(r[c.value]), u = c.units >= 0 ? parseNumber(r[c.units]) : null;
    if (!ym || (v === null && u === null)) { skipped++; continue; }
    const p = c.product >= 0 ? String(r[c.product] ?? "").trim() || "(no name)" : "All sales";
    const l = c.location >= 0 ? String(r[c.location] ?? "").trim() : "", g = c.region >= 0 ? String(r[c.region] ?? "").trim() : "";
    const k = `${p}\u0001${l}\u0001${g}`;
    let e = groups.get(k);
    if (!e) groups.set(k, (e = { product: p, location: l, region: g, amount: new Map(), units: new Map() }));
    if (v !== null) { const m = valueIsUnits ? e.units : e.amount; m.set(ym, (m.get(ym) || 0) + v); }
    if (u !== null && !valueIsUnits) e.units.set(ym, (e.units.get(ym) || 0) + u);
    seen.add(ym); used++;
  }
  if (!seen.size) return { error: "No dates and amounts could be read with these columns. Check the column choices." };
  const sorted = [...seen].sort();
  let months = [];
  for (let cur = sorted[0]; cur <= sorted[sorted.length - 1]; ) { months.push(cur); const [y, mo] = cur.split("-").map(Number); cur = mo === 12 ? `${y + 1}-01` : `${y}-${String(mo + 1).padStart(2, "0")}`; }
  const allMonths = months.length, firstAll = months[0];
  if (months.length > maxMonths) months = months.slice(-maxMonths);
  const hasAmount = [...groups.values()].some((e) => e.amount.size), hasUnits = [...groups.values()].some((e) => e.units.size);
  const r2 = (x) => Math.round(x * 100) / 100, sum = (a) => a.reduce((x, y) => x + y, 0);
  const series = [...groups.values()].map((e) => ({ product: e.product, location: e.location, region: e.region,
    ...(hasAmount ? { amount: months.map((m) => r2(e.amount.get(m) || 0)) } : {}), ...(hasUnits ? { units: months.map((m) => r2(e.units.get(m) || 0)) } : {}) }))
    .filter((s) => sum(s.amount || []) !== 0 || sum(s.units || []) !== 0);
  return { months, series, used, skipped, allMonths: allMonths > maxMonths ? allMonths : 0, firstAll, hasAmount, hasUnits,
    products: new Set(series.map((s) => s.product)).size, locations: new Set(series.map((s) => s.location).filter(Boolean)).size, regions: new Set(series.map((s) => s.region).filter(Boolean)).size };
}
