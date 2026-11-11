/**
 * The signing thank-you in the real app (as approved on /lab/sign): while the customer signs, "Thank you" writes
 * itself across the top of the signature box in step with the finger, and their signature stays visible at the
 * bottom; on lift the name appears, the green tick draws itself, a gentle tap. Saved signature exactly as drawn;
 * reopening a signed invoice shows the settled thank-you with the signature back at the bottom; Clear resets.
 */
const { chromium } = require("playwright");
const { start } = require("./serve.cjs");
const path = require("path");

const PORT = 8798, OUT = path.join(__dirname, "output");
let failures = 0;
const check = (ok, name, extra = "") => { console.log(`${ok ? "PASS" : "FAIL"}  ${name}${extra ? "  — " + extra : ""}`); if (!ok) failures++; };
const MOCK = `window.__buzz = []; Object.defineProperty(navigator, "vibrate", { configurable: true, value: (p) => { window.__buzz.push(p); return true; } });`;

async function touchStroke(page, cdp, { x0, y, w, n = 36, shot = null }) {
  await cdp.send("Input.dispatchTouchEvent", { type: "touchStart", touchPoints: [{ x: x0, y, id: 1 }] });
  for (let i = 1; i <= n; i++) {
    const u = i / n;
    await cdp.send("Input.dispatchTouchEvent", { type: "touchMove", touchPoints: [{ x: x0 + u * w, y: y - Math.sin(u * Math.PI * 3) * 24 + Math.cos(u * 13) * 4, id: 1 }] });
    await page.waitForTimeout(15);
    if (shot && i === shot.at) await shot.fn();
  }
  await cdp.send("Input.dispatchTouchEvent", { type: "touchEnd", touchPoints: [] });
}
/** Rows of the signature canvas that hold ink, as fractions of its height. */
const inkRows = (page) => page.evaluate(() => {
  const c = document.getElementById("sign-canvas"), g = c.getContext("2d"), d = g.getImageData(0, 0, c.width, c.height).data;
  let top = 1, bottom = 0;
  for (let y = 0; y < c.height; y++) for (let x = 0; x < c.width; x += 2) if (d[(y * c.width + x) * 4 + 3] > 128) { top = Math.min(top, y / c.height); bottom = Math.max(bottom, y / c.height); break; }
  return { top, bottom };
});

