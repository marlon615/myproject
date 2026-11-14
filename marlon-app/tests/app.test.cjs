/**
 * End-to-end: the real app at phone size, after a made-up business has set itself up (tests/fixture.cjs).
 * Invoice flows, list prices, signature guard, QR (decoded), print/share hand-off, owner dashboard (PIN, totals,
 * history, open), customer viewer, and full offline use.
 */
const { chromium } = require("playwright");
const { start } = require("./serve.cjs");
const { BUSINESS, setUp, appUrl } = require("./fixture.cjs");
const path = require("path");

const PORT = 8791, OUT = path.join(__dirname, "output");
let failures = 0;
const check = (ok, name, extra = "") => { console.log(`${ok ? "PASS" : "FAIL"}  ${name}${extra ? "  — " + extra : ""}`); if (!ok) failures++; };
const today = (() => { const d = new Date(); const z = new Date(d.getTime() - d.getTimezoneOffset() * 60000); return z.toISOString().slice(0, 10); })();

const MOCKS = `
  window.__printed = []; window.__shared = [];
  Object.defineProperty(navigator, "bluetooth", { value: {
    async requestDevice() { return { id: "d1", name: "PT-210", gatt: { connected: false,
      async connect() { this.connected = true; return { async getPrimaryServices() { return [{ async getCharacteristics() { return [{ uuid: "00002af1-0000-1000-8000-00805f9b34fb", properties: { write: true },
        async writeValueWithResponse(v) { window.__printed.push(v.byteLength); } }]; } }]; } }; }, disconnect() { this.connected = false; } } }; },
    async getDevices() { return []; } } });
  navigator.canShare = (d) => !!(d && d.files);
  navigator.share = async (d) => { window.__shared.push({ name: d.files[0].name, type: d.files[0].type, size: d.files[0].size }); };
  window.print = () => { window.__printCalls = (window.__printCalls || 0) + 1; };
`;

async function drawSignature(page) {
  await page.locator("#sign-canvas").scrollIntoViewIfNeeded();
  const b = await page.locator("#sign-canvas").boundingBox();
  await page.mouse.move(b.x + 40, b.y + 110);
  await page.mouse.down();
  for (let i = 1; i <= 18; i++) await page.mouse.move(b.x + 40 + i * 13, b.y + 110 - Math.sin(i / 2) * 40);
  await page.mouse.up();
}
const row = (page, name) => page.locator(".prod-row", { hasText: name }).first();
async function qrText(page) {
  return page.evaluate(() => { const c = document.querySelector("#qr-box canvas"); if (!c) return null; const x = c.getContext("2d").getImageData(0, 0, c.width, c.height); const r = window.jsQR(x.data, x.width, x.height); return r && r.data; });
}

