/**
 * The sellable copy itself, at phone size:
 *   - ships with nobody's data (no owner name, products, customers or invoices in any file);
 *   - first open: the "Marlon" splash, then the setup screen (never a blank page); nothing is sent before setup;
 *   - setup: checks what's typed, keeps a half-typed setup, then the company name shows at the top;
 *   - what leaves the phone: only a random phone id and {kind, day} counts — never names, products, prices or amounts;
 *     counts wait while offline; the business can turn them off;
 *   - Settings: business details, product prices and units can be changed later;
 *   - without a personal link the app doesn't open; two phones never see each other's data.
 */
const { chromium } = require("playwright");
const { start } = require("./serve.cjs");
const { BUSINESS, setUp, appUrl } = require("./fixture.cjs");
const fs = require("fs"), path = require("path");

const PORT = 8798, OUT = path.join(__dirname, "output"), PUBLIC = path.join(__dirname, "..", "public");
let failures = 0;
const check = (ok, name, extra = "") => { console.log(`${ok ? "PASS" : "FAIL"}  ${name}${extra ? "  — " + extra : ""}`); if (!ok) failures++; };
const KINDS = new Set(["open", "setup", "invoice", "voice", "print", "pdf", "picture"]);
const row = (page, name) => page.locator(".prod-row", { hasText: name }).first();
const dbCount = (page, store) => page.evaluate((s) => new Promise((ok) => {
  const req = indexedDB.open("marlon-invoices");
  req.onsuccess = () => { const db = req.result; if (!db.objectStoreNames.contains(s)) { ok(0); return; } const c = db.transaction(s).objectStore(s).count(); c.onsuccess = () => ok(c.result); c.onerror = () => ok(-1); };
  req.onerror = () => ok(-1);
}), store);

