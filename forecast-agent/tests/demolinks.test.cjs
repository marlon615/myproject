/**
 * One-time demo links, end to end, with the real Worker and a stand-in email service. The 72-hour viewing window and
 * the 30-day unused limit are shortened to seconds for this test only (DEMO_VIEW_SECONDS / DEMO_UNUSED_SECONDS, which
 * the live site doesn't set).
 *   - the owner creates a link → the email has step-by-step instructions and a clear "works only once" warning
 *   - a bad file is refused WITHOUT using the run; two runs at the same moment → exactly one goes through
 *   - the run gives one full forecast (accuracy test + 3-month forecast); no second run; results viewable for the window
 *   - then the link locks for good, shows "contact us", and the uploaded data is really deleted (checked in storage)
 *   - unused links lock; "Allow one more run" gives a fresh link; "Became a customer" moves the data into a new account
 *   - the owner sees each link's status (sent / used / locked), never the data; and in a real browser at phone size
 */
const { spawnSync, execFileSync } = require("child_process");
const fs = require("fs"), os = require("os"), path = require("path"), http = require("http");
const { chromium } = require("playwright");
const { checker, startWorker, api, until, sleep, APP } = require("./helpers.cjs");

const PORT = 8890, MAIL = 8891, OUT = path.join(__dirname, "output"), VIEW = 45, UNUSED = 60;
const { check, failures } = checker();
const mails = [];
const mailer = http.createServer((rq, rs) => { let b = ""; rq.on("data", (d) => (b += d)); rq.on("end", () => { try { mails.push(JSON.parse(b)); } catch { /* ignore */ } rs.writeHead(200, { "content-type": "application/json" }); rs.end('{"id":"x"}'); }); });
const months = (start, n) => Array.from({ length: n }, (_, i) => { const d = new Date(Date.UTC(+start.slice(0, 4), +start.slice(5) - 1 + i, 1)); return d.toISOString().slice(0, 7); });
const salesFile = (n = 24) => {
  const ax = months("2024-01", n), series = [];
  for (const [p, base] of [["Lemon Soda", 400], ["Iced Tea", 300], ["Trail Mix", 150]]) for (const s of ["Main Street", "Harbourside"]) series.push({ product: p, location: s, region: "Coast", amount: ax.map((_, t) => Math.round(base * (1 + 0.02 * t) * (1 + 0.3 * Math.sin(t / 1.9)) * 5)), units: ax.map((_, t) => Math.round(base * (1 + 0.02 * t) * (1 + 0.3 * Math.sin(t / 1.9)))) });
  return { name: "My sales", months: ax, series };
};
/** Sales rows stored in every Company store on disk (Durable Object SQLite files). */
function storedSeriesRows(dir) {
  const files = []; const walk = (d) => { for (const e of fs.readdirSync(d, { withFileTypes: true })) { const p = path.join(d, e.name); e.isDirectory() ? walk(p) : files.push(p); } }; walk(dir);
  const py = `import sqlite3,sys\nt=0\nfor f in sys.argv[1:]:\n  try:\n    c=sqlite3.connect(f); t+=c.execute("select count(*) from series").fetchone()[0]\n  except Exception: pass\nprint(t)`;
  return Number(execFileSync("python3", ["-c", py, ...files.filter((f) => /\.sqlite$/.test(f))]).toString().trim());
}

