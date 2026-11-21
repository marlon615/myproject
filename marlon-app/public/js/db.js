/**
 * On-phone storage (IndexedDB). Everything stays on this device; nothing is ever uploaded.
 *
 * Stores:
 *   products  { id, name, order, custom, hidden, createdAt }   (prices live on invoices only)
 *   invoices  { id, number, seller, store, address, date, items[], total, signature, signedAt, createdAt, updatedAt, payment?, remote?, signerName? }
 *             remote (sent for signature): { state: "sent"|"opened"|"signed"|"expired", link, sentAt, openedAt, expires, signedAt }
 *             Once remote.state is "signed", put() never changes the invoice again (only its payment).
 *             payment (owner only, never on the customer's copies):
 *             { status: "paid" | "unpaid", method: "cash" | "terms", termsDays: 0 | 7 | 14, dueDate: "YYYY-MM-DD" | null,
 *               recordedAt, paidAt: ISO | null }
 *   settings  { key, value }
 *   credits   (Marlon Pro: returns) { id, number, store, address, date, lines[{ productId, name, qty, unit, price, total, reason }],
 *             total, signature, signerName, signedAt, createdAt, updatedAt, appliedTo: { invoiceId: { amount, number } } }
 *             A credit note's amount comes off that store's next invoice(s) automatically: invoices.put() works out, in
 *             the same transaction, which credit notes an unsigned invoice uses (oldest first, never more than its
 *             subtotal) and records it on both. A signed (or sent-for-signature) invoice keeps the credit it had.
 *             Deleting an invoice gives its credit back.
 *   orders    (Marlon Pro: shelf orders) { id, number, store, address, date, lines[{ productId, name, unit, onShelf, target, qty }],
 *             signerName, signature, signedAt, status: "pending"|"delivered"|"cancelled", deliveredAt, cancelledAt,
 *             invoiceId, invoiceNumber, shelfCheckId, createdAt, updatedAt }
 *             Numbered ORD-0001, ORD-0002… on this phone. The store person who orders types their name and signs.
 */
import { allocateCredit, parseAmount, normalizeUnit, storeKey, tidy, toCents, uid, withTotals } from "./util.js";

const DB_NAME = "marlon-invoices";
const DB_VERSION = 3; // 2: + credits (Marlon Pro returns). 3: + orders (Marlon Pro shelf orders). Upgrading keeps everything already saved.
let dbPromise = null;

function openDb() {
  if (dbPromise) return dbPromise;
  dbPromise = new Promise((resolve, reject) => {
    if (!("indexedDB" in self)) return reject(new Error("This browser can't save data. Open the app in Safari or Chrome."));
    const req = indexedDB.open(DB_NAME, DB_VERSION);
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains("products")) db.createObjectStore("products", { keyPath: "id" });
      if (!db.objectStoreNames.contains("invoices")) {
        const s = db.createObjectStore("invoices", { keyPath: "id" });
        s.createIndex("date", "date");
        s.createIndex("number", "number");
      }
      if (!db.objectStoreNames.contains("settings")) db.createObjectStore("settings", { keyPath: "key" });
      if (!db.objectStoreNames.contains("credits")) db.createObjectStore("credits", { keyPath: "id" }).createIndex("date", "date");
      if (!db.objectStoreNames.contains("orders")) db.createObjectStore("orders", { keyPath: "id" }).createIndex("date", "date");
    };
    req.onsuccess = () => {
      const db = req.result;
      db.onversionchange = () => { db.close(); dbPromise = null; };
      resolve(db);
    };
    req.onerror = () => { dbPromise = null; reject(req.error || new Error("Could not open storage")); };
    req.onblocked = () => { dbPromise = null; reject(new Error("Storage is busy. Close other copies of this app and try again.")); };
  });
  return dbPromise;
}

const done = (req) => new Promise((resolve, reject) => { req.onsuccess = () => resolve(req.result); req.onerror = () => reject(req.error); });

