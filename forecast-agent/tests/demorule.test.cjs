/**
 * The free demo's fairness rule: it only ever predicts 3 months that have already finished, worked out from today's
 * date (never fixed months). A file may end at the latest 4 months before the current month.
 *   - the month arithmetic for every month of the year, across year ends, and the user's example (November → July);
 *   - "today" is taken in Hawaii time, so a month only counts as finished once it's over everywhere in the US;
 *   - the server refuses any later month on every request, so calling the API directly can't get round it;
 *   - the page shows today's cut-off, refuses a too-recent file with the polite message, and sends nothing;
 *   - a file that ends on time works as before, and nothing is stored;
 *   - the website's pages all agree on the rule and on how much history the demo and the full product need.
 * Uses a test-only date (X-Test-Today header, honoured only with ALLOW_TEST_CLOCK=1, which the live site doesn't set).
 */
const fs = require("fs"), os = require("os"), path = require("path"), { spawnSync } = require("child_process");
const { chromium } = require("playwright");
const { checker, startWorker, APP } = require("./helpers.cjs");

const PORT = 8940, OUT = path.join(__dirname, "output");
const { check, failures } = checker();
const months = (first, n) => Array.from({ length: n }, (_, i) => { const [y, m] = first.split("-").map(Number); const t = y * 12 + m - 1 + i; return `${Math.floor(t / 12)}-${String((t % 12) + 1).padStart(2, "0")}`; });
const csvFor = (ms) => ["Month,Product,Sales", ...ms.flatMap((m, t) => ["Apple Juice", "Oat Milk", "Sparkling Water"].map((p, k) => `${m},${p},${(100 + 40 * k) * (1 + 0.02 * t)}`))].join("\n") + "\n";

