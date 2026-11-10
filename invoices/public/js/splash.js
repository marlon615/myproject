/*
 * Startup splash timing. The splash (#splash in index.html, styles in css/splash.css) stays up for five
 * seconds from launch, then fades smoothly into the main page and is removed.
 *
 * - A plain (non-module) deferred script, so the splash still leaves even if the app's modules fail to load.
 * - Five seconds are counted from navigation start (performance.now()), not from when this script runs.
 * - If the app hasn't drawn its first screen by then (it sets window.__appReady and fires "app:ready"),
 *   the splash waits for it, but never longer than MAX_MS in total, so you don't fade into a blank page.
 * - While the splash shows, the page behind it is inert (no accidental taps or keyboard focus).
 * - Automated browsers (navigator.webdriver) skip it so tests run fast; add "?splash" to the URL to force it.
 */
(() => {
  const SHOW_MS = 5000;  // how long the splash stays fully visible
  const FADE_MS = 800;   // must match the transition in splash.css
  const MAX_MS = 10000;  // never hold the app back longer than this

  const root = document.documentElement;
  const splash = document.getElementById("splash");
  if (!splash) { root.classList.remove("splash-active"); return; }

  const forced = /[?&]splash(?:[=&]|$)/.test(location.search);
  if (navigator.webdriver === true && !forced) { finish(); return; }

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

  function maybeLeave() {
    if (leaving || !timeUp || !appReady) return;
    leaving = true;
    for (const el of madeInert) el.inert = false;   // the page is usable as soon as the fade begins
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