/** Runs fn(stores) inside one transaction and resolves with fn's result once the transaction commits. */
async function run(names, mode, fn) {
  const db = await openDb();
  return new Promise((resolve, reject) => {
    const t = db.transaction(names, mode);
    const stores = Object.fromEntries([].concat(names).map((n) => [n, t.objectStore(n)]));
    let result;
    t.oncomplete = () => resolve(result);
    t.onerror = () => reject(t.error || new Error("Storage error"));
    t.onabort = () => reject(t.error || new Error("Storage write was cancelled"));
    Promise.resolve(fn(stores)).then((r) => { result = r; }, (e) => { try { t.abort(); } catch {} reject(e); });
  });
}

const nowISO = () => new Date().toISOString();

// ── Settings ────────────────────────────────────────────────────────────

export const settings = {
  async get(key, fallback = null) {
    const row = await run("settings", "readonly", (s) => done(s.settings.get(key)));
    return row ? row.value : fallback;
  },
  async set(key, value) {
    await run("settings", "readwrite", (s) => done(s.settings.put({ key, value })));
    return value;
  },
  async remove(key) {
    await run("settings", "readwrite", (s) => done(s.settings.delete(key)));
  },
  async all() {
    const rows = await run("settings", "readonly", (s) => done(s.settings.getAll()));
    return Object.fromEntries(rows.map((r) => [r.key, r.value]));
  },
};

// ── Products ────────────────────────────────────────────────────────────

const byOrder = (a, b) => (a.order ?? 0) - (b.order ?? 0) || a.name.localeCompare(b.name);

export const products = {
  /** Products in list order. Hidden (removed) products are left out unless includeHidden. */
  async all({ includeHidden = false } = {}) {
    const rows = await run("products", "readonly", (s) => done(s.products.getAll()));
    return rows.filter((p) => includeHidden || !p.hidden).sort(byOrder);
  },
  async get(id) {
    return (await run("products", "readonly", (s) => done(s.products.get(id)))) || null;
  },
  async put(p) {
    await run("products", "readwrite", (s) => done(s.products.put(p)));
    return p;
  },
  /**
   * Adds a product at the end of the list. If a product with the same name exists, it is
   * un-hidden and returned instead of creating a duplicate.
   */
  async add(name, { price = null, unit = "each" } = {}) {
    const clean = tidy(name).replace(/\n/g, " ");
    if (!clean) throw new Error("Type a product name first.");
    return run("products", "readwrite", async (s) => {
      const rows = await done(s.products.getAll());
      const same = rows.find((p) => p.name.toLowerCase() === clean.toLowerCase());
      if (same) {
        if (same.hidden) { same.hidden = false; await done(s.products.put(same)); }
        return same;
      }
      const order = rows.reduce((m, p) => Math.max(m, p.order ?? 0), 0) + 1;
      const p = { id: uid("c_"), name: clean, order, custom: true, hidden: false, createdAt: nowISO(), price: parseAmount(price), unit: normalizeUnit(unit) };
      await done(s.products.put(p));
      return p;
    });
  },
  /** Changes a product's name, price (null = none) and/or unit. */
  async update(id, { name, price, unit } = {}) {
    const p = await products.get(id);
    if (!p) throw new Error("That product no longer exists.");
    if (name !== undefined) {
      const clean = tidy(name).replace(/\n/g, " ");
      if (!clean) throw new Error("Type a product name first.");
      p.name = clean;
    }
    if (price !== undefined) p.price = parseAmount(price);
    if (unit !== undefined) p.unit = normalizeUnit(unit);
    return products.put(p);
  },
  async rename(id, name) {
    const clean = tidy(name).replace(/\n/g, " ");
    if (!clean) throw new Error("Type a product name first.");
    const p = await products.get(id);
    if (!p) throw new Error("That product no longer exists.");
    p.name = clean;
    return products.put(p);
  },
  /** Removes a product from the list (kept in storage so old invoices are unaffected). */
  async hide(id) {
    const p = await products.get(id);
    if (p) { p.hidden = true; await products.put(p); }
  },
  async unhide(id) {
    const p = await products.get(id);
    if (p) { p.hidden = false; await products.put(p); }
  },
  /** Moves a product one place up (-1) or down (+1) among visible products. */
  async move(id, dir) {
    const list = await products.all();
    const i = list.findIndex((p) => p.id === id), j = i + dir;
    if (i < 0 || j < 0 || j >= list.length) return;
    const a = list[i], b = list[j];
    [a.order, b.order] = [b.order, a.order];
    await run("products", "readwrite", async (s) => { await done(s.products.put(a)); await done(s.products.put(b)); });
  },
};

