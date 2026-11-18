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
  if (typeof Notification !== "undefined" && Notification.permission === "default") Notification.requestPermission().catch(() => {}); // to hear when it's signed
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

function stop() { clearInterval(timer); timer = null; }
export function startRemoteWatch() {
  if (timer) return;
  timer = setInterval(() => { if (document.visibilityState === "visible") checkNow(); }, EVERY);
  checkNow();
}
document.addEventListener("visibilitychange", () => { if (document.visibilityState === "visible" && timer) checkNow(); });
window.addEventListener("online", () => { if (timer) checkNow(); });
