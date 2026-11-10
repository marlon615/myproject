// Emulates the app's "first screen rendered" signal. ?ready=<ms> delays it; ?ready=never never sends it.
const p = new URLSearchParams(location.search).get("ready");
const send = () => { window.__appReady = true; document.dispatchEvent(new Event("app:ready")); };
if (p !== "never") setTimeout(send, Number(p) || 0);
window.__t0 = performance.now();
document.addEventListener("splash:done", () => { window.__splashDoneAt = performance.now(); });