// ── Invoices ────────────────────────────────────────────────────────────

const newestFirst = (a, b) => (b.date || "").localeCompare(a.date || "") || (b.number || 0) - (a.number || 0) || (b.createdAt || "").localeCompare(a.createdAt || "");

export const invoices = {
  /** All saved invoices, newest first (by invoice date, then number). */
  async all() {
    const rows = await run("invoices", "readonly", (s) => done(s.invoices.getAll()));
    return rows.sort(newestFirst);
  },
  async get(id) {
    return (await run("invoices", "readonly", (s) => done(s.invoices.get(id)))) || null;
  },
  /**
   * Saves an invoice (totals are recomputed). The first save of an invoice without a number
   * claims the next invoice number in the same transaction. Resolves with the saved invoice.
   * A payment already recorded on the invoice is kept unless `inv` brings its own (the invoice screen never does).
   */
  async put(inv) {
    const clean = withTotals({ ...inv });
    clean.store = tidy(clean.store).replace(/\n/g, " ");
    clean.address = tidy(clean.address);
    clean.updatedAt = nowISO();
    clean.createdAt = clean.createdAt || clean.updatedAt;
    if (!clean.id) clean.id = uid("inv_");
    return run(["invoices", "settings", "credits"], "readwrite", async (s) => {
      const old = await done(s.invoices.get(clean.id));
      if (!("payment" in inv) && old?.payment) clean.payment = old.payment;
      // Signed by the buyer through a link: the invoice is locked for good. Only the private payment status may change.
      if (old?.remote?.state === "signed") {
        const locked = { ...old, payment: clean.payment ?? old.payment, updatedAt: clean.updatedAt };
        await done(s.invoices.put(locked));
        return locked;
      }
      if (!clean.number) {
        const row = await done(s.settings.get("nextNumber"));
        const n = Math.max(1, Number(row?.value) || 1);
        clean.number = n;
        await done(s.settings.put({ key: "nextNumber", value: n + 1 }));
      }
      const withCredit = await applyCredits(s, clean, old);
      await done(s.invoices.put(withCredit));
      return withCredit;
    });
  },
  async remove(id) {
    await run(["invoices", "credits"], "readwrite", async (s) => {
      await done(s.invoices.delete(id));
      for (const cn of await done(s.credits.getAll())) { // its credit goes back to the credit note(s)
        if (cn.appliedTo?.[id]) { delete cn.appliedTo[id]; cn.updatedAt = nowISO(); await done(s.credits.put(cn)); }
      }
    });
  },
  /**
   * Records how this one invoice is being paid (each invoice is separate, with its own due date), or changes it,
   * e.g. to paid when the money comes in. `payment` null removes it. Resolves with the saved invoice.
   */
  async setPayment(id, payment) {
    return run("invoices", "readwrite", async (s) => {
      const inv = await done(s.invoices.get(id));
      if (!inv) throw new Error("That invoice no longer exists.");
      if (payment) inv.payment = { ...payment };
      else delete inv.payment;
      inv.updatedAt = nowISO();
      await done(s.invoices.put(inv));
      return inv;
    });
  },
  /** The number the next new invoice will get (for display before its first save). */
  async peekNextNumber() {
    return Math.max(1, Number(await settings.get("nextNumber", 1)) || 1);
  },
  /** Stores seen on past invoices, most recent first: [{ name, address, lastDate, count }]. */
  async knownStores() {
    const map = new Map();
    for (const inv of await invoices.all()) {
      const k = storeKey(inv.store);
      if (!k) continue;
      const cur = map.get(k);
      if (!cur) map.set(k, { name: inv.store, address: inv.address || "", lastDate: inv.date, count: 1 });
      else { cur.count++; if (!cur.address && inv.address) cur.address = inv.address; }
    }
    return [...map.values()];
  },
};