(async () => {
  const srv = await start(PORT);
  const browser = await chromium.launch();
  const errors = [];
  try {
    const ctx = await browser.newContext({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true, bypassCSP: true });
    await ctx.addInitScript(MOCKS);
    const page = await ctx.newPage();
    page.on("pageerror", (e) => errors.push(e.message));
    page.on("console", (m) => { if (m.type() === "error") errors.push(m.text()); });
    await page.goto(appUrl(srv));
    await page.waitForFunction(() => window.__appReady === true);
    await setUp(page);
    await page.addScriptTag({ path: require.resolve("jsqr/dist/jsQR.js") });

    // Permanent brand bar: fixed, dark, outside the invoice form, never covering it.
    const bar = await page.evaluate(() => {
      const b = document.getElementById("brand-bar"), r = b.getBoundingClientRect(), cs = getComputedStyle(b);
      const svg = b.querySelector("svg"), tag = b.querySelector(".brand-tag");
      const form = document.getElementById("invoice-screen");
      return { pos: cs.position, top: r.top, h: r.height, bg: cs.backgroundColor, label: svg && svg.getAttribute("aria-label"),
        tag: tag && tag.textContent.trim(), tagColor: tag && getComputedStyle(tag).color, inForm: form.contains(b),
        firstContentTop: document.querySelector(".masthead").getBoundingClientRect().top, svgH: svg && svg.getBoundingClientRect().height };
    });
    check(bar.pos === "fixed" && bar.top === 0 && bar.h <= 64 && bar.bg === "rgb(15, 20, 17)", "slim dark brand bar fixed at the top", JSON.stringify({ h: bar.h, bg: bar.bg }));
    check(bar.label === "Marlon" && bar.svgH >= 18 && bar.tag === "Delivery Invoices" && bar.tagColor === "rgb(108, 196, 149)", "bar shows the Marlon wordmark and the green 'Delivery Invoices' line");
    check(!bar.inForm && bar.firstContentTop >= bar.h, "bar sits outside the invoice form and never covers it", `content starts at ${bar.firstContentTop}px, bar ${bar.h}px`);
    check(await page.evaluate(() => document.querySelector('meta[name="theme-color"]').content) === "#0f1411", "browser/status bar colour matches the dark bar");

    // A fresh invoice.
    check(await page.textContent(".masthead-name") === BUSINESS.name, "header shows the business's own name", await page.textContent(".masthead-name"));
    check(await page.title() === `${BUSINESS.name} · Marlon`, "the page title is the business's name", await page.title());
    check(await page.inputValue("#date") === today, "date fills in today automatically", await page.inputValue("#date"));
    check(await page.locator(".prod-row").count() === BUSINESS.products.length, `all ${BUSINESS.products.length} of the business's products listed`);
    const names = await page.locator(".prod-name").allTextContents();
    check(names.join("|") === BUSINESS.products.map((p) => p.name).join("|"), "products in the order they were typed at setup", names.join("|"));
    check(await page.textContent("#invoice-no") === "No. 0001" && await page.locator("#qr-box .qr-empty").count() === 1, "new invoice No. 0001 with a QR placeholder");
    for (const w of [390, 360]) { await page.setViewportSize({ width: w, height: 844 }); check(!(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth)), `no sideways scroll at ${w}px`); }
    await page.setViewportSize({ width: 390, height: 844 });

    await page.mouse.wheel(0, 1400); await page.waitForTimeout(300);
    check(await page.evaluate(() => document.getElementById("brand-bar").getBoundingClientRect().top === 0 && window.scrollY > 500), "brand bar stays in place while the invoice scrolls");
    await page.evaluate(() => window.scrollTo(0, 0));

    // Date can be changed.
    await page.fill("#date", "2026-11-09");
    check(await page.inputValue("#date") === "2026-11-09", "date can be changed");

    // Tick, quantities, prices, totals.
    await page.fill("#store", "Hill Top Grocery");
    await page.fill("#address", "5 Hope Road\nKingston");
    for (const n of ["Mango Juice", "Small Patty", "Yellow Yam"]) await row(page, n).locator(".prod-check").click();
    check(await row(page, "Mango Juice").locator(".price-input").inputValue() === "250", "ticking a product fills in its usual price from setup", await row(page, "Mango Juice").locator(".price-input").inputValue());
    check(await row(page, "Yellow Yam").locator(".unit-select").inputValue() === "lb" && await row(page, "Yellow Yam").locator(".price-input").inputValue() === "", "a product sold by the pound starts in pounds; one with no usual price starts empty");
    await row(page, "Mango Juice").locator(".qty-input").fill("12");
    await row(page, "Mango Juice").locator(".price-input").fill("350");
    await row(page, "Small Patty").locator(".qty-btn").nth(1).click();
    await row(page, "Small Patty").locator(".price-input").fill("150.5");
    const cuc = row(page, "Carrot Juice");
    check(await cuc.evaluate((e) => +getComputedStyle(e).opacity) < 0.5 && await cuc.locator(".prod-detail").isHidden(), "unticked products fade and hide qty/price but stay in the list");
    check(await row(page, "Mango Juice").locator(".line-total").textContent() === "$4,200.00", "line total = qty × price (a typed price replaces the usual one)");
    check(await row(page, "Small Patty").locator(".qty-input").inputValue() === "2" && await row(page, "Small Patty").locator(".line-total").textContent() === "$301.00", "stepper + decimal price");
    check(await row(page, "Yellow Yam").locator(".line-total").textContent() === "—", "missing price shows —");
    check(await page.textContent("#grand-amount") === "$4,501.00" && await page.textContent("#grand-count") === "3 items", "grand total at the bottom", await page.textContent("#grand-amount"));
    await row(page, "Yellow Yam").locator(".prod-check").click(); await row(page, "Yellow Yam").locator(".prod-check").click(); // untick, re-tick
    check(await row(page, "Yellow Yam").locator(".qty-input").inputValue() === "1", "re-ticking keeps the row usable");

    // Add a product: ticked now, kept for later invoices.
    await page.fill("#prod-add-name", "Pineapple Juice");
    await page.click("#prod-add button[type=submit]");
    await page.waitForTimeout(300);
    check(await row(page, "Pineapple Juice").evaluate((e) => e.classList.contains("is-on")), "added product appears ticked");
    await row(page, "Pineapple Juice").locator(".price-input").fill("200");

    // Autosave + reload.
    await page.waitForTimeout(900);
    check(/Saved on this phone/.test(await page.textContent("#save-status")), "autosaved on the phone");
    await page.reload(); await page.waitForFunction(() => window.__appReady === true); await page.addScriptTag({ path: require.resolve("jsqr/dist/jsQR.js") });
    check(await page.inputValue("#store") === "Hill Top Grocery" && await page.textContent("#grand-amount") === "$4,701.00" && await page.textContent("#invoice-no") === "No. 0001", "everything survives a reload", await page.textContent("#grand-amount"));
    check(await page.locator(".prod-row").count() === BUSINESS.products.length + 1, "added product stays in the list");
    check(await page.textContent(".masthead-name") === BUSINESS.name && await page.locator("#setup").isHidden(), "the business's name stays at the top and setup doesn't come back");

    // QR: link and text modes decode correctly.
    await page.waitForTimeout(400);
    const want = await page.evaluate(async () => { const c = await import("/js/codec.js"); const db = await import("/js/db.js"); return c.invoiceToUrl(await db.invoices.get(await db.settings.get("currentId"))); });
    const link = await qrText(page);
    check(link === want && /\/v#2~Island\+Fresh\+Distributors~876\+555\+0123~1~20261109~Hill\+Top\+Grocery~/.test(link), "QR decodes to the complete invoice link (with the business's name and phone)", link?.slice(0, 90));
    await page.click("#qr-toggle"); await page.waitForTimeout(100);
    const txt = await qrText(page);
    check(/^INVOICE No\. 0001\nIsland Fresh Distributors\nTel: 876 555 0123\nDate: 9 Nov 2026\nStore: Hill Top Grocery/.test(txt || "") && /TOTAL: \$4,701\.00/.test(txt || "") && !/Carrot/.test(txt || ""), "text-only QR holds the whole invoice as plain text", (txt || "").split("\n").slice(0, 4).join(" / "));
    await page.click("#qr-toggle");

    // Signature + signed-invoice guard.
    await drawSignature(page);
    await page.waitForTimeout(700);
    check(/^Signed ✓/.test(await page.textContent("#sign-status")) && await page.locator("#signed-badge").isVisible(), "customer signature captured");
    await page.reload(); await page.waitForFunction(() => window.__appReady === true); await page.addScriptTag({ path: require.resolve("jsqr/dist/jsQR.js") });
    check(/^Signed ✓/.test(await page.textContent("#sign-status")), "signature survives a reload");
    await row(page, "Scallion").locator(".prod-check").click();
    await page.waitForSelector("dialog.sheet[open]");
    check(/Remove the signature/.test(await page.textContent("dialog.sheet[open]")), "changing a signed invoice asks first");
    check(!/\bnull\b/.test(await page.locator("dialog.sheet[open]").innerText()), "question sheet has no stray 'null' text");
    await page.getByRole("button", { name: "Keep it" }).click();
    check(!(await row(page, "Scallion").evaluate((e) => e.classList.contains("is-on"))) && /^Signed/.test(await page.textContent("#sign-status")), "'Keep it' leaves the invoice and signature untouched");
    await row(page, "Scallion").locator(".prod-check").click();
    await page.getByRole("button", { name: "Change invoice" }).click();
    await page.waitForTimeout(200);
    check(await row(page, "Scallion").evaluate((e) => e.classList.contains("is-on")) && await page.textContent("#sign-status") === "Not signed yet", "'Change invoice' applies the change and removes the signature");
    await row(page, "Scallion").locator(".prod-check").click(); // untick again
    await drawSignature(page); await page.waitForTimeout(600);

    // Print + share hand-off; missing-price confirmation.
    await row(page, "Yellow Yam").scrollIntoViewIfNeeded();
    await page.click("#print-btn");
    await page.waitForSelector("dialog.sheet[open]");
    check(/1 item has no price/.test(await page.textContent("dialog.sheet[open]")), "warns before printing an item with no price");
    await page.getByRole("button", { name: "Add prices" }).click();
    // The invoice is signed, so typing a price first asks about the signature; then the price box has focus.
    await page.waitForSelector("dialog.sheet[open]");
    check(/Remove the signature/.test(await page.textContent("dialog.sheet[open]")), "'Add prices' on a signed invoice asks about the signature first");
    await page.getByRole("button", { name: "Change invoice" }).click();
    await page.waitForTimeout(150);
    check(await page.evaluate(() => document.activeElement?.closest(".prod-row")?.textContent.includes("Yellow Yam") && document.activeElement.classList.contains("price-input")), "…then the missing price box is ready to type in");
    await page.keyboard.type("90");
    await page.waitForTimeout(200);
    await drawSignature(page); await page.waitForTimeout(600);
    await page.click("#print-btn");
    await page.waitForFunction(() => window.__printed.length > 0, null, { timeout: 8000 });
    check(true, "Print sends the receipt to the Bluetooth printer", `${await page.evaluate(() => window.__printed.length)} writes`);
    await page.click("#share-pdf-btn");
    await page.waitForFunction(() => window.__shared.length > 0, null, { timeout: 8000 });
    const sh = await page.evaluate(() => window.__shared[0]);
    check(sh.type === "application/pdf" && sh.name === "Invoice-0001-Hill-Top-Grocery.pdf", "Share PDF hands over a named PDF", JSON.stringify(sh));
    await page.screenshot({ path: path.join(OUT, "app-filled.png"), fullPage: true });

    // New invoice on a signed invoice with no payment recorded: the private payment page comes first (can be skipped).
    await page.click("#new-btn");
    await page.waitForSelector("dialog.pay[open]");
    check(/Only you see this page/.test(await page.textContent("dialog.pay[open]")), "New invoice on a signed invoice offers the private payment page first");
    await page.getByRole("button", { name: "Skip for now" }).click();
    await page.waitForTimeout(400);

    // New invoice + known store fills its address.
    check(await page.textContent("#invoice-no") === "No. 0002" && await page.inputValue("#store") === "" && await page.locator(".prod-row.is-on").count() === 0, "New invoice starts clean as No. 0002");
    await page.fill("#store", "Hill Top Grocery");
    await page.waitForTimeout(100);
    check(await page.inputValue("#address") === "5 Hope Road\nKingston", "a store from before fills in its address", JSON.stringify(await page.inputValue("#address")));
    await row(page, "Yellow Yam").locator(".prod-check").click();
    check(await row(page, "Yellow Yam").locator(".price-input").inputValue() === "", "a price typed on one invoice stays on that invoice (no usual price: the next starts empty)");
    await row(page, "Mango Juice").locator(".prod-check").click();
    check(await row(page, "Mango Juice").locator(".price-input").inputValue() === "250", "…and a product with a usual price starts at that price again", await row(page, "Mango Juice").locator(".price-input").inputValue());
    await row(page, "Mango Juice").locator(".prod-check").click();
    await row(page, "Yellow Yam").locator(".price-input").fill("90");
    await page.waitForTimeout(900);

    // Owner dashboard: PIN, totals, history, open.
    await page.click("#owner-link");
    await page.waitForSelector(".dash-key");
    check(await page.locator("#invoice-screen").isHidden() && await page.locator("#brand-bar").isHidden(), "dashboard replaces the invoice screen (it keeps its own header)");
    const pin = async (digits) => { for (const d of digits) await page.locator(`.dash-key[aria-label="${d}"]`).click(); await page.waitForTimeout(150); };
    await pin("2468");
    await page.getByRole("button", { name: "Continue" }).click();
    await page.waitForSelector("text=Enter the same PIN again");
    await pin("2468"); // the confirmation submits itself at the same length
    await page.waitForSelector(".dash-kpi", { timeout: 8000 });
    const all = await page.locator('.dash-kpi[data-kpi="all"] .dash-kpi-value').textContent();
    check(all === "$4,881.00", "dashboard all-time total matches the invoices", all);
    check(!/\bnull\b|\bundefined\b|NaN/.test(await page.locator("#dashboard").innerText()), "dashboard shows no stray null/undefined/NaN text");
    await page.screenshot({ path: path.join(OUT, "app-dashboard.png"), fullPage: true });
    await page.getByRole("tab", { name: "History" }).click();
    await page.waitForSelector(".dash-row");
    check(await page.locator(".dash-row").count() === 2, "history lists both invoices");
    check(!/\bnull\b|\bundefined\b|NaN/.test(await page.locator("#dashboard").innerText()), "history shows no stray null/undefined/NaN text");
    await page.locator(".dash-row", { hasText: "No. 0001" }).click();
    await page.getByRole("button", { name: "Open and edit" }).click();
    await page.waitForFunction(() => !document.getElementById("invoice-screen").hidden);
    await page.waitForTimeout(300);
    check(await page.textContent("#invoice-no") === "No. 0001" && /^Signed/.test(await page.textContent("#sign-status")), "'Open and edit' loads that invoice");
    check(await page.locator("#brand-bar").isVisible(), "brand bar is back on the invoice screen");

    // Customer viewer from the QR link.
    const url = await page.evaluate(async () => { const c = await import("/js/codec.js"); const db = await import("/js/db.js"); return c.invoiceToUrl(await db.invoices.get(await db.settings.get("currentId"))); });
    const v = await ctx.newPage();
    v.on("pageerror", (e) => errors.push("viewer: " + e.message));
    await v.goto(url);
    await v.waitForSelector(".sheet .seller");
    const vt = (await v.textContent(".sheet")).replace(/\s+/g, " ");
    check(await v.textContent("h1.seller") === BUSINESS.name && await v.getAttribute(".seller-phone a", "href") === "tel:8765550123", "customer page opens with the business's own name and a tap-to-call phone number", `${await v.textContent("h1.seller")} · ${await v.getAttribute(".seller-phone a", "href")}`);
    check((await v.textContent(".made-with")) === "Made with Marlon" && await v.title() === `Invoice 0001 · ${BUSINESS.name}`, "…with a small 'Made with Marlon' at the foot", await v.title());
    check(/Invoice No\. 0001/.test(vt) && /Hill Top Grocery/.test(vt) && /\$4,791\.00/.test(vt) && /Signed by the customer/.test(vt) && !/Marlon Williams/.test(vt), "customer sees the full invoice from the QR link", vt.slice(0, 120));
    const labels = (await v.locator(".view-actions button").allTextContents()).map((t) => t.trim());
    check(labels.join("|") === "Save PDF|Print" && !(await v.textContent("main")).includes("Save or print"), "customer page has two buttons: Save PDF and Print", labels.join(" | "));
    await v.getByRole("button", { name: "Save PDF" }).click();
    await v.waitForFunction(() => window.__shared.length > 0, null, { timeout: 8000 });
    const vs = await v.evaluate(() => window.__shared[0]);
    check(vs.type === "application/pdf" && vs.name === "Invoice-0001-Hill-Top-Grocery.pdf" && vs.size > 20000, "Save PDF makes the invoice PDF on the customer's phone", JSON.stringify(vs));
    await v.getByRole("button", { name: "Print" }).click();
    check(await v.evaluate(() => window.__printCalls) === 1, "Print opens the phone's print option");
    // A separate browser = the customer's own phone: saving the PDF must not store anything there.
    const cust = await browser.newContext({ viewport: { width: 390, height: 844 }, isMobile: true });
    await cust.addInitScript(MOCKS);
    const cp = await cust.newPage();
    await cp.goto(url);
    await cp.getByRole("button", { name: "Save PDF" }).click();
    await cp.waitForFunction(() => window.__shared.length > 0, null, { timeout: 8000 });
    check(await cp.evaluate(async () => (await indexedDB.databases()).length) === 0, "the customer's phone stores nothing");
    await cust.close();
    await v.screenshot({ path: path.join(OUT, "app-viewer.png"), fullPage: true });
    await v.goto(`${srv.url}/v#nonsense`);
    check(/doesn't contain an invoice/.test(await v.textContent("main")), "a broken link shows a friendly message");

    // Fully offline.
    await page.evaluate(() => navigator.serviceWorker.ready);
    await page.waitForTimeout(600);
    await ctx.setOffline(true);
    await page.reload();
    await page.waitForFunction(() => window.__appReady === true, null, { timeout: 8000 });
    check(await page.inputValue("#store") === "Hill Top Grocery" && await page.textContent(".masthead-name") === BUSINESS.name, "app opens and works with no internet (business name still at the top)");
    await v.goto(url);
    await v.waitForSelector(".sheet .seller", { timeout: 8000 });
    check(true, "customer invoice page also opens offline (from this phone)");
    await ctx.setOffline(false);
    check(errors.length === 0, "no console errors", errors.join(" | "));
    await ctx.close();
  } finally {
    await browser.close();
    await srv.close();
  }
  console.log(failures ? `\n${failures} check(s) failed` : "\nAll app checks passed");
  process.exit(failures ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
