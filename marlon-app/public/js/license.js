/**
 * Personal links: the app opens only on phones activated through a buyer's own link (made in the maker's console).
 * (Shown in #gate; the app itself doesn't start behind it.)
 * Each link works on up to the number of phones the buyer paid for; the first phones to open it take the places.
 *
 *   const access = await ensureAccess();   // { ok: true } or { ok: false, reason } (the gate screen is then showing)
 *
 * After the first activation the app works offline. When there's a connection, each start checks the phone is
 * still switched on (the maker can switch off one phone or a whole buyer); a switched-off phone stays blocked,
 * even offline, until it's switched on again.
 *
 * iPhone: a home-screen app has its own storage, separate from Safari, so activating in Safari would use two places.
 * There the link asks to "Add to Home Screen" first (the link travels with it) and the home-screen app activates.
 */
import { settings } from "./db.js";
import { h } from "./util.js";

const KEY = /^[0-9a-f]{32}$/;
const randomId = () => Array.from(crypto.getRandomValues(new Uint8Array(16)), (b) => b.toString(16).padStart(2, "0")).join("");
let root = null;

/** The personal link's key in this page's address, if any (?k=…). */
function keyFromUrl() {
  try { const k = new URL(location.href).searchParams.get("k"); return k && KEY.test(k) ? k : null; } catch { return null; }
}

/** Takes the key out of the address bar once this phone is active (it's no longer needed there). */
function cleanUrl() {
  try {
    const u = new URL(location.href);
    if (!u.searchParams.has("k")) return;
    u.searchParams.delete("k");
    history.replaceState(history.state, "", u.pathname + (u.search === "?" ? "" : u.search) + u.hash);
  } catch { /* fine */ }
}

/** iPhone/iPad, in Safari (or another iPhone browser) rather than from the home screen. */
const iosBrowser = () => navigator.standalone === false;

async function call(path, body) {
  const res = await fetch(path, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body), cache: "no-store" });
  let data = {};
  try { data = await res.json(); } catch { /* empty */ }
  if (res.status >= 500 || (!res.ok && res.status !== 403)) throw new Error(`HTTP ${res.status}`);
  return data;
}

async function contactText() {
  try { const r = await fetch("/api/contact", { cache: "no-store" }); return (await r.json()).contact || ""; } catch { return (await settings.get("licenseContact", "")) || ""; }
}

export async function ensureAccess(container) {
  root = container;
  const saved = await settings.get("license", null);
  const urlKey = keyFromUrl();

  if (saved?.key && saved.device) {
    if (saved.state === "off") return recheckOff(saved);
    cleanUrl();
    checkLater(saved); // when online: is this phone still switched on? (never holds up opening the app)
    return { ok: true };
  }
  if (!urlKey) return show("nolink", await contactText());
  if (iosBrowser()) return showInstall(urlKey);
  return activate(urlKey);
}

async function activate(key) {
  const device = (await settings.get("licenseDevice", null)) || randomId();
  await settings.set("licenseDevice", device);
  let r;
  try {
    r = await call("/api/activate", { key, device });
  } catch {
    return show("offline", "", () => location.reload());
  }
  if (r.ok) {
    await settings.set("license", { key, device, state: "on", at: new Date().toISOString() });
    cleanUrl();
    return { ok: true, activated: true };
  }
  await settings.set("licenseContact", r.contact || "");
  return show(r.reason === "full" ? "full" : "off", r.contact || "");
}

/** A switched-off phone: blocked, but asks again when online in case the maker switched it back on. */
async function recheckOff(saved) {
  try {
    const r = await call("/api/check", { key: saved.key, device: saved.device });
    if (r.ok) {
      await settings.set("license", { ...saved, state: "on" });
      cleanUrl();
      return { ok: true };
    }
    await settings.set("licenseContact", r.contact || "");
  } catch { /* offline: stays blocked */ }
  return show("off", (await settings.get("licenseContact", "")) || "");
}

function checkLater(saved) {
  const run = async () => {
    if (navigator.onLine === false) return;
    try {
      const r = await call("/api/check", { key: saved.key, device: saved.device });
      if (r.ok || r.reason === undefined) return;
      await settings.set("license", { ...saved, state: "off" });
      await settings.set("licenseContact", r.contact || "");
      show("off", r.contact || "");
      document.dispatchEvent(new Event("app:blocked"));
    } catch { /* offline or the server is away: keep working */ }
  };
  run();
  window.addEventListener("online", run);
}

const TEXT = {
  nolink: ["Open your personal link", "Marlon opens only from the personal link you got when you bought it. Open that link on this phone."],
  full: ["This link is already in use", "This personal link is already active on all the phones it was bought for, so it can't be used on this one."],
  off: ["Marlon is switched off on this phone", "This phone's access to Marlon has been switched off."],
  offline: ["Connect to the internet once", "The first time, Marlon needs the internet for a moment to activate this phone. After that it works offline."],
};

/** The gate screen in place of the app. */
function show(reason, contact, retry = () => location.reload()) {
  const [title, lead] = TEXT[reason];
  const contactLine = reason === "offline" ? null
    : h("p", { class: "gate-contact" }, contact ? `To get access, contact ${contact}.` : "To get access, contact the person who sold you Marlon.");
  root.replaceChildren(h("div", { class: "gate card", role: "alert", dataset: { reason } },
    h("p", { class: "gate-kicker" }, "Marlon"),
    h("h1", { class: "gate-title" }, title),
    h("p", { class: "gate-lead" }, lead),
    contactLine,
    h("button", { type: "button", class: "btn btn-primary btn-block gate-retry", onclick: retry }, "Try again")));
  root.hidden = false;
  return { ok: false, reason };
}

/** iPhone in Safari: add to the home screen first; the personal link goes with it. Or use it here instead. */
function showInstall(key) {
  const manifest = document.querySelector('link[rel="manifest"]');
  if (manifest) manifest.href = `/manifest.webmanifest?k=${key}`;
  root.replaceChildren(h("div", { class: "gate card", dataset: { reason: "install" } },
    h("p", { class: "gate-kicker" }, "Marlon"),
    h("h1", { class: "gate-title" }, "Add Marlon to your Home Screen"),
    h("p", { class: "gate-lead" }, "On iPhone, Marlon works from your Home Screen, even with no internet. Your personal link goes with it."),
    h("ol", { class: "gate-steps" },
      h("li", {}, "Tap the Share button (the square with an arrow) at the bottom of Safari."),
      h("li", {}, "Choose “Add to Home Screen”, then “Add”."),
      h("li", {}, "Open Marlon from your Home Screen.")),
    h("button", { type: "button", class: "link-btn gate-here", onclick: async () => { const r = await activate(key); if (r.ok) location.reload(); } }, "Use it here in Safari instead (this counts as one of your phones)")));
  root.hidden = false;
  return { ok: false, reason: "install" }; // the app opens from the Home Screen (or after "use it here")
}
