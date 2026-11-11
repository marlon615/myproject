/**
 * Finger signature pad for a <canvas>.
 *
 * - Pointer events, so a finger, a stylus and a mouse all work. One stroke at a time (a resting palm is ignored).
 * - Strokes are kept as points and drawn as smooth curves, so the pad redraws crisply after a resize or a
 *   rotation, and on high-density screens.
 * - toDataURL() exports black ink on a transparent 900×300 PNG, cropped to the ink and centred.
 * - onChange fires after every finished stroke. clear() and fromDataURL() are for the app and never fire it.
 * - baseArea(w, h) (optional): where a saved signature is drawn back into the pad, as { x, y, w, h } in pad pixels
 *   (default: the whole pad). It only places the picture on screen; the export is unchanged.
 *
 *   const pad = new SignaturePad(canvas, { onChange: () => save(pad.toDataURL()) });
 */
import { loadImage } from "./util.js";

const OUT_W = 900, OUT_H = 300; // export size (3:1)
const OUT_MARGIN = 14;          // clear border around the ink in the export
const OUT_MAX_SCALE = 4;        // a tiny mark is not blown up into a blot
const INK = "#000";
const LINE = 2.6;               // stroke width in CSS pixels, at the pad size used when signing started
const MIN_STEP = 0.75;          // finger jitter smaller than this (CSS pixels) is ignored

export class SignaturePad {
  #canvas;
  #ctx;
  #onChange;
  #baseArea;
  #strokes = [];               // arrays of { x, y } in pad space
  #base = null;                // { img, url } drawn underneath, from fromDataURL()
  #space = null;               // { w, h }: the pad's size when this signature was started
  #view = { w: 0, h: 0, dpr: 1 };
  #pointerId = null;           // the pointer drawing the current stroke
  #disabled = false;
  #edited = false;             // strokes were added after fromDataURL()
  #loads = 0;                  // bumped by clear()/fromDataURL() so a slow image load can't overwrite newer state

