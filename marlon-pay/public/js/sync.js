/**
 * Sends this device's new records to the store and brings back what changed (suppliers for everyone; every record and
 * correction note for the owner). Records stay on the device until the server confirms them, and are never removed
 * after that either: nothing is lost if the signal drops or the app closes. Runs when the app opens, every 15 seconds
 * while it's open and online, when the signal comes back, and right after anything is saved.
 */
import { meta, notes, payouts, suppliers } from "./db.js";

let running = null, timer = null, listener = () => {};
export const onSync = (fn) => { listener = fn; };

export async function waitingCount() {
  const [p, s, n] = await Promise.all([payouts.all(), suppliers.all(), notes.all()]);
  return p.filter((x) => !x.synced && !x.rejected).length + s.filter((x) => x.dirty).length + n.filter((x) => !x.synced).length;
}

export function syncNow() {
  if (running) return running;
  running = (async () => {
    const lic = await meta.get("license");
    if (!lic || navigator.onLine === false) return { ok: false, offline: true };
    let rounds = 0, last = { ok: true };
    while (rounds++ < 30) {
      const [allP, allS, allN] = await Promise.all([payouts.all(), suppliers.all(), notes.all()]);
      const sendP = allP.filter((p) => !p.synced && !p.rejected && p.signature).slice(0, 15);
      const sendS = allS.filter((s) => s.dirty).slice(0, 200);
      const sendN = allN.filter((n) => !n.synced).slice(0, 50);
      let res;
      try {
        res = await fetch("/api/sync", { method: "POST", cache: "no-store", headers: { "content-type": "application/json" },
          body: JSON.stringify({ key: lic.key, device: lic.device, cursor: await meta.get("cursor", 0),
            suppliers: sendS.map(({ dirty, ...s }) => s), notes: sendN.map(({ synced, ...n }) => n),
            payouts: sendP.map(({ synced, rejected, receivedAt, fromServer, ...p }) => p) }) });
      } catch { return { ok: false, offline: true }; }
      const data = await res.json().catch(() => ({}));
      if (!res.ok) { last = { ok: false, status: res.status, reason: data.reason, error: data.error }; break; }
      await payouts.markSync([...data.stored.payouts.map((id) => ({ id, synced: true })), ...data.rejected.payouts.map((r) => ({ id: r.id, synced: false, rejected: r.reason }))]);
      await suppliers.markSent(data.stored.suppliers);
      await notes.markSent(data.stored.notes);
      await suppliers.merge(data.changes.suppliers);
      await payouts.merge(data.changes.payouts);
      await notes.merge(data.changes.notes);
      await meta.set("cursor", data.cursor);
      await meta.set("lastSync", new Date().toISOString());
      if (data.store?.name && data.store.name !== lic.storeName) await meta.set("license", { ...lic, storeName: data.store.name });
      last = { ok: true };
      if (sendP.length < 15 && sendS.length < 200 && sendN.length < 50) break; // nothing more waiting
    }
    return last;
  })().finally(async () => { running = null; listener(await waitingCount().catch(() => 0)); });
  return running;
}

export function startSync() {
  const kick = () => { if (document.visibilityState !== "hidden") syncNow().then((r) => { if (r?.reason) document.dispatchEvent(new CustomEvent("pay:blocked", { detail: r })); }); };
  kick();
  clearInterval(timer);
  timer = setInterval(kick, 15000);
  window.addEventListener("online", kick);
  document.addEventListener("visibilitychange", kick);
  window.__paySync = () => syncNow(); // (used by the tests)
}
