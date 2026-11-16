/**
 * The open demo (/demo) and a load test, with the real Worker (wrangler dev) and a real browser at phone size.
 *   - starts empty, no sample data anywhere; no sign-up
 *   - a company with 24 months uploads the first 21, keeps the last 3: the forecast covers exactly those 3 months,
 *     for every product and the total, with chart, by-product table and CSV; we compare with the kept months
 *   - private: nothing is stored on the server (checked in storage), another visitor sees an empty page,
 *     "Start over" clears it; the owner sees the visit (device, file size) but no data; request access works
 *   - limits: batch size, consecutive months, a rate limit for abuse of the open link
 *   - LOAD TEST: 5,000 products × 21 months through the real page; timing, requests, CPU per batch (free plan: 10 ms)
 */
const { spawnSync } = require("child_process");
const fs = require("fs"), os = require("os"), path = require("path"), http = require("http");
const { chromium } = require("playwright");
const { checker, startWorker, api, until, sleep, APP } = require("./helpers.cjs");

const PORT = 8895, MAIL = 8896, OUT = path.join(__dirname, "output");
const { check, failures } = checker();
const mails = [];
const mailer = http.createServer((rq, rs) => { let b = ""; rq.on("data", (d) => (b += d)); rq.on("end", () => { try { mails.push(JSON.parse(b)); } catch { /* ignore */ } rs.writeHead(200, { "content-type": "application/json" }); rs.end('{"id":"x"}'); }); });
const ym = (start, i) => { const d = new Date(Date.UTC(+start.slice(0, 4), +start.slice(5) - 1 + i, 1)); return d.toISOString().slice(0, 7); };

/** A company's 24 months of daily sales for a few products (seasonal, growing). */
function companyFile() {
  let seed = 7; const rnd = () => { seed = (seed * 1103515245 + 12345) % 2147483648; return seed / 2147483648; };
  const prods = [["Blueberry Yogurt", 3.2, 900, [0.9, 0.9, 1, 1, 1.1, 1.2, 1.2, 1.15, 1, 0.95, 0.9, 0.95]], ["Sourdough Loaf", 5.5, 600, [1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1.05, 1.2]], ["Cold Brew 4-pack", 11, 300, [0.7, 0.75, 0.85, 1, 1.15, 1.35, 1.45, 1.4, 1.1, 0.9, 0.75, 0.7]],
    ["Pumpkin Soup", 4.75, 250, [1.3, 1.2, 1, 0.8, 0.6, 0.5, 0.5, 0.6, 0.9, 1.3, 1.5, 1.6]], ["Granola 500g", 6, 400, [1.05, 1, 1, 1, 0.95, 0.95, 0.95, 1.1, 1.15, 1, 1, 1]], ["Sparkling Lemonade", 2.5, 1100, [0.8, 0.8, 0.9, 1, 1.15, 1.3, 1.4, 1.35, 1.1, 0.9, 0.8, 0.85]],
    ["Olive Oil 1L", 12, 150, [1, 1, 1, 1, 1, 1, 1, 1, 1, 1.05, 1.1, 1.2]], ["Dark Chocolate", 3.5, 500, [0.95, 1.4, 0.9, 1, 0.85, 0.8, 0.75, 0.8, 0.9, 1.1, 1.2, 1.5]]];
  const months = Array.from({ length: 24 }, (_, i) => ym("2024-10", i)); // Oct 2024 .. Sep 2026
  const rows = ["Date,Item,Revenue"], kept = {};
  months.forEach((m, t) => prods.forEach(([p, price, base, season]) => {
    const units = Math.round(base * Math.pow(1.01, t) * season[+m.slice(5) - 1] * (0.95 + rnd() * 0.1));
    for (const day of ["05", "15", "25"]) {
      const amt = Math.round((units / 3) * price * 100) / 100;
      if (t < 21) rows.push(`${m}-${day},${p},${amt}`); else kept[p] = kept[p] || {}, kept[p][m] = (kept[p][m] || 0) + amt;
    }
  }));
  return { csv: rows.join("\n") + "\n", kept, keptMonths: months.slice(21) };
}