(async () => {
  fs.mkdirSync(OUT, { recursive: true });
  check(spawnSync(process.execPath, [path.join(APP, "scripts", "build-worker.cjs")], { cwd: APP }).status === 0, "the app packs into the Worker");
  await new Promise((ok) => mailer.listen(MAIL, ok));
  const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), "draxly-links-"));
  const w = startWorker(PORT, stateDir, { EMAIL_URL: `http://localhost:${MAIL}/emails`, DEMO_VIEW_SECONDS: String(VIEW), DEMO_UNUSED_SECONDS: String(UNUSED) });
  const req = api(w.base);
  const tryReq = (tok, p = "/api/try", body) => req(p, { method: body ? "POST" : "GET", body, headers: { "X-Demo-Link": tok } });
  const browser = await chromium.launch();
  const errors = [];
  try {
    await w.ready;
    const owner = (await req("/api/owner/claim", { method: "POST", body: { passcode: "owner-pass-123" } })).data.token;
    const pl = (await req("/api/owner/platform", { token: owner })).data.platform;
    check(pl.billingName === "M. D. Williams Enterprise, trading as Draxly" && pl.ownerEmail === "foliopayments.ja@gmail.com" && !("bookingUrl" in pl), "your business name and demo-request email are the defaults; no booking-link setting");
    await req("/api/owner/platform", { method: "POST", token: owner, body: { emailKey: "re_key", emailFrom: "Draxly <demo@draxly.test>" } });
    const tokOf = (url) => url.split("#")[1];

    // ── Create and email a link ────────────────────────────────────────────────────────────────────────────
    const unused = await req("/api/owner/demo-links", { method: "POST", token: owner, body: { company: "Never Opened Ltd", name: "Nia", email: "nia@never.test" } }); // stays unused
    const a = await req("/api/owner/demo-links", { method: "POST", token: owner, body: { company: "Bayside Beverages", name: "Ava Chen", email: "AVA@bayside.test" } });
    const tA = tokOf(a.data.url), mailA = mails.find((m) => m.to[0] === "ava@bayside.test");
    check(a.status === 200 && /\/try#[0-9a-f]{64}$/.test(a.data.url) && a.data.emailed && a.data.link.status === "sent", "owner creates a demo link: it's emailed, status Sent");
    check(/works once/i.test(mailA.subject) && /this link works only ONCE/i.test(mailA.html) && /THIS LINK WORKS ONLY ONCE/.test(mailA.text) && /get everything right before you press go/i.test(mailA.text) && mailA.html.includes(a.data.url)
      && ["Get your sales file ready", "Check its columns", "Open your link on a computer", "Choose your file", "Run my forecast", "Save your results"].every((s) => mailA.text.includes(s)) && /deleted when the link locks/.test(mailA.text) && /M\. D\. Williams Enterprise, trading as Draxly/.test(mailA.text),
      "the email has 6 clear steps, warns it works only once, explains the data is private and deleted, signed with your business name", mailA.subject);
    check(a.data.text === mailA.text && /^Your one-time Draxly demo/.test(a.data.subject), "the same text is shown on your dashboard to paste into your own email if needed");
    check(/<title>Your Draxly demo<\/title>/.test(await (await fetch(`${w.base}/try`)).text()), "the link opens the demo page");
    const st0 = await tryReq(tA);
    check(st0.data.status === "sent" && st0.data.company === "Bayside Beverages" && (await tryReq("f".repeat(64))).status === 404 && (await tryReq("nonsense")).status === 404, "a valid link shows the company; a made-up one is refused");

    // ── Bad files don't use the run; two at once → one ────────────────────────────────────────────────────
    const short = await tryReq(tA, "/api/try/run", salesFile(8));
    const tooBig = await tryReq(tA, "/api/try/run", { ...salesFile(24), series: Array.from({ length: 501 }, (_, i) => ({ product: `P${i}`, amount: Array(24).fill(1) })) });
    check(short.status === 400 && /hasn't been used/.test(short.data.error) && tooBig.status === 400 && (await tryReq(tA)).data.status === "sent", "a file with too few months, or too many combinations, is refused — and the run is NOT used", short.data.error);
    const [r1, r2] = await Promise.all([tryReq(tA, "/api/try/run", salesFile(24)), tryReq(tA, "/api/try/run", salesFile(24))]);
    check([r1.status, r2.status].sort().join() === "200,409", "two runs sent at the same moment: exactly one goes through", `${r1.status} ${r2.status}`);
    const res = await until(async () => { const s = (await tryReq(tA)).data; return s.result?.forecast?.ok && s.result?.backtest?.ok ? s : null; }, 60000, 500);
    check(res && res.status === "used" && res.result.products === 3 && res.result.locations === 2 && res.result.backtest.accuracy > 50 && res.result.forecast.months.length === 3 && res.result.forecast.products.length === 3, "one full forecast: accuracy test and the next 3 months by product (and store)", res ? `${res.result.backtest.accuracy}% accurate` : "");
    check((await tryReq(tA, "/api/try/run", salesFile(24))).status === 409, "a second run is refused");
    const stored = storedSeriesRows(stateDir);
    check(stored > 0, "(their data is stored while the results are viewable)", `${stored} rows`);
    const links1 = (await req("/api/owner/demo-links", { token: owner })).data.links;
    const la = links1.find((l) => l.company === "Bayside Beverages");
    check(la.status === "used" && la.openedAt && la.usedAt && la.viewUntil > Date.now() && !JSON.stringify(links1).match(/Lemon Soda|Main Street|Trail Mix/), "owner sees Used (opened, run time, viewable until) — and none of their data");

    // ── Browser: a second company does it on the page ──────────────────────────────────────────────────────
    const b = await req("/api/owner/demo-links", { method: "POST", token: owner, body: { company: "Hilltop Grocers", email: "jo@hilltop.test" } });
    const ctx = await browser.newContext({ viewport: { width: 390, height: 844 }, deviceScaleFactor: 2, isMobile: true, hasTouch: true, acceptDownloads: true });
    const P = await ctx.newPage();
    P.on("pageerror", (e) => errors.push(e.message));
    await P.goto(b.data.url);
    await P.waitForSelector("#t-start:not([hidden])");
    check(/works only once/i.test(await P.textContent(".warn-card")) && (await P.locator(".steps li").count()) === 6 && /Hilltop Grocers/.test(await P.textContent("#t-start h1")), "the page greets the company, warns it works only once, and lists the 6 steps");
    await P.screenshot({ path: path.join(OUT, "links-1-instructions-phone.png"), fullPage: true });
    await P.setInputFiles("#t-file", path.join(APP, "public", "sample-sales.csv"));
    await P.waitForSelector("#t-map:not([hidden])");
    check(/36 months/.test(await P.textContent("#t-preview")) && /6 products/.test(await P.textContent("#t-preview")) && await P.isDisabled("#t-run"), "after choosing the file it shows what it found (36 months, 6 products); the button stays off until they confirm");
    await P.check("#t-confirm");
    let asked = "";
    P.once("dialog", (d) => { asked = d.message(); d.accept(); });
    await P.click("#t-run");
    await P.waitForSelector("#t-fc-card:not([hidden])", { timeout: 60000 });
    check(/Last check/.test(asked) && /can't run it again/.test(asked) && /%/.test(await P.textContent("#t-acc")) && (await P.locator("#t-fc-table tbody tr").count()) === 7 && await P.isVisible("#t-fc-chart svg[role=img]"),
      "a last-check warning, then the accuracy score, forecast chart and product table", asked.split("\n")[0]);
    const [dl] = await Promise.all([P.waitForEvent("download"), P.click("#t-csv")]);
    check(/^draxly-forecast-Hilltop-Grocers\.csv$/.test(dl.suggestedFilename()), "the forecast downloads as a CSV");
    check(/72 hours|until/.test(await P.textContent("#t-r-contact")) && /foliopayments\.ja@gmail\.com/.test(await P.textContent("#t-r-contact")), "it says how long the results stay, and how to contact you");
    await P.screenshot({ path: path.join(OUT, "links-2-result-phone.png"), fullPage: true });
    await P.reload();
    await P.waitForSelector("#t-result:not([hidden])");
    check(!(await P.isVisible("#t-file")), "opening the link again shows the results, never the upload");

    // ── Allow one more run; became a customer ──────────────────────────────────────────────────────────────
    const again = await req(`/api/owner/demo-links/${la.id}/reissue`, { method: "POST", token: owner });
    const tA2 = tokOf(again.data.url);
    check(again.data.link.status === "sent" && (await tryReq(tA)).status === 404 && (await tryReq(tA2)).data.status === "sent", "'Allow one more run': a fresh link (Sent); the old link stops working; their earlier data is deleted");
    await tryReq(tA2, "/api/try/run", salesFile(30));
    await until(async () => (await tryReq(tA2)).data.result?.forecast?.ok, 60000, 500);
    const cu = await req(`/api/owner/demo-links/${la.id}/customer`, { method: "POST", token: owner });
    check(cu.status === 200 && cu.data.moved && /#\/invite\/[0-9a-f]{64}$/.test(cu.data.inviteLink) && cu.data.emailed, "'Became a customer': an account is created, the admin invite is emailed, the demo data moves in");
    const joined = await req("/api/invite", { method: "POST", body: { token: cu.data.inviteLink.split("/").pop(), name: "Ava Chen", password: "bayside-pass-1" } });
    const ups = (await req("/api/uploads", { token: joined.data.token })).data.uploads;
    check(joined.data.me.company === "Bayside Beverages" && joined.data.me.role === "admin" && ups.length === 1 && ups[0].months === 30 && ups[0].products === 3, "they accept the invite and find their demo data (30 months, 3 products) in their own account");
    check((await tryReq(tA2)).data.status === "locked" && (await req("/api/owner/demo-links", { token: owner })).data.links.find((l) => l.id === la.id).lockReason.startsWith("became a customer"), "the demo link itself is locked");

    // ── Time's up: locked for good, data deleted; unused links lock too ────────────────────────────────────
    await until(async () => (await req("/api/owner/demo-links", { token: owner })).data.links.find((l) => l.company === "Hilltop Grocers").viewUntil < Date.now(), (VIEW + 20) * 1000, 1000);
    const lockedNow = await tryReq(tokOf(b.data.url));
    check(lockedNow.data.status === "locked" && !lockedNow.data.result && /foliopayments/.test(lockedNow.data.contact), "after the viewing time the link locks for good (no results, a contact address)");
    await until(async () => (await req("/api/owner/demo-links", { token: owner })).data.links.find((l) => l.company === "Never Opened Ltd").status === "locked", (UNUSED + 20) * 1000, 2000);
    const finalLinks = (await req("/api/owner/demo-links", { token: owner })).data.links;
    check(finalLinks.find((l) => l.company === "Never Opened Ltd").lockReason.startsWith("unused for"), "a link that's never used locks by itself after the time limit");
    const left = storedSeriesRows(stateDir), customerRows = 30 && ups[0].series * 2;
    check(left === customerRows, "every demo's uploaded data is gone from storage; only the new customer's own copy remains", `${left} rows left (customer's own: ${customerRows})`);
    await P.reload();
    await P.waitForSelector("#t-locked:not([hidden])");
    check(/locked/.test(await P.textContent("#t-locked")) && /contact us at foliopayments\.ja@gmail\.com/.test(await P.textContent("#t-locked")), "the page now says it's locked and tells them to contact you");
    await P.screenshot({ path: path.join(OUT, "links-3-locked-phone.png") });
    // Owner dashboard view.
    const O = await ctx.newPage();
    O.on("pageerror", (e) => errors.push("owner: " + e.message));
    await O.goto(w.base + "/owner");
    await O.evaluate((t) => sessionStorage.setItem("forecast.owner", t), owner);
    await O.reload();
    await O.waitForSelector("#dl-table tbody tr[data-link]");
    const table = await O.textContent("#dl-table");
    check(/Bayside Beverages/.test(table) && /Hilltop Grocers/.test(table) && (table.match(/Locked/g) || []).length === 3 && /became a customer/.test(table), "owner dashboard lists each demo link with its status");
    await O.fill("#dl-company", "Coastline Foods"); await O.fill("#dl-email", "sam@coastline.test");
    await O.click("#dl-form button[type=submit]");
    await O.waitForSelector("#dl-new:not([hidden]) .reset-url");
    check(/\/try#/.test(await O.locator("#dl-new .reset-url").inputValue()) && /Sent/.test(await O.textContent("#dl-table")), "creating a link from the dashboard shows it once (with the email text) and lists it as Sent");
    await O.screenshot({ path: path.join(OUT, "links-4-owner-phone.png"), fullPage: true });
    check(errors.length === 0, "no page errors", errors.join(" | "));
    await ctx.close();
  } finally {
    await browser.close();
    await w.stop();
    mailer.close();
    if (failures()) console.log(w.log.join("").slice(-3000));
    fs.rmSync(stateDir, { recursive: true, force: true });
  }
  console.log(failures() ? `\n${failures()} check(s) failed` : "\nAll demo-link checks passed");
  process.exit(failures() ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
