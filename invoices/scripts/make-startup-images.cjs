/**
 * Renders the real startup splash at every common iPhone screen size and saves dark launch images
 * (apple-touch-startup-image) into public/splash/, so an installed iPhone app opens straight onto the
 * dark splash instead of flashing a white screen first. Then rewrites the <link> tags in index.html
 * between the markers <!-- startup-images:start --> and <!-- startup-images:end -->.
 *
 * Run after changing the splash:  node scripts/make-startup-images.cjs
 */
const fs = require("fs");
const path = require("path");
const { execFileSync } = require("child_process");
const { chromium } = require("playwright");
const { start } = require("../tests/serve.cjs");

const ROOT = path.join(__dirname, "..");
const OUT = path.join(ROOT, "public", "splash");
const INDEX = path.join(ROOT, "public", "index.html");

// Portrait iPhone screens: CSS width × height and pixel ratio.
const DEVICES = [
  { w: 440, h: 956, dpr: 3, name: "iPhone 16/17 Pro Max" },
  { w: 420, h: 912, dpr: 3, name: "iPhone Air" },
  { w: 402, h: 874, dpr: 3, name: "iPhone 16/17 Pro, iPhone 17" },
  { w: 430, h: 932, dpr: 3, name: "iPhone 14 Pro Max, 15 Plus/Pro Max, 16 Plus" },
  { w: 393, h: 852, dpr: 3, name: "iPhone 14 Pro, 15, 15 Pro, 16" },
  { w: 428, h: 926, dpr: 3, name: "iPhone 12/13 Pro Max, 14 Plus" },
  { w: 390, h: 844, dpr: 3, name: "iPhone 12/13/14, 12/13 Pro, 16e" },
  { w: 375, h: 812, dpr: 3, name: "iPhone X/XS/11 Pro, 12/13 mini" },
  { w: 414, h: 896, dpr: 3, name: "iPhone XS Max, 11 Pro Max" },
  { w: 414, h: 896, dpr: 2, name: "iPhone XR, 11" },
  { w: 414, h: 736, dpr: 3, name: "iPhone 6/7/8 Plus" },
  { w: 375, h: 667, dpr: 2, name: "iPhone 6/7/8, SE (2nd/3rd gen)" },
  { w: 320, h: 568, dpr: 2, name: "iPhone SE (1st gen)" },
];

const fileFor = (d) => `launch-${d.w * d.dpr}x${d.h * d.dpr}.png`;

(async () => {
  const html = fs.readFileSync(INDEX, "utf8");
  if (!html.includes('id="splash"')) throw new Error("index.html has no #splash markup yet.");
  fs.mkdirSync(OUT, { recursive: true });
  const srv = await start(8796);
  const browser = await chromium.launch();
  try {
    for (const d of DEVICES) {
      const ctx = await browser.newContext({ viewport: { width: d.w, height: d.h }, deviceScaleFactor: d.dpr, isMobile: true, hasTouch: true });
      const page = await ctx.newPage();
      await page.goto(`${srv.url}/?splash`);
      await page.waitForSelector("#splash", { state: "visible" });
      await page.waitForTimeout(700); // fonts and layout settled; the splash is fully opaque until 5 s
      const file = path.join(OUT, fileFor(d));
      await page.screenshot({ path: file });
      await ctx.close();
      // Shrink: the image is flat colour plus anti-aliased text, so a 64-colour palette is visually identical.
      try {
        execFileSync("python3", ["-c", "import sys;from PIL import Image;im=Image.open(sys.argv[1]).convert('RGB');im.quantize(colors=64,method=Image.Quantize.MEDIANCUT,dither=Image.Dither.NONE).save(sys.argv[1],optimize=True)", file]);
      } catch { /* keep the full-colour PNG if Pillow isn't available */ }
      console.log(`${fileFor(d).padEnd(22)} ${(fs.statSync(file).size / 1024).toFixed(0).padStart(4)} KB  ${d.name}`);
    }
  } finally {
    await browser.close();
    await srv.close();
  }

  const links = DEVICES.map((d) =>
    `<link rel="apple-touch-startup-image" media="screen and (device-width: ${d.w}px) and (device-height: ${d.h}px) and (-webkit-device-pixel-ratio: ${d.dpr}) and (orientation: portrait)" href="/splash/${fileFor(d)}">`);
  const block = `<!-- startup-images:start -->\n${links.join("\n")}\n<!-- startup-images:end -->`;
  const re = /<!-- startup-images:start -->[\s\S]*?<!-- startup-images:end -->/;
  if (re.test(html)) {
    fs.writeFileSync(INDEX, html.replace(re, block));
    console.log(`Updated ${links.length} launch-image links in index.html`);
  } else {
    console.log("No <!-- startup-images:start/end --> markers in index.html; add them in <head>, then re-run.");
  }
})().catch((e) => { console.error(e.message || e); process.exit(1); });
