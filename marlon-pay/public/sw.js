/* Marlon Pay offline: the app's files are kept on the device, so it opens and works with no signal.
   /api/ always goes to the network (records are saved in the app's own storage and sent by sync.js). */
const VERSION = "7d8c6e72d239";
const CACHE = `marlon-pay-${VERSION}`;
const PRECACHE = [
  "/",
  "/manifest.webmanifest",
  "/css/pay.css",
  "/js/app.js",
  "/js/db.js",
  "/js/sync.js",
  "/js/util.js",
  "/js/owner.js",
  "/js/pdf.js",
  "/js/signature.js",
  "/icons/icon.svg",
  "/icons/icon-192.png",
  "/icons/apple-touch-icon.png",
];
self.addEventListener("install", (e) => { e.waitUntil(caches.open(CACHE).then((c) => c.addAll(PRECACHE)).then(() => self.skipWaiting())); });
self.addEventListener("activate", (e) => {
  e.waitUntil(caches.keys().then((keys) => Promise.all(keys.filter((k) => k.startsWith("marlon-pay-") && k !== CACHE).map((k) => caches.delete(k)))).then(() => self.clients.claim()));
});
self.addEventListener("fetch", (e) => {
  const url = new URL(e.request.url);
  if (e.request.method !== "GET" || url.origin !== location.origin || url.pathname.startsWith("/api/")) return;
  if (e.request.mode === "navigate") {
    // The page: fresh when online (so updates arrive), the kept copy when offline.
    e.respondWith(fetch(e.request).then((r) => { if (r.ok) { const copy = r.clone(); caches.open(CACHE).then((c) => c.put("/", copy)); } return r; }).catch(() => caches.match("/")));
    return;
  }
  e.respondWith(caches.match(e.request, { ignoreSearch: true }).then((hit) => hit || fetch(e.request)));
});
