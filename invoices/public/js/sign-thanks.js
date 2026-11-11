/**
 * The signing thank-you, as approved on the test page (/lab/sign).
 *
 * While the customer signs, "Thank you" writes itself in a flowing script across the top of the signature box, in
 * step with their finger; their real signature stays visible where they sign, at the bottom (and is saved exactly
 * as drawn, by SignaturePad). When the finger lifts, the words finish and settle, the customer's name appears under
 * them, then the green tick draws itself and the phone gives a gentle tap.
 *
 *   const thanks = new SignThanks({ pad, canvas, signature, name: () => "Sarah Supermarket", onChange });
 *   thanks.reset()        the signature was cleared (or a new invoice started)
 *   thanks.showSigned()   an invoice that is already signed: the settled thank-you at once (no animation, no tap)
 *   thanks.busy           true while the words are being written or settling
 *   signatureArea(w, h)   where a saved signature is drawn back into the box (the part below the words)
 */
import { h } from "./util.js";
import { InkScript } from "./ink-script.js";
import { buzz } from "./thanks.js";

const INK = "#16241c";
const GAIN = 1.15;       // at first the words are written a little faster than the finger moves, then gently slower
const FOLLOW_MS = 70;    // how softly the pen follows the finger
const MAX_SPEED = 2600;  // px/s, so a flick never jumps
const GRACE_MS = 650;    // a lift shorter than this is still the same signature (between first and last name)
const DRIFT = 260;       // px/s the pen keeps writing during that pause, so it never stops dead
const MIN_TRAVEL = 40;   // px of finger movement before it counts as signing (a tap isn't)
const NS = "http://www.w3.org/2000/svg";
const reduced = () => matchMedia("(prefers-reduced-motion: reduce)").matches;

/** The box's zones: the words across the top, the name under them, the signature below. */
function zones(w, hgt) {
  const wordsH = Math.min(hgt * 0.3, 78);
  const cy = 10 + wordsH / 2;
  return { words: { cy, maxW: w * 0.8, maxH: wordsH }, signTop: Math.round(cy + wordsH / 2 + 30) };
}

/** Where a saved signature is drawn back into a w × h box: below the thank-you, where it was signed. */
export function signatureArea(w, hgt) {
  const top = zones(w, hgt).signTop;
  return { x: 10, y: top, w: Math.max(1, w - 20), h: Math.max(1, hgt - top - 6) };
}

function checkmark() {
  const svg = document.createElementNS(NS, "svg");
  svg.setAttribute("viewBox", "0 0 96 96");
  svg.setAttribute("class", "sign-thanks-check");
  const add = (tag, attrs) => { const n = document.createElementNS(NS, tag); for (const [k, v] of Object.entries(attrs)) n.setAttribute(k, v); svg.append(n); };
  add("circle", { class: "disc", cx: "48", cy: "48", r: "44" });
  add("circle", { class: "ring", cx: "48", cy: "48", r: "44", transform: "rotate(-90 48 48)" });
  add("path", { class: "tick", d: "M30 49.5 42.5 62 67 35.5" });
  return svg;
}

