/*
 * Opening animation (#splash in index.html, styles in css/splash.css), about three seconds:
 *   0.0 s  the screen is completely black — no name.
 *   0.3 s  a cannon blast: a white-gold flash, the screen jolts, and hundreds of gold confetti pieces and sparkles
 *          shoot out of three cannons (bottom left, bottom right, centre) across the whole screen.
 *   ~1.5 s the blast has settled (confetti drifting down, sparkles twinkling) and "Marlon" appears, whole, at once.
 *   ~2.5 s after holding the name for a second, the screen fades into the app (0.5 s).
 * "Marlon" is never visible before the blast has settled. Reduced motion: no blast — black, then the name fades in,
 * then the app. Drawn on a canvas, all in the page, so it works offline; stopped as soon as the splash goes.
 */
(() => {
  const SPLASH_BG = "#000000"; // must match --splash-bg in splash.css
  const BLAST_MS = 300;  // black, then the cannon blast this long after the splash starts
  const WORD_MS = 1500;  // the blast has settled: "Marlon" appears (never before this)
  const HOLD_MS = 1000;  // the name is held this long before the fade
  const SHOW_MS = WORD_MS + HOLD_MS; // then the 0.5 s fade: about three seconds in all
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
  setTimeout(() => { timeUp = true; maybeLeave(); }, Math.max(0, (matchMedia("(prefers-reduced-motion: reduce)").matches ? 1400 : SHOW_MS) - elapsed));
  const reduced = matchMedia("(prefers-reduced-motion: reduce)").matches;
  var stopSparks = reduced ? () => {} : blast(splash);
  // The name appears whole once the blast has settled (with reduced motion: after a moment of black).
  setTimeout(() => splash.classList.add("is-word"), Math.max(0, (reduced ? 400 : WORD_MS) - elapsed));
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

  /** The cannon blast: gold confetti and sparkles fired across the whole screen, then falling and twinkling. */
  function blast(host) {
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
    const GOLD = ["#ffd700", "#ffc93c", "#f5b81c", "#ffe27a", "#e6a817", "#fff1b8", "#ffffff", "#fff7dc", "#d4a017", "#ffdf6e"];
    const rnd = (a, b) => a + Math.random() * (b - a);
    const big = Math.max(w, h);
    const pieces = [];
    // Three cannons: bottom left and bottom right firing up across the screen, and one bursting from the centre.
    const fire = (x, y, angle, spread, count, speed) => {
      for (let i = 0; i < count; i++) {
        const a = angle + rnd(-spread, spread), v = speed * rnd(0.55, 1.25);
        const confetti = Math.random() < 0.62;
        pieces.push({ x, y, vx: Math.cos(a) * v, vy: Math.sin(a) * v, confetti,
          size: confetti ? rnd(7, 15) : rnd(1.6, 4.2), color: GOLD[(Math.random() * GOLD.length) | 0],
          rot: rnd(0, 6.28), spin: rnd(-14, 14), flip: rnd(4, 12), phase: rnd(0, 6.28), twinkle: rnd(6, 16) });
      }
    };
    let fired = false, start = 0, last = 0, raf = 0, stopped = false;
    const frame = (now) => {
      if (stopped) return;
      if (!start) start = last = now;
      const t = (now - start) / 1000, dt = Math.min(0.05, (now - last) / 1000);
      last = now;
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      ctx.clearRect(0, 0, w, h);
      const since = (now - start - BLAST_MS) / 1000; // seconds since the blast
      if (since >= 0) {
        if (!fired) {
          fired = true;
          const n = Math.min(520, Math.round(w * h / 700));
          fire(0, h, -Math.PI / 3.2, 0.42, n * 0.35, big * 2.6);
          fire(w, h, -Math.PI + Math.PI / 3.2, 0.42, n * 0.35, big * 2.6);
          fire(w / 2, h / 2, 0, Math.PI, n * 0.3, big * 1.9);
        }
        // The jolt: the whole blast shakes for a moment.
        if (since < 0.3) { const k = (1 - since / 0.3) * 9; ctx.translate(rnd(-k, k), rnd(-k, k)); }
        // The flash.
        if (since < 0.4) {
          const g = ctx.createRadialGradient(w / 2, h / 2, 0, w / 2, h / 2, big * 0.8);
          const o = 0.85 * (1 - since / 0.4);
          g.addColorStop(0, `rgba(255, 250, 225, ${o})`);
          g.addColorStop(0.45, `rgba(255, 205, 80, ${o * 0.55})`);
          g.addColorStop(1, "rgba(255, 190, 60, 0)");
          ctx.fillStyle = g;
          ctx.fillRect(-20, -20, w + 40, h + 40);
        }
        const drag = Math.pow(0.08, dt);
        for (const p of pieces) {
          p.vx *= drag; p.vy = p.vy * drag + (p.confetti ? 520 : 300) * dt; // fast out, then gravity: falling
          if (p.confetti) { p.vx += Math.sin(t * 3 + p.phase) * 18 * dt; p.vy = Math.min(p.vy, 170); } // flutter down
          p.x += p.vx * dt; p.y += p.vy * dt; p.rot += p.spin * dt;
          if (p.y > h + 30 || p.x < -60 || p.x > w + 60) continue;
          ctx.fillStyle = p.color;
          if (p.confetti) {
            ctx.save();
            ctx.translate(p.x, p.y); ctx.rotate(p.rot);
            ctx.scale(1, Math.abs(Math.cos(t * p.flip + p.phase)) * 0.9 + 0.1); // tumbling paper
            ctx.globalAlpha = 0.95;
            ctx.fillRect(-p.size / 2, -p.size / 4, p.size, p.size / 2);
            ctx.restore();
          } else {
            ctx.globalAlpha = Math.max(0.15, 0.6 + 0.4 * Math.sin(t * p.twinkle + p.phase)); // twinkle
            const r = p.size * 2.4, a = p.rot;
            ctx.beginPath();
            for (let k = 0; k < 8; k++) { const rr = k % 2 ? r * 0.25 : r; const aa = a + k * Math.PI / 4; ctx.lineTo(p.x + Math.cos(aa) * rr, p.y + Math.sin(aa) * rr); }
            ctx.closePath(); ctx.fill();
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
