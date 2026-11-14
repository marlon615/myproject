/*
 * Opening animation. The splash (#splash in index.html, styles in css/splash.css): the screen starts dark, a burst
 * of gold and white sparkles flies out from the centre to the edges and drifts down twinkling (drawn here on a
 * canvas, at most 160 sparks, stopped when the splash goes); as it bursts, the whole word "Marlon" appears with a
 * glow and a gentle scale-up, then a shimmer of light sweeps across it; at about two seconds it fades into the app.
 * Reduced motion: no sparkles or movement, just the word fading in.
 *
 * - A plain (non-module) deferred script, so the splash still leaves even if the app's modules fail to load.
 * - The time is counted from navigation start (performance.now()), and also waits for the last letter's animation.
 * - If the app hasn't drawn its first screen by then (it sets window.__appReady and fires "app:ready"),
 *   the splash waits for it, but never longer than MAX_MS in total, so you don't fade into a blank page.
 * - While the splash shows, the page behind it is inert (no accidental taps or keyboard focus), and the
 *   browser/status-bar colour (meta theme-color) matches the dark splash; both are restored afterwards.
 * - A tap anywhere (or any key) skips the wait and fades straight to the main page. It listens for "click",
 *   which fires when the finger lifts, so the tap is fully used up by the splash and can't fall through
 *   and press something on the page underneath.
 * - Automated browsers (navigator.webdriver) skip it so tests run fast; add "?splash" to the URL to force it.
 * - Right after the app reloads itself into a new version (sessionStorage "skipSplashOnce"), it isn't shown again.
 */
