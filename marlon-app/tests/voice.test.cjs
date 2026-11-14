/**
 * Voice entry end to end, with a stand-in speech recogniser (Playwright can't speak into a microphone):
 * mic toggle, live text, review screen (highlighted lines, tap to fix, usual prices), putting it on the invoice, units,
 * the keyboard-dictation fallback, and recovering when the browser pauses or refuses to listen. Uses a made-up
 * business's own products (tests/fixture.cjs): the app ships with none.
 */
const { chromium } = require("playwright");
const { start } = require("./serve.cjs");
const { setUp, appUrl } = require("./fixture.cjs");
const path = require("path");

const PORT = 8793, OUT = path.join(__dirname, "output");
const TODAY = (() => { const d = new Date(); const z = new Date(d.getTime() - d.getTimezoneOffset() * 60000); return z.toISOString().slice(0, 10); })();
let failures = 0;
const check = (ok, name, extra = "") => { console.log(`${ok ? "PASS" : "FAIL"}  ${name}${extra ? "  — " + extra : ""}`); if (!ok) failures++; };

/** A fake SpeechRecognition. window.__say(text, {final}) feeds it; window.__speech.mode picks on-device/cloud. */
const FAKE_SPEECH = `
  window.__speech = { mode: "on-device", started: 0, processLocally: null, failWith: null, lang: null };
  class FakeRecognition {
    static async available(opts) { return window.__speech.mode === "on-device" ? "available" : "downloadable"; }
    static async install() { return true; }
    constructor() { this.processLocally = false; this.continuous = false; this.interimResults = false; this.maxAlternatives = 1; this._finals = []; }
    start() {
      window.__speech.started++; window.__speech.processLocally = this.processLocally; window.__speech.lang = this.lang;
      window.__rec = this;
      if (window.__speech.failWith) { const err = window.__speech.failWith; setTimeout(() => { this.onerror?.({ error: err }); this.onend?.(); }, 30); }
    }
    stop() { setTimeout(() => this.onend?.(), 20); }
    abort() { setTimeout(() => this.onend?.(), 5); }
    _emit(text, final, alts = []) {
      const mk = (t) => ({ transcript: t, confidence: 0.9 });
      const result = [mk(text), ...alts.map(mk)]; result.isFinal = final;
      const results = [...this._finals, result];
      const ev = { resultIndex: this._finals.length, results };
      if (final) this._finals.push(result);
      this.onresult?.(ev);
    }
  }
  window.SpeechRecognition = FakeRecognition;
  window.__say = (text, final = true, alts = []) => window.__rec._emit(text, final, alts);
  window.__shared = []; navigator.canShare = (d) => !!(d && d.files); navigator.share = async (d) => { window.__shared.push(d.files[0].name); };
`;
const NO_SPEECH = `Object.defineProperty(window, "SpeechRecognition", { value: undefined, configurable: true }); Object.defineProperty(window, "webkitSpeechRecognition", { value: undefined, configurable: true });`;

