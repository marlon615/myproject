/**
 * Pointed-pen ink for the signing-effect test page: draws "Thank you" (thankyou-strokes) the way a calligrapher's
 * pen would, hairline upstrokes and swelling downstrokes, revealed along the writing path up to any length.
 *
 *   const ink = new InkScript();
 *   ink.layout(widthPx, heightPx)        → { total, box }   total: path length in px (with short pen lifts)
 *   ink.drawTo(ctx, lengthPx)            → { x, y } | null  adds the newly written ink; pen tip (null while lifted)
 *   ink.redraw(ctx, lengthPx)            after the canvas was cleared (resize)
 */
import { STROKES, BOUNDS } from "./thankyou-strokes.1.js";

const DOWN = (() => { const x = -0.545, y = 0.839, l = Math.hypot(x, y); return [x / l, y / l]; })(); // the script's downstroke
const CORNER = Math.cos((100 * Math.PI) / 180);  // turning more than 100° keeps a sharp point (the top of an n, the bottom of a v)
const STEP = 6;                                   // spline sample spacing, font units
const AIR_PX = 22;                                // pen lift between strokes, in px of travel

const dist = (a, b) => Math.hypot(b[0] - a[0], b[1] - a[1]);
const smoothstep = (a, b, x) => { const t = Math.min(1, Math.max(0, (x - a) / (b - a))); return t * t * (3 - 2 * t); };

function pairs(flat) {
  const out = [];
  for (let i = 0; i + 1 < flat.length; i += 2) {
    const p = [flat[i], flat[i + 1]];
    if (!out.length || dist(out.at(-1), p) > 0.01) out.push(p);
  }
  return out;
}

/** Splits a polyline at sharp corners; each run shares its end point with the next. */
function runsOf(pts) {
  const runs = [];
  let cur = [pts[0]];
  for (let i = 1; i < pts.length; i++) {
    cur.push(pts[i]);
    if (i < pts.length - 1) {
      const ax = pts[i][0] - pts[i - 1][0], ay = pts[i][1] - pts[i - 1][1];
      const bx = pts[i + 1][0] - pts[i][0], by = pts[i + 1][1] - pts[i][1];
      if ((ax * bx + ay * by) / (Math.hypot(ax, ay) * Math.hypot(bx, by)) < CORNER) { runs.push(cur); cur = [pts[i]]; }
    }
  }
  runs.push(cur);
  return runs;
}

/** Centripetal Catmull-Rom through the points of one run (smooth, no overshoot) → dense points. */
function spline(run) {
  if (run.length === 2) {
    const n = Math.max(1, Math.ceil(dist(run[0], run[1]) / STEP));
    return Array.from({ length: n + 1 }, (_, k) => [run[0][0] + ((run[1][0] - run[0][0]) * k) / n, run[0][1] + ((run[1][1] - run[0][1]) * k) / n]);
  }
  const mirror = (a, b) => [2 * a[0] - b[0], 2 * a[1] - b[1]];
  const P = [mirror(run[0], run[1]), ...run, mirror(run.at(-1), run.at(-2))];
  const out = [run[0]];
  for (let i = 1; i < P.length - 2; i++) {
    const p0 = P[i - 1], p1 = P[i], p2 = P[i + 1], p3 = P[i + 2];
    const t1 = Math.max(1e-3, Math.sqrt(dist(p0, p1)));
    const t2 = t1 + Math.max(1e-3, Math.sqrt(dist(p1, p2)));
    const t3 = t2 + Math.max(1e-3, Math.sqrt(dist(p2, p3)));
    const n = Math.max(1, Math.ceil(dist(p1, p2) / STEP));
    for (let k = 1; k <= n; k++) {
      const t = t1 + ((t2 - t1) * k) / n;
      const lerp = (a, b, ta, tb) => [((tb - t) * a[0] + (t - ta) * b[0]) / (tb - ta), ((tb - t) * a[1] + (t - ta) * b[1]) / (tb - ta)];
      const A1 = lerp(p0, p1, 0, t1), A2 = lerp(p1, p2, t1, t2), A3 = lerp(p2, p3, t2, t3);
      const B1 = lerp(A1, A2, 0, t2), B2 = lerp(A2, A3, t1, t3);
      out.push(lerp(B1, B2, t1, t2));
    }
  }
  return out;
}

/** One stroke as runs of samples { x, y, f (0 hairline … 1 full swell), l (length along the stroke, font units) }. */
function buildStroke(flat) {
  const runs = runsOf(pairs(flat)).map(spline);
  let l = 0;
  const out = runs.map((pts) => {
    const n = pts.length;
    const samples = pts.map((p, i) => {
      if (i > 0) l += dist(pts[i - 1], p);
      const a = pts[Math.max(0, i - 1)], b = pts[Math.min(n - 1, i + 1)];
      const len = dist(a, b) || 1;
      const down = ((b[0] - a[0]) * DOWN[0] + (b[1] - a[1]) * DOWN[1]) / len;
      return { x: p[0], y: p[1], f: smoothstep(0.05, 0.85, down), l };
    });
    // Ease the swell in and out along the stroke, as the pressure on a real nib changes: each run starts and
    // ends as a hairline and swells in between (no blunt blobs where a downstroke turns).
    const f = samples.map((s) => s.f);
    const runStart = samples[0].l, runEnd = samples[n - 1].l;
    for (let i = 0; i < n; i++) {
      let sum = 0, k = 0;
      for (let j = Math.max(0, i - 6); j <= Math.min(n - 1, i + 6); j++) { sum += f[j]; k++; }
      const into = samples[i].l - runStart, left = runEnd - samples[i].l;
      samples[i].f = (sum / k) * smoothstep(0, 110, into) * (0.25 + 0.75 * smoothstep(0, 80, left));
    }
    return samples;
  });
  return { runs: out, length: l };
}