(async () => {
  fs.mkdirSync(OUT, { recursive: true });
  const R = await import("../worker/demo-rules.js");

  // ── The rule itself ──────────────────────────────────────────────────────────────────────────────────────
  const nov = R.demoRules("2026-11");
  check(nov.latestMonth === "2026-07" && nov.forecastMonths.join() === "2026-08,2026-09,2026-10", "your example: in November 2026 the file may end in July 2026; Draxly predicts August, September and October", JSON.stringify(nov));
  const expect = { "2027-01": ["2026-09", "2026-10,2026-11,2026-12"], "2027-02": ["2026-10", "2026-11,2026-12,2027-01"], "2027-03": ["2026-11", "2026-12,2027-01,2027-02"], "2027-04": ["2026-12", "2027-01,2027-02,2027-03"],
    "2027-05": ["2027-01", "2027-02,2027-03,2027-04"], "2027-12": ["2027-08", "2027-09,2027-10,2027-11"] };
  const wrong = Object.entries(expect).filter(([cur, [l, f]]) => { const r = R.demoRules(cur); return r.latestMonth !== l || r.forecastMonths.join() !== f; });
  check(wrong.length === 0, "across year ends too (January, February, March, April, May, December)", wrong.map(([c]) => c).join(", "));
  const allYear = months("2026-01", 24).every((cur) => { const r = R.demoRules(cur); return r.forecastMonths[2] === R.shiftMonth(cur, -1) && r.latestMonth < cur; });
  check(allYear, "for every month of two years: the last predicted month is always the month before the current one (finished), never the current month or later");
  check(R.currentMonth(new Date("2026-11-01T05:00:00Z")) === "2026-10" && R.currentMonth(new Date("2026-11-01T10:30:00Z")) === "2026-11", "a month counts as finished only once it's over in Hawaii (Oct 31, 7 p.m. in Hawaii is still October)");
  const realNow = R.currentMonth();
  check(R.demoCurrentMonth({}, { headers: new Headers({ "X-Test-Today": "2030-01-15" }) }) === realNow && R.demoCurrentMonth({ ALLOW_TEST_CLOCK: "1" }, { headers: new Headers({ "X-Test-Today": "2030-01-15" }) }) === "2030-01",
    "the live site always uses today's real date: the test date is ignored unless the test setting is on");
  check(R.tooRecentMessage(nov) === "To keep the test fair, please remove your most recent months so your file ends in July 2026. Draxly will predict the 3 months after that (August 2026 to October 2026), and you can compare them with your real sales.",
    "the refusal says it politely and names the allowed month and the 3 months that will be predicted", R.tooRecentMessage(nov));

  // ── The server ───────────────────────────────────────────────────────────────────────────────────────────
  check(spawnSync(process.execPath, [path.join(APP, "scripts", "build-worker.cjs")], { cwd: APP }).status === 0, "the app packs into the Worker");
  const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), "draxly-rule-"));
  const w = startWorker(PORT, stateDir, { ALLOW_TEST_CLOCK: "1" });
  const browser = await chromium.launch();
  const errors = [];
  try {
    await w.ready;
    const on = (today) => ({ "content-type": "application/json", ...(today ? { "X-Test-Today": today } : {}) });
    const rules = async (today) => (await fetch(`${w.base}/api/demo/rules`, { headers: on(today) })).json();
    check((await rules("2026-11-17")).latestMonth === "2026-07" && (await rules("2027-01-02")).latestMonth === "2026-09", "the server works the cut-off out from the date it's given (Nov 17 → July; Jan 2 → September)");
    check((await rules()).latestMonth === R.demoRules(realNow).latestMonth, `with no test date, it uses today's real date (today: file may end in ${R.monthName(R.demoRules(realNow).latestMonth)})`);
    const forecast = (ms, today) => fetch(`${w.base}/api/demo/forecast`, { method: "POST", headers: on(today), body: JSON.stringify({ months: ms, series: [{ product: "Apple Juice", values: ms.map((_, i) => 100 + i) }] }) });
    let r = await forecast(months("2024-11", 21), "2026-11-17");
    const ok = await r.json();
    check(r.status === 200 && ok.months.join() === "2026-08,2026-09,2026-10", "a file ending in July (in November) is forecast: August to October, all finished", JSON.stringify(ok.months));
    const refused = [];
    for (const last of ["2026-08", "2026-10", "2026-11", "2027-03"]) { const res = await forecast(months(R.shiftMonth(last, -20), 21), "2026-11-17"); const d = await res.json(); if (!(res.status === 400 && d.code === "too_recent" && d.error === R.tooRecentMessage(nov))) refused.push(`${last}: ${res.status}`); }
    check(refused.length === 0, "files ending in August, October, November (this month) or later are refused by the server with the polite message — calling the API directly doesn't get round it", refused.join(", "));
    r = await forecast(months("2025-01", 21), "2027-01-05");
    const r2 = await forecast(months("2025-02", 21), "2027-01-05");
    check(r.status === 200 && r2.status === 400, "in January 2027: a file ending September 2026 works, one ending October 2026 is refused (year end handled)");
    check((await forecast(months("2024-01", 12), "2026-11-17")).status === 200, "a file that ends earlier than the cut-off (here December 2024) is fine: its 3 months are long finished");
    const summary = (ms, today) => fetch(`${w.base}/api/demo/summary`, { method: "POST", headers: on(today), body: JSON.stringify({ months: ms, kind: "money", total: { history: ms.map(() => 1), forecast: [1, 1, 1] }, products: [] }) });
    check((await summary(months("2024-11", 21), "2026-11-17")).status === 200 && (await summary(months("2025-01", 21), "2026-11-17")).status === 400, "the written summary follows the same rule");

    // ── The demo page ──────────────────────────────────────────────────────────────────────────────────────
    const ctx = await browser.newContext({ viewport: { width: 1280, height: 900 }, acceptDownloads: true });
    await ctx.route("**/api/demo/**", (route) => route.continue({ headers: { ...route.request().headers(), "x-test-today": "2026-11-17" } }));
    const P = await ctx.newPage();
    P.on("pageerror", (e) => errors.push(e.message));
    const sent = []; P.on("request", (q) => { if (q.url().includes("/api/demo/forecast")) sent.push(q.url()); });
    await P.goto(`${w.base}/demo`);
    await P.waitForFunction(() => document.querySelector("#d-rule .r-latest")?.textContent === "July 2026");
    const ruleText = (await P.textContent("#d-rule")).replace(/\s+/g, " ");
    check(/must end in July 2026 or earlier/.test(ruleText) && /predict August 2026 to October 2026/.test(ruleText) && /never forecasts the future/.test(ruleText), "the demo page shows today's cut-off: end in July 2026; Draxly predicts August to October 2026", ruleText.slice(0, 160));
    const steps = (await P.textContent("#d-start ol")).replace(/\s+/g, " ");
    check(/November 2024 to October 2026/.test(steps) && /August 2026 to October 2026/.test(steps) && /November 2024 to July 2026/.test(steps), "its steps name the actual months: export Nov 2024–Oct 2026, keep Aug–Oct 2026 back, upload Nov 2024–Jul 2026", steps.slice(0, 200));
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "rule-files-"));
    const late = path.join(dir, "too-recent.csv"); fs.writeFileSync(late, csvFor(months("2025-01", 21))); // ends Sep 2026
    await P.setInputFiles("#d-file", late);
    await P.waitForSelector("#d-map-error:not([hidden])");
    const msg = await P.textContent("#d-map-error");
    check(msg === R.tooRecentMessage(nov) && await P.isDisabled("#d-run"), "a file ending in September 2026 is refused on the page with the polite message, and the button stays off", msg);
    check(sent.length === 0, "…and nothing was sent to be forecast");
    await P.screenshot({ path: path.join(OUT, "demo-rule-refused.png") });
    const good = path.join(dir, "ends-july.csv"); fs.writeFileSync(good, csvFor(months("2024-11", 21)));
    await P.setInputFiles("#d-file", good);
    await P.waitForFunction(() => !document.querySelector("#d-run").disabled);
    check(await P.isHidden("#d-map-error") && /forecast <b>Aug 2026 to Oct 2026<\/b>/.test(await P.innerHTML("#d-preview")), "a file ending in July 2026 is accepted: Draxly will forecast Aug to Oct 2026");
    await P.click("#d-run");
    await P.waitForSelector("#d-result:not([hidden])", { timeout: 60000 });
    const title = await P.textContent("#d-r-title");
    const [dl] = await Promise.all([P.waitForEvent("download"), P.click("#d-csv")]);
    check(/Aug 2026 to Oct 2026/.test(title) && dl.suggestedFilename() === "draxly-forecast-2026-08-to-2026-10.csv", "…and the result covers exactly August to October 2026 (title and CSV)", `${title} · ${dl.suggestedFilename()}`);
    await P.screenshot({ path: path.join(OUT, "demo-rule-ok.png") });
    const stored = []; const walk = (d) => { for (const e of fs.readdirSync(d, { withFileTypes: true })) { const p = path.join(d, e.name); e.isDirectory() ? walk(p) : stored.push(fs.readFileSync(p)); } }; walk(stateDir);
    check(!stored.some((b) => b.includes(Buffer.from("Apple Juice")) || b.includes(Buffer.from("Oat Milk"))), "still nothing stored: no product names in any stored file");

    // ── The website agrees ─────────────────────────────────────────────────────────────────────────────────
    const W = await ctx.newPage();
    await W.goto(`${w.base}/free-demo`);
    await W.waitForSelector(".r-today:not([hidden])");
    check(/Today: your file must end in July 2026 or earlier, and Draxly will predict August 2026 to October 2026/.test((await W.textContent(".r-today")).replace(/\s+/g, " ")), "the Free test demo page shows today's cut-off too");
    const page = async (p) => (await (await fetch(w.base + p)).text()).replace(/<[^>]+>/g, " ").replace(/\s+/g, " ");
    const site = {}; for (const p of ["/", "/how-it-works", "/integrations", "/security", "/pricing", "/free-demo", "/faq", "/about", "/terms", "/privacy", "/dpa", "/contact", "/demo"]) site[p] = await page(p);
    const stale = [/keep your last 3 real months/i, /6 months minimum/i, /History needed/i, /get the next 3 months for every product/i, /Forecast the next 3 months/i, /Your next 3 months/i, /up to your most recent full month — one row/i, /6 to 60 accepted/i];
    const found = Object.entries(site).flatMap(([p, t]) => stale.filter((re) => re.test(t)).map((re) => `${p}: ${re.source}`));
    check(found.length === 0, "no page still has the old, conflicting wording (e.g. '6 months minimum' for everything, or 'the next 3 months' for the demo)", found.join(" | "));
    const FULL = "At least 6 months of sales to forecast and 9 for the accuracy test; 12 to 24 months works best", DEMO = "21 months recommended (at least 6), ending at least 4 months before the current month";
    check(site["/"].includes(FULL) && site["/"].includes(DEMO) && site["/how-it-works"].includes(FULL) && site["/how-it-works"].includes(DEMO) && site["/free-demo"].includes(DEMO), "home, How it works and the Free demo page state the same history needs, separately for the full product and the demo");
    check(/Full product: at least 6 months of sales to forecast and 9 for the accuracy test/.test(site["/faq"]) && /Free test demo: 21 months recommended \(at least 6\), ending at least 4 months before the current month/.test(site["/faq"]), "the FAQ says the same");
    check(/in November your file can go up to July at the latest, and Draxly predicts August, September and October/.test(site["/faq"]) && /in November your file can go up to July at the latest/.test(site["/free-demo"]) && /never predicts the future/.test(site["/faq"]), "the FAQ and the Free demo page explain the cut-off rule with your example");
    const demoMentions = Object.entries(site).filter(([p, t]) => p !== "/demo" && /Upload 21 months/i.test(t) && !/at least 4 months ago|4 months before the current month/.test(t)).map(([p]) => p);
    check(demoMentions.length === 0, "every page that tells people to upload 21 months also says they must end at least 4 months ago", demoMentions.join(", "));
    check(errors.length === 0, "no page errors", errors.join(" | "));
  } finally {
    await browser.close(); await w.stop(); fs.rmSync(stateDir, { recursive: true, force: true });
  }
  if (failures()) { console.log(`\n${failures()} check(s) failed`); process.exit(1); }
  console.log("\nAll demo cut-off checks passed");
})().catch((e) => { console.error(e); process.exit(1); });
