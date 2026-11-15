/**
 * The forecasting engine and the spreadsheet reader, in Node (no browser):
 *   - reading CSV and Excel (via the same SheetJS file the app ships), messy dates and money, column guessing;
 *   - forecasts on data where the right answer is known (trend, seasons, flat, short, zero, falling);
 *   - the backtest's accuracy score; the plain-English summary's numbers; folding many products into "Other";
 *   - speed: the worst case must fit easily in Cloudflare's free-plan CPU allowance (10 ms per request).
 */
const fs = require("fs"), path = require("path");
(async () => {
  const E = await import("../worker/forecast.js");
  const P = await import("../public/parse.js");
  // Load the vendored SheetJS file exactly as the browser does (a plain script that defines XLSX).
  const sandbox = { console, Date, Uint8Array, ArrayBuffer, Buffer, TextDecoder, TextEncoder };
  sandbox.self = sandbox; sandbox.window = sandbox;
  require("vm").runInNewContext(fs.readFileSync(path.join(__dirname, "..", "public", "vendor", "xlsx.full.min.js"), "utf8"), sandbox);
  const XLSX = sandbox.XLSX;
  let failures = 0;
  const check = (ok, name, extra = "") => { console.log(`${ok ? "PASS" : "FAIL"}  ${name}${extra ? "  — " + extra : ""}`); if (!ok) failures++; };
  const months = (start, n) => Array.from({ length: n }, (_, i) => E.addMonths(start, i));
  const near = (a, b, tol) => Math.abs(a - b) <= tol * Math.abs(b);

  // ── Reading ──────────────────────────────────────────────────────────────────────────────────────────────────
  const csv = 'Date;Item;"Net Sales"\n31/01/2025;"Mango, large";"1.234,50"\n15/02/2025;Rice;(20)\n';
  const rows = P.parseCSV(csv);
  check(rows.length === 3 && rows[1][1] === "Mango, large" && P.parseNumber(rows[1][2]) === 1234.5 && P.parseNumber(rows[2][2]) === -20, "CSV: semicolons, quotes, European decimals, (20) as −20");
  const mac = P.parseCSV("a;b\r1,5;x\r2,5;y\r");
  check(mac.length === 3 && mac[1][0] === "1,5" && mac[2][1] === "y", "CSV with old Mac line endings (a lone \\r) and semicolons");
  check(P.parseNumber("$1,234.50") === 1234.5 && P.parseNumber("1,234") === 1234 && P.parseNumber("12,5") === 12.5 && P.parseNumber("abc") === null, "money in different styles");
  const D = (v, o) => P.toYearMonth(v, o);
  check(D("2025-03-31") === "2025-03" && D("31/03/2025", "dmy") === "2025-03" && D("03/31/2025", "mdy") === "2025-03" && D("31.03.2025") === "2025-03" && D("Mar 2025") === "2025-03"
    && D("March 31, 2025") === "2025-03" && D("2025-03") === "2025-03" && D(45747) === "2025-03" && D(new Date(2025, 2, 31)) === "2025-03" && D("hello") === null, "dates in many styles (incl. an Excel serial number)");
  check(P.dateOrderOf([["31/01/2025"], ["01/02/2025"]], 0) === "dmy" && P.dateOrderOf([["01/31/2025"]], 0) === "mdy" && P.dateOrderOf([["01/02/2025"]], 0) === null, "tells day/month from month/day when it can; says when it can't");
  const det = P.detectColumns(["Order Date", "Region", "Product Name", "Qty", "Revenue"], [["2025-01-03", "North", "Mango", "3", "$750"]]);
  check(det.date === 0 && det.product === 2 && det.value === 4 && det.kind === "money", "guesses the date, product and sales columns from the headings", JSON.stringify(det));
  const det2 = P.detectColumns(["when", "what", "how many"], [["2025-01-03", "Mango", "3"], ["2025-02-03", "Rice", "5"]]);
  check(det2.date === 0 && det2.product === 1 && det2.value === 2, "…and from what's in them when the headings are unclear", JSON.stringify(det2));
  const mo = P.toMonthly([["2025-01-05", "A", "10"], ["2025-01-20", "A", "5"], ["2025-03-01", "B", "7"], ["bad", "A", "1"]], { date: 0, product: 1, value: 2 });
  check(mo.months.join() === "2025-01,2025-02,2025-03" && mo.products.A.join() === "15,0,0" && mo.products.B.join() === "0,0,7" && mo.skipped === 1, "adds up by month; a month with no sales counts as 0; unreadable rows are skipped and counted", JSON.stringify(mo));
  // The sample file, and the same data as a real .xlsx.
  const sample = P.parseCSV(fs.readFileSync(path.join(__dirname, "..", "public", "sample-sales.csv"), "utf8"));
  const sdet = P.detectColumns(sample[0], sample.slice(1));
  const order = P.dateOrderOf(sample.slice(1), sdet.date);
  const smo = P.toMonthly(sample.slice(1), { ...sdet, order });
  check(sdet.value === 3 && sdet.kind === "money" && order === "dmy" && smo.months.length === 36 && Object.keys(smo.products).length === 6 && smo.skipped === 0, "the sample file: 36 months, 6 products, all rows read", `${smo.months[0]}…${smo.months[35]}`);
  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet([["Date", "Product", "Sales"], ...sample.slice(1, 400).map((r) => [new Date(+r[0].slice(6), +r[0].slice(3, 5) - 1, +r[0].slice(0, 2)), r[1], P.parseNumber(r[3])])]), "Sales");
  const buf = XLSX.write(wb, { type: "buffer", bookType: "xlsx" });
  const back = XLSX.utils.sheet_to_json(XLSX.read(buf, { type: "buffer", cellDates: true }).Sheets.Sales, { header: 1, raw: true });
  const xdet = P.detectColumns(back[0], back.slice(1));
  const xmo = P.toMonthly(back.slice(1), { ...xdet, order: "dmy" });
  check(xmo.months[0] === "2023-10" && xmo.used === 399 && Object.keys(xmo.products).length === 6, "an Excel (.xlsx) file reads the same way, with real dates", `${xmo.months.join(",")}`);

  // ── Forecasting on known patterns ────────────────────────────────────────────────────────────────────────────
  const season = [0.8, 0.8, 0.9, 1.0, 1.1, 1.3, 1.4, 1.4, 1.1, 0.9, 0.9, 1.4];
  const truth = (t, base, g, s) => base * Math.pow(1 + g, t) * (s ? s[(t + 9) % 12] : 1); // starts in October
  const m36 = months("2023-10", 39);
  const make = (base, g, s) => m36.map((_, t) => Math.round(truth(t, base, g, s)));
  const full = { months: m36.slice(0, 36), kind: "money", products: { Seasonal: make(1000, 0.01, season).slice(0, 36), Trend: make(500, 0.03).slice(0, 36), Flat: make(300, 0).slice(0, 36) } };
  const fc = E.runForecast(full);
  const S = fc.products.find((p) => p.name === "Seasonal"), T = fc.products.find((p) => p.name === "Trend"), F = fc.products.find((p) => p.name === "Flat");
  const want = (name, base, g, s) => m36.slice(36).map((_, k) => truth(36 + k, base, g, s));
  check(fc.ok && fc.months.join() === "2026-10,2026-11,2026-12", "forecasts the 3 months after the data", fc.months.join());
  check(S.forecast.every((v, i) => near(v, want("S", 1000, 0.01, season)[i], 0.08)) && /seasonal|lastyear/.test(S.method), "a seasonal product: follows its seasons (within 8%) using a seasonal method", `${S.method} ${S.forecast.map(Math.round)} vs ${want("S", 1000, 0.01, season).map(Math.round)}`);
  check(T.forecast.every((v, i) => near(v, want("T", 500, 0.03)[i], 0.08)), "a growing product: keeps growing (within 8%)", `${T.method} ${T.forecast.map(Math.round)} vs ${want("T", 500, 0.03).map(Math.round)}`);
  check(F.forecast.every((v) => near(v, 300, 0.02)), "a flat product stays flat", `${F.method} ${F.forecast}`);
  check(fc.total.forecast.every((v, i) => Math.abs(v - (S.forecast[i] + T.forecast[i] + F.forecast[i])) < 0.02), "the total is exactly the sum of the products");
  const falling = E.forecastSeries([100, 80, 60, 40, 25, 12, 5, 2, 1], 3);
  check(falling.forecast.every((v) => v >= 0), "a falling product never goes below zero", falling.forecast.join());
  check(E.forecastSeries([0, 0, 0, 0, 0, 0, 0], 3).forecast.join() === "0,0,0", "a product with no sales forecasts 0");
  const short = E.runForecast({ months: months("2026-01", 5), kind: "money", products: { A: [1, 2, 3, 4, 5] } });
  check(!short.ok && /at least 6 months/.test(short.reason), "fewer than 6 months: it says forecasting needs more history", short.reason);
  const seven = E.runForecast({ months: months("2026-01", 7), kind: "units", products: { A: [10, 12, 11, 13, 12, 14, 13] } });
  check(seven.ok && seven.summary.some((s) => /7 months of sales history/.test(s)) && /units/.test(seven.summary[0]), "7 months: forecasts, warns that more history helps, and talks in units", seven.summary[0]);

  // ── Backtest ─────────────────────────────────────────────────────────────────────────────────────────────────
  const bt = E.runBacktest(full);
  check(bt.ok && bt.months.join() === "2026-07,2026-08,2026-09" && bt.trainedOn === 33, "the backtest hides the last 3 months and learns from the 33 before", bt.months.join());
  const handAcc = E.accuracy(bt.total.predicted, bt.total.actual);
  check(bt.accuracy === handAcc && bt.accuracy >= 92, "on clean patterned data the backtest is highly accurate", `${bt.accuracy}%`);
  check(E.accuracy([90, 110], [100, 100]) === 90 && E.accuracy([0, 0], [100, 100]) === 0 && E.accuracy([1], [0]) === null && E.accuracy([300], [100]) === 0, "accuracy = 100% − total error ÷ actual (never below 0; none when nothing sold)");
  check(/accurate/.test(bt.summary[0]) && bt.products.every((p) => p.predicted.length === 3 && p.actual.length === 3), "backtest gives predicted vs actual per product per month, and a summary", bt.summary[0]);
  check(!E.runBacktest({ months: months("2026-01", 8), kind: "money", products: { A: [1, 2, 3, 4, 5, 6, 7, 8] } }).ok, "the backtest needs at least 9 months");
  // The sample file end to end.
  const sbt = E.runBacktest({ ...smo, kind: "money" }), sfc = E.runForecast({ ...smo, kind: "money" });
  check(sbt.ok && sbt.accuracy >= 80, "the sample file's backtest", `${sbt.accuracy}% accurate`);
  check(sfc.ok && sfc.months.join() === "2026-10,2026-11,2026-12" && sfc.summary.length >= 5, "the sample file's forecast and summary", sfc.summary.join(" | ").slice(0, 300));
  // The summary's numbers are the real numbers.
  const next = sfc.total.forecast.reduce((a, b) => a + b, 0), last3 = sfc.total.history.slice(-3).reduce((a, b) => a + b, 0);
  const pctWant = Math.abs(Math.round(((next - last3) / last3) * 100));
  check(sfc.summary[0].includes(`${pctWant}%`) && sfc.summary[0].includes(Math.round(next).toLocaleString("en-US").slice(0, 3)), "the summary's total and % change match the forecast", sfc.summary[0]);
  check(sfc.summary.some((s) => /December is usually a strong month/.test(s)), "it spots the sample's December peak", sfc.summary.find((s) => /usually/.test(s)) || "");

  // ── Many products, speed ─────────────────────────────────────────────────────────────────────────────────────
  const many = { months: months("2021-10", 60), kind: "money", products: {} };
  for (let i = 0; i < 45; i++) many.products[`P${i}`] = many.months.map((_, t) => Math.round(truth(t, 100 + i * 10, 0.005, season) * (0.9 + ((t * 7 + i) % 5) / 25)));
  const mf = E.runForecast(many);
  check(mf.products.length === 30 && /Other \(16 products\)/.test(mf.products[29].name), "45 products: the biggest 29 plus 'Other (16 products)'", mf.products[29].name);
  const t0 = performance.now();
  for (let i = 0; i < 20; i++) { E.runForecast(many); E.runBacktest(many); }
  const ms = (performance.now() - t0) / 20;
  check(ms < 8, "worst case (30 products × 60 months, forecast + backtest) is quick", `${ms.toFixed(2)} ms each`);

  console.log(failures ? `\n${failures} check(s) failed` : "\nAll engine checks passed");
  process.exit(failures ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