  constructor(canvas, { onChange, baseArea } = {}) {
    this.#canvas = canvas;
    this.#ctx = canvas.getContext("2d");
    this.#onChange = onChange;
    this.#baseArea = baseArea;
    canvas.style.touchAction = "none";
    canvas.addEventListener("pointerdown", (e) => this.#start(e));
    canvas.addEventListener("pointermove", (e) => this.#move(e));
    for (const type of ["pointerup", "pointercancel", "lostpointercapture"]) canvas.addEventListener(type, (e) => this.#end(e));
    // iOS: never scroll, zoom or open the magnifier while a finger is signing.
    const hold = (e) => { if (!this.#disabled) e.preventDefault(); };
    canvas.addEventListener("touchstart", hold, { passive: false });
    canvas.addEventListener("touchmove", hold, { passive: false });
    new ResizeObserver(() => this.#resize()).observe(canvas);
    this.#resize();
  }

  /** Removes all ink. */
  clear() {
    this.#loads++;
    this.#reset();
    this.#render();
  }

  isEmpty() {
    return this.#strokes.length === 0 && !this.#base;
  }

  /** PNG data URL (black on transparent, 900×300), or null when the pad is empty. */
  toDataURL() {
    if (this.isEmpty()) return null;
    if (this.#base && !this.#edited) return this.#base.url;
    const box = this.#inkBox();
    const s = Math.min((OUT_W - 2 * OUT_MARGIN) / box.w, (OUT_H - 2 * OUT_MARGIN) / box.h, OUT_MAX_SCALE);
    const out = document.createElement("canvas");
    out.width = OUT_W;
    out.height = OUT_H;
    const ctx = out.getContext("2d");
    ctx.setTransform(s, 0, 0, s, (OUT_W - box.w * s) / 2 - box.x * s, (OUT_H - box.h * s) / 2 - box.y * s);
    paint(ctx, this.#area(), this.#base, this.#strokes);
    return out.toDataURL("image/png");
  }

  /** Shows a saved signature. Resolves true once it is drawn, false if there was nothing to draw. */
  async fromDataURL(url) {
    const load = ++this.#loads;
    this.#reset();
    this.#render();
    if (!url) return false;
    let img;
    try { img = await loadImage(url); } catch { return false; }
    if (load !== this.#loads) return false; // cleared or replaced while the image was loading
    this.#base = { img, url };
    this.#space ||= this.#view.w ? { w: this.#view.w, h: this.#view.h } : { w: OUT_W, h: OUT_H };
    this.#render();
    return true;
  }

  /** A disabled pad ignores new strokes and lets the page scroll over it. */
  setDisabled(disabled) {
    this.#disabled = Boolean(disabled);
    this.#canvas.style.touchAction = this.#disabled ? "auto" : "none";
  }

  #reset() {
    this.#strokes = [];
    this.#base = null;
    this.#space = null;
    this.#edited = false;
    this.#pointerId = null;
  }

  #start(e) {
    if (this.#disabled || this.#pointerId !== null || !this.#view.w) return;
    if (e.pointerType === "mouse" && e.button !== 0) return;
    e.preventDefault();
    this.#pointerId = e.pointerId;
    try { this.#canvas.setPointerCapture(e.pointerId); } catch { /* the stroke still works without capture */ }
    if (this.isEmpty()) this.#space = { w: this.#view.w, h: this.#view.h };
    const p = this.#toSpace(e);
    this.#strokes.push([p]);
    this.#edited = true;
    const ctx = this.#pen();
    ctx.beginPath();
    ctx.arc(p.x, p.y, LINE / 2, 0, Math.PI * 2);
    ctx.fill();
  }

  #move(e) {
    if (e.pointerId !== this.#pointerId) return;
    e.preventDefault();
    const pts = this.#strokes[this.#strokes.length - 1];
    const coalesced = e.getCoalescedEvents?.() ?? [];
    for (const ev of coalesced.length ? coalesced : [e]) {
      const p = this.#toSpace(ev), last = pts[pts.length - 1];
      if (Math.hypot(p.x - last.x, p.y - last.y) < MIN_STEP) continue;
      pts.push(p);
      this.#drawTail(pts);
    }
  }

  #end(e) {
    if (e.pointerId !== this.#pointerId) return;
    this.#pointerId = null;
    const pts = this.#strokes[this.#strokes.length - 1];
    if (pts.length > 1) {
      const ctx = this.#pen(), a = mid(pts[pts.length - 2], pts[pts.length - 1]), b = pts[pts.length - 1];
      ctx.beginPath();
      ctx.moveTo(a.x, a.y);
      ctx.lineTo(b.x, b.y);
      ctx.stroke();
    }
    this.#onChange?.();
  }

  /** Draws only the newest piece of the stroke being signed (midpoint-smoothed). */
  #drawTail(pts) {
    const ctx = this.#pen(), n = pts.length;
    ctx.beginPath();
    if (n === 2) {
      const m = mid(pts[0], pts[1]);
      ctx.moveTo(pts[0].x, pts[0].y);
      ctx.lineTo(m.x, m.y);
    } else {
      const a = mid(pts[n - 3], pts[n - 2]), b = mid(pts[n - 2], pts[n - 1]);
      ctx.moveTo(a.x, a.y);
      ctx.quadraticCurveTo(pts[n - 2].x, pts[n - 2].y, b.x, b.y);
    }
    ctx.stroke();
  }

  /** Pad space → canvas CSS pixels: a uniform scale, centred, so a resized pad never stretches the ink. */
  #transform() {
    const { w, h } = this.#view, sp = this.#space;
    if (!sp) return { s: 1, x: 0, y: 0 };
    const s = Math.min(w / sp.w, h / sp.h);
    return { s, x: (w - sp.w * s) / 2, y: (h - sp.h * s) / 2 };
  }

  #toSpace(e) {
    const r = this.#canvas.getBoundingClientRect(), t = this.#transform();
    return { x: (e.clientX - r.left - t.x) / t.s, y: (e.clientY - r.top - t.y) / t.s };
  }

  /** The 2D context set up for drawing in pad space. */
  #pen() {
    const ctx = this.#ctx, t = this.#transform(), d = this.#view.dpr;
    ctx.setTransform(d * t.s, 0, 0, d * t.s, d * t.x, d * t.y);
    setPen(ctx);
    return ctx;
  }

  #render() {
    const ctx = this.#ctx;
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.clearRect(0, 0, this.#canvas.width, this.#canvas.height);
    if (!this.#space || !this.#view.w) return;
    this.#pen();
    paint(ctx, this.#area(), this.#base, this.#strokes);
  }

  /** Where the saved signature picture goes, in pad space. */
  #area() {
    const sp = this.#space;
    const a = sp && this.#baseArea?.(sp.w, sp.h);
    return a && a.w > 0 && a.h > 0 ? a : { x: 0, y: 0, w: sp?.w || OUT_W, h: sp?.h || OUT_H };
  }

  #resize() {
    const w = this.#canvas.clientWidth, h = this.#canvas.clientHeight, dpr = window.devicePixelRatio || 1;
    if (!w || !h) return; // hidden for now: keep everything until it shows again
    if (w === this.#view.w && h === this.#view.h && dpr === this.#view.dpr) return;
    this.#view = { w, h, dpr };
    this.#canvas.width = Math.round(w * dpr);
    this.#canvas.height = Math.round(h * dpr);
    this.#render();
  }

  /** Bounding box of all ink in pad space, including the stroke width. */
  #inkBox() {
    let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
    const add = (x, y) => { x0 = Math.min(x0, x); y0 = Math.min(y0, y); x1 = Math.max(x1, x); y1 = Math.max(y1, y); };
    if (this.#base) {
      const r = fit(this.#base.img, this.#area());
      add(r.x, r.y);
      add(r.x + r.w, r.y + r.h);
    }
    for (const pts of this.#strokes) for (const p of pts) add(p.x, p.y);
    return { x: x0 - LINE / 2, y: y0 - LINE / 2, w: x1 - x0 + LINE, h: y1 - y0 + LINE };
  }
}

const mid = (a, b) => ({ x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 });

function setPen(ctx) {
  ctx.lineWidth = LINE;
  ctx.lineCap = "round";
  ctx.lineJoin = "round";
  ctx.strokeStyle = INK;
  ctx.fillStyle = INK;
}

/** Where an image sits when fitted (contained and centred) inside an area { x, y, w, h }. */
function fit(img, { x = 0, y = 0, w, h }) {
  const s = Math.min(w / img.naturalWidth, h / img.naturalHeight);
  return { x: x + (w - img.naturalWidth * s) / 2, y: y + (h - img.naturalHeight * s) / 2, w: img.naturalWidth * s, h: img.naturalHeight * s };
}

/** Draws the saved image (fitted into `area`) and every stroke; the context's transform must already map pad space. */
function paint(ctx, area, base, strokes) {
  if (base) {
    const r = fit(base.img, area);
    ctx.drawImage(base.img, r.x, r.y, r.w, r.h);
  }
  setPen(ctx);
  for (const pts of strokes) {
    ctx.beginPath();
    if (pts.length === 1) {
      ctx.arc(pts[0].x, pts[0].y, LINE / 2, 0, Math.PI * 2);
      ctx.fill();
      continue;
    }
    ctx.moveTo(pts[0].x, pts[0].y);
    const first = mid(pts[0], pts[1]);
    ctx.lineTo(first.x, first.y);
    for (let i = 1; i < pts.length - 1; i++) {
      const m = mid(pts[i], pts[i + 1]);
      ctx.quadraticCurveTo(pts[i].x, pts[i].y, m.x, m.y);
    }
    const last = pts[pts.length - 1];
    ctx.lineTo(last.x, last.y);
    ctx.stroke();
  }
}
