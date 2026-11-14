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
 * Phones in the browser see an install page first (the personal link travels with the installed app):
 *   iPhone:  a home-screen app has its own storage, separate from Safari, so activating in Safari would use two
 *            places; the home-screen app activates (or "use it here" in Safari, which takes a place).
 *   Android: Chrome's menu → "Add to Home screen" / "Install app" (or Chrome's own Install button when it offers
 *            one); "use it here in Chrome" costs nothing extra, since Chrome and the installed app share storage.
 */
import { eraseEverything, exportBackup, settings } from "./db.js";
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

const UA = () => navigator.userAgent || "";
/** A real iPhone or iPad (iPads can say "Macintosh"; only they have touch) — never an Android phone. */
const isIOS = () => !/Android/i.test(UA()) && (/iPhone|iPad|iPod/.test(UA()) || (/Macintosh/.test(UA()) && navigator.maxTouchPoints > 1));
const isAndroid = () => /Android/i.test(UA()) || navigator.userAgentData?.platform === "Android";
const installed = () => navigator.standalone === true || ["standalone", "fullscreen", "minimal-ui"].some((m) => matchMedia(`(display-mode: ${m})`).matches);
/** iPhone/iPad, in Safari (or another iPhone browser) rather than from the home screen. */
const iosBrowser = () => isIOS() && !installed();
/** An Android phone, in the browser rather than opened as an installed app. */
const androidBrowser = () => isAndroid() && !installed();
/** Which browser, for the right steps. In-app browsers (Facebook, Instagram…) can't add to the Home Screen. */
function browserName() {
  const ua = UA();
  if (/FBAN|FBAV|FB_IAB|Instagram|Line\/|Snapchat|TikTok|musical_ly|; wv\)/.test(ua)) return "inapp";
  if (/SamsungBrowser/.test(ua)) return "samsung";
  if (/EdgA|EdgiOS/.test(ua)) return "edge";
  if (/Firefox|FxiOS/.test(ua)) return "firefox";
  if (/OPR\/|Opera/.test(ua)) return "opera";
  if (/CriOS/.test(ua)) return "chrome-ios";
  return isIOS() ? "safari" : "chrome";
}

// Chrome on Android can offer its own "Install app" button; keep its offer for the install page.
let installOffer = null;
window.addEventListener("beforeinstallprompt", (e) => {
  e.preventDefault();
  installOffer = e;
  document.dispatchEvent(new Event("license:installable"));
});

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

  // This phone already uses Marlon through another link: ask before switching (never ignore the link silently).
  if (saved?.key && saved.device && urlKey && urlKey !== saved.key) return showSwitch(saved, urlKey);
  if (saved?.key && saved.device) {
    if (saved.state === "off") return recheckOff(saved);
    cleanUrl();
    checkLater(saved); // when online: is this phone still switched on? (never holds up opening the app)
    return { ok: true, team: Boolean(saved.team), company: saved.company || "", repName: saved.repName || "" };
  }
  if (!urlKey) return show("nolink", await contactText());
  if (iosBrowser()) return showInstall(urlKey, "ios");
  if (androidBrowser()) return showInstall(urlKey, "android");
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
    await settings.set("license", { key, device, state: "on", team: Boolean(r.team), company: r.company || "", repName: r.repName || "", at: new Date().toISOString() });
    cleanUrl();
    return { ok: true, activated: true, team: Boolean(r.team), company: r.company || "", repName: r.repName || "" };
  }
  await settings.set("licenseContact", r.contact || "");
  return show(r.reason === "full" ? "full" : "off", r.contact || "");
}

