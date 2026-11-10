/**
 * On-phone storage (IndexedDB). Everything stays on this device; nothing is ever uploaded.
 *
 * Stores:
 *   products  { id, name, order, custom, hidden, lastPrice, createdAt }
 *   invoices  { id, number, seller, store, address, date, items[], total, signature, signedAt, createdAt, updatedAt }
 *   settings  { key, value }
 */
import { DEFAULT_PRODUCTS, SELLER, defaultProductId, defaultUnitFor, normalizeUnit, storeKey, tidy, uid, withTotals } from "./util.js";

const DB_NAME = "marlon-invoices";
const DB_VERSION = 1;
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
  async add(name) {
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
      const p = { id: uid("c_"), name: clean, order, custom: true, hidden: false, lastPrice: null, createdAt: nowISO() };
      await done(s.products.put(p));
      return p;
    });
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
  /**
   * Remembers the last price used for each product, per unit: { productId: price } (the product's usual unit)
   * or { productId: { price, unit } }. Prices are never converted between units (a dozen isn't 12 × each).
   */
  async rememberPrices(map) {
    const entries = Object.entries(map || {})
      .map(([id, v]) => [id, typeof v === "number" ? { price: v, unit: null } : v])
      .filter(([, v]) => v && typeof v.price === "number" && Number.isFinite(v.price));
    if (!entries.length) return;
    await run("products", "readwrite", async (s) => {
      for (const [id, { price, unit }] of entries) {
        const p = await done(s.products.get(id));
        if (!p) continue;
        const u = unit ? normalizeUnit(unit) : defaultUnitFor(p);
        let changed = false;
        if (p.lastPrices?.[u] !== price) { p.lastPrices = { ...(p.lastPrices || {}), [u]: price }; changed = true; }
        if (u === defaultUnitFor(p) && p.lastPrice !== price) { p.lastPrice = price; changed = true; }
        if (changed) await done(s.products.put(p));
      }
    });
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
   */
  async put(inv) {
    const clean = withTotals({ seller: SELLER, ...inv });
    clean.store = tidy(clean.store).replace(/\n/g, " ");
    clean.address = tidy(clean.address);
    clean.updatedAt = nowISO();
    clean.createdAt = clean.createdAt || clean.updatedAt;
    if (!clean.id) clean.id = uid("inv_");
    return run(["invoices", "settings"], "readwrite", async (s) => {
      if (!clean.number) {
        const row = await done(s.settings.get("nextNumber"));
        const n = Math.max(1, Number(row?.value) || 1);
        clean.number = n;
        await done(s.settings.put({ key: "nextNumber", value: n + 1 }));
      }
      await done(s.invoices.put(clean));
      return clean;
    });
  },
  async remove(id) {
    await run("invoices", "readwrite", (s) => done(s.invoices.delete(id)));
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

// ── Setup, backup and restore ───────────────────────────────────────────

/** Opens storage, adds the starting products on first run and asks the browser to keep data. */
export async function init() {
  const existing = await run("products", "readonly", (s) => done(s.products.count()));
  let seeded = false;
  if (!existing) {
    const created = nowISO();
    await run("products", "readwrite", async (s) => {
      for (const [i, name] of DEFAULT_PRODUCTS.entries()) {
        await done(s.products.put({ id: defaultProductId(i), name, order: i + 1, custom: false, hidden: false, lastPrice: null, createdAt: created }));
      }
    });
    seeded = true;
  }
  if ((await settings.get("nextNumber")) === null) await settings.set("nextNumber", 1);
  requestPersistence();
  return { seeded };
}

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
const PRIVATE_SETTINGS = new Set(["pin", "printer", "currentId"]);

/** Everything needed to restore on another phone (the dashboard PIN and printer are left out). */
export async function exportBackup() {
  const [p, inv, st] = await Promise.all([products.all({ includeHidden: true }), invoices.all(), settings.all()]);
  const safeSettings = Object.fromEntries(Object.entries(st).filter(([k]) => !PRIVATE_SETTINGS.has(k)));
  return { app: "marlon-invoices", version: 1, exportedAt: nowISO(), products: p, invoices: inv, settings: safeSettings };
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
  await run(["products", "invoices", "settings"], "readwrite", async (s) => {
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
      if (PRIVATE_SETTINGS.has(k) || k === "nextNumber") continue;
      const cur = await done(s.settings.get(k));
      if (!cur) await done(s.settings.put({ key: k, value: v }));
    }
  });
  return counts;
}

/** Deletes every invoice, product and setting on this phone, then re-seeds the starting products. */
export async function eraseEverything() {
  await run(["products", "invoices", "settings"], "readwrite", async (s) => {
    await done(s.products.clear());
    await done(s.invoices.clear());
    await done(s.settings.clear());
  });
  return init();
}