(() => {
  const SPLASH_BG = "#0f1411"; // must match --splash-bg in splash.css
  const SHOW_MS = 1550;  // fully visible until this long after launch, then the 0.5 s fade: ~2 s in all
  const BURST_MS = 150;  // the sparkles burst (and the word appears) this long after the splash starts
  const SHIMMER_MS = 700; // the shimmer sweeps across the word this long after the burst
  const FADE_MS = 500;   // must match the transition in splash.css
  const MAX_MS = 10000;  // never hold the app back longer than this
  const TAP_GRACE_MS = 1500; // after a tap, wait at most this long for a slow app before fading anyway

  const root = document.documentElement;
  const splash = document.getElementById("splash");
  if (!splash) { root.classList.remove("splash-active"); return; }

  const forced = /[?&]splash(?:[=&]|$)/.test(location.search);
  // Just reloaded into a new version during the splash: don't show it a second time.
  let skipOnce = false;
  try { skipOnce = sessionStorage.getItem("skipSplashOnce") === "1"; sessionStorage.removeItem("skipSplashOnce"); } catch { /* private mode */ }
  if (skipOnce || (navigator.webdriver === true && !forced)) { finish(); return; }

  // Dark status bar / browser chrome while the splash shows (restored when it leaves).
  let themeMetas = [...document.querySelectorAll('meta[name="theme-color"]')];
  const addedMeta = !themeMetas.length;
  if (addedMeta) {
    const m = document.createElement("meta");
    m.name = "theme-color";
    document.head.append(m);
    themeMetas = [m];
  }
  const savedThemes = themeMetas.map((m) => m.content);
  for (const m of themeMetas) m.content = SPLASH_BG;
  const restoreTheme = () => {
    if (addedMeta) themeMetas[0].remove();
    else themeMetas.forEach((m, i) => { m.content = savedThemes[i]; });
  };

  // Make everything behind the splash inert until it has gone (remember what we changed).
  const madeInert = [];
  for (const el of document.body.children) {
    if (el !== splash && !el.inert) { el.inert = true; madeInert.push(el); }
  }

  let timeUp = false;
  let appReady = window.__appReady === true;
  let leaving = false;

  const elapsed = performance.now();
  setTimeout(() => { timeUp = true; maybeLeave(); }, Math.max(0, SHOW_MS - elapsed));
  const reduced = matchMedia("(prefers-reduced-motion: reduce)").matches;
  var stopSparks = reduced ? () => {} : sparkles(splash);
  setTimeout(() => {
    splash.classList.add("is-burst");
    setTimeout(() => {
      splash.classList.add("is-shimmer");
    }, SHIMMER_MS);
  }, reduced ? 0 : BURST_MS);
  setTimeout(() => { appReady = true; maybeLeave(); }, Math.max(0, MAX_MS - elapsed));
  document.addEventListener("app:ready", () => { appReady = true; maybeLeave(); }, { once: true });

  // Tap anywhere (or press any key) to skip straight to the main page.
  const listeners = new AbortController();
  let tapped = false;
  const skip = () => {
    if (leaving || tapped) return;
    tapped = true;
    timeUp = true;
    setTimeout(() => { appReady = true; maybeLeave(); }, TAP_GRACE_MS);
    maybeLeave();
  };
  splash.addEventListener("click", skip, { signal: listeners.signal });
  document.addEventListener("keydown", skip, { signal: listeners.signal });

  function maybeLeave() {
    if (leaving || !timeUp || !appReady) return;
    leaving = true;
    listeners.abort();
    for (const el of madeInert) el.inert = false;   // the page is usable as soon as the fade begins
    restoreTheme();
    splash.classList.add("is-leaving");
    let removed = false;
    const remove = () => { if (!removed) { removed = true; finish(); } };
    splash.addEventListener("transitionend", (e) => { if (e.propertyName === "opacity") remove(); });
    setTimeout(remove, FADE_MS + 300); // in case transitionend never fires
  }

  function finish() {
    stopSparks?.();
    splash.remove();
    root.classList.remove("splash-active");
    document.dispatchEvent(new Event("splash:done"));
  }

  /** The burst: gold and white sparks shot out from the centre, slowing, then falling and twinkling. */
  function sparkles(host) {
    const canvas = document.createElement("canvas");
    canvas.className = "splash-sparks";
    canvas.setAttribute("aria-hidden", "true");
    host.prepend(canvas);
    const ctx = canvas.getContext("2d");
    if (!ctx) return () => {};
    const dpr = Math.min(2, window.devicePixelRatio || 1);
    let w = 0, h = 0;
    const size = () => { w = host.clientWidth; h = host.clientHeight; canvas.width = w * dpr; canvas.height = h * dpr; ctx.setTransform(dpr, 0, 0, dpr, 0, 0); };
    size();
    const COLORS = ["#ffd56b", "#f7c548", "#ffe9a8", "#ffffff", "#fff4d6", "#e8b04a"];
    const reach = Math.hypot(w, h) / 2;
    const sparks = Array.from({ length: Math.min(160, Math.round(w * h / 2400)) }, (_, i) => {
      const angle = Math.random() * Math.PI * 2, speed = reach * (0.9 + Math.random() * 1.6); // px per second
      return { x: 0, y: 0, vx: Math.cos(angle) * speed, vy: Math.sin(angle) * speed - reach * 0.25, r: 1 + Math.random() * 2.6,
        color: COLORS[i % COLORS.length], star: Math.random() < 0.35, spin: Math.random() * 6, twinkle: 4 + Math.random() * 8, phase: Math.random() * 6 };
    });
    let start = 0, last = 0, raf = 0, stopped = false;
    const frame = (now) => {
      if (stopped) return;
      if (!start) { start = last = now; }
      const t = (now - start) / 1000, dt = Math.min(0.05, (now - last) / 1000);
      last = now;
      ctx.clearRect(0, 0, w, h);
      const burst = (now - start) >= BURST_MS;
      if (burst) {
        // A quick flash at the centre as it bursts.
        const ft = (now - start - BURST_MS) / 1000;
        if (ft < 0.35) {
          const g = ctx.createRadialGradient(w / 2, h / 2, 0, w / 2, h / 2, reach * 0.55);
          g.addColorStop(0, `rgba(255, 236, 180, ${0.55 * (1 - ft / 0.35)})`);
          g.addColorStop(1, "rgba(255, 236, 180, 0)");
          ctx.fillStyle = g;
          ctx.fillRect(0, 0, w, h);
        }
        for (const p of sparks) {
          const drag = Math.pow(0.12, dt);               // fast out, then slowing (air resistance)
          p.vx *= drag; p.vy = p.vy * drag + 260 * dt;    // ...and gravity takes over: they drift down
          p.x += p.vx * dt; p.y += p.vy * dt;
          const tw = 0.55 + 0.45 * Math.sin(t * p.twinkle + p.phase); // twinkle
          ctx.globalAlpha = Math.max(0, Math.min(1, tw));
          ctx.fillStyle = p.color;
          const x = w / 2 + p.x, y = h / 2 + p.y;
          if (p.star) {                                   // a little four-pointed glint
            const r = p.r * 2.2, a = p.spin + t * 3;
            ctx.beginPath();
            for (let k = 0; k < 8; k++) { const rr = k % 2 ? r * 0.28 : r; const aa = a + k * Math.PI / 4; ctx.lineTo(x + Math.cos(aa) * rr, y + Math.sin(aa) * rr); }
            ctx.closePath(); ctx.fill();
          } else {
            ctx.beginPath(); ctx.arc(x, y, p.r, 0, Math.PI * 2); ctx.fill();
          }
        }
        ctx.globalAlpha = 1;
      }
      raf = requestAnimationFrame(frame);
    };
    raf = requestAnimationFrame(frame);
    window.addEventListener("resize", size);
    return () => { stopped = true; cancelAnimationFrame(raf); window.removeEventListener("resize", size); };
  }
})();
