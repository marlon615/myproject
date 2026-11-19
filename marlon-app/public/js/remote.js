/**
 * "Send for signature": for a buyer in another town. The seller's phone sends the invoice to the server, which
 * freezes it and makes a secret link (/s/…) that the seller shares by WhatsApp, Instagram, email or text. The buyer
 * signs on their own phone; the signed copy comes back here by itself.
 *
 *   sendForSignature(inv)  → { ok, link, remote } | { error }   freezes the invoice and opens the share sheet
 *   shareLink(inv)                                               shares the same link again (while it's valid)
 *   cancelLink(inv)        → { ok } | { error }                  so the seller can change the invoice
 *   startRemoteWatch()                                           asks for news every 20 s while the app is open
 *   checkNow()             → number of invoices that changed
 *
 * Statuses kept on each invoice (inv.remote.state): "sent" → "opened" → "signed", or "expired" after 7 days.
 * When a signed copy arrives, the invoice on this phone is replaced by exactly what the buyer signed, with their
 * signature, name and the time, and from then on it can't be changed (see invoices.put in db.js).
 * Events: "remote:changed" { ids } and "remote:signed" { inv } on document.
 */
import { invoices, settings } from "./db.js";
import { invoiceNo, signedOnText, withTotals } from "./util.js";

const EVERY = 20000;
let timer = null, running = null;

