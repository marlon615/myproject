/**
 * Paper sizes and the install page:
 *   - the emailed / printed invoice (Share PDF, the customer's Save PDF) is ONE US Letter page, even with 60 products;
 *   - "Receipt size": a narrow copy for 58 mm / 80 mm thermal printers — a pure black-and-white picture exactly
 *     384 / 576 dots wide, shared to the printer's app; the QR on it still scans;
 *   - the install page shows the right steps for Android (Chrome, Samsung Internet, Firefox, in-app browsers) and
 *     iPhone (Safari, Chrome) — and never iPhone steps on an Android phone.
 */
const { chromium, devices } = require("playwright");
const { start } = require("./serve.cjs");
const { setUp, appUrl } = require("./fixture.cjs");
const jsQR = require("jsqr");
const fs = require("fs"), path = require("path"), { execFileSync } = require("child_process");

const PORT = 8803, OUT = path.join(__dirname, "output");
let failures = 0;
const check = (ok, name, extra = "") => { console.log(`${ok ? "PASS" : "FAIL"}  ${name}${extra ? "  — " + extra : ""}`); if (!ok) failures++; };
const SHARE_MOCK = `
  window.__shared = [];
  navigator.canShare = (d) => !!(d && d.files && d.files.length);
  navigator.share = async (d) => { const f = d.files[0]; const b = new Uint8Array(await f.arrayBuffer()); let s = ""; for (let i = 0; i < b.length; i += 0x8000) s += String.fromCharCode(...b.subarray(i, i + 0x8000));
    window.__shared.push({ name: f.name, type: f.type, size: b.length, b64: btoa(s) }); };
`;

