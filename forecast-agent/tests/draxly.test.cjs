/**
 * Draxly: the new name everywhere, billing (Draxly Enterprise agreements, invoices, reminders, renewal, early
 * cancellation, PDFs, owner and customer billing pages) and the public demo (read-only, sample distributor data,
 * Book a call / Request access, who opened it), with the real Worker and stand-in email (Resend shape) and phone
 * alert (ntfy shape) services on this machine. Billing runs on a test clock (only possible with ALLOW_TEST_CLOCK=1,
 * which the live site doesn't set).
 */
const { spawnSync } = require("child_process");
const fs = require("fs"), os = require("os"), path = require("path"), http = require("http");
const { chromium } = require("playwright");
const { checker, startWorker, api, until, sleep, APP } = require("./helpers.cjs");

const PORT = 8880, MAIL = 8881, NTFY = 8882, OUT = path.join(__dirname, "output");
const { check, failures } = checker();
const mails = [], alerts = [];
const sink = (list) => http.createServer((rq, rs) => { let b = ""; rq.on("data", (d) => (b += d)); rq.on("end", () => { try { list.push(JSON.parse(b)); } catch { /* ignore */ } rs.writeHead(200, { "content-type": "application/json" }); rs.end('{"id":"x"}'); }); });
const mailer = sink(mails), ntfy = sink(alerts);
const pdfText = (b64) => Buffer.from(b64, "base64").toString("latin1");

