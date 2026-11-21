/**
 * Marlon Pay, end to end: the real Marlon Pay Worker and the real Marlon Worker (for the maker's console and the
 * Marlon invoice page), both under `wrangler dev` with fresh local storage, and the app at phone size.
 * Covers device-locked links, suppliers, paying + signing, locked records, offline saving and sync, correction notes,
 * the owner dashboard and exports, staff links, privacy between stores, encryption at rest, the console section, and
 * the hand-off from a Marlon invoice.   Usage: node tests/pay.test.cjs
 */
const { chromium } = require("playwright");
const { spawn, spawnSync } = require("child_process");
const path = require("path"), fs = require("fs"), os = require("os"), crypto = require("crypto");

const ROOT = path.join(__dirname, ".."), APP = path.join(ROOT, "..", "marlon-app"), OUT = path.join(__dirname, "output");
const WRANGLER = path.join(ROOT, "..", "chief-of-staff", "node_modules", ".bin", "wrangler");
const PAY = "http://localhost:8871", MARLON = "http://localhost:8872";
const PHONE = { viewport: { width: 390, height: 844 }, deviceScaleFactor: 2, isMobile: true, hasTouch: true };
let failures = 0;
const check = (ok, name, extra = "") => { console.log(`${ok ? "PASS" : "FAIL"}  ${name}${extra ? "  — " + extra : ""}`); if (!ok) failures++; };
const post = (base, p, body, token) => fetch(base + p, { method: "POST", headers: { "content-type": "application/json", ...(token ? { Authorization: `Bearer ${token}` } : {}) }, body: JSON.stringify(body) });
const today = (() => { const d = new Date(); return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`; })();

function startDev(cwd, port, inspector, vars, stateDir) {
  const log = [];
  const child = spawn(WRANGLER, ["dev", "--port", String(port), "--inspector-port", String(inspector), "--persist-to", stateDir, "--show-interactive-dev-session=false", "--log-level", "warn",
    ...Object.entries(vars).flatMap(([k, v]) => ["--var", `${k}:${v}`])], { cwd, env: { ...process.env, WRANGLER_SEND_METRICS: "false", CLOUDFLARE_API_TOKEN: "placeholder-not-used-locally" }, stdio: ["ignore", "pipe", "pipe"] });
  child.stdout.on("data", (d) => log.push(String(d))); child.stderr.on("data", (d) => log.push(String(d)));
  const ready = (async () => { for (let i = 0; i < 120; i++) { try { if ((await fetch(`http://localhost:${port}/`)).status) return; } catch {} await new Promise((r) => setTimeout(r, 500)); } throw new Error(`wrangler dev (${cwd}) didn't start:\n${log.join("")}`); })();
  return { ready, log, stop: () => new Promise((ok) => { child.once("exit", ok); child.kill("SIGTERM"); setTimeout(() => { child.kill("SIGKILL"); ok(); }, 5000); }) };
}
async function sign(page) {
  const c = page.locator("#sign-canvas");
  await c.scrollIntoViewIfNeeded();
  const b = await c.boundingBox();
  await page.mouse.move(b.x + 40, b.y + b.height * 0.6); await page.mouse.down();
  for (let i = 1; i <= 18; i++) await page.mouse.move(b.x + 40 + i * 14, b.y + b.height * 0.6 - Math.sin(i / 2) * 30);
  await page.mouse.up();
}
const dbAll = (page, store) => page.evaluate(async (s) => (await import("/js/db.js"))[s].all(), store);
async function pay(page, supplier, invoice, amount) {
  await page.goto(`${PAY}/#/`);
  await page.waitForSelector(".sup-btn");
  await page.locator(".sup-btn", { hasText: supplier }).first().click();
  await page.waitForSelector("#pf-invoice");
  await page.fill("#pf-invoice", invoice);
  await page.fill("#pf-amount", amount);
  await page.click("#pf-next");
  await page.waitForSelector("#sign-canvas");
  await sign(page);
  await page.waitForFunction(() => !document.getElementById("sign-done").disabled);
  await page.click("#sign-done");
  await page.waitForSelector(".rec-card");
}

(async () => {
  fs.mkdirSync(OUT, { recursive: true });
  for (const dir of [ROOT, APP]) check(spawnSync(process.execPath, [path.join(dir, "scripts", dir === ROOT ? "build.cjs" : "build-worker.cjs")], { cwd: dir }).status === 0, `${path.basename(dir)} builds`);
  const payState = fs.mkdtempSync(path.join(os.tmpdir(), "pay-")), appState = fs.mkdtempSync(path.join(os.tmpdir(), "payapp-"));
  const payDev = startDev(ROOT, 8871, 9371, { ENCRYPTION_KEY: crypto.randomBytes(32).toString("base64") }, payState);
  await payDev.ready;
  const appDev = startDev(APP, 8872, 9372, { PAY_ORIGIN: PAY }, appState);
  const browser = await chromium.launch();
  const errors = [];
  const watch = (page, who) => page.on("pageerror", (e) => errors.push(`${who}: ${e.message}`));
  try {
    await appDev.ready;
    // ── The maker's console creates a store ─────────────────────────────────────────────────────────────────────
    const token = (await (await post(MARLON, "/api/console/claim", { passcode: "pay-test-passcode" })).json()).token;
    const made = await (await post(MARLON, "/api/console/pay", { name: "Hill Top Grocery", places: 2 }, token)).json();
    check(made.connected && made.store.name === "Hill Top Grocery" && made.store.ownerLink.startsWith(`${PAY}/?k=`) && made.store.paid === false, "the maker's console creates a Marlon Pay store with an owner link (unpaid to start)");
    const ownerLink = made.store.ownerLink, storeId = made.store.id;
    const other = (await (await post(MARLON, "/api/console/pay", { name: "Corner Shop", places: 0 }, token)).json()).store;

    // ── Owner device ────────────────────────────────────────────────────────────────────────────────────────────
    const octx = await browser.newContext({ ...PHONE, acceptDownloads: true });
    await octx.addInitScript((pay) => { try { localStorage.setItem("marlon.payOrigin", pay); } catch {} }, PAY);
    const O = await octx.newPage(); watch(O, "owner");
    await O.goto(ownerLink);
    await O.waitForSelector("#sup-add");
    check(/Hill Top Grocery/.test(await O.textContent(".brand")) && await O.locator("#nav-owner").count() === 1 && new URL(O.url()).search === "", "the owner link opens Marlon Pay for the store (with the Dashboard), and the link is removed from the address bar");
    await O.screenshot({ path: path.join(OUT, "pay-1-first-open.png") });
    // Suppliers: add, edit, no duplicates, archive.
    for (const [n, p] of [["Island Fresh Distributors", "+1 876 555 0101"], ["Bay Foods", ""], ["Coastline Juices", "876 555 0199"]]) {
      await O.click("#sup-add"); await O.fill("#sf-name", n); await O.fill("#sf-phone", p); await O.click("#sf-save"); await O.waitForSelector("#sup-add");
    }
    check((await O.locator(".sup-btn").count()) === 3, "suppliers are saved once (name, phone, notes) and shown as big buttons", String(await O.locator(".sup-btn").count()));
    await O.click("#sup-add"); await O.fill("#sf-name", "bay foods"); await O.click("#sf-save");
    await O.waitForSelector(".error:not([hidden])");
    check(/already have a supplier called Bay Foods/.test(await O.textContent(".error")), "the same supplier can't be added twice");
    await O.goto(`${PAY}/#/`);
    await O.locator(".sup-item", { hasText: "Bay Foods" }).locator(".sup-edit").click();
    await O.fill("#sf-notes", "Delivers Tuesdays"); await O.fill("#sf-phone", "+1 876 555 0177"); await O.click("#sf-save"); await O.waitForSelector("#sup-add");
    check(/\+1 876 555 0177/.test(await O.textContent(".sup-item:has-text('Bay Foods')")), "a supplier can be edited");
    await O.locator(".sup-item", { hasText: "Coastline Juices" }).locator(".sup-edit").click();
    await O.click("#sf-archive"); await O.click("#confirm-yes"); await O.waitForSelector("#sup-add");
    check(await O.locator(".sup-btn", { hasText: "Coastline Juices" }).count() === 0 && await O.locator("#sup-archived").count() === 1, "archiving a supplier takes them out of the list (records are kept)");
    await O.fill("#sup-search", "island");
    check(await O.locator(".sup-btn").count() === 1, "search finds a supplier by name");
    await O.fill("#sup-search", "");
    await O.evaluate(() => window.__paySync());
    await O.screenshot({ path: path.join(OUT, "pay-2-suppliers.png") });

    // ── Staff link: locked to the first device ────────────────────────────────────────────────────────────────
    await O.click("#nav-staff");
    await O.waitForSelector("#st-name");
    await O.fill("#st-name", "Andre"); await O.click("#st-add");
    await O.waitForSelector(".staff .staff-link");
    const staffLink = await O.inputValue(".staff .staff-link");
    check(/Added Andre/.test(await O.textContent(".ok-msg")) && staffLink.startsWith(`${PAY}/?k=`), "the owner adds a staff member and gets their own link");
    const actx = await browser.newContext({ ...PHONE });
    const A = await actx.newPage(); watch(A, "staff");
    await A.goto(staffLink);
    await A.waitForSelector("#sup-add");
    await A.evaluate(() => window.__paySync());
    await A.goto(`${PAY}/#/`); await A.waitForSelector(".sup-btn");
    check(await A.locator("#nav-owner").count() === 0 && await A.locator(".sup-btn").count() === 2, "the staff link opens Marlon Pay without the dashboard, with the store's suppliers");
    const bctx = await browser.newContext({ ...PHONE });
    const Bp = await bctx.newPage();
    await Bp.goto(staffLink);
    await Bp.waitForFunction(() => { const t = document.querySelector(".gate h1")?.textContent || ""; return t && !/Setting up|Marlon Pay$/.test(t); });
    check(/can't be used here/.test(await Bp.textContent(".gate h1")) && /already in use on another device/.test(await Bp.textContent(".gate")), "a second device opening the same staff link is turned away");

    // ── Paying a supplier: details, signature, Done ────────────────────────────────────────────────────────────
    await A.locator(".sup-btn", { hasText: "Island Fresh" }).click();
    await A.waitForSelector("#pf-date");
    check(await A.inputValue("#pf-date") === today, "the date starts as today");
    await A.click("#pf-next");
    check(/invoice number/.test(await A.textContent(".pf-error")), "it asks for the invoice number");
    await A.fill("#pf-invoice", "INV-101"); await A.fill("#pf-amount", "abc"); await A.click("#pf-next");
    check(/amount paid/.test(await A.textContent(".pf-error")), "and a real amount");
    await A.fill("#pf-amount", "1,250.50"); await A.click("#pf-next");
    await A.waitForSelector("#sign-canvas");
    check(/\$1,250\.50/.test(await A.textContent(".sign-screen h1")) && /I, Island Fresh Distributors, received this cash payment for invoice INV-101/.test(await A.textContent(".sign-what")) && await A.locator("#sign-done").isDisabled(),
      "the signing screen shows the amount and what the supplier is signing for; Done waits for a signature");
    await sign(A);
    await A.screenshot({ path: path.join(OUT, "pay-3-signing.png") });
    await A.click("#sign-done");
    await A.waitForSelector(".rec-card");
    check(/Saved and locked/.test(await A.textContent("main h1")) && await A.locator(".rec-sig img").count() === 1 && /Locked/.test(await A.textContent(".rec-lock")) && /Andre/.test(await A.textContent(".rec-card")),
      "Done saves a locked record with the signature and who paid");
    await A.screenshot({ path: path.join(OUT, "pay-4-saved.png") });
    await A.evaluate(() => window.__paySync());
    let aRecs = await dbAll(A, "payouts");
    check(aRecs.length === 1 && aRecs[0].synced === true && aRecs[0].amountCents === 125050, "with signal, the record is sent to the store straight away");

    // ── Offline: saved on the device, sent when the signal is back ─────────────────────────────────────────────
    await actx.setOffline(true);
    await pay(A, "Bay Foods", "B-77", "300");
    check(/Saved on this device/.test(await A.textContent("main")), "offline: Done still saves the record on the device");
    await A.reload();
    await A.waitForSelector("#sync-pill");
    check(/1 waiting to send/.test(await A.textContent("#sync-pill")), "offline: after reloading the app, the record is still there, waiting to send", await A.textContent("#sync-pill"));
    await A.goto(`${PAY}/#/records`); await A.waitForSelector(".rec-row");
    check(/waiting to send/.test(await A.textContent(".rec-list")), "the records list shows it's waiting to send");
    await actx.setOffline(false);
    await A.evaluate(() => window.__paySync());
    aRecs = await dbAll(A, "payouts");
    check(aRecs.length === 2 && aRecs.every((p) => p.synced), "back online: it sends itself, nothing lost");

    // ── Locked: no way to change or delete a signed record ─────────────────────────────────────────────────────
    const first = aRecs.find((p) => p.invoiceNo === "INV-101");
    const recreate = await A.evaluate(async (p) => { try { await (await import("/js/db.js")).payouts.create(p); return "saved"; } catch (e) { return e.message; } }, first);
    check(/already saved and locked/.test(recreate), "on the device, a signed record can't be saved over", recreate);
    const aLic = await A.evaluate(async () => (await import("/js/db.js")).meta.get("license"));
    const forged = await (await post(PAY, "/api/sync", { key: aLic.key, device: aLic.device, cursor: 0, suppliers: [], notes: [], payouts: [{ ...first, amountCents: 1000, synced: undefined }] })).json();
    check(forged.rejected.payouts[0]?.reason === "locked" && forged.stored.payouts.length === 0, "the server refuses a changed copy of a signed record (amount $12,505 → $10)");
    await A.goto(`${PAY}/#/record/${first.id}`); await A.waitForSelector(".rec-card");
    check(await A.locator(".rec-card button, main button:has-text('Delete'), main button:has-text('Edit')").count() === 0, "a record has no Edit or Delete button");
    check((await post(PAY, "/api/payouts/delete", { key: aLic.key, device: aLic.device, id: first.id })).status === 404, "and the server has no way to delete one");

    // ── Owner: dashboard, record with signature, correction note ───────────────────────────────────────────────
    await O.evaluate(() => window.__paySync());
    await O.goto(`${PAY}/#/`); await O.waitForSelector(".sup-btn");
    await pay(O, "Island Fresh", "INV-102", "80");
    await O.evaluate(() => window.__paySync());
    await O.click("#nav-owner");
    await O.waitForSelector("#od-today");
    const tiles = { today: await O.textContent("#od-today strong"), week: await O.textContent("#od-week strong"), month: await O.textContent("#od-month strong") };
    check(tiles.today === "$1,630.50" && tiles.week === "$1,630.50" && tiles.month === "$1,630.50", "dashboard: cash paid out today, this week and this month ($1,250.50 + $300 + $80)", JSON.stringify(tiles));
    const bySup = (await O.locator("#od-by-supplier tbody tr").allTextContents()).map((t) => t.replace(/\s+/g, " "));
    const byStaff = (await O.locator("#od-by-staff tbody tr").allTextContents()).map((t) => t.replace(/\s+/g, " "));
    check(bySup[0] === "Island Fresh Distributors2$1,330.50" && bySup[1] === "Bay Foods1$300.00", "totals by supplier", JSON.stringify(bySup));
    check(byStaff[0] === "Andre2$1,550.50" && byStaff[1] === "Owner1$80.00", "totals by staff member", JSON.stringify(byStaff));
    await O.fill("#od-from", "2020-01-01"); await O.locator("#od-from").dispatchEvent("change");
    await O.fill("#od-to", "2020-12-31"); await O.locator("#od-to").dispatchEvent("change");
    await O.waitForFunction(() => /0 payments/.test(document.getElementById("od-range-total")?.textContent || ""), null, { timeout: 5000 }).catch(() => {});
    check(/\$0\.00 paid in 0 payments/.test(await O.textContent("#od-range-total")), "any date range: dates with no payments show $0.00");
    await O.fill("#od-to", today); await O.locator("#od-to").dispatchEvent("change");
    await O.waitForTimeout(300);
    await O.fill("#od-from", today); await O.locator("#od-from").dispatchEvent("change");
    await O.waitForFunction(() => /3 payments/.test(document.getElementById("od-range-total")?.textContent || ""), null, { timeout: 5000 }).catch(() => {});
    check(/\$1,630\.50 paid in 3 payments/.test(await O.textContent("#od-range-total")), "any date range: today = $1,630.50 in 3 payments");
    await O.screenshot({ path: path.join(OUT, "pay-5-dashboard.png"), fullPage: true });
    await O.fill("#od-search", "INV-101");
    check(await O.locator("#od-results .rec-row").count() === 1, "search by invoice number");
    await O.fill("#od-search", "bay");
    check(await O.locator("#od-results .rec-row").count() === 1, "search by supplier");
    await O.fill("#od-search", today);
    check(await O.locator("#od-results .rec-row").count() === 3, "search by date");
    await O.fill("#od-search", "INV-101");
    await O.click("#od-results .rec-row");
    await O.waitForSelector(".rec-sig img");
    check((await O.getAttribute(".rec-sig img", "src")).startsWith("data:image/png;base64,"), "the owner opens a staff member's record and sees its signature (decrypted from the store's server copy)");
    await O.fill("#note-text", "Supplier says the invoice number is INV-110.");
    await O.click("#note-add"); await O.click("#confirm-yes");
    await O.waitForSelector(".rec-note");
    await O.evaluate(() => window.__paySync());
    check(/INV-110/.test(await O.textContent(".rec-note")) && /1,250\.50/.test(await O.textContent(".rec-amt")), "the owner adds a dated correction note; the record itself is unchanged");
    await O.screenshot({ path: path.join(OUT, "pay-6-record-note.png"), fullPage: true });
    const staffNote = await (await post(PAY, "/api/sync", { key: aLic.key, device: aLic.device, cursor: 0, suppliers: [], payouts: [], notes: [{ id: "nt_staff1", payoutId: first.id, text: "staff note" }] })).json();
    check(staffNote.rejected.notes[0]?.reason === "owner", "staff can't add correction notes (owner only)");

    // ── Exports for the accountant ────────────────────────────────────────────────────────────────────────────
    await O.click("#nav-owner"); await O.waitForSelector("#od-csv");
    const [csvDl] = await Promise.all([O.waitForEvent("download"), O.click("#od-csv")]);
    const csv = fs.readFileSync(await csvDl.path(), "utf8");
    check(/Hill Top Grocery — cash paid out/.test(csv) && /,Island Fresh Distributors,INV-101,1250\.50,Andre,/.test(csv) && /INV-110/.test(csv) && /Total,,,,1630\.50/.test(csv), "Download CSV: every payment with supplier, invoice, amount, staff, correction notes and the total", csvDl.suggestedFilename());
    const [pdfDl] = await Promise.all([O.waitForEvent("download"), O.click("#od-pdf")]);
    const pdf = fs.readFileSync(await pdfDl.path());
    check(pdf.subarray(0, 5).toString() === "%PDF-" && /\/Count 1/.test(pdf.toString("latin1")) && pdf.length > 50000, "Download PDF: a PDF of the payments with their signatures", `${pdf.length} bytes`);
    const many = await O.evaluate(async () => { const { pagesToPdfBlob } = await import("/js/pdf.js"); const c = () => { const x = document.createElement("canvas"); x.width = 200; x.height = 260; return x; }; return new TextDecoder("latin1").decode(await (await pagesToPdfBlob([c(), c(), c()])).arrayBuffer()).match(/\/Count (\d+)/)[1]; });
    check(many === "3", "long reports run over several pages", many);

    // ── Encryption at rest and privacy between stores ──────────────────────────────────────────────────────────
    const files = []; const walk = (d) => { for (const e of fs.readdirSync(d, { withFileTypes: true })) { const p = path.join(d, e.name); if (e.isDirectory()) walk(p); else files.push(p); } }; walk(payState);
    check(files.length > 0 && !files.some((f) => fs.readFileSync(f).includes("iVBORw0KGgo")), "signatures are stored encrypted (no signature picture readable in the server's storage files)", `${files.length} files searched`);
    const otherLic = { key: other.ownerLink.split("k=")[1], device: "c".repeat(32) };
    await post(PAY, "/api/activate", otherLic);
    const otherSync = await (await post(PAY, "/api/sync", { ...otherLic, cursor: 0, suppliers: [], payouts: [], notes: [] })).json();
    const otherSig = await (await post(PAY, "/api/signatures", { ...otherLic, ids: [first.id] })).json();
    check(otherSync.changes.suppliers.length === 0 && otherSync.changes.payouts.length === 0 && Object.keys(otherSig.signatures).length === 0, "each store's data is private: another store sees none of its suppliers, records or signatures");
    check((await post(PAY, "/api/signatures", { key: aLic.key, device: aLic.device, ids: [first.id] })).status === 403, "staff can't download signatures (owner only)");

    // ── Switching off a staff link ────────────────────────────────────────────────────────────────────────────
    await O.click("#nav-staff"); await O.waitForSelector(".st-off");
    await O.click(".st-off");
    await O.waitForSelector(".staff.is-off");
    await A.goto(`${PAY}/#/`);
    await A.evaluate(() => window.__paySync());
    await A.waitForSelector(".gate h1");
    check(/switched off/.test(await A.textContent(".gate h1")) && /Records already on this device are kept/.test(await A.textContent(".gate")), "the owner switches off a staff link: that device stops, its records are kept");
    check((await dbAll(A, "payouts")).length === 2, "…and its 2 records are still on the device");

    // ── The maker's console: stores, paid/unpaid, counts, problems ─────────────────────────────────────────────
    const C = await (await browser.newContext({ ...PHONE })).newPage(); watch(C, "console");
    await C.goto(`${MARLON}/console`);
    await C.evaluate((t) => sessionStorage.setItem("marlon.console", t), token);
    await C.reload();
    await C.waitForSelector(".con-pay-store");
    const card = C.locator(".con-pay-store", { hasText: "Hill Top Grocery" });
    const cardText = (await card.textContent()).replace(/\s+/g, " ");
    check(/Unpaid/.test(cardText) && /Suppliers ?2/.test(cardText) && /Payments signed ?3 in all · 3 in 30 days/.test(cardText) && /2 devices in use/.test(cardText) && /1 of 2 staff places named/.test(cardText), "the console lists the store with its counts (active suppliers, payments, devices, staff places)", cardText.slice(0, 200));
    await card.locator(".con-pay-problems summary").click();
    const probs = await card.locator(".con-pay-problems").textContent();
    check(/second device tried to open a link/.test(probs) && /changed copy of a signed record/.test(probs) && /switched-off staff link/.test(probs), "the console shows the store's problems (second device, changed record refused, switched-off link)");
    check(!/Island Fresh|INV-101|1,250|Andre/.test(cardText + probs), "the console never shows the store's supplier names, invoice numbers, amounts or staff names");
    await C.screenshot({ path: path.join(OUT, "pay-7-console.png"), clip: await card.boundingBox() });
    await card.locator("button", { hasText: "Mark paid" }).click();
    await C.waitForFunction(() => [...document.querySelectorAll(".con-pay-store")].some((c) => /Hill Top/.test(c.textContent) && c.querySelector(".pay-paid-badge")?.textContent === "Paid" && /Mark unpaid/.test(c.textContent)));
    check(true, "the console's paid/unpaid switch marks the store Paid");
    await C.fill("#pay-name", "Sunrise Mart"); await C.fill("#pay-places", "1"); await C.click("#pay-create");
    await C.waitForSelector("#pay-created");
    check(/Owner link for Sunrise Mart/.test(await C.textContent("#pay-created")), "a new store can be created from the console, with its owner link");
    await C.locator(".con-pay-store", { hasText: "Sunrise Mart" }).locator("button", { hasText: "Switch store off" }).click();
    await C.waitForFunction(() => [...document.querySelectorAll(".con-pay-store")].some((c) => /Sunrise Mart/.test(c.textContent) && /Switched off/.test(c.textContent)));
    const sun = (await (await fetch(`${MARLON}/api/console/pay`, { headers: { Authorization: `Bearer ${token}` } })).json()).stores.find((s) => s.name === "Sunrise Mart");
    const sunTry = await post(PAY, "/api/activate", { key: sun.ownerLink.split("k=")[1], device: "d".repeat(32) });
    check(sunTry.status === 403 && /switched off for this store/.test((await sunTry.json()).error), "a store switched off in the console can't be used");

    const terms = await (await fetch(`${MARLON}/terms`)).text();
    check(/id="marlon-pay"/.test(terms) && /one-time payment, with no monthly plan/.test(terms) && /the record is locked: nobody can change or delete it/.test(terms) && /id="marlon-pro"/.test(terms) && /\$25<\/strong> \(US dollars\) per rep, per month/.test(terms),
      "the terms page has a Marlon Pay section, and the Marlon Pro section is still there unchanged");

    // ── From Marlon: the rep's invoice opens in Marlon Pay, filled in ──────────────────────────────────────────
    const invUrl = await O.evaluate(async (m) => { const r = await fetch(`${m}/js/codec.js`); void r; return null; }, MARLON).catch(() => null); void invUrl;
    const V = await octx.newPage(); watch(V, "marlon invoice page");
    await V.goto(`${MARLON}/v`);
    const vUrl = await V.evaluate(async () => (await import("/js/codec.js")).invoiceToUrl({ seller: "Coastline Foods", sellerPhone: "+1 876 555 0300", number: 42, date: new Date().toISOString().slice(0, 10), store: "Hill Top Grocery",
      items: [{ name: "Mango Juice", qty: 24, unit: "each", price: 2.5 }, { name: "Eggs", qty: 5, unit: "dozen", price: 4.8 }], signature: "x" }));
    await V.goto(vUrl);
    await V.waitForSelector("#pay-link");
    check(/Record it in Marlon Pay/.test(await V.textContent("#pay-link")), "a Marlon invoice page has “Paying cash? Record it in Marlon Pay”");
    await V.screenshot({ path: path.join(OUT, "pay-8-marlon-invoice.png"), fullPage: true });
    await V.click("#pay-link");
    await V.waitForSelector("#pf-invoice");
    check(await V.inputValue("#pf-invoice") === "0042" && await V.getAttribute("#pf-invoice", "readonly") !== null && await V.inputValue("#pf-amount") === "84.00" && /From Marlon/.test(await V.textContent(".from-marlon")) && /Pay Coastline Foods/.test(await V.textContent("main h1")),
      "it opens Marlon Pay with the supplier (added automatically), invoice number and total ($84.00) filled in");
    await V.screenshot({ path: path.join(OUT, "pay-9-from-marlon.png") });
    await V.click("#pf-next"); await V.waitForSelector("#sign-canvas"); await sign(V);
    await V.waitForFunction(() => !document.getElementById("sign-done").disabled);
    await V.click("#sign-done"); await V.waitForSelector(".rec-card");
    const fm = (await dbAll(V, "payouts")).find((p) => p.invoiceNo === "0042");
    check(fm?.fromMarlon?.seller === "Coastline Foods" && fm.fromMarlon.totalCents === 8400 && fm.amountCents === 8400 && /From Marlon/.test(await V.textContent(".rec-card")), "the supplier just signs; the record notes it came from a Marlon invoice");

    // ── Phone layout ──────────────────────────────────────────────────────────────────────────────────────────
    const small = await (await browser.newContext({ viewport: { width: 320, height: 640 }, isMobile: true, hasTouch: true })).newPage();
    await small.goto(ownerLink.replace(/k=.*/, "")); // (no link: the gate)
    for (const [pg, url] of [[O, `${PAY}/#/`], [O, `${PAY}/#/owner`], [O, `${PAY}/#/records`], [O, `${PAY}/#/staff`], [small, `${PAY}/`]]) {
      await pg.goto(url); await pg.waitForTimeout(600);
      const sw = await pg.evaluate(() => [document.documentElement.scrollWidth, innerWidth]);
      check(sw[0] <= sw[1], `no sideways scrolling at ${sw[1]} px: ${url.replace(PAY, "")}`, `${sw[0]}px`);
    }
    check(errors.length === 0, "no page errors", errors.join(" | "));
  } catch (e) {
    console.error(e); failures++;
  } finally {
    await browser.close(); await appDev.stop(); await payDev.stop();
    fs.rmSync(payState, { recursive: true, force: true }); fs.rmSync(appState, { recursive: true, force: true });
  }
  console.log(failures ? `\n${failures} check(s) failed` : "\nAll Marlon Pay checks passed");
  process.exit(failures ? 1 : 0);
})();
