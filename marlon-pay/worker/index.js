/**
 * Marlon Pay — the store's signed cash-payout book (the store-side partner to Marlon).
 *
 * The Worker serves the app (packed in from public/) and its API. One Durable Object (SQLite), PayHub, keeps every
 * store's data; every request is checked against the store's own link + device, so a store only ever sees its own.
 *
 * Links: the maker creates a store in the maker's console (marlon-app) → an owner link. The owner names staff places
 * and shares each staff link. Every link locks to the first device that opens it (like Marlon); others are turned away.
 *
 *   POST /api/activate     { key, device }  → { ok, role: "owner"|"staff", store, staffName } | { ok: false, reason }
 *   POST /api/sync         { key, device, cursor, suppliers, payouts, notes }
 *                          → { ok, stored: { suppliers, payouts, notes }, rejected: { payouts: [{ id, reason }] }, cursor, changes }
 *        Payouts are signed records: append only. A payout id the server already has is only ever accepted again if it
 *        is exactly the same (the server works out its own fingerprint, SHA-256); any different copy is refused
 *        ("locked") and logged as a problem. There is no way to edit or delete a payout. Notes (owner only) are
 *        dated corrections added to a payout, never changed or removed.
 *   POST /api/signatures   { key, device, ids } (owner) → { signatures: { id: dataURL } }   (decrypted on demand)
 *   POST /api/staff        { key, device } (owner) → { places }
 *   POST /api/staff/add    … + { name } → { place }   POST /api/staff/off … + { n, off }   POST /api/staff/replace … + { n }
 *
 * Signatures are kept encrypted (AES-256-GCM) with the ENCRYPTION_KEY secret; without it, sync refuses (records stay
 * safely on the devices) instead of storing signatures in the clear.
 *
 * The maker's console reaches this Worker only through the PayAdmin entrypoint (a Worker-to-Worker binding from
 * marlon-app; not reachable from the internet). It gets each store's counts and problems, never names or amounts.
 */
import { DurableObject, WorkerEntrypoint } from "cloudflare:workers";
import { FILES, RULES } from "./assets.generated.js";

