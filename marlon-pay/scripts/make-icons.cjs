/** Makes the PNG icons from public/icons/icon.svg (home screen, Android). node scripts/make-icons.cjs */
const { chromium } = require("playwright");
const path = require("path"), fs = require("fs");
const DIR = path.join(__dirname, "..", "public", "icons");
(async () => {
  const svg = fs.readFileSync(path.join(DIR, "icon.svg"), "utf8");
  const b = await chromium.launch();
  for (const [name, size, pad] of [["icon-192.png", 192, 0], ["icon-512.png", 512, 0], ["apple-touch-icon.png", 180, 0]]) {
    const p = await b.newPage({ viewport: { width: size, height: size } });
    await p.setContent(`<html><body style="margin:0;background:${name.startsWith("apple") ? "#17633f" : "transparent"}">${svg.replace("<svg ", `<svg width="${size}" height="${size}" `)}</body></html>`);
    await p.screenshot({ path: path.join(DIR, name), omitBackground: !name.startsWith("apple") });
    await p.close();
  }
  await b.close();
  console.log("icons made");
})();
