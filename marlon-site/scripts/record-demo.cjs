/**
 * Records the demo video from the REAL Marlon app (marlon-app/public, served locally exactly as deployed), at phone
 * size, with a made-up sample business that is labelled as one. Nothing in marlon-app is changed: it is only served.
 *   node scripts/record-demo.cjs   → public/media/marlon-demo.mp4 (+ poster.jpg)
 */
const { chromium } = require("playwright");
const path = require("path"), fs = require("fs"), { execFileSync } = require("child_process");
const APP = path.join(__dirname, "..", "..", "marlon-app");
const { start } = require(path.join(APP, "tests", "serve.cjs"));
const { appUrl } = require(path.join(APP, "tests", "fixture.cjs"));
const OUT = path.join(__dirname, "..", "public", "media"), TMP = path.join(__dirname, "..", ".video-tmp");

const SAMPLE = {
  name: "Sample Foods (demo)", address: "Demo address only", phone: "+1 000 000 0000",
  products: [["Mango Juice", "2.50", "each"], ["Coconut Water", "1.80", "each"], ["Eggs", "4.80", "dozen"], ["Sweet Potato", "1.20", "lb"]],
};
const MOCKS = `
  Object.defineProperty(navigator, "vibrate", { configurable: true, value: () => true });
  navigator.canShare = (d) => !!(d && d.files);
  navigator.share = async () => {};
`;
// A caption pill drawn over the recording (the app itself is untouched).
const CAPTION_JS = (t) => {
  let c = document.getElementById("__cap");
  if (!c) {
    c = document.createElement("div"); c.id = "__cap";
    c.style.cssText = "position:fixed;left:12px;right:12px;bottom:18px;z-index:2147483647;background:rgba(10,20,15,.9);color:#fff;font:600 16px/1.35 -apple-system,Segoe UI,Roboto,sans-serif;padding:12px 16px;border-radius:14px;text-align:center;box-shadow:0 8px 24px rgba(0,0,0,.3);transition:opacity .25s;pointer-events:none";
    document.documentElement.appendChild(c);
  }
  c.style.opacity = t ? "1" : "0"; if (t) c.textContent = t;
};

