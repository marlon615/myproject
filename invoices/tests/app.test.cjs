/**
 * End-to-end: the real app at phone size. Invoice flows, signature guard, QR (decoded), print/share hand-off,
 * owner dashboard (PIN, totals, history, open), customer viewer, and full offline use.
 */
const { chromium } = require("playwright");
const { start } = require("./serve.cjs");
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
  navigator.share = async (d) => { window.__shared.push({ name: d.files[0].name, type: d.files[0].type }); };
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
    await page.goto(`${srv.url}/`);
    await page.waitForFunction(() => window.__appReady === true);
    await page.addScriptTag({ path: require.resolve("jsqr/dist/jsQR.js") });

    // A fresh invoice.
    check(await page.textContent(".masthead-name") === "Marlon Williams", "header shows Marlon Williams");
    check(await page.inputValue("#date") === today, "date fills in today automatically", await page.inputValue("#date"));
    check(await page.locator(".prod-row").count() === 14, "all 14 products listed");
    const names = await page.locator(".prod-name").allTextContents();
    check(names.join("|") === "Beetroot Juice|Cucumber Juice|Pumpkin Punch|Green Juice|Mini Bammy|Large Bammy|Juicify Drink Grape|Juicify Drink Fruit Punch|Hot Pepper|Shredded Callaloo|Lemons|Limes|Grapefruit|Okra", "products in the owner's order");
    check(await page.textContent("#invoice-no") === "No. 0001" && await page.locator("#qr-box .qr-empty").count() === 1, "new invoice No. 0001 with a QR placeholder");
    for (const w of [390, 360]) { await page.setViewportSize({ width: w, height: 844 }); check(!(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth)), `no sideways scroll at ${w}px`); }
    await page.setViewportSize({ width: 390, height: 844 });

    // Date can be changed.
    await page.fill("#date", "2026-11-09");
    check(await page.inputValue("#date") === "2026-11-09", "date can be changed");

    // Tick, quantities, prices, totals.
    await page.fill("#store", "Rose Hall Grocery");
    await page.fill("#address", "12 Main Street\nMontego Bay");
    for (const n of ["Beetroot Juice", "Mini Bammy", "Okra"]) await row(page, n).locator(".prod-check").click();
    await row(page, "Beetroot Juice").locator(".qty-input").fill("12");
    await row(page, "Beetroot Juice").locator(".price-input").fill("350");
    await row(page, "Mini Bammy").locator(".qty-btn").nth(1).click();
    await row(page, "Mini Bammy").locator(".price-input").fill("150.5");
    const cuc = row(page, "Cucumber Juice");
    check(await cuc.evaluate((e) => +getComputedStyle(e).opacity) < 0.5 && await cuc.locator(".prod-detail").isHidden(), "unticked products fade and hide qty/price but stay in the list");
    check(await row(page, "Beetroot Juice").locator(".line-total").textContent() === "$4,200.00", "line total = qty × price");
    check(await row(page, "Mini Bammy").locator(".qty-input").inputValue() === "2" && await row(page, "Mini Bammy").locator(".line-total").textContent() === "$301.00", "stepper + decimal price");
    check(await row(page, "Okra").locator(".line-total").textContent() === "—", "missing price shows —");
    check(await page.textContent("#grand-amount") === "$4,501.00" && await page.textContent("#grand-count") === "3 items", "grand total at the bottom", await page.textContent("#grand-amount"));
    await row(page, "Okra").locator(".prod-check").click(); await row(page, "Okra").locator(".prod-check").click(); // untick, re-tick
    check(await row(page, "Okra").locator(".qty-input").inputValue() === "1", "re-ticking keeps the row usable");

    // Add a product: ticked now, kept for later invoices.
    await page.fill("#prod-add-name", "Sorrel Drink");
    await page.click("#prod-add button[type=submit]");
    await page.waitForTimeout(300);
    check(await row(page, "Sorrel Drink").evaluate((e) => e.classList.contains("is-on")), "added product appears ticked");
    await row(page, "Sorrel Drink").locator(".price-input").fill("200");

    // Autosave + reload.
    await page.waitForTimeout(900);
    check(/Saved on this phone/.test(await page.textContent("#save-status")), "autosaved on the phone");
    await page.reload(); await page.waitForFunction(() => window.__appReady === true); await page.addScriptTag({ path: require.resolve("jsqr/dist/jsQR.js") });
    check(await page.inputValue("#store") === "Rose Hall Grocery" && await page.textContent("#grand-amount") === "$4,701.00" && await page.textContent("#invoice-no") === "No. 0001", "everything survives a reload", await page.textContent("#grand-amount"));
    check(await page.locator(".prod-row").count() === 15, "added product stays in the list");

    // QR: link and text modes decode correctly.
    await page.waitForTimeout(400);
    const want = await page.evaluate(async () => { const c = await import("/js/codec.js"); const db = await import("/js/db.js"); return c.invoiceToUrl(await db.invoices.get(await db.settings.get("currentId"))); });
    const link = await qrText(page);
    check(link === want && /\/v#1~Marlon\+Williams~1~20261109~Rose\+Hall\+Grocery~/.test(link), "QR decodes to the complete invoice link", link?.slice(0, 70));
    await page.click("#qr-toggle"); await page.waitForTimeout(100);
    const txt = await qrText(page);
    check(/^INVOICE No\. 0001\nMarlon Williams\nDate: 9 Nov 2026\nStore: Rose Hall Grocery/.test(txt || "") && /TOTAL: \$4,701\.00/.test(txt || "") && !/Cucumber/.test(txt || ""), "text-only QR holds the whole invoice as plain text");
    await page.click("#qr-toggle");

    // Signature + signed-invoice guard.
    await drawSignature(page);
    await page.waitForTimeout(700);
    check(/^Signed ✓/.test(await page.textContent("#sign-status")) && await page.locator("#signed-badge").isVisible(), "customer signature captured");
    await page.reload(); await page.waitForFunction(() => window.__appReady === true); await page.addScriptTag({ path: require.resolve("jsqr/dist/jsQR.js") });
    check(/^Signed ✓/.test(await page.textContent("#sign-status")), "signature survives a reload");
    await row(page, "Lemons").locator(".prod-check").click();
    await page.waitForSelector("dialog.sheet[open]");
    check(/Remove the signature/.test(await page.textContent("dialog.sheet[open]")), "changing a signed invoice asks first");
    check(!/\bnull\b/.test(await page.locator("dialog.sheet[open]").innerText()), "question sheet has no stray 'null' text");
    await page.getByRole("button", { name: "Keep it" }).click();
    check(!(await row(page, "Lemons").evaluate((e) => e.classList.contains("is-on"))) && /^Signed/.test(await page.textContent("#sign-status")), "'Keep it' leaves the invoice and signature untouched");
    await row(page, "Lemons").locator(".prod-check").click();
    await page.getByRole("button", { name: "Change invoice" }).click();
    await page.waitForTimeout(200);
    check(await row(page, "Lemons").evaluate((e) => e.classList.contains("is-on")) && await page.textContent("#sign-status") === "Not signed yet", "'Change invoice' applies the change and removes the signature");
    await row(page, "Lemons").locator(".prod-check").click(); // untick again
    await drawSignature(page); await page.waitForTimeout(600);

    // Print + share hand-off; missing-price confirmation.
    await row(page, "Okra").scrollIntoViewIfNeeded();
    await page.click("#print-btn");
    await page.waitForSelector("dialog.sheet[open]");
    check(/1 item has no price/.test(await page.textContent("dialog.sheet[open]")), "warns before printing an item with no price");
    await page.getByRole("button", { name: "Add prices" }).click();
    // The invoice is signed, so typing a price first asks about the signature; then the price box has focus.
    await page.waitForSelector("dialog.sheet[open]");
    check(/Remove the signature/.test(await page.textContent("dialog.sheet[open]")), "'Add prices' on a signed invoice asks about the signature first");
    await page.getByRole("button", { name: "Change invoice" }).click();
    await page.waitForTimeout(150);
    check(await page.evaluate(() => document.activeElement?.closest(".prod-row")?.textContent.includes("Okra") && document.activeElement.classList.contains("price-input")), "…then the missing price box is ready to type in");
    await page.keyboard.type("90");
    await page.waitForTimeout(200);
    await drawSignature(page); await page.waitForTimeout(600);
    await page.click("#print-btn");
    await page.waitForFunction(() => window.__printed.length > 0, null, { timeout: 8000 });
    check(true, "Print sends the receipt to the Bluetooth printer", `${await page.evaluate(() => window.__printed.length)} writes`);
    await page.click("#share-pdf-btn");
    await page.waitForFunction(() => window.__shared.length > 0, null, { timeout: 8000 });
    const sh = await page.evaluate(() => window.__shared[0]);
    check(sh.type === "application/pdf" && sh.name === "Invoice-0001-Rose-Hall-Grocery.pdf", "Share PDF hands over a named PDF", JSON.stringify(sh));
    await page.screenshot({ path: path.join(OUT, "app-filled.png"), fullPage: true });

    // New invoice + known store fills its address.
    await page.click("#new-btn"); await page.waitForTimeout(300);
    check(await page.textContent("#invoice-no") === "No. 0002" && await page.inputValue("#store") === "" && await page.locator(".prod-row.is-on").count() === 0, "New invoice starts clean as No. 0002");
    await page.fill("#store", "Rose Hall Grocery");
    await page.waitForTimeout(100);
    check(await page.inputValue("#address") === "12 Main Street\nMontego Bay", "known store fills in its address");
    await row(page, "Okra").locator(".prod-check").click();
    check(await row(page, "Okra").locator(".price-input").inputValue() === "90", "last price is remembered for the product");
    await page.waitForTimeout(900);

    // Owner dashboard: PIN, totals, history, open.
    await page.click("#owner-link");
    await page.waitForSelector(".dash-key");
    check(await page.locator("#invoice-screen").isHidden(), "dashboard replaces the invoice screen");
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

    // Customer viewer from the QR link.
    const url = await page.evaluate(async () => { const c = await import("/js/codec.js"); const db = await import("/js/db.js"); return c.invoiceToUrl(await db.invoices.get(await db.settings.get("currentId"))); });
    const v = await ctx.newPage();
    v.on("pageerror", (e) => errors.push("viewer: " + e.message));
    await v.goto(url);
    await v.waitForSelector(".sheet .seller");
    const vt = (await v.textContent(".sheet")).replace(/\s+/g, " ");
    check(/Marlon Williams/.test(vt) && /Invoice No\. 0001/.test(vt) && /Rose Hall Grocery/.test(vt) && /\$4,791\.00/.test(vt) && /Signed by the customer/.test(vt), "customer sees the full invoice from the QR link", vt.slice(0, 120));
    await v.screenshot({ path: path.join(OUT, "app-viewer.png"), fullPage: true });
    await v.goto(`${srv.url}/v#nonsense`);
    check(/doesn't contain an invoice/.test(await v.textContent("main")), "a broken link shows a friendly message");

    // Fully offline.
    await page.evaluate(() => navigator.serviceWorker.ready);
    await page.waitForTimeout(600);
    await ctx.setOffline(true);
    await page.reload();
    await page.waitForFunction(() => window.__appReady === true, null, { timeout: 8000 });
    check(await page.inputValue("#store") === "Rose Hall Grocery", "app opens and works with no internet");
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
