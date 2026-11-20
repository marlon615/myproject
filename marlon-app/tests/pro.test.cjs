/**
 * Marlon Pro, end to end, with the real Worker (wrangler dev, local SQLite), the real app at iPhone size and a stand-in
 * for Google's Gemini API (so nothing leaves this machine):
 *   - the maker's console: switching Pro on asks how many reps; $25 per rep per month minus the automatic team discount
 *     for that many reps (one table with plain Marlon), minus a special deal % on top; the total updates as the reps
 *     change; "Pro each month"; a company without Pro sees no Pro features and the server refuses Pro requests;
 *   - Return → credit note: products, quantities, reasons, the store signs, CN-0001…; PDF; the credit comes off the
 *     store's next invoice automatically (capped at the invoice, the rest carries over); every receipt, QR page and
 *     signing link shows it; a signed invoice keeps its credit; deleting an invoice gives the credit back; offline;
 *   - accountant summary (by quarter and for the year, CSV + print) and returns, in the solo dashboard and the boss's;
 *   - team: a rep's credit notes reach the boss: returns by store, by product and by rep;
 *   - shelf photo: shrunk on the phone, the company's products only (an invented one is dropped), queued offline,
 *     Google's free limit, the 100-a-day company limit, no key;
 *   - Pro switched off reaches the phone; credit notes already given still count;
 *   - the Terms page with its Marlon Pro section.
 * Nothing here touches the live site.
 */
const { spawn, spawnSync } = require("child_process");
const fs = require("fs"), os = require("os"), path = require("path"), http = require("http"), crypto = require("crypto");
const { chromium } = require("playwright");
const { setUp, BUSINESS } = require("./fixture.cjs");