// ── Credit notes (Marlon Pro: returns) ──────────────────────────────────

/** What's left on a credit note, in whole cents (optionally not counting what one invoice uses). */
const creditLeftCents = (cn, exceptInvoice = null) =>
  toCents(cn.total) - Object.entries(cn.appliedTo || {}).reduce((t, [inv, a]) => t + (inv === exceptInvoice ? 0 : toCents(a.amount)), 0);

/**
 * Credit notes of this store with something left (not counting what `invoiceId` already uses), oldest first. Only the
 * store's NEXT invoices: a credit note never goes onto an invoice dated before it (unless that invoice already uses it).
 */
function availableCredit(all, store, invoiceId, invoiceDate = null) {
  const key = storeKey(store);
  if (!key) return [];
  return all.filter((cn) => storeKey(cn.store) === key && (!invoiceDate || (cn.date || "") <= invoiceDate || cn.appliedTo?.[invoiceId]))
    .sort((a, b) => (a.createdAt || "").localeCompare(b.createdAt || "") || (a.number || 0) - (b.number || 0))
    .map((cn) => ({ id: cn.id, number: cn.number, left: creditLeftCents(cn, invoiceId) / 100 }))
    .filter((c) => c.left > 0);
}

/**
 * Inside invoices.put's transaction: which credit notes this invoice uses. A signed invoice, one waiting on a
 * signature link, or one already marked paid keeps exactly the credit it had (what the customer saw doesn't change).
 */
async function applyCredits(s, clean, old) {
  const all = await done(s.credits.getAll());
  if (!all.length && !clean.credit) return clean;
  const frozen = old && (old.signature || ["sent", "opened"].includes(old.remote?.state) || old.payment?.status === "paid");
  if (frozen) return withTotals({ ...clean, credit: old.credit || null });
  const subtotal = withTotals({ ...clean, credit: null }).total;
  const credit = clean.items.length ? allocateCredit(availableCredit(all, clean.store, clean.id, clean.date), subtotal) : null;
  for (const cn of all) {
    const had = cn.appliedTo?.[clean.id];
    const use = credit?.notes.find((n) => n.id === cn.id);
    if (!had && !use) continue;
    if (had && use && toCents(had.amount) === toCents(use.amount) && had.number === clean.number) continue;
    cn.appliedTo = { ...(cn.appliedTo || {}) };
    if (use) cn.appliedTo[clean.id] = { amount: use.amount, number: clean.number };
    else delete cn.appliedTo[clean.id];
    cn.updatedAt = nowISO();
    await done(s.credits.put(cn));
  }
  return withTotals({ ...clean, credit });
}