(async () => {
  const srv = await start(PORT);
  const browser = await chromium.launch();
  const errors = [];
  try {
    const ctx = await browser.newContext({ viewport: { width: 390, height: 844 }, deviceScaleFactor: 2, isMobile: true, hasTouch: true });
    await ctx.addInitScript(MOCK);
    const page = await ctx.newPage();
    page.on("pageerror", (e) => errors.push(e.message));
    page.on("console", (m) => { if (m.type() === "error") errors.push(m.text()); });
    await page.goto(`${srv.url}/`);
    await page.waitForFunction(() => window.__appReady === true);
    await page.fill("#store", "Sarah Supermarket");
    const row = (n) => page.locator(".prod-row", { hasText: n }).first();
    await row("Green Juice").locator(".prod-check").click();
    await row("Green Juice").locator(".qty-input").fill("13");
    await row("Green Juice").locator(".price-input").fill("300");
    await page.waitForTimeout(700);
    await page.locator("#sign-pad").scrollIntoViewIfNeeded();
    await page.evaluate(() => window.scrollBy(0, 120));
    const cdp = await ctx.newCDPSession(page);
    const box = await page.locator("#sign-pad").boundingBox();
    check(box.height >= 230, "the signature box has room for the thank-you above the signing line", `${Math.round(box.height)} px tall`);

    // While signing: the words write themselves at the top, in step with the finger; the signature shows where it's drawn.
    let mid = null;
    await touchStroke(page, cdp, { x0: box.x + 26, y: box.y + box.height * 0.72, w: box.width * 0.48, n: 40, shot: { at: 30, fn: async () => {
      await page.waitForTimeout(60);
      mid = await page.evaluate(() => ({ cls: document.getElementById("sign-pad").className, done: !document.getElementById("sign-done").hidden }));
      await page.screenshot({ path: path.join(OUT, "sign-thanks-1-writing.png") });
    } } });
    const inkTop = await page.evaluate(() => { const c = document.querySelector(".sign-thanks-ink"); const g = c.getContext("2d"); const d = g.getImageData(0, 0, c.width, c.height).data; let n = 0; for (let i = 3; i < d.length; i += 4) if (d[i] > 128) n++; return n; });
    check(/is-writing/.test(mid.cls) && inkTop > 300 && !mid.done, "while signing, 'Thank you' is being written (Done waits)", `${inkTop} px of script`);
    const sig1 = await inkRows(page);
    check(await page.evaluate(() => getComputedStyle(document.getElementById("sign-canvas")).opacity) === "1" && sig1.top > 0.5, "the customer's signature stays visible, at the bottom where they sign", JSON.stringify(sig1));
    await page.waitForTimeout(250);
    await touchStroke(page, cdp, { x0: box.x + box.width * 0.52, y: box.y + box.height * 0.74, w: box.width * 0.42, n: 34 });

    // On lift: words finish, name under them, the green tick, a gentle tap; then Done.
    await page.waitForSelector("#sign-done", { state: "visible", timeout: 8000 });
    await page.waitForTimeout(150);
    const end = await page.evaluate(() => ({
      who: document.querySelector(".sign-thanks-who").textContent,
      shown: document.querySelector(".sign-thanks-sealed").classList.contains("is-shown"),
      tick: parseFloat(getComputedStyle(document.querySelector(".sign-thanks-check .tick")).strokeDashoffset),
      stroke: getComputedStyle(document.querySelector(".sign-thanks-check .tick")).stroke,
      buzz: window.__buzz, status: document.getElementById("sign-status").textContent,
    }));
    check(end.who === "Sarah Supermarket" && end.shown, "'Thank you' finishes and the customer's name appears under it", end.who);
    check(end.tick < 1 && end.stroke === "rgb(23, 99, 63)", "then the green tick draws itself");
    check(JSON.stringify(end.buzz) === "[35]", "with one gentle tap", JSON.stringify(end.buzz));
    check(/^Signed/.test(end.status), "the invoice is signed", end.status);
    const sig2 = await inkRows(page);
    check(sig2.top > 0.5 && sig2.bottom < 0.95, "the signature is still there at the bottom", JSON.stringify(sig2));
    await page.screenshot({ path: path.join(OUT, "sign-thanks-2-done.png") });

    // Saved exactly as drawn: the app's 900×300 signature, no script in it.
    const saved = await page.evaluate(async () => {
      const db = await import("/js/db.js"); await new Promise((r) => setTimeout(r, 700));
      const inv = await db.invoices.get(await db.settings.get("currentId"));
      const img = new Image(); img.src = inv.signature; await img.decode();
      return { w: img.naturalWidth, h: img.naturalHeight };
    });
    check(saved.w === 900 && saved.h === 300, "the real signature is saved (900×300, as before)", JSON.stringify(saved));

    // Done still opens the full-screen thank-you with the invoice number and total.
    await page.click("#sign-done");
    await page.waitForSelector(".thanks");
    check(/Thank you, Sarah Supermarket/.test(await page.textContent(".thanks")) && /\$3,900\.00/.test(await page.textContent(".thanks")), "Done still shows the thank-you with the invoice number and total");
    await page.waitForSelector(".thanks", { state: "detached", timeout: 5000 });

    // Reopened: the settled thank-you at once (no animation, no tap), the saved signature back at the bottom.
    await page.reload();
    await page.waitForFunction(() => window.__appReady === true);
    await page.waitForTimeout(500);
    const re = await page.evaluate(() => ({ cls: document.getElementById("sign-pad").className, who: document.querySelector(".sign-thanks-who").textContent, buzz: window.__buzz }));
    check(/is-static/.test(re.cls) && /is-thanked/.test(re.cls) && re.who === "Sarah Supermarket" && re.buzz.length === 0, "reopened: the thank-you is shown settled, with no animation and no tap", JSON.stringify(re));
    const sig3 = await inkRows(page);
    check(sig3.top > 0.45, "reopened: the saved signature is drawn back at the bottom, below the thank-you", JSON.stringify(sig3));
    await page.locator("#sign-pad").scrollIntoViewIfNeeded();
    await page.evaluate(() => window.scrollBy(0, 120));
    await page.screenshot({ path: path.join(OUT, "sign-thanks-3-reopened.png") });

    // Clear: an empty box again, ready for a new signature.
    await page.click("#sign-clear");
    await page.waitForTimeout(150);
    check(await page.evaluate(() => !/is-thanked|is-static/.test(document.getElementById("sign-pad").className) && !document.querySelector(".sign-thanks-sealed").classList.contains("is-shown")), "Clear empties the box");

    // A tap isn't signing: no thank-you.
    const b2 = await page.locator("#sign-pad").boundingBox();
    await cdp.send("Input.dispatchTouchEvent", { type: "touchStart", touchPoints: [{ x: b2.x + 120, y: b2.y + 170, id: 1 }] });
    await cdp.send("Input.dispatchTouchEvent", { type: "touchEnd", touchPoints: [] });
    await page.waitForTimeout(1200);
    check(await page.evaluate(() => !document.getElementById("sign-pad").classList.contains("is-thanked")), "a tap alone doesn't bring the thank-you");

    // No store name: just "Thank you" and the tick.
    await page.click("#sign-clear").catch(() => {});
    await page.evaluate(() => window.scrollTo(0, 0));
    await page.fill("#store", "");
    await page.waitForTimeout(300);
    await page.locator("#sign-pad").scrollIntoViewIfNeeded();
    const b3 = await page.locator("#sign-pad").boundingBox();
    await touchStroke(page, cdp, { x0: b3.x + 30, y: b3.y + b3.height * 0.72, w: b3.width * 0.8, n: 50 });
    await page.waitForSelector("#sign-done", { state: "visible", timeout: 8000 });
    check(await page.evaluate(() => document.querySelector(".sign-thanks-who").hidden && document.querySelector(".sign-thanks-sealed").classList.contains("is-checked")), "with no store name: 'Thank you' and the tick");

    check(errors.length === 0, "no console errors", errors.join(" | "));
  } finally {
    await browser.close();
    await srv.close();
  }
  console.log(failures ? `\n${failures} check(s) failed` : "\nAll sign-thanks checks passed");
  process.exit(failures ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
