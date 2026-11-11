/**
 * After the customer signs: Done → thank-you checkmark (gentle buzz, about 2 s) → back to the QR code;
 * the owner-only payment page (Cash / 7 days / 14 days); every invoice with its own due date on the dashboard,
 * red from its due day until "Payment received" (never by itself); "Your business in numbers";
 * "Thank you, <store>" at the bottom of every customer copy; and payment never on the customer's copies
 * or the signing screen.
 */
const { chromium } = require("playwright");
const { start } = require("./serve.cjs");
const path = require("path");

const PORT = 8795, OUT = path.join(__dirname, "output");
let failures = 0;
const check = (ok, name, extra = "") => { console.log(`${ok ? "PASS" : "FAIL"}  ${name}${extra ? "  — " + extra : ""}`); if (!ok) failures++; };
const PAYMENT_WORDS = /unpaid|\bpaid\b|overdue|due (today|wed|thu|fri|sat|sun|mon|tue)|7 days|14 days|payment received/i;

const MOCKS = `
  window.__buzz = [];
  Object.defineProperty(navigator, "vibrate", { configurable: true, value: (p) => { window.__buzz.push(p); return true; } });
  window.__shared = [];
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
  await page.waitForTimeout(350);
}
const row = (page, name) => page.locator(".prod-row", { hasText: name }).first();
async function fillInvoice(page, { store = "", address = "", items }) {
  await page.evaluate(() => window.scrollTo(0, 0));
  if (store) await page.fill("#store", store);
  if (address) await page.fill("#address", address);
  for (const [name, qty, price] of items) {
    await row(page, name).locator(".prod-check").click();
    await row(page, name).locator(".qty-input").fill(String(qty));
    await row(page, name).locator(".price-input").fill(String(price));
  }
  await page.waitForTimeout(800); // autosave
}
async function signAndThank(page) {
  await drawSignature(page);
  await page.click("#sign-done");
  await page.waitForSelector(".thanks");
  const text = (await page.textContent(".thanks")).replace(/\s+/g, " ");
  await page.waitForSelector(".thanks", { state: "detached", timeout: 5000 });
  return text;
}
const dbEval = (page, fn, arg) => page.evaluate(async ({ src, arg }) => {
  const db = await import("/js/db.js");
  return new Function("db", "arg", `return (${src})(db, arg);`)(db, arg);
}, { src: fn.toString(), arg });
const paymentOf = (page, number) => dbEval(page, async (db, n) => (await db.invoices.all()).find((i) => i.number === n)?.payment || null, number);

async function openDashboard(page, { create = false } = {}) {
  await page.click("#owner-link");
  await page.waitForSelector(".dash-key");
  const pin = async () => { for (const d of "1357") await page.locator(`.dash-key[aria-label="${d}"]`).click(); };
  await pin();
  if (create) {
    await page.getByRole("button", { name: "Continue" }).click();
    await page.waitForSelector("text=Enter the same PIN again");
    await pin();
  }
  await page.waitForSelector(".dash-kpi", { timeout: 8000 });
}
async function reloadOn(page, when) {
  await page.clock.setFixedTime(new Date(when));
  await page.goto(page.url().replace(/#.*$/, "") + "#/");
  await page.reload();
  await page.waitForFunction(() => window.__appReady === true);
}

(async () => {
  const srv = await start(PORT);
  const browser = await chromium.launch();
  const errors = [];
  try {
    const ctx = await browser.newContext({ viewport: { width: 390, height: 844 }, deviceScaleFactor: 2, isMobile: true, hasTouch: true, bypassCSP: true });
    await ctx.addInitScript(MOCKS);
    const page = await ctx.newPage();
    page.on("pageerror", (e) => errors.push(e.message));
    page.on("console", (m) => { if (m.type() === "error") errors.push(m.text()); });
    await page.clock.setFixedTime(new Date("2026-11-11T10:00:00"));
    await page.goto(`${srv.url}/`);
    await page.waitForFunction(() => window.__appReady === true);

    // ── Invoice 1: Sarah Supermarket. Done → thank-you → back to the QR. ──
    check(await page.locator("#sign-done").isHidden() && await page.locator("#finish-btn").isHidden(), "Done and Finish stay hidden until the customer signs");
    await fillInvoice(page, { store: "Sarah Supermarket", address: "14 Wellington Street", items: [["Beetroot Juice", 24, 315], ["Okra", 50, 250]] });
    await drawSignature(page);
    check(await page.locator("#sign-done").isVisible(), "after signing, a Done button appears under the signature");
    const t0 = Date.now();
    await page.click("#sign-done");
    await page.waitForSelector(".thanks");
    const thanks = (await page.textContent(".thanks")).replace(/\s+/g, " ");
    check(/Thank you, Sarah Supermarket/.test(thanks) && /Invoice No\. 0001/.test(thanks) && /\$20,060\.00/.test(thanks), "thank-you shows 'Thank you, Sarah Supermarket', the invoice number and the total", thanks);
    check(await page.locator(".thanks svg.thanks-check .thanks-ring").count() === 1 && await page.locator(".thanks svg.thanks-check .thanks-tick").count() === 1, "with a checkmark (ring and tick)");
    check(await page.evaluate(() => getComputedStyle(document.querySelector(".thanks-tick")).stroke) === "rgb(23, 99, 63)", "the checkmark is green");
    check(JSON.stringify(await page.evaluate(() => window.__buzz)) === "[[30,60,30]]", "a gentle buzz with it");
    const early = await page.evaluate(() => parseFloat(getComputedStyle(document.querySelector(".thanks-tick")).strokeDashoffset));
    await page.waitForTimeout(1200);
    const late = await page.evaluate(() => parseFloat(getComputedStyle(document.querySelector(".thanks-tick")).strokeDashoffset));
    check(early > 20 && late < 1, "the checkmark draws itself", `tick dash offset ${early.toFixed(1)} → ${late.toFixed(1)}`);
    await page.screenshot({ path: path.join(OUT, "finish-1-thank-you.png") });
    await page.waitForSelector(".thanks", { state: "detached", timeout: 5000 });
    const shown = Date.now() - t0;
    check(shown >= 1900 && shown <= 3300, "on screen for about two seconds", `${shown} ms`);
    await page.waitForTimeout(900);
    const qr = await page.evaluate(() => { const r = document.getElementById("qr-card").getBoundingClientRect(); return { top: Math.round(r.top), bottom: Math.round(r.bottom), h: innerHeight }; });
    check(qr.top >= 0 && qr.bottom <= qr.h + 1, "then back to the invoice with the QR code in view", JSON.stringify(qr));
    check(await page.locator("#qr-box canvas").count() === 1, "the QR code is there for the customer");
    await page.screenshot({ path: path.join(OUT, "finish-1b-back-to-qr.png") });

    // The signing screen never shows payment.
    check(!PAYMENT_WORDS.test(await page.locator("#invoice-screen").innerText()), "no payment words anywhere on the signing screen");

    // ── Owner-only payment page: 7 days. ──
    check(await page.locator("#finish-btn").isVisible(), "'Finish invoice' is there once the customer has their receipt");
    await page.click("#finish-btn");
    await page.waitForSelector("dialog.pay[open]");
    const payText = (await page.textContent("dialog.pay[open]")).replace(/\s+/g, " ");
    check(/Only you see this page/.test(payText) && /Sarah Supermarket/.test(payText) && /Invoice No\. 0001/.test(payText) && /\$20,060\.00/.test(payText), "payment page: private, shows which invoice", payText.slice(0, 120));
    const options = await page.locator("dialog.pay .pay-option-title").allTextContents();
    check(options.join("|") === "Cash|7 days|14 days", "three buttons: Cash, 7 days, 14 days", options.join(" | "));
    check(/Due Wed 18 Nov/.test(payText) && /Due Wed 25 Nov/.test(payText), "7 and 14 days show their due dates (18 and 25 Nov)");
    await page.screenshot({ path: path.join(OUT, "finish-2-payment-page.png") });
    await page.click("dialog.pay .pay-option[data-choice='7']");
    await page.waitForSelector("dialog.pay", { state: "detached" });
    await page.waitForTimeout(400);
    check(await page.textContent("#invoice-no") === "No. 0002" && await page.inputValue("#store") === "" && await page.locator(".prod-row.is-on").count() === 0, "after the choice, a fresh invoice No. 0002 starts");
    const toastText = await page.textContent(".toast").catch(() => "");
    check(!PAYMENT_WORDS.test(toastText || ""), "the confirmation on the invoice screen doesn't say paid/unpaid", toastText);
    let p1 = await paymentOf(page, 1);
    check(p1?.status === "unpaid" && p1.method === "terms" && p1.termsDays === 7 && p1.dueDate === "2026-11-18" && p1.paidAt === null, "7 days → Unpaid, due 18 Nov", JSON.stringify(p1));

    // ── Invoice 2: the same store, 14 days (its own due date). ──
    await fillInvoice(page, { store: "Sarah Supermarket", items: [["Green Juice", 16, 230]] });
    const th2 = await signAndThank(page);
    check(/Thank you, Sarah Supermarket/.test(th2) && /Invoice No\. 0002/.test(th2) && /\$3,680\.00/.test(th2), "second invoice's thank-you", th2);
    await page.click("#finish-btn");
    await page.waitForSelector("dialog.pay[open]");
    await page.click("dialog.pay .pay-option[data-choice='14']");
    await page.waitForSelector("dialog.pay", { state: "detached" });
    await page.waitForTimeout(400);
    const p2 = await paymentOf(page, 2);
    check(p2?.status === "unpaid" && p2.termsDays === 14 && p2.dueDate === "2026-11-25", "14 days → Unpaid, due 25 Nov (one store, two separate open invoices)", JSON.stringify(p2));

    // ── Invoice 3: another store; "New invoice" asks for the payment first; Cash. ──
    await fillInvoice(page, { store: "Corner Shop", address: "6 Hope Road", items: [["Pumpkin Punch", 12, 250]] });
    const th3 = await signAndThank(page);
    check(/Thank you, Corner Shop/.test(th3) && /Invoice No\. 0003/.test(th3) && /\$3,000\.00/.test(th3), "works for any store name: 'Thank you, Corner Shop'", th3);
    await page.click("#new-btn");
    await page.waitForSelector("dialog.pay[open]");
    check(await page.locator("dialog.pay .pay-skip").textContent() === "Skip for now", "'New invoice' on a signed invoice opens the payment page first");
    await page.click("dialog.pay .pay-option[data-choice='cash']");
    await page.waitForSelector("dialog.pay", { state: "detached" });
    await page.waitForTimeout(400);
    const p3 = await paymentOf(page, 3);
    check(p3?.status === "paid" && p3.method === "cash" && Boolean(p3.paidAt), "Cash → Paid right away", JSON.stringify(p3));
    check(await page.textContent("#invoice-no") === "No. 0004", "and the next invoice starts");

    // ── Invoice 4: no store name; payment skipped. ──
    await fillInvoice(page, { items: [["Limes", 10, 50]] });
    const th4 = await signAndThank(page);
    check(/^Thank you!/.test(th4.trim()) && /Invoice No\. 0004/.test(th4), "no store name: 'Thank you!'", th4);
    await page.click("#new-btn");
    await page.waitForSelector("dialog.pay[open]");
    await page.click("dialog.pay .pay-skip");
    await page.waitForSelector("dialog.pay", { state: "detached" });
    await page.waitForTimeout(400);
    check(await page.textContent("#invoice-no") === "No. 0005" && await paymentOf(page, 4) === null, "'Skip for now' starts the next invoice and records nothing");

    // ── Every customer copy ends with "Thank you, <store>", and none shows payment. ──
    const inv1 = await dbEval(page, async (db) => (await db.invoices.all()).find((i) => i.number === 1));
    const url1 = await page.evaluate(async (inv) => (await import("/js/codec.js")).invoiceToUrl(inv), inv1);
    check(!/2026-?11-?18|unpaid|paid|terms/i.test(url1), "the QR code carries no payment details", url1.slice(0, 80));
    const drawn = await page.evaluate(async (inv) => {
      const { renderReceiptCanvas } = await import("/js/receipt.js");
      const seen = [];
      const orig = CanvasRenderingContext2D.prototype.fillText;
      CanvasRenderingContext2D.prototype.fillText = function (t, ...rest) { seen.push(String(t)); return orig.call(this, t, ...rest); };
      try { await renderReceiptCanvas(inv, { paper: 58 }); } finally { CanvasRenderingContext2D.prototype.fillText = orig; }
      return seen;
    }, inv1);
    check(drawn.at(-1) === "Thank you, Sarah Supermarket", "PDF and picture receipt end with 'Thank you, Sarah Supermarket'", drawn.slice(-2).join(" / "));
    check(!drawn.some((t) => PAYMENT_WORDS.test(t)), "no payment on the PDF or picture");
    const esc = await page.evaluate(async (inv) => {
      const { buildEscPos } = await import("/js/printer.js");
      const { receiptModel } = await import("/js/receipt.js");
      return Array.from(buildEscPos(receiptModel(inv), { paper: 58 })).map((b) => (b >= 32 && b < 127 ? String.fromCharCode(b) : "\n")).join("");
    }, inv1);
    const escLines = esc.split("\n").map((l) => l.trim()).filter((l) => /[a-z]{3,}/i.test(l)); // skip printer command bytes
    check(escLines.at(-1) === "Thank you, Sarah Supermarket", "paper receipt ends with 'Thank you, Sarah Supermarket'", escLines.slice(-2).join(" / "));
    check(!PAYMENT_WORDS.test(esc), "no payment on the paper receipt");
    await page.evaluate(() => { window.__shared = []; });
    const v = await ctx.newPage();
    v.on("pageerror", (e) => errors.push("viewer: " + e.message));
    await v.goto(url1);
    await v.waitForSelector(".sheet .thanks-line");
    check(await v.textContent(".thanks-line") === "Thank you, Sarah Supermarket", "customer QR page ends with 'Thank you, Sarah Supermarket'");
    check(!PAYMENT_WORDS.test(await v.locator("main").innerText()), "customer QR page shows no payment");
    await v.locator(".sheet .thanks-line").scrollIntoViewIfNeeded();
    await v.screenshot({ path: path.join(OUT, "finish-5-customer-page-thank-you.png") });
    await v.close();

    // ── Dashboard on 11 Nov: unpaid list, chips, filter, numbers. ──
    await openDashboard(page, { create: true });
    const unpaidRows = page.locator(".dash-unpaid .dash-row");
    const ut = (await unpaidRows.allInnerTexts()).map((t) => t.replace(/\s+/g, " "));
    check(ut.length === 2 && /No\. 0001/.test(ut[0]) && /Unpaid · due Wed 18 Nov/.test(ut[0]) && /No\. 0002/.test(ut[1]) && /Unpaid · due Wed 25 Nov/.test(ut[1]),
      "Unpaid invoices: each on its own with its own due date, soonest first", ut.join(" | "));
    check(await page.locator(".dash-unpaid .dash-row.is-due").count() === 0, "nothing is red before its due day");
    check(/\$23,740\.00 owed/.test(await page.textContent(".dash-unpaid")), "what's owed is added up ($20,060 + $3,680)");
    const nums = (await page.locator("#dashboard .dash-numbers").innerText()).replace(/\s+/g, " ");
    check(/Total billed \$27,240\.00 4 invoices/.test(nums), "Your business in numbers: total billed $27,240.00 (4 invoices)", nums);
    check(/Best customer Sarah Supermarket \$23,740\.00 · 2 invoices/.test(nums), "best customer: Sarah Supermarket");
    check(/Busiest day Wed 11 Nov 4 invoices · \$27,240\.00/.test(nums), "busiest day: Wed 11 Nov");
    check(await page.textContent(".dash-month-label") === "November 2026" && await page.locator(".dash-month-next").isDisabled(), "month by month, starting with this month");
    check(await page.locator(".dash-month-btn").first().isDisabled(), "no going back before the first invoice's month");
    check(!/\bnull\b|\bundefined\b|NaN/.test(await page.locator("#dashboard").innerText()), "no stray null/undefined/NaN on the dashboard");
    await page.screenshot({ path: path.join(OUT, "finish-3-dashboard.png"), fullPage: true });
    await page.getByRole("tab", { name: "History" }).click();
    await page.waitForSelector(".dash-row");
    const hrow = async (no) => (await page.locator(".dash-row", { hasText: `No. ${no}` }).innerText()).replace(/\s+/g, " ");
    check(/Unpaid · due Wed 18 Nov/.test(await hrow("0001")) && /Unpaid · due Wed 25 Nov/.test(await hrow("0002")) && /Paid · cash/.test(await hrow("0003")) && /No payment set/.test(await hrow("0004")),
      "History shows each invoice's payment status");
    await page.locator(".dash-chip[data-filter='unpaid']").click();
    check(await page.locator(".dash-row").count() === 2, "'Unpaid' filter lists just the two unpaid invoices");
    await page.locator(".dash-chip[data-filter='all']").click();

    // ── 18 Nov: invoice 1 turns red on its due day; invoice 2 doesn't. ──
    await reloadOn(page, "2026-11-18T08:30:00");
    await openDashboard(page);
    let due = (await page.locator(".dash-unpaid .dash-row").allInnerTexts()).map((t) => t.replace(/\s+/g, " "));
    check(await page.locator(".dash-unpaid .dash-row.is-due").count() === 1 && /No\. 0001/.test(due[0]) && /Due today/.test(due[0]), "18 Nov: invoice 1 turns red on its due day", due.join(" | "));
    check(/No\. 0002/.test(due[1]) && /Unpaid · due Wed 25 Nov/.test(due[1]) && !(await page.locator(".dash-unpaid .dash-row").nth(1).evaluate((e) => e.classList.contains("is-due"))), "invoice 2 keeps its own date: not red yet");
    check(await page.locator(".dash-unpaid .dash-row.is-due").evaluate((e) => getComputedStyle(e).backgroundColor) === "rgb(251, 233, 231)", "the due row is red");
    await page.screenshot({ path: path.join(OUT, "finish-4-dashboard-due-day.png") });

    // ── 20 Nov: still red (it never clears itself) until "Payment received" on that invoice. ──
    await reloadOn(page, "2026-11-20T15:00:00");
    await openDashboard(page);
    due = (await page.locator(".dash-unpaid .dash-row").allInnerTexts()).map((t) => t.replace(/\s+/g, " "));
    check(/No\. 0001/.test(due[0]) && /Overdue 2 days/.test(due[0]) && (await paymentOf(page, 1)).status === "unpaid", "20 Nov: still unpaid and red (overdue 2 days)", due[0]);
    await page.locator(".dash-unpaid .dash-row", { hasText: "No. 0001" }).click();
    await page.waitForSelector(".dash-payment");
    check(/Overdue 2 days/.test(await page.textContent(".dash-payment")) && await page.locator(".dash-received").isVisible(), "the invoice shows its status and a 'Payment received' button");
    await page.screenshot({ path: path.join(OUT, "finish-6-invoice-payment.png") });
    await page.click(".dash-received");
    await page.waitForSelector("dialog.sheet[open]");
    await page.locator("dialog.sheet[open]").getByRole("button", { name: "Payment received" }).click();
    await page.waitForTimeout(500);
    p1 = await paymentOf(page, 1);
    check(p1.status === "paid" && p1.paidAt && p1.paidAt.startsWith("2026-11-20") && p1.dueDate === "2026-11-18", "'Payment received' clears it: Paid on 20 Nov (the due date stays on record)", JSON.stringify(p1));
    check(/Paid on 20 Nov 2026/.test(await page.textContent(".dash-payment")) && await page.locator(".dash-received").count() === 0, "the invoice now shows Paid");
    check((await paymentOf(page, 2)).status === "unpaid", "the other invoice for the same store is untouched");
    await page.click(".dash-back-list");
    await page.waitForSelector(".dash-kpi");
    check(await page.locator(".dash-unpaid .dash-row").count() === 1 && /No\. 0002/.test(await page.locator(".dash-unpaid .dash-row").innerText()), "the unpaid list now has just invoice 2");

    // ── 26 Nov: invoice 2 turns red by itself on its own date and stays. ──
    await reloadOn(page, "2026-11-26T09:00:00");
    await openDashboard(page);
    check(await page.locator(".dash-unpaid .dash-row.is-due").count() === 1 && /Overdue 1 day/.test(await page.locator(".dash-unpaid .dash-row").innerText()), "26 Nov: invoice 2 is red (overdue 1 day), still waiting for 'Payment received'");

    // ── A paid invoice opened again: still nothing about payment on the signing screen, and saving keeps it. ──
    await page.getByRole("tab", { name: "History" }).click();
    await page.locator(".dash-row", { hasText: "No. 0001" }).click();
    await page.getByRole("button", { name: "Open and edit" }).click();
    await page.waitForFunction(() => !document.getElementById("invoice-screen").hidden);
    await page.waitForTimeout(300);
    check(await page.textContent("#invoice-no") === "No. 0001" && !PAYMENT_WORDS.test(await page.locator("#invoice-screen").innerText()), "reopened paid invoice: the signing screen still shows no payment");
    check(await page.locator("#finish-btn").isHidden(), "and no 'Finish invoice' (its payment is already recorded)");
    const kept = await dbEval(page, async (db) => {
      const inv = (await db.invoices.all()).find((i) => i.number === 1);
      const { payment, ...rest } = inv;
      await db.invoices.put({ ...rest, address: "14 Wellington Street, Brownstone" });
      return (await db.invoices.get(inv.id)).payment;
    });
    check(kept?.status === "paid", "editing an invoice never loses its payment");

    check(errors.length === 0, "no console errors", errors.join(" | "));
  } finally {
    await browser.close();
    await srv.close();
  }
  console.log(failures ? `\n${failures} check(s) failed` : "\nAll finish checks passed");
  process.exit(failures ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