export const credits = {
  /** All credit notes, newest first. */
  async all() {
    const rows = await run("credits", "readonly", (s) => done(s.credits.getAll()));
    return rows.sort((a, b) => (b.date || "").localeCompare(a.date || "") || (b.number || 0) - (a.number || 0));
  },
  async get(id) { return (await run("credits", "readonly", (s) => done(s.credits.get(id)))) || null; },
  /** Credit notes this store still has credit on for an invoice dated `date` (not counting what `invoiceId` uses): [{ id, number, left }]. */
  async availableFor(store, invoiceId = null, date = null) {
    if (!storeKey(store)) return [];
    return availableCredit(await run("credits", "readonly", (s) => done(s.credits.getAll())), store, invoiceId, date);
  },
  /** What's left on a credit note, in dollars. */
  left: (cn) => Math.max(0, creditLeftCents(cn)) / 100,
  /**
   * A new numbered credit note (CN-0001, CN-0002… on this phone). lines: [{ productId, name, qty, unit, price, reason }].
   * The store's signature is required. Resolves with the saved credit note.
   */
  async create({ store, address = "", date, lines, signature, signerName = "" }) {
    const clean = tidy(store).replace(/\n/g, " ");
    if (!clean) throw new Error("Type the store's name first.");
    const items = (lines || []).map((l) => ({ productId: l.productId ?? null, name: tidy(l.name).replace(/\n/g, " "), qty: parseAmount(l.qty), unit: normalizeUnit(l.unit),
      price: parseAmount(l.price), reason: l.reason === "damaged" ? "damaged" : "expired" })).filter((l) => l.name && l.qty > 0);
    if (!items.length) throw new Error("Add at least one returned product with its quantity.");
    if (items.some((l) => l.price === null)) throw new Error("Every returned product needs a price, so the credit can be worked out.");
    if (!signature) throw new Error("The store needs to sign first.");
    const t = withTotals({ items });
    const at = nowISO();
    return run(["credits", "settings"], "readwrite", async (s) => {
      const row = await done(s.settings.get("nextCreditNumber"));
      const number = Math.max(1, Number(row?.value) || 1);
      await done(s.settings.put({ key: "nextCreditNumber", value: number + 1 }));
      const cn = { id: uid("cn_"), number, store: clean, address: tidy(address), date: date || at.slice(0, 10),
        lines: t.items.map((it, i) => ({ ...it, reason: items[i].reason })), total: t.total,
        signature, signerName: tidy(signerName).replace(/\n/g, " ").slice(0, 80), signedAt: at, createdAt: at, updatedAt: at, appliedTo: {} };
      await done(s.credits.put(cn));
      return cn;
    });
  },
};

// ── Marlon Pro: shelf orders ────────────────────────────────────────────

const ORDER_STATUSES = new Set(["pending", "delivered", "cancelled"]);
/** What to order: the target minus what's on the shelf, never below nothing. */
export const orderQty = (target, onShelf) => {
  const t = parseAmount(target), o = parseAmount(onShelf) || 0;
  return t === null ? null : Math.max(0, Math.round((t - o) * 1000) / 1000);
};