(async () => {
  fs.rmSync(TMP, { recursive: true, force: true });
  const srv = await start(8899);
  const browser = await chromium.launch();
  const ctx = await browser.newContext({ viewport: { width: 390, height: 844 }, deviceScaleFactor: 2, isMobile: true, hasTouch: true, bypassCSP: true });
  await ctx.addInitScript(MOCKS);
  const page = await ctx.newPage();
  // Chrome's own screen capture at full pixel size (Playwright's recorder captures at CSS size). Frames arrive when
  // the screen changes; each is kept with its time and shown until the next one.
  fs.mkdirSync(TMP, { recursive: true });
  const cdp = await ctx.newCDPSession(page), frames = [];
  cdp.on("Page.screencastFrame", async (f) => {
    const file = path.join(TMP, `f${String(frames.length).padStart(5, "0")}.jpg`);
    fs.writeFileSync(file, Buffer.from(f.data, "base64"));
    frames.push({ file, t: f.metadata.timestamp });
    await cdp.send("Page.screencastFrameAck", { sessionId: f.sessionId }).catch(() => {});
  });
  await cdp.send("Page.startScreencast", { format: "jpeg", quality: 92, maxWidth: 780, maxHeight: 1688, everyNthFrame: 1 });
  const t0 = Date.now(), marks = [];
  const cap = async (t, ms = 0) => { await page.evaluate(CAPTION_JS, t).catch(() => {}); if (t) marks.push([((Date.now() - t0) / 1000).toFixed(1), t]); if (ms) await page.waitForTimeout(ms); };
  const pause = (ms) => page.waitForTimeout(ms);
  try {
    await page.goto(appUrl(srv));
    await page.waitForFunction(() => window.__appReady === true, null, { timeout: 20000 });
    await page.waitForSelector("#setup-name", { timeout: 15000 });
    await cap("First open: the business types its name and products once.", 1800);
    await page.type("#setup-name", SAMPLE.name, { delay: 45 });
    await page.fill("#setup-address", SAMPLE.address);
    await page.fill("#setup-phone", SAMPLE.phone);
    const rows = () => page.locator(".setup-prow");
    for (let i = 0; i < SAMPLE.products.length; i++) {
      if (i >= await rows().count()) await page.click(".setup-add");
      const r = rows().nth(i), [n, p, u] = SAMPLE.products[i];
      await r.scrollIntoViewIfNeeded();
      await r.locator(".setup-pname").type(n, { delay: 25 });
      await r.locator(".setup-pprice").fill(p);
      await r.locator(".setup-punit").selectOption(u);
    }
    await pause(600);
    await page.click(".setup-start");
    await page.waitForSelector("#invoice-screen:not([hidden])");
    await cap("No signal on the route? Marlon keeps working offline.", 2200);
    await ctx.setOffline(true);
    await cap("Type the store, tick the products, set the quantity.", 900);
    await page.type("#store", "Bay Market (sample)", { delay: 45 });
    await page.type("#address", "12 Sample Street", { delay: 30 });
    const row = (n) => page.locator(".prod-row", { hasText: n }).first();
    for (const [n, q] of [["Mango Juice", "24"], ["Eggs", "5"], ["Sweet Potato", "40"]]) {
      await row(n).scrollIntoViewIfNeeded();
      await row(n).locator(".prod-check").click(); await pause(250);
      await row(n).locator(".qty-input").fill(""); await row(n).locator(".qty-input").type(q, { delay: 90 });
      await pause(450);
    }
    await cap("Totals add themselves up. Usual prices fill in, and can be changed.", 2400);
    await page.locator("#sign-canvas").scrollIntoViewIfNeeded();
    await cap("The store signs with a finger, right on the phone.", 700);
    const b = await page.locator("#sign-canvas").boundingBox();
    await page.mouse.move(b.x + 40, b.y + 110); await page.mouse.down();
    for (let i = 1; i <= 22; i++) { await page.mouse.move(b.x + 40 + i * 11, b.y + 110 - Math.sin(i / 2) * 38); await pause(28); }
    await page.mouse.up();
    await page.waitForSelector("#sign-done", { state: "visible", timeout: 6000 });
    await pause(1600);
    await page.click("#sign-done");
    await cap("Done.", 0);
    await page.waitForSelector(".thanks");
    await page.waitForSelector(".thanks", { state: "detached", timeout: 6000 });
    await cap("Share the invoice: QR code, PDF or picture by WhatsApp or email, or print it.", 3200);
    await page.click("#finish-btn");
    await page.waitForSelector("dialog.pay[open]");
    await cap("Only the owner sees payment: cash, 7 days or 14 days.", 2400);
    await page.click("dialog.pay .pay-option[data-choice='7']");
    await page.waitForSelector("dialog.pay", { state: "detached" });
    await pause(500);
    await cap("The owner's dashboard is locked with a PIN.", 600);
    await page.click("#owner-link");
    await page.waitForSelector(".dash-key");
    const pin = async () => { for (const d of "1357") { await page.locator(`.dash-key[aria-label="${d}"]`).click(); await pause(160); } };
    await pin();
    await page.getByRole("button", { name: "Continue" }).click();
    await page.waitForSelector("text=Enter the same PIN again");
    await pin();
    await page.waitForSelector(".dash-kpi", { timeout: 8000 });
    await cap("Totals, unpaid invoices with due dates, and every invoice — all on the phone.", 2600);
    await page.evaluate(() => window.scrollBy({ top: 420, behavior: "smooth" })); await pause(1600);
    await page.evaluate(() => window.scrollBy({ top: 420, behavior: "smooth" })); await pause(1600);
    await cap("Marlon. Offline delivery invoicing for any business.", 2600);
  } finally {
    await cdp.send("Page.stopScreencast").catch(() => {});
    const endT = Date.now() / 1000;
    await ctx.close(); await browser.close(); await srv.close();
    fs.mkdirSync(OUT, { recursive: true });
    const mp4 = path.join(OUT, "marlon-demo.mp4");
    // ffmpeg concat list: each frame lasts until the next one arrives (the last one until recording stopped).
    const list = frames.map((f, i) => `file '${f.file}'\nduration ${Math.max(0.001, ((frames[i + 1]?.t ?? endT) - f.t)).toFixed(3)}`).join("\n")
      + `\nfile '${frames[frames.length - 1].file}'\n`;
    fs.writeFileSync(path.join(TMP, "list.txt"), list);
    execFileSync("ffmpeg", ["-y", "-loglevel", "error", "-f", "concat", "-safe", "0", "-i", path.join(TMP, "list.txt"),
      "-vf", "scale=540:1168:flags=lanczos,setsar=1,fps=30", "-c:v", "libx264", "-preset", "slow", "-crf", "24", "-pix_fmt", "yuv420p", "-movflags", "+faststart", "-an", mp4]);
    console.log("frames:", frames.length, "first frame at", (frames[0].t - t0 / 1000).toFixed(2), "s after the page opened");
    execFileSync("ffmpeg", ["-y", "-loglevel", "error", "-ss", "9", "-i", mp4, "-frames:v", "1", "-q:v", "4", path.join(OUT, "marlon-demo-poster.jpg")]);
    fs.rmSync(TMP, { recursive: true, force: true });
    console.log("video:", mp4, fs.statSync(mp4).size, "bytes");
    for (const [t, c] of marks) console.log(`  ${t}s  ${c}`);
  }
})();
