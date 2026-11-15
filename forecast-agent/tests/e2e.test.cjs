/**
 * The whole Forecasting Agent with the real Worker (wrangler dev, local storage) and a real browser at phone size:
 *   - two companies sign up; one uploads the sample CSV, the other a real Excel (.xlsx) file;
 *   - the free backtest runs on upload: accuracy score, chart, predicted vs actual table, summary;
 *   - the 3-month forecast is refused (by the server, 402) until the owner records a payment, then shows its chart,
 *     product table and plain-English summary;
 *   - each company's data is separate (the other company's upload ids give "not found");
 *   - the owner dashboard: passcode set on first visit, customers, uploads, accuracy, money collected, switches,
 *     viewing a customer's forecast, deleting a customer; wrong-passcode and wrong-password limits; bad uploads refused.
 * Nothing here touches the live site.
 */
const { spawn, spawnSync } = require("child_process");
const fs = require("fs"), os = require("os"), path = require("path"), vm = require("vm");
const { chromium } = require("playwright");

const PORT = 8811, BASE = `http://localhost:${PORT}`;
const APP = path.join(__dirname, ".."), OUT = path.join(__dirname, "output");
const WRANGLER = path.join(APP, "..", "chief-of-staff", "node_modules", ".bin", "wrangler");
let failures = 0;
const check = (ok, name, extra = "") => { console.log(`${ok ? "PASS" : "FAIL"}  ${name}${extra ? "  — " + extra : ""}`); if (!ok) failures++; };
const PHONE = { viewport: { width: 390, height: 844 }, deviceScaleFactor: 2, isMobile: true, hasTouch: true };
const req = async (p, { method = "GET", body, token } = {}) => {
  const r = await fetch(BASE + p, { method, headers: { ...(body ? { "content-type": "application/json" } : {}), ...(token ? { Authorization: `Bearer ${token}` } : {}) }, body: body ? JSON.stringify(body) : undefined });
  return { status: r.status, data: r.status === 204 ? {} : await r.json().catch(() => ({})) };
};

function startWorker(stateDir) {
  const log = [];
  const child = spawn(WRANGLER, ["dev", "--port", String(PORT), "--persist-to", stateDir, "--show-interactive-dev-session=false", "--log-level", "warn"], {
    cwd: APP, env: { ...process.env, WRANGLER_SEND_METRICS: "false", CLOUDFLARE_API_TOKEN: "placeholder-not-used-locally" }, stdio: ["ignore", "pipe", "pipe"],
  });
  child.stdout.on("data", (d) => log.push(String(d)));
  child.stderr.on("data", (d) => log.push(String(d)));
  const ready = (async () => {
    for (let i = 0; i < 120; i++) { try { if ((await fetch(`${BASE}/api/owner/state`)).status) return; } catch { /* not yet */ } await new Promise((ok) => setTimeout(ok, 500)); }
    throw new Error(`wrangler dev didn't start:\n${log.join("")}`);
  })();
  return { ready, log, stop: () => new Promise((ok) => { child.once("exit", ok); child.kill("SIGTERM"); setTimeout(() => { child.kill("SIGKILL"); ok(); }, 5000); }) };
}

/** A real .xlsx of the sample's first 15 months, made with the same SheetJS file the app ships. */
function makeXlsx(file) {
  const sb = { console, Date, Uint8Array, ArrayBuffer, Buffer, TextDecoder, TextEncoder }; sb.self = sb; sb.window = sb;
  vm.runInNewContext(fs.readFileSync(path.join(APP, "public", "vendor", "xlsx.full.min.js"), "utf8"), sb);
  const XLSX = sb.XLSX;
  const lines = fs.readFileSync(path.join(APP, "public", "sample-sales.csv"), "utf8").trim().split("\n").slice(1);
  const rows = [["Invoice date", "Item", "Units", "Revenue"]];
  for (const l of lines) {
    const m = /^(\d\d)\/(\d\d)\/(\d{4}),([^,]+),(\d+),"\$([\d,.]+)"$/.exec(l);
    const d = new Date(Date.UTC(+m[3], +m[2] - 1, +m[1]));
    if (d >= new Date(Date.UTC(2025, 0, 1))) break; // Oct 2023 – Dec 2024 = 15 months
    rows.push([d, m[4], +m[5], +m[6].replace(/,/g, "")]);
  }
  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet([["Notes: exported from the till"]]), "Notes");
  XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet(rows, { cellDates: true }), "Sales");
  fs.writeFileSync(file, XLSX.write(wb, { type: "buffer", bookType: "xlsx" }));
  return rows.length - 1;
}

