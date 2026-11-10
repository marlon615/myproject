/*
 * Offline support. Installs a copy of the whole app on the phone, then serves it with no network at all.
 * Updates: a new version installs in the background and waits; the app shows "A new version is ready",
 * and "Refresh" posts {type: "SKIP_WAITING"} so it takes over. VERSION is stamped by scripts/stamp-sw.cjs.
 */
const VERSION = "be90a2888499";
const CACHE = `mw-invoices-${VERSION}`;

// On Cloudflare "/index.html" redirects to "/" and "/v.html" to "/v", so the pages are cached by those URLs.
const PRECACHE = [
  "/",
  "/v",
  "/manifest.webmanifest",
  "/favicon.ico",
  "/css/base.css",
  "/css/splash.css",
  "/css/app.css",
  "/css/dashboard.css",
  "/css/view.css",
  "/js/app.js",
  "/js/db.js",
  "/js/util.js",
  "/js/ui.js",
  "/js/splash.js",
  "/js/signature.js",
  "/js/dashboard.js",
  "/js/qr.js",
  "/js/codec.js",
  "/js/view.js",
  "/js/receipt.js",
  "/js/pdf.js",
  "/js/share.js",
  "/js/printer.js",
  "/js/vendor/qrcode.js",
  "/icons/icon.svg",
  "/icons/icon-192.png",
  "/icons/icon-512.png",
  "/icons/icon-maskable-512.png",
  "/icons/apple-touch-icon.png",
  "/icons/favicon-32.png",
];

self.addEventListener("install", (event) => {
  // addAll fails the whole install if any file is missing, so a broken deploy never replaces a working one.
  event.waitUntil(caches.open(CACHE).then((cache) => cache.addAll(PRECACHE.map((url) => new Request(url, { cache: "reload" })))));
});

self.addEventListener("activate", (event) => {
  event.waitUntil((async () => {
    for (const key of await caches.keys()) if (key.startsWith("mw-invoices-") && key !== CACHE) await caches.delete(key);
    await self.clients.claim();
  })());
});

self.addEventListener("message", (event) => {
  if (event.data && event.data.type === "SKIP_WAITING") self.skipWaiting();
});

const isViewer = (path) => path === "/v" || path === "/v/" || path === "/v.html";
const isApp = (path) => path === "/" || path === "/index.html";

self.addEventListener("fetch", (event) => {
  const req = event.request;
  if (req.method !== "GET") return;
  const url = new URL(req.url);
  if (url.origin !== self.location.origin) return;

  if (req.mode === "navigate") {
    if (isViewer(url.pathname) || isApp(url.pathname)) {
      const key = isViewer(url.pathname) ? "/v" : "/";
      event.respondWith(caches.match(key, { ignoreSearch: true }).then((hit) => hit || fetch(req)));
    } else {
      // Unknown page: ask the network (its 404 page), or open the app when offline.
      event.respondWith(fetch(req).catch(() => caches.match("/")));
    }
    return;
  }

  event.respondWith(
    caches.match(req, { ignoreSearch: true }).then((hit) => hit || fetch(req).then((res) => {
      if (res.ok && res.type === "basic") {
        const copy = res.clone();
        caches.open(CACHE).then((cache) => cache.put(req, copy));
      }
      return res;
    })),
  );
});