(async () => {
  fs.mkdirSync(OUT, { recursive: true });
  check(spawnSync(process.execPath, [path.join(APP, "scripts", "build-worker.cjs")], { cwd: APP }).status === 0, "the app packs into the Worker");
  await new Promise((ok) => mailer.listen(MAIL, ok));
  const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), "draxly-open-"));
  const w = startWorker(PORT, stateDir, { EMAIL_URL: `http://localhost:${MAIL}/emails` });
  const req = api(w.base);
  const browser = await chromium.launch();
  const errors = [];
  const report = {};
  try {
    await w.ready;
    const owner = (await req("/api/owner/claim", { method: "POST", body: { passcode: "owner-pass-123" } })).data.token;
    await req("/api/owner/platform", { method: "POST", token: owner, body: { emailKey: "re_key", emailFrom: "Draxly <demo@draxly.test>" } });

    // ── No sample data, starts empty ───────────────────────────────────────────────────────────────────────
    const html = await (await fetch(`${w.base}/demo`)).text(), js = await (await fetch(`${w.base}/demo.js`)).text(), sheetJs = await (await fetch(`${w.base}/sheet.js`)).text();
    const sampleNames = ["Mango Juice", "Coconut Water", "Harbor & Vine", "Cold Brew Coffee", "Sparkling Water 12-pack", "sample-sales.csv", "/api/demo/session"];
    check(/<title>Draxly demo<\/title>/.test(html) && sampleNames.every((n) => !html.includes(n) && !js.includes(n) && !sheetJs.includes(n)), "the demo page and its code contain no sample data (and no sign-up)");
    const gone = await req("/api/demo/session", { method: "POST", body: {} });
    check(gone.status !== 200 && !gone.data.token, "the old sample-data demo is gone (no demo session is handed out)", String(gone.status));

    // ── A company tries it: 21 months up, last 3 kept back ─────────────────────────────────────────────────
    const co = companyFile();
    const coFile = path.join(stateDir, "my-sales-21-months.csv");
    fs.writeFileSync(coFile, co.csv);
    const ctx = await browser.newContext({ viewport: { width: 390, height: 844 }, deviceScaleFactor: 2, isMobile: true, hasTouch: true, acceptDownloads: true });
    const P = await ctx.newPage();
    P.on("pageerror", (e) => errors.push(e.message));
    await P.goto(`${w.base}/demo?utm_source=email`);
    check(await P.isVisible("#d-start") && !(await P.isVisible("#d-result")) && (await P.locator("table tr").count()) === 0 && (await P.locator("svg[role=img]").count()) === 0, "the page starts empty: instructions and an upload button, no data, no charts");
    check(/Keep your last 3 months back/.test(await P.textContent(".steps")) && /never stored/.test(await P.textContent("#d-start")), "the steps say to keep the last 3 months back, and that nothing is stored");
    await P.screenshot({ path: path.join(OUT, "open-1-empty-phone.png"), fullPage: true });
    await P.setInputFiles("#d-file", coFile);
    await P.waitForSelector("#d-map:not([hidden])");
    const pv = (await P.textContent("#d-preview")).replace(/\s+/g, " ");
    check(/21 months: Oct 2024 to Jun 2026/.test(pv) && /8 products/.test(pv) && /forecast Jul 2026 to Sep 2026/.test(pv) && !/designed for 21/.test(pv), "it finds 21 months and 8 products, and says it will forecast Jul–Sep 2026 — the 3 months they kept", pv.slice(0, 160));
    await P.click("#d-run");
    await P.waitForSelector("#d-result:not([hidden])", { timeout: 60000 });
    check(/Jul 2026 to Sep 2026/.test(await P.textContent("#d-r-title")) && (await P.locator("#d-table tbody tr").count()) === 9 && await P.isVisible("#d-chart svg[role=img]") && (await P.locator("#d-summary li").count()) >= 3,
      "results: the next 3 months for every product and the total, with a chart, the by-product table and a plain-English summary");
    await P.selectOption("#d-pick", { label: "Pumpkin Soup" });
    check(/Pumpkin Soup/.test(await P.textContent("#d-chart .legend")), "the chart can show any one product");
    const [dl] = await Promise.all([P.waitForEvent("download"), P.click("#d-csv")]);
    const csv = fs.readFileSync(await dl.path(), "utf8").trim().split("\n");
    check(/^draxly-forecast-2026-07-to-2026-09\.csv$/.test(dl.suggestedFilename()) && csv.length === 10 && /"Forecast Jul 2026".*"Your actual Jul 2026"/.test(csv[0]), "the CSV has every product plus the total, with empty 'Your actual' columns to fill in", csv[0]);
    // How close was it to the months they kept?
    const fc = Object.fromEntries(csv.slice(1, -1).map((l) => { const c = l.split(","); return [c[0].replace(/"/g, ""), c.slice(1, 4).map(Number)]; }));
    let err = 0, act = 0;
    for (const [p, byM] of Object.entries(co.kept)) co.keptMonths.forEach((m, i) => { err += Math.abs(fc[p][i] - byM[m]); act += byM[m]; });
    const acc = Math.round((1 - err / act) * 1000) / 10;
    report.companyAccuracy = acc;
    check(acc > 85, "compared with the 3 months they kept back, the forecast was close", `${acc}% accurate across all products and months`);
    await P.screenshot({ path: path.join(OUT, "open-2-result-phone.png"), fullPage: true });

    // ── Private: nothing stored, others can't see it ───────────────────────────────────────────────────────
    const files = []; const walk = (d) => { for (const e of fs.readdirSync(d, { withFileTypes: true })) { const p2 = path.join(d, e.name); e.isDirectory() ? walk(p2) : files.push(p2); } }; walk(stateDir);
    const stored = Buffer.concat(files.filter((f) => !f.endsWith(".csv")).map((f) => fs.readFileSync(f)));
    check(!["Blueberry Yogurt", "Sourdough Loaf", "Pumpkin Soup", "Dark Chocolate"].some((n) => stored.includes(Buffer.from(n))), "nothing they uploaded is stored on the server (product names aren't in any stored file)");
    const P2 = await (await browser.newContext({ viewport: { width: 390, height: 844 } })).newPage();
    await P2.goto(`${w.base}/demo`);
    check(await P2.isVisible("#d-start") && !(await P2.isVisible("#d-result")) && !/Pumpkin|Yogurt/.test(await P2.content()), "another visitor opening the link sees an empty page — not the first visitor's data");
    const od = (await req("/api/owner/demo", { token: owner })).data;
    const v = od.visits[0];
    check(v && /forecast: 8 products, 21 months/.test(v.source) && /source=email/.test(v.source) && /iPhone|Android|Linux|Mac|Other/.test(v.device) && !JSON.stringify(od).match(/Pumpkin|Yogurt|Sourdough/), "your dashboard shows the visit (device, where from, file size) — never their data", `${v?.device} · ${v?.source}`);
    await P.fill("#d-name", "Lee Park"); await P.fill("#d-email", "lee@parkfoods.test"); await P.fill("#d-company", "Park Foods");
    await P.click("#d-send");
    await P.waitForSelector("#d-form-ok:not([hidden])");
    check((await req("/api/owner/demo", { token: owner })).data.leads.some((l) => l.email === "lee@parkfoods.test" && Number(l.visit) === v.id) && mails.some((m) => m.to[0] === "draxlyforecast@gmail.com" && /Lee Park/.test(m.subject)), "'Request access' on the results page reaches you (email to draxlyforecast@gmail.com, linked to the visit)");
    P.once("dialog", (d) => d.accept());
    await P.click("#d-restart");
    check(await P.isVisible("#d-start") && !(await P.isVisible("#d-result")) && (await P.locator("#d-table tr").count()) === 0, "'Start over' clears everything from the page");

    // ── Limits ─────────────────────────────────────────────────────────────────────────────────────────────
    const m21 = Array.from({ length: 21 }, (_, i) => ym("2024-10", i));
    check((await req("/api/demo/forecast", { method: "POST", body: { months: m21, series: Array.from({ length: 51 }, (_, i) => ({ product: `P${i}`, values: Array(21).fill(1) })) } })).status === 400, "more than 50 products in one request is refused");
    check((await req("/api/demo/forecast", { method: "POST", body: { months: [...m21.slice(0, 10), ...m21.slice(11)], series: [{ product: "x", values: Array(20).fill(1) }] } })).status === 400, "months with a gap are refused");
    check((await req("/api/demo/forecast", { method: "POST", body: { months: m21, series: [{ product: "x", values: Array(21).fill("1") }] } })).status === 400, "non-numbers are refused");

    // ── LOAD TEST: 5,000 products × 21 months through the real page ────────────────────────────────────────
    const lines = ["Month,Product,Sales"];
    for (let p = 0; p < 5000; p++) { const base = 50 + (p % 97) * 13; for (let t = 0; t < 21; t++) lines.push(`${m21[t]},Product ${String(p).padStart(4, "0")},${Math.round(base * (1 + 0.01 * t) * (1 + 0.2 * Math.sin((t + p) / 1.9)) * 100) / 100}`); }
    const bigFile = path.join(stateDir, "load-5000-products.csv");
    fs.writeFileSync(bigFile, lines.join("\n") + "\n");
    report.fileRows = lines.length - 1; report.fileMB = Math.round(fs.statSync(bigFile).size / 1e5) / 10;
    const L = await (await browser.newContext({ viewport: { width: 1280, height: 900 }, acceptDownloads: true })).newPage();
    L.on("pageerror", (e) => errors.push("load: " + e.message));
    const calls = []; const started = new Map();
    L.on("request", (r) => { if (r.url().includes("/api/demo/")) started.set(r, Date.now()); });
    L.on("requestfinished", async (r) => { if (r.url().includes("/api/demo/forecast")) calls.push({ ms: Date.now() - started.get(r), status: (await r.response())?.status() }); });
    await L.goto(`${w.base}/demo`);
    const tRead = Date.now();
    await L.setInputFiles("#d-file", bigFile);
    await L.waitForSelector("#d-map:not([hidden])", { timeout: 120000 });
    await L.waitForFunction(() => !document.querySelector("#d-run").disabled, null, { timeout: 120000 });
    report.readSeconds = (Date.now() - tRead) / 1000;
    const tRun = Date.now();
    await L.click("#d-run");
    await L.waitForSelector("#d-result:not([hidden])", { timeout: 600000 });
    report.forecastSeconds = (Date.now() - tRun) / 1000;
    report.requests = calls.length; report.failed = calls.filter((c) => c.status !== 200).length;
    const sorted = calls.map((c) => c.ms).sort((a, b) => a - b);
    report.batchMsMedian = sorted[Math.floor(sorted.length / 2)]; report.batchMsMax = sorted[sorted.length - 1];
    const [bdl] = await Promise.all([L.waitForEvent("download"), L.click("#d-csv")]);
    report.csvLines = fs.readFileSync(await bdl.path(), "utf8").trim().split("\n").length;
    check(report.requests === 100 && report.failed === 0 && report.csvLines === 5002 && /5,000 products forecast/.test(await L.textContent("#d-r-lead")) && !/0\.0 seconds/.test(await L.textContent("#d-r-lead")),
      "LOAD TEST: 5,000 products × 21 months finishes — 100 forecast requests, none failed, CSV has all 5,000 products + total", `read ${report.readSeconds}s, forecast ${report.forecastSeconds}s`);
    await L.screenshot({ path: path.join(OUT, "open-3-load-5000.png") });
    // CPU per request: the same work one request does (50 products × 21 months), measured on this machine.
    const E = await import("../worker/forecast.js");
    const series50 = Array.from({ length: 50 }, (_, p) => m21.map((_, t) => (50 + (p % 97) * 13) * (1 + 0.01 * t) * (1 + 0.2 * Math.sin((t + p) / 1.9))));
    for (let i = 0; i < 20; i++) series50.forEach((y) => E.forecastSeries(y));
    const c0 = process.cpuUsage(); const REPS = 200;
    for (let i = 0; i < REPS; i++) { const body = JSON.parse(JSON.stringify({ months: m21, series: series50.map((v, k) => ({ product: `P${k}`, values: v })) })); body.series.forEach((x) => E.forecastSeries(x.values)); }
    const c = process.cpuUsage(c0);
    report.cpuMsPerRequest = Math.round(((c.user + c.system) / REPS / 1000) * 100) / 100;
    check(report.cpuMsPerRequest < 10, "each forecast request needs well under the free plan's 10 ms of CPU", `${report.cpuMsPerRequest} ms per 50-product request (measured here, Node 22)`);
    fs.writeFileSync(path.join(OUT, "loadtest.json"), JSON.stringify(report, null, 2));
    console.log("LOAD TEST REPORT", JSON.stringify(report));
    check(errors.length === 0, "no page errors", errors.join(" | "));
    // Rate limit (last, so it doesn't affect the rest): this visitor already used ~110 calls of the 1,500 per 10 minutes.
    let last; for (let i = 0; i < 1500 && (!last || last.status !== 429); i++) last = await req("/api/demo/forecast", { method: "POST", body: { months: m21, series: [{ product: "x", values: Array(21).fill(1) }] } });
    check(last.status === 429, "an open link can't be hammered: too many forecast calls from one place in 10 minutes are slowed down");
  } finally {
    await browser.close();
    await w.stop();
    mailer.close();
    if (failures()) console.log(w.log.join("").slice(-3000));
    fs.rmSync(stateDir, { recursive: true, force: true });
  }
  console.log(failures() ? `\n${failures()} check(s) failed` : "\nAll open-demo checks passed");
  process.exit(failures() ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
