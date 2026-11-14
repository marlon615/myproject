/**
 * Builds the "Marlon" wordmark from Bodoni Moda 500 outlines (SIL Open Font License 1.1): a refined Didone M
 * with sharp thin–thick strokes (hairline left stem and serifs, heavy first diagonal, pointed vertex), set with
 * the typeface's own spacing and kerning so it matches "arlon" exactly.
 *
 * Writes the inline SVG into every <!-- wordmark:start --> … <!-- wordmark:end --> block (the brand bar), and a
 * whole-word version with a shimmer overlay into <!-- splashmark:start --> … <!-- splashmark:end --> (the opening animation),
 * in public/index.html and tests/harness/splash-harness.html. (Receipts, PDFs and the customer page show each
 * business's own name instead of the wordmark, so there's no wordmark module in this copy.)
 * Usage: node scripts/make-wordmark.cjs
 */
const opentype = require("opentype.js");
const fs = require("fs");
const path = require("path");

const FONT = require.resolve("@fontsource/bodoni-moda/files/bodoni-moda-latin-500-normal.woff");
const buf = fs.readFileSync(FONT);
const font = opentype.parse(buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength));
const S = 1000, BASE = 800;
const f1 = (n) => Math.round(n * 10) / 10;

const word = font.getPath("Marlon", 0, BASE, S, { kerning: true });
const d = word.toPathData(1);
const bb = word.getBoundingBox();
const pad = 8;
const vb = [f1(bb.x1 - pad), f1(bb.y1 - pad), f1(bb.x2 - bb.x1 + 2 * pad), f1(bb.y2 - bb.y1 + 2 * pad)];

const svg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="${vb.join(" ")}" role="img" aria-label="Marlon"><title>Marlon</title><!-- Wordmark from Bodoni Moda outlines (SIL Open Font License 1.1). --><path fill="currentColor" d="${d}"/></svg>`;

// The splash version: the whole word at once, plus a copy of it filled with a moving band of light (the shimmer).
const bandW = Math.round(vb[2] * 0.32);
const splashSvg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="${vb.join(" ")}" role="img" aria-label="Marlon"><title>Marlon</title><!-- Wordmark from Bodoni Moda outlines (SIL Open Font License 1.1). --><defs><clipPath id="splash-clip"><path d="${d}"/></clipPath><linearGradient id="splash-shine" x1="0" y1="0" x2="1" y2="0"><stop offset="0" stop-color="#ffd56b" stop-opacity="0"/><stop offset=".35" stop-color="#ffd56b" stop-opacity=".85"/><stop offset=".5" stop-color="#ffffff" stop-opacity="1"/><stop offset=".65" stop-color="#ffd56b" stop-opacity=".85"/><stop offset="1" stop-color="#ffd56b" stop-opacity="0"/></linearGradient></defs><path class="splash-word" fill="currentColor" d="${d}"/><g clip-path="url(#splash-clip)"><rect class="splash-shine" x="${vb[0] - bandW * 1.5}" y="${vb[1] - vb[3]}" width="${bandW}" height="${vb[3] * 3}" fill="url(#splash-shine)"/></g></svg>`;

const ROOT = path.join(__dirname, "..");
for (const rel of ["public/index.html", "tests/harness/splash-harness.html"]) {
  const file = path.join(ROOT, rel);
  const html = fs.readFileSync(file, "utf8");
  const re = /<!-- wordmark:start -->[\s\S]*?<!-- wordmark:end -->/g;
  const reSplash = /<!-- splashmark:start -->[\s\S]*?<!-- splashmark:end -->/g;
  const blocks = html.match(re)?.length || 0, splashBlocks = html.match(reSplash)?.length || 0;
  if (!blocks && !splashBlocks) throw new Error(`${rel}: add <!-- wordmark:start --><!-- wordmark:end --> (or splashmark) where the wordmark goes first`);
  fs.writeFileSync(file, html.replace(re, () => `<!-- wordmark:start -->${svg}<!-- wordmark:end -->`)
    .replace(reSplash, () => `<!-- splashmark:start -->${splashSvg}<!-- splashmark:end -->`));
  console.log(`${rel}: ${blocks} wordmark${blocks === 1 ? "" : "s"}, ${splashBlocks} splash wordmark (whole word + shimmer)`);
}
