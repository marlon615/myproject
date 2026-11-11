/**
 * Signing-effect test page (not part of the app yet).
 *
 * While the customer signs, the ink writes "Thank you" in a flowing script, in step with the finger: the more the
 * finger moves, the further the pen writes. The real signature is recorded underneath by the app's own
 * SignaturePad, exactly as drawn ("What's saved" shows it). When the finger lifts, the words finish and settle,
 * the customer's name appears under them, then the green tick draws itself and the phone gives a gentle tap.
 */
import { SignaturePad } from "/js/signature.js";
import { buzz } from "/js/thanks.js";
import { InkScript } from "./ink-script.1.js";

const $ = (id) => document.getElementById(id);
const el = {
  pad: $("pad"), sig: $("sig"), ink: $("ink"), fx: $("fx"), sealed: $("sealed"), who: $("who"), whoInput: $("who-input"),
  status: $("status"), again: $("again"), trail: $("trail"), saved: $("saved"), savedImg: $("saved-img"),
};

const INK = "#16241c";
const GAIN = 1.15;       // at first the words are written a little faster than the finger moves, then gently slower
const FOLLOW_MS = 70;    // how softly the pen follows the finger
const MAX_SPEED = 2600;  // px/s, so a flick never jumps
const GRACE_MS = 650;    // a lift shorter than this is still the same signature (between first and last name)
const DRIFT = 260;       // px/s the pen keeps writing during that pause, so it never stops dead
const TRAIL_MS = 380;    // how long the faint trail under the finger lasts
const MIN_TRAVEL = 40;   // px of finger movement before it counts as a signature (a tap isn't one)
const reduced = () => matchMedia("(prefers-reduced-motion: reduce)").matches;

const pad = new SignaturePad(el.sig, { onChange: () => { if (st.phase === "done") showSaved(); } });
const ink = new InkScript();
const inkCtx = el.ink.getContext("2d");
const fxCtx = el.fx.getContext("2d");

const st = {
  phase: "idle",           // idle → writing → finishing → settling → done
  total: 0, box: null, size: { w: 0, h: 0, dpr: 1 },
  target: 0, shown: 0, speed: 0, travel: 0,
  pointer: null, last: null,
  trail: [],               // { x, y, t, gap }
  finish: null,            // { from, at, dur, m0 }
  timers: [], raf: 0, prev: 0,
};

// ── Layout ───────────────────────────────────────────────────────────────

function resize() {
  const w = el.pad.clientWidth, h = el.pad.clientHeight;
  if (!w || !h) return;
  const dpr = Math.min(3, window.devicePixelRatio || 1);
  if (w === st.size.w && h === st.size.h && dpr === st.size.dpr) return;
  const oldTotal = st.total;
  st.size = { w, h, dpr };
  for (const c of [el.ink, el.fx]) { c.width = Math.round(w * dpr); c.height = Math.round(h * dpr); }
  const { total, box } = ink.layout(w, h);
  if (oldTotal) { st.shown *= total / oldTotal; st.target *= total / oldTotal; }
  st.total = total;
  st.box = box;
  for (const ctx of [inkCtx, fxCtx]) ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  inkCtx.fillStyle = INK;
  inkCtx.clearRect(0, 0, w, h);
  ink.redraw(inkCtx, st.shown);
  // The words settle (shrink a touch and rise) around their own centre; the name sits just under them.
  const cx = box.x + box.w / 2, cy = box.y + box.h / 2;
  el.ink.style.transformOrigin = `${cx}px ${cy}px`;
  el.sealed.style.top = `${Math.round(Math.min(h - 34, cy + box.h * 0.47 - 6 + 5))}px`;
}

// ── Finger ───────────────────────────────────────────────────────────────

const local = (e) => {
  const r = el.pad.getBoundingClientRect();
  return { x: e.clientX - r.left - el.pad.clientLeft, y: e.clientY - r.top - el.pad.clientTop };
};

function onDown(e) {
  if (st.pointer !== null || (e.pointerType === "mouse" && e.button !== 0)) return;
  if (st.phase !== "idle" && st.phase !== "writing") return; // after the words finish, extra strokes are still recorded
  st.pointer = e.pointerId;
  st.last = local(e);
  st.trail.push({ ...st.last, t: performance.now(), gap: true });
  clearTimers();
  if (st.phase === "idle") el.pad.classList.add("is-writing");
  st.phase = "writing";
  run();
}

function onMove(e) {
  if (e.pointerId !== st.pointer) return;
  const list = typeof e.getCoalescedEvents === "function" ? e.getCoalescedEvents() : [];
  for (const ev of list.length ? list : [e]) {
    const p = local(ev);
    const d = Math.hypot(p.x - st.last.x, p.y - st.last.y);
    st.last = p;
    st.travel += d;
    // The pen travels along "Thank you" as the finger travels: quickly at first, easing as the words fill up.
    st.target += (d * GAIN * (st.total - st.target)) / st.total;
    st.trail.push({ ...p, t: performance.now(), gap: false });
  }
}

function onUp(e) {
  if (e.pointerId !== st.pointer) return;
  st.pointer = null;
  if (st.phase !== "writing") return;
  later(GRACE_MS, () => {
    if (st.pointer !== null || st.phase !== "writing") return;
    if (pad.isEmpty() || st.travel < MIN_TRAVEL) { restart("Sign with your finger: move it across the box."); return; }
    startFinish();
  });
}

// ── Writing, finishing, settling ─────────────────────────────────────────