const PORT = 8811, BASE = `http://localhost:${PORT}`, GPORT = 8812;
const APP = path.join(__dirname, ".."), OUT = path.join(__dirname, "output");
const WRANGLER = path.join(APP, "..", "chief-of-staff", "node_modules", ".bin", "wrangler");
const ENC = crypto.randomBytes(32).toString("base64");
let failures = 0;
const check = (ok, name, extra = "") => { console.log(`${ok ? "PASS" : "FAIL"}  ${name}${extra ? "  — " + extra : ""}`); if (!ok) failures++; };
const PHONE = { viewport: { width: 390, height: 844 }, deviceScaleFactor: 2, isMobile: true, hasTouch: true };
const post = (p, body, token) => fetch(BASE + p, { method: "POST", headers: { "content-type": "application/json", ...(token ? { Authorization: `Bearer ${token}` } : {}) }, body: JSON.stringify(body) });
const row = (page, name) => page.locator(".prod-row", { hasText: name }).first();
const today = (() => { const d = new Date(); return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`; })();
// (Playwright runs these functions in the page itself; each one imports the app's storage module.)

// ── A stand-in for Google's Gemini API ─────────────────────────────────────────────────────────────────────────
const gemini = { mode: "ok", calls: [] };
function startGemini() {
  const srv = http.createServer((req, res) => {
    let raw = "";
    req.on("data", (c) => { raw += c; });
    req.on("end", () => {
      let body = {}; try { body = JSON.parse(raw); } catch { /* */ }
      const parts = body.contents?.[0]?.parts || [];
      gemini.calls.push({ path: req.url, key: req.headers["x-goog-api-key"], prompt: parts.find((p) => p.text)?.text || "", image: parts.find((p) => p.inline_data)?.inline_data || null, schema: body.generationConfig?.responseSchema || null });
      const send = (status, obj) => { res.writeHead(status, { "content-type": "application/json" }); res.end(JSON.stringify(obj)); };
      if (gemini.mode === "limit") return send(429, { error: { code: 429, message: "You exceeded your current quota.", status: "RESOURCE_EXHAUSTED" } });
      if (/gemini-flash-lite-latest/.test(req.url) && gemini.mode === "retired") return send(404, { error: { code: 404, message: "This model is no longer available to new users." } });
      const answer = { products: [{ name: "Mango Juice", count: 6 }, { name: "Imaginary Soda", count: 3 }, { name: "eggs", count: 2 }] };
      send(200, { candidates: [{ content: { parts: [{ text: JSON.stringify(answer) }] } }] });
    });
  });
  return new Promise((ok) => srv.listen(GPORT, () => ok(srv)));
}

function startWorker(stateDir) {
  const log = [];
  const vars = { ALLOW_TEST_CLOCK: "1", GEMINI_BASE: `http://localhost:${GPORT}`, GEMINI_API_KEY: "test-gemini-key", ENCRYPTION_KEY: ENC };
  const child = spawn(WRANGLER, ["dev", "--port", String(PORT), "--persist-to", stateDir, "--show-interactive-dev-session=false", "--log-level", "warn",
    ...Object.entries(vars).flatMap(([k, v]) => ["--var", `${k}:${v}`])], {
    cwd: APP, env: { ...process.env, WRANGLER_SEND_METRICS: "false", CLOUDFLARE_API_TOKEN: "placeholder-not-used-locally" }, stdio: ["ignore", "pipe", "pipe"],
  });
  child.stdout.on("data", (d) => log.push(String(d)));
  child.stderr.on("data", (d) => log.push(String(d)));
  const ready = (async () => {
    for (let i = 0; i < 120; i++) {
      try { const r = await fetch(`${BASE}/api/console/state`); if (r.status) return; } catch { /* not yet */ }
      await new Promise((ok) => setTimeout(ok, 500));
    }
    throw new Error(`wrangler dev didn't start:\n${log.join("")}`);
  })();
  return { ready, log, stop: () => new Promise((ok) => { child.once("exit", ok); child.kill("SIGTERM"); setTimeout(() => { child.kill("SIGKILL"); ok(); }, 5000); }) };
}

async function makeInvoice(page, store, lines) {
  await page.click("#new-btn").catch(() => {});
  await page.waitForTimeout(250);
  if (await page.locator("dialog.pay .pay-skip").count()) { await page.click("dialog.pay .pay-skip"); await page.waitForTimeout(250); }
  await page.evaluate(() => window.scrollTo(0, 0));
  await page.fill("#store", store);
  for (const [name, qty, price] of lines) {
    await row(page, name).locator(".prod-check").click();
    await row(page, name).locator(".qty-input").fill(String(qty));
    if (price !== undefined) await row(page, name).locator(".price-input").fill(String(price));
  }
  await page.waitForTimeout(1100); // autosave (and the credit check)
}
async function signOn(page, selector) {
  await page.locator(selector).scrollIntoViewIfNeeded();
  const b = await page.locator(selector).boundingBox();
  await page.mouse.move(b.x + 30, b.y + b.height * 0.6);
  await page.mouse.down();
  for (let i = 1; i <= 16; i++) await page.mouse.move(b.x + 30 + i * 14, b.y + b.height * 0.6 - Math.sin(i / 2) * 30);
  await page.mouse.up();
}
/** Logs a return in the Return screen: lines = [[product, qty, reason]]. Returns the credit note number shown. */
async function logReturn(page, store, lines, { signer = "" } = {}) {
  await page.click("#pro-return");
  await page.waitForSelector("dialog.pro-return[open]");
  await page.fill("#ret-store", store);
  for (let i = 0; i < lines.length; i++) {
    if (i > 0) await page.click("#ret-add");
    const li = page.locator(".ret-line").nth(i);
    await li.locator(".ret-product").selectOption({ label: lines[i][0] });
    await li.locator(".ret-qty").fill(String(lines[i][1]));
    if (lines[i][2] === "damaged") await li.locator('.ret-chip[data-reason="damaged"]').click();
  }
  if (signer) await page.fill("#ret-signer", signer);
  await signOn(page, "#ret-sign");
  await page.waitForFunction(() => !document.getElementById("ret-create").disabled, null, { timeout: 4000 });
  await page.click("#ret-create");
  await page.waitForSelector("dialog.pro-return.is-done");
  return page.textContent("dialog.pro-return h2");
}
async function openDashboard(page, create) {
  await page.click("#owner-link");
  await page.waitForSelector(".dash-key");
  const pin = async () => { for (const d of "1357") await page.locator(`.dash-key[aria-label="${d}"]`).click(); };
  await pin();
  if (create) { await page.getByRole("button", { name: "Continue" }).click(); await page.waitForSelector("text=Enter the same PIN again"); await pin(); }
  await page.waitForSelector(".dash-kpi", { timeout: 8000 });
}
/** A real JPEG of a "shelf", made in the browser, as an upload. */
async function shelfJpeg(page) {
  const b64 = await page.evaluate(() => {
    const c = document.createElement("canvas"); c.width = 2400; c.height = 1600;
    const x = c.getContext("2d"); x.fillStyle = "#c9b48a"; x.fillRect(0, 0, 2400, 1600);
    for (let i = 0; i < 12; i++) { x.fillStyle = i % 2 ? "#f2a31b" : "#3a7d44"; x.fillRect(80 + i * 190, 300, 150, 600); }
    return c.toDataURL("image/jpeg", 0.92).split(",")[1];
  });
  return { name: "shelf.jpg", mimeType: "image/jpeg", buffer: Buffer.from(b64, "base64") };
}

(async () => {
  fs.mkdirSync(OUT, { recursive: true });
  const build = spawnSync(process.execPath, [path.join(APP, "scripts", "build-worker.cjs")], { cwd: APP, encoding: "utf8" });
  check(build.status === 0, "the app packs into the Worker");
  const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), "marlon-pro-"));
  const gsrv = await startGemini();
  const w = startWorker(stateDir);
  const browser = await chromium.launch();
  const errors = [];
  const watch = (page, who) => page.on("pageerror", (e) => { errors.push(`${who}: ${e.message}`); console.log(`PAGE ERROR (${who}): ${e.message}`); });
  try {
    await w.ready;
    const token = (await (await post("/api/console/claim", { passcode: "pro-test-passcode" })).json()).token;
    const buyers = async () => (await (await fetch(`${BASE}/api/console/buyers`, { headers: { Authorization: `Bearer ${token}` } })).json());
    const solo = (await (await post("/api/console/buyers", { name: "Island Fresh Distributors", devices: 2, amount: 120 }, token)).json());
    const plain = (await (await post("/api/console/buyers", { name: "No Pro Shop", devices: 1, amount: 60 }, token)).json());
    const team = (await (await post("/api/console/buyers", { name: "Coastline Foods", devices: 3, amount: 900, kind: "team" }, token)).json());

    // ── Console: Pro on/off and the discount ──────────────────────────────────────────────────────────────────
    let list = await buyers();
    check(list.buyers.every((b) => b.pro === false) && list.proMonthlyCents === 0, "a new company starts without Pro");
    // One table of team discounts for plain Marlon and Marlon Pro.
    const pricing = await import(path.join(APP, "public", "js", "pricing.js"));
    const edges = [[1, 0], [4, 0], [5, 10], [9, 10], [10, 15], [24, 15], [25, 20], [49, 20], [50, 25], [99, 25], [100, 30], [101, 30], [5000, 30]];
    check(edges.every(([n, pct]) => pricing.tierFor(n).pct === pct), "team discount tiers: 1–4 reps 0%, 5–9 10%, 10–24 15%, 25–49 20%, 50–99 25%, 100+ 30% (every edge checked)",
      edges.map(([n]) => `${n}:${pricing.tierFor(n).pct}%`).join(" "));
    const p7 = pricing.proPrice(7, 5);
    check(p7.grossCents === 17500 && p7.tierCents === 1750 && p7.extraCents === 788 && p7.netCents === 14962 && pricing.proPrice(100, 100).netCents === 0,
      "a special deal comes off after the team discount (7 reps: $175.00 − 10% = $157.50 − 5% = $149.62), so the two never pass 100%");
    const bad = await post("/api/console/pro", { id: solo.buyer.id, pro: true, reps: 1, discountPct: 150 }, token);
    check(bad.status === 400, "a special deal over 100 % is refused", `HTTP ${bad.status}`);
    const noReps = await post("/api/console/pro", { id: solo.buyer.id, pro: true, discountPct: 0 }, token);
    check(noReps.status === 400 && /how many reps/.test((await noReps.json()).error), "Pro can't be switched on without saying how many reps", `HTTP ${noReps.status}`);
    const badReps = await post("/api/console/pro", { id: solo.buyer.id, pro: true, reps: 2.5, discountPct: 0 }, token);
    check(badReps.status === 400, "the number of reps must be a whole number, 1 or more", `HTTP ${badReps.status}`);
    const noAuth = await post("/api/console/pro", { id: solo.buyer.id, pro: true, reps: 1, discountPct: 0 });
    check(noAuth.status === 401, "only the maker's console can switch Pro on", `HTTP ${noAuth.status}`);
    const sp = await (await post("/api/console/pro", { id: solo.buyer.id, pro: true, reps: 1, discountPct: 10 }, token)).json();
    const tp = await (await post("/api/console/pro", { id: team.buyer.id, pro: true, reps: 3, discountPct: 0 }, token)).json();
    check(sp.buyer.pro && sp.buyer.discountPct === 10 && sp.buyer.proMonthlyCents === 2250 && tp.buyer.proMonthlyCents === 7500 && tp.buyer.proTierPct === 0,
      "price: solo (1 rep) with a 10% special deal = $22.50; a 3-rep team (no team discount under 5 reps) = $75.00", `${sp.buyer.proMonthlyCents} / ${tp.buyer.proMonthlyCents}`);
    list = await buyers();
    check(list.proMonthlyCents === 9750, "'Pro each month' adds up every company with Pro on ($97.50)", String(list.proMonthlyCents));

    const con = await (await browser.newContext({ ...PHONE })).newPage();
    watch(con, "console");
    await con.goto(`${BASE}/console`);
    await con.evaluate((t) => sessionStorage.setItem("marlon.console", t), token);
    await con.reload();
    await con.waitForSelector(".con-pro");
    check(/Pro each month/.test(await con.locator(".con-tiles").nth(1).textContent()) && /\$97\.50/.test(await con.locator(".con-tiles").nth(1).textContent()), "the console shows 'Pro each month' ($97.50)");
    const tierRows = await con.locator(".con-tier-table tr").allTextContents();
    check(tierRows.length === 6 && /1–4 reps\s*No discount/.test(tierRows[0]) && /100\+ reps\s*30% off/.test(tierRows[5]), "the console shows the team discount table (used by Marlon and Marlon Pro)", tierRows.join(" | "));
    // Switch Pro on for a company: it asks how many reps, applies their team discount and shows the total.
    const plainCard = con.locator(".con-buyer", { hasText: "No Pro Shop" });
    check(await plainCard.locator('.con-pro[data-pro="off"]').count() === 1 && /asks how many reps/.test(await plainCard.locator(".con-pro").textContent()), "a company without Pro shows 'Switch Pro on'");
    const asked = [];
    const onDialog = async (d) => { asked.push(`${d.type()}: ${d.message()}`); if (d.type() === "prompt") await d.accept("7"); else await d.accept(); };
    con.on("dialog", onDialog);
    await plainCard.locator(".con-pro-toggle").click();
    await con.waitForSelector('.con-buyer:has-text("No Pro Shop") .con-pro[data-pro="on"]');
    con.off("dialog", onDialog);
    const card7 = con.locator(".con-buyer", { hasText: "No Pro Shop" });
    const lines7 = (await card7.locator(".con-pro-lines").textContent()).replace(/\s+/g, " ");
    check(/^prompt: How many reps does No Pro Shop have\?/.test(asked[0] || "") && /Team discount 10% \(5–9 reps\): −\$17\.50/.test(asked[1] || "") && /Monthly total: \$157\.50/.test(asked[1] || ""),
      "Switch Pro on first asks how many reps, then shows the discounted monthly total before confirming", asked.map((x) => x.split("\n")[0]).join(" | "));
    check(/7 reps × \$25\.00 ?\$175\.00/.test(lines7), "the card shows 7 reps × $25.00 = $175.00", lines7);
    check(/Team discount 10% \(5–9 reps\)/.test(lines7) && /\$157\.50/.test(await card7.locator(".con-pro-price").textContent()), "…the automatic 10% team discount for 5–9 reps, and the monthly total $157.50");
    await card7.locator(".con-pro-reps").fill("25");
    check(/Team discount 20% \(25–49 reps\)/.test(await card7.locator(".con-pro-lines").textContent()) && /\$500\.00/.test(await card7.locator(".con-pro-price").textContent()) && await card7.locator(".con-pro-save").isVisible(),
      "changing the reps to 25 updates the discount (20%) and the total ($625.00 → $500.00) straight away", await card7.locator(".con-pro-price").textContent());
    await card7.locator(".con-pro-discount").fill("10");
    check(/Special deal 10% \(on top\)/.test(await card7.locator(".con-pro-lines").textContent()) && /\$450\.00/.test(await card7.locator(".con-pro-price").textContent()),
      "a special deal % comes off on top of the team discount ($500.00 − 10% = $450.00)");
    await card7.locator(".con-pro-save").click();
    await con.waitForFunction(() => /\$450\.00/.test(document.querySelector('.con-buyer[data-id] .con-pro.is-on .con-pro-price')?.textContent || "") || [...document.querySelectorAll(".con-buyer")].some((c) => /No Pro Shop/.test(c.textContent) && /\$450\.00/.test(c.querySelector(".con-pro-price")?.textContent || "")), null, { timeout: 5000 });
    const saved25 = (await buyers()).buyers.find((b) => b.name === "No Pro Shop");
    check(saved25.proReps === 25 && saved25.proTierPct === 20 && saved25.discountPct === 10 && saved25.proMonthlyCents === 45000, "saved: 25 reps, 20% team discount, 10% special deal, $450.00 a month", JSON.stringify({ r: saved25.proReps, t: saved25.proTierPct, d: saved25.discountPct, c: saved25.proMonthlyCents }));
    await con.waitForTimeout(600); // the console redraws after saving
    await con.locator(".con-buyer", { hasText: "No Pro Shop" }).first().scrollIntoViewIfNeeded();
    await con.screenshot({ path: path.join(OUT, "pro-1b-console-tiers.png") });
    // Plain Marlon uses the same table: the new-team form shows the discount for that many reps.
    await con.locator(".con-kind", { hasText: "Team" }).click();
    await con.locator(".con-chips label", { hasText: "Another number" }).click();
    await con.fill("#con-devices-other", "12");
    check(/Team discount for 12 reps: 15% \(10–24 reps\)/.test(await con.textContent(".con-tier-hint")), "plain Marlon's new-team form shows the same team discount for that number of reps");
    await post("/api/console/pro", { id: plain.buyer.id, pro: false, discountPct: 0 }, token);
    await con.reload();
    await con.waitForSelector(".con-pro");
    await con.locator(".con-buyer", { hasText: "Island Fresh Distributors" }).scrollIntoViewIfNeeded();
    await con.screenshot({ path: path.join(OUT, "pro-1-console.png") });

    // ── A company without Pro: nothing Pro shows, and the server refuses Pro requests ─────────────────────────────
    const ctxN = await browser.newContext({ ...PHONE });
    const N = await ctxN.newPage();
    watch(N, "no-pro phone");
    await N.goto(`${BASE}/?k=${plain.buyer.id}`);
    await setUp(N);
    await N.waitForTimeout(500);
    check(await N.locator("#pro-bar").isHidden() && await N.locator("#pro-return").count() === 0, "a company without Pro: no Return or Shelf photo buttons");
    const nLic = await N.evaluate(async () => (await import("/js/db.js")).settings.get("license"));
    const nShelf = await post("/api/pro/shelf", { key: nLic.key, device: nLic.device, image: "A".repeat(200), mime: "image/jpeg", products: ["Mango Juice"] });
    check(nShelf.status === 403 && /part of Marlon Pro/.test((await nShelf.json()).error), "…and the server refuses a shelf photo from it", `HTTP ${nShelf.status}`);

    // ── Solo Pro phone ──────────────────────────────────────────────────────────────────────────────────────────
    const ctxS = await browser.newContext({ ...PHONE, acceptDownloads: true });
    const S = await ctxS.newPage();
    watch(S, "solo phone");
    await S.goto(`${BASE}/?k=${solo.buyer.id}`);
    await setUp(S);
    await S.waitForSelector("#pro-return");
    check(await S.locator("#pro-bar .pro-tag").textContent() === "Pro" && await S.locator("#pro-shelf").isVisible(), "a Pro company: Return and Shelf photo show under 'Speak the invoice'");
    await S.screenshot({ path: path.join(OUT, "pro-2-invoice-screen.png") });

    await makeInvoice(S, "Hill Top Grocery", [["Mango Juice", 4]]);
    check((await S.textContent("#grand-amount")).trim() === "$1,000.00" && await S.locator("#credit-rows").isHidden(), "before any return: the invoice is $1,000.00 with no credit line");

    const cn1 = await logReturn(S, "Hill Top Grocery", [["Mango Juice", 2, "expired"], ["Eggs", 1, "damaged"]], { signer: "Marcia" });
    const done1 = await S.textContent("dialog.pro-return .pro-lead");
    check(cn1.trim() === "Credit note CN-0001" && /\$980\.00 comes off Hill Top Grocery's next invoice automatically/.test(done1),
      "Return: 2 Mango Juice (expired) + 1 dozen Eggs (damaged), the store signs → credit note CN-0001 for $980.00", `${cn1} · ${done1}`);
    check(/Expired/.test(await S.textContent(".cn-card")) && /Damaged/.test(await S.textContent(".cn-card")) && await S.locator(".cn-sig img").count() === 1 && /by Marcia/.test(await S.textContent(".cn-sig")),
      "the credit note lists each product with its reason and shows the store's signature");
    await S.screenshot({ path: path.join(OUT, "pro-3-credit-note.png") });
    const [pdf] = await Promise.all([S.waitForEvent("download"), S.click("#cn-pdf")]);
    const pdfBytes = fs.readFileSync(await pdf.path());
    check(pdf.suggestedFilename() === "credit-note-CN-0001.pdf" && pdfBytes.subarray(0, 5).toString() === "%PDF-" && pdfBytes.length > 20000, "Share PDF makes a real one-page PDF of the credit note", `${pdf.suggestedFilename()} · ${pdfBytes.length} bytes`);
    await S.click("#cn-done");

    // The next invoice for that store: the credit comes off by itself (never more than the invoice).
    await makeInvoice(S, "Hill Top Grocery", [["Mango Juice", 2]]);
    const credRows = await S.textContent("#credit-rows");
    check(!await S.locator("#credit-rows").isHidden() && /Subtotal\$500\.00/.test(credRows.replace(/\s+/g, "")) && /Credit note CN-0001/.test(credRows) && /-\$500\.00/.test(credRows) && (await S.textContent("#grand-amount")).trim() === "$0.00",
      "the store's next invoice: the credit comes off automatically, capped at the invoice ($500.00 off a $500.00 invoice)", credRows.replace(/\s+/g, " "));
    await S.screenshot({ path: path.join(OUT, "pro-4-credit-on-invoice.png") });
    await makeInvoice(S, "Hill Top Grocery", [["Coconut Water", 10]]);
    check((await S.textContent("#grand-amount")).trim() === "$1,320.00" && /-\$480\.00/.test(await S.textContent("#credit-rows")), "…and what's left ($480.00) comes off the invoice after that: $1,800.00 → $1,320.00");
    await makeInvoice(S, "Bay Market", [["Ginger Beer", 2]]);
    check(await S.locator("#credit-rows").isHidden() && (await S.textContent("#grand-amount")).trim() === "$300.00", "another store's invoice gets no credit");
    const cnState = await S.evaluate(async () => { const db = await import("/js/db.js"); const [cn] = await db.credits.all(); return { left: db.credits.left(cn), uses: Object.values(cn.appliedTo).map((a) => a.amount).sort((a, b) => a - b) }; });
    check(cnState.left === 0 && JSON.stringify(cnState.uses) === "[480,500]", "the credit note records exactly which invoices used it ($500 + $480 = $980, nothing left)", JSON.stringify(cnState));

    // Every copy of the invoice shows the credit: receipt, QR page (link and text), PDF.
    const inv3 = await S.evaluate(async () => (await (await import("/js/db.js")).invoices.all()).find((i) => i.items[0]?.name === "Coconut Water"));
    check(inv3.subtotal === 1800 && inv3.credit.amount === 480 && inv3.total === 1320, "the saved invoice: subtotal $1,800, credit $480, total $1,320", JSON.stringify({ s: inv3.subtotal, c: inv3.credit?.amount, t: inv3.total }));
    const copies = await S.evaluate(async (inv) => {
      const { receiptModel } = await import("/js/receipt.js"); const codec = await import("/js/codec.js");
      return { receipt: receiptModel(inv), url: codec.invoiceToUrl(inv), text: codec.invoiceToText(inv) };
    }, inv3);
    check(copies.receipt.credit?.label === "Credit note CN-0001" && copies.receipt.credit.amountText === "-$480.00" && copies.receipt.totalText === "$1,320.00", "the printed receipt and PDF show 'Credit note CN-0001  -$480.00' above the total");
    check(/Credit note CN-0001: -\$480\.00\nTOTAL: \$1,320\.00/.test(copies.text), "the text-only QR shows the credit too");
    const V = await (await browser.newContext({ ...PHONE })).newPage();
    watch(V, "customer page");
    await V.goto(copies.url);
    await V.waitForSelector(".credit-lines");
    const vText = (await V.textContent(".sheet")).replace(/\s+/g, "");
    check(/Subtotal\$1,800\.00/.test(vText) && /CreditnoteCN-0001-\$480\.00/.test(vText) && /\$1,320\.00/.test(vText) && !/pleasecheckwith/.test(vText),
      "the customer's QR page shows subtotal, credit note and total (no 'doesn't add up' warning)");
    await V.screenshot({ path: path.join(OUT, "pro-5-customer-page.png"), fullPage: true });
    const plainUrl = await S.evaluate(async () => { const codec = await import("/js/codec.js"); return codec.invoiceToUrl({ seller: "S", number: 9, date: "2026-11-20", store: "X", items: [{ name: "A", qty: 1, price: 2 }] }); });
    check(plainUrl.split("#")[1].split("~").length === 10, "an invoice without a credit keeps exactly the same QR link as before (10 fields)");

    // A signing link carries the credit, worked out by the server.
    const lic = await S.evaluate(async () => (await import("/js/db.js")).settings.get("license"));
    const sent = await (await post("/api/sign/create", { key: lic.key, device: lic.device, invoice: { ...inv3, seller: "Island Fresh Distributors" } })).json();
    const viewed = await (await post("/api/sign/view", { token: sent.token })).json();
    check(viewed.invoice?.subtotal === 1800 && viewed.invoice.credit.amount === 480 && viewed.invoice.total === 1320, "Send for signature: the buyer's copy shows the same credit and total", JSON.stringify(viewed.invoice?.credit));
    const sg = await (await browser.newContext({ ...PHONE })).newPage();
    await sg.goto(`${BASE}/s/${sent.token}`);
    await sg.waitForSelector(".sg-credit");
    check(/Credit note CN-0001/.test(await sg.textContent(".sg-credit")) && /\$1,320\.00/.test(await sg.textContent(".sg-total")), "…and the buyer's signing page shows the credit line");
    await post("/api/sign/cancel", { key: lic.key, device: lic.device, invoiceId: inv3.id });

    // A signed invoice keeps its credit; deleting an invoice gives its credit back.
    const frozen = await S.evaluate(async () => {
      const db = await import("/js/db.js");
      const all = await db.invoices.all();
      const inv2 = all.find((i) => i.items[0]?.name === "Mango Juice" && i.items[0]?.qty === 2);
      await db.invoices.put({ ...inv2, signature: "data:image/png;base64,iVBORw0KGgo=" });
      await db.credits.create({ store: "Hill Top Grocery", date: new Date().toISOString().slice(0, 10), lines: [{ name: "Mango Juice", qty: 1, unit: "each", price: 250, reason: "expired" }], signature: "data:image/png;base64,iVBORw0KGgo=" });
      const again = await db.invoices.put({ ...(await db.invoices.get(inv2.id)), date: inv2.date });
      return { credit: again.credit.amount, notes: again.credit.notes.map((n) => n.number).join() };
    });
    check(frozen.credit === 500 && frozen.notes === "1", "a signed invoice keeps exactly the credit it had (a newer credit note doesn't change it)", JSON.stringify(frozen));
    const released = await S.evaluate(async (id) => { const db = await import("/js/db.js"); await db.invoices.remove(id); const cn1 = (await db.credits.all()).find((c) => c.number === 1); return db.credits.left(cn1); }, inv3.id);
    check(released === 480, "deleting an invoice gives its credit back to the credit note ($480.00 to come off again)", String(released));

    // Offline: a return works with no signal.
    await ctxS.setOffline(true);
    await S.evaluate(() => window.scrollTo(0, 0));
    const cn3 = await logReturn(S, "Bay Market", [["Ginger Beer", 3, "damaged"]]);
    check(cn3.trim() === "Credit note CN-0003", "offline: a return and its credit note still work (CN-0003)", cn3);
    await S.click("#cn-done");

    // Shelf photo, offline first: the photo waits on the phone.
    gemini.calls.length = 0;
    await S.click("#pro-shelf");
    await S.waitForSelector("dialog.pro-shelf[open]");
    await S.fill("#shelf-store", "Hill Top Grocery");
    await S.setInputFiles("#shelf-file", await shelfJpeg(S));
    await S.waitForSelector(".shelf-result.is-waiting");
    check(gemini.calls.length === 0 && /saved on this phone and will be checked/.test(await S.textContent(".shelf-out")), "offline: the shelf photo waits on the phone");
    await ctxS.setOffline(false);
    await S.evaluate(() => window.__pro.processShelfQueue());
    await S.waitForSelector(".shelf-past");
    const call = gemini.calls[0] || {};
    const imgBytes = Buffer.from(call.image?.data || "", "base64");
    check(gemini.calls.length === 1 && call.key === "test-gemini-key" && call.image?.mime_type === "image/jpeg" && imgBytes.length > 2000 && imgBytes.length < 400000 && /Mango Juice/.test(call.prompt) && /Never add a product/.test(call.prompt),
      "back online: the photo (shrunk on the phone) goes to Gemini once, with the company's product list", `${imgBytes.length} bytes sent (the original was a 2400×1600 photo)`);
    await S.locator(".shelf-past summary").first().click();
    const past = await S.textContent(".shelf-past");
    check(/Mango Juice/.test(past) && /× 6/.test(past) && /Eggs/.test(past) && /× 2/.test(past) && !/Imaginary Soda/.test(past) && /Not seen:/.test(past) && /Counted by AI/.test(past),
      "results: which of the company's products are there and how many (Mango Juice × 6, Eggs × 2); an invented product is dropped", past.replace(/\s+/g, " ").slice(0, 160));
    await S.setInputFiles("#shelf-file", await shelfJpeg(S));
    await S.waitForSelector(".shelf-out .shelf-found");
    await S.screenshot({ path: path.join(OUT, "pro-6-shelf-photo.png") });
    gemini.mode = "limit";
    await S.setInputFiles("#shelf-file", await shelfJpeg(S));
    await S.waitForSelector(".shelf-out .shelf-result.is-error");
    check(/free photo checks are used up/.test(await S.textContent(".shelf-out")), "when Google's free daily limit is reached, the rep is told plainly (no charge)");
    gemini.mode = "retired";
    const retired = await (await post("/api/pro/shelf", { key: lic.key, device: lic.device, image: "A".repeat(300), mime: "image/jpeg", products: ["Mango Juice"] })).json();
    check(retired.ok && gemini.calls.slice(-2).map((c) => c.path).join(" ").includes("gemini-flash-latest"), "a model Google retired is skipped for the next one");
    gemini.mode = "ok";
    await S.locator("dialog.pro-shelf .pro-x").click();

    // The solo dashboard's Pro tab: accountant summary and returns.
    await openDashboard(S, true);
    await S.getByRole("tab", { name: "Pro" }).click();
    await S.waitForSelector("#dash-accountant");
    const yearCard = (await S.textContent('#dash-accountant .pro-q.is-year')).replace(/\s+/g, " ");
    // Invoices this year: $1,000 + $500 (credit $500) + $300 = $1,800 gross (the $1,800 one was deleted); returns $980 + $250 + $450 (CN-0003) = $1,680.
    check(/Net sales/.test(yearCard) && /Grosssales\$1,800\.00/.test(yearCard.replace(/ /g, "")) && /Returns−\$1,680\.00/.test(yearCard.replace(/ /g, "")) && /\$120\.00/.test(yearCard),
      "solo dashboard → Pro: the accountant summary for the year (gross $1,800, returns $1,680, net $120)", yearCard.slice(0, 200));
    check(/accountant still needs to check it/.test(await S.textContent(".pro-acct-note")), "it says the accountant still checks it");
    const [csvDl] = await Promise.all([S.waitForEvent("download"), S.click("#dash-csv")]);
    const csv = fs.readFileSync(await csvDl.path(), "utf8");
    check(/sales summary for \d{4} \(year ending 31 December/.test(csv) && /Q4,Oct – Dec/.test(csv) && /Your accountant still needs to check it/.test(csv) && /CN-0001,.*Mango Juice,2,each,Expired,250\.00,500\.00/.test(csv),
      "Download for accountant: a CSV with the quarters, the year and every invoice and credit note line", csvDl.suggestedFilename());
    const retStore = await S.textContent("#dash-ret-store");
    check(/Hill Top Grocery/.test(retStore) && /Bay Market/.test(retStore) && /Mango Juice/.test(await S.textContent("#dash-ret-product")), "returns by store and by product");
    await S.screenshot({ path: path.join(OUT, "pro-7-solo-dashboard.png"), fullPage: true });
    await S.getByRole("tab", { name: "Settings" }).click();
    check(await S.locator(".dash-terms a[href='/terms']").count() === 1, "Settings links to the Terms (with the Marlon Pro section)");

    // ── Team Pro: a rep's return reaches the boss ─────────────────────────────────────────────────────────────────
    const ctxR = await browser.newContext({ ...PHONE });
    const R = await ctxR.newPage();
    watch(R, "rep");
    await R.goto(team.repLinks[0]);
    await R.waitForSelector("#setup-rep");
    await R.fill("#setup-rep", "Dana Reid");
    await setUp(R, { ...BUSINESS, name: "Coastline Foods" }); // a rep's company name comes from the team
    await R.waitForSelector("#pro-return");
    await makeInvoice(R, "Corner Shop", [["Mango Juice", 6]]);
    await logReturn(R, "Corner Shop", [["Mango Juice", 3, "expired"]]);
    await R.click("#cn-done");
    await makeInvoice(R, "Corner Shop", [["Carrot Juice", 4]]);
    check((await R.textContent("#grand-amount")).trim() === "$250.00", "a rep's next invoice for the store: $1,000.00 − $750.00 credit = $250.00");
    await R.evaluate(() => window.__teamSync());
    await R.evaluate(() => window.__teamSync());
    const bctx = await browser.newContext({ ...PHONE, acceptDownloads: true });
    const B = await bctx.newPage();
    watch(B, "boss");
    await B.goto(team.bossLink);
    await B.waitForSelector("#boss-pass2");
    await B.fill("#boss-pass", "boss-secret-1");
    await B.fill("#boss-pass2", "boss-secret-1");
    await B.click("button[type=submit]");
    await B.waitForSelector("#boss-accountant");
    check(/Pro/.test(await B.textContent(".boss-pro-tag")), "the boss dashboard shows Pro");
    const retRep = await B.textContent("#boss-ret-rep");
    check(/Corner Shop/.test(await B.textContent("#boss-ret-store")) && /Mango Juice/.test(await B.textContent("#boss-ret-product")) && /3 expired/.test(await B.textContent("#boss-ret-product")) && /Dana Reid/.test(retRep) && /\$750\.00/.test(retRep),
      "boss: returns by store, by product (with the reason) and by rep", retRep.replace(/\s+/g, " "));
    check(/Credit note CN-0001/.test(await B.textContent(".boss-credit")) && /−\$750\.00/.test(await B.textContent(".boss-credit")), "boss: the invoice shows the credit that came off it");
    const bYear = (await B.textContent("#boss-accountant .boss-q.is-year")).replace(/\s+/g, "");
    // The rep's invoices: 6 × $250 = $1,500 and 4 × $250 = $1,000 (of which $750 was credit); the return: $750.
    check(/Grosssales\$2,500\.00/.test(bYear) && /Returns−\$750\.00/.test(bYear) && /\$1,750\.00/.test(bYear) && /accountant still needs to check it/.test(await B.textContent(".boss-acct-note")),
      "boss: the accountant summary by quarter and year (gross $2,500, returns $750, net $1,750), with the note", bYear.slice(0, 140));
    const [bcsv] = await Promise.all([B.waitForEvent("download"), B.click("#boss-csv")]);
    const bText = fs.readFileSync(await bcsv.path(), "utf8");
    check(/Coastline Foods — sales summary/.test(bText) && /Dana Reid/.test(bText) && /CN-0001,Dana Reid,Corner Shop,Mango Juice,3,each,Expired/.test(bText), "boss: the accountant's CSV names the rep on every line");
    await B.screenshot({ path: path.join(OUT, "pro-8-boss.png"), fullPage: true });

    // A team without Pro: the boss sees no Pro sections, and the server sends no credit notes.
    await post("/api/console/pro", { id: team.buyer.id, pro: false, discountPct: 0 }, token);
    await B.reload();
    await B.waitForSelector("#boss-reps");
    check(await B.locator("#boss-accountant").count() === 0 && await B.locator("#boss-returns").count() === 0, "Pro switched off: the boss's Pro sections disappear (the data is kept)");
    await post("/api/console/pro", { id: team.buyer.id, pro: true, discountPct: 0 }, token);

    // ── Pro switched off reaches the phone; credit notes already given still count ─────────────────────────────────
    await post("/api/console/pro", { id: solo.buyer.id, pro: false, discountPct: 10 }, token);
    await S.goto(`${BASE}/#/`);
    await S.reload(); // a real new open of the app (a change after "#" alone doesn't reload the page)
    await S.waitForFunction(() => window.__appReady === true);
    await S.waitForFunction(() => document.getElementById("pro-bar").hidden === true, null, { timeout: 8000 });
    check(true, "Pro switched off in the console: the phone hides Return and Shelf photo the next time it's online");
    await makeInvoice(S, "Hill Top Grocery", [["Mango Juice", 1]]);
    check(/CN-0001/.test(await S.textContent("#credit-rows")), "…and credit notes it already gave stores still come off their next invoices");

    // Shelf photo limits on the server.
    const limitKey = team.repLinks[1].split("k=")[1], limitDev = "d".repeat(32);
    await post("/api/activate", { key: limitKey, device: limitDev });
    let last = null;
    for (let i = 0; i < 101; i++) last = await post("/api/pro/shelf", { key: limitKey, device: limitDev, image: "A".repeat(200), mime: "image/jpeg", products: ["Mango Juice"] });
    check(last.status === 429 && /today's 100 shelf photos/.test((await last.json()).error), "each company can check up to 100 shelf photos a day (keeps the free quota for everyone)", `HTTP ${last.status}`);
    const { shelfCount } = await import(path.join(APP, "worker", "shelf.js"));
    const noKey = await shelfCount({}, { image: "x", mime: "image/jpeg", products: ["A"] });
    check(noKey.error === "setup" && /isn't set up/.test(noKey.message), "without a Gemini key, shelf photo says it isn't set up (nothing breaks)");

    // ── Terms ───────────────────────────────────────────────────────────────────────────────────────────────────
    const T = await (await browser.newContext({ ...PHONE })).newPage();
    await T.goto(`${BASE}/terms`);
    const terms = (await T.textContent("#marlon-pro")).replace(/\s+/g, " ");
    check(/\$25 \(US dollars\) per rep, per month/.test(terms) && /same automatic team discount as regular Marlon/.test(terms) && /5–9 reps ?10% off/.test(terms) && /100\+ reps ?30% off/.test(terms) && /special deal .* on top of the team discount/.test(terms) && /billed monthly, in advance, for every rep place/.test(terms) && /cancel Marlon Pro at any time/.test(terms),
      "the Terms page has a Marlon Pro section: price with the team discount table, per-rep monthly billing and cancellation");
    await T.screenshot({ path: path.join(OUT, "pro-9-terms.png"), fullPage: true });

    check(errors.length === 0, "no page errors anywhere", errors.join(" | "));
  } catch (e) {
    console.error(e);
    failures++;
  } finally {
    await browser.close();
    await w.stop();
    gsrv.close();
    fs.rmSync(stateDir, { recursive: true, force: true });
  }
  console.log(failures ? `\n${failures} check(s) failed` : "\nAll Marlon Pro checks passed");
  process.exit(failures ? 1 : 0);
})();