(async () => {
  fs.mkdirSync(OUT, { recursive: true });
  check(spawnSync(process.execPath, [path.join(APP, "scripts", "build-worker.cjs")], { cwd: APP }).status === 0, "the app packs into the Worker");
  const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), "forecast-e2e-"));
  const xlsxFile = path.join(stateDir, "bay-market-sales.xlsx");
  const xlsxRows = makeXlsx(xlsxFile);
  const w = startWorker(stateDir);
  const browser = await chromium.launch();
  const errors = [];
  const watch = (page, who) => {
    page.on("pageerror", (e) => errors.push(`${who}: ${e.message}`));
    page.on("console", (m) => { if (m.type() === "error" && !/status of (401|402|403|409|429)/.test(m.text())) errors.push(`${who} console: ${m.text()}`); });
  };
  try {
    await w.ready;

    // ── Company A signs up in the browser and tries the sample ────────────────────────────────────────────────
    const actx = await browser.newContext({ ...PHONE, acceptDownloads: true }); const A = await actx.newPage(); watch(A, "A");
    await A.goto(BASE + "/");
    await A.waitForSelector("#auth:not([hidden])");
    await A.fill("#company", "Island Drinks Co"); await A.fill("#email", "owner@islanddrinks.test"); await A.fill("#password", "mango-season-1");
    await A.click("#auth-submit");
    await A.waitForSelector("#home:not([hidden])");
    check(await A.textContent("#who-name") === "Island Drinks Co", "company A signs up and lands on its page");
    await A.click("#sample");
    await A.waitForSelector("#map:not([hidden])");
    const prev = (await A.textContent("#preview")).replace(/\s+/g, " ");
    check(/36 months/.test(prev) && /Oct 2023 to Sep 2026/.test(prev) && /6 products/.test(prev) && !/skipped/.test(prev), "sample file: the columns are guessed and it finds 36 months, 6 products", prev);
    check(await A.$eval("#col-date", (s) => s.selectedOptions[0].text) === "Date" && await A.$eval("#col-value", (s) => s.selectedOptions[0].text) === "Sales" && await A.$eval("#col-product", (s) => s.selectedOptions[0].text) === "Product", "date, product and sales columns picked correctly");
    await A.click("#run");
    await A.waitForSelector("#result:not([hidden]) #bt-acc");
    await A.waitForFunction(() => /%/.test(document.querySelector("#bt-acc").textContent));
    const acc = await A.textContent("#bt-acc");
    const btRows = await A.locator("#bt-table tbody tr").count();
    check(/^\d+(\.\d)?%$/.test(acc) && parseFloat(acc) >= 80, "the free backtest runs straight away with an accuracy score", acc);
    check(btRows === 7 && /Predicted/.test(await A.textContent("#bt-table")) && /Actual/.test(await A.textContent("#bt-table")), "predicted and actual side by side for each of the 6 products plus the total");
    check(await A.locator("#bt-chart svg path.line").count() === 2 && /Jul 2026, Aug 2026, Sep 2026/.test(await A.textContent("#bt-months")), "backtest chart (actual vs predicted) for the 3 hidden months: Jul–Sep 2026");
    check((await A.locator("#bt-summary li").count()) >= 2, "plain-English backtest summary", (await A.textContent("#bt-summary li")).slice(0, 120));
    await A.screenshot({ path: path.join(OUT, "1-backtest-phone.png"), fullPage: true });
    // Hover tooltip on the chart.
    const box = await A.locator("#bt-chart svg[role=img]").boundingBox();
    await A.mouse.move(box.x + box.width - 16, box.y + box.height / 2);
    check(/Sep 2026/.test(await A.textContent("#bt-chart .tip")) && /Predicted/.test(await A.textContent("#bt-chart .tip")), "hovering the chart shows that month's actual and predicted", (await A.textContent("#bt-chart .tip")).replace(/\s+/g, " "));
    // Forecast is locked until paid.
    check(await A.isVisible("#fc-locked") && !(await A.isVisible("#fc-run")), "the 3-month forecast is locked for a new (unpaid) account");
    const tokenA = await A.evaluate(() => localStorage.getItem("forecast.token"));
    const listA = (await req("/api/uploads", { token: tokenA })).data.uploads;
    check((await req(`/api/uploads/${listA[0].id}/forecast`, { method: "POST", token: tokenA })).status === 402, "…and the server itself refuses it (402), not just the page");

    // ── Company B signs up and uploads a real Excel file ───────────────────────────────────────────────────────
    const bctx = await browser.newContext({ ...PHONE }); const B = await bctx.newPage(); watch(B, "B");
    await B.goto(BASE + "/");
    await B.fill("#company", "Bay Market"); await B.fill("#email", "BOSS@baymarket.test "); await B.fill("#password", "bay-market-22");
    await B.click("#auth-submit");
    await B.waitForSelector("#home:not([hidden])");
    await B.setInputFiles("#file", xlsxFile);
    await B.waitForSelector("#map:not([hidden])", { timeout: 15000 });
    const bprev = (await B.textContent("#preview")).replace(/\s+/g, " ");
    check(/15 months/.test(bprev) && /Oct 2023 to Dec 2024/.test(bprev) && new RegExp(`${xlsxRows.toLocaleString("en-US")} rows used`).test(bprev), "Excel file (2 sheets, real dates): picks the Sales sheet, 15 months, every row used", bprev);
    check(await B.$eval("#col-value", (s) => s.selectedOptions[0].text) === "Revenue" && await B.$eval("#col-product", (s) => s.selectedOptions[0].text) === "Item", "Excel columns 'Invoice date / Item / Revenue' recognised");
    await B.click("#run");
    await B.waitForFunction(() => /%/.test(document.querySelector("#bt-acc")?.textContent || ""));
    check(/Oct 2024, Nov 2024, Dec 2024/.test(await B.textContent("#bt-months")), "B's backtest hides its own last 3 months (Oct–Dec 2024)", await B.textContent("#bt-acc"));
    const tokenB = await B.evaluate(() => localStorage.getItem("forecast.token"));
    const listB = (await req("/api/uploads", { token: tokenB })).data.uploads;

    // ── Separation ───────────────────────────────────────────────────────────────────────────────────────────
    check(listA.length === 1 && listB.length === 1 && listA[0].id !== listB[0].id && listB[0].months === 15, "each company sees only its own upload");
    check((await req(`/api/uploads/${listA[0].id}`, { token: tokenB })).status === 404 && (await req(`/api/uploads/${listA[0].id}`, { method: "DELETE", token: tokenB })).status === 204
      && (await req(`/api/uploads/${listA[0].id}`, { token: tokenA })).status === 200, "B can't read or delete A's upload even with its exact id (A's is untouched)");
    check((await req("/api/uploads")).status === 401 && (await req("/api/uploads", { token: "f".repeat(64) })).status === 401, "no token or a made-up token: nothing");
    check((await req("/api/signup", { method: "POST", body: { company: "X", email: "boss@baymarket.test", password: "whatever-123" } })).status === 409, "the same email can't sign up twice (emails are not case-sensitive)");
    check((await req("/api/signup", { method: "POST", body: { company: "X", email: "x@y.test", password: "short" } })).status === 400, "passwords under 8 characters are refused");
    const bad = await req("/api/uploads", { method: "POST", token: tokenB, body: { name: "gap", kind: "money", months: ["2025-01", "2025-03"], products: { A: [1, 2] } } });
    check(bad.status === 400 && /gaps/.test(bad.data.error), "a tampered upload (months with a gap) is refused", bad.data.error);
    const bad2 = await req("/api/uploads", { method: "POST", token: tokenB, body: { name: "x", months: ["2025-01"], products: { A: ["<script>"] } } });
    check(bad2.status === 400, "non-numbers in an upload are refused");

    // ── Owner dashboard ──────────────────────────────────────────────────────────────────────────────────────
    const octx = await browser.newContext({ ...PHONE }); const O = await octx.newPage(); watch(O, "owner");
    await O.goto(BASE + "/owner");
    await O.waitForSelector("#o-gate:not([hidden])");
    check(/Set your owner passcode/.test(await O.textContent("#o-gate-title")), "first visit to /owner asks to set the passcode");
    await O.fill("#o-pass", "owner-pass-123"); await O.fill("#o-pass2", "owner-pass-123"); await O.click("#o-submit");
    await O.waitForSelector("#o-dash:not([hidden]) .cust");
    const tiles = (await O.textContent("#o-tiles")).replace(/\s+/g, " ");
    check(/2\s*Customers/.test(tiles) && /0\s*Paying/.test(tiles) && /\$0\.00\s*Money collected/.test(tiles) && /2\s*Uploads/.test(tiles), "owner sees 2 customers, 2 uploads, $0 collected", tiles);
    const cardA = O.locator(".cust", { hasText: "Island Drinks Co" });
    check(new RegExp(`${acc.replace("%", "")}%`).test(await cardA.textContent()) && /Backtest only/.test(await cardA.textContent()), "owner sees A's backtest accuracy and that A is on backtest only");
    check((await req("/api/owner/claim", { method: "POST", body: { passcode: "someone-else-1" } })).status === 409, "nobody else can set the passcode after you");
    check((await req("/api/owner/customers", { token: tokenA })).status === 401, "a customer's login doesn't open the owner dashboard");
    // Record a payment for A → forecasts switch on.
    await cardA.locator(".pay-amount").fill("49");
    await cardA.locator(".pay-note").fill("Starter, paid by Zelle");
    await cardA.locator(".pay-add").click();
    await O.waitForFunction(() => /\$49\.00\s*Money collected/.test(document.querySelector("#o-tiles").textContent));
    check(/Forecasts on/.test(await O.locator(".cust", { hasText: "Island Drinks Co" }).textContent()) && /1\s*Paying/.test(await O.textContent("#o-tiles")), "recording $49 for A: Money collected $49.00 and A's forecasts switch on");
    await O.screenshot({ path: path.join(OUT, "2-owner-phone.png"), fullPage: true });

    // A now gets the forecast.
    await A.reload();
    await A.waitForSelector("#fc-ask:not([hidden]) #fc-run");
    await A.click("#fc-run");
    await A.waitForSelector("#fc:not([hidden])");
    const fcTable = await A.textContent("#fc-table");
    check(/Oct 2026/.test(fcTable) && /Nov 2026/.test(fcTable) && /Dec 2026/.test(fcTable) && await A.locator("#fc-table tbody tr").count() === 7, "after paying, A gets the next 3 months (Oct–Dec 2026) for all 6 products plus the total");
    const sum1 = (await A.textContent("#fc-summary")).replace(/\s+/g, " ");
    check(/Expected sales for Oct 2026 to Dec 2026: about \$[\d,]+/.test(sum1) && /December is usually a strong month/.test(sum1), "plain-English forecast summary explains what's driving it", sum1.slice(0, 160));
    check(await A.locator("#fc-chart svg path.line").count() === 2, "forecast chart: actual history and the dashed forecast");
    await A.selectOption("#fc-pick", { label: "Mango Juice" });
    check(/Mango Juice/.test(await A.textContent("#fc-chart .legend")), "the chart switches to one product");
    const [dl] = await Promise.all([A.waitForEvent("download"), A.click("#fc-csv")]);
    const csvText = fs.readFileSync(await dl.path(), "utf8");
    check(/^"Product","Oct 2026","Nov 2026","Dec 2026"/.test(csvText) && csvText.trim().split("\n").length === 8, "the forecast downloads as a CSV", csvText.split("\n")[0]);
    await A.screenshot({ path: path.join(OUT, "3-forecast-phone.png"), fullPage: true });
    check((await req(`/api/uploads/${listB[0].id}/forecast`, { method: "POST", token: tokenB })).status === 402, "B (unpaid) is still refused");

    // Owner views A's uploads and forecast.
    await O.reload();
    await O.waitForSelector(".cust");
    await O.locator(".cust", { hasText: "Island Drinks Co" }).locator(".toggle-uploads").click();
    await O.waitForSelector(".cust-uploads li[data-uid]");
    check(/forecast made/.test(await O.textContent(".cust-uploads")), "owner sees A's upload and that its forecast was made");
    await O.locator(".up-view").first().click();
    await O.waitForSelector(".view .o-chart svg[role=img]");
    check(/Expected sales/.test(await O.textContent(".view")), "owner can open A's backtest, forecast summary, chart and table");
    // Owner runs a forecast for B (owner can always), without switching B's forecasts on.
    await O.locator(".cust", { hasText: "Bay Market" }).locator(".toggle-uploads").click();
    await O.locator(".cust", { hasText: "Bay Market" }).locator(".up-fc").click();
    await O.waitForSelector(".cust:has-text('Bay Market') .view .o-chart svg");
    check(/Jan 2025/.test(await O.locator(".cust", { hasText: "Bay Market" }).locator(".view").textContent()), "owner can run a forecast for any customer's upload (B: Jan–Mar 2025)");
    await O.screenshot({ path: path.join(OUT, "4-owner-view-phone.png"), fullPage: true });

    // Switch B off: blocked everywhere; on again: works.
    await O.fill("#o-contact", "hello@forecast.test"); await O.click("#o-contact-save");
    await O.waitForFunction(() => document.querySelector("#o-contact-saved").textContent === "Saved");
    await O.locator(".cust", { hasText: "Bay Market" }).locator(".sw-account").uncheck();
    await O.waitForFunction(() => /Account off/.test([...document.querySelectorAll(".cust")].find((c) => /Bay Market/.test(c.textContent)).textContent));
    check((await req("/api/uploads", { token: tokenB })).status === 401, "switching B off signs B out everywhere");
    const offLogin = await req("/api/login", { method: "POST", body: { email: "boss@baymarket.test", password: "bay-market-22" } });
    check(offLogin.status === 403 && offLogin.data.contact === "hello@forecast.test", "B can't sign in while off, and is told who to contact");
    await B.reload();
    await B.waitForSelector("#auth:not([hidden])");
    await B.click("#tab-login"); await B.fill("#email", "boss@baymarket.test"); await B.fill("#password", "bay-market-22"); await B.click("#auth-submit");
    await B.waitForSelector("#off:not([hidden])");
    check(/hello@forecast\.test/.test(await B.textContent("#off")), "B's page shows 'switched off' with your contact");
    await O.locator(".cust", { hasText: "Bay Market" }).locator(".sw-account").check();
    await O.waitForFunction(() => /Account on/.test([...document.querySelectorAll(".cust")].find((c) => /Bay Market/.test(c.textContent)).textContent));
    check((await req("/api/login", { method: "POST", body: { email: "boss@baymarket.test", password: "bay-market-22" } })).status === 200, "switched back on: B can sign in again, data intact");
    // The forecast switch can also be turned off by hand.
    await O.locator(".cust", { hasText: "Island Drinks Co" }).locator(".sw-forecasts").uncheck();
    await O.waitForFunction(() => /Backtest only/.test([...document.querySelectorAll(".cust")].find((c) => /Island Drinks/.test(c.textContent)).textContent));
    check((await req(`/api/uploads/${listA[0].id}/forecast`, { method: "POST", token: tokenA })).status === 402, "turning A's forecast switch off locks new forecasts again");

    // Limits on guessing.
    let last;
    for (let i = 0; i < 6; i++) last = await req("/api/login", { method: "POST", body: { email: "owner@islanddrinks.test", password: `wrong-${i}-xx` } });
    check(last.status === 429, "6 wrong customer passwords in a row: told to wait");
    for (let i = 0; i < 6; i++) last = await req("/api/owner/login", { method: "POST", body: { passcode: `wrong-pass-${i}` } });
    check(last.status === 429, "6 wrong owner passcodes in a row: told to wait");

    // Delete a customer completely.
    O.once("dialog", (d) => d.accept());
    await O.locator(".cust", { hasText: "Bay Market" }).locator(".del-cust").click();
    await O.waitForFunction(() => !/Bay Market/.test(document.querySelector("#o-customers").textContent));
    const after = (await req("/api/owner/customers", { token: await O.evaluate(() => sessionStorage.getItem("forecast.owner")) })).data;
    check(after.customers.length === 1 && after.totals.uploads === 1 && after.totals.collectedCents === 4900, "deleting B removes it from your dashboard (A and the $49 stay)");
    check((await req("/api/uploads", { token: tokenB })).status === 401 && (await req("/api/login", { method: "POST", body: { email: "boss@baymarket.test", password: "bay-market-22" } })).status !== 200, "B's login and data are gone");

    check(errors.length === 0, "no page errors", errors.join(" | "));
    for (const c of [actx, bctx, octx]) await c.close();
  } finally {
    await browser.close();
    await w.stop();
    if (failures) console.log(w.log.join("").slice(-3000));
    fs.rmSync(stateDir, { recursive: true, force: true });
  }
  console.log(failures ? `\n${failures} check(s) failed` : "\nAll end-to-end checks passed");
  process.exit(failures ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