(async () => {
  const srv = await start(PORT);
  const browser = await chromium.launch();
  const errors = [];
  try {
    // Security header lets this app (only) use the microphone.
    const res = await fetch(`${srv.url}/`);
    check(/microphone=\(self\)/.test(res.headers.get("permissions-policy") || ""), "microphone allowed for this app", res.headers.get("permissions-policy"));

    const ctx = await browser.newContext({ viewport: { width: 390, height: 844 }, deviceScaleFactor: 2, isMobile: true, hasTouch: true });
    await ctx.addInitScript(FAKE_SPEECH);
    const page = await ctx.newPage();
    page.on("pageerror", (e) => errors.push(e.message));
    page.on("console", (m) => { if (m.type() === "error") errors.push(m.text()); });
    await page.goto(appUrl(srv));
    await page.waitForFunction(() => window.__appReady === true);
    await setUp(page);

    // One mic button: tap to start.
    check(await page.locator("#mic-btn").count() === 1 && (await page.textContent("#mic-btn")).trim() === "Speak the invoice" && await page.locator("#voice-panel").isHidden(), "one mic button, idle");
    await page.screenshot({ path: path.join(OUT, "voice-0-mic-button.png") });
    await page.click("#mic-btn");
    await page.waitForFunction(() => window.__speech.started === 1);
    check(await page.getAttribute("#mic-btn", "aria-pressed") === "true" && (await page.textContent("#mic-btn")).trim() === "Stop listening" && await page.locator("#voice-panel").isVisible(), "tap once: listening (button shows Stop listening)");
    await page.waitForTimeout(100);
    check(await page.evaluate(() => window.__speech.processLocally) === true && /works offline/.test(await page.textContent("#voice-mode")), "uses on-device speech when the phone has it", await page.textContent("#voice-mode"));

    // Speak the whole invoice (plus an unclear 'patty').
    await page.evaluate(() => window.__say("Bay Market, 12 King Street, Riverside, two dozen", false));
    check(/Bay Market/.test(await page.textContent("#voice-text")), "words appear while speaking");
    await page.evaluate(() => window.__say("Bay Market, 12 King Street, Riverside, two dozen mango juice, one dozen yellow yam,"));
    // The browser pauses after a silence: listening carries on by itself.
    await page.evaluate(() => window.__rec.onend());
    await page.waitForFunction(() => window.__speech.started === 2);
    check(await page.getAttribute("#mic-btn", "aria-pressed") === "true", "a pause in the browser doesn't stop listening");
    await page.evaluate(() => window.__say("five dozen large patty, one dozen patty, fifty pounds sweet potato at two fifty"));
    await page.screenshot({ path: path.join(OUT, "voice-1-listening.png") });

    // Tap again: stop → review screen.
    await page.click("#mic-btn");
    await page.waitForSelector("dialog.review[open]");
    check(await page.getAttribute("#mic-btn", "aria-pressed") === "false", "tap again: stops listening");
    const store = await page.inputValue("dialog.review input[aria-label='Store name']");
    const address = await page.inputValue("dialog.review textarea[aria-label='Store address']");
    check(store === "Bay Market" && address === "12 King Street, Riverside", "review shows store and address", `${store} | ${address}`);
    const names = await page.locator("dialog.review .review-line-name").allTextContents();
    check(names.join(" | ") === "Mango Juice | Yellow Yam | Large Patty | “patty” | Sweet Potato", "review lists every product heard (the unclear one as heard)", names.join(" | "));
    const fixRows = await page.locator("dialog.review .review-line.needs-fix").count();
    const fixText = await page.textContent("dialog.review .review-line.needs-fix");
    check(fixRows === 1 && /Which product is “patty”/.test(fixText) && /Small Patty/.test(fixText) && /Large Patty/.test(fixText), "unclear 'patty' is highlighted with both choices, not guessed", `${fixRows} highlighted`);
    check(await page.locator("dialog.review .review-apply").isDisabled() && /Fix 1 highlighted line/.test(await page.textContent("dialog.review .review-apply")), "can't put it on the invoice until the unclear line is fixed");
    check(/50 lb × \$250\.00/.test(await page.textContent("dialog.review")), "sweet potato by weight at the spoken price (not the usual $120): 50 lb × $250.00");
    const mangoLine = page.locator("dialog.review .review-line", { hasText: "Mango Juice" });
    check(/24 \(2 dozen\) × \$250\.00/.test(await mangoLine.textContent()) && /Your usual price/.test(await mangoLine.textContent()), "no price said for Mango Juice: its usual price from setup, marked 'Your usual price'", await mangoLine.textContent());
    check(await page.locator("dialog.review .review-line", { hasText: "Yellow Yam" }).evaluate((e) => !e.classList.contains("needs-fix") && !e.querySelector(".review-issue") && /Add price/.test(e.textContent)),
      "a product with no usual price and none said is plain (not highlighted), with a quiet 'Add price' note");
    await page.screenshot({ path: path.join(OUT, "voice-2-review.png") });

    // Fix by tapping: choose Small Patty from the suggestions; change the mango price to what was agreed.
    await page.locator("dialog.review .review-line.needs-fix .review-chip", { hasText: "Small Patty" }).click();
    check(await page.locator("dialog.review .review-line.needs-fix").count() === 0, "one tap on a suggestion fixes the line");
    await page.locator("dialog.review .review-line", { hasText: "Mango Juice" }).locator(".review-line-main").click();
    await page.locator("dialog.review .review-editor input[aria-label='Price per unit']").fill("315");
    await page.screenshot({ path: path.join(OUT, "voice-3-fix-line.png") });
    await page.locator("dialog.review .review-editor").getByRole("button", { name: "Done" }).click();
    check(/24 \(2 dozen\) × \$315\.00/.test(await page.textContent("dialog.review")) && !/Your usual price/.test(await page.locator("dialog.review .review-line", { hasText: "Mango Juice" }).textContent()), "tap a line to change it: price changed (2 dozen shown as 24)");
    check(await page.locator("dialog.review .review-apply").isEnabled(), "Put on invoice is ready");
    await page.click("dialog.review .review-apply");
    await page.waitForSelector("dialog.review", { state: "detached" });
    await page.waitForTimeout(300);

    // On the invoice: ticks, amounts, units, prices, total.
    const row = (n) => page.locator(".prod-row", { hasText: n }).first();
    const rowState = async (n) => ({ on: await row(n).evaluate((e) => e.classList.contains("is-on")), qty: await row(n).locator(".qty-input").inputValue(), unit: await row(n).locator(".unit-select").inputValue(), price: await row(n).locator(".price-input").inputValue(), total: await row(n).locator(".line-total").textContent() });
    check(await page.inputValue("#store") === "Bay Market" && await page.inputValue("#address") === "12 King Street, Riverside", "store and address filled in");
    const mango = await rowState("Mango Juice"), sweet = await rowState("Sweet Potato"), large = await rowState("Large Patty");
    check(mango.on && mango.qty === "24" && mango.unit === "each" && mango.price === "315" && mango.total === "$7,560.00", "Mango Juice: 2 dozen = 24 × 315", JSON.stringify(mango));
    check(sweet.on && sweet.qty === "50" && sweet.unit === "lb" && sweet.price === "250" && sweet.total === "$12,500.00", "Sweet Potato: 50 lb × 250 (by weight)", JSON.stringify(sweet));
    check(large.on && large.qty === "60" && large.unit === "each" && large.total === "—", "Large Patty: 5 dozen = 60, price still to add", JSON.stringify(large));
    check(!(await row("Coconut Water").evaluate((e) => e.classList.contains("is-on"))), "products not said stay unticked");
    check(await page.textContent("#grand-amount") === "$20,060.00" && await page.textContent("#grand-count") === "5 items", "added up", await page.textContent("#grand-amount"));
    const text = await page.evaluate(async () => { const c = await import("/js/codec.js"); const db = await import("/js/db.js"); await new Promise((r) => setTimeout(r, 700)); return c.invoiceToText(await db.invoices.get(await db.settings.get("currentId"))); });
    check(/24 x \$315\.00 = \$7,560\.00/.test(text) && /50 lb x \$250\.00 = \$12,500\.00/.test(text), "units carried into the saved invoice and its QR text", text.replace(/\n/g, " / "));
    await row("Mango Juice").scrollIntoViewIfNeeded();
    await page.screenshot({ path: path.join(OUT, "voice-4-filled.png") });

    // A second voice entry on a filled invoice asks before replacing.
    await page.evaluate(() => window.scrollTo(0, 0));
    await page.click("#mic-btn");
    await page.waitForFunction(() => window.__speech.started === 3);
    await page.evaluate(() => window.__say("three dozen ginger beer at 1200"));
    await page.click("#mic-btn");
    await page.waitForSelector("dialog.review[open]");
    await page.click("dialog.review .review-apply");
    await page.waitForSelector("dialog.sheet[open]");
    check(/already has products/.test(await page.textContent("dialog.sheet[open]")), "asks before replacing products already on the invoice");
    await page.getByRole("button", { name: "Add to them" }).click();
    await page.waitForTimeout(300);
    check((await rowState("Ginger Beer")).on && (await rowState("Sweet Potato")).on, "'Add to them' keeps the earlier products");
    // The private dashboard still works, and counts units sensibly.
    await page.waitForTimeout(800);
    await page.click("#owner-link");
    await page.waitForSelector(".dash-key");
    for (const d of "1357") await page.locator(`.dash-key[aria-label="${d}"]`).click();
    await page.getByRole("button", { name: "Continue" }).click();
    await page.waitForSelector("text=Enter the same PIN again");
    for (const d of "1357") await page.locator(`.dash-key[aria-label="${d}"]`).click();
    await page.waitForSelector(".dash-kpi");
    const dashText = await page.locator("#dashboard").innerText();
    check(/Mango Juice[\s\S]*?24 sold/.test(dashText) && /Sweet Potato[\s\S]*?50 lb sold/.test(dashText), "dashboard: 2 dozen counts as 24 sold, sweet potato in pounds");
    await page.getByRole("tab", { name: "History" }).click();
    await page.locator(".dash-row").first().click();
    check(/24 × \$315\.00/.test(await page.locator("#dashboard").innerText()) && /50 lb × \$250\.00/.test(await page.locator("#dashboard").innerText()), "dashboard invoice detail shows units");
    check(errors.length === 0, "no console errors", errors.join(" | "));
    await ctx.close();

    // Phones where the browser can't listen (e.g. some iPhone home-screen apps): keyboard dictation box.
    const c2 = await browser.newContext({ viewport: { width: 390, height: 844 }, deviceScaleFactor: 2, isMobile: true, hasTouch: true,
      userAgent: "Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Mobile/15E148" });
    await c2.addInitScript(NO_SPEECH);
    const p2 = await c2.newPage();
    p2.on("pageerror", (e) => errors.push("fallback: " + e.message));
    await p2.goto(appUrl(srv));
    await p2.waitForFunction(() => window.__appReady === true);
    await setUp(p2);
    await p2.click("#mic-btn");
    await p2.waitForSelector("dialog.sheet[open] textarea.dictate-box");
    check(/microphone on your keyboard/.test(await p2.textContent("dialog.sheet[open]")), "no listening available: offers the keyboard microphone");
    await p2.fill("dialog.sheet[open] textarea.dictate-box", "Corner Shop, 6 Hope Road, a dozen ginger beer at 1200, 3 pounds yellow yam at 400");
    await p2.screenshot({ path: path.join(OUT, "voice-5-keyboard-fallback.png") });
    await p2.getByRole("button", { name: "Done" }).click();
    await p2.waitForSelector("dialog.review[open]");
    check(/12 \(1 dozen\) × \$1,200\.00/.test(await p2.textContent("dialog.review")) && /3 lb × \$400\.00/.test(await p2.textContent("dialog.review")), "dictated text goes through the same review");
    await c2.close();

    // The browser refuses to listen part-way (e.g. home-screen app): what was heard carries into the box.
    const c3 = await browser.newContext({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true });
    await c3.addInitScript(FAKE_SPEECH);
    const p3 = await c3.newPage();
    await p3.goto(appUrl(srv));
    await p3.waitForFunction(() => window.__appReady === true);
    await setUp(p3);
    await p3.evaluate(() => { window.__speech.mode = "cloud"; });
    await p3.click("#mic-btn");
    await p3.waitForFunction(() => window.__speech.started === 1);
    check(await p3.evaluate(() => window.__speech.processLocally) === false, "without on-device speech it uses the browser's own");
    await p3.evaluate(() => { window.__say("Hope Store two dozen eggs"); window.__rec.onerror({ error: "service-not-allowed" }); });
    await p3.waitForSelector("dialog.sheet[open] textarea.dictate-box");
    check(await p3.inputValue("dialog.sheet[open] textarea.dictate-box") === "Hope Store two dozen eggs", "if listening is refused, the words so far carry into the keyboard box");
    await c3.close();

    // A clean test sentence: three clean lines, no orange, 24×315 + 16×230 + 12×250 = $14,240.
    const c4 = await browser.newContext({ viewport: { width: 390, height: 844 }, deviceScaleFactor: 2, isMobile: true, hasTouch: true });
    await c4.addInitScript(FAKE_SPEECH);
    const p4 = await c4.newPage();
    p4.on("pageerror", (e) => errors.push("test sentence: " + e.message));
    await p4.goto(appUrl(srv));
    await p4.waitForFunction(() => window.__appReady === true);
    await setUp(p4);
    await p4.click("#mic-btn");
    await p4.waitForFunction(() => window.__speech.started === 1);
    await p4.evaluate(() => window.__say("Bay Market, 12 King Street, Riverside, 24 mango juice 315 per unit, 16 carrot juice 230 per unit, 12 ginger beer 250 per unit"));
    await p4.click("#mic-btn");
    await p4.waitForSelector("dialog.review[open]");
    const lines4 = await p4.locator("dialog.review .review-line").allTextContents();
    check(lines4.length === 3, "test sentence: exactly three lines in the review", lines4.join(" | "));
    check(await p4.locator("dialog.review .review-line.needs-fix, dialog.review .review-issue, dialog.review .review-note").count() === 0, "test sentence: no warnings at all");
    const calc4 = await p4.locator("dialog.review .review-line-calc").allTextContents();
    check(calc4.join(" | ") === "24 × $315.00 | 16 × $230.00 | 12 × $250.00", "test sentence: each price attached to its own product", calc4.join(" | "));
    check(await p4.textContent("dialog.review .review-total-amt") === "$14,240.00" && await p4.locator("dialog.review .review-apply").isEnabled(), "test sentence: review total $14,240.00, ready to put on the invoice", await p4.textContent("dialog.review .review-total-amt"));
    await p4.screenshot({ path: path.join(OUT, "voice-6-test-sentence-review.png") });
    await p4.click("dialog.review .review-apply");
    await p4.waitForSelector("dialog.review", { state: "detached" });
    await p4.waitForTimeout(300);
    const r4 = (n) => p4.locator(".prod-row", { hasText: n }).first().locator(".line-total").textContent();
    check(await r4("Mango Juice") === "$7,560.00" && await r4("Carrot Juice") === "$3,680.00" && await r4("Ginger Beer") === "$3,000.00", "line totals: quantity × spoken unit price");
    check(await p4.textContent("#grand-amount") === "$14,240.00" && await p4.textContent("#grand-count") === "3 items", "grand total on the invoice: $14,240.00", await p4.textContent("#grand-amount"));
    await p4.locator(".prod-row", { hasText: "Mango Juice" }).first().scrollIntoViewIfNeeded();
    await p4.screenshot({ path: path.join(OUT, "voice-7-test-sentence-invoice.png") });

    // Loose matching, "dozen" = 12, usual prices filled in, no red lines, no "which product?".
    await p4.waitForTimeout(700);
    await p4.click("#new-btn");
    await p4.waitForTimeout(300);
    await p4.evaluate(() => window.scrollTo(0, 0));
    await p4.click("#mic-btn");
    await p4.waitForFunction(() => window.__speech.started === 2);
    await p4.evaluate(() => window.__say("Bay Market, 12 King Street, two dozen mango, one dozen carrot, five dozen large patty, fifty pounds sweet potato at two fifty"));
    await p4.click("#mic-btn");
    await p4.waitForSelector("dialog.review[open]");
    const n5 = await p4.locator("dialog.review .review-line-name").allTextContents();
    const c5 = await p4.locator("dialog.review .review-line-calc").allTextContents();
    check(n5.join(" | ") === "Mango Juice | Carrot Juice | Large Patty | Sweet Potato", "loose test: every product matched ('mango', 'carrot')", n5.join(" | "));
    check(c5.join(" | ") === "24 (2 dozen) × $250.00 | 12 (1 dozen) × $250.00 | 60 (5 dozen) × no price | 50 lb × $250.00", "loose test: dozens become 24, 12 and 60; usual prices where none was said; sweet potato 50 lb × $250 as said", c5.join(" | "));
    check(await p4.locator("dialog.review .review-line.needs-fix, dialog.review .review-issue").count() === 0 && !/Which product/.test(await p4.textContent("dialog.review")), "loose test: no red lines, no 'which product?'");
    check(await p4.inputValue("dialog.review input[aria-label='Store name']") === "Bay Market" && await p4.inputValue("dialog.review textarea[aria-label='Store address']") === "12 King Street", "loose test: store and address");
    check(await p4.locator("dialog.review .review-apply").isEnabled() && await p4.textContent("dialog.review .review-total-amt") === "$21,500.00", "loose test: ready to put on the invoice ($6,000 + $3,000 + $12,500 priced so far)", await p4.textContent("dialog.review .review-total-amt"));
    await p4.screenshot({ path: path.join(OUT, "voice-8-latest-test-review.png") });
    await p4.click("dialog.review .review-apply");
    await p4.waitForSelector("dialog.review", { state: "detached" });
    await p4.waitForTimeout(300);
    const q5 = (n) => p4.locator(".prod-row", { hasText: n }).first().locator(".qty-input").inputValue();
    check(await q5("Mango Juice") === "24" && await q5("Carrot Juice") === "12" && await q5("Large Patty") === "60" && await q5("Sweet Potato") === "50", "loose test: on the invoice as 24, 12, 60 and 50 lb");

    // A spoken date sets the invoice date (not the address); and the next invoice starts fresh (no $315 carried over: the usual price).
    await p4.waitForTimeout(700);
    await p4.click("#new-btn");
    await p4.waitForTimeout(300);
    await p4.evaluate(() => window.scrollTo(0, 0));
    await p4.click("#mic-btn");
    await p4.waitForFunction(() => window.__speech.started === 3);
    await p4.evaluate(() => window.__say("Bay Market, 12th of the 11th 2026, 12 King Street, Riverside, 24 mango juice"));
    await p4.click("#mic-btn");
    await p4.waitForSelector("dialog.review[open]");
    check(await p4.inputValue("dialog.review input[aria-label='Invoice date']") === "2026-11-12" && await p4.inputValue("dialog.review textarea[aria-label='Store address']") === "12 King Street, Riverside", "'12th of the 11th 2026' → date 12 Nov 2026, kept out of the address");
    check(/24 × \$250\.00/.test(await p4.textContent("dialog.review")) && !/315/.test(await p4.textContent("dialog.review")), "next invoice starts fresh: the usual price, nothing carried over from the last one");
    await p4.click("dialog.review .review-apply");
    await p4.waitForSelector("dialog.review", { state: "detached" });
    await p4.waitForTimeout(200);
    check(await p4.inputValue("#date") === "2026-11-12" && await p4.inputValue("#address") === "12 King Street, Riverside", "invoice date set from what was said");
    check(await p4.locator(".prod-row", { hasText: "Mango Juice" }).first().locator(".price-input").inputValue() === "250", "the mango price box has the usual $250 on the new invoice");

    // The address test: store, "today", products, no address → three product lines and an empty address.
    await p4.waitForTimeout(700);
    await p4.click("#new-btn");
    await p4.waitForTimeout(300);
    await p4.evaluate(() => window.scrollTo(0, 0));
    await p4.click("#mic-btn");
    await p4.waitForFunction(() => window.__speech.started === 4);
    await p4.evaluate(() => window.__say("Bay Market, today, two dozen mango, one dozen carrot, thirteen ginger beer at 300"));
    await p4.click("#mic-btn");
    await p4.waitForSelector("dialog.review[open]");
    const n6 = await p4.locator("dialog.review .review-line-name").allTextContents();
    const c6 = await p4.locator("dialog.review .review-line-calc").allTextContents();
    check(n6.join(" | ") === "Mango Juice | Carrot Juice | Ginger Beer" && c6.join(" | ") === "24 (2 dozen) × $250.00 | 12 (1 dozen) × $250.00 | 13 × $300.00", "address test: exactly three product lines", `${n6.join(" | ")} — ${c6.join(" | ")}`);
    check(await p4.inputValue("dialog.review textarea[aria-label='Store address']") === "" && await p4.inputValue("dialog.review input[aria-label='Store name']") === "Bay Market", "address test: the address field is empty");
    check(await p4.inputValue("dialog.review input[aria-label='Invoice date']") === TODAY, "address test: 'today' sets today's date");
    check(await p4.locator("dialog.review .review-use-address").isVisible() && /12 King Street/.test(await p4.textContent("dialog.review .review-use-address")), "the store's last address is offered as one tap, not filled in");
    check(await p4.locator("dialog.review .review-line.needs-fix, dialog.review .review-issue").count() === 0 && await p4.textContent("dialog.review .review-total-amt") === "$12,900.00", "address test: no red lines; $6,000 + $3,000 + 13 × $300 = $12,900");
    await p4.setViewportSize({ width: 390, height: 1100 });
    await p4.waitForTimeout(250);
    await p4.screenshot({ path: path.join(OUT, "voice-9-address-test-review.png") });
    await p4.setViewportSize({ width: 390, height: 844 });
    await p4.click("dialog.review .review-apply");
    await p4.waitForSelector("dialog.review", { state: "detached" });
    await p4.waitForTimeout(300);
    check(await p4.inputValue("#store") === "Bay Market" && await p4.inputValue("#address") === "" && await p4.locator(".prod-row.is-on").count() === 3, "on the invoice: Bay Market, empty address, three products ticked");

    // Several guesses from the phone: the reading that matches the most products is used, and no line is dropped —
    // a line nothing matches stays, highlighted, to fix.
    await p4.waitForTimeout(700);
    await p4.click("#new-btn");
    await p4.waitForTimeout(300);
    await p4.evaluate(() => window.scrollTo(0, 0));
    await p4.click("#mic-btn");
    await p4.waitForFunction(() => window.__speech.started === 5);
    await p4.evaluate(() => {
      window.__say("Bay Market today,");
      window.__say("two dozen man go shoes,", true, ["two dozen mango juice,"]);
      window.__say("one dozen carrot, tamarind balls,");
      window.__say("13 ginger bee at 300", true, ["13 ginger beer at 300"]);
    });
    await p4.click("#mic-btn");
    await p4.waitForSelector("dialog.review[open]");
    const n7 = await p4.locator("dialog.review .review-line-name").allTextContents();
    check(n7.join(" | ") === "Mango Juice | Carrot Juice | “tamarind balls” | Ginger Beer", "the phone's other guesses put misheard products right; nothing said is dropped", n7.join(" | "));
    const fix7 = p4.locator("dialog.review .review-line.needs-fix");
    check(await fix7.count() === 1 && /tamarind balls/.test(await fix7.textContent()), "the line nothing matched stays on the review screen, highlighted");
    check(await p4.locator("dialog.review .review-apply").isDisabled() && /Fix 1 highlighted line/.test(await p4.textContent("dialog.review .review-apply")), "…and must be fixed or removed before it goes on the invoice");
    await p4.setViewportSize({ width: 390, height: 1100 });
    await p4.waitForTimeout(250);
    await p4.screenshot({ path: path.join(OUT, "voice-10-unmatched-line.png") });
    await p4.setViewportSize({ width: 390, height: 844 });
    await fix7.locator(".review-line-main").click();
    await p4.locator("dialog.review .review-editor select[aria-label='Product']").selectOption({ label: "Coconut Water" });
    check(await p4.inputValue("dialog.review .review-editor input[aria-label='Price per unit']") === "180", "choosing the product fills in its usual price ($180)", await p4.inputValue("dialog.review .review-editor input[aria-label='Price per unit']"));
    await p4.locator("dialog.review .review-editor input[aria-label='Amount']").fill("6");
    await p4.locator("dialog.review .review-editor").getByRole("button", { name: "Done" }).click();
    check(await p4.locator("dialog.review .review-line.needs-fix").count() === 0 && await p4.locator("dialog.review .review-apply").isEnabled(), "fixed by tapping the line and choosing the product");
    await p4.click("dialog.review button:has-text('Cancel')");
    await p4.waitForSelector("dialog.review", { state: "detached" });

    // Real, messy speech: the review shows exactly what the phone heard; repeats are kept once; the phone's other guess
    // fixes a misheard product; a line nothing matches offers the closest products as one tap.
    await p4.click("#mic-btn");
    await p4.waitForFunction(() => window.__speech.started === 6);
    await p4.evaluate(() => {
      window.__say("bay market 24 mangoes juice at 3:15 per unit");
      window.__say("bay market 24 mangoes juice at 3:15 per unit"); // the phone sends it twice
      window.__say("16 car rot shoes 230 per unit", true, ["16 carrot juice 230 per unit"]);
      window.__say("12 ginger beers to 50 per unit 7 widgets");
    });
    await p4.click("#mic-btn");
    await p4.waitForSelector("dialog.review[open]");
    const heardText = await p4.textContent("dialog.review .review-heard-text");
    check(heardText === "bay market 24 mangoes juice at 3:15 per unit 16 car rot shoes 230 per unit 12 ginger beers to 50 per unit 7 widgets",
      "the review shows exactly what the phone heard (a repeated phrase only once)", heardText);
    check(/16 carrot juice 230 per unit/.test(await p4.textContent("dialog.review .review-heard-used")), "…and says when it used the phone's other guess");
    const n8 = await p4.locator("dialog.review .review-line-name").allTextContents();
    const c8 = await p4.locator("dialog.review .review-line-calc").allTextContents();
    check(n8.join(" | ") === "Mango Juice | Carrot Juice | Ginger Beer | “widgets”" && c8.slice(0, 3).join(" | ") === "24 × $315.00 | 16 × $230.00 | 12 × $250.00",
      "messy speech: products matched by sound, '3:15' and 'to 50' read as prices", `${n8.join(" | ")} — ${c8.join(" | ")}`);
    const unclear = p4.locator("dialog.review .review-line.needs-fix");
    check(await unclear.count() === 1 && /Closest:/.test(await unclear.textContent()) && await unclear.locator(".review-chip").count() >= 1, "the unclear line offers the closest products as one tap", await unclear.textContent());
    await p4.setViewportSize({ width: 390, height: 1150 });
    await p4.waitForTimeout(250);
    await p4.screenshot({ path: path.join(OUT, "voice-11-heard-transcript.png") });
    await p4.setViewportSize({ width: 390, height: 844 });
    await unclear.locator(".review-chip").first().click();
    check(await p4.locator("dialog.review .review-line.needs-fix").count() === 0, "one tap on a suggestion fixes it");
    await p4.click("dialog.review button:has-text('Cancel')");
    await p4.waitForSelector("dialog.review", { state: "detached" });

    // Words before the products that weren't a product or a clear address: highlighted, with "use as the address".
    await p4.click("#mic-btn");
    await p4.waitForFunction(() => window.__speech.started === 7);
    await p4.evaluate(() => window.__say("Bay Market, Riverside, two dozen mango"));
    await p4.click("#mic-btn");
    await p4.waitForSelector("dialog.review[open]");
    const chip = p4.locator("dialog.review .review-chip-address");
    check(await chip.count() === 1 && /Use “Riverside” as the address/.test(await chip.textContent()), "a word that might be the address is kept, with one tap to use it as the address");
    await chip.click();
    check(await p4.inputValue("dialog.review textarea[aria-label='Store address']") === "Riverside" && await p4.locator("dialog.review .review-line").count() === 1, "one tap: it's the address, and the line goes");
    await p4.click("dialog.review button:has-text('Cancel')");
    await p4.waitForSelector("dialog.review", { state: "detached" });
    await c4.close();
    check(errors.length === 0, "no console errors (test sentence)", errors.join(" | "));
  } finally {
    await browser.close();
    await srv.close();
  }
  console.log(failures ? `\n${failures} check(s) failed` : "\nAll voice checks passed");
  process.exit(failures ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