(async () => {
  fs.mkdirSync(OUT, { recursive: true });

  // ── Nobody's data in what's shipped ──────────────────────────────────────────────────────────────────────────
  const OWNER = /delivery invoices|marlon williams|\bwilliams\b|beetroot|cucumber|pumpkin|green juice|bammy|juicify|callaloo|grapefruit|hot pepper|\bokra\b|\blimes?\b|\blemons?\b|sarah supermarket|wellington|rose hall|brownstone/i;
  const files = (function walk(d) { return fs.readdirSync(d, { withFileTypes: true }).flatMap((e) => e.isDirectory() ? walk(path.join(d, e.name)) : [path.join(d, e.name)]); })(PUBLIC)
    .filter((f) => /\.(html|js|css|json|webmanifest|svg|txt)$/.test(f) || path.basename(f) === "_headers");
  const hits = files.flatMap((f) => (fs.readFileSync(f, "utf8").match(new RegExp(OWNER.source, "gi")) || []).map((m) => `${path.relative(PUBLIC, f)}: ${m}`));
  check(files.length > 20 && hits.length === 0, `no owner name, products, customers, addresses or 'Delivery Invoices' in any of the ${files.length} shipped files`, hits.slice(0, 8).join(" | "));
  const util = await import(path.join(PUBLIC, "js", "util.js"));
  check(Array.isArray(util.DEFAULT_PRODUCTS) && util.DEFAULT_PRODUCTS.length === 0 && util.business.name === "" && !("SELLER" in util), "no built-in products and no built-in business");

  const srv = await start(PORT);
  const browser = await chromium.launch();
  const errors = [];
  try {
    // ── First open on a new phone ──────────────────────────────────────────────────────────────────────────────
    const ctx = await browser.newContext({ viewport: { width: 390, height: 844 }, deviceScaleFactor: 2, isMobile: true, hasTouch: true });
    const page = await ctx.newPage();
    page.on("pageerror", (e) => errors.push(e.message));
    page.on("console", (m) => { if (m.type() === "error") errors.push(m.text()); });
    // Without a personal link: blocked (a shared link no longer works for everyone).
    await page.goto(`${srv.url}/`);
    await page.waitForSelector(".gate[data-reason='nolink']");
    check(await page.locator("#setup-name").count() === 0 && await page.locator("#invoice-screen").isHidden(), "without a personal link the app doesn't open (no setup, no invoices)");
    check(srv.pings.length === 0, "…and nothing is counted");
    // With the buyer's personal link.
    await page.goto(appUrl(srv, "splash"));
    await page.waitForSelector("#splash");
    const splashText = await page.evaluate(() => document.getElementById("splash").textContent.replace(/\s+/g, " ").trim());
    check(splashText === "Marlon", "first open from the personal link: the opening animation shows only 'Marlon'", JSON.stringify(splashText));
    await page.waitForFunction(() => document.getElementById("splash")?.classList.contains("is-burst"), null, { timeout: 3000 });
    check(await page.locator("#splash canvas.splash-sparks").count() === 1 && await page.evaluate(() => getComputedStyle(document.querySelector("#splash .splash-name svg")).animationName) === "splash-word",
      "…with the sparkle burst and the whole word appearing at once");
    await page.waitForSelector("#splash", { state: "detached", timeout: 9000 });
    const gone = await page.evaluate(() => performance.now());
    check(gone <= 2700, "…and goes into the app after about two seconds", `${gone.toFixed(0)}ms after opening`);
    check(await page.locator("#setup-name").isVisible() && await page.locator("#invoice-screen").isHidden(), "…then the setup screen (not a blank page, not someone else's invoice)");
    check(await page.title() === "Marlon", "the page is just 'Marlon' until the business names itself", await page.title());
    check(await dbCount(page, "products") === 0 && await dbCount(page, "invoices") === 0, "starts completely blank: no products, no invoices");
    check(!OWNER.test(await page.locator("body").innerText()), "nothing of the owner's anywhere on screen");
    await page.waitForTimeout(400);
    await page.screenshot({ path: path.join(OUT, "sell-1-setup.png") });

    // Checks on what's typed.
    await page.click(".setup-start");
    check(/Type your company name first/.test(await page.textContent(".setup-error")), "can't start without a company name");
    await page.fill("#setup-name", "  Island Fresh Distributors ");
    const r0 = page.locator(".setup-prow").nth(0);
    await r0.locator(".setup-pname").fill("Mango Juice");
    await r0.locator(".setup-pprice").fill("abc");
    await page.click(".setup-start");
    check(/Check the price of Mango Juice/.test(await page.textContent(".setup-error")), "a price that isn't a number is caught", await page.textContent(".setup-error"));
    await r0.locator(".setup-pprice").fill("250");
    await page.locator(".setup-prow").nth(1).locator(".setup-pprice").fill("99");
    await page.click(".setup-start");
    check(/Give each product with a price a name/.test(await page.textContent(".setup-error")), "a price with no product name is caught");
    // Half-typed, then the app is closed: what was typed is still there.
    await page.reload();
    await page.waitForSelector("#setup-name");
    check(await page.inputValue("#setup-name") === "  Island Fresh Distributors " && await page.locator(".setup-prow").nth(0).locator(".setup-pname").inputValue() === "Mango Juice", "closing the app half-way keeps what was typed (on this phone)");
    await page.locator(".setup-prow").nth(1).locator(".setup-remove").click();
    check(await page.locator(".setup-prow").count() === 2, "a product row can be removed");
    await page.click(".setup-add");
    check(await page.locator(".setup-prow").count() === 3, "'Add another product' adds a row");
    check(srv.pings.length === 0, "nothing at all is sent before the business finishes setting up", `${srv.pings.length} pings`);
    // Finish with the full made-up business.
    await page.evaluate(() => { for (const b of document.querySelectorAll(".setup-remove")) b.click(); });
    await setUp(page);
    await page.screenshot({ path: path.join(OUT, "sell-2-after-setup.png") });
    await page.waitForTimeout(300);
    check(await page.textContent("#company-name") === BUSINESS.name && await page.title() === `${BUSINESS.name} · Marlon`, "after setup: the company name is at the top", await page.textContent("#company-name"));
    const names = await page.locator(".prod-name").allTextContents();
    check(names.join("|") === BUSINESS.products.map((p) => p.name).join("|"), "their own products, in their order", names.join(", "));
    await page.screenshot({ path: path.join(OUT, "sell-3-invoice.png") });
    await page.reload();
    await page.waitForFunction(() => window.__appReady === true);
    check(await page.locator("#setup").isHidden() && await page.textContent("#company-name") === BUSINESS.name, "setup is only once: next open goes straight to invoices");
    // The opening animation plays every time the app opens, offline too.
    await page.evaluate(() => navigator.serviceWorker.ready);
    await page.waitForTimeout(500);
    await ctx.setOffline(true);
    for (let n = 1; n <= 2; n++) {
      await page.goto(`${srv.url}/?splash`);
      await page.waitForFunction(() => document.getElementById("splash")?.classList.contains("is-burst"), null, { timeout: 3000 });
      const played = await page.locator("#splash canvas.splash-sparks").count() === 1;
      await page.waitForSelector("#splash", { state: "detached", timeout: 6000 });
      check(played && await page.textContent("#company-name") === BUSINESS.name, `opening ${n} with no internet: the sparkle animation plays, then the app`);
    }
    await ctx.setOffline(false);

    // ── What leaves the phone ──────────────────────────────────────────────────────────────────────────────────
    await page.waitForFunction(() => true, null, { timeout: 1500 }).catch(() => {});
    for (let i = 0; i < 20 && srv.pings.length === 0; i++) await page.waitForTimeout(150);
    const bodies = srv.pings.map((p) => p.body);
    const raw = srv.pings.map((p) => p.raw).join("\n");
    const events = bodies.flatMap((b) => b.events || []);
    check(bodies.length > 0 && bodies.every((b) => JSON.stringify(Object.keys(b).sort()) === '["device","events"]'), "each count message holds only a phone id and the counts", JSON.stringify(Object.keys(bodies[0] || {})));
    check(bodies.every((b) => /^[0-9a-f]{32}$/.test(b.device)) && new Set(bodies.map((b) => b.device)).size === 1, "the phone id is a random number made on this phone", bodies[0]?.device);
    check(events.every((e) => JSON.stringify(Object.keys(e).sort()) === '["day","kind"]' && KINDS.has(e.kind) && /^\d{4}-\d{2}-\d{2}$/.test(e.day)), "each count is just what happened and the day", JSON.stringify(events.slice(0, 3)));
    check(events.some((e) => e.kind === "setup") && events.some((e) => e.kind === "open"), "counted: one business set up, the app opened", events.map((e) => e.kind).join(","));
    const secrets = [BUSINESS.name, "Island", "Harbour", "555", ...BUSINESS.products.map((p) => p.name), "250", "1500"];
    check(!secrets.some((s) => raw.includes(s)), "no company name, address, phone, product or price ever goes out", raw.slice(0, 160));
    check(srv.pings.every((p) => !p.headers.cookie), "no cookies are sent with the counts");

    // Counts wait while offline, then go.
    // Let any counts from earlier steps finish arriving first.
    for (let quiet = 0, n = srv.pings.length; quiet < 6; ) { await page.waitForTimeout(100); if (srv.pings.length === n) quiet++; else { n = srv.pings.length; quiet = 0; } }
    const before = srv.pings.length;
    await ctx.setOffline(true);
    await page.fill("#store", "Bay Market");
    await row(page, "Mango Juice").locator(".prod-check").click();
    await page.waitForTimeout(1200);
    const queued = await page.evaluate(async () => (await (await import("/js/db.js")).settings.get("usageQueue", [])).map((e) => e.kind));
    check(srv.pings.length === before && queued.includes("invoice"), "offline: the invoice is counted on the phone and nothing is sent", queued.join(","));
    await ctx.setOffline(false);
    await page.evaluate(() => window.dispatchEvent(new Event("online")));
    for (let i = 0; i < 30 && srv.pings.length === before; i++) await page.waitForTimeout(100);
    const sentLater = srv.pings.slice(before).flatMap((p) => p.body.events).map((e) => e.kind);
    check(sentLater.includes("invoice"), "back online: the waiting counts go", sentLater.join(","));

    // ── Settings: business details, prices, counts switch ───────────────────────────────────────────────────────
    await page.click("#owner-link");
    await page.waitForSelector(".dash-key");
    const pin = async () => { for (const d of "2580") await page.locator(`.dash-key[aria-label="${d}"]`).click(); };
    await pin();
    await page.getByRole("button", { name: "Continue" }).click();
    await page.waitForSelector("text=Enter the same PIN again");
    await pin();
    await page.waitForSelector(".dash-kpi", { timeout: 8000 });
    check(await page.textContent(".dash-kicker") === BUSINESS.name, "the owner dashboard is the business's own", await page.textContent(".dash-kicker"));
    await page.getByRole("tab", { name: "Settings" }).click();
    await page.waitForSelector(".dash-business");
    check(await page.inputValue(".dash-business input[aria-label='Company name']") === BUSINESS.name && await page.inputValue(".dash-business textarea[aria-label='Address']") === BUSINESS.address
      && await page.inputValue(".dash-business input[aria-label='Phone']") === BUSINESS.phone, "Settings shows the business details from setup");
    const labels = await page.locator(".dash-prow-price").allTextContents();
    check(labels.slice(0, 2).join(" | ") === "$250.00 each | $250.00 each" && labels[6] === "$120.00 per lb" && labels[4] === "no price yet" && labels[8] === "$480.00 per dozen" && labels[10] === "$1,500.00 per bag",
      "each product shows its usual price and unit", labels.join(" | "));
    await page.fill(".dash-business input[aria-label='Company name']", "Island Fresh Ltd");
    await page.fill(".dash-business input[aria-label='Phone']", "876 555 0199");
    await page.click(".dash-business button[type=submit]");
    await page.waitForTimeout(300);
    // Change a price and add a product.
    await page.locator(".dash-prow", { hasText: "Mango Juice" }).locator(".dash-prow-main").click();
    await page.locator(".dash-prow", { hasText: "Mango Juice" }).locator("[data-act='rename']").click();
    await page.fill(".dash-rename .dash-pprice", "275");
    await page.click(".dash-rename button[type=submit]");
    await page.waitForTimeout(300);
    await page.fill(".dash-add-product input[aria-label='New product name']", "Plantain Chips");
    await page.fill(".dash-add-product .dash-pprice", "2400");
    await page.selectOption(".dash-add-product .dash-punit", "dozen");
    await page.click(".dash-add-product button[type=submit]");
    await page.waitForTimeout(300);
    const labels2 = await page.locator(".dash-prow", { hasText: "Mango Juice" }).locator(".dash-prow-price").textContent();
    const chips = await page.locator(".dash-prow", { hasText: "Plantain Chips" }).locator(".dash-prow-price").textContent();
    check(labels2 === "$275.00 each" && chips === "$2,400.00 per dozen", "a price can be changed and a product added with its price and unit", `${labels2} · ${chips}`);
    await page.locator(".dash-business").scrollIntoViewIfNeeded();
    await page.screenshot({ path: path.join(OUT, "sell-4-settings.png") });
    // Counts switch off: nothing more is sent.
    await page.locator(".dash-usage-box").scrollIntoViewIfNeeded();
    check(await page.locator(".dash-usage-box").isChecked(), "anonymous counts are on unless the business turns them off");
    await page.locator(".dash-usage-box").click();
    await page.waitForTimeout(200);
    await page.screenshot({ path: path.join(OUT, "sell-5-usage-switch.png") });
    const afterOff = srv.pings.length;
    await page.locator(".dash-close, [aria-label='Close'], .dash-back").first().click().catch(() => {});
    await page.goto(`${srv.url}/`);
    await page.waitForFunction(() => window.__appReady === true);
    check(await page.textContent("#company-name") === "Island Fresh Ltd", "the new company name is at the top", await page.textContent("#company-name"));
    await page.click("#new-btn").catch(() => {});
    await page.waitForTimeout(300);
    const pay = page.locator("dialog.pay .pay-skip");
    if (await pay.count()) await pay.click();
    await page.waitForTimeout(300);
    await row(page, "Mango Juice").locator(".prod-check").click();
    check(await row(page, "Mango Juice").locator(".price-input").inputValue() === "275", "a new invoice uses the changed price", await row(page, "Mango Juice").locator(".price-input").inputValue());
    await row(page, "Plantain Chips").locator(".prod-check").click();
    check(await row(page, "Plantain Chips").locator(".unit-select").inputValue() === "dozen" && await row(page, "Plantain Chips").locator(".price-input").inputValue() === "2400", "…and the new product, by the dozen at its price");
    await page.waitForTimeout(1500);
    check(srv.pings.length === afterOff, "with counts off, nothing is sent (opening, invoices)", `${srv.pings.length - afterOff} new`);
    check(JSON.stringify(await page.evaluate(async () => (await import("/js/db.js")).settings.get("usageQueue", []))) === "[]", "…and nothing waits to be sent later");
    const link = await page.evaluate(async () => { const c = await import("/js/codec.js"); const db = await import("/js/db.js"); await new Promise((r) => setTimeout(r, 700)); return c.invoiceToUrl(await db.invoices.get(await db.settings.get("currentId"))); });
    check(/#2~Island\+Fresh\+Ltd~876\+555\+0199~/.test(link), "new QR links carry the changed name and phone", link.slice(link.indexOf("#"), link.indexOf("#") + 40));

    // ── A second phone (another of the buyer's devices) ────────────────────────────────────────────────────────────────────────
    const other = await browser.newContext({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true });
    const p2 = await other.newPage();
    await p2.goto(appUrl(srv));
    await p2.waitForFunction(() => window.__appReady === true);
    check(await p2.locator("#setup-name").isVisible() && await dbCount(p2, "products") === 0 && !(await p2.locator("body").innerText()).includes("Island Fresh"), "another phone starts blank and sees nothing of the first business");
    await setUp(p2, { name: "Hilltop Bakery", address: "", phone: "", products: [{ name: "Bulla Cake", price: "120", unit: "each" }] });
    check(await p2.textContent("#company-name") === "Hilltop Bakery" && await p2.locator(".prod-row").count() === 1, "…and sets up its own business");
    await page.reload();
    await page.waitForFunction(() => window.__appReady === true);
    check(await page.textContent("#company-name") === "Island Fresh Ltd" && await page.locator(".prod-row", { hasText: "Bulla Cake" }).count() === 0, "the first phone still has only its own business");
    await other.close();
    check(errors.length === 0, "no console errors", errors.join(" | "));
    await ctx.close();
  } finally {
    await browser.close();
    await srv.close();
  }
  console.log(failures ? `\n${failures} check(s) failed` : "\nAll sellable checks passed");
  process.exit(failures ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
