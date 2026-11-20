/*
 * Offline support. Installs a copy of the whole app on the phone, then serves it with no network at all.
 * Updates install in the background and take over at once (skipWaiting), so the next launch is always the
 * newest version; the open app reloads itself if it's still on the splash, or offers "Refresh" otherwise.
 * VERSION is stamped by scripts/stamp-sw.cjs.
 */
const VERSION = "31f745fe7560";
const CACHE = `marlon-app-${VERSION}`;

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
  "/js/letter.js",
  "/js/printer.js",
  "/js/voice.js",
  "/js/voice-parse.js",
  "/js/voice-review.js",
  "/js/thanks.js",
  "/js/payment.js",
  "/js/sign-thanks.js",
  "/js/setup.js",
  "/js/usage.js",
  "/js/license.js",
  "/js/team.js",
  "/js/remote.js",
  "/js/pro.js",
  "/js/pro-report.js",
  "/js/pricing.js",
  "/terms",
  "/boss",
  "/js/boss.js",
  "/js/ink-script.js",
  "/js/thankyou-strokes.js",
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
  event.waitUntil(
    caches.open(CACHE)
      .then((cache) => cache.addAll(PRECACHE.map((url) => new Request(url, { cache: "reload" }))))
      .then(() => self.skipWaiting()),
  );
});

self.addEventListener("activate", (event) => {
  event.waitUntil((async () => {
    for (const key of await caches.keys()) if (key.startsWith("marlon-app-") && key !== CACHE) await caches.delete(key);
    await self.clients.claim();
  })());
});

self.addEventListener("message", (event) => {
  if (event.data && event.data.type === "SKIP_WAITING") self.skipWaiting();
});

const isViewer = (path) => path === "/v" || path === "/v/" || path === "/v.html";
const isApp = (path) => path === "/" || path === "/index.html";
const isBoss = (path) => path === "/boss" || path === "/boss.html";

self.addEventListener("fetch", (event) => {
  const req = event.request;
  if (req.method !== "GET") return;
  const url = new URL(req.url);
  if (url.origin !== self.location.origin) return;
  // The maker's console and the anonymous counts are always live, never kept for offline use.
  if (url.pathname.startsWith("/api/") || url.pathname === "/console" || url.pathname === "/js/console.js") return;
  // A personal link's manifest (it starts the iPhone home-screen app at that link): from the server, not the cache.
  if (url.pathname === "/manifest.webmanifest" && url.searchParams.has("k")) {
    event.respondWith(fetch(req).catch(() => caches.match("/manifest.webmanifest")));
    return;
  }

  if (req.mode === "navigate") {
    if (isViewer(url.pathname) || isApp(url.pathname) || isBoss(url.pathname)) {
      const key = isViewer(url.pathname) ? "/v" : isBoss(url.pathname) ? "/boss" : "/";
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

// ── Alerts (web push): a buyer signed an invoice sent for signature, even while Marlon is closed ──
const signedText = (iso) => { const d = new Date(iso); return Number.isNaN(d.getTime()) ? "" : d.toLocaleString("en-US", { month: "short", day: "numeric", year: "numeric", hour: "numeric", minute: "2-digit" }); };
self.addEventListener("push", (event) => {
  let d = {};
  try { d = event.data ? event.data.json() : {}; } catch { d = {}; }
  const signed = d.type === "signed";
  const no = d.number ? String(d.number).padStart(4, "0") : "";
  const title = signed ? `Invoice ${no} signed`.replace("Invoice  ", "Invoice ") : "Marlon";
  const when = signed && d.signedAt ? signedText(d.signedAt) : "";
  const body = signed ? `Signed by ${d.signer || "your buyer"}${when ? ` on ${when}` : ""}` : "Open Marlon to see what's new.";
  event.waitUntil((async () => {
    // If Marlon is open, it fetches the signed copy straight away.
    for (const c of await self.clients.matchAll({ type: "window" })) c.postMessage({ type: "remote-check" });
    // Always show it (phones require that); the same tag as the app's own alert, so it never appears twice.
    await self.registration.showNotification(title, { body, tag: d.invoiceId ? `signed-${d.invoiceId}` : "marlon", icon: "/icons/icon-192.png", badge: "/icons/icon-192.png", data: { url: "/" } });
  })());
});
self.addEventListener("notificationclick", (event) => {
  event.notification.close();
  event.waitUntil((async () => {
    const wins = await self.clients.matchAll({ type: "window", includeUncontrolled: true });
    const app = wins.find((w) => new URL(w.url).pathname === "/");
    if (app) { app.postMessage({ type: "remote-check" }); return app.focus(); }
    return self.clients.openWindow("/");
  })());
});