(async () => {
  fs.mkdirSync(OUT, { recursive: true });
  const srv = await start(PORT);
  const browser = await chromium.launch();
  const errors = [];
  try {
    const ctx = await browser.newContext({ viewport: { width: 390, height: 844 }, deviceScaleFactor: 1 });
    await ctx.addInitScript(SHARE_MOCK);
    const page = await ctx.newPage();
    page.on("pageerror", (e) => errors.push(e.message));
    await page.goto(`${srv.url}/__tests/print-harness.html`);
    await page.waitForFunction(() => window.ready === true);

    // ── The emailed invoice: one US Letter page ────────────────────────────────────────────────────────────────
    for (const n of [3, 18, 60]) {
      const file = path.join(OUT, `letter-${n}items.pdf`);
      fs.writeFileSync(file, Buffer.from(await page.evaluate((k) => T.letterB64(k), n), "base64"));
      const info = execFileSync("pdfinfo", [file], { encoding: "utf8" });
      const pages = /Pages:\s+(\d+)/.exec(info)?.[1], size = /Page size:\s+([\d.]+) x ([\d.]+)/.exec(info);
      check(pages === "1" && size && Number(size[1]) === 612 && Number(size[2]) === 792, `${n} products: the emailed PDF is exactly one US Letter page (8.5 × 11 in)`, `pages=${pages} size=${size?.[1]}x${size?.[2]}pt`);
      execFileSync("pdftoppm", ["-png", "-r", "60", "-singlefile", file, file.replace(/\.pdf$/, "")]);
      const text = execFileSync("pdftotext", [file, "-"], { encoding: "utf8" }).trim();
      check(text === "", `${n} products: (the page is a picture, so it prints exactly as it looks)`, text.slice(0, 40));
    }
    // Nothing cut off at the bottom, and the last product and the thank-you are on the page (60 products).
    const big = await page.evaluate(async () => {
      const r = await T.letterPng(60);
      const img = new Image(); img.src = r.png; await img.decode();
      const c = document.createElement("canvas"); c.width = img.width; c.height = img.height; const x = c.getContext("2d"); x.drawImage(img, 0, 0);
      const d = x.getImageData(0, 0, c.width, c.height).data;
      const inkRows = []; for (let y = 0; y < c.height; y += 4) { let ink = 0; for (let xx = 0; xx < c.width; xx += 4) { const k = (y * c.width + xx) * 4; if (d[k] < 120) ink++; } if (ink > 2) inkRows.push(y); }
      return { w: r.w, h: r.h, lastInk: inkRows[inkRows.length - 1], firstInk: inkRows[0] };
    });
    check(big.w === 2550 && big.h === 3300 && big.lastInk < big.h - 0.3 * 300, "60 products: everything fits inside the page with a margin at the bottom (shrunk to fit, not cut off)", JSON.stringify(big));
    const shot = path.join(OUT, "letter-18items.png");
    check(fs.existsSync(shot), "letter page picture saved for a look", shot);

    // ── Receipt size for thermal printers ──────────────────────────────────────────────────────────────────────
    for (const paper of [58, 80]) {
      const r = await page.evaluate(async ([p]) => {
        const t = await T.thermal(5, p);
        const img = new Image(); img.src = t.url; await img.decode();
        const c = document.createElement("canvas"); c.width = img.width; c.height = img.height; const x = c.getContext("2d"); x.drawImage(img, 0, 0);
        const d = x.getImageData(0, 0, c.width, c.height);
        let grey = 0; for (let i = 0; i < d.data.length; i += 4) { const v = d.data[i]; if (v !== 0 && v !== 255) grey++; }
        return { name: t.name, type: t.type, w: c.width, h: c.height, grey, rgba: Array.from(d.data) };
      }, [paper]);
      const want = paper === 80 ? 576 : 384;
      check(r.type === "image/png" && r.w === want && r.h > r.w, `Receipt size ${paper} mm: a picture exactly ${want} dots wide (the printer's width)`, `${r.name} ${r.w}×${r.h}`);
      check(r.grey === 0, `Receipt size ${paper} mm: pure black and white (no faint grey on thermal paper)`, `${r.grey} grey pixels`);
      const code = jsQR(Uint8ClampedArray.from(r.rgba), r.w, r.h);
      check(Boolean(code && /\/v#2~/.test(code.data)), `Receipt size ${paper} mm: the QR code on it still scans`, code ? code.data.slice(0, 40) : "no QR");
    }
    await ctx.close();

    // ── In the app: Share PDF (letter) and Receipt size → the share sheet ──────────────────────────────────────
    const appCtx = await browser.newContext({ viewport: { width: 390, height: 844 }, deviceScaleFactor: 2, isMobile: true, hasTouch: true });
    await appCtx.addInitScript(SHARE_MOCK);
    const app = await appCtx.newPage();
    app.on("pageerror", (e) => errors.push("app: " + e.message));
    await app.goto(appUrl(srv));
    await setUp(app);
    await app.fill("#store", "Bay Market");
    await app.locator(".prod-row", { hasText: "Mango Juice" }).first().locator(".prod-check").click();
    await app.waitForTimeout(600);
    const before = await app.locator("#invoice-screen").boundingBox();
    check(/Share PDF \(letter page\)/.test(await app.textContent("#share-pdf-btn")) && /Receipt size/.test(await app.textContent("#receipt-size-btn")), "the invoice has 'Share PDF (letter page)' and 'Receipt size (58 / 80 mm)'");
    await app.click("#share-pdf-btn");
    await app.waitForFunction(() => window.__shared.length === 1, null, { timeout: 10000 });
    const pdf = await app.evaluate(() => window.__shared[0]);
    const pdfFile = path.join(OUT, "app-share-letter.pdf");
    fs.writeFileSync(pdfFile, Buffer.from(pdf.b64, "base64"));
    const pinfo = execFileSync("pdfinfo", [pdfFile], { encoding: "utf8" });
    check(pdf.type === "application/pdf" && /Pages:\s+1\b/.test(pinfo) && /612 x 792/.test(pinfo), "Share PDF in the app hands over a one-page US Letter PDF (for email)", `${pdf.name}`);
    await app.locator("#receipt-size-btn").scrollIntoViewIfNeeded();
    await app.click("#receipt-size-btn");
    await app.waitForSelector("dialog.sheet[open]");
    check(/Receipt size/.test(await app.textContent("dialog.sheet[open]")), "Receipt size asks 58 mm or 80 mm");
    await app.screenshot({ path: path.join(OUT, "receipt-size-sheet.png") });
    await app.locator("dialog.sheet[open]").getByRole("button", { name: "80 mm", exact: true }).click();
    await app.waitForFunction(() => window.__shared.length === 2, null, { timeout: 10000 });
    const rcpt = await app.evaluate(() => window.__shared[1]);
    fs.writeFileSync(path.join(OUT, "app-receipt-80mm.png"), Buffer.from(rcpt.b64, "base64"));
    check(rcpt.type === "image/png" && /^Receipt-80mm-/.test(rcpt.name), "…and shares the 80 mm receipt picture to the share sheet (then the printer's app)", rcpt.name);
    const dims = execFileSync("python3", ["-c", "import sys;from PIL import Image;i=Image.open(sys.argv[1]);print(i.size[0])", path.join(OUT, "app-receipt-80mm.png")], { encoding: "utf8" }).trim();
    check(dims === "576", "the 80 mm picture is 576 dots wide", dims);
    const after = await app.locator("#invoice-screen").boundingBox();
    check(Math.abs(after.width - before.width) < 1 && await app.locator(".prod-row").count() > 0, "the on-screen invoice is unchanged");
    await appCtx.close();

    // ── Install page steps by phone and browser ────────────────────────────────────────────────────────────────
    const ANDROID = "Mozilla/5.0 (Linux; Android 14; SM-S918B) AppleWebKit/537.36 (KHTML, like Gecko)";
    const cases = [
      ["Android · Chrome", `${ANDROID} Chrome/130.0 Mobile Safari/537.36`, false, /menu \(⋮\) at the top right of Chrome/, "android"],
      ["Android · Samsung Internet", `${ANDROID} SamsungBrowser/26.0 Chrome/122.0 Mobile Safari/537.36`, false, /Samsung Internet[\s\S]*Add page to[\s\S]*Home screen/, "android"],
      ["Android · Firefox", "Mozilla/5.0 (Android 14; Mobile; rv:132.0) Gecko/132.0 Firefox/132.0", false, /menu \(⋮\) in Firefox/, "android"],
      ["Android · Facebook's built-in browser", `${ANDROID} Chrome/130.0 Mobile Safari/537.36 [FBAN/EMA;FBLC/en_US;FBAV/480.0]`, false, /Open in Chrome/, "android"],
      ["Android browser that reports the iPhone-only setting", `${ANDROID} Chrome/130.0 Mobile Safari/537.36`, true, /menu \(⋮\) at the top right of Chrome/, "android"],
      ["iPhone · Safari", devices["iPhone 13"].userAgent, true, /Share button[\s\S]*bottom of Safari/, "ios"],
      ["iPhone · Chrome", devices["iPhone 13"].userAgent.replace(/Version\/[\d.]+/, "CriOS/130.0"), true, /top right of Chrome/, "ios"],
    ];
    for (const [label, ua, standaloneProp, want, platform] of cases) {
      const c = await browser.newContext({ viewport: { width: 390, height: 844 }, deviceScaleFactor: 2, isMobile: true, hasTouch: true, userAgent: ua });
      if (standaloneProp) await c.addInitScript(() => Object.defineProperty(navigator, "standalone", { get: () => false }));
      const p = await c.newPage();
      await p.goto(appUrl(srv));
      await p.waitForSelector(".gate[data-reason='install']");
      const t = (await p.textContent(".gate")).replace(/\s+/g, " ");
      const plat = await p.getAttribute(".gate", "data-platform");
      check(want.test(t) && plat === platform && (platform === "ios" || !/Safari|square with an arrow/.test(t)), `${label}: the right steps`, t.slice(t.indexOf("1") > 0 ? 0 : 0, 200));
      if (label === "Android · Samsung Internet") await p.screenshot({ path: path.join(OUT, "install-android-samsung.png") });
      if (label === "Android · Chrome") await p.screenshot({ path: path.join(OUT, "install-android-chrome.png") });
      await c.close();
    }
    check(errors.length === 0, "no page errors", errors.join(" | "));
  } finally {
    await browser.close();
    await srv.close();
  }
  console.log(failures ? `\n${failures} check(s) failed` : "\nAll print-size checks passed");
  process.exit(failures ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
