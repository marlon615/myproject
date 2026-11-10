/** Renders the app icons (PNG + ICO) from one SVG design. Usage: node scripts/make-icons.cjs */
const fs = require("fs");
const path = require("path");
const { execFileSync } = require("child_process");
const { chromium } = require("playwright");

const OUT = path.join(__dirname, "..", "public", "icons");
const GREEN = "#17633f", CREAM = "#f3efe4", INK = "#24493a";

// Receipt glyph in a 512 box: rounded top, zig-zag torn bottom, a title line, item lines and a bold total.
function receipt() {
  let teeth = "";
  for (let x = 376, up = true; x > 136; x -= 15, up = !up) teeth += ` L${x - 15} ${up ? 386 : 404}`;
  return `<path d="M158 104 H354 Q376 104 376 126 V404${teeth} V126 Q136 104 158 104 Z" fill="${CREAM}"/>
  <rect x="176" y="150" width="160" height="22" rx="11" fill="${GREEN}"/>
  <rect x="176" y="206" width="112" height="14" rx="7" fill="${INK}" opacity=".55"/><rect x="304" y="206" width="32" height="14" rx="7" fill="${INK}" opacity=".55"/>
  <rect x="176" y="242" width="96" height="14" rx="7" fill="${INK}" opacity=".55"/><rect x="296" y="242" width="40" height="14" rx="7" fill="${INK}" opacity=".55"/>
  <rect x="176" y="278" width="124" height="14" rx="7" fill="${INK}" opacity=".55"/><rect x="316" y="278" width="20" height="14" rx="7" fill="${INK}" opacity=".55"/>
  <rect x="176" y="318" width="160" height="4" rx="2" fill="${INK}" opacity=".35"/>
  <rect x="176" y="338" width="64" height="18" rx="9" fill="${INK}"/><rect x="264" y="336" width="72" height="22" rx="11" fill="${GREEN}"/>`;
}
const svg = ({ rounded, scale }) => `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 512 512">
  <rect width="512" height="512" ${rounded ? 'rx="114"' : ""} fill="${GREEN}"/>
  <g transform="translate(256 ${256 + 6 * scale}) scale(${scale}) translate(-256 -254)">${receipt()}</g>
</svg>`;

(async () => {
  fs.mkdirSync(OUT, { recursive: true });
  const any = svg({ rounded: true, scale: 1 });
  fs.writeFileSync(path.join(OUT, "icon.svg"), any.replace(/\n\s*/g, "\n") + "\n");
  const browser = await chromium.launch();
  const page = await browser.newPage();
  const shoot = async (markup, size, file, transparent) => {
    await page.setViewportSize({ width: size, height: size });
    await page.setContent(`<html><body style="margin:0;background:transparent">${markup.replace("<svg ", `<svg width="${size}" height="${size}" `)}</body></html>`);
    await page.screenshot({ path: path.join(OUT, file), omitBackground: transparent });
    console.log(file);
  };
  await shoot(any, 192, "icon-192.png", true);
  await shoot(any, 512, "icon-512.png", true);
  await shoot(svg({ rounded: false, scale: 0.78 }), 512, "icon-maskable-512.png", false);   // glyph inside the 80% safe zone
  await shoot(svg({ rounded: false, scale: 0.86 }), 180, "apple-touch-icon.png", false);    // iOS rounds the corners itself
  await shoot(any, 32, "favicon-32.png", true);
  await shoot(any, 16, "favicon-16.tmp.png", true);
  await browser.close();
  execFileSync("python3", ["-c", "import sys;from PIL import Image;a=Image.open(sys.argv[1]);b=Image.open(sys.argv[2]);a.save(sys.argv[3],format='ICO',sizes=[(32,32),(16,16)],append_images=[b])",
    path.join(OUT, "favicon-32.png"), path.join(OUT, "favicon-16.tmp.png"), path.join(OUT, "..", "favicon.ico")]);
  fs.unlinkSync(path.join(OUT, "favicon-16.tmp.png"));
  console.log("favicon.ico");
})().catch((e) => { console.error(e); process.exit(1); });
