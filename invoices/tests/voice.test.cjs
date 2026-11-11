/**
 * Voice entry end to end, with a stand-in speech recogniser (Playwright can't speak into a microphone):
 * mic toggle, live text, review screen (highlighted lines, tap to fix), putting it on the invoice, units,
 * the keyboard-dictation fallback, and recovering when the browser pauses or refuses to listen.
 */
const { chromium } = require("playwright");
const { start } = require("./serve.cjs");
const path = require("path");

const PORT = 8793, OUT = path.join(__dirname, "output");
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
    await page.goto(`${srv.url}/`);
    await page.waitForFunction(() => window.__appReady === true);

    // One mic button: tap to start.
    check(await page.locator("#mic-btn").count() === 1 && (await page.textContent("#mic-btn")).trim() === "Speak the invoice" && await page.locator("#voice-panel").isHidden(), "one mic button, idle");
    await page.screenshot({ path: path.join(OUT, "voice-0-mic-button.png") });
    await page.click("#mic-btn");
    await page.waitForFunction(() => window.__speech.started === 1);
    check(await page.getAttribute("#mic-btn", "aria-pressed") === "true" && (await page.textContent("#mic-btn")).trim() === "Stop listening" && await page.locator("#voice-panel").isVisible(), "tap once: listening (button shows Stop listening)");
    await page.waitForTimeout(100);
    check(await page.evaluate(() => window.__speech.processLocally) === true && /works offline/.test(await page.textContent("#voice-mode")), "uses on-device speech when the phone has it", await page.textContent("#voice-mode"));

    // Speak the whole invoice (the owner's example, plus an unclear 'bammy').
    await page.evaluate(() => window.__say("Sarah Supermarket, 14 Wellington Street, Brownstone, two dozen", false));
    check(/Sarah Supermarket/.test(await page.textContent("#voice-text")), "words appear while speaking");
    await page.evaluate(() => window.__say("Sarah Supermarket, 14 Wellington Street, Brownstone, two dozen beetroot juice, one dozen cucumber juice,"));
    // The browser pauses after a silence: listening carries on by itself.
    await page.evaluate(() => window.__rec.onend());
    await page.waitForFunction(() => window.__speech.started === 2);
    check(await page.getAttribute("#mic-btn", "aria-pressed") === "true", "a pause in the browser doesn't stop listening");
    await page.evaluate(() => window.__say("five dozen large bammy, one dozen bammy, fifty pounds okra at two fifty"));
    await page.screenshot({ path: path.join(OUT, "voice-1-listening.png") });

    // Tap again: stop → review screen.
    await page.click("#mic-btn");
    await page.waitForSelector("dialog.review[open]");
    check(await page.getAttribute("#mic-btn", "aria-pressed") === "false", "tap again: stops listening");
    const store = await page.inputValue("dialog.review input[aria-label='Store name']");
    const address = await page.inputValue("dialog.review textarea[aria-label='Store address']");
    check(store === "Sarah Supermarket" && address === "14 Wellington Street, Brownstone", "review shows store and address", `${store} | ${address}`);
    const names = await page.locator("dialog.review .review-line-name").allTextContents();
    check(names.join(" | ") === "Beetroot Juice | Cucumber Juice | Large Bammy | “bammy” | Okra", "review lists every product heard (the unclear one as heard)", names.join(" | "));
    const fixRows = await page.locator("dialog.review .review-line.needs-fix").count();
    const fixText = await page.textContent("dialog.review .review-line.needs-fix");
    check(fixRows === 1 && /Which product is “bammy”/.test(fixText) && /Mini Bammy/.test(fixText) && /Large Bammy/.test(fixText), "unclear 'bammy' is highlighted with both choices, not guessed", `${fixRows} highlighted`);
    check(await page.locator("dialog.review .review-apply").isDisabled() && /Fix 1 highlighted line/.test(await page.textContent("dialog.review .review-apply")), "can't put it on the invoice until the unclear line is fixed");
    check(/50 lb × \$250\.00/.test(await page.textContent("dialog.review")), "okra by weight at the spoken price: 50 lb × $250.00");
    check(await page.locator("dialog.review .review-line", { hasText: "Cucumber Juice" }).evaluate((e) => !e.classList.contains("needs-fix") && !e.querySelector(".review-issue") && /Add price/.test(e.textContent)),
      "a line with no price yet is plain (not highlighted), with a quiet 'Add price' note");
    await page.screenshot({ path: path.join(OUT, "voice-2-review.png") });

    // Fix by tapping: choose Mini Bammy from the suggestions; add the missing beetroot price.
    await page.locator("dialog.review .review-line.needs-fix .review-chip", { hasText: "Mini Bammy" }).click();
    check(await page.locator("dialog.review .review-line.needs-fix").count() === 0, "one tap on a suggestion fixes the line");
    await page.locator("dialog.review .review-line", { hasText: "Beetroot Juice" }).locator(".review-line-main").click();
    await page.locator("dialog.review .review-editor input[aria-label='Price per unit']").fill("315");
    await page.screenshot({ path: path.join(OUT, "voice-3-fix-line.png") });
    await page.locator("dialog.review .review-editor").getByRole("button", { name: "Done" }).click();
    check(/24 \(2 dozen\) × \$315\.00/.test(await page.textContent("dialog.review")), "tap a line to fix it: price added (2 dozen shown as 24)");
    check(await page.locator("dialog.review .review-apply").isEnabled(), "Put on invoice is ready");
    await page.click("dialog.review .review-apply");
    await page.waitForSelector("dialog.review", { state: "detached" });
    await page.waitForTimeout(300);

    // On the invoice: ticks, amounts, units, prices, total.
    const row = (n) => page.locator(".prod-row", { hasText: n }).first();
    const rowState = async (n) => ({ on: await row(n).evaluate((e) => e.classList.contains("is-on")), qty: await row(n).locator(".qty-input").inputValue(), unit: await row(n).locator(".unit-select").inputValue(), price: await row(n).locator(".price-input").inputValue(), total: await row(n).locator(".line-total").textContent() });
    check(await page.inputValue("#store") === "Sarah Supermarket" && await page.inputValue("#address") === "14 Wellington Street, Brownstone", "store and address filled in");
    const beet = await rowState("Beetroot Juice"), okra = await rowState("Okra"), large = await rowState("Large Bammy");
    check(beet.on && beet.qty === "24" && beet.unit === "each" && beet.price === "315" && beet.total === "$7,560.00", "Beetroot Juice: 2 dozen = 24 × 315", JSON.stringify(beet));
    check(okra.on && okra.qty === "50" && okra.unit === "lb" && okra.price === "250" && okra.total === "$12,500.00", "Okra: 50 lb × 250 (by weight)", JSON.stringify(okra));
    check(large.on && large.qty === "60" && large.unit === "each" && large.total === "—", "Large Bammy: 5 dozen = 60, price still to add", JSON.stringify(large));
    check(!(await row("Pumpkin Punch").evaluate((e) => e.classList.contains("is-on"))), "products not said stay unticked");
    check(await page.textContent("#grand-amount") === "$20,060.00" && await page.textContent("#grand-count") === "5 items", "added up", await page.textContent("#grand-amount"));
    const text = await page.evaluate(async () => { const c = await import("/js/codec.js"); const db = await import("/js/db.js"); await new Promise((r) => setTimeout(r, 700)); return c.invoiceToText(await db.invoices.get(await db.settings.get("currentId"))); });
    check(/24 x \$315\.00 = \$7,560\.00/.test(text) && /50 lb x \$250\.00 = \$12,500\.00/.test(text), "units carried into the saved invoice and its QR text", text.replace(/\n/g, " / "));
    await row("Beetroot Juice").scrollIntoViewIfNeeded();
    await page.screenshot({ path: path.join(OUT, "voice-4-filled.png") });

    // A second voice entry on a filled invoice asks before replacing.
    await page.evaluate(() => window.scrollTo(0, 0));
    await page.click("#mic-btn");
    await page.waitForFunction(() => window.__speech.started === 3);
    await page.evaluate(() => window.__say("three dozen limes at 1200"));
    await page.click("#mic-btn");
    await page.waitForSelector("dialog.review[open]");
    await page.click("dialog.review .review-apply");
    await page.waitForSelector("dialog.sheet[open]");
    check(/already has products/.test(await page.textContent("dialog.sheet[open]")), "asks before replacing products already on the invoice");
    await page.getByRole("button", { name: "Add to them" }).click();
    await page.waitForTimeout(300);
    check((await rowState("Limes")).on && (await rowState("Okra")).on, "'Add to them' keeps the earlier products");
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
    check(/Beetroot Juice[\s\S]*?24 sold/.test(dashText) && /Okra[\s\S]*?50 lb sold/.test(dashText), "dashboard: 2 dozen counts as 24 sold, okra in pounds");
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
    await p2.goto(`${srv.url}/`);
    await p2.waitForFunction(() => window.__appReady === true);
    await p2.click("#mic-btn");
    await p2.waitForSelector("dialog.sheet[open] textarea.dictate-box");
    check(/microphone on your keyboard/.test(await p2.textContent("dialog.sheet[open]")), "no listening available: offers the keyboard microphone");
    await p2.fill("dialog.sheet[open] textarea.dictate-box", "Corner Shop, 6 Hope Road, a dozen limes at 1200, 3 pounds hot pepper at 400");
    await p2.screenshot({ path: path.join(OUT, "voice-5-keyboard-fallback.png") });
    await p2.getByRole("button", { name: "Done" }).click();
    await p2.waitForSelector("dialog.review[open]");
    check(/12 \(1 dozen\) × \$1,200\.00/.test(await p2.textContent("dialog.review")) && /3 lb × \$400\.00/.test(await p2.textContent("dialog.review")), "dictated text goes through the same review");
    await c2.close();

    // The browser refuses to listen part-way (e.g. home-screen app): what was heard carries into the box.
    const c3 = await browser.newContext({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true });
    await c3.addInitScript(FAKE_SPEECH);
    const p3 = await c3.newPage();
    await p3.goto(`${srv.url}/`);
    await p3.waitForFunction(() => window.__appReady === true);
    await p3.evaluate(() => { window.__speech.mode = "cloud"; });
    await p3.click("#mic-btn");
    await p3.waitForFunction(() => window.__speech.started === 1);
    check(await p3.evaluate(() => window.__speech.processLocally) === false, "without on-device speech it uses the browser's own");
    await p3.evaluate(() => { window.__say("Hope Store two dozen okra"); window.__rec.onerror({ error: "service-not-allowed" }); });
    await p3.waitForSelector("dialog.sheet[open] textarea.dictate-box");
    check(await p3.inputValue("dialog.sheet[open] textarea.dictate-box") === "Hope Store two dozen okra", "if listening is refused, the words so far carry into the keyboard box");
    await c3.close();

    // The owner's test sentence: three clean lines, no orange, 24×315 + 16×230 + 12×250 = $14,240.
    const c4 = await browser.newContext({ viewport: { width: 390, height: 844 }, deviceScaleFactor: 2, isMobile: true, hasTouch: true });
    await c4.addInitScript(FAKE_SPEECH);
    const p4 = await c4.newPage();
    p4.on("pageerror", (e) => errors.push("test sentence: " + e.message));
    await p4.goto(`${srv.url}/`);
    await p4.waitForFunction(() => window.__appReady === true);
    await p4.click("#mic-btn");
    await p4.waitForFunction(() => window.__speech.started === 1);
    await p4.evaluate(() => window.__say("Sarah Supermarket, 14 Wellington Street, Brownstone, 24 beetroot juice 315 per unit, 16 green juice 230 per unit, 12 pumpkin punch 250 per unit"));
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
    check(await r4("Beetroot Juice") === "$7,560.00" && await r4("Green Juice") === "$3,680.00" && await r4("Pumpkin Punch") === "$3,000.00", "line totals: quantity × spoken unit price");
    check(await p4.textContent("#grand-amount") === "$14,240.00" && await p4.textContent("#grand-count") === "3 items", "grand total on the invoice: $14,240.00", await p4.textContent("#grand-amount"));
    await p4.locator(".prod-row", { hasText: "Beetroot Juice" }).first().scrollIntoViewIfNeeded();
    await p4.screenshot({ path: path.join(OUT, "voice-7-test-sentence-invoice.png") });

    // The owner's latest test: loose matching, "dozen" = 12, no red lines, no "which product?".
    await p4.waitForTimeout(700);
    await p4.click("#new-btn");
    await p4.waitForTimeout(300);
    await p4.evaluate(() => window.scrollTo(0, 0));
    await p4.click("#mic-btn");
    await p4.waitForFunction(() => window.__speech.started === 2);
    await p4.evaluate(() => window.__say("Sarah Supermarket, 14 Wellington Street, two dozen beetroot, one dozen cucumber, five dozen large bammy, fifty pounds okra at two fifty"));
    await p4.click("#mic-btn");
    await p4.waitForSelector("dialog.review[open]");
    const n5 = await p4.locator("dialog.review .review-line-name").allTextContents();
    const c5 = await p4.locator("dialog.review .review-line-calc").allTextContents();
    check(n5.join(" | ") === "Beetroot Juice | Cucumber Juice | Large Bammy | Okra", "latest test: every product matched", n5.join(" | "));
    check(c5.join(" | ") === "24 (2 dozen) × no price | 12 (1 dozen) × no price | 60 (5 dozen) × no price | 50 lb × $250.00", "latest test: dozens become 24, 12 and 60; okra 50 lb × $250", c5.join(" | "));
    check(await p4.locator("dialog.review .review-line.needs-fix, dialog.review .review-issue").count() === 0 && !/Which product/.test(await p4.textContent("dialog.review")), "latest test: no red lines, no 'which product?'");
    check(await p4.inputValue("dialog.review input[aria-label='Store name']") === "Sarah Supermarket" && await p4.inputValue("dialog.review textarea[aria-label='Store address']") === "14 Wellington Street", "latest test: store and address");
    check(await p4.locator("dialog.review .review-apply").isEnabled() && await p4.textContent("dialog.review .review-total-amt") === "$12,500.00", "latest test: ready to put on the invoice ($12,500 priced so far)", await p4.textContent("dialog.review .review-total-amt"));
    await p4.screenshot({ path: path.join(OUT, "voice-8-latest-test-review.png") });
    await p4.click("dialog.review .review-apply");
    await p4.waitForSelector("dialog.review", { state: "detached" });
    await p4.waitForTimeout(300);
    const q5 = (n) => p4.locator(".prod-row", { hasText: n }).first().locator(".qty-input").inputValue();
    check(await q5("Beetroot Juice") === "24" && await q5("Cucumber Juice") === "12" && await q5("Large Bammy") === "60" && await q5("Okra") === "50", "latest test: on the invoice as 24, 12, 60 and 50 lb");

    // A spoken date sets the invoice date (not the address); and the next invoice starts fresh (no $315 carried over).
    await p4.waitForTimeout(700);
    await p4.click("#new-btn");
    await p4.waitForTimeout(300);
    await p4.evaluate(() => window.scrollTo(0, 0));
    await p4.click("#mic-btn");
    await p4.waitForFunction(() => window.__speech.started === 3);
    await p4.evaluate(() => window.__say("Sarah Supermarket, 12th of the 11th 2026, 14 Wellington Street, Brownstone, 24 beetroot juice"));
    await p4.click("#mic-btn");
    await p4.waitForSelector("dialog.review[open]");
    check(await p4.inputValue("dialog.review input[aria-label='Invoice date']") === "2026-11-12" && await p4.inputValue("dialog.review textarea[aria-label='Store address']") === "14 Wellington Street, Brownstone", "'12th of the 11th 2026' → date 12 Nov 2026, kept out of the address");
    check(/24 × no price/.test(await p4.textContent("dialog.review")) && !/315/.test(await p4.textContent("dialog.review")), "next invoice starts fresh: no price carried over from the last one");
    await p4.click("dialog.review .review-apply");
    await p4.waitForSelector("dialog.review", { state: "detached" });
    await p4.waitForTimeout(200);
    check(await p4.inputValue("#date") === "2026-11-12" && await p4.inputValue("#address") === "14 Wellington Street, Brownstone", "invoice date set from what was said");
    check(await p4.locator(".prod-row", { hasText: "Beetroot Juice" }).first().locator(".price-input").inputValue() === "", "the beetroot price box is empty on the new invoice");
    await c4.close();
    check(errors.length === 0, "no console errors (test sentence)", errors.join(" | "));
  } finally {
    await browser.close();
    await srv.close();
  }
  console.log(failures ? `\n${failures} check(s) failed` : "\nAll voice checks passed");
  process.exit(failures ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