export const orders = {
  /** All shelf orders, newest first. */
  async all() {
    const rows = await run("orders", "readonly", (s) => done(s.orders.getAll()));
    return rows.sort((a, b) => (b.createdAt || "").localeCompare(a.createdAt || "") || (b.number || 0) - (a.number || 0));
  },
  async get(id) { return (await run("orders", "readonly", (s) => done(s.orders.get(id)))) || null; },
  /**
   * A new numbered order (ORD-0001, ORD-0002… on this phone), status Pending.
   * lines: [{ productId, name, unit, onShelf, target, qty }] — lines ordering nothing are left out.
   * The store person's name and signature are both required.
   */
  async create({ store, address = "", lines, signature, signerName, shelfCheckId = null }) {
    const clean = tidy(store).replace(/\n/g, " ");
    if (!clean) throw new Error("Type the store's name first.");
    const name = tidy(signerName).replace(/\n/g, " ").slice(0, 80);
    if (!name) throw new Error("The person placing the order types their name first.");
    if (!signature) throw new Error("The person placing the order needs to sign first.");
    const items = (lines || []).map((l) => ({ productId: l.productId ?? null, name: tidy(l.name).replace(/\n/g, " ").slice(0, 80), unit: normalizeUnit(l.unit),
      onShelf: parseAmount(l.onShelf) ?? 0, target: parseAmount(l.target), qty: parseAmount(l.qty) })).filter((l) => l.name && l.qty > 0);
    if (!items.length) throw new Error("Order at least one product (an amount above 0).");
    const at = nowISO();
    return run(["orders", "settings"], "readwrite", async (s) => {
      const row = await done(s.settings.get("nextOrderNumber"));
      const number = Math.max(1, Number(row?.value) || 1);
      await done(s.settings.put({ key: "nextOrderNumber", value: number + 1 }));
      const o = { id: uid("or_"), number, store: clean, address: tidy(address), date: at.slice(0, 10), lines: items, signerName: name, signature, signedAt: at,
        status: "pending", deliveredAt: null, cancelledAt: null, invoiceId: null, invoiceNumber: null, shelfCheckId, createdAt: at, updatedAt: at };
      await done(s.orders.put(o));
      return o;
    });
  },
  /** Pending → Delivered (with the invoice made from it) or Cancelled. A delivered or cancelled order doesn't change again. */
  async setStatus(id, status, { invoiceId = null, invoiceNumber = null } = {}) {
    if (!ORDER_STATUSES.has(status) || status === "pending") throw new Error("Unknown order status.");
    return run("orders", "readwrite", async (s) => {
      const o = await done(s.orders.get(id));
      if (!o) throw new Error("That order no longer exists.");
      if (o.status !== "pending") return o;
      const at = nowISO();
      Object.assign(o, { status, updatedAt: at }, status === "delivered" ? { deliveredAt: at, invoiceId, invoiceNumber } : { cancelledAt: at });
      await done(s.orders.put(o));
      return o;
    });
  },
};

// ── Setup, backup and restore ───────────────────────────────────────────

/** Opens storage, adds the starting products on first run and asks the browser to keep data. */
export async function init() {
  // No products to start with: each business adds its own in the setup screen.
  if ((await settings.get("nextNumber")) === null) await settings.set("nextNumber", 1);
  requestPersistence();
  return { seeded: false };
}

/** This phone's business: { name, address, phone, setupAt } — or null before the setup screen is finished. */
export const profile = {
  async get() { return settings.get("business", null); },
  async set(b) {
    const clean = { name: tidy(b.name).replace(/\n/g, " "), address: tidy(b.address || ""), phone: tidy(b.phone || "").replace(/\n/g, " "), setupAt: b.setupAt || new Date().toISOString() };
    if (b.repName !== undefined) clean.repName = tidy(b.repName).replace(/\n/g, " ").slice(0, 60); // team reps: their own name
    if (!clean.name) throw new Error("Type your company name first.");
    await settings.set("business", clean);
    return clean;
  },
};

/** Asks the browser not to clear this app's data when space runs low. Safe to call often. */
export async function requestPersistence() {
  try {
    if (navigator.storage?.persisted && (await navigator.storage.persisted())) return true;
    return navigator.storage?.persist ? await navigator.storage.persist() : false;
  } catch { return false; }
}

/** { persisted, usage, quota } in bytes, where the browser reports them. */
export async function storageStatus() {
  const out = { persisted: false, usage: null, quota: null };
  try { out.persisted = navigator.storage?.persisted ? await navigator.storage.persisted() : false; } catch {}
  try { const e = await navigator.storage?.estimate?.(); if (e) { out.usage = e.usage ?? null; out.quota = e.quota ?? null; } } catch {}
  return out;
}

/** Settings that never leave the phone in a backup file. */
const PRIVATE_SETTINGS = new Set(["pin", "printer", "currentId", "deviceId", "usageQueue"]);

/** Everything needed to restore on another phone (the dashboard PIN and printer are left out). */
export async function exportBackup() {
  const [p, inv, st, cn, od] = await Promise.all([products.all({ includeHidden: true }), invoices.all(), settings.all(), credits.all(), orders.all()]);
  const safeSettings = Object.fromEntries(Object.entries(st).filter(([k]) => !PRIVATE_SETTINGS.has(k)));
  return { app: "marlon-invoices", version: 1, exportedAt: nowISO(), products: p, invoices: inv, settings: safeSettings, ...(cn.length ? { credits: cn } : {}), ...(od.length ? { orders: od } : {}) };
}