export class InkScript {
  constructor() {
    this.strokes = STROKES.map(buildStroke);
    this.view = null;
    this.drawn = 0;
  }

  /**
   * Fits the words into a pad of w × h px (centred, in the upper part) and lays out every sample in px along one
   * writing path: { x, y, r (half the ink width), at (px of travel from the start), first (starts a run) }.
   */
  layout(w, h) {
    const bw = BOUNDS.maxX - BOUNDS.minX, bh = BOUNDS.maxY - BOUNDS.minY;
    const s = Math.min((w * 0.8) / bw, (h * 0.56) / bh);
    const left = (w - bw * s) / 2 - BOUNDS.minX * s;
    const top = h * 0.44 - (bh * s) / 2 - BOUNDS.minY * s;
    const hair = Math.max(0.85, 13 * s), swell = Math.max(2.2, 44 * s);
    const samples = [];
    let at = 0;
    this.strokes.forEach((st, i) => {
      const start = at;
      for (const run of st.runs) {
        run.forEach((p, k) => samples.push({
          x: left + p.x * s, y: top + p.y * s, r: (hair + (swell - hair) * p.f) / 2, at: start + p.l * s, first: k === 0, stroke: i,
        }));
      }
      at = start + st.length * s + (i < this.strokes.length - 1 ? AIR_PX : 0);
    });
    this.view = { s, samples, total: at };
    this.drawn = 0;
    return { total: at, box: { x: left + BOUNDS.minX * s, y: top + BOUNDS.minY * s, w: bw * s, h: bh * s } };
  }

  /** Forgets what was drawn (after the canvas is cleared). */
  reset() { this.drawn = 0; }

  /**
   * Adds the ink written between the last call and `length` px of travel (the canvas keeps what was drawn before).
   * → pen tip { x, y } while the pen is on the paper, else null.
   */
  drawTo(ctx, length) {
    const v = this.view;
    if (!v) return null;
    const S = v.samples;
    const from = this.drawn;
    const to = Math.min(length, v.total);
    let tip = null;
    if (to > from) {
      for (let i = 1; i < S.length; i++) {
        const a = S[i - 1], b = S[i];
        if (b.first) { if (b.at <= to && b.at >= from) this.#dot(ctx, b.x, b.y, b.r); continue; } // a new run starts here
        if (b.at <= from || a.at >= to) continue;
        const t0 = Math.max(0, (from - a.at) / (b.at - a.at || 1));
        const t1 = Math.min(1, (to - a.at) / (b.at - a.at || 1));
        const p = (t) => ({ x: a.x + (b.x - a.x) * t, y: a.y + (b.y - a.y) * t, r: a.r + (b.r - a.r) * t });
        this.#segment(ctx, p(t0), p(t1));
      }
      if (S[0].at >= from && S[0].at <= to) this.#dot(ctx, S[0].x, S[0].y, S[0].r);
      this.drawn = to;
    }
    // Where the pen is now (only while it touches the paper).
    for (let i = 1; i < S.length; i++) {
      const a = S[i - 1], b = S[i];
      if (b.first || b.stroke !== a.stroke) continue;
      if (a.at <= to && b.at >= to) { const t = (to - a.at) / (b.at - a.at || 1); tip = { x: a.x + (b.x - a.x) * t, y: a.y + (b.y - a.y) * t }; break; }
    }
    return to < v.total ? tip : null;
  }

  /** Redraws everything up to `length` (after a resize). */
  redraw(ctx, length) { this.drawn = 0; return this.drawTo(ctx, length); }

  #dot(ctx, x, y, r) { ctx.beginPath(); ctx.arc(x, y, r, 0, Math.PI * 2); ctx.fill(); }

  /** A short piece of stroke from a to b: a quad between their nib edges, rounded at b. */
  #segment(ctx, a, b) {
    const dx = b.x - a.x, dy = b.y - a.y, len = Math.hypot(dx, dy);
    if (len < 1e-6) return;
    const nx = -dy / len, ny = dx / len;
    ctx.beginPath();
    ctx.moveTo(a.x + nx * a.r, a.y + ny * a.r);
    ctx.lineTo(b.x + nx * b.r, b.y + ny * b.r);
    ctx.lineTo(b.x - nx * b.r, b.y - ny * b.r);
    ctx.lineTo(a.x - nx * a.r, a.y - ny * a.r);
    ctx.closePath();
    ctx.fill();
    this.#dot(ctx, b.x, b.y, b.r);
  }
}
