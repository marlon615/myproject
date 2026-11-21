/**
 * Marlon Pay's storage on this device (IndexedDB). Everything is saved here first, so it works with no signal.
 *
 *   suppliers { id, name, phone, notes, archived, updatedAt, dirty }       (dirty: not sent to the server yet)
 *   payouts   { id, supplierId, supplierName, date, invoiceNo, amountCents, staffName, signedAt, signature, fromMarlon,
 *               synced, rejected, receivedAt }
 *             A payout is a SIGNED record: it can only be created, never changed or deleted. The only thing that ever
 *             changes afterwards is whether the server has it (synced) or refused it (rejected, kept and flagged).
 *   notes     { id, payoutId, text, createdAt, synced }   owner's dated corrections, added to a payout, never changed
 *   meta      { key, value }   license, device id, sync cursor
 */
const DB = "marlon-pay", VERSION = 1;
let dbp = null;
function open() {
  return (dbp ||= new Promise((resolve, reject) => {
    if (!("indexedDB" in self)) return reject(new Error("This browser can't save data. Open Marlon Pay in Safari or Chrome."));
    const req = indexedDB.open(DB, VERSION);
    req.onupgradeneeded = () => {
      const db = req.result;
      for (const s of ["suppliers", "payouts", "notes"]) if (!db.objectStoreNames.contains(s)) db.createObjectStore(s, { keyPath: "id" });
      if (!db.objectStoreNames.contains("meta")) db.createObjectStore("meta", { keyPath: "key" });
    };
    req.onsuccess = () => { req.result.onversionchange = () => { req.result.close(); dbp = null; }; resolve(req.result); };
    req.onerror = () => { dbp = null; reject(req.error); };
  }));
}
const done = (r) => new Promise((ok, no) => { r.onsuccess = () => ok(r.result); r.onerror = () => no(r.error); });
async function run(names, mode, fn) {
  const db = await open();
  return new Promise((resolve, reject) => {
    const t = db.transaction(names, mode);
    const s = Object.fromEntries([].concat(names).map((n) => [n, t.objectStore(n)]));
    let out;
    t.oncomplete = () => resolve(out);
    t.onerror = () => reject(t.error);
    t.onabort = () => reject(t.error || new Error("Couldn't save on this device."));
    Promise.resolve(fn(s)).then((r) => { out = r; }, (e) => { try { t.abort(); } catch {} reject(e); });
  });
}
const nowISO = () => new Date().toISOString();

export const meta = {
  async get(key, fallback = null) { const r = await run("meta", "readonly", (s) => done(s.meta.get(key))); return r ? r.value : fallback; },
  async set(key, value) { await run("meta", "readwrite", (s) => done(s.meta.put({ key, value }))); return value; },
};

export const suppliers = {
  async all() { return (await run("suppliers", "readonly", (s) => done(s.suppliers.getAll()))).sort((a, b) => a.name.localeCompare(b.name)); },
  async get(id) { return (await run("suppliers", "readonly", (s) => done(s.suppliers.get(id)))) || null; },
  /** Add or change a supplier on this device (sent to the server with the next sync). */
  async save(sup) {
    const rec = { ...sup, updatedAt: nowISO(), dirty: true };
    await run("suppliers", "readwrite", (s) => done(s.suppliers.put(rec)));
    return rec;
  },
  async markSent(ids) { await run("suppliers", "readwrite", async (s) => { for (const id of ids) { const r = await done(s.suppliers.get(id)); if (r?.dirty) { r.dirty = false; await done(s.suppliers.put(r)); } } }); },
  /** The server's copy wins unless this device has a newer change still waiting to be sent. */
  async merge(list) {
    await run("suppliers", "readwrite", async (s) => {
      for (const sv of list) {
        const cur = await done(s.suppliers.get(sv.id));
        if (cur?.dirty && cur.updatedAt > sv.updatedAt) continue;
        await done(s.suppliers.put({ ...sv, dirty: false }));
      }
    });
  },
};

export const payouts = {
  async all() { return (await run("payouts", "readonly", (s) => done(s.payouts.getAll()))).sort((a, b) => (b.signedAt || "").localeCompare(a.signedAt || "")); },
  async get(id) { return (await run("payouts", "readonly", (s) => done(s.payouts.get(id)))) || null; },
  /** A new signed record. It can never be changed or deleted afterwards. */
  async create(p) {
    if (!p.signature || !p.signedAt) throw new Error("The supplier needs to sign first.");
    return run("payouts", "readwrite", async (s) => {
      if (await done(s.payouts.get(p.id))) throw new Error("This record is already saved and locked.");
      const rec = { ...p, synced: false, rejected: null };
      await done(s.payouts.add(rec));
      return rec;
    });
  },
  /** The server has it (or refused it): only the sync state changes, never the record. */
  async markSync(results) {
    await run("payouts", "readwrite", async (s) => {
      for (const { id, synced, rejected } of results) {
        const r = await done(s.payouts.get(id));
        if (!r) continue;
        await done(s.payouts.put({ ...r, synced: Boolean(synced), rejected: rejected || null }));
      }
    });
  },
  /** Records made on the store's other devices (owner): added if missing, never replacing one already here. */
  async merge(list) {
    await run("payouts", "readwrite", async (s) => {
      for (const p of list) {
        const cur = await done(s.payouts.get(p.id));
        if (cur) { if (!cur.synced) await done(s.payouts.put({ ...cur, synced: true, receivedAt: p.receivedAt })); continue; }
        await done(s.payouts.add({ ...p, signature: null, synced: true, rejected: null, fromServer: true }));
      }
    });
  },
  /** A signature fetched from the server for a record made on another device (display only; the record is unchanged). */
  async cacheSignature(id, signature) {
    await run("payouts", "readwrite", async (s) => { const r = await done(s.payouts.get(id)); if (r && !r.signature) await done(s.payouts.put({ ...r, signature })); });
  },
};

export const notes = {
  async all() { return (await run("notes", "readonly", (s) => done(s.notes.getAll()))).sort((a, b) => (a.createdAt || "").localeCompare(b.createdAt || "")); },
  async add(payoutId, text) {
    const n = { id: `nt_${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`, payoutId, text, createdAt: nowISO(), synced: false };
    await run("notes", "readwrite", (s) => done(s.notes.add(n)));
    return n;
  },
  async markSent(ids) { await run("notes", "readwrite", async (s) => { for (const id of ids) { const r = await done(s.notes.get(id)); if (r) await done(s.notes.put({ ...r, synced: true })); } }); },
  async merge(list) { await run("notes", "readwrite", async (s) => { for (const n of list) await done(s.notes.put({ ...n, synced: true })); }); },
};

/** Ask the browser to keep this app's data even when space runs low. */
export async function keepData() { try { return navigator.storage?.persist ? await navigator.storage.persist() : false; } catch { return false; } }