(async () => {
  fs.mkdirSync(OUT, { recursive: true });
  check(spawnSync(process.execPath, [path.join(APP, "scripts", "build-worker.cjs")], { cwd: APP }).status === 0, "the app packs into the Worker");
  await new Promise((ok) => mailer.listen(MAIL, ok)); await new Promise((ok) => ntfy.listen(NTFY, ok));
  const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), "draxly-"));
  const w = startWorker(PORT, stateDir, { EMAIL_URL: `http://localhost:${MAIL}/emails`, NTFY_URL: `http://localhost:${NTFY}/`, ALLOW_TEST_CLOCK: "1" });
  const req = api(w.base);
  const browser = await chromium.launch();
  const errors = [];
  try {
    await w.ready;

    // ── The new name ───────────────────────────────────────────────────────────────────────────────────────
    const pages = {};
    for (const p of ["/", "/owner", "/pricing", "/security", "/docs", "/demo", "/no-such-page", "/app.js", "/owner.js"]) pages[p] = (await (await fetch(w.base + p)).text());
    check(Object.values(pages).every((t) => !/Forecasting Agent/i.test(t)), "no page, script or 404 says 'Forecasting Agent' any more");
    check(["/", "/owner", "/pricing", "/security", "/docs", "/no-such-page"].every((p) => /<title>[^<]*Draxly[^<]*<\/title>/.test(pages[p])), "every page's title says Draxly");
    check((pages["/"].match(/Know what to stock before you need it\./g) || []).length >= 2, "the tagline is on the home page and on the sign-in card");
    check(/draxly-forecast-/.test(pages["/app.js"]) && /draxly-reorder-suggestions\.csv/.test(pages["/app.js"]) && /draxly-activity-log\.csv/.test(pages["/app.js"]) && /draxly-invoice-/.test(pages["/app.js"]), "downloads are named draxly-… (forecast, reorder, activity log, invoices)");
    check(/\$30,000/.test(pages["/pricing"]) && /\$2,500 a month/.test(pages["/pricing"]) && /renews automatically/.test(pages["/pricing"]) && /rest of that year is still owed/.test(pages["/pricing"]), "the pricing page states the plan and terms");

    // ── Setup ──────────────────────────────────────────────────────────────────────────────────────────────
    const owner = (await req("/api/owner/claim", { method: "POST", body: { passcode: "owner-pass-123" } })).data.token;
    await req("/api/owner/platform", { method: "POST", token: owner, body: { emailKey: "re_key", emailFrom: "Draxly <billing@draxly.test>", billingName: "Draxly Inc.", paymentInstructions: "ACH to Example Bank, routing 011000015, account 123456789.", ownerEmail: "owner@draxly.test", bookingUrl: "https://cal.example.com/draxly/intro" } });
    await req("/api/owner/alerts", { method: "POST", token: owner, body: { make: true } });
    const A = await req("/api/signup", { method: "POST", body: { company: "Cascade Grocers", email: "cfo@cascade.test", password: "admin-pass-1" } });
    const aid = A.data.me.id, adminA = A.data.token;
    const inv = await req("/api/team", { method: "POST", token: adminA, body: { email: "ops@cascade.test", role: "manager" } });
    const mgr = (await req("/api/invite", { method: "POST", body: { token: inv.data.link.split("/").pop(), password: "manager-pass-1" } })).data.token;
    const run = async (today) => (await req("/api/owner/billing/run", { method: "POST", token: owner, body: { today } })).data;
    const bill = async (id) => (await req("/api/owner/customers", { token: owner })).data.customers.find((c) => c.id === id).billing;

    // ── Annual, upfront ────────────────────────────────────────────────────────────────────────────────────
    let n0 = mails.length;
    const st = await req("/api/owner/agreement", { method: "POST", token: owner, body: { id: aid, billing: "annual", start: "2026-01-15", today: "2026-01-15" } });
    let b = st.data.billing;
    const i1 = b.invoices[0];
    check(st.status === 200 && b.agreement.plan === "Draxly Enterprise" && b.agreement.renewal === "2027-01-15" && b.invoices.length === 1 && i1.amountCents === 3000000 && i1.number === "DRX-2026-0001" && i1.due === "2026-01-30" && b.status === "paid" && b.owedCents === 3000000,
      "upfront agreement from Jan 15: one $30,000 invoice (DRX-2026-0001, due in 15 days), renews Jan 15 2027", `${b.statusWords}, owed ${b.owedCents / 100}`);
    const invMail = mails.slice(n0).filter((m) => /Draxly invoice DRX-2026-0001/.test(m.subject));
    check(invMail.length === 1 && invMail[0].to[0] === "cfo@cascade.test" && invMail[0].attachments?.[0]?.filename === "DRX-2026-0001.pdf" && /^%PDF-1\.4/.test(pdfText(invMail[0].attachments[0].content)) && /DRX-2026-0001/.test(pdfText(invMail[0].attachments[0].content)) && /ACH to Example Bank/.test(invMail[0].html),
      "the invoice is emailed automatically to the company's admin (not the manager) with the PDF attached and how to pay", invMail[0]?.subject);
    check((await req("/api/owner/agreement", { method: "POST", token: owner, body: { id: aid, billing: "monthly", today: "2026-02-01" } })).status === 409, "a company can't get a second agreement while one is active");
    // Reminders: 1, 7, 14 days late, then every 14 days; never twice.
    const reminders = async (today) => { const k = mails.length; await run(today); return mails.slice(k).filter((m) => /^Reminder: Draxly invoice/.test(m.subject)).map((m) => m.subject); };
    check((await reminders("2026-01-30")).length === 0, "no reminder on the due date");
    const r1 = await reminders("2026-01-31");
    check(r1.length === 1 && /1 day overdue/.test(r1[0]) && (await bill(aid)).status === "overdue" && (await bill(aid)).overdueCents === 3000000, "1 day late: a reminder, and the company shows Overdue", r1[0]);
    check((await reminders("2026-01-31")).length === 0 && (await reminders("2026-02-01")).length === 0, "running again the same day (or the next) sends nothing more");
    check(/7 days overdue/.test((await reminders("2026-02-06"))[0] || "") && /14 days overdue/.test((await reminders("2026-02-13"))[0] || "") && (await reminders("2026-02-26")).length === 0 && /28 days overdue/.test((await reminders("2026-02-27"))[0] || ""), "then reminders at 7, 14 and 28 days late (every 14 days after that)");
    const pr = await req(`/api/owner/invoices/${i1.id}/paid`, { method: "POST", token: owner, body: { paid: true, note: "ACH received" } });
    b = await bill(aid);
    check(pr.status === 200 && b.status === "paid" && b.paidCents === 3000000 && b.owedCents === 0 && b.invoices[0].status === "paid", "'Mark paid': paid up, $30,000 paid, nothing owed");
    check((await reminders("2026-03-13")).length === 0, "no reminders for a paid invoice");
    const ren = await run("2027-01-15");
    b = await bill(aid);
    check(ren.renewed.includes(aid) && b.agreement.termStart === "2027-01-15" && b.agreement.renewal === "2028-01-15" && b.invoices.length === 2 && b.invoices[0].number === "DRX-2027-0002" && b.owedCents === 3000000, "on Jan 15 2027 it renews by itself: new year, new $30,000 invoice, next renewal Jan 15 2028");

    // ── Monthly, starting on the 31st; early cancellation ──────────────────────────────────────────────────
    const B = await req("/api/signup", { method: "POST", body: { company: "Pacific Pantry Co", email: "owner@pantry.test", password: "admin-pass-2" } });
    const bid = B.data.me.id;
    await req("/api/owner/agreement", { method: "POST", token: owner, body: { id: bid, billing: "monthly", start: "2026-03-31", today: "2026-03-31" } });
    for (const d of ["2026-04-30", "2026-05-31", "2026-06-30", "2026-06-30"]) await run(d);
    b = await bill(bid);
    const starts = b.invoices.map((i) => i.periodStart).sort();
    check(starts.join() === "2026-03-31,2026-04-30,2026-05-31,2026-06-30" && b.invoices.every((i) => i.amountCents === 250000) && b.remainingTermCents === 8 * 250000, "monthly from Mar 31: $2,500 on Mar 31, Apr 30, May 31, Jun 30 (month ends handled), no duplicates; $20,000 still to invoice this year", starts.join(" "));
    for (const i of b.invoices.filter((x) => x.periodStart < "2026-06-30")) await req(`/api/owner/invoices/${i.id}/paid`, { method: "POST", token: owner, body: { paid: true } });
    n0 = mails.length;
    const cx = await req("/api/owner/agreement/cancel", { method: "POST", token: owner, body: { id: bid, today: "2026-07-10" } });
    b = cx.data.billing;
    const rem = b.invoices.find((i) => i.kind === "remainder");
    check(cx.status === 200 && b.status === "cancelled" && rem.amountCents === 2000000 && /remaining 8 months/.test(rem.description) && b.owedCents === 2250000 && b.agreement.renewal === null && b.agreement.termEnd === "2027-03-31",
      "cancelling early: no renewal, and the remaining 8 months ($20,000) are invoiced now — owed $22,500 with June", `${b.statusWords}, owed ${b.owedCents / 100}`);
    check(mails.slice(n0).some((m) => m.to[0] === "owner@pantry.test" && m.subject.includes(rem.number)), "the remainder invoice is emailed too");
    for (const d of ["2026-07-31", "2026-08-31", "2027-03-31", "2027-04-01"]) await run(d);
    b = await bill(bid);
    check(b.invoices.length === 5 && b.agreement.termStart === "2026-03-31" && b.status === "cancelled" && b.statusWords === "Cancelled (overdue)", "after cancelling: no more monthly invoices and no renewal at the year end; shows 'Cancelled (overdue)' while June is unpaid", b.statusWords);
    for (const i of b.invoices.filter((x) => x.status === "open")) await req(`/api/owner/invoices/${i.id}/paid`, { method: "POST", token: owner, body: { paid: true } });
    b = await bill(bid);
    check(b.status === "ended" && b.paidCents === 3000000 && b.owedCents === 0, "once everything is paid after the year ends: Ended, $30,000 paid in total");
    // Owner tools and the customer's billing page.
    const sent = await req(`/api/owner/invoices/${(await bill(aid)).invoices[0].id}/send`, { method: "POST", token: owner });
    check(sent.status === 200 && sent.data.sent === 1, "'Send invoice' emails it again");
    const opdf = await fetch(`${w.base}/api/owner/invoices/${(await bill(aid)).invoices[0].id}/pdf`, { headers: { Authorization: `Bearer ${owner}` } });
    check(opdf.status === 200 && opdf.headers.get("content-type") === "application/pdf" && /draxly-invoice-DRX-2027-0002\.pdf/.test(opdf.headers.get("content-disposition")), "owner can download any invoice PDF");
    const cb = await req("/api/billing", { token: adminA });
    check(cb.status === 200 && cb.data.billing.agreement.plan === "Draxly Enterprise" && cb.data.billing.invoices.length === 2 && cb.data.billing.nextPayment?.amountCents === 3000000 && /ACH/.test(cb.data.instructions), "customer admin's billing page: plan, invoices, next payment, how to pay");
    check((await req("/api/billing", { token: mgr })).status === 403, "managers don't see billing (admins only)");
    const myPdf = await fetch(`${w.base}/api/billing/invoices/${cb.data.billing.invoices[0].id}/pdf`, { headers: { Authorization: `Bearer ${adminA}` } });
    const otherPdf = await fetch(`${w.base}/api/billing/invoices/${cb.data.billing.invoices[0].id}/pdf`, { headers: { Authorization: `Bearer ${B.data.token}` } });
    check(myPdf.status === 200 && otherPdf.status === 404, "a company can download its own invoice PDFs, not another company's");
    fs.writeFileSync(path.join(OUT, "draxly-invoice-sample.pdf"), Buffer.from(await myPdf.arrayBuffer()));
    const olog = (await req("/api/owner/log", { token: owner })).data.events.map((e) => e.action);
    check(["agreement started", "invoice emailed", "overdue reminder emailed", "invoice marked paid", "agreement renewed", "agreement cancelled"].every((x) => olog.includes(x)), "billing events are in the owner's log");
    await req("/api/owner/switch", { method: "POST", token: owner, body: { id: aid, account: false } });
    check((await req("/api/uploads", { token: adminA })).status === 401, "switching a company's access off locks them out straight away");
    await req("/api/owner/switch", { method: "POST", token: owner, body: { id: aid, account: true } });
    const adminA2 = (await req("/api/login", { method: "POST", body: { email: "cfo@cascade.test", password: "admin-pass-1" } })).data.token; // switching off ended every session
    check(Boolean(adminA2), "switched back on: they can sign in again");

    // ── The demo ───────────────────────────────────────────────────────────────────────────────────────────
    const d1 = await req("/api/demo/session", { method: "POST", body: { referrer: "https://www.linkedin.com/feed/", source: "source=linkedin" }, headers: { "User-Agent": "Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) Safari/604.1" } });
    check(d1.status === 200 && d1.data.token && d1.data.me.demo && d1.data.me.role === "viewer" && d1.data.bookingUrl === "https://cal.example.com/draxly/intro", "opening the demo needs no sign-up: a read-only demo session");
    const dt = d1.data.token, du = d1.data.upload;
    const ready = await until(async () => { const u = (await req(`/api/uploads/${du}`, { token: dt })).data.upload; return u?.status === "ready" && u.forecast?.ok ? u : null; }, 120000, 1000);
    check(ready && ready.products === 12 && ready.locations === 3 && ready.regions === 2 && ready.months === 36 && ready.backtest.ok && ready.backtest.accuracy > 80, "demo data: a food and drink distributor — 12 products, 3 distribution centres, 2 regions, 36 months; accuracy test ready", ready ? `${ready.backtest.accuracy}% accurate` : "not ready");
    check(ready?.forecast.products.some((p) => p.name === "Hot Cocoa Mix 12-pack") && ready.forecast.summary.length >= 4, "demo 3-month forecast with product table and summary");
    const ro = await until(async () => { const r = (await req("/api/reorder", { token: dt })).data; return r.ok && !r.pending ? r : null; }, 60000, 1000);
    check(ro && ro.items.find((x) => x.product === "Cold Brew Coffee 4-pack" && x.location === "Seattle DC")?.status === "out" && ro.counts.low + ro.counts.out >= 3, "demo reorder alerts: Cold Brew out of stock in Seattle, several items to reorder", ro ? `${ro.counts.out} out, ${ro.counts.low} low` : "");
    const blocked = await Promise.all([
      req("/api/uploads", { method: "POST", token: dt, body: { name: "x", months: ["2026-01"], series: [{ product: "p", amount: [1] }] } }),
      req(`/api/uploads/${du}`, { method: "DELETE", token: dt }), req(`/api/uploads/${du}/forecast`, { method: "POST", token: dt }),
      req("/api/stock", { method: "POST", token: dt, body: { items: [{ product: "x", onHand: 1 }] } }), req("/api/prefs", { method: "POST", token: dt, body: { reports: false } }),
      req("/api/team", { token: dt }), req("/api/billing", { token: dt }), req("/api/audit", { token: dt }), req("/api/settings", { token: dt }), req("/api/password", { method: "POST", token: dt, body: { current: "x", password: "yyyyyyyy" } }),
    ]);
    check(blocked.every((r) => r.status === 403 && r.data.demo), "demo visitors can't change or save anything (uploads, deleting, forecasts, stock, settings, team, billing, activity log, password)", blocked.map((r) => r.status).join(" "));
    const d2 = await req("/api/demo/session", { method: "POST", body: {} });
    check(d2.data.upload === du, "every visitor sees the same demo (it isn't set up again)");
    const cust = (await req("/api/owner/customers", { token: owner })).data;
    check(!cust.customers.some((c) => /Harbor & Vine/.test(c.company)) && cust.totals.customers === 2, "the demo company never appears in your customer list or totals");
    // Request access
    check((await req("/api/demo/request", { method: "POST", body: { name: "", email: "x@y.test", company: "Y" } })).status === 400, "the request form needs a name, company and a valid email");
    const nA = alerts.length;
    await req("/api/demo/request", { method: "POST", body: { name: "Robot", email: "bot@spam.test", company: "Spam", website: "http://spam" } });
    const n1 = mails.length;
    const rq = await req("/api/demo/request", { method: "POST", body: { name: "Dana Reyes", email: "dana@northwindfoods.test", company: "Northwind Foods", title: "VP Supply Chain", phone: "+1 206 555 0100", locations: "21–100", message: "We run 40 stores.", wantsCall: true, visit: d1.data.visit } });
    await until(async () => alerts.length > nA, 5000);
    const al = alerts.slice(nA), ml = mails.slice(n1);
    check(rq.status === 200 && al.length === 1 && /Dana Reyes \(Northwind Foods\)/.test(al[0].message) && /Wants a call/.test(al[0].message) && al[0].click.endsWith("/owner"), "a request alerts your phone with the name, company and email (the robot-filled one is ignored)", al[0]?.message.split("\n")[0]);
    check(ml.length === 1 && ml[0].to[0] === "owner@draxly.test" && /Draxly access request: Dana Reyes/.test(ml[0].subject) && /VP Supply Chain/.test(ml[0].html), "…and emails you the details", ml[0]?.subject);
    const ds = (await req("/api/owner/demo", { token: owner })).data;
    const dana = ds.leads.find((l) => l.email === "dana@northwindfoods.test");
    const v1 = ds.visits.find((v) => v.id === d1.data.visit);
    check(ds.counts.visitsAll >= 2 && v1.device === "iPhone · Safari" && /linkedin/.test(v1.referrer + v1.source) && v1.lead === dana.id && dana.wantsCall && dana.alerted === 1 && dana.emailed === 1 && !ds.leads.some((l) => l.email === "bot@spam.test"),
      "owner dashboard: who opened the demo (device, where they came from) and who requested access, linked together");
    await req(`/api/owner/leads/${dana.id}`, { method: "POST", token: owner, body: { status: "contacted" } });
    check((await req("/api/owner/demo", { token: owner })).data.leads.find((l) => l.id === dana.id).status === "contacted", "a request can be marked contacted");

    // ── In a browser, phone size ───────────────────────────────────────────────────────────────────────────
    const ctx = await browser.newContext({ viewport: { width: 390, height: 844 }, deviceScaleFactor: 2, isMobile: true, hasTouch: true, acceptDownloads: true });
    const P = await ctx.newPage();
    P.on("pageerror", (e) => errors.push(e.message));
    P.on("console", (m) => { if (m.type() === "error" && !/status of (40[0-9]|429)/.test(m.text())) errors.push("console: " + m.text()); });
    await P.goto(w.base + "/demo");
    await P.waitForSelector("#fc:not([hidden])", { timeout: 60000 });
    check(await P.isVisible("#demo-bar") && /Harbor & Vine/.test(await P.textContent("#demo-bar")) && /%/.test(await P.textContent("#bt-acc")) && (await P.locator("#fc-table tbody tr").count()) >= 13 && await P.isVisible("#fc-chart svg[role=img]"),
      "the demo page opens straight onto the accuracy test, forecast chart and product table, with the demo bar");
    check(!(await P.isVisible("#upload-card")) && !(await P.isVisible("#r-delete")) && !(await P.isVisible('#nav a[data-nav="team"]')) && !(await P.isVisible("#signout")) && await P.isVisible('#nav a[data-nav="stock"]'), "nothing to change: no upload, delete, team or sign-out; Forecasts and Stock to look at");
    await P.screenshot({ path: path.join(OUT, "draxly-1-demo-phone.png"), fullPage: true });
    const [dl] = await Promise.all([P.waitForEvent("download"), P.click("#fc-csv")]);
    check(/^draxly-forecast-/.test(dl.suggestedFilename()), "the forecast CSV downloads as draxly-forecast-….csv", dl.suggestedFilename());
    await P.click('#nav a[data-nav="stock"]');
    await P.waitForSelector("#ro-table tbody tr");
    check(/Out of stock/.test(await P.textContent("#ro-table")) && /Cold Brew Coffee/.test(await P.textContent("#ro-table")), "the demo's Stock page shows the reorder alerts");
    await P.screenshot({ path: path.join(OUT, "draxly-2-demo-stock-phone.png"), fullPage: true });
    await P.evaluate(() => { window.__opened = []; window.open = (u) => { window.__opened.push(u); return null; }; }); // the booking site itself isn't reachable from here
    await P.click("#demo-call");
    check((await P.evaluate(() => window.__opened))[0] === "https://cal.example.com/draxly/intro", "'Book a call' opens your booking link (in a new tab)");
    await P.click("#demo-request");
    await P.waitForSelector("#request:not([hidden])");
    await P.fill("#rq-name", "Sam Patel"); await P.fill("#rq-email", "sam@freshco.test"); await P.fill("#rq-company", "FreshCo Distributors"); await P.selectOption("#rq-locations", "6–20");
    await P.click("#rq-submit");
    await P.waitForSelector("#rq-ok:not([hidden])");
    check(/Thanks, Sam/.test(await P.textContent("#rq-ok")) && (await req("/api/owner/demo", { token: owner })).data.leads.some((l) => l.email === "sam@freshco.test"), "'Request access' from the page: thank-you message, and it's on your dashboard");
    await P.screenshot({ path: path.join(OUT, "draxly-3-request-phone.png") });
    // Customer billing page and owner billing box.
    const C2 = await ctx.newPage();
    C2.on("pageerror", (e) => errors.push("billing: " + e.message));
    await C2.goto(w.base + "/");
    await C2.evaluate((t) => localStorage.setItem("forecast.token", t), adminA2);
    await C2.goto(w.base + "/#/billing"); await C2.reload();
    await C2.waitForSelector("#bl-table tbody tr");
    check(/Draxly Enterprise/.test(await C2.textContent("#bl-plan")) && /January 15, 2027 – January 14, 2028/.test(await C2.textContent("#bl-plan")) && /Renews\s*January 15, 2028/.test(await C2.textContent("#bl-plan")) && (await C2.locator("#bl-table tbody tr").count()) === 2 && /\$30,000\.00/.test(await C2.textContent("#bl-next")), "customer billing page: plan, renewal date, invoices and next payment");
    const [ipdf] = await Promise.all([C2.waitForEvent("download"), C2.locator(".bl-pdf").first().click()]);
    check(/^draxly-invoice-DRX-2027-0002\.pdf$/.test(ipdf.suggestedFilename()), "invoice PDF download from the billing page", ipdf.suggestedFilename());
    await C2.screenshot({ path: path.join(OUT, "draxly-4-billing-phone.png"), fullPage: true });
    const O = await ctx.newPage();
    O.on("pageerror", (e) => errors.push("owner: " + e.message));
    await O.goto(w.base + "/owner");
    await O.evaluate((t) => sessionStorage.setItem("forecast.owner", t), owner);
    await O.reload();
    await O.waitForSelector(".billing-box");
    const ca = O.locator(".cust", { hasText: "Cascade Grocers" }), cpp = O.locator(".cust", { hasText: "Pacific Pantry" });
    check(/Overdue/.test(await ca.locator(".billing-box .cust-head").textContent()) && /Ended/.test(await cpp.locator(".billing-box").textContent()) && /Renews: Jan 15, 2028/.test(await ca.locator(".billing-box").textContent()),
      "owner dashboard shows each company's plan, renewal and status", (await ca.locator(".cust-head").first().textContent()).replace(/\s+/g, " "));
    O.once("dialog", (d) => d.accept(""));
    await ca.locator(".inv-paid").first().click();
    await O.waitForFunction(() => /Paid up/.test([...document.querySelectorAll(".cust")].find((c) => /Cascade/.test(c.textContent)).querySelector(".billing-box").textContent));
    check(true, "'Mark paid' on the dashboard turns the company Paid up");
    check(/Northwind Foods/.test(await O.textContent("#dm-leads")) && /iPhone · Safari/.test(await O.textContent("#dm-visits")), "owner dashboard's demo card lists requests and visits");
    await O.screenshot({ path: path.join(OUT, "draxly-5-owner-phone.png"), fullPage: true });
    check(errors.length === 0, "no page errors", errors.join(" | "));
    await ctx.close();
    let last; for (let i = 0; i < 6; i++) last = await req("/api/demo/request", { method: "POST", body: { name: `Flood ${i}`, email: `f${i}@x.test`, company: "F" } });
    check(last.status === 429, "too many requests from one place are slowed down");
  } finally {
    await browser.close();
    await w.stop();
    mailer.close(); ntfy.close();
    if (failures()) console.log(w.log.join("").slice(-3000));
    fs.rmSync(stateDir, { recursive: true, force: true });
  }
  console.log(failures() ? `\n${failures()} check(s) failed` : "\nAll Draxly checks passed");
  process.exit(failures() ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