/** A switched-off phone: blocked, but asks again when online in case the maker switched it back on. */
async function recheckOff(saved) {
  try {
    const r = await call("/api/check", { key: saved.key, device: saved.device });
    if (r.ok) {
      await settings.set("license", { ...saved, state: "on", team: Boolean(r.team) });
      cleanUrl();
      return { ok: true, team: Boolean(r.team) };
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
      if (r.ok) { if (Boolean(r.team) !== Boolean(saved.team)) await settings.set("license", { ...saved, team: Boolean(r.team) }); return; }
      if (r.reason === undefined) return;
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

/** Another personal link opened on a phone already set up: say what each is, and switch only if asked. */
async function showSwitch(saved, newKey) {
  let info = null;
  try { info = await call("/api/link-info", { key: newKey }); } catch { /* offline */ }
  const current = (await settings.get("business", null))?.name || "your business";
  const target = info?.ok ? (info.kind === "team" ? `${info.company}${info.rep ? ` (rep ${info.rep})` : " (team)"}` : "another business") : "another Marlon link";
  const keep = () => { cleanUrl(); location.replace(location.pathname); };
  const sw = async () => {
    if (!confirm(`Switch this phone to ${target}?\n\nThis erases ${current}'s invoices, customers and products from this phone.`)) return;
    await eraseEverything();
    try { localStorage.removeItem("marlon.setupDraft"); } catch { /* fine */ }
    location.replace(`/?k=${newKey}`);
  };
  root.replaceChildren(h("div", { class: "gate card", dataset: { reason: "switch" } },
    h("p", { class: "gate-kicker" }, "Marlon"),
    h("h1", { class: "gate-title" }, "This phone already uses Marlon"),
    h("p", { class: "gate-lead" }, `It's set up for ${current}. The link you just opened is for ${target}.`),
    h("p", { class: "gate-lead" }, `Switching erases ${current}'s invoices, customers and products from this phone, so save a backup first if you need them.`),
    h("button", { type: "button", class: "btn btn-primary btn-block gate-switch", onclick: sw }, `Switch to ${target}`),
    h("button", { type: "button", class: "btn btn-block gate-backup", onclick: async () => {
      try { const blob = new Blob([JSON.stringify(await exportBackup(), null, 2)], { type: "application/json" }); const a = document.createElement("a"); a.href = URL.createObjectURL(blob); a.download = "marlon-backup.json"; a.click(); } catch { alert("Couldn't make the backup."); }
    } }, "Save a backup first"),
    h("button", { type: "button", class: "link-btn gate-keep", onclick: keep }, `Keep ${current}`)));
  root.hidden = false;
  return { ok: false, reason: "switch" };
}

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

/** The steps for this phone and this browser. */
function installSteps(ios) {
  const li = (t) => h("li", {}, t);
  const open = li("Open Marlon from your Home Screen.");
  switch (browserName()) {
    case "inapp": return [li(ios ? "This app's built-in browser can't add Marlon to your Home Screen." : "This app's built-in browser can't install Marlon."),
      li(ios ? "Tap the menu (⋯ or the compass) and choose “Open in Safari”." : "Tap the menu (⋮) and choose “Open in Chrome” (or “Open in browser”)."), li("Then follow the steps there.")];
    case "safari": return [li("Tap the Share button (the square with an arrow) at the bottom of Safari."), li("Choose “Add to Home Screen”, then “Add”."), open];
    case "chrome-ios": return [li("Tap the Share button (the square with an arrow) at the top right of Chrome."), li("Choose “Add to Home Screen”, then “Add”."), open];
    case "samsung": return [li("Tap the menu (☰) at the bottom right of Samsung Internet."), li("Choose “Add page to”, then “Home screen”, then “Add”."), open];
    case "firefox": return [li("Tap the menu (⋮) in Firefox."), li("Choose “Add to Home screen” (or “Install”), then “Add”."), open];
    case "edge": return [li("Tap the menu (⋯) at the bottom of Edge."), li("Choose “Add to phone”, then “Install”."), open];
    case "opera": return [li("Tap the menu (⋮) in Opera."), li("Choose “Add to” → “Home screen”, then “Add”."), open];
    default: return [li("Tap the menu (⋮) at the top right of Chrome."), li("Choose “Add to Home screen” or “Install app”, then “Install”."), open];
  }
}

/**
 * The install page: add Marlon to the Home Screen first; the personal link goes with it (the manifest's start_url).
 *   iPhone:  Safari and a Home Screen app keep separate storage, so using it in Safari too would take a second place.
 *   Android: Chrome and the installed app share storage, so "use it here" costs nothing extra.
 */
function showInstall(key, platform) {
  const manifest = document.querySelector('link[rel="manifest"]');
  if (manifest) manifest.href = `/manifest.webmanifest?k=${key}`;
  const ios = platform === "ios";
  const steps = installSteps(ios);
  const installBtn = ios ? null : h("button", { type: "button", class: "btn btn-primary btn-block gate-install", hidden: !installOffer, onclick: async () => {
    if (!installOffer) return;
    const offer = installOffer;
    installOffer = null;
    installBtn.hidden = true;
    try { await offer.prompt(); await offer.userChoice; } catch { /* dismissed */ }
  } }, "Install app");
  if (installBtn) document.addEventListener("license:installable", () => { installBtn.hidden = false; });
  const done = h("p", { class: "gate-contact", hidden: true }, "Installed. Open Marlon from your Home Screen.");
  window.addEventListener("appinstalled", () => { done.hidden = false; if (installBtn) installBtn.hidden = true; });
  root.replaceChildren(h("div", { class: "gate card", dataset: { reason: "install", platform } },
    h("p", { class: "gate-kicker" }, "Marlon"),
    h("h1", { class: "gate-title" }, "Add Marlon to your Home Screen"),
    h("p", { class: "gate-lead" }, `On ${ios ? "iPhone" : "Android"}, Marlon works from your Home Screen, even with no internet. Your personal link goes with it.`),
    installBtn,
    h("ol", { class: "gate-steps" }, steps),
    done,
    h("button", { type: "button", class: "link-btn gate-here", onclick: async () => { const r = await activate(key); if (r.ok) location.reload(); } },
      ios ? `Use it here in ${browserName() === "chrome-ios" ? "Chrome" : "Safari"} instead (this counts as one of your phones)` : "Use it here in this browser instead")));
  root.hidden = false;
  return { ok: false, reason: "install" }; // the app opens from the Home Screen (or after "use it here")
}
