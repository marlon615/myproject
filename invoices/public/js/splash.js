/*
 * Startup splash timing. The splash (#splash in index.html, styles in css/splash.css) stays up for five
 * seconds from launch, then fades smoothly into the main page and is removed.
 *
 * - A plain (non-module) deferred script, so the splash still leaves even if the app's modules fail to load.
 * - Five seconds are counted from navigation start (performance.now()), not from when this script runs.
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
  const SHOW_MS = 5000;  // how long the splash stays fully visible
  const FADE_MS = 800;   // must match the transition in splash.css
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
