import { fromB64url } from "./crypto";
import { ICON_192, ICON_512 } from "./icons";

/** Lets the phone install Chief to the Home Screen (required for notifications on iPhone). */
export const MANIFEST = JSON.stringify({
  name: "Chief of Staff",
  short_name: "Chief",
  start_url: "/",
  scope: "/",
  display: "standalone",
  background_color: "#f6f5f2",
  theme_color: "#2f5bd3",
  icons: [
    { src: "/icon-192.png", sizes: "192x192", type: "image/png" },
    { src: "/icon-512.png", sizes: "512x512", type: "image/png", purpose: "any maskable" },
  ],
});

/**
 * Runs on the phone in the background: shows Chief's notifications, and on Android
 * the "Yes, send" button approves right from the notification.
 */
export const SERVICE_WORKER = `
self.addEventListener("install", function(){ self.skipWaiting(); });
self.addEventListener("activate", function(e){ e.waitUntil(self.clients.claim()); });
self.addEventListener("push", function(e){
  var m = {}; try { m = e.data ? e.data.json() : {}; } catch(_) { m = { title: "Chief", body: e.data ? e.data.text() : "" }; }
  e.waitUntil(self.registration.showNotification(m.title || "Chief", {
    body: m.body || "", tag: m.tag, data: m, icon: "/icon-192.png", badge: "/icon-192.png",
    requireInteraction: !!m.approve,
    actions: m.approve ? [{ action: "yes", title: "Yes, send" }, { action: "open", title: "Read it" }] : []
  }));
});
self.addEventListener("notificationclick", function(e){
  e.notification.close();
  var m = e.notification.data || {};
  if (e.action === "yes" && m.approve) {
    e.waitUntil(fetch("/approve/" + m.approve, { method: "POST", body: new URLSearchParams({ decision: "yes" }), headers: { "Accept": "application/json" }, credentials: "same-origin" })
      .then(function(r){ return r.json(); })
      .then(function(j){ return self.registration.showNotification(j.ok ? (j.label || "Sent ✓") : "Not sent", { body: j.ok ? "Done." : (j.error || "Open Chief to try again."), icon: "/icon-192.png", tag: (m.tag || "chief") + "-done" }); })
      .catch(function(){ return self.clients.openWindow(m.url || "/"); }));
    return;
  }
  e.waitUntil(self.clients.matchAll({ type: "window", includeUncontrolled: true }).then(function(list){
    for (var i = 0; i < list.length; i++) { if ("focus" in list[i]) { list[i].navigate(m.url || "/"); return list[i].focus(); } }
    return self.clients.openWindow(m.url || "/");
  }));
});
`;

export function icon(size: 192 | 512): Response {
  return new Response(fromB64url((size === 192 ? ICON_192 : ICON_512).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "")), {
    headers: { "Content-Type": "image/png", "Cache-Control": "public, max-age=86400" },
  });
}
