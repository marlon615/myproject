/*
 * Opening animation (#splash in index.html, styles in css/splash.css), under 1.5 seconds:
 *   dark screen; the word "Marlon" flies at the screen from far away, fast (0.22 s, from the first frame), slams into
 *   place full size with one small shake of the screen, holds for 1 second, then the app opens (0.12 s fade).
 * The hold is counted from when the throw really began, so the word always holds a full second.
 * Reduced motion: no flying or shaking — the word appears, holds, then the app. All in the page: works offline.
 */
(() => {
  const SPLASH_BG = "#000000"; // must match --splash-bg in splash.css
  const FLY_MS = 220;    // the word flies in from the first frame (must match splash-fly in splash.css)
  const HOLD_MS = 1000;  // it lands (with the small shake) and holds this long
  const FADE_MS = 120;   // must match the transition in splash.css
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
  const reduced = matchMedia("(prefers-reduced-motion: reduce)").matches;
  // The throw started on the first frame (CSS); hold a full second after it lands, counted from when it really began.
  splash.classList.add("is-fly");
  const fly = splash.querySelector(".splash-name svg")?.getAnimations?.()[0];
  const began = fly && typeof fly.startTime === "number" ? fly.startTime : performance.now();
  setTimeout(() => { timeUp = true; maybeLeave(); }, Math.max(0, began + (reduced ? 150 : FLY_MS) + HOLD_MS - performance.now()));
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
    splash.remove();
    root.classList.remove("splash-active");
    document.dispatchEvent(new Event("splash:done"));
  }

})();