function startFinish() {
  const remaining = Math.max(1, st.total - st.shown);
  const dur = Math.min(1100, Math.max(380, (remaining / 700) * 1000));
  // Start at the pen's current speed and glide to a stop at the end of "you".
  const m0 = Math.min(2.2, Math.max(0.4, (st.speed * dur) / 1000 / remaining));
  st.finish = { from: st.shown, at: performance.now(), dur, m0 };
  st.phase = "finishing";
  run();
}

function settle() {
  st.phase = "settling";
  el.pad.classList.add("is-settling", "is-sealed");
  const name = el.whoInput.value.trim();
  el.who.textContent = name;
  el.who.hidden = !name;
  const quick = reduced();
  later(quick ? 0 : 220, () => el.sealed.classList.add("is-shown"));
  later(quick ? 0 : 580, () => el.sealed.classList.add("is-checked"));
  later(quick ? 0 : 580 + 760, () => { buzz(); done(name); }); // the tap lands as the tick completes
}

function done(name) {
  st.phase = "done";
  el.status.textContent = name ? `Signed. Thank you, ${name}.` : "Signed. Thank you!";
  el.status.classList.add("is-done");
  el.again.hidden = false;
  showSaved();
}

function showSaved() {
  el.savedImg.src = pad.toDataURL();
  el.saved.hidden = false;
}

function restart(message = "Sign in the box with your finger.") {
  clearTimers();
  pad.clear();
  st.phase = "idle";
  st.target = st.shown = st.speed = st.travel = 0;
  st.pointer = null;
  st.trail = [];
  st.finish = null;
  ink.reset();
  inkCtx.clearRect(0, 0, st.size.w, st.size.h);
  fxCtx.clearRect(0, 0, st.size.w, st.size.h);
  el.pad.classList.remove("is-writing", "is-settling", "is-sealed");
  el.sealed.classList.remove("is-shown", "is-checked");
  el.status.textContent = message;
  el.status.classList.remove("is-done");
  el.again.hidden = true;
  el.saved.hidden = true;
}

// ── Animation ────────────────────────────────────────────────────────────

function run() {
  if (!st.raf) { st.prev = 0; st.raf = requestAnimationFrame(frame); }
}

function frame(t) {
  const dt = st.prev ? Math.min(64, t - st.prev) : 16;
  st.prev = t;
  const before = st.shown;
  if (st.phase === "writing") {
    if (st.pointer === null) st.target = Math.min(st.total * 0.985, st.target + (DRIFT * dt) / 1000);
    const step = (st.target - st.shown) * (1 - Math.exp(-dt / FOLLOW_MS));
    st.shown += Math.min(Math.max(0, step), (MAX_SPEED * dt) / 1000);
  } else if (st.phase === "finishing") {
    const f = st.finish, k = Math.min(1, (t - f.at) / f.dur);
    const h = f.m0 * (k * k * k - 2 * k * k + k) + (3 * k * k - 2 * k * k * k); // Hermite: current speed → stop
    st.shown = f.from + (st.total - f.from) * h;
    if (k >= 1) { st.shown = st.total; settle(); }
  }
  st.speed = st.speed * 0.8 + (((st.shown - before) * 1000) / dt) * 0.2;
  const tip = ink.drawTo(inkCtx, st.shown);
  drawFx(t, tip);
  const busy = st.phase === "writing" || st.phase === "finishing" || st.trail.length > 0;
  st.raf = busy ? requestAnimationFrame(frame) : 0;
}

/** The faint, quickly fading trail under the finger, and a soft glow at the pen's tip. */
function drawFx(t, tip) {
  const { w, h } = st.size;
  fxCtx.clearRect(0, 0, w, h);
  st.trail = st.trail.filter((p) => t - p.t < TRAIL_MS);
  if (el.trail.checked && st.trail.length > 1) {
    fxCtx.lineCap = "round";
    fxCtx.lineJoin = "round";
    fxCtx.lineWidth = 2.4;
    for (let i = 1; i < st.trail.length; i++) {
      const a = st.trail[i - 1], b = st.trail[i];
      if (b.gap) continue;
      fxCtx.strokeStyle = `rgba(22, 36, 28, ${(0.15 * (1 - (t - b.t) / TRAIL_MS)).toFixed(3)})`;
      fxCtx.beginPath();
      fxCtx.moveTo(a.x, a.y);
      fxCtx.lineTo(b.x, b.y);
      fxCtx.stroke();
    }
  }
  if (tip && (st.phase === "writing" || st.phase === "finishing")) {
    const g = fxCtx.createRadialGradient(tip.x, tip.y, 0, tip.x, tip.y, 11);
    g.addColorStop(0, "rgba(23, 99, 63, 0.30)");
    g.addColorStop(1, "rgba(23, 99, 63, 0)");
    fxCtx.fillStyle = g;
    fxCtx.beginPath();
    fxCtx.arc(tip.x, tip.y, 11, 0, Math.PI * 2);
    fxCtx.fill();
  }
}

// ── Wiring ───────────────────────────────────────────────────────────────

function later(ms, fn) { st.timers.push(setTimeout(fn, ms)); }
function clearTimers() { for (const id of st.timers) clearTimeout(id); st.timers = []; }

el.sig.addEventListener("pointerdown", onDown);
el.sig.addEventListener("pointermove", onMove);
for (const type of ["pointerup", "pointercancel"]) el.sig.addEventListener(type, onUp);
el.again.addEventListener("click", () => restart());
el.whoInput.addEventListener("input", () => {
  if (st.phase !== "settling" && st.phase !== "done") return;
  const name = el.whoInput.value.trim();
  el.who.textContent = name;
  el.who.hidden = !name;
  if (st.phase === "done") el.status.textContent = name ? `Signed. Thank you, ${name}.` : "Signed. Thank you!";
});
new ResizeObserver(resize).observe(el.pad);
resize();
window.__lab = { st, pad }; // for the automated check