export class SignThanks {
  #pad; #canvas; #signature; #name; #onChange;
  #ink = new InkScript();
  #inkCanvas; #fxCanvas; #inkCtx; #fxCtx; #sealed; #who;
  #st = {
    phase: "idle",       // idle → writing → finishing → settling → done
    total: 0, box: null, size: { w: 0, h: 0, dpr: 1 },
    target: 0, shown: 0, speed: 0, travel: 0,
    pointer: null, last: null, finish: null, timers: [], raf: 0, prev: 0,
  };

  constructor({ pad, canvas, signature, name = () => "", onChange = () => {} }) {
    this.#pad = pad;
    this.#canvas = canvas;
    this.#signature = signature;
    this.#name = name;
    this.#onChange = onChange;
    this.#inkCanvas = h("canvas", { class: "sign-thanks-ink", "aria-hidden": "true" });
    this.#fxCanvas = h("canvas", { class: "sign-thanks-fx", "aria-hidden": "true" });
    this.#who = h("span", { class: "sign-thanks-who" });
    this.#sealed = h("div", { class: "sign-thanks-sealed", "aria-hidden": "true" }, checkmark(), this.#who);
    canvas.before(this.#inkCanvas, this.#fxCanvas); // under the signature, so the customer's ink is always on top
    canvas.after(this.#sealed);
    this.#inkCtx = this.#inkCanvas.getContext("2d");
    this.#fxCtx = this.#fxCanvas.getContext("2d");
    canvas.addEventListener("pointerdown", (e) => this.#down(e));
    canvas.addEventListener("pointermove", (e) => this.#move(e));
    for (const type of ["pointerup", "pointercancel"]) canvas.addEventListener(type, (e) => this.#up(e));
    new ResizeObserver(() => this.#resize()).observe(pad);
    this.#resize();
  }

  get busy() { return ["writing", "finishing", "settling"].includes(this.#st.phase); }
  get phase() { return this.#st.phase; }

  /** Back to an empty box (the signature was cleared, or a new invoice). */
  reset() {
    this.#clearTimers();
    const st = this.#st;
    st.phase = "idle";
    st.target = st.shown = st.speed = st.travel = 0;
    st.pointer = null;
    st.finish = null;
    this.#ink.reset();
    this.#inkCtx.clearRect(0, 0, st.size.w, st.size.h);
    this.#fxCtx.clearRect(0, 0, st.size.w, st.size.h);
    this.#pad.classList.remove("is-writing", "is-thanked", "is-static");
    this.#sealed.classList.remove("is-shown", "is-checked");
  }

  /** An invoice that's already signed: "Thank you", the name and the tick, settled, with no animation and no tap. */
  showSigned() {
    this.reset();
    const st = this.#st;
    st.shown = st.target = st.total;
    st.phase = "done";
    this.#pad.classList.add("is-static", "is-thanked");
    this.#setName();
    this.#sealed.classList.add("is-shown", "is-checked");
    this.#ink.redraw(this.#inkCtx, st.shown);
  }

  // ── Layout ─────────────────────────────────────────────────────────────

  #resize() {
    const w = this.#pad.clientWidth, hgt = this.#pad.clientHeight;
    if (!w || !hgt) return;
    const dpr = Math.min(3, window.devicePixelRatio || 1);
    const st = this.#st;
    if (w === st.size.w && hgt === st.size.h && dpr === st.size.dpr) return;
    const oldTotal = st.total;
    st.size = { w, h: hgt, dpr };
    for (const c of [this.#inkCanvas, this.#fxCanvas]) { c.width = Math.round(w * dpr); c.height = Math.round(hgt * dpr); }
    const { total, box } = this.#ink.layout(w, hgt, zones(w, hgt).words);
    if (oldTotal) { st.shown *= total / oldTotal; st.target *= total / oldTotal; } else if (st.phase === "done") st.shown = st.target = total;
    st.total = total;
    st.box = box;
    for (const ctx of [this.#inkCtx, this.#fxCtx]) ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    this.#inkCtx.fillStyle = INK;
    this.#inkCtx.clearRect(0, 0, w, hgt);
    this.#ink.redraw(this.#inkCtx, st.shown);
    // The words settle (shrink a touch and rise) around their own centre; the name sits just under them.
    const cx = box.x + box.w / 2, cy = box.y + box.h / 2;
    this.#inkCanvas.style.transformOrigin = `${cx}px ${cy}px`;
    this.#sealed.style.top = `${Math.round(cy + box.h * 0.47 - 4 + 3)}px`;
  }

  // ── Finger ─────────────────────────────────────────────────────────────

  #local(e) {
    const r = this.#pad.getBoundingClientRect();
    return { x: e.clientX - r.left - this.#pad.clientLeft, y: e.clientY - r.top - this.#pad.clientTop };
  }

  #down(e) {
    const st = this.#st;
    if (st.pointer !== null || (e.pointerType === "mouse" && e.button !== 0)) return;
    if (st.phase !== "idle" && st.phase !== "writing") return; // after the words finish, extra strokes are just recorded
    st.pointer = e.pointerId;
    st.last = this.#local(e);
    this.#clearTimers();
    if (st.phase === "idle") this.#pad.classList.add("is-writing");
    st.phase = "writing";
    this.#run();
    this.#onChange();
  }

  #move(e) {
    const st = this.#st;
    if (e.pointerId !== st.pointer) return;
    const list = typeof e.getCoalescedEvents === "function" ? e.getCoalescedEvents() : [];
    for (const ev of list.length ? list : [e]) {
      const p = this.#local(ev);
      const d = Math.hypot(p.x - st.last.x, p.y - st.last.y);
      st.last = p;
      st.travel += d;
      // The pen travels along "Thank you" as the finger travels: quickly at first, easing as the words fill up.
      st.target += (d * GAIN * (st.total - st.target)) / st.total;
    }
  }

  #up(e) {
    const st = this.#st;
    if (e.pointerId !== st.pointer) return;
    st.pointer = null;
    if (st.phase !== "writing") return;
    this.#later(GRACE_MS, () => {
      if (st.pointer !== null || st.phase !== "writing") return;
      if (this.#signature.isEmpty() || st.travel < MIN_TRAVEL) { this.reset(); this.#onChange(); return; } // a tap isn't signing
      this.#startFinish();
    });
  }

  // ── Writing, finishing, settling ───────────────────────────────────────

  #startFinish() {
    const st = this.#st;
    const remaining = Math.max(1, st.total - st.shown);
    const dur = Math.min(1100, Math.max(380, (remaining / 700) * 1000));
    // Start at the pen's current speed and glide to a stop at the end of "you".
    const m0 = Math.min(2.2, Math.max(0.4, (st.speed * dur) / 1000 / remaining));
    st.finish = { from: st.shown, at: performance.now(), dur, m0 };
    st.phase = "finishing";
    this.#run();
  }

  #settle() {
    const st = this.#st;
    st.phase = "settling";
    this.#pad.classList.add("is-thanked");
    this.#setName();
    const quick = reduced();
    this.#later(quick ? 0 : 220, () => this.#sealed.classList.add("is-shown"));
    this.#later(quick ? 0 : 580, () => this.#sealed.classList.add("is-checked"));
    this.#later(quick ? 0 : 580 + 760, () => { // the tap lands as the tick completes
      buzz();
      st.phase = "done";
      this.#onChange();
    });
  }

  #setName() {
    const name = String(this.#name() || "").trim();
    this.#who.textContent = name;
    this.#who.hidden = !name;
  }

  // ── Animation ──────────────────────────────────────────────────────────

  #run() {
    const st = this.#st;
    if (!st.raf) { st.prev = 0; st.raf = requestAnimationFrame((t) => this.#frame(t)); }
  }

  #frame(t) {
    const st = this.#st;
    const dt = st.prev ? Math.min(64, t - st.prev) : 16;
    st.prev = t;
    const before = st.shown;
    if (st.phase === "writing") {
      if (st.pointer === null) st.target = Math.min(st.total * 0.985, st.target + (DRIFT * dt) / 1000);
      const step = (st.target - st.shown) * (1 - Math.exp(-dt / FOLLOW_MS));
      st.shown += Math.min(Math.max(0, step), (MAX_SPEED * dt) / 1000);
    } else if (st.phase === "finishing") {
      const f = st.finish, k = Math.min(1, (t - f.at) / f.dur);
      const hm = f.m0 * (k * k * k - 2 * k * k + k) + (3 * k * k - 2 * k * k * k); // Hermite: current speed → stop
      st.shown = f.from + (st.total - f.from) * hm;
      if (k >= 1) { st.shown = st.total; this.#settle(); }
    }
    st.speed = st.speed * 0.8 + (((st.shown - before) * 1000) / dt) * 0.2;
    const tip = this.#ink.drawTo(this.#inkCtx, st.shown);
    this.#glow(tip);
    const busy = st.phase === "writing" || st.phase === "finishing";
    st.raf = busy ? requestAnimationFrame((n) => this.#frame(n)) : 0;
    if (!busy) this.#fxCtx.clearRect(0, 0, st.size.w, st.size.h);
  }

  /** A soft glow at the pen's tip while it writes. */
  #glow(tip) {
    const { w, h: hgt } = this.#st.size;
    const ctx = this.#fxCtx;
    ctx.clearRect(0, 0, w, hgt);
    if (!tip) return;
    const g = ctx.createRadialGradient(tip.x, tip.y, 0, tip.x, tip.y, 11);
    g.addColorStop(0, "rgba(23, 99, 63, 0.30)");
    g.addColorStop(1, "rgba(23, 99, 63, 0)");
    ctx.fillStyle = g;
    ctx.beginPath();
    ctx.arc(tip.x, tip.y, 11, 0, Math.PI * 2);
    ctx.fill();
  }

  #later(ms, fn) { this.#st.timers.push(setTimeout(fn, ms)); }
  #clearTimers() { for (const id of this.#st.timers) clearTimeout(id); this.#st.timers = []; }
}