/**
 * Merges a backup into this phone. Invoices and products are matched by id; the newer copy wins.
 * Resolves with { invoicesAdded, invoicesUpdated, productsAdded }.
 */
export async function importBackup(data) {
  if (!data || data.app !== "marlon-invoices" || !Array.isArray(data.invoices) || !Array.isArray(data.products)) {
    throw new Error("That file isn't a backup from this app.");
  }
  const counts = { invoicesAdded: 0, invoicesUpdated: 0, productsAdded: 0 };
  await run(["products", "invoices", "settings", "credits", "orders"], "readwrite", async (s) => {
    let maxOrder = 0;
    for (const o of Array.isArray(data.orders) ? data.orders : []) {
      if (!o || typeof o.id !== "string" || !Array.isArray(o.lines)) continue;
      const cur = await done(s.orders.get(o.id));
      if (!cur || (o.updatedAt || "") > (cur.updatedAt || "")) await done(s.orders.put(o));
      maxOrder = Math.max(maxOrder, Number(o.number) || 0);
    }
    if (maxOrder) {
      const r = await done(s.settings.get("nextOrderNumber"));
      await done(s.settings.put({ key: "nextOrderNumber", value: Math.max(Number(r?.value) || 1, maxOrder + 1) }));
    }
    let maxCredit = 0;
    for (const cn of Array.isArray(data.credits) ? data.credits : []) {
      if (!cn || typeof cn.id !== "string" || !Array.isArray(cn.lines)) continue;
      const cur = await done(s.credits.get(cn.id));
      if (!cur || (cn.updatedAt || "") > (cur.updatedAt || "")) await done(s.credits.put(cn));
      maxCredit = Math.max(maxCredit, Number(cn.number) || 0);
    }
    if (maxCredit) {
      const r = await done(s.settings.get("nextCreditNumber"));
      await done(s.settings.put({ key: "nextCreditNumber", value: Math.max(Number(r?.value) || 1, maxCredit + 1) }));
    }
    for (const p of data.products) {
      if (!p || typeof p.id !== "string" || typeof p.name !== "string") continue;
      const cur = await done(s.products.get(p.id));
      if (!cur) { await done(s.products.put(p)); counts.productsAdded++; }
    }
    let maxNumber = 0;
    for (const inv of data.invoices) {
      if (!inv || typeof inv.id !== "string" || !Array.isArray(inv.items)) continue;
      const cur = await done(s.invoices.get(inv.id));
      if (!cur) { await done(s.invoices.put(inv)); counts.invoicesAdded++; }
      else if ((inv.updatedAt || "") > (cur.updatedAt || "")) { await done(s.invoices.put(inv)); counts.invoicesUpdated++; }
      maxNumber = Math.max(maxNumber, Number(inv.number) || 0);
    }
    const row = await done(s.settings.get("nextNumber"));
    const next = Math.max(Number(row?.value) || 1, maxNumber + 1);
    await done(s.settings.put({ key: "nextNumber", value: next }));
    for (const [k, v] of Object.entries(data.settings || {})) {
      if (PRIVATE_SETTINGS.has(k) || k === "nextNumber" || k === "nextCreditNumber" || k === "nextOrderNumber") continue;
      const cur = await done(s.settings.get(k));
      if (!cur) await done(s.settings.put({ key: k, value: v }));
    }
  });
  return counts;
}

/** Deletes every invoice, product and setting on this phone, then re-seeds the starting products. */
export async function eraseEverything() {
  await run(["products", "invoices", "settings", "credits", "orders"], "readwrite", async (s) => {
    await done(s.products.clear());
    await done(s.invoices.clear());
    await done(s.settings.clear());
    await done(s.credits.clear());
    await done(s.orders.clear());
  });
  return init();
}
