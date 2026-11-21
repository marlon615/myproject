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
 *     Google busy, the 20-a-day per-rep limit, no key;
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
      const imgs = parts.filter((p) => p.inline_data);
      gemini.calls.push({ path: req.url, key: req.headers["x-goog-api-key"], prompt: parts.find((p) => p.text)?.text || "", texts: parts.filter((p) => p.text).map((p) => p.text), image: imgs[imgs.length - 1]?.inline_data || null, images: imgs.length, schema: body.generationConfig?.responseSchema || null });
      const send = (status, obj) => { res.writeHead(status, { "content-type": "application/json" }); res.end(JSON.stringify(obj)); };
      if (gemini.mode === "limit") return send(429, { error: { code: 429, message: "You exceeded your current quota.", status: "RESOURCE_EXHAUSTED" } });
      if (/gemini-flash-lite-latest/.test(req.url) && gemini.mode === "retired") return send(404, { error: { code: 404, message: "This model is no longer available to new users." } });
      const answer = { products: [{ name: "Mango Juice", count: 6 }, { name: "Imaginary Soda", count: 3 }, { name: "eggs", count: 2 }], unknown: [{ description: "red can", count: 2 }] };
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
  await page.waitForSelector(".dash-key, .dash-tablist");
  if (!create && !(await page.locator(".dash-key").isVisible().catch(() => false))) return; // still unlocked from earlier (on the last tab used)
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

    const con = await (await browser.newContext({ ...PHONE, acceptDownloads: true })).newPage();
    watch(con, "console");
    await con.goto(`${BASE}/console`);
    await con.evaluate((t) => sessionStorage.setItem("marlon.console", t), token);
    await con.reload();
    await con.waitForSelector(".con-buyer");
    check(/Pro each month/.test(await con.locator(".con-tiles").nth(1).textContent()) && /\$97\.50/.test(await con.locator(".con-tiles").nth(1).textContent()), "the console shows 'Pro each month' ($97.50)");
    const tierRows = await con.locator(".con-tier-table tr").allTextContents();
    check(tierRows.length === 6 && /1–4 reps\s*No discount/.test(tierRows[0]) && /100\+ reps\s*30% off/.test(tierRows[5]), "the console shows the team discount table (used by Marlon and Marlon Pro)", tierRows.join(" | "));
    // ── Every buyer card opens the customer's edit page ────────────────────────────────────────────────────────
    const cardCount = await con.locator(".con-buyer").count();
    check(cardCount >= 3 && await con.locator(".con-buyer.is-tappable").count() === cardCount && await con.locator(".con-buyer .con-edit-big").count() === cardCount,
      "every buyer card is tappable and has an 'Edit customer' button", `${cardCount} cards`);
    const plainCard = con.locator(".con-buyer", { hasText: "No Pro Shop" });
    check(/Marlon Pro: off/.test(await plainCard.locator(".con-summary").textContent()) && /Contact: none saved/.test(await plainCard.locator(".con-summary").textContent()), "the card shows contact and Pro at a glance (none saved · off)");
    await plainCard.locator(".con-summary p").first().click(); // a tap on the card itself, not a button
    await con.waitForSelector(".ed-page");
    check(new URL(con.url()).hash === `#buyer/${plain.buyer.id}` && /No Pro Shop/.test(await con.textContent(".ed-title h1")) && await con.locator(".con-buyer").count() === 0,
      "tapping the card opens that customer's own page", new URL(con.url()).hash);
    const headings = await con.locator(".ed-section h2").allTextContents();
    check(headings[0] === "Contact" && headings[1] === "Marlon Pro", "Contact is at the top of the page, then Marlon Pro", headings.join(" → "));
    check(await con.inputValue("#ed-name") === "No Pro Shop" && await con.locator("#ed-phone").count() === 1 && await con.locator("#ed-email").count() === 1, "Contact has the name, phone and email");
    const saveButtons = await con.locator(".ed-page button").evaluateAll((bs) => bs.filter((b) => /save/i.test(b.textContent)).length);
    check(saveButtons === 1, "the page has one Save button", String(saveButtons));
    check(await con.locator(".ed-pro-fields").isHidden() && !(await con.isChecked("#ed-pro")), "Pro is off: the reps and special deal are hidden");
    await con.screenshot({ path: path.join(OUT, "pro-1e-edit-page.png") });
    // Switching Pro on asks how many reps and shows the price as it's typed.
    await con.click(".ed-switch");
    check(await con.isChecked("#ed-pro") && /How many reps do they have\?/.test(await con.textContent(".ed-pro-fields")) && await con.evaluate(() => document.activeElement?.id) === "ed-reps",
      "switching Pro on asks 'How many reps do they have?' and puts the cursor there");
    await con.fill("#ed-reps", "7");
    const lines7 = (await con.textContent(".con-pro-lines")).replace(/\s+/g, " ");
    check(/7 reps × \$25\.00 a month ?\$175\.00/.test(lines7) && /Team discount 10% \(5–9 reps\)/.test(lines7) && /\$157\.50/.test(await con.textContent(".con-pro-price")),
      "7 reps: 7 × $25.00 = $175.00, the automatic 10% team discount (5–9 reps), monthly total $157.50", lines7);
    await con.fill("#ed-reps", "25");
    check(/Team discount 20% \(25–49 reps\)/.test(await con.textContent(".con-pro-lines")) && /\$500\.00/.test(await con.textContent(".con-pro-price")), "changing the reps to 25 updates the discount (20%) and the total ($500.00) straight away");
    await con.fill("#ed-deal", "10");
    check(/Special deal 10%/.test(await con.textContent(".con-pro-lines")) && /\$450\.00/.test(await con.textContent(".con-pro-price")), "a special deal % comes off on top of the team discount ($500.00 − 10% = $450.00)");
    await con.fill("#ed-reps", "7");
    await con.fill("#ed-deal", "0");
    // One Save checks everything first: a bad phone stops the whole save (Pro isn't switched on either).
    await con.fill("#ed-phone", "876 555 0199");
    await con.click(".ed-save");
    check(/country code/.test(await con.textContent(".ed-error")) && await con.locator("#ed-phone.is-wrong").count() === 1 && !(await buyers()).buyers.find((b) => b.name === "No Pro Shop").pro,
      "a phone without the country code is refused at Save, the phone box is marked, and nothing is saved (Pro stays off)");
    await con.fill("#ed-phone", "+1 876 555 0199");
    await con.fill("#ed-email", "owner@noproshop.example");
    const asked = [];
    const onDialog = async (d) => { asked.push(`${d.type()}: ${d.message()}`); await d.accept(); };
    con.on("dialog", onDialog);
    await con.click(".ed-save");
    // The payment notice pops up straight away, on this console only.
    await con.waitForSelector("dialog.con-notice[open]");
    con.off("dialog", onDialog);
    check(/^confirm: Switch Marlon Pro on for No Pro Shop\?/.test(asked[0] || "") && /Team discount 10% \(5–9 reps\): −\$17\.50/.test(asked[0] || "") && /Monthly total: \$157\.50/.test(asked[0] || ""),
      "Save asks to confirm switching Pro on, showing the discounted monthly total", (asked[0] || "").split("\n")[0]);
    const np1 = (await buyers()).buyers.find((b) => b.name === "No Pro Shop");
    check(np1.pro && np1.proReps === 7 && np1.proMonthlyCents === 15750 && np1.phone === "+1 876 555 0199" && np1.email === "owner@noproshop.example",
      "one Save stored everything together: Pro on, 7 reps, $157.50 a month, phone and email", JSON.stringify({ pro: np1.pro, r: np1.proReps, c: np1.proMonthlyCents, ph: np1.phone }));
    const localDay = await con.evaluate(() => { const d = new Date(); return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`; });
    const pricingMod = await import(path.join(APP, "public", "js", "pricing.js"));
    const startText = pricingMod.longDate(localDay), dueText = pricingMod.dueDayText(localDay);
    const lead = (await con.textContent(".con-notice-lead")).replace(/\s+/g, " ");
    check(lead === `No Pro Shop: your monthly payment for Marlon Pro (owner dashboard plus 7 reps) is $157.50. Payment starts on ${startText} and is due on ${dueText}.`,
      "switching Pro on pops up the payment notice straight away: company, owner dashboard plus 7 reps, $157.50, start date and monthly due date", lead);
    const nTable = (await con.textContent(".con-notice-table")).replace(/\s+/g, " ");
    check(/7 reps × \$25\.00 a month ?\$175\.00/.test(nTable) && /Team discount 10% \(5–9 reps\) ?−\$17\.50/.test(nTable) && /Monthly total ?\$157\.50/.test(nTable), "…with the price breakdown (team discount included)", nTable);
    check(/only you see this/i.test(await con.textContent(".con-notice-kicker")) && /Nothing is sent until you tap a button/.test(await con.textContent("dialog.con-notice")), "the pop-up says only the maker sees it, and nothing is sent until a button is tapped");
    const waHref = await con.getAttribute(".con-send-wa", "href");
    const waText = decodeURIComponent(waHref.replace(/^https:\/\/wa\.me\/\d*\?text=/, ""));
    check(waHref.startsWith("https://wa.me/18765550199?text=") && waText.startsWith("No Pro Shop: your monthly payment for Marlon Pro (owner dashboard plus 7 reps) is $157.50.") && /Team discount 10% \(5–9 reps\): −\$17\.50/.test(waText) && /\/terms$/.test(waText),
      "Send by WhatsApp opens WhatsApp to the number just saved with the whole message ready", waText.split("\n")[0]);
    const mailUrl = new URL(await con.getAttribute(".con-send-email", "href"));
    check(mailUrl.protocol === "mailto:" && mailUrl.pathname === "owner@noproshop.example" && /Marlon Pro: your monthly payment \(No Pro Shop\)/.test(mailUrl.searchParams.get("subject") || "") && /Monthly total: \$157\.50/.test(mailUrl.searchParams.get("body") || ""),
      "Send by email opens the mail app addressed to them, with the subject and the message filled in", mailUrl.searchParams.get("subject"));
    const [noticePdf] = await Promise.all([con.waitForEvent("download"), con.click(".con-send-pdf")]);
    const noticeBytes = fs.readFileSync(await noticePdf.path());
    check(noticeBytes.subarray(0, 5).toString() === "%PDF-" && noticeBytes.length > 15000 && /marlon-pro-payment-no-pro-shop\.pdf/.test(noticePdf.suggestedFilename()), "Send as PDF makes a one-page PDF of the notice", `${noticePdf.suggestedFilename()} · ${noticeBytes.length} bytes`);
    await con.screenshot({ path: path.join(OUT, "pro-1c-payment-notice.png") });
    await con.click(".con-notice-close");
    const kept = (await buyers()).buyers.find((b) => b.name === "No Pro Shop").notices;
    check(kept.length === 1 && kept[0].startDate === localDay && kept[0].price.netCents === 15750 && kept[0].price.reps === 7, "a copy is kept in the company's record (start date, reps and the exact price)", JSON.stringify({ n: kept.length, d: kept[0]?.startDate, c: kept[0]?.price.netCents }));
    check(await con.locator(".ed-page").count() === 1 && /Saved/.test(await con.textContent(".con-saved")) && await con.isChecked("#ed-pro") && /^Reps$/.test(await con.textContent(".ed-pro-fields .con-field span")),
      "after saving, the page stays open with 'Saved.' and Pro on");
    // Change reps and the special deal later: same page, same Save (no second notice unless asked for).
    await con.fill("#ed-reps", "25");
    await con.fill("#ed-deal", "10");
    await con.click(".ed-save");
    await con.waitForFunction(() => /\$450\.00/.test(document.querySelector(".ed-page .con-pro-price")?.textContent || "") && document.querySelector(".con-saved"), null, { timeout: 5000 });
    const saved25 = (await buyers()).buyers.find((b) => b.name === "No Pro Shop");
    check(saved25.proReps === 25 && saved25.proTierPct === 20 && saved25.discountPct === 10 && saved25.proMonthlyCents === 45000 && saved25.notices.length === 1,
      "saved: 25 reps, 20% team discount, 10% special deal, $450.00 a month", JSON.stringify({ r: saved25.proReps, t: saved25.proTierPct, d: saved25.discountPct, c: saved25.proMonthlyCents }));
    // "Send again" shows the notice exactly as it was agreed, even though the price has changed since.
    check(/Payment notices \(1\)/.test(await con.textContent(".ed-page .con-notices summary")), "the customer's page lists its payment notices");
    await con.click(".ed-page .con-notices summary");
    await con.click(".ed-page .con-notice-again");
    await con.waitForSelector("dialog.con-notice[open]");
    check(/is \$157\.50\./.test(await con.textContent(".con-notice-lead")), "Send again reopens the saved notice with its original price ($157.50), ready to send by WhatsApp, PDF or email");
    await con.click(".con-notice-close");
    await con.click(".ed-page .con-notice-new");
    await con.waitForSelector("dialog.con-notice[open]");
    check(/owner dashboard plus 25 reps\) is \$450\.00/.test(await con.textContent(".con-notice-lead")) && /Special deal 10%/.test(await con.textContent(".con-notice-table")),
      "a new payment notice at today's price shows the new total with the team discount and special deal ($450.00)");
    await con.click(".con-notice-close");
    check((await buyers()).buyers.find((b) => b.name === "No Pro Shop").notices.length === 2, "…and is kept too (2 notices in the record)");
    // Back to the list: the card shows the new details.
    await con.waitForSelector(".ed-back");
    await con.click(".ed-back");
    await con.waitForSelector(".con-buyer");
    const npSummary = await con.locator(".con-buyer", { hasText: "No Pro Shop" }).locator(".con-summary").textContent();
    check(new URL(con.url()).hash === "" && /\+1 876 555 0199 · owner@noproshop\.example/.test(npSummary) && /Marlon Pro: on · 25 reps · \$450\.00 a month/.test(npSummary),
      "'‹ All buyers' goes back to the list, and the card shows the new contact and Pro details", npSummary.replace(/\s+/g, " "));
    // The server checks everything too, and saves nothing if one part is wrong.
    const halfBad = await post("/api/console/buyer-update", { id: plain.buyer.id, name: "Renamed Shop", phone: "+1 876 555 0199", email: "owner@", pro: true, reps: 25, discountPct: 10 }, token);
    const afterBad = (await buyers()).buyers.find((b) => b.id === plain.buyer.id);
    check(halfBad.status === 400 && (await halfBad.json()).field === "email" && afterBad.name === "No Pro Shop", "the server refuses a save with one wrong part (a broken email) and keeps the old name too", `HTTP ${halfBad.status}`);
    const offRes = await post("/api/console/buyer-update", { id: team.buyer.id, name: team.buyer.name, phone: "", email: "", pro: false, discountPct: 0 }, token);
    check(offRes.status === 200 && !(await offRes.json()).buyer.pro, "switching Pro off from the page works (Save with Pro off)");
    const noName = await post("/api/console/buyer-update", { id: team.buyer.id, name: "  ", phone: "", email: "", pro: false, discountPct: 0 }, token);
    check(noName.status === 400 && (await noName.json()).field === "name", "a blank name is refused");
    await post("/api/console/pro", { id: team.buyer.id, pro: true, reps: 3, discountPct: 0 }, token);

    // ── The buyer's phone and email fill in WhatsApp and email ──────────────────────────────────────────────────
    const noCc = await post("/api/console/buyers", { name: "Brown's Wholesale", devices: 5, amount: 300, kind: "team", phone: "876 555 0123", email: "" }, token);
    check(noCc.status === 400 && /country code/.test((await noCc.json()).error), "a phone number without the country code is refused (WhatsApp needs it)", `HTTP ${noCc.status}`);
    const badMail = await post("/api/console/buyers", { name: "Brown's Wholesale", devices: 5, amount: 300, kind: "team", phone: "", email: "brown@" }, token);
    check(badMail.status === 400 && /email address/.test((await badMail.json()).error), "a broken email address is refused", `HTTP ${badMail.status}`);
    const brown = await (await post("/api/console/buyers", { name: "Brown's Wholesale", devices: 5, amount: 300, kind: "team", phone: "+1 876 555 0123", email: "orders@brownswholesale.example" }, token)).json();
    check(brown.buyer.phone === "+1 876 555 0123" && brown.buyer.email === "orders@brownswholesale.example", "a new buyer can be saved with their phone and email", JSON.stringify([brown.buyer.phone, brown.buyer.email]));
    await post("/api/console/pro", { id: brown.buyer.id, pro: true, reps: 5, discountPct: 5 }, token);
    await con.reload();
    await con.waitForSelector(".con-buyer");
    const brownCard = con.locator(".con-buyer", { hasText: "Brown's Wholesale" }).first();
    check(/\+1 876 555 0123 · orders@brownswholesale\.example/.test(await brownCard.locator(".con-summary").textContent()), "the buyer's card shows their phone and email under Contact");
    await brownCard.locator(".con-edit").click(); // the small "Edit ›" button at the top of the card
    await con.waitForSelector(".ed-page");
    await con.click(".ed-page .con-notices summary").catch(() => {});
    await con.locator(".ed-page .con-notice-again").first().click();
    await con.waitForSelector("dialog.con-notice[open]");
    const bWa = await con.getAttribute(".con-send-wa", "href"), bMail = await con.getAttribute(".con-send-email", "href");
    check(bWa.startsWith("https://wa.me/18765550123?text=") && /Send by WhatsApp to \+1 876 555 0123/.test(await con.textContent(".con-send-wa")) && /owner dashboard plus 5 reps\) is \$106\.87/.test(decodeURIComponent(bWa)),
      "WhatsApp opens straight to the buyer's number (+1 876 555 0123) with the notice filled in ($106.87 for 5 reps, 10% team discount, 5% special deal)", bWa.slice(0, 40));
    check(bMail.startsWith("mailto:orders@brownswholesale.example?subject=") && /Send by email to orders@brownswholesale\.example/.test(await con.textContent(".con-send-email")) && /To: \+1 876 555 0123 · orders@brownswholesale\.example/.test(await con.textContent(".con-notice-to")),
      "email opens addressed to the buyer, and the pop-up shows who it's going to", bMail.slice(0, 50));
    await con.screenshot({ path: path.join(OUT, "pro-1d-notice-with-contact.png") });
    await con.click(".con-notice-close");
    // Rename on the page: the new name is saved and shown.
    await con.fill("#ed-name", "Brown's Wholesale Ltd");
    await con.click(".ed-save");
    await con.waitForFunction(() => /Brown's Wholesale Ltd/.test(document.querySelector(".ed-title h1")?.textContent || ""), null, { timeout: 5000 });
    check((await buyers()).buyers.find((b) => b.id === brown.buyer.id).name === "Brown's Wholesale Ltd", "the customer's name can be changed on the page");
    // Opening the page by its address works too (e.g. after a reload).
    await con.reload();
    await con.waitForSelector(".ed-page");
    check(/Brown's Wholesale Ltd/.test(await con.textContent(".ed-title h1")), "reloading keeps the customer's page open");
    await con.click(".ed-back");
    await con.waitForSelector(".con-buyer");
    await post("/api/console/buyer-contact", { id: plain.buyer.id, phone: "", email: "" }, token);
    check((await buyers()).buyers.find((b) => b.name === "No Pro Shop").phone === "", "contact details can be cleared again (WhatsApp and email then ask who to send to)");
    await con.locator(".con-buyer", { hasText: "No Pro Shop" }).first().scrollIntoViewIfNeeded();
    await con.screenshot({ path: path.join(OUT, "pro-1b-console-tiers.png") });
    // Plain Marlon uses the same table: the new-team form shows the discount for that many reps.
    await con.locator(".con-kind", { hasText: "Team" }).click();
    await con.locator(".con-chips label", { hasText: "Another number" }).click();
    await con.fill("#con-devices-other", "12");
    check(/Team discount for 12 reps: 15% \(10–24 reps\)/.test(await con.textContent(".con-tier-hint")), "plain Marlon's new-team form shows the same team discount for that number of reps");
    await post("/api/console/pro", { id: plain.buyer.id, pro: false, discountPct: 0 }, token);
    await con.reload();
    await con.waitForSelector(".con-buyer");
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
    // My Products: a solo business's own list becomes its company list (once), and the phone then uses that list.
    await S.evaluate(() => window.__catalogSync());
    await S.waitForFunction(async () => (await (await import("/js/db.js")).products.all()).every((p) => p.company), null, { timeout: 8000 });
    const seeded = await S.evaluate(async () => { const db = await import("/js/db.js"); const c = await db.settings.get("catalog"); const list = await db.products.all(); return { n: c.products.length, edit: c.canEdit, names: list.map((p) => p.name), mango: list.find((p) => p.name === "Mango Juice") }; });
    check(seeded.n === 12 && seeded.edit && seeded.names.length === 12 && seeded.mango?.price === 250 && seeded.mango.unit === "each",
      "My Products: a solo business's 12 products become its saved company list the first time (nothing lost), and the phone uses that list", JSON.stringify({ n: seeded.n, phone: seeded.names.length }));
    check((await buyers()).buyers.find((b) => b.id === solo.buyer.id).productCount === 12, "the maker's console counts the company's products (12)");
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

    // ── My Products (owner dashboard → Pro): add with camera photos, edit, delete ────────────────────────────────
    await openDashboard(S, true);
    await S.getByRole("tab", { name: "Pro" }).click();
    await S.waitForSelector("#my-products .mp-item");
    check(/12 products/.test(await S.textContent("#mp-count")) && await S.locator("#mp-add").isVisible(), "dashboard → Pro → My Products lists the company's 12 products, with “Add a product”");
    await S.click("#mp-add");
    await S.fill(".mp-editor .mp-in-name", "Pineapple Juice");
    await S.fill(".mp-editor .mp-in-size", "1 L");
    await S.fill(".mp-editor .mp-in-price", "3.50");
    await S.setInputFiles(".mp-editor .mp-file", await shelfJpeg(S));
    await S.waitForSelector(".mp-editor .mp-ph.is-new img");
    await S.screenshot({ path: path.join(OUT, "pro-11a-my-products-add.png") });
    await S.click(".mp-editor .mp-save");
    await S.waitForSelector("#my-products .mp-msg:not(.is-bad)");
    check(/Added Pineapple Juice \(1 L\)/.test(await S.textContent("#my-products .mp-msg")) && /13 products/.test(await S.textContent("#mp-count")), "a new product with its name, size, price and a camera photo is saved (13 products)");
    const pine = () => S.evaluate(async () => { const r = await (await import("/js/catalog.js")).catalogApi(""); return r.data.products.find((p) => p.name === "Pineapple Juice"); });
    let pj = await pine();
    check(pj && pj.size === "1 L" && pj.price === 3.5 && pj.unit === "each" && pj.photos.length === 1 && pj.photos[0].thumb.length > 300, "…on the server, for this company: size 1 L, $3.50 each, 1 photo (with a small thumbnail)", JSON.stringify({ size: pj?.size, price: pj?.price, photos: pj?.photos.length }));
    await S.waitForFunction(async () => (await (await import("/js/db.js")).products.all()).some((p) => p.name === "Pineapple Juice 1 L" && p.price === 3.5), null, { timeout: 6000 });
    check(true, "the phone's product list (invoices, returns, orders) gets it as “Pineapple Juice 1 L”");
    const item = S.locator(".mp-item", { hasText: "Pineapple Juice" });
    await item.locator(".mp-edit").click();
    await S.fill(".mp-editor .mp-in-price", "3.75");
    await S.setInputFiles(".mp-editor .mp-file", await shelfJpeg(S));
    await S.waitForFunction(() => document.querySelectorAll(".mp-editor .mp-ph:not(.is-new)").length === 2);
    await S.click(".mp-editor .mp-save");
    await S.waitForFunction(() => /Saved Pineapple Juice/.test(document.querySelector("#my-products .mp-msg")?.textContent || ""));
    pj = await pine();
    check(pj.price === 3.75 && pj.photos.length === 2 && /\$3\.75 each/.test(await S.textContent(".mp-item:has-text('Pineapple Juice')")), "editing changes the price ($3.75) and adds a second photo");
    await S.locator(".mp-item", { hasText: "Pineapple Juice" }).locator(".mp-thumb").first().click();
    await S.waitForSelector(".mp-viewer img");
    check((await S.getAttribute(".mp-viewer img", "src")).startsWith("data:image/jpeg;base64,"), "tapping a photo shows it full size");
    await S.click(".mp-viewer .btn");
    await S.locator(".mp-item", { hasText: "Scallion" }).locator(".mp-edit").click();
    S.once("dialog", (d) => d.accept());
    await S.click(".mp-editor .mp-delete");
    await S.waitForFunction(() => /Deleted Scallion/.test(document.querySelector("#my-products .mp-msg")?.textContent || ""));
    check(/12 products/.test(await S.textContent("#mp-count")) && !(await S.evaluate(async () => (await (await import("/js/db.js")).products.all()).some((p) => p.name === "Scallion"))),
      "deleting a product removes it from My Products and from the phone's list");
    const dupe = await S.evaluate(async () => (await (await import("/js/catalog.js")).catalogApi("/save", { product: { name: "pineapple juice", size: "1 l", price: 1 } })).status);
    check(dupe === 409, "the same name and size can't be saved twice", String(dupe));
    check(!/null|undefined/.test(await S.textContent("#my-products")), "My Products shows no stray “null” text");
    await S.screenshot({ path: path.join(OUT, "pro-11b-my-products.png"), fullPage: true });
    await S.getByRole("tab", { name: "Settings" }).click();
    check(/in My Products \(the Pro tab\)/.test(await S.textContent("#dash-products-managed")), "Settings → Products points to My Products (one place to change the list)");
    await S.evaluate(() => { location.hash = "#/"; });
    await S.waitForSelector("#pro-shelf");

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
    check(/- Pineapple Juice \(1 L\)/.test(call.prompt) && !/Scallion/.test(call.prompt) && call.images === 2 && call.texts.includes("Reference photo: Pineapple Juice (1 L)") && /goes in "unknown"/.test(call.prompt),
      "shelf photo matches only the company's saved products (with sizes; the deleted one is gone), sending a product's photo as a labelled reference", `${call.images} images`);
    await S.locator(".shelf-past summary").first().click();
    const past = await S.textContent(".shelf-past");
    check(/Mango Juice/.test(past) && /× 6/.test(past) && /Eggs/.test(past) && /× 2/.test(past) && !/Imaginary Soda/.test(past) && /Not seen:/.test(past) && /Counted by AI/.test(past),
      "results: which of the company's products are there and how many (Mango Juice × 6, Eggs × 2)", past.replace(/\s+/g, " ").slice(0, 160));
    const unk = (await S.locator(".shelf-past .shelf-unknown li").allTextContents()).map((t) => t.replace(/\s+/g, " ").trim());
    check(unk.length === 2 && unk[0] === "Unknown product× 3" && unk[1] === "Unknown product · red can× 2",
      "anything that isn't one of the company's products shows as “Unknown product” (a name Gemini made up is never shown as if it were real)", JSON.stringify(unk));
    await S.setInputFiles("#shelf-file", await shelfJpeg(S));
    await S.waitForSelector(".shelf-out .shelf-found");
    await S.screenshot({ path: path.join(OUT, "pro-6-shelf-photo.png") });
    gemini.mode = "limit";
    await S.setInputFiles("#shelf-file", await shelfJpeg(S));
    await S.waitForSelector(".shelf-out .shelf-result.is-error");
    check(/photo service is busy right now/.test(await S.textContent(".shelf-out")), "when Google's service is busy or over its limit, the rep is told plainly to try again later");
    gemini.mode = "retired";
    const retired = await (await post("/api/pro/shelf", { key: lic.key, device: lic.device, image: "A".repeat(300), mime: "image/jpeg", products: ["Mango Juice"] })).json();
    check(retired.ok && gemini.calls.slice(-2).map((c) => c.path).join(" ").includes("gemini-flash-latest"), "a model Google retired is skipped for the next one");
    gemini.mode = "ok";
    await S.locator("dialog.pro-shelf .pro-x").click();

    // ── Shelf Order: from the shelf count to a signed order, then an invoice ────────────────────────────────────
    check(await S.locator("#pro-orders").isVisible() && await S.locator("#pro-order-count").isHidden(), "Pro: an Orders button sits next to Return and Shelf photo (no pending orders yet)");
    await S.click("#pro-shelf");
    await S.waitForSelector("dialog.pro-shelf[open]");
    const firstPast = S.locator(".shelf-past").filter({ hasText: "Mango Juice" }).first();
    await firstPast.locator("summary").click();
    check(await firstPast.locator(".shelf-order").isVisible(), "after a shelf photo, the products seen and their counts come with a “Make an order” button");
    await firstPast.locator(".shelf-order").click();
    await S.waitForSelector("dialog.pro-order[open]");
    const ordLines = async () => S.evaluate(() => [...document.querySelectorAll(".ord-line")].map((li) => ({
      name: li.querySelector(".ord-product").selectedOptions[0]?.textContent, shelf: li.querySelector(".ord-shelf").value, target: li.querySelector(".ord-target").value, qty: li.querySelector(".ord-qty").value })));
    let ol = await ordLines();
    check(await S.inputValue("#ord-store") === "Hill Top Grocery" && ol.length === 2 && ol[0].name === "Mango Juice" && ol[0].shelf === "6" && ol[1].name === "Eggs" && ol[1].shelf === "2",
      "the order form fills itself from the shelf count: Mango Juice 6 on the shelf, Eggs 2, at the same store", JSON.stringify(ol));
    check(ol[0].target === "20" && ol[0].qty === "14" && ol[1].qty === "18", "with a target of 20 each, Marlon orders the difference: 20 − 6 = 14 Mango Juice, 20 − 2 = 18 Eggs", JSON.stringify(ol.map((x) => x.qty)));
    await S.fill("#ord-all-target", "24");
    await S.locator("#ord-all-target").dispatchEvent("change");
    ol = await ordLines();
    check(ol[0].target === "24" && ol[0].qty === "18" && ol[1].qty === "22", "changing the target for every product (24) works the orders out again: 18 and 22", JSON.stringify(ol));
    await S.locator(".ord-line").nth(1).locator(".ord-target").fill("10");
    await S.locator(".ord-line").nth(0).locator(".ord-qty").fill("15");
    await S.click("#ord-add");
    await S.locator(".ord-line").nth(2).locator(".ord-product").selectOption({ label: "Coconut Water" });
    await S.locator(".ord-line").nth(2).locator(".ord-target").fill("12");
    await S.click("#ord-add");
    await S.locator(".ord-line").nth(3).locator(".ord-product").selectOption({ label: "Ginger Beer" });
    await S.locator(".ord-line").nth(3).locator(".ord-shelf").fill("30");
    ol = await ordLines();
    check(ol[0].qty === "15" && ol[1].qty === "8" && ol[2].qty === "12" && ol[3].qty === "0",
      "the rep can change any amount (15 Mango Juice), one product's target (Eggs 10 − 2 = 8), add products (Coconut Water 12); a shelf above target orders 0", JSON.stringify(ol.map((x) => `${x.name}:${x.qty}`)));
    await S.fill("#ord-store", "Sunrise Mart");
    check(await S.locator("#ord-save").isDisabled() && /types their name/.test(await S.textContent("dialog.pro-order .ret-why")), "Save waits for the name of the person ordering");
    await S.fill("#ord-signer", "Marcia Brown");
    check(await S.locator("#ord-save").isDisabled() && /signs below/.test(await S.textContent("dialog.pro-order .ret-why")), "…and their signature");
    await signOn(S, "#ord-sign");
    await S.waitForFunction(() => !document.getElementById("ord-save").disabled, null, { timeout: 4000 });
    await S.screenshot({ path: path.join(OUT, "pro-10a-order-form.png") });
    await S.click("#ord-save");
    await S.waitForSelector("dialog.pro-order.is-done");
    check((await S.textContent("dialog.pro-order h2")).trim() === "Order ORD-0001" && await S.locator("dialog.pro-shelf").count() === 0, "the order is saved as ORD-0001 (the shelf screen closes)");
    const card = (await S.textContent("dialog.pro-order .ord-card")).replace(/\s+/g, " ");
    check(/Pending/.test(card) && /Sunrise Mart/.test(card) && /Ordered by Marcia Brown/.test(card) && await S.locator("dialog.pro-order .ord-sig img").count() === 1 && !/Ginger Beer/.test(card) && /8 dozen/.test(card),
      "the order shows Pending, the store, every product ordered (Ginger Beer at 0 left out), and who ordered with their signature", card.slice(0, 220));
    const saved = await S.evaluate(async () => (await (await import("/js/db.js")).orders.all())[0]);
    check(saved.number === 1 && saved.status === "pending" && saved.store === "Sunrise Mart" && saved.signerName === "Marcia Brown" && saved.signature.startsWith("data:image/png;base64,")
      && /T\d{2}:\d{2}/.test(saved.signedAt) && saved.date === today && saved.lines.map((l) => `${l.name}:${l.onShelf}/${l.target}/${l.qty}`).join(",") === "Mango Juice:6/24/15,Eggs:2/10/8,Coconut Water:0/12/12",
      "saved on the phone with the store, the name, the signature, the date and time, and shelf / target / order for each product", JSON.stringify({ n: saved.number, st: saved.status, at: saved.signedAt, l: saved.lines.length }));
    const [opdf] = await Promise.all([S.waitForEvent("download"), S.click("#ord-pdf")]);
    const opdfBytes = fs.readFileSync(await opdf.path());
    check(opdf.suggestedFilename() === "order-ORD-0001.pdf" && opdfBytes.subarray(0, 5).toString() === "%PDF-" && opdfBytes.length > 15000, "Share PDF makes a one-page PDF of the order (with the signature) for a driver on another phone", `${opdfBytes.length} bytes`);
    await S.screenshot({ path: path.join(OUT, "pro-10b-order-saved.png") });
    await S.click("#ord-done");
    await S.waitForFunction(() => document.getElementById("pro-order-count")?.textContent === "1");
    check(await S.locator("#pro-order-count").isVisible(), "Done: the Orders button shows 1 pending order");
    // At delivery, offline: the driver opens the order and shows who ordered it.
    await ctxS.setOffline(true);
    await S.click("#pro-orders");
    await S.waitForSelector("dialog.pro-orders[open] .ord-row");
    check(/ORD-0001 · Sunrise Mart/.test(await S.textContent(".ord-row")) && /Pending \(1\)/.test(await S.textContent(".ord-filter")), "Orders lists the pending order (offline too)");
    await S.click(".ord-row");
    await S.waitForSelector("dialog.pro-order-view[open]");
    check(/Ordered by Marcia Brown/.test(await S.textContent("dialog.pro-order-view .ord-sig")) && await S.locator("dialog.pro-order-view .ord-sig img").isVisible(),
      "offline at delivery: the order shows who ordered it, with their name and signature");
    await S.screenshot({ path: path.join(OUT, "pro-10c-order-at-delivery.png") });
    await ctxS.setOffline(false);
    await S.click("#ord-deliver");
    await S.waitForFunction(() => document.getElementById("store").value === "Sunrise Mart" && document.querySelectorAll("dialog[open]").length === 0, null, { timeout: 6000 });
    await S.waitForTimeout(700);
    const fromOrder = await S.evaluate(async () => { const db = await import("/js/db.js"); const o = (await db.orders.all())[0]; const inv = await db.invoices.get(o.invoiceId); return { o, inv }; });
    check(fromOrder.o.status === "delivered" && fromOrder.inv && fromOrder.o.invoiceNumber === fromOrder.inv.number && fromOrder.inv.store === "Sunrise Mart"
      && fromOrder.inv.items.map((i) => `${i.name}:${i.qty}:${i.price}`).sort().join(",") === "Coconut Water:12:180,Eggs:8:480,Mango Juice:15:250" && (await S.textContent("#grand-amount")).trim() === "$9,750.00",
      "“Delivered: make the invoice” turns it into an invoice in one tap: the store, each product with its amount and usual price ($9,750.00); the order shows Delivered with the invoice number",
      JSON.stringify({ st: fromOrder.o.status, inv: fromOrder.o.invoiceNumber, invNo: fromOrder.inv?.number, store: fromOrder.inv?.store, items: fromOrder.inv?.items.map((i) => `${i.name}:${i.qty}:${i.price}`), total: fromOrder.inv?.total }));
    check(await S.locator("#pro-order-count").isHidden(), "the Orders button has no pending orders left");
    await S.evaluate(async (id) => (await import("/js/db.js")).invoices.remove(id), fromOrder.inv.id); // (keeps the accountant numbers below as they were)
    await S.click("#new-btn").catch(() => {});
    // A second order, then cancelled.
    await S.click("#pro-shelf");
    await S.waitForSelector("dialog.pro-shelf[open]");
    await S.locator(".shelf-past").filter({ hasText: "Mango Juice" }).first().locator("summary").click();
    await S.locator(".shelf-past").filter({ hasText: "Mango Juice" }).first().locator(".shelf-order").click();
    await S.waitForSelector("dialog.pro-order[open]");
    check((await ordLines())[0].target === "24", "the next order remembers the last target used (24)");
    await S.fill("#ord-signer", "Paul Green");
    await signOn(S, "#ord-sign");
    await S.waitForFunction(() => !document.getElementById("ord-save").disabled, null, { timeout: 4000 });
    await S.click("#ord-save");
    await S.waitForSelector("dialog.pro-order.is-done");
    check((await S.textContent("dialog.pro-order h2")).trim() === "Order ORD-0002", "the next order is ORD-0002");
    await S.click("#ord-done");
    await S.click("#pro-orders");
    await S.waitForSelector("dialog.pro-orders[open] .ord-row");
    await S.click(".ord-row");
    await S.waitForSelector("dialog.pro-order-view[open]");
    await S.click("#ord-cancel");
    await S.getByRole("button", { name: "Cancel the order" }).click();
    await S.waitForFunction(async () => ((await (await import("/js/db.js")).orders.all()).find((o) => o.number === 2) || {}).status === "cancelled", null, { timeout: 5000 });
    check(true, "an order can be cancelled (ORD-0002 shows Cancelled)");
    await S.locator("dialog.pro-orders .pro-x").click().catch(() => {});
    const noOrdBefore = await S.evaluate(async () => (await (await import("/js/db.js")).exportBackup()).orders?.length || 0);
    check(noOrdBefore === 2, "orders are in the phone's backup file", String(noOrdBefore));

    // The solo dashboard's Pro tab: accountant summary and returns.
    await openDashboard(S, false);
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
    const dOrd = (await S.textContent("#dash-orders")).replace(/\s+/g, " ");
    check(/1 pending|0 pending/.test(dOrd) && /1 delivered · 1 cancelled/.test(dOrd) && /ORD-0001 · Sunrise Mart/.test(dOrd) && /ordered by Marcia Brown/.test(dOrd),
      "solo dashboard → Pro: Shelf orders with their status (1 delivered, 1 cancelled) and who ordered", dOrd.slice(0, 160));
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
    // ── My Products for a team: the boss manages them; every rep phone gets them (and can't change them) ─────────
    await B.waitForSelector("#my-products #mp-add");
    check(/0 products/.test(await B.textContent("#mp-count")), "boss → My Products: the team starts with no company products");
    const repOwn = await R.evaluate(async () => (await (await import("/js/db.js")).products.all()).length);
    for (const [n, size, price, photo] of [["Coconut Water", "330 ml", "1.80", true], ["Mango Juice", "", "2.50", false]]) {
      await B.click("#mp-add");
      await B.fill(".mp-editor .mp-in-name", n);
      await B.fill(".mp-editor .mp-in-size", size);
      await B.fill(".mp-editor .mp-in-price", price);
      if (photo) { await B.setInputFiles(".mp-editor .mp-file", await shelfJpeg(B)); await B.waitForSelector(".mp-editor .mp-ph.is-new"); }
      await B.click(".mp-editor .mp-save");
      await B.waitForFunction((x) => new RegExp(`Added ${x}`).test(document.querySelector("#my-products .mp-msg")?.textContent || ""), n);
    }
    check(/2 products/.test(await B.textContent("#mp-count")) && await B.locator("#my-products .mp-thumb img").count() === 1, "the boss adds products with a size, price and photo (2 products)");
    check(!/null|undefined/.test(await B.textContent("#my-products")), "the boss's My Products shows no stray “null” text");
    await B.screenshot({ path: path.join(OUT, "pro-11c-boss-my-products.png"), clip: await B.locator("#my-products").boundingBox() });
    await R.evaluate(() => window.__catalogSync());
    await R.waitForFunction(async () => (await (await import("/js/db.js")).products.all()).length === 2, null, { timeout: 8000 });
    const repList = await R.evaluate(async () => (await (await import("/js/db.js")).products.all()).map((p) => `${p.name}:${p.price}`).join(","));
    check(repOwn === 12 && repList === "Coconut Water 330 ml:1.8,Mango Juice:2.5", "once the boss saves products, the rep's phone uses exactly the company list (its own 12 are hidden, not deleted)", `${repOwn} → ${repList}`);
    const rLicMp = await R.evaluate(async () => (await import("/js/db.js")).settings.get("license"));
    const repTry = await post("/api/pro/products/save", { key: rLicMp.key, device: rLicMp.device, product: { name: "Rep Soda", size: "", price: 1 } });
    check(repTry.status === 403 && /boss manages/.test((await repTry.json()).error), "a rep can't add, change or delete company products (only the boss)", `HTTP ${repTry.status}`);
    const teamCat = await (await post("/api/pro/products", { key: rLicMp.key, device: rLicMp.device })).json();
    const teamPhoto = teamCat.products.find((p) => p.photos.length).photos[0].id;
    check(teamCat.canEdit === false && teamCat.products.length === 2 && (await (await post("/api/pro/products/photo-get", { key: rLicMp.key, device: rLicMp.device, photoId: teamPhoto })).json()).image?.length > 1000,
      "a rep's phone can read the company list and its photos");
    const sLicMp = await S.evaluate(async () => (await import("/js/db.js")).settings.get("license"));
    const foreign = await post("/api/pro/products/photo-get", { key: sLicMp.key, device: sLicMp.device, photoId: teamPhoto });
    const soloCat = await (await post("/api/pro/products", { key: sLicMp.key, device: sLicMp.device })).json();
    await post("/api/pro/products/delete", { key: sLicMp.key, device: sLicMp.device, id: teamCat.products[0].id });
    const stillThere = (await (await post("/api/pro/products", { key: rLicMp.key, device: rLicMp.device })).json()).products.length;
    check(foreign.status === 404 && !soloCat.products.some((p) => teamCat.products.some((t) => t.id === p.id)) && stillThere === 2, "each company's products stay private: another company can't see, open or delete them", JSON.stringify({ foreign: foreign.status, still: stillThere }));
    check((await buyers()).buyers.find((b) => b.id === team.buyer.id).productCount === 2, "the maker's console shows the team's product count (2)");
    await con.reload();
    await con.waitForSelector(".con-buyer .con-products");
    const conTeam = (await con.locator(".con-buyer", { hasText: "Coastline Foods" }).first().locator(".con-products").textContent()).replace(/\s+/g, " ");
    const conSolo = (await con.locator(".con-buyer", { hasText: "Island Fresh Distributors" }).first().locator(".con-products").textContent()).replace(/\s+/g, " ");
    check(conTeam === "My Products: 2 products" && conSolo === "My Products: 12 products", "the console's buyer cards show each company's product count", `${conTeam} | ${conSolo}`);
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
    // Shelf orders reach the boss: who ordered is shown, the signature only on request.
    await R.evaluate(async () => {
      const db = await import("/js/db.js");
      const c = document.createElement("canvas"); c.width = 300; c.height = 100; const x = c.getContext("2d"); x.lineWidth = 4; x.beginPath(); x.moveTo(10, 70); x.bezierCurveTo(80, 0, 150, 120, 290, 30); x.stroke();
      await db.orders.create({ store: "Corner Shop", address: "", lines: [{ name: "Mango Juice", unit: "each", onShelf: 4, target: 20, qty: 16 }], signature: c.toDataURL("image/png"), signerName: "Owen Clarke" });
    });
    await R.evaluate(() => window.__teamSync());
    await B.click("text=Refresh");
    await B.waitForSelector("#boss-orders .boss-ord");
    const bOrd = (await B.textContent("#boss-orders")).replace(/\s+/g, " ");
    check(/1 pending/.test(bOrd) && /ORD-0001 · Corner Shop/.test(bOrd) && /by Dana Reid/.test(bOrd) && /ordered by Owen Clarke/.test(bOrd) && /order 16/.test(bOrd),
      "boss: Shelf orders shows the rep's order: number, store, rep, who ordered, and what to deliver", bOrd.slice(0, 200));
    const bossRaw = await (await fetch(`${BASE}/api/boss/data`, { headers: { Authorization: `Bearer ${await B.evaluate(() => { const t = sessionStorage.getItem("marlon.boss.token"); try { return JSON.parse(t); } catch { return t; } })}` } })).json();
    check(bossRaw.orders?.length === 1 && bossRaw.orders[0].signer === "Owen Clarke" && !("signature" in bossRaw.orders[0]) && !JSON.stringify(bossRaw).includes("data:image/png"),
      "the boss's data carries the orderer's name but not the signature picture (that comes only on request)", JSON.stringify({ n: bossRaw.orders?.length, signer: bossRaw.orders?.[0]?.signer, keys: Object.keys(bossRaw.orders?.[0] || {}), err: bossRaw.error, png: JSON.stringify(bossRaw).indexOf("data:image/png") }));
    await B.click(".boss-ord-show");
    await B.waitForSelector(".boss-ord-sig img");
    check((await B.getAttribute(".boss-ord-sig img", "src")).startsWith("data:image/png;base64,") && /Ordered by Owen Clarke for Corner Shop/.test(await B.textContent(".boss-ord-sig")),
      "“Show signature” shows the orderer's signature, decrypted on the server for the signed-in boss");
    await B.screenshot({ path: path.join(OUT, "pro-8b-boss-orders.png"), fullPage: false, clip: await B.locator("#boss-orders").boundingBox() });
    await R.evaluate(async () => { const db = await import("/js/db.js"); const o = (await db.orders.all())[0]; await db.orders.setStatus(o.id, "delivered", { invoiceId: "x", invoiceNumber: 3 }); });
    await R.evaluate(() => window.__teamSync());
    await B.click("text=Refresh");
    await B.selectOption("#boss-ord-status", "delivered");
    await B.waitForSelector('#boss-orders .boss-ord[data-status="delivered"]');
    check(/Delivered/.test(await B.textContent("#boss-orders .boss-ord")) && /invoice No\. 0003/.test(await B.textContent("#boss-orders .boss-ord")), "a delivered order shows Delivered on the boss dashboard, with its invoice number");
    await B.screenshot({ path: path.join(OUT, "pro-8-boss.png"), fullPage: true });

    // A team without Pro: the boss sees no Pro sections, and the server sends no credit notes.
    await post("/api/console/pro", { id: team.buyer.id, pro: false, discountPct: 0 }, token);
    await B.reload();
    await B.waitForSelector("#boss-reps");
    check(await B.locator("#boss-accountant").count() === 0 && await B.locator("#boss-returns").count() === 0 && await B.locator("#boss-orders").count() === 0 && await B.locator("#my-products").count() === 0, "Pro switched off: the boss's Pro sections (orders and My Products too) disappear (the data is kept)");
    const offCat = await (await post("/api/pro/products", { key: rLicMp.key, device: rLicMp.device })).json();
    const offSave = await post("/api/pro/products/save", { key: sLicMp.key, device: sLicMp.device, product: { name: "X" } });
    check(offCat.pro === false && (await buyers()).buyers.find((b) => b.id === team.buyer.id).productCount === 2, "without Pro, My Products isn't served (the saved list is kept for when Pro comes back)");
    void offSave;
    const rLic = await R.evaluate(async () => (await import("/js/db.js")).settings.get("license"));
    const offSync = await (await post("/api/team/sync", { key: rLic.key, device: rLic.device, invoices: [], orders: [{ id: "or_test1", number: 9, date: today, store: "X", status: "pending", lines: [], signer: "Y", signature: "", signedAt: "", updatedAt: "" }] })).json();
    check(offSync.ok && offSync.storedOrders.length === 0, "without Pro, the server doesn't take shelf orders");
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
    const shot = (key, device, extra = {}) => post("/api/pro/shelf", { key, device, image: "A".repeat(200), mime: "image/jpeg", products: ["Mango Juice"], today, ...extra });
    const statuses = [];
    for (let i = 0; i < 21; i++) statuses.push((await shot(limitKey, limitDev)).status);
    const over = await shot(limitKey, limitDev);
    const overMsg = (await over.json()).error;
    check(statuses.slice(0, 20).every((x) => x === 200) && statuses[20] === 429 && over.status === 429 && overMsg === "You've reached today's 20 shelf checks. More are available tomorrow.",
      "each rep can check 20 shelf photos a day; the 21st gets “You've reached today's 20 shelf checks. More are available tomorrow.”", `${statuses.filter((x) => x === 200).length} ok · ${overMsg}`);
    const otherRep = await shot(team.repLinks[0].split("k=")[1], rLicMp.device);
    check(otherRep.status === 200, "…it's per rep: another rep in the same company can still check", `HTTP ${otherRep.status}`);
    const tomorrow = (() => { const d = new Date(`${today}T12:00:00`); d.setDate(d.getDate() + 1); return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`; })();
    check((await shot(limitKey, limitDev, { today: tomorrow })).status === 200, "…and the next day (by the phone's own date) the rep can check again");
    // A solo business counts as one rep: its phones share the 20.
    await post("/api/console/pro", { id: solo.buyer.id, pro: true, reps: 1, discountPct: 0 }, token);
    const soloDev2 = "e".repeat(32);
    await post("/api/activate", { key: solo.buyer.id, device: soloDev2 });
    let soloOk = 0, soloLast = null;
    for (let i = 0; i < 21; i++) { soloLast = await shot(solo.buyer.id, soloDev2); if (soloLast.status === 200) soloOk++; }
    const firstPhone = await shot(sLicMp.key, sLicMp.device);
    check(soloLast.status === 429 && soloOk < 20 && firstPhone.status === 429, "a solo business counts as one rep: its two phones share the same 20 a day (the first phone's checks already counted)", `${soloOk} more on the 2nd phone`);
    const { shelfCount } = await import(path.join(APP, "worker", "shelf.js"));
    const noKey = await shelfCount({}, { image: "x", mime: "image/jpeg", products: ["A"] });
    check(noKey.error === "setup" && /isn't set up/.test(noKey.message), "without a Gemini key, shelf photo says it isn't set up (nothing breaks)");

    // ── Terms ───────────────────────────────────────────────────────────────────────────────────────────────────
    const T = await (await browser.newContext({ ...PHONE })).newPage();
    await T.goto(`${BASE}/terms`);
    const terms = (await T.textContent("#marlon-pro")).replace(/\s+/g, " ");
    check(/\$25 \(US dollars\) per rep, per month/.test(terms) && /same automatic team discount as regular Marlon/.test(terms) && /5–9 reps ?10% off/.test(terms) && /100\+ reps ?30% off/.test(terms) && /special deal .* on top of the team discount/.test(terms) && /billed monthly, in advance, for every rep place/.test(terms) && /cancel Marlon Pro at any time/.test(terms),
      "the Terms page has a Marlon Pro section: price with the team discount table, per-rep monthly billing and cancellation");
    check(/adds My Products, Shelf photo, Shelf Order/.test(terms) && /up to 3 photos per product/.test(terms) && /Reps can see the list but can't change it/.test(terms) && /for your company only/.test(terms)
      && /"Unknown product"/.test(terms) && /one photo of each product \(up to 40\)/.test(terms) && /ORD-0001/.test(terms) && /Pending, Delivered or Cancelled/.test(terms) && /stored encrypted/.test(terms),
      "the Terms' Marlon Pro section covers My Products and Shelf Order (and what shelf photo sends to Google)");
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