async function phone() {
  const lic = await settings.get("license", null);
  return lic?.key && lic?.device ? { key: lic.key, device: lic.device } : null;
}
async function post(path, body) {
  try {
    const res = await fetch(path, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
    return { ok: res.ok, status: res.status, data: await res.json().catch(() => ({})) };
  } catch { return { ok: false, status: 0, data: { error: "No internet connection. Sending for signature needs the internet." } }; }
}
const linkFor = (token) => `${location.origin}/s/${token}`;

/** What's still waiting for the buyer (and not past its 7 days). */
export const isWaiting = (inv) => ["sent", "opened"].includes(inv?.remote?.state) && Date.parse(inv.remote.expires) > Date.now();
export const isRemoteSigned = (inv) => inv?.remote?.state === "signed";
/** The status the dashboard shows: Sent, Opened, Signed or Expired (null if never sent). */
export function remoteStatus(inv) {
  const r = inv?.remote;
  if (!r) return null;
  if (r.state === "signed") return "signed";
  if (Date.parse(r.expires) <= Date.now()) return "expired";
  return r.state === "opened" ? "opened" : "sent";
}
export const STATUS_WORDS = { sent: "Sent", opened: "Opened", signed: "Signed", expired: "Expired" };

async function share(inv, link) {
  const title = `Invoice ${invoiceNo(inv.number)}${inv.seller ? ` from ${inv.seller}` : ""}`;
  const text = `Hi ${inv.store || ""}, please check and sign your invoice${inv.seller ? ` from ${inv.seller}` : ""} here:`.replace("Hi ,", "Hi,");
  if (navigator.share) {
    try { await navigator.share({ title, text, url: link }); return "shared"; } catch (e) { if (e?.name === "AbortError") return "cancelled"; }
  }
  try { await navigator.clipboard.writeText(`${text} ${link}`); return "copied"; } catch { return "shown"; }
}

/** Freezes the invoice on the server and opens the share sheet with the new link. */
export async function sendForSignature(inv) {
  const t = withTotals(inv);
  if (!t.store) return { error: "Add the buyer's name first." };
  if (!t.items.length) return { error: "Add at least one item first." };
  if (t.items.some((it) => it.price === null || !(it.qty > 0))) return { error: "Every item needs a quantity and a price before it can be sent." };
  const p = await phone();
  if (!p) return { error: "This phone isn't set up for sending yet. Open Marlon from your personal link once." };
  const r = await post("/api/sign/create", { ...p, invoice: { id: t.id, number: t.number, date: t.date, seller: t.seller, sellerAddress: t.sellerAddress, sellerPhone: t.sellerPhone, store: t.store, address: t.address, items: t.items } });
  if (!r.ok) return { error: r.data.error || "That didn't send. Please try again." };
  const link = linkFor(r.data.token);
  const remote = { state: "sent", link, sentAt: new Date().toISOString(), openedAt: null, expires: r.data.expires, digest: r.data.digest };
  const saved = await invoices.put({ ...inv, remote });
  const how = await share(saved, link);
  startRemoteWatch();
  return { ok: true, link, remote, inv: saved, how };
}

export async function shareLink(inv) { return isWaiting(inv) ? share(inv, inv.remote.link) : "expired"; }

/** Cancels a link that hasn't been signed, so the invoice can be changed (the buyer then needs a new link). */
export async function cancelLink(inv) {
  const p = await phone();
  if (!p) return { error: "This phone isn't set up for sending." };
  const r = await post("/api/sign/cancel", { ...p, invoiceId: inv.id });
  if (!r.ok) { if (r.status === 409) await checkNow(); return { error: r.data.error || "Couldn't cancel the link. Check the internet and try again." }; }
  const saved = await invoices.put({ ...inv, remote: null });
  return { ok: true, inv: saved };
}

/** A signed copy from the server: exactly what the buyer signed replaces the invoice here, then it's locked. */
async function applySigned(inv, s) {
  const signed = s.invoice;
  const items = signed.items.map((it, i) => ({ ...it, productId: inv.items?.[i]?.name === it.name ? inv.items[i].productId ?? null : null }));
  return invoices.put({ ...inv, id: inv.id, number: inv.number, date: signed.date, seller: signed.seller, sellerAddress: signed.sellerAddress, sellerPhone: signed.sellerPhone,
    store: signed.store, address: signed.address, items, signature: s.signature, signedAt: s.signedAt, signerName: s.signer,
    remote: { ...(inv.remote || {}), state: "signed", openedAt: s.openedAt || inv.remote?.openedAt || null, signedAt: s.signedAt, digest: s.digest } });
}

function notify(inv) {
  const body = `Signed by ${inv.signerName} on ${signedOnText(inv.signedAt)}`;
  const title = `Invoice ${invoiceNo(inv.number)} signed`;
  try {
    if (typeof Notification !== "undefined" && Notification.permission === "granted") {
      navigator.serviceWorker?.getRegistration().then((reg) => (reg ? reg.showNotification(title, { body, tag: `signed-${inv.id}`, icon: "/icons/icon-192.png" }) : new Notification(title, { body }))).catch(() => {});
    }
  } catch { /* notifications not available */ }
  navigator.vibrate?.([30, 60, 30]);
}

/** Asks the server about everything this phone sent; applies new statuses and signed copies. */
export async function checkNow() {
  if (running) return running;
  running = (async () => {
    const p = await phone();
    if (!p || navigator.onLine === false) return 0;
    const all = await invoices.all();
    const sent = all.filter((i) => i.remote && i.remote.state !== "signed");
    const ackKey = "remoteAck", ack = (await settings.get(ackKey, [])) || [];
    if (!sent.length && !ack.length) { stop(); return 0; }
    const r = await post("/api/sign/status", { ...p, ack });
    if (!r.ok) return 0;
    if (ack.length) await settings.set(ackKey, []);
    const byId = new Map(all.map((i) => [i.id, i]));
    const changed = [], newAck = [];
    for (const l of r.data.links || []) {
      const inv = byId.get(l.invoiceId);
      if (!inv?.remote) continue;
      if (l.state === "signed") {
        if (inv.remote.state !== "signed") {
          const saved = await applySigned(inv, l);
          changed.push(saved.id);
          notify(saved);
          document.dispatchEvent(new CustomEvent("remote:signed", { detail: { inv: saved } }));
        }
        newAck.push(l.invoiceId);
        continue;
      }
      const state = l.state === "opened" ? "opened" : l.state === "sent" ? "sent" : l.state === "expired" ? "expired" : null;
      if (state && (inv.remote.state !== state || inv.remote.openedAt !== (l.openedAt || null))) {
        await invoices.put({ ...inv, remote: { ...inv.remote, state, openedAt: l.openedAt || null } });
        changed.push(inv.id);
      }
    }
    if (newAck.length) await settings.set(ackKey, newAck); // the server stops sending them once it hears they arrived
    if (changed.length) document.dispatchEvent(new CustomEvent("remote:changed", { detail: { ids: changed } }));
    return changed.length;
  })().finally(() => { running = null; });
  return running;
}

// ── Alerts when Marlon is closed (web push) ──────────────────────────────────────────────────────────────
// iPhone: only for Marlon added to the Home Screen (iOS 16.4 or later). The permission prompt must come from a tap.
export const pushSupported = () => typeof window !== "undefined" && "serviceWorker" in navigator && "PushManager" in window && typeof Notification !== "undefined";
let pushKeyP = null;
const pushKey = () => (pushKeyP ||= fetch("/api/push/key").then((r) => (r.ok ? r.json() : null)).then((d) => d?.key || null).catch(() => null).then((k) => { if (!k) pushKeyP = null; return k; }));
const unb64url = (s) => Uint8Array.from(atob(s.replace(/-/g, "+").replace(/_/g, "/") + "===".slice((s.length + 3) % 4)), (c) => c.charCodeAt(0));
const sameKey = (sub, key) => { const a = sub?.options?.applicationServerKey; if (!a) return true; const x = new Uint8Array(a), y = unb64url(key); return x.length === y.length && x.every((v, i) => v === y[i]); };

/** "unsupported" | "denied" | "off" | "on" */
export async function pushState() {
  if (!pushSupported()) return "unsupported";
  if (Notification.permission === "denied") return "denied";
  if (Notification.permission !== "granted") return "off";
  const reg = await navigator.serviceWorker.getRegistration();
  return (await reg?.pushManager.getSubscription()) ? "on" : "off";
}
async function saveSub(sub) {
  const p = await phone();
  if (!p) return { error: "This phone isn't set up for alerts yet." };
  const r = await post("/api/push/subscribe", { ...p, subscription: sub.toJSON() });
  return r.ok ? { ok: true } : { error: r.data.error || "Couldn't turn on alerts. Check the internet and try again." };
}
async function subscription(key) {
  const reg = await navigator.serviceWorker.ready;
  let sub = await reg.pushManager.getSubscription();
  if (sub && !sameKey(sub, key)) { await sub.unsubscribe().catch(() => {}); sub = null; } // the server's key changed
  return sub || reg.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: unb64url(key) });
}
/** From a tap: asks permission, subscribes this phone, and tells the server. */
export async function enablePush() {
  if (!pushSupported()) return { error: "This phone can't show alerts from Marlon. On iPhone, open Marlon from its Home Screen icon (iOS 16.4 or later)." };
  const keyReady = pushKey();
  const perm = await Notification.requestPermission();
  if (perm !== "granted") return { error: perm === "denied" ? "Alerts are blocked for Marlon. Turn them on in your phone's settings, then try again." : "Alerts weren't turned on." };
  const key = await keyReady;
  if (!key) return { error: "Couldn't reach the server. Check the internet and try again." };
  try { return await saveSub(await subscription(key)); } catch (e) { console.error(e); return { error: "This phone couldn't turn on alerts. Please try again." }; }
}
/** On every open: keeps the server's copy of this phone's subscription up to date (it can change). */
export async function syncPush() {
  try {
    if ((await pushState()) !== "on") return;
    const key = await pushKey();
    if (key) await saveSub(await subscription(key));
  } catch { /* try again next time */ }
}
if (typeof navigator !== "undefined" && navigator.serviceWorker) navigator.serviceWorker.addEventListener("message", (e) => { if (e.data?.type === "remote-check") { startRemoteWatch(); checkNow(); } });

function stop() { clearInterval(timer); timer = null; }
let synced = false;
export function startRemoteWatch() {
  if (!synced) { synced = true; syncPush(); }
  if (timer) return;
  timer = setInterval(() => { if (document.visibilityState === "visible") checkNow(); }, EVERY);
  checkNow();
}
document.addEventListener("visibilitychange", () => { if (document.visibilityState === "visible" && timer) checkNow(); });
window.addEventListener("online", () => { if (timer) checkNow(); });
