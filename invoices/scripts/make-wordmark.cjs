/**
 * Builds the "Marlon" splash wordmark from Bodoni Moda 500 outlines (SIL Open Font License 1.1): the M's
 * top-left serif flows into one fine pen stroke that sweeps down-left and ends in a ball terminal (echoing the
 * ball terminals of "a" and "r"); "arlon" is the typeface's own outlines and spacing, untouched.
 * Writes the SVG inline into public/index.html and tests/harness/splash-harness.html between
 * <!-- wordmark:start --> and <!-- wordmark:end -->.  Usage: node scripts/make-wordmark.cjs
 */
const opentype = require("opentype.js");
const fs = require("fs");
const path = require("path");

const FONT = require.resolve("@fontsource/bodoni-moda/files/bodoni-moda-latin-500-normal.woff");
const buf = fs.readFileSync(FONT);
const font = opentype.parse(buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength));
const S = 1000, BASE = 800;
const P = (x, y) => ({ x, y });
const f1 = (n) => Math.round(n * 10) / 10;

// ── The M itself stays intact; its top-left serif (y 50–69.5, left tip at x 28.5) flows into the scroll ──
const mGlyph = font.charToGlyph("M");
const m = mGlyph.getPath(0, BASE, S).commands.filter((c) => c.type !== "Z").map((c) => P(c.x, c.y));

// ── The curl: a tapered stroke along a cubic centreline, then a ball terminal ──
const cfg = {
  p0: P(44, 59.75), c1: P(-46, 59.75), c2: P(-118, 168), p3: P(-92, 326), // centreline: out of the serif, sweeping down-left
  widths: [[0, 19.5], [0.12, 12], [0.3, 8.5], [0.56, 15.5], [0.82, 9.5], [1, 10.5]], // serif thickness → hairline → a gentle pen swell → thin neck
  ball: 30,
};
const bez = (t, a, b, c, d) => {
  const u = 1 - t;
  return P(u * u * u * a.x + 3 * u * u * t * b.x + 3 * u * t * t * c.x + t * t * t * d.x, u * u * u * a.y + 3 * u * u * t * b.y + 3 * u * t * t * c.y + t * t * t * d.y);
};
const tangent = (t, a, b, c, d) => {
  const u = 1 - t;
  return P(3 * u * u * (b.x - a.x) + 6 * u * t * (c.x - b.x) + 3 * t * t * (d.x - c.x), 3 * u * u * (b.y - a.y) + 6 * u * t * (c.y - b.y) + 3 * t * t * (d.y - c.y));
};
const width = (t) => {
  const w = cfg.widths;
  for (let i = 1; i < w.length; i++) if (t <= w[i][0]) {
    const [t0, a] = w[i - 1], [t1, b] = w[i];
    const k = (t - t0) / (t1 - t0), s = k * k * (3 - 2 * k); // smoothstep between keyframes
    return a + (b - a) * s;
  }
  return w[w.length - 1][1];
};
const N = 72, left = [], right = [];
for (let i = 0; i <= N; i++) {
  const t = i / N, pt = bez(t, cfg.p0, cfg.c1, cfg.c2, cfg.p3), d = tangent(t, cfg.p0, cfg.c1, cfg.c2, cfg.p3);
  const len = Math.hypot(d.x, d.y) || 1, nx = -d.y / len, ny = d.x / len, hw = width(t) / 2;
  left.push(P(pt.x + nx * hw, pt.y + ny * hw));
  right.push(P(pt.x - nx * hw, pt.y - ny * hw));
}
const end = bez(1, cfg.p0, cfg.c1, cfg.c2, cfg.p3), endDir = tangent(1, cfg.p0, cfg.c1, cfg.c2, cfg.p3);
const el = Math.hypot(endDir.x, endDir.y);
const ballC = P(end.x + endDir.x / el * (cfg.ball * 0.55), end.y + endDir.y / el * (cfg.ball * 0.55));

const poly = (pts) => "M" + pts.map((p) => `${f1(p.x)} ${f1(p.y)}`).join("L") + "Z";
const curlD = poly([...left, ...right.reverse()]);
const r = cfg.ball;
const ballD = `M${f1(ballC.x - r)} ${f1(ballC.y)}a${r} ${r} 0 1 0 ${2 * r} 0a${r} ${r} 0 1 0 ${-2 * r} 0Z`;
const mD = poly(m);

// ── "arlon", spaced with the font's own advance widths and kerning ──
const x0 = mGlyph.advanceWidth / font.unitsPerEm * S + font.getKerningValue(mGlyph, font.charToGlyph("a")) / font.unitsPerEm * S;
const rest = font.getPath("arlon", x0, BASE, S, { kerning: true });
const restD = rest.toPathData(1);

// ── Tight viewBox ──
const xs = [...m, ...left, ...right].map((p) => p.x).concat([ballC.x - r, ballC.x + r]);
const ys = [...m, ...left, ...right].map((p) => p.y).concat([ballC.y - r, ballC.y + r]);
const rb = rest.getBoundingBox();
const minX = Math.min(...xs, rb.x1), maxX = Math.max(...xs, rb.x2), minY = Math.min(...ys, rb.y1), maxY = Math.max(...ys, rb.y2);
const pad = 12, vb = [f1(minX - pad), f1(minY - pad), f1(maxX - minX + 2 * pad), f1(maxY - minY + 2 * pad)];

const svg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="${vb.join(" ")}" role="img" aria-label="Marlon"><title>Marlon</title><!-- Wordmark drawn from Bodoni Moda (SIL Open Font License 1.1); custom M with a hairline curl and ball terminal. --><path fill="currentColor" d="${mD}"/><path fill="currentColor" d="${curlD}"/><path fill="currentColor" d="${ballD}"/><path fill="currentColor" d="${restD}"/></svg>`;
const ROOT = path.join(__dirname, "..");
for (const rel of ["public/index.html", "tests/harness/splash-harness.html"]) {
  const file = path.join(ROOT, rel);
  const html = fs.readFileSync(file, "utf8");
  const block = `<!-- wordmark:start -->${svg}<!-- wordmark:end -->`;
  const re = /<!-- wordmark:start -->[\s\S]*?<!-- wordmark:end -->/;
  if (!re.test(html)) throw new Error(`${rel}: add <!-- wordmark:start --><!-- wordmark:end --> inside .splash-name first`);
  fs.writeFileSync(file, html.replace(re, () => block));
  console.log(`${rel}: wordmark ${svg.length} bytes, viewBox ${vb.join(" ")}`);
}