const MAX_PLACES = 50;
const hex = (buf) => Array.from(new Uint8Array(buf), (b) => b.toString(16).padStart(2, "0")).join("");
const randomHex = (n) => hex(crypto.getRandomValues(new Uint8Array(n)));
const sha256Hex = async (text) => hex(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text)));
const hex32 = (v) => (typeof v === "string" && /^[0-9a-f]{32}$/.test(v) ? v : null);
const oid = (v) => (typeof v === "string" && /^[A-Za-z0-9_-]{4,64}$/.test(v) ? v : null);
const DAY = /^\d{4}-\d{2}-\d{2}$/;
const txt = (v, n) => String(v ?? "").replace(/[\u0000-\u0008\u000b-\u001f\u007f]/g, "").replace(/[ \t]+/g, " ").trim().slice(0, n);
const json = (data, status = 200) => new Response(JSON.stringify(data), { status, headers: { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store", "X-Content-Type-Options": "nosniff" } });
async function readJson(request, limit) {
  const text = await request.text();
  if (text.length > limit) throw new Error("too big");
  const v = JSON.parse(text);
  if (!v || typeof v !== "object" || Array.isArray(v)) throw new Error("bad");
  return v;
}

// ── Signatures, encrypted at rest ────────────────────────────────────────────────────────────────────────────────
const KEY_OK = (env) => typeof env?.ENCRYPTION_KEY === "string" && /^[A-Za-z0-9+/]{43}=$/.test(env.ENCRYPTION_KEY);
const b64 = (u8) => { let s = ""; for (let i = 0; i < u8.length; i += 0x8000) s += String.fromCharCode.apply(null, u8.subarray(i, i + 0x8000)); return btoa(s); };
let aesKey = null;
const sealKey = async (env) => (aesKey ||= await crypto.subtle.importKey("raw", Uint8Array.from(atob(env.ENCRYPTION_KEY), (c) => c.charCodeAt(0)), "AES-GCM", false, ["encrypt", "decrypt"]));
async function seal(env, text) {
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const ct = new Uint8Array(await crypto.subtle.encrypt({ name: "AES-GCM", iv }, await sealKey(env), new TextEncoder().encode(String(text))));
  const out = new Uint8Array(12 + ct.length); out.set(iv); out.set(ct, 12);
  return "v1:" + b64(out);
}
async function unseal(env, stored) {
  const raw = Uint8Array.from(atob(String(stored).slice(3)), (c) => c.charCodeAt(0));
  return new TextDecoder().decode(await crypto.subtle.decrypt({ name: "AES-GCM", iv: raw.slice(0, 12) }, await sealKey(env), raw.slice(12)));
}

/** A payout as the server keeps it (from what a device sent), or null if it isn't a valid signed record. */
function cleanPayout(p) {
  if (!p || typeof p !== "object") return null;
  const id = oid(p.id), supplierId = oid(p.supplierId);
  const cents = Number(p.amountCents);
  const sig = typeof p.signature === "string" && p.signature.length < 200000 && /^data:image\/png;base64,[A-Za-z0-9+/=]+$/.test(p.signature) ? p.signature : null;
  if (!id || !supplierId || !sig || !DAY.test(p.date || "") || !Number.isInteger(cents) || cents <= 0 || cents > 1e10) return null;
  if (!/^\d{4}-\d{2}-\d{2}T[\d:.]+Z$/.test(p.signedAt || "")) return null;
  const m = p.fromMarlon && typeof p.fromMarlon === "object" ? { seller: txt(p.fromMarlon.seller, 120), totalCents: Number.isInteger(Number(p.fromMarlon.totalCents)) ? Number(p.fromMarlon.totalCents) : null } : null;
  return { id, supplierId, supplierName: txt(p.supplierName, 120), date: p.date, invoiceNo: txt(p.invoiceNo, 60), amountCents: cents, staffName: txt(p.staffName, 80),
    signedAt: p.signedAt, fromMarlon: m, signature: sig };
}
/** The record's fingerprint: every field that was signed, including the signature itself. */
const fingerprint = (p) => sha256Hex(JSON.stringify([p.id, p.supplierId, p.supplierName, p.date, p.invoiceNo, p.amountCents, p.staffName, p.signedAt, p.fromMarlon, p.signature]));

export class PayHub extends DurableObject {
  constructor(ctx, env) {
    super(ctx, env);
    this.sql = ctx.storage.sql;
    this.sql.exec(`CREATE TABLE IF NOT EXISTS stores (id TEXT PRIMARY KEY, name TEXT NOT NULL, places INTEGER NOT NULL, owner_key TEXT NOT NULL UNIQUE,
      paid INTEGER NOT NULL DEFAULT 0, off INTEGER NOT NULL DEFAULT 0, created TEXT NOT NULL, seq INTEGER NOT NULL DEFAULT 0)`);
    this.sql.exec(`CREATE TABLE IF NOT EXISTS places (key TEXT PRIMARY KEY, store TEXT NOT NULL, n INTEGER NOT NULL, name TEXT NOT NULL, off INTEGER NOT NULL DEFAULT 0, created TEXT NOT NULL)`);
    this.sql.exec(`CREATE TABLE IF NOT EXISTS devices (key TEXT PRIMARY KEY, store TEXT NOT NULL, device TEXT NOT NULL, label TEXT NOT NULL, first_at TEXT NOT NULL, last_at TEXT NOT NULL)`);
    this.sql.exec(`CREATE TABLE IF NOT EXISTS suppliers (store TEXT NOT NULL, id TEXT NOT NULL, name TEXT NOT NULL, phone TEXT NOT NULL, notes TEXT NOT NULL,
      archived INTEGER NOT NULL, updated TEXT NOT NULL, seq INTEGER NOT NULL, PRIMARY KEY (store, id))`);
    this.sql.exec(`CREATE TABLE IF NOT EXISTS payouts (store TEXT NOT NULL, id TEXT NOT NULL, data TEXT NOT NULL, sig TEXT NOT NULL, hash TEXT NOT NULL,
      device_key TEXT NOT NULL, received TEXT NOT NULL, seq INTEGER NOT NULL, PRIMARY KEY (store, id))`);
    this.sql.exec(`CREATE TABLE IF NOT EXISTS notes (store TEXT NOT NULL, id TEXT NOT NULL, payout TEXT NOT NULL, text TEXT NOT NULL, created TEXT NOT NULL, seq INTEGER NOT NULL, PRIMARY KEY (store, id))`);
    this.sql.exec(`CREATE TABLE IF NOT EXISTS problems (store TEXT NOT NULL, at TEXT NOT NULL, kind TEXT NOT NULL, detail TEXT NOT NULL)`);
    this.sql.exec(`CREATE TABLE IF NOT EXISTS usage (store TEXT NOT NULL, day TEXT NOT NULL, kind TEXT NOT NULL, n INTEGER NOT NULL, PRIMARY KEY (store, day, kind))`);
  }
  #store(id) { return this.sql.exec("SELECT * FROM stores WHERE id = ?", id).toArray()[0] || null; }
  #problem(store, kind, detail = "") {
    this.sql.exec("INSERT INTO problems (store, at, kind, detail) VALUES (?, ?, ?, ?)", store, new Date().toISOString(), kind, String(detail).slice(0, 160));
    this.sql.exec("DELETE FROM problems WHERE store = ? AND at < ?", store, new Date(Date.now() - 90 * 864e5).toISOString());
  }
  #count(store, kind, n = 1) {
    this.sql.exec("INSERT INTO usage (store, day, kind, n) VALUES (?, ?, ?, ?) ON CONFLICT(store, day, kind) DO UPDATE SET n = n + excluded.n", store, new Date().toISOString().slice(0, 10), kind, n);
  }
  #nextSeq(store) { this.sql.exec("UPDATE stores SET seq = seq + 1 WHERE id = ?", store); return this.#store(store).seq; }

  /** Who a link belongs to: { store, role, place } (no device check). */
  #resolve(key) {
    const s = this.sql.exec("SELECT * FROM stores WHERE owner_key = ?", key).toArray()[0];
    if (s) return { store: s, role: "owner", place: null };
    const p = this.sql.exec("SELECT * FROM places WHERE key = ?", key).toArray()[0];
    return p ? { store: this.#store(p.store), role: "staff", place: p } : null;
  }
  /** A link + device that may use the store now, or { error }. The first device to open a link takes it. */
  #who(key, device, label = "", { claim = false } = {}) {
    const r = key && this.#resolve(key);
    if (!r || !r.store) return { error: "unknown" };
    if (r.store.off) { this.#problem(r.store.id, "store-off", r.role); return { error: "storeoff" }; }
    if (r.place?.off) { this.#problem(r.store.id, "staff-off", `place ${r.place.n}`); return { error: "off" }; }
    const d = this.sql.exec("SELECT * FROM devices WHERE key = ?", key).toArray()[0];
    const now = new Date().toISOString();
    if (d) {
      if (d.device !== device) { this.#problem(r.store.id, "other-device", r.role === "owner" ? "owner link" : `staff place ${r.place.n}`); return { error: "taken" }; }
      this.sql.exec("UPDATE devices SET last_at = ? WHERE key = ?", now, key);
    } else {
      if (!claim) return { error: "unknown" };
      this.sql.exec("INSERT INTO devices (key, store, device, label, first_at, last_at) VALUES (?, ?, ?, ?, ?, ?)", key, r.store.id, device, String(label).slice(0, 80), now, now);
    }
    return { ...r, key };
  }

  activate(key, device, label) {
    const w = this.#who(key, device, label, { claim: true });
    if (w.error) return { ok: false, reason: w.error };
    return { ok: true, role: w.role, store: { name: w.store.name }, staffName: w.role === "owner" ? "Owner" : w.place.name, place: w.place?.n ?? null };
  }

  async sync(key, device, body, sealed) {
    const w = this.#who(key, device);
    if (w.error) return { error: w.error };
    const store = w.store.id;
    const stored = { suppliers: [], payouts: [], notes: [] }, rejected = { payouts: [], notes: [] };
    // Suppliers: anyone in the store can add, edit or archive; the newest edit wins.
    for (const s of body.suppliers) {
      const cur = this.sql.exec("SELECT updated FROM suppliers WHERE store = ? AND id = ?", store, s.id).toArray()[0];
      if (!cur || cur.updated < s.updatedAt) {
        this.sql.exec(`INSERT INTO suppliers (store, id, name, phone, notes, archived, updated, seq) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
          ON CONFLICT(store, id) DO UPDATE SET name = excluded.name, phone = excluded.phone, notes = excluded.notes, archived = excluded.archived, updated = excluded.updated, seq = excluded.seq`,
          store, s.id, s.name, s.phone, s.notes, s.archived ? 1 : 0, s.updatedAt, this.#nextSeq(store));
      }
      stored.suppliers.push(s.id);
    }
    // Payouts: signed records, append only.
    for (const p of sealed) {
      const cur = this.sql.exec("SELECT hash FROM payouts WHERE store = ? AND id = ?", store, p.id).toArray()[0];
      if (cur) {
        if (cur.hash === p.hash) stored.payouts.push(p.id);
        else { rejected.payouts.push({ id: p.id, reason: "locked" }); this.#problem(store, "changed-record", "a device sent a different copy of a signed record (refused)"); }
        continue;
      }
      this.sql.exec("INSERT INTO payouts (store, id, data, sig, hash, device_key, received, seq) VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
        store, p.id, JSON.stringify(p.data), p.sig, p.hash, key, new Date().toISOString(), this.#nextSeq(store));
      this.#count(store, "payouts");
      stored.payouts.push(p.id);
    }
    // Correction notes: owner only, added to a payout, never changed.
    for (const n of body.notes) {
      if (w.role !== "owner") { rejected.notes.push({ id: n.id, reason: "owner" }); continue; }
      if (!this.sql.exec("SELECT 1 FROM payouts WHERE store = ? AND id = ?", store, n.payoutId).toArray().length) { rejected.notes.push({ id: n.id, reason: "unknown" }); continue; }
      const cur = this.sql.exec("SELECT 1 FROM notes WHERE store = ? AND id = ?", store, n.id).toArray().length;
      if (!cur) this.sql.exec("INSERT INTO notes (store, id, payout, text, created, seq) VALUES (?, ?, ?, ?, ?, ?)", store, n.id, n.payoutId, n.text, new Date().toISOString(), this.#nextSeq(store));
      stored.notes.push(n.id);
    }
    if (body.suppliers.length || sealed.length || body.notes.length) this.#count(store, "syncs");
    // What changed since this device last asked. Staff get suppliers and their own records; the owner gets everything.
    const since = Number.isInteger(body.cursor) && body.cursor >= 0 ? body.cursor : 0;
    const changes = {
      suppliers: this.sql.exec("SELECT id, name, phone, notes, archived, updated FROM suppliers WHERE store = ? AND seq > ? ORDER BY seq", store, since).toArray()
        .map((r) => ({ id: r.id, name: r.name, phone: r.phone, notes: r.notes, archived: Boolean(r.archived), updatedAt: r.updated })),
      payouts: (w.role === "owner"
        ? this.sql.exec("SELECT data, device_key, received FROM payouts WHERE store = ? AND seq > ? ORDER BY seq", store, since)
        : this.sql.exec("SELECT data, device_key, received FROM payouts WHERE store = ? AND seq > ? AND device_key = ? ORDER BY seq", store, since, key)).toArray()
        .map((r) => ({ ...JSON.parse(r.data), receivedAt: r.received })),
      notes: w.role === "owner" ? this.sql.exec("SELECT id, payout, text, created FROM notes WHERE store = ? AND seq > ? ORDER BY seq", store, since).toArray()
        .map((r) => ({ id: r.id, payoutId: r.payout, text: r.text, createdAt: r.created })) : [],
    };
    return { ok: true, stored, rejected, cursor: this.#store(store).seq, changes, role: w.role, store: { name: w.store.name } };
  }

  /** Owner only: signatures of the store's own records (still encrypted; the Worker decrypts them). */
  signatures(key, device, ids) {
    const w = this.#who(key, device);
    if (w.error) return { error: w.error };
    if (w.role !== "owner") return { error: "owner" };
    const out = {};
    for (const id of ids) { const r = this.sql.exec("SELECT sig FROM payouts WHERE store = ? AND id = ?", w.store.id, id).toArray()[0]; if (r) out[id] = r.sig; }
    return { ok: true, sealed: out };
  }

  // ── Staff links (owner) ─────────────────────────────────────────────────────────────────────────────────────────
  #places(store) {
    const s = this.#store(store);
    const rows = this.sql.exec("SELECT p.key, p.n, p.name, p.off, d.label, d.last_at FROM places p LEFT JOIN devices d ON d.key = p.key WHERE p.store = ? ORDER BY p.n", store).toArray();
    return { total: s.places, places: rows.map((r) => ({ n: r.n, name: r.name, key: r.key, off: Boolean(r.off), device: r.label ? { label: r.label, lastSeen: r.last_at } : null })) };
  }
  staff(key, device, action = "list", arg = {}) {
    const w = this.#who(key, device);
    if (w.error) return { error: w.error };
    if (w.role !== "owner") return { error: "owner" };
    const store = w.store.id;
    if (action === "add") {
      const used = new Set(this.sql.exec("SELECT n FROM places WHERE store = ?", store).toArray().map((r) => r.n));
      let n = 1; while (used.has(n)) n++;
      if (n > w.store.places) return { error: "full" };
      this.sql.exec("INSERT INTO places (key, store, n, name, off, created) VALUES (?, ?, ?, ?, 0, ?)", randomHex(16), store, n, arg.name, new Date().toISOString());
    } else if (action === "off") {
      this.sql.exec("UPDATE places SET off = ? WHERE store = ? AND n = ?", arg.off ? 1 : 0, store, arg.n);
    } else if (action === "replace") {
      // A new staff member: a new link for the same place; the old link and its device never work again.
      const p = this.sql.exec("SELECT key FROM places WHERE store = ? AND n = ?", store, arg.n).toArray()[0];
      if (!p) return { error: "unknown" };
      this.sql.exec("DELETE FROM places WHERE key = ?", p.key);
      this.sql.exec("DELETE FROM devices WHERE key = ?", p.key);
      this.sql.exec("INSERT INTO places (key, store, n, name, off, created) VALUES (?, ?, ?, ?, 0, ?)", randomHex(16), store, arg.n, arg.name, new Date().toISOString());
    }
    return { ok: true, ...this.#places(store) };
  }

  // ── The maker's console (through PayAdmin) ──────────────────────────────────────────────────────────────────────
  adminCreate(name, places) {
    const id = randomHex(16), owner = randomHex(16);
    this.sql.exec("INSERT INTO stores (id, name, places, owner_key, created) VALUES (?, ?, ?, ?, ?)", id, name, places, owner, new Date().toISOString());
    return this.adminStores().stores.find((s) => s.id === id);
  }
  adminSet(id, { paid, off, places }) {
    if (!this.#store(id)) return { error: "unknown" };
    if (paid !== undefined) this.sql.exec("UPDATE stores SET paid = ? WHERE id = ?", paid ? 1 : 0, id);
    if (off !== undefined) this.sql.exec("UPDATE stores SET off = ? WHERE id = ?", off ? 1 : 0, id);
    if (places !== undefined) this.sql.exec("UPDATE stores SET places = ? WHERE id = ?", places, id);
    return { ok: true, store: this.adminStores().stores.find((s) => s.id === id) };
  }
  /** Every store with counts and problems only: never supplier names, amounts or signatures. */
  adminStores() {
    const since30 = new Date(Date.now() - 30 * 864e5).toISOString().slice(0, 10);
    const n = (sql, ...a) => this.sql.exec(sql, ...a).toArray()[0].n;
    const stores = this.sql.exec("SELECT * FROM stores ORDER BY created DESC").toArray().map((s) => ({
      id: s.id, name: s.name, created: s.created, paid: Boolean(s.paid), off: Boolean(s.off), places: s.places, ownerKey: s.owner_key,
      staffNamed: n("SELECT COUNT(*) AS n FROM places WHERE store = ?", s.id),
      devices: n("SELECT COUNT(*) AS n FROM devices WHERE store = ?", s.id),
      suppliers: n("SELECT COUNT(*) AS n FROM suppliers WHERE store = ? AND archived = 0", s.id),
      payouts: n("SELECT COUNT(*) AS n FROM payouts WHERE store = ?", s.id),
      payouts30: n("SELECT COALESCE(SUM(n), 0) AS n FROM usage WHERE store = ? AND kind = 'payouts' AND day >= ?", s.id, since30),
      lastActive: this.sql.exec("SELECT MAX(last_at) AS t FROM devices WHERE store = ?", s.id).toArray()[0].t || null,
      problems: this.sql.exec("SELECT at, kind, detail FROM problems WHERE store = ? ORDER BY at DESC LIMIT 10", s.id).toArray(),
      problems30: n("SELECT COUNT(*) AS n FROM problems WHERE store = ? AND at >= ?", s.id, since30),
    }));
    return { stores };
  }
}

const hub = (env) => env.HUB.get(env.HUB.idFromName("hub"));

/** The maker's console (marlon-app) calls these through a service binding; they aren't reachable from the internet. */
export class PayAdmin extends WorkerEntrypoint {
  async stores() { return hub(this.env).adminStores(); }
  async createStore(name, places) {
    const n = txt(name, 80), p = Number(places);
    if (!n) return { error: "Type the store's name." };
    if (!Number.isInteger(p) || p < 0 || p > MAX_PLACES) return { error: `Staff places: a whole number from 0 to ${MAX_PLACES}.` };
    return { ok: true, store: await hub(this.env).adminCreate(n, p) };
  }
  async setStore(id, changes = {}) {
    if (!hex32(id)) return { error: "unknown" };
    const c = {};
    if (changes.paid !== undefined) c.paid = Boolean(changes.paid);
    if (changes.off !== undefined) c.off = Boolean(changes.off);
    if (changes.places !== undefined) { const p = Number(changes.places); if (!Number.isInteger(p) || p < 0 || p > MAX_PLACES) return { error: "bad places" }; c.places = p; }
    return hub(this.env).adminSet(id, c);
  }
}

// ── HTTP API ─────────────────────────────────────────────────────────────────────────────────────────────────────
const REASON = {
  unknown: "This link isn't valid. Ask the store owner for a new one.",
  taken: "This link is already in use on another device. Ask the store owner for your own link.",
  off: "This link has been switched off. Ask the store owner.",
  storeoff: "Marlon Pay is switched off for this store. Contact the person who sold it to you.",
  owner: "Only the store owner can do that.",
};
async function api(request, env, path) {
  if (request.method !== "POST") return json({ error: "Not found" }, 404);
  if (!/^application\/json\b/i.test(request.headers.get("content-type") || "")) return json({ error: "bad request" }, 415);
  let body;
  try { body = await readJson(request, path === "/api/sync" ? 3_000_000 : 20000); } catch { return json({ error: "That was too big or not readable." }, 400); }
  const key = hex32(body.key), device = hex32(body.device);
  if (!key || !device) return json({ ok: false, reason: "unknown", error: REASON.unknown }, 403);
  const h = hub(env);
  const fail = (r) => json({ ok: false, reason: r.error, error: REASON[r.error] || "That didn't work." }, r.error === "owner" ? 403 : r.error === "full" ? 409 : 403);

  if (path === "/api/activate") {
    const label = (() => { const ua = request.headers.get("User-Agent") || ""; return /iPhone/.test(ua) ? "iPhone" : /iPad/.test(ua) ? "iPad" : /Android/.test(ua) ? "Android" : /Mac/.test(ua) ? "Mac" : /Windows/.test(ua) ? "Windows" : "Browser"; })();
    const r = await h.activate(key, device, label);
    return r.ok ? json(r) : json({ ok: false, reason: r.reason, error: REASON[r.reason] }, 403);
  }
  if (path === "/api/sync") {
    if (!KEY_OK(env)) return json({ ok: false, error: "Marlon Pay isn't finished being set up on the server yet. Your records are safe on this device." }, 503);
    const list = (v, n) => (Array.isArray(v) ? v.slice(0, n) : []);
    const suppliers = list(body.suppliers, 200).map((s) => ({ id: oid(s?.id), name: txt(s?.name, 120), phone: txt(s?.phone, 40), notes: txt(s?.notes, 500), archived: Boolean(s?.archived),
      updatedAt: /^\d{4}-\d{2}-\d{2}T[\d:.]+Z$/.test(s?.updatedAt || "") ? s.updatedAt : "" })).filter((s) => s.id && s.name && s.updatedAt);
    const notes = list(body.notes, 50).map((n) => ({ id: oid(n?.id), payoutId: oid(n?.payoutId), text: txt(n?.text, 500) })).filter((n) => n.id && n.payoutId && n.text);
    const sealed = [], bad = [];
    for (const raw of list(body.payouts, 20)) {
      const p = cleanPayout(raw);
      if (!p) { bad.push(oid(raw?.id) || "?"); continue; }
      const { signature, ...data } = p;
      sealed.push({ id: p.id, data, sig: await seal(env, signature), hash: await fingerprint(p) });
    }
    const r = await h.sync(key, device, { cursor: body.cursor, suppliers, notes }, sealed);
    if (r.error) return fail(r);
    for (const id of bad) r.rejected.payouts.push({ id, reason: "invalid" });
    return json(r);
  }
  if (path === "/api/signatures") {
    const ids = (Array.isArray(body.ids) ? body.ids : []).slice(0, 200).map(oid).filter(Boolean);
    const r = await h.signatures(key, device, ids);
    if (r.error) return fail(r);
    const signatures = {};
    for (const [id, s] of Object.entries(r.sealed)) { try { signatures[id] = await unseal(env, s); } catch { signatures[id] = null; } }
    return json({ ok: true, signatures });
  }
  if (path === "/api/staff" || path === "/api/staff/add" || path === "/api/staff/off" || path === "/api/staff/replace") {
    const action = path.split("/")[3] || "list";
    const name = txt(body.name, 60), n = Number(body.n);
    if ((action === "add" || action === "replace") && !name) return json({ error: "Type the staff member's name." }, 400);
    if ((action === "off" || action === "replace") && !(Number.isInteger(n) && n >= 1)) return json({ error: "bad request" }, 400);
    const r = await h.staff(key, device, action, { name, n, off: Boolean(body.off) });
    if (r.error === "full") return json({ error: "All your staff places are in use. Ask the person who sold you Marlon Pay for more." }, 409);
    if (r.error) return fail(r);
    const origin = new URL(request.url).origin;
    return json({ ...r, places: r.places.map((p) => ({ ...p, link: `${origin}/?k=${p.key}`, key: undefined })) });
  }
  return json({ error: "Not found" }, 404);
}

// ── Files ────────────────────────────────────────────────────────────────────────────────────────────────────────
const matches = (pattern, path) => pattern === path || (pattern.endsWith("*") && path.startsWith(pattern.slice(0, -1)));
const bodyOf = (f) => (f.text !== undefined ? f.text : Uint8Array.from(atob(f.b64), (c) => c.charCodeAt(0)));
function respond(request, path, f, status = 200) {
  const headers = new Headers({ "Content-Type": f.type, "Cache-Control": "no-cache", ETag: f.etag });
  for (const r of RULES) if (matches(r.pattern, path)) for (const [k, v] of Object.entries(r.headers)) headers.set(k, v);
  if (status === 200 && (request.headers.get("If-None-Match") || "").replace(/^W\//, "") === f.etag) return new Response(null, { status: 304, headers });
  return new Response(request.method === "HEAD" ? null : bodyOf(f), { status, headers });
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    if (url.pathname.startsWith("/api/")) {
      try { return await api(request, env, url.pathname); } catch { return json({ error: "Something went wrong. Your records are safe on this device." }, 500); }
    }
    if (request.method !== "GET" && request.method !== "HEAD") return new Response("Method not allowed", { status: 405 });
    const path = url.pathname;
    // The home-screen app keeps its personal link: "/manifest.webmanifest?k=…" starts at "/?k=…".
    const k = url.searchParams.get("k");
    if (path === "/manifest.webmanifest" && hex32(k)) {
      const m = JSON.parse(FILES[path].text);
      m.start_url = `/?k=${k}`; m.id = `/?k=${k}`;
      return new Response(JSON.stringify(m), { headers: { "Content-Type": FILES[path].type, "Cache-Control": "no-cache", "X-Content-Type-Options": "nosniff" } });
    }
    const f = path === "/" ? FILES["/index.html"] : FILES[path] || FILES[path + ".html"];
    if (f) return respond(request, path, f);
    return respond(request, path, FILES["/index.html"], 404);
  },
};
