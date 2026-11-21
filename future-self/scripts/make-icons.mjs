// Renders public/icons/*.png from public/icons/icon.svg. Run: node scripts/make-icons.mjs
import { createRequire } from "node:module";
const { chromium } = createRequire(import.meta.url)("playwright");
import { readFileSync } from "node:fs";

const svg = readFileSync(new URL("../public/icons/icon.svg", import.meta.url), "utf8");
const out = (n) => new URL(`../public/icons/${n}`, import.meta.url).pathname;
const browser = await chromium.launch();
const page = await browser.newPage();
async function render(name, size, pad = 0) {
  await page.setViewportSize({ width: size, height: size });
  const inner = size - pad * 2;
  await page.setContent(`<html><body style="margin:0;background:#07060b;width:${size}px;height:${size}px;display:grid;place-items:center">
    <div style="width:${inner}px;height:${inner}px">${svg.replace("<svg", `<svg width="${inner}" height="${inner}"`)}</div></body></html>`);
  await page.screenshot({ path: out(name), omitBackground: false });
}
await render("icon-512.png", 512);
await render("icon-192.png", 192);
await render("apple-touch-icon.png", 180);
await render("maskable-512.png", 512, 64);
await browser.close();
console.log("icons written");
