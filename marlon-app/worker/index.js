/**
 * Marlon (the sellable copy): serves the offline invoice app from files packed into this Worker
 * (see scripts/build-worker.cjs) — "/" → index.html, "/v" → v.html, "/x.html" redirects to "/x", _headers rules
 * applied, ETag revalidation, friendly 404 page.
 *
 * Every business's data stays on its own phone. The only thing this Worker keeps is anonymous counts for the
 * maker's console (/console): which kinds of things happened on which day, and a random id per phone — no names,
 * customers, products, prices or amounts. Stored in one Durable Object (SQLite).
 *
 *   POST /api/ping            { device, events: [{ kind, day }] }          anonymous counts from the app
 *   GET  /api/console/state   { claimed }                                  has the maker set a passcode yet?
 *   POST /api/console/claim   { passcode } → { token }                     first visit only: sets the passcode
 *   POST /api/console/login   { passcode } → { token }                     5 wrong tries per 15 minutes, then wait
 *   GET  /api/console/stats   (Authorization: Bearer token) → the counts
 *   POST /api/console/logout
 *
 * Personal links (each buyer gets one; it works on up to the number of phones they paid for):
 *   POST /api/activate        { key, device } → { ok } | 403 { ok:false, reason: "full"|"off"|"unknown", contact }
 *   POST /api/check           { key, device } → the same, for a phone that's already active (switch-offs reach it here)
 *   GET  /api/contact         → { contact }   what blocked phones are told
 *   GET  /api/console/buyers  (Bearer) → { buyers: [...with devices], totalCents, contact }
 *   POST /api/console/buyers  (Bearer) { name, devices, amount } → { buyer, link }
 *   POST /api/console/buyer-off  (Bearer) { id, off }        switch a whole buyer off / on again
 *   POST /api/console/device-off (Bearer) { id, device, off } switch one phone off / on again (frees / takes a place)
 *   POST /api/console/contact    (Bearer) { contact }
 *
 * Marlon Pro (switched on per company in the console): $25 per rep per month, minus the automatic team discount for
 * that many reps (public/js/pricing.js, the same table as plain Marlon), minus any special deal % on top:
 *   POST /api/console/pro        (Bearer) { id, pro, reps, discountPct, startDate }   Pro on/off, the company's reps, the
 *                                special deal; switching Pro on also saves a payment notice (returned as { notice })
 *   POST /api/console/pro-notice (Bearer) { id, startDate }   a new payment notice at today's price (kept in the record)
 *   POST /api/console/buyer-contact (Bearer) { id, phone, email }  the buyer's phone (with country code) and email, which
 *                                fill in WhatsApp and email for payment notices
 *   POST /api/console/buyer-update  (Bearer) { id, name, phone, email, pro, reps, discountPct, startDate }  the customer's
 *                                edit page: everything is checked first, then saved together → { buyer, notice }
 *   /api/activate and /api/check also answer { pro } so phones show Pro features (remembered for offline)
 *   POST /api/team/sync          also takes { credits: [...] }: a rep's credit notes (returns) go to the boss too
 *   POST /api/pro/shelf          { key, device, image, mime, products } → { found, unknown } (Google Gemini); 20 per rep per day
 *   GET  /api/boss/data          also answers { pro, credits, orders } (orders: Marlon Pro shelf orders, without signatures)
 *   POST /api/team/sync          also takes { orders: [...] } (Pro only): shelf orders; the orderer's name and signature
 *                                are kept encrypted (AES-256-GCM, ENCRYPTION_KEY) → { storedOrders }
 *   POST /api/boss/order-signature (Bearer) { id } → { signer, signature, signedAt }  one order's signature, on demand
 *   Marlon Pay (the store-side app, Worker "marlon-pay", reached through the PAY service binding):
 *   GET  /api/console/pay        (Bearer) → { connected, stores: [{ …counts and problems, ownerLink }] }   never names or amounts
 *   POST /api/console/pay        (Bearer) { name, places } → { store }   a new store and its owner link
 *   POST /api/console/pay/set    (Bearer) { id, paid?, off?, places? } → { store }
 *   Marlon Pro · My Products (each company's own product list, private to that company; shelf photo matches only these):
 *   POST /api/pro/products        { key, device } or boss Bearer → { pro, canEdit, version, products: [{ id, name, size, price,
 *                                unit, photos: [{ id, thumb }] }] }   (a solo phone and the boss can edit; reps only read)
 *   POST /api/pro/products/save   … + { product: { id?, name, size, price, unit } } → { product }
 *   POST /api/pro/products/delete … + { id }
 *   POST /api/pro/products/photo  … + { productId, image (512 px JPEG, base64), thumb (small JPEG, base64) } → { photo }
 *   POST /api/pro/products/photo-delete … + { productId, photoId }
 *   POST /api/pro/products/photo-get    … + { photoId } → { image }
 *   POST /api/pro/products/seed   { key, device, products: [{ name, price, unit }] }  a solo phone's own list, once, while
 *                                the company has no saved products yet
 */
import { DurableObject } from "cloudflare:workers";
import { FILES, RULES } from "./assets.generated.js";
import { withTotals, normalizeUnit } from "../public/js/util.js";
import { newVapidKeys, pushEndpointOk, sendPush } from "./webpush.js";
import { shelfCount } from "./shelf.js";
import { PRO_REP_CENTS, TIER_LABELS, cleanEmail, cleanPhone, cleanReps, proPrice } from "../public/js/pricing.js";

// Marlon Pro: the free-tier guard for shelf photos (the price lives in public/js/pricing.js).
const SHELF_REP_DAILY = 20; // shelf photos per rep per day (a solo business counts as one rep), by the phone's own date
const SHELF_MAX_PRODUCTS = 200;   // My Products per company
const PRODUCT_PHOTOS = 3;          // photos per product
const SHELF_REFS = 40;             // reference photos sent with one shelf photo (one per product)


const KINDS = ["open", "setup", "invoice", "voice", "print", "pdf", "picture"];
const BOSS_PLACES = 2; // boss phones per team (on iPhone, the browser and the Home Screen icon count as two)
const DAY = /^\d{4}-\d{2}-\d{2}$/;
const todayUTC = () => new Date().toISOString().slice(0, 10);
const addDays = (iso, n) => { const d = new Date(`${iso}T12:00:00Z`); d.setUTCDate(d.getUTCDate() + n); return d.toISOString().slice(0, 10); };
const hex = (buf) => Array.from(new Uint8Array(buf), (b) => b.toString(16).padStart(2, "0")).join("");
const randomHex = (n) => hex(crypto.getRandomValues(new Uint8Array(n)));
const sha256Hex = async (text) => hex(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text)));

// ── Send for signature: limits, encryption at rest, and the invoice copy that gets frozen ──────────────────
const SIGN_DAYS = 7, SIGN_DAILY_LIMIT = 200;
const SIGN_KEY_OK = (env) => typeof env?.ENCRYPTION_KEY === "string" && /^[A-Za-z0-9+/]{43}=$/.test(env.ENCRYPTION_KEY); // 32 bytes, base64
const b64 = (u8) => { let s = ""; for (let i = 0; i < u8.length; i += 0x8000) s += String.fromCharCode.apply(null, u8.subarray(i, i + 0x8000)); return btoa(s); };
let aesKey = null;
async function sealKey(env) {
  if (!SIGN_KEY_OK(env)) throw new Error("ENCRYPTION_KEY is not set");
  return (aesKey ||= await crypto.subtle.importKey("raw", Uint8Array.from(atob(env.ENCRYPTION_KEY), (c) => c.charCodeAt(0)), "AES-GCM", false, ["encrypt", "decrypt"]));
}
/** AES-256-GCM: "v1:" + base64(iv | ciphertext). */
async function seal(env, text) {
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const ct = new Uint8Array(await crypto.subtle.encrypt({ name: "AES-GCM", iv }, await sealKey(env), new TextEncoder().encode(String(text))));
  const out = new Uint8Array(12 + ct.length); out.set(iv); out.set(ct, 12);
  return "v1:" + b64(out);
}
async function unseal(env, stored) {
  if (stored == null) return null;
  const raw = Uint8Array.from(atob(String(stored).slice(3)), (c) => c.charCodeAt(0));
  return new TextDecoder().decode(await crypto.subtle.decrypt({ name: "AES-GCM", iv: raw.slice(0, 12) }, await sealKey(env), raw.slice(12)));
}
/**
 * The invoice as it will be frozen and shown to the buyer: only these fields, in this order, with every line total
 * and the grand total worked out here (whole cents) — never taken from the phone. → { inv } | { error }
 */
function cleanSignInvoice(raw) {
  if (!raw || typeof raw !== "object" || typeof raw.id !== "string" || !/^[A-Za-z0-9_-]{1,64}$/.test(raw.id)) return { error: "That invoice can't be sent." };
  const txt = (v, n) => String(v ?? "").replace(/\s+/g, " ").trim().slice(0, n);
  const items = Array.isArray(raw.items) ? raw.items.slice(0, 300) : [];
  if (!items.length) return { error: "Add at least one item first." };
  const bad = items.some((it) => !(typeof it?.qty === "number" && it.qty > 0 && it.qty < 1e6) || !(typeof it?.price === "number" && it.price >= 0 && it.price < 1e8) || !txt(it?.name, 80));
  if (bad) return { error: "Every item needs a name, a quantity and a price before it can be sent." };
  const store = txt(raw.store, 120);
  if (!store) return { error: "Add the buyer's name first." };
  const t = withTotals({ items: items.map((it) => ({ name: txt(it.name, 80), qty: it.qty, unit: normalizeUnit(it.unit), price: it.price })) });
  const credit = cleanCredit(raw.credit, t.total);
  return { inv: {
    id: raw.id, number: Number.isInteger(raw.number) && raw.number > 0 && raw.number < 1e7 ? raw.number : null,
    date: /^\d{4}-\d{2}-\d{2}$/.test(raw.date || "") ? raw.date : new Date().toISOString().slice(0, 10),
    seller: txt(raw.seller, 120), sellerAddress: txt(raw.sellerAddress, 300), sellerPhone: txt(raw.sellerPhone, 60),
    store, address: txt(raw.address, 300),
    items: t.items.map((it) => ({ name: it.name, qty: it.qty, unit: it.unit, price: it.price, total: it.total })), total: t.total,
    ...(credit ? { subtotal: t.total, credit, total: Math.round((t.total - credit.amount) * 100) / 100 } : {}),
  } };
}

/**
 * A credit (from credit notes for returned goods) taken off an invoice: { amount, notes: [{ id, number, amount }] }.
 * Never more than the items' subtotal; null when there's none. The total is subtotal − credit.
 */
function cleanCredit(raw, subtotal) {
  if (!raw || typeof raw !== "object") return null;
  const notes = (Array.isArray(raw.notes) ? raw.notes.slice(0, 50) : []).map((n) => ({
    id: String(n?.id ?? "").slice(0, 64), number: Number.isInteger(n?.number) && n.number > 0 && n.number < 1e7 ? n.number : null,
    amount: typeof n?.amount === "number" && Number.isFinite(n.amount) && n.amount > 0 ? Math.round(n.amount * 100) / 100 : 0,
  })).filter((n) => n.amount > 0);
  const amount = Math.min(Math.round(notes.reduce((t, n) => t + n.amount * 100, 0)) / 100, subtotal);
  return amount > 0 ? { amount, notes } : null;
}

/** A rep's credit note (returned goods), as the boss sees it. */
function cleanCreditNote(cn) {
  if (!cn || typeof cn !== "object" || typeof cn.id !== "string" || !/^[A-Za-z0-9_-]{1,64}$/.test(cn.id)) return null;
  const txt = (v, n = 200) => String(v ?? "").slice(0, n);
  const num = (v) => (typeof v === "number" && Number.isFinite(v) ? v : null);
  return {
    id: cn.id, number: num(cn.number), date: /^\d{4}-\d{2}-\d{2}$/.test(cn.date || "") ? cn.date : null,
    store: txt(cn.store, 120), address: txt(cn.address, 300), total: num(cn.total) ?? 0, signed: Boolean(cn.signed), signer: txt(cn.signer, 80),
    lines: (Array.isArray(cn.lines) ? cn.lines.slice(0, 100) : []).map((l) => ({ name: txt(l?.name, 80), qty: num(l?.qty), unit: txt(l?.unit, 10), price: num(l?.price),
      total: num(l?.total) ?? 0, reason: l?.reason === "damaged" ? "damaged" : "expired" })),
    applied: num(cn.applied) ?? 0, updatedAt: txt(cn.updatedAt, 30),
  };
}

/** A shelf order from a rep's phone: what the boss sees, plus the orderer's name and signature (to be encrypted). */
function cleanOrder(o) {
  if (!o || typeof o !== "object" || typeof o.id !== "string" || !/^[A-Za-z0-9_-]{1,64}$/.test(o.id)) return null;
  const txt = (v, n = 200) => String(v ?? "").slice(0, n);
  const num = (v) => (typeof v === "number" && Number.isFinite(v) ? v : null);
  const iso = (v) => (/^\d{4}-\d{2}-\d{2}T[\d:.]+Z$/.test(v || "") ? v : "");
  const sig = typeof o.signature === "string" && o.signature.length < 120000 && /^data:image\/png;base64,[A-Za-z0-9+/=]+$/.test(o.signature) ? o.signature : "";
  return {
    order: {
      id: o.id, number: num(o.number), date: /^\d{4}-\d{2}-\d{2}$/.test(o.date || "") ? o.date : null, store: txt(o.store, 120), address: txt(o.address, 300),
      status: ["pending", "delivered", "cancelled"].includes(o.status) ? o.status : "pending",
      lines: (Array.isArray(o.lines) ? o.lines.slice(0, 100) : []).map((l) => ({ name: txt(l?.name, 80), unit: txt(l?.unit, 10), onShelf: num(l?.onShelf), target: num(l?.target), qty: num(l?.qty) })),
      signedAt: iso(o.signedAt), deliveredAt: iso(o.deliveredAt), cancelledAt: iso(o.cancelledAt), invoiceNumber: num(o.invoiceNumber), signed: Boolean(sig), updatedAt: txt(o.updatedAt, 30),
    },
    secret: { signer: txt(o.signer, 80), signature: sig, signedAt: iso(o.signedAt) },
  };
}

/** Only the fields the boss dashboard shows, with sane sizes (a rep's phone sends these; nothing else is kept). */
function cleanInvoice(inv) {
  if (!inv || typeof inv !== "object" || typeof inv.id !== "string" || !/^[A-Za-z0-9_-]{1,64}$/.test(inv.id)) return null;
  const txt = (v, n = 200) => String(v ?? "").slice(0, n);
  const num = (v) => (typeof v === "number" && Number.isFinite(v) ? v : null);
  const p = inv.payment && typeof inv.payment === "object" ? inv.payment : null;
  return {
    id: inv.id, number: num(inv.number), date: /^\d{4}-\d{2}-\d{2}$/.test(inv.date || "") ? inv.date : null,
    store: txt(inv.store, 120), address: txt(inv.address, 300), total: num(inv.total) ?? 0, signed: Boolean(inv.signed),
    items: (Array.isArray(inv.items) ? inv.items.slice(0, 300) : []).map((it) => ({ name: txt(it?.name, 80), qty: num(it?.qty), unit: txt(it?.unit, 10), price: num(it?.price), total: num(it?.total) ?? 0 })),
    payment: p ? { status: p.status === "paid" ? "paid" : "unpaid", method: txt(p.method, 10), termsDays: num(p.termsDays), dueDate: txt(p.dueDate, 10), paidAt: txt(p.paidAt, 30), ...(p.markedBy === "boss" ? { markedBy: "boss" } : {}) } : null,
    updatedAt: txt(inv.updatedAt, 30),
    ...(inv.credit ? { subtotal: num(inv.subtotal) ?? num(inv.total) ?? 0, credit: cleanCredit(inv.credit, num(inv.subtotal) ?? Infinity) } : {}),
  };
}

/** "iPhone", "Android · Chrome", "Windows · Edge"… so the owner can tell a buyer's phones apart. */
function deviceLabel(ua) {
  const os = /iPhone/.test(ua) ? "iPhone" : /iPad/.test(ua) ? "iPad" : /Android/.test(ua) ? "Android" : /Windows/.test(ua) ? "Windows"
    : /Macintosh/.test(ua) ? "Mac" : /Linux|CrOS/.test(ua) ? "Linux" : "Device";
  const br = /EdgA?\//.test(ua) ? "Edge" : /SamsungBrowser/.test(ua) ? "Samsung Internet" : /CriOS|Chrome\//.test(ua) ? "Chrome"
    : /FxiOS|Firefox\//.test(ua) ? "Firefox" : /Safari\//.test(ua) ? "Safari" : "";
  return br ? `${os} · ${br}` : os;
}

async function hashPasscode(passcode, salt) {
  const key = await crypto.subtle.importKey("raw", new TextEncoder().encode(passcode), "PBKDF2", false, ["deriveBits"]);
  const bits = await crypto.subtle.deriveBits({ name: "PBKDF2", hash: "SHA-256", salt: new TextEncoder().encode(salt), iterations: 5000 }, key, 256);
  return hex(bits);
}
const sameText = (a, b) => { if (a.length !== b.length) return false; let x = 0; for (let i = 0; i < a.length; i++) x |= a.charCodeAt(i) ^ b.charCodeAt(i); return x === 0; };

/** The maker's anonymous counts and the console's passcode, in one place. */
export class Stats extends DurableObject {
  constructor(ctx, env) {
    super(ctx, env);
    this.sql = ctx.storage.sql;
    this.sql.exec(`CREATE TABLE IF NOT EXISTS phones (id TEXT PRIMARY KEY, first_day TEXT NOT NULL, last_day TEXT NOT NULL, setup_day TEXT)`);
    this.sql.exec(`CREATE TABLE IF NOT EXISTS daily (day TEXT NOT NULL, kind TEXT NOT NULL, n INTEGER NOT NULL, PRIMARY KEY (day, kind))`);
    this.sql.exec(`CREATE TABLE IF NOT EXISTS active (day TEXT NOT NULL, id TEXT NOT NULL, PRIMARY KEY (day, id))`);
    this.sql.exec(`CREATE TABLE IF NOT EXISTS meta (k TEXT PRIMARY KEY, v TEXT NOT NULL)`);
    this.sql.exec(`CREATE TABLE IF NOT EXISTS sessions (token TEXT PRIMARY KEY, expires INTEGER NOT NULL)`);
    // Buyers and their phones. Amounts in whole cents, so the total never drifts.
    this.sql.exec(`CREATE TABLE IF NOT EXISTS buyers (id TEXT PRIMARY KEY, name TEXT NOT NULL, devices INTEGER NOT NULL,
      amount_cents INTEGER NOT NULL, created TEXT NOT NULL, off INTEGER NOT NULL DEFAULT 0)`);
    this.sql.exec(`CREATE TABLE IF NOT EXISTS buyer_devices (buyer TEXT NOT NULL, device TEXT NOT NULL, label TEXT NOT NULL DEFAULT '',
      first_at TEXT NOT NULL, last_at TEXT NOT NULL, off INTEGER NOT NULL DEFAULT 0, PRIMARY KEY (buyer, device))`);
    // Teams (added later: new columns are added to existing tables, nothing is lost).
    const addColumn = (table, column, decl) => {
      if (!this.sql.exec(`PRAGMA table_info(${table})`).toArray().some((c) => c.name === column)) this.sql.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${decl}`);
    };
    addColumn("buyers", "kind", "TEXT NOT NULL DEFAULT 'solo'");
    addColumn("buyers", "boss_key", "TEXT");
    addColumn("buyers", "boss_salt", "TEXT");
    addColumn("buyers", "boss_hash", "TEXT");
    addColumn("buyers", "boss_fails", "TEXT NOT NULL DEFAULT '[]'");
    addColumn("buyer_devices", "role", "TEXT NOT NULL DEFAULT 'rep'");
    addColumn("buyer_devices", "rep_name", "TEXT NOT NULL DEFAULT ''");
    this.sql.exec(`CREATE TABLE IF NOT EXISTS team_invoices (buyer TEXT NOT NULL, device TEXT NOT NULL, id TEXT NOT NULL, data TEXT NOT NULL,
      updated TEXT NOT NULL, PRIMARY KEY (buyer, id))`);
    this.sql.exec(`CREATE TABLE IF NOT EXISTS boss_sessions (token TEXT PRIMARY KEY, buyer TEXT NOT NULL, device TEXT NOT NULL, expires INTEGER NOT NULL)`);
    // One personal link per rep ("slot"): it locks to the first phone that opens it, so passing it on does nothing.
    this.sql.exec(`CREATE TABLE IF NOT EXISTS team_slots (key TEXT PRIMARY KEY, buyer TEXT NOT NULL, n INTEGER NOT NULL, created TEXT NOT NULL)`);
    addColumn("buyer_devices", "slot_key", "TEXT");
    addColumn("team_slots", "name", "TEXT NOT NULL DEFAULT ''");          // the rep's name, as the boss typed it
    addColumn("buyer_devices", "released", "INTEGER NOT NULL DEFAULT 0"); // switched off by the boss: its link is free again
    addColumn("buyer_devices", "boss_name", "TEXT NOT NULL DEFAULT ''");  // the name the boss gave this rep (kept on old invoices)
    // Invoices the boss marked paid: a rep's phone can never undo that, and picks it up.
    this.sql.exec(`CREATE TABLE IF NOT EXISTS boss_paid (buyer TEXT NOT NULL, id TEXT NOT NULL, paid_at TEXT NOT NULL, PRIMARY KEY (buyer, id))`);
    // "Send for signature": a frozen copy of the invoice behind a secret link. Only a SHA-256 hash of the link is kept,
    // the invoice, the buyer's name and their signature are encrypted (AES-256-GCM), and nothing here can change the copy.
    this.sql.exec(`CREATE TABLE IF NOT EXISTS sign_links (hash TEXT PRIMARY KEY, buyer TEXT NOT NULL, device TEXT NOT NULL, invoice_id TEXT NOT NULL,
      data TEXT NOT NULL, digest TEXT NOT NULL, status TEXT NOT NULL, created TEXT NOT NULL, expires INTEGER NOT NULL,
      opened_at TEXT, signed_at TEXT, signer TEXT, signature TEXT, delivered INTEGER NOT NULL DEFAULT 0)`);
    this.sql.exec("CREATE INDEX IF NOT EXISTS sign_links_phone ON sign_links (buyer, device, invoice_id)");
    // Web push: each seller phone's push subscription(s) (encrypted), so it hears about signatures even when Marlon is closed.
    this.sql.exec(`CREATE TABLE IF NOT EXISTS push_subs (hash TEXT PRIMARY KEY, buyer TEXT NOT NULL, device TEXT NOT NULL, data TEXT NOT NULL, created TEXT NOT NULL)`);
    // Marlon Pro: on/off and the discount per company, the reps' credit notes (returns), and the shelf-photo count per day.
    addColumn("buyers", "pro", "INTEGER NOT NULL DEFAULT 0");
    addColumn("buyers", "discount_pct", "REAL NOT NULL DEFAULT 0");
    addColumn("buyers", "pro_since", "TEXT");
    addColumn("buyers", "pro_reps", "INTEGER"); // how many reps Pro is billed for (asked when Pro is switched on)
    addColumn("buyers", "phone", "TEXT NOT NULL DEFAULT ''"); // the buyer's phone (with country code), for WhatsApp
    addColumn("buyers", "email", "TEXT NOT NULL DEFAULT ''");
    // Pro payment notices the maker sent (or can send again): the exact price at that moment, kept for good.
    this.sql.exec(`CREATE TABLE IF NOT EXISTS pro_notices (id TEXT PRIMARY KEY, buyer TEXT NOT NULL, created TEXT NOT NULL, start_date TEXT NOT NULL, data TEXT NOT NULL)`);
    this.sql.exec(`CREATE TABLE IF NOT EXISTS team_credits (buyer TEXT NOT NULL, device TEXT NOT NULL, id TEXT NOT NULL, data TEXT NOT NULL,
      updated TEXT NOT NULL, PRIMARY KEY (buyer, id))`);
    this.sql.exec(`CREATE TABLE IF NOT EXISTS shelf_daily (buyer TEXT NOT NULL, day TEXT NOT NULL, n INTEGER NOT NULL, PRIMARY KEY (buyer, day))`);
    // Shelf photos per rep per day ("rep" = the rep's phone for a team; "company" for a solo business, which counts as one rep).
    this.sql.exec(`CREATE TABLE IF NOT EXISTS shelf_rep_daily (buyer TEXT NOT NULL, rep TEXT NOT NULL, day TEXT NOT NULL, n INTEGER NOT NULL, PRIMARY KEY (buyer, rep, day))`);
    // Marlon Pro · My Products: each company's own products and their photos (private to that company).
    this.sql.exec(`CREATE TABLE IF NOT EXISTS company_products (buyer TEXT NOT NULL, id TEXT NOT NULL, name TEXT NOT NULL, size TEXT NOT NULL DEFAULT '',
      price_cents INTEGER, unit TEXT NOT NULL DEFAULT 'each', position INTEGER NOT NULL, created TEXT NOT NULL, updated TEXT NOT NULL, PRIMARY KEY (buyer, id))`);
    this.sql.exec(`CREATE TABLE IF NOT EXISTS product_photos (buyer TEXT NOT NULL, product_id TEXT NOT NULL, id TEXT NOT NULL, image TEXT NOT NULL, thumb TEXT NOT NULL,
      created TEXT NOT NULL, PRIMARY KEY (buyer, id))`);
    addColumn("buyers", "catalog_ver", "INTEGER NOT NULL DEFAULT 0");
    // Marlon Pro shelf orders from reps' phones. `data` has no name or signature; `sealed` has both, encrypted.
    this.sql.exec(`CREATE TABLE IF NOT EXISTS team_orders (buyer TEXT NOT NULL, device TEXT NOT NULL, id TEXT NOT NULL, data TEXT NOT NULL,
      sealed TEXT NOT NULL, updated TEXT NOT NULL, PRIMARY KEY (buyer, id))`);
  }

  #meta(k) { return this.sql.exec("SELECT v FROM meta WHERE k = ?", k).toArray()[0]?.v ?? null; }
  #setMeta(k, v) { this.sql.exec("INSERT INTO meta (k, v) VALUES (?, ?) ON CONFLICT(k) DO UPDATE SET v = excluded.v", k, String(v)); }

  // ── Send for signature ─────────────────────────────────────────────────────────────────────────────────
  // Statuses: sent → opened → signed (final), or replaced / cancelled (a newer link, or the seller cancelled), or
  // expired (worked out: not signed within 7 days). A signed copy can never be changed, replaced or cancelled.

  /** An active phone of an active buyer (solo or team), or null. */
  #activePhone(key, device) {
    const { b } = this.#resolve(key);
    if (!b || b.off) return null;
    const d = b.phones.find((x) => x.device === device);
    return d && !d.off ? b : null;
  }
  #signState(row, now = Date.now()) {
    if (row.status === "signed" || row.status === "replaced" || row.status === "cancelled") return row.status;
    return now > row.expires ? "expired" : row.status;
  }

  /** The seller sends a (cleaned) invoice: it's frozen, and a new secret link is made. Older unsigned links for it stop working. */
  async signCreate(key, device, inv) {
    const b = this.#activePhone(key, device);
    if (!b) return { error: "off" };
    if (!SIGN_KEY_OK(this.env)) return { error: "setup" };
    const rows = this.sql.exec("SELECT status FROM sign_links WHERE buyer = ? AND device = ? AND invoice_id = ?", b.id, device, inv.id).toArray();
    if (rows.some((r) => r.status === "signed")) return { error: "signed" };
    const today = new Date().toISOString().slice(0, 10);
    const sentToday = this.sql.exec("SELECT COUNT(*) AS n FROM sign_links WHERE buyer = ? AND device = ? AND created >= ?", b.id, device, today).one().n;
    if (sentToday >= SIGN_DAILY_LIMIT) return { error: "limit" };
    this.sql.exec("UPDATE sign_links SET status = 'replaced' WHERE buyer = ? AND device = ? AND invoice_id = ? AND status IN ('sent', 'opened')", b.id, device, inv.id);
    const token = randomHex(32), hash = await sha256Hex(token), now = new Date();
    const text = JSON.stringify(inv), digest = await sha256Hex(text), expires = now.getTime() + SIGN_DAYS * 86_400_000;
    this.sql.exec("INSERT INTO sign_links (hash, buyer, device, invoice_id, data, digest, status, created, expires) VALUES (?, ?, ?, ?, ?, ?, 'sent', ?, ?)",
      hash, b.id, device, inv.id, await seal(this.env, text), digest, now.toISOString(), expires);
    return { ok: true, token, expires: new Date(expires).toISOString(), digest };
  }

  async #signCopy(row) {
    const text = await unseal(this.env, row.data);
    if ((await sha256Hex(text)) !== row.digest) throw new Error("stored invoice doesn't match its fingerprint");
    return { invoice: JSON.parse(text), digest: row.digest };
  }
  async #signedOut(row) {
    return { ...(await this.#signCopy(row)), state: "signed", signedAt: row.signed_at, signer: await unseal(this.env, row.signer), signature: await unseal(this.env, row.signature) };
  }

  /** The buyer opens the link. The first open marks it "opened". */
  async signView(token, now = Date.now()) {
    const row = this.sql.exec("SELECT * FROM sign_links WHERE hash = ?", await sha256Hex(token)).toArray()[0];
    if (!row) return { state: "unknown" };
    const st = this.#signState(row, now);
    if (st === "signed") return this.#signedOut(row);
    const { invoice } = await this.#signCopy(row);
    const seller = invoice.seller || "the seller";
    if (st === "expired" || st === "replaced" || st === "cancelled") return { state: st, seller };
    if (row.status === "sent") this.sql.exec("UPDATE sign_links SET status = 'opened', opened_at = ? WHERE hash = ?", new Date().toISOString(), row.hash);
    return { state: "open", invoice, digest: row.digest, expires: new Date(row.expires).toISOString() };
  }

  // ── Web push ──────────────────────────────────────────────────────────────────────────────────────────
  // This server's VAPID key pair is made once and kept here, encrypted with ENCRYPTION_KEY (no extra secret to set up).
  #vapidP = null;
  #vapid() {
    return (this.#vapidP ||= (async () => {
      const stored = this.#meta("vapid");
      if (stored) { try { return JSON.parse(await unseal(this.env, stored)); } catch { this.sql.exec("DELETE FROM push_subs"); } } // key changed: old subscriptions can't work
      const keys = await newVapidKeys();
      this.#setMeta("vapid", await seal(this.env, JSON.stringify(keys)));
      return keys;
    })().catch((e) => { this.#vapidP = null; throw e; }));
  }
  async pushKey() { if (!SIGN_KEY_OK(this.env)) return { error: "setup" }; return { key: (await this.#vapid()).publicKey }; }
  async pushSubscribe(key, device, sub) {
    const b = this.#activePhone(key, device);
    if (!b) return { error: "off" };
    if (!SIGN_KEY_OK(this.env)) return { error: "setup" };
    const hash = await sha256Hex(sub.endpoint);
    this.sql.exec("INSERT INTO push_subs (hash, buyer, device, data, created) VALUES (?, ?, ?, ?, ?) ON CONFLICT(hash) DO UPDATE SET buyer = excluded.buyer, device = excluded.device, data = excluded.data",
      hash, b.id, device, await seal(this.env, JSON.stringify(sub)), new Date().toISOString());
    const extra = this.sql.exec("SELECT hash FROM push_subs WHERE buyer = ? AND device = ? ORDER BY created DESC LIMIT -1 OFFSET 5", b.id, device).toArray();
    for (const r of extra) this.sql.exec("DELETE FROM push_subs WHERE hash = ?", r.hash);
    return { ok: true };
  }
  async pushUnsubscribe(key, device, endpoint) {
    const b = this.#activePhone(key, device);
    if (!b) return { error: "off" };
    this.sql.exec("DELETE FROM push_subs WHERE hash = ? AND buyer = ? AND device = ?", await sha256Hex(endpoint), b.id, device);
    return { ok: true };
  }
  /** Tells the seller's phone(s) an invoice was signed. Subscriptions the push service says are gone are removed. */
  async #pushSigned(buyer, device, payload, subject) {
    const rows = this.sql.exec("SELECT hash, data FROM push_subs WHERE buyer = ? AND device = ?", buyer, device).toArray();
    if (!rows.length) return;
    const keys = await this.#vapid();
    for (const r of rows) {
      let sub; try { sub = JSON.parse(await unseal(this.env, r.data)); } catch { this.sql.exec("DELETE FROM push_subs WHERE hash = ?", r.hash); continue; }
      const res = await sendPush(sub, keys, subject, payload);
      if (res.gone) this.sql.exec("DELETE FROM push_subs WHERE hash = ?", r.hash);
    }
  }

  /** The buyer signs. Only their name and signature are accepted, and only for the exact copy they were shown. */
  async signSubmit(token, name, signature, digest, now = Date.now(), origin = "") {
    const row = this.sql.exec("SELECT * FROM sign_links WHERE hash = ?", await sha256Hex(token)).toArray()[0];
    if (!row) return { state: "unknown" };
    const st = this.#signState(row, now);
    if (st === "signed") return { ...(await this.#signedOut(row)), already: true };
    if (st !== "sent" && st !== "opened") return { state: st };
    await this.#signCopy(row); // the stored copy must still match its fingerprint
    if (digest !== row.digest) return { state: "changed" };
    const at = new Date().toISOString();
    this.sql.exec("UPDATE sign_links SET status = 'signed', signed_at = ?, signer = ?, signature = ?, opened_at = COALESCE(opened_at, ?) WHERE hash = ? AND status IN ('sent', 'opened')",
      at, await seal(this.env, name), await seal(this.env, signature), at, row.hash);
    // Alert the seller's phone, even with Marlon closed (in the background: the buyer doesn't wait for it).
    const { invoice } = await this.#signCopy(row);
    this.ctx.waitUntil(this.#pushSigned(row.buyer, row.device, { type: "signed", invoiceId: row.invoice_id, number: invoice.number, store: invoice.store, signer: name, signedAt: at }, origin || "mailto:noreply@invalid")
      .catch((e) => console.error("push failed", e?.message)));
    return this.#signedOut(this.sql.exec("SELECT * FROM sign_links WHERE hash = ?", row.hash).one());
  }

  /** The seller's phone: the status of everything it sent (newest link per invoice), with signed copies it hasn't got yet. */
  async signStatus(key, device, ack, now = Date.now()) {
    const b = this.#activePhone(key, device);
    if (!b) return { error: "off" };
    for (const id of ack) this.sql.exec("UPDATE sign_links SET delivered = 1 WHERE buyer = ? AND device = ? AND invoice_id = ? AND status = 'signed'", b.id, device, id);
    const rows = this.sql.exec(`SELECT * FROM sign_links WHERE buyer = ? AND device = ? AND status NOT IN ('replaced', 'cancelled')
      AND (status = 'signed' OR created >= ?) ORDER BY created`, b.id, device, new Date(Date.now() - 60 * 86_400_000).toISOString()).toArray();
    const latest = new Map();
    for (const r of rows) if (r.status === "signed" || !latest.has(r.invoice_id) || latest.get(r.invoice_id).status !== "signed") latest.set(r.invoice_id, r);
    const out = [];
    for (const r of latest.values()) {
      const st = this.#signState(r, now);
      if (st === "signed" && r.delivered) continue; // already on the phone
      const item = { invoiceId: r.invoice_id, state: st, sentAt: r.created, openedAt: r.opened_at, expires: new Date(r.expires).toISOString() };
      if (st === "signed") Object.assign(item, await this.#signedOut(r));
      out.push(item);
    }
    return { ok: true, links: out };
  }

  /** The seller cancels a link that hasn't been signed (to change the invoice). A signed one can't be cancelled. */
  signCancel(key, device, invoiceId) {
    const b = this.#activePhone(key, device);
    if (!b) return { error: "off" };
    if (this.sql.exec("SELECT 1 FROM sign_links WHERE buyer = ? AND device = ? AND invoice_id = ? AND status = 'signed'", b.id, device, invoiceId).toArray().length) return { error: "signed" };
    this.sql.exec("UPDATE sign_links SET status = 'cancelled' WHERE buyer = ? AND device = ? AND invoice_id = ? AND status IN ('sent', 'opened')", b.id, device, invoiceId);
    return { ok: true };
  }

  /** Counts from one phone: grouped by day and kind first, so a batch costs a handful of writes, not one per event. */
  record(device, events) {
    const today = todayUTC(), oldest = addDays(today, -40), newest = addDays(today, 1);
    const counts = new Map(), days = new Set();
    let setupDay = null;
    for (const e of events) {
      const day = DAY.test(e.day) && e.day >= oldest && e.day <= newest ? e.day : today;
      const key = `${day}|${e.kind}`;
      counts.set(key, (counts.get(key) || 0) + 1);
      days.add(day);
      if (e.kind === "setup" && (!setupDay || day < setupDay)) setupDay = day;
    }
    for (const [key, n] of counts) {
      const [day, kind] = key.split("|");
      this.sql.exec("INSERT INTO daily (day, kind, n) VALUES (?, ?, ?) ON CONFLICT(day, kind) DO UPDATE SET n = n + excluded.n", day, kind, n);
    }
    for (const day of days) this.sql.exec("INSERT OR IGNORE INTO active (day, id) VALUES (?, ?)", day, device);
    const sorted = [...days].sort();
    this.sql.exec(`INSERT INTO phones (id, first_day, last_day, setup_day) VALUES (?, ?, ?, ?)
      ON CONFLICT(id) DO UPDATE SET last_day = MAX(last_day, excluded.last_day), first_day = MIN(first_day, excluded.first_day),
      setup_day = COALESCE(setup_day, excluded.setup_day)`, device, sorted[0], sorted[sorted.length - 1], setupDay);
    if (this.#meta("pruned") !== today) { // once a day: per-phone activity older than 120 days isn't needed
      this.sql.exec("DELETE FROM active WHERE day < ?", addDays(today, -120));
      this.#setMeta("pruned", today);
    }
  }

  // The passcode belongs to one "generation" (wrangler.toml → CONSOLE_GENERATION). Raising that number and
  // redeploying lets the passcode be set again (forgotten passcode, or someone else got there first); counts stay.
  #generation() { return String(this.env?.CONSOLE_GENERATION ?? "1"); }
  #claimed() { return Boolean(this.#meta("hash")) && this.#meta("gen") === this.#generation(); }

  state() { return { claimed: this.#claimed() }; }

  /** First visit only. One at a time, so two people can't both "set" it at the same moment. */
  claim(passcode) {
    return this.ctx.blockConcurrencyWhile(async () => {
      if (this.#claimed()) return { error: "taken" };
      const salt = randomHex(16);
      const hash = await hashPasscode(passcode, salt);
      this.sql.exec("DELETE FROM sessions");
      this.#setMeta("salt", salt);
      this.#setMeta("hash", hash);
      this.#setMeta("gen", this.#generation());
      this.#setMeta("since", todayUTC());
      this.#setMeta("fails", "[]");
      return { token: this.#session() };
    });
  }

  /** One try at a time, so sending many guesses at once can't get past the 5-tries limit. */
  login(passcode) {
    return this.ctx.blockConcurrencyWhile(async () => {
      const now = Date.now();
      const fails = JSON.parse(this.#meta("fails") || "[]").filter((t) => now - t < 15 * 60 * 1000);
      if (fails.length >= 5) return { error: "wait", retryAfter: Math.ceil((15 * 60 * 1000 - (now - fails[0])) / 1000) };
      if (!this.#claimed()) return { error: "unclaimed" };
      if (!sameText(await hashPasscode(passcode, this.#meta("salt")), this.#meta("hash"))) {
        fails.push(now);
        this.#setMeta("fails", JSON.stringify(fails));
        return { error: "wrong", left: Math.max(0, 5 - fails.length) };
      }
      this.#setMeta("fails", "[]");
      return { token: this.#session() };
    });
  }

  #session() {
    const token = randomHex(32);
    this.sql.exec("DELETE FROM sessions WHERE expires < ?", Date.now());
    this.sql.exec("INSERT INTO sessions (token, expires) VALUES (?, ?)", token, Date.now() + 12 * 60 * 60 * 1000);
    return token;
  }

  check(token) {
    return Boolean(token) && this.#claimed() && this.sql.exec("SELECT 1 FROM sessions WHERE token = ? AND expires > ?", token, Date.now()).toArray().length > 0;
  }

  logout(token) { this.sql.exec("DELETE FROM sessions WHERE token = ?", token); }

  // ── Personal links ─────────────────────────────────────────────────────

  contact() { return this.#meta("contact") || ""; }
  setContact(text) { this.#setMeta("contact", text); return this.contact(); }

  /** kind "solo" (one business) or "team" (a company: `devices` rep phones, plus a boss link for the boss's phone). */
  createBuyer(name, devices, amountCents, kind = "solo", phone = "", email = "") {
    const id = randomHex(16);
    const bossKey = kind === "team" ? randomHex(16) : null;
    const now = new Date().toISOString();
    this.sql.exec("INSERT INTO buyers (id, name, devices, amount_cents, created, kind, boss_key, phone, email) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)",
      id, name, devices, amountCents, now, kind, bossKey, phone, email);
    if (kind === "team") for (let n = 1; n <= devices; n++) this.sql.exec("INSERT INTO team_slots (key, buyer, n, created) VALUES (?, ?, ?, ?)", randomHex(16), id, n, now);
    return this.#buyer(id);
  }

  #buyer(id) {
    const b = this.sql.exec("SELECT * FROM buyers WHERE id = ?", id).toArray()[0];
    if (!b) return null;
    const all = this.sql.exec("SELECT device, label, first_at, last_at, off, role, rep_name, slot_key, released, boss_name FROM buyer_devices WHERE buyer = ? ORDER BY first_at", id).toArray()
      .map((d) => ({ device: d.device, label: d.label, firstAt: d.first_at, lastAt: d.last_at, off: Boolean(d.off), role: d.role,
        repName: d.boss_name || d.rep_name, slotKey: d.slot_key || null, released: Boolean(d.released) }));
    const slots = this.sql.exec("SELECT key, n, name FROM team_slots WHERE buyer = ? ORDER BY n", id).toArray()
      .map((r) => ({ n: r.n, key: r.key, name: r.name || "", phone: all.find((d) => d.slotKey === r.key && !d.released) || null,
        used: all.some((d) => d.slotKey === r.key) }));
    const devices = all.filter((d) => d.role !== "boss"), bosses = all.filter((d) => d.role === "boss");
    return { id: b.id, name: b.name, kind: b.kind || "solo", devices: b.devices, amountCents: b.amount_cents, created: b.created, off: Boolean(b.off), phone: b.phone || "", email: b.email || "",
      phones: devices, active: devices.filter((d) => !d.off).length, bossKey: b.boss_key || null, bossPhones: bosses, bossPlaces: BOSS_PLACES, slots,
      invoices: b.kind === "team" ? this.sql.exec("SELECT COUNT(*) AS n FROM team_invoices WHERE buyer = ?", id).toArray()[0].n : 0,
      productCount: this.sql.exec("SELECT COUNT(*) AS n FROM company_products WHERE buyer = ?", id).toArray()[0].n,
      ...(() => {
        // Companies on Pro before reps were asked: their rep places (a solo business: 1 rep), so their price is unchanged.
        const reps = cleanReps(b.pro_reps) || (b.kind === "team" ? b.devices : 1);
        const price = proPrice(reps, Number(b.discount_pct) || 0);
        const notices = this.sql.exec("SELECT id, created, start_date, data FROM pro_notices WHERE buyer = ? ORDER BY created DESC LIMIT 20", id).toArray()
          .map((n) => ({ id: n.id, created: n.created, startDate: n.start_date, ...JSON.parse(n.data) }));
        return { notices, pro: Boolean(b.pro), discountPct: price.extraPct, proSince: b.pro_since || null, proReps: reps, proRepsSaved: cleanReps(b.pro_reps) !== null, proTierPct: price.tierPct, proTierLabel: price.tierLabel, proPrice: price, proMonthlyCents: price.netCents };
      })() };
  }

  /** Marlon Pro on or off for one company, and its discount (0–100 %). */
  setPro(id, pro, discountPct, reps = null, startDate = null) {
    const b = this.#buyer(id);
    if (!b) return null;
    const since = pro ? (b.pro ? b.proSince : new Date().toISOString()) : null;
    this.sql.exec("UPDATE buyers SET pro = ?, discount_pct = ?, pro_since = ?, pro_reps = COALESCE(?, pro_reps) WHERE id = ?", pro ? 1 : 0, discountPct, since, reps, id);
    // Switched on just now: a payment notice with the price agreed, kept in the company's record.
    const notice = pro && !b.pro ? this.proNotice(id, startDate) : null;
    return { buyer: this.#buyer(id), notice };
  }

  /** The customer's name (already checked). */
  renameBuyer(id, name) {
    if (!this.#buyer(id)) return null;
    this.sql.exec("UPDATE buyers SET name = ? WHERE id = ?", name, id);
    return this.#buyer(id);
  }

  /** The buyer's phone and email (already checked). */
  setBuyerContact(id, phone, email) {
    if (!this.#buyer(id)) return null;
    this.sql.exec("UPDATE buyers SET phone = ?, email = ? WHERE id = ?", phone, email, id);
    return this.#buyer(id);
  }

  /** A payment notice for a Pro company at its current price, starting on `startDate` (YYYY-MM-DD). Kept for good. */
  proNotice(id, startDate) {
    const b = this.#buyer(id);
    if (!b) return null;
    const start = DAY.test(startDate || "") ? startDate : todayUTC();
    const n = { id: randomHex(12), created: new Date().toISOString(), startDate: start, company: b.name, kind: b.kind, price: b.proPrice };
    this.sql.exec("INSERT INTO pro_notices (id, buyer, created, start_date, data) VALUES (?, ?, ?, ?, ?)", n.id, id, n.created, start,
      JSON.stringify({ company: n.company, kind: n.kind, price: n.price }));
    return n;
  }

  /** A shelf photo from a Pro company's active phone: counts it against today's limit. → { ok } | { error } */
  shelfAllow(key, device, phoneDay = null) {
    const b = this.#activePhone(key, device);
    if (!b) return { error: "off" };
    if (!b.pro) return { error: "notpro" };
    const list = this.#products(b.id);
    if (!list.length) return { error: "noproducts", team: b.kind === "team" };
    // "Today" is the phone's own date (so the limit resets at the rep's midnight), if it's within a day of the server's.
    const utc = todayUTC();
    const day = DAY.test(phoneDay || "") && phoneDay >= addDays(utc, -1) && phoneDay <= addDays(utc, 1) ? phoneDay : utc;
    const rep = b.kind === "team" ? device : "company";
    const n = this.sql.exec("SELECT n FROM shelf_rep_daily WHERE buyer = ? AND rep = ? AND day = ?", b.id, rep, day).toArray()[0]?.n || 0;
    if (n >= SHELF_REP_DAILY) return { error: "daily" };
    this.sql.exec("INSERT INTO shelf_rep_daily (buyer, rep, day, n) VALUES (?, ?, ?, 1) ON CONFLICT(buyer, rep, day) DO UPDATE SET n = n + 1", b.id, rep, day);
    this.sql.exec("DELETE FROM shelf_rep_daily WHERE day < ?", addDays(utc, -30));
    // The company's saved products (name and size), and the first photo of each as a reference (up to SHELF_REFS).
    const label = (p) => (p.size ? `${p.name} (${p.size})` : p.name);
    const refs = [];
    for (const p of list) {
      if (refs.length >= SHELF_REFS) break;
      const ph = this.sql.exec("SELECT image FROM product_photos WHERE buyer = ? AND product_id = ? ORDER BY created LIMIT 1", b.id, p.id).toArray()[0];
      if (ph) refs.push({ label: label(p), data: ph.image });
    }
    return { ok: true, products: list.map((p) => ({ id: p.id, label: label(p) })), refs };
  }

  // ── Marlon Pro · My Products ──────────────────────────────────────────────────────────────────────────────────
  #products(buyerId) {
    return this.sql.exec("SELECT id, name, size, price_cents, unit, position FROM company_products WHERE buyer = ? ORDER BY position, created", buyerId).toArray()
      .map((r) => ({ id: r.id, name: r.name, size: r.size, price: r.price_cents === null ? null : r.price_cents / 100, unit: r.unit }));
  }
  /** Who is asking: a company phone ({ key, device }) or a signed-in boss phone ({ boss }). Solo phones and bosses can edit. */
  #catalogWho(who, { edit = false } = {}) {
    let b = null;
    if (who?.boss) {
      const s = this.sql.exec("SELECT buyer, device FROM boss_sessions WHERE token = ? AND expires > ?", who.boss, Date.now()).toArray()[0];
      if (!s) return { error: "signin" };
      b = this.#buyer(s.buyer);
      if (!this.#bossDeviceOk(b, s.device)) return { error: "off" };
    } else {
      b = this.#activePhone(who?.key, who?.device);
      if (!b) return { error: "off" };
    }
    if (!b.pro) return { error: "notpro", b };
    const canEdit = Boolean(who?.boss) || b.kind !== "team";
    if (edit && !canEdit) return { error: "readonly" };
    return { b, canEdit };
  }
  #bumpCatalog(id) { this.sql.exec("UPDATE buyers SET catalog_ver = catalog_ver + 1 WHERE id = ?", id); }
  catalog(who) {
    const r = this.#catalogWho(who);
    if (r.error === "notpro") return { pro: false };
    if (r.error) return r;
    const photos = this.sql.exec("SELECT id, product_id, thumb FROM product_photos WHERE buyer = ? ORDER BY created", r.b.id).toArray();
    const ver = this.sql.exec("SELECT catalog_ver FROM buyers WHERE id = ?", r.b.id).toArray()[0].catalog_ver;
    return { pro: true, canEdit: r.canEdit, team: r.b.kind === "team", version: ver,
      products: this.#products(r.b.id).map((p) => ({ ...p, photos: photos.filter((x) => x.product_id === p.id).map((x) => ({ id: x.id, thumb: x.thumb })) })) };
  }
  catalogSave(who, p) {
    const r = this.#catalogWho(who, { edit: true });
    if (r.error) return r;
    const id = r.b.id, now = new Date().toISOString();
    const clash = this.sql.exec("SELECT id FROM company_products WHERE buyer = ? AND lower(name) = lower(?) AND lower(size) = lower(?) AND id != ?", id, p.name, p.size, p.id || "").toArray()[0];
    if (clash) return { error: "duplicate" };
    if (p.id) {
      if (!this.sql.exec("SELECT 1 FROM company_products WHERE buyer = ? AND id = ?", id, p.id).toArray().length) return { error: "unknown" };
      this.sql.exec("UPDATE company_products SET name = ?, size = ?, price_cents = ?, unit = ?, updated = ? WHERE buyer = ? AND id = ?", p.name, p.size, p.priceCents, p.unit, now, id, p.id);
    } else {
      const n = this.sql.exec("SELECT COUNT(*) AS n, COALESCE(MAX(position), 0) AS m FROM company_products WHERE buyer = ?", id).toArray()[0];
      if (n.n >= SHELF_MAX_PRODUCTS) return { error: "limit" };
      p.id = `cp_${randomHex(8)}`;
      this.sql.exec("INSERT INTO company_products (buyer, id, name, size, price_cents, unit, position, created, updated) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)", id, p.id, p.name, p.size, p.priceCents, p.unit, n.m + 1, now, now);
    }
    this.#bumpCatalog(id);
    return { ok: true, product: this.#products(id).find((x) => x.id === p.id) };
  }
  catalogDelete(who, productId) {
    const r = this.#catalogWho(who, { edit: true });
    if (r.error) return r;
    this.sql.exec("DELETE FROM product_photos WHERE buyer = ? AND product_id = ?", r.b.id, productId);
    this.sql.exec("DELETE FROM company_products WHERE buyer = ? AND id = ?", r.b.id, productId);
    this.#bumpCatalog(r.b.id);
    return { ok: true };
  }
  catalogPhoto(who, productId, image, thumb) {
    const r = this.#catalogWho(who, { edit: true });
    if (r.error) return r;
    if (!this.sql.exec("SELECT 1 FROM company_products WHERE buyer = ? AND id = ?", r.b.id, productId).toArray().length) return { error: "unknown" };
    if (this.sql.exec("SELECT COUNT(*) AS n FROM product_photos WHERE buyer = ? AND product_id = ?", r.b.id, productId).toArray()[0].n >= PRODUCT_PHOTOS) return { error: "photos" };
    const photo = { id: `ph_${randomHex(8)}`, thumb };
    this.sql.exec("INSERT INTO product_photos (buyer, product_id, id, image, thumb, created) VALUES (?, ?, ?, ?, ?, ?)", r.b.id, productId, photo.id, image, thumb, new Date().toISOString());
    this.#bumpCatalog(r.b.id);
    return { ok: true, photo };
  }
  catalogPhotoDelete(who, productId, photoId) {
    const r = this.#catalogWho(who, { edit: true });
    if (r.error) return r;
    this.sql.exec("DELETE FROM product_photos WHERE buyer = ? AND product_id = ? AND id = ?", r.b.id, productId, photoId);
    this.#bumpCatalog(r.b.id);
    return { ok: true };
  }
  catalogPhotoGet(who, photoId) {
    const r = this.#catalogWho(who);
    if (r.error) return r;
    const row = this.sql.exec("SELECT image FROM product_photos WHERE buyer = ? AND id = ?", r.b.id, photoId).toArray()[0]; // only this company's photos
    return row ? { ok: true, image: row.image } : { error: "unknown" };
  }
  /** A solo phone's own product list becomes My Products, once, while the company has none saved yet. */
  catalogSeed(who, list) {
    const r = this.#catalogWho(who, { edit: true });
    if (r.error) return r;
    if (r.b.kind === "team" || who?.boss) return { error: "readonly" };
    if (this.#products(r.b.id).length) return { ok: true, seeded: 0 };
    const now = new Date().toISOString(), seen = new Set();
    let pos = 0;
    for (const p of list.slice(0, SHELF_MAX_PRODUCTS)) {
      const k = p.name.toLowerCase();
      if (seen.has(k)) continue;
      seen.add(k);
      this.sql.exec("INSERT INTO company_products (buyer, id, name, size, price_cents, unit, position, created, updated) VALUES (?, ?, ?, '', ?, ?, ?, ?, ?)",
        r.b.id, `cp_${randomHex(8)}`, p.name, p.priceCents, p.unit, ++pos, now, now);
    }
    this.#bumpCatalog(r.b.id);
    return { ok: true, seeded: pos };
  }

  buyers() {
    const list = this.sql.exec("SELECT id FROM buyers ORDER BY created DESC").toArray().map((r) => this.#buyer(r.id));
    const totalCents = this.sql.exec("SELECT COALESCE(SUM(amount_cents), 0) AS t FROM buyers").toArray()[0].t;
    const proMonthly = list.filter((b) => b.pro && !b.off).reduce((t, b) => t + b.proMonthlyCents, 0);
    return { buyers: list, totalCents, proMonthlyCents: proMonthly, proRepCents: PRO_REP_CENTS, teamTiers: TIER_LABELS, contact: this.contact() };
  }

  /** Deletes a buyer or team completely: its phones, rep links, boss phones, passcode, sessions and team invoices. */
  deleteBuyer(id) {
    if (!this.#buyer(id)) return false;
    for (const t of ["buyer_devices", "team_slots", "team_invoices", "boss_paid", "boss_sessions", "team_credits", "shelf_daily", "shelf_rep_daily", "pro_notices", "team_orders", "company_products", "product_photos"]) this.sql.exec(`DELETE FROM ${t} WHERE buyer = ?`, id);
    this.sql.exec("DELETE FROM buyers WHERE id = ?", id);
    return true;
  }

  /** What's left anywhere for a buyer (used by the tests to prove a delete leaves nothing). */
  leftovers(id) {
    const n = (t, col = "buyer") => this.sql.exec(`SELECT COUNT(*) AS n FROM ${t} WHERE ${col} = ?`, id).toArray()[0].n;
    return { buyers: n("buyers", "id"), devices: n("buyer_devices"), slots: n("team_slots"), invoices: n("team_invoices"), paid: n("boss_paid"), sessions: n("boss_sessions"),
      credits: n("team_credits"), shelf: n("shelf_daily") + n("shelf_rep_daily"), notices: n("pro_notices"), orders: n("team_orders"), products: n("company_products"), photos: n("product_photos") };
  }

  setBuyerOff(id, off) {
    this.sql.exec("UPDATE buyers SET off = ? WHERE id = ?", off ? 1 : 0, id);
    return this.#buyer(id);
  }

  /** Switching a phone back on needs a free place (the buyer may have used it for another phone meanwhile). */
  setDeviceOff(id, device, off) {
    const b = this.#buyer(id);
    const boss = b?.bossPhones.find((x) => x.device === device);
    if (boss) {
      if (!off && boss.off && b.bossPhones.filter((x) => !x.off).length >= BOSS_PLACES) return { error: "full" };
      this.sql.exec("UPDATE buyer_devices SET off = ? WHERE buyer = ? AND device = ?", off ? 1 : 0, id, device);
      if (off) this.sql.exec("DELETE FROM boss_sessions WHERE buyer = ? AND device = ?", id, device);
      return { buyer: this.#buyer(id) };
    }
    const d = b?.phones.find((x) => x.device === device);
    if (!d) return { error: "unknown" };
    if (!off && d.off && b.active >= b.devices) return { error: "full" };
    if (!off && d.slotKey && !b.slots.some((x) => x.key === d.slotKey)) return { error: "replaced" };
    if (!off && d.released) return { error: "released" };
    this.sql.exec("UPDATE buyer_devices SET off = ? WHERE buyer = ? AND device = ?", off ? 1 : 0, id, device);
    return { buyer: this.#buyer(id) };
  }

  /**
   * A phone opening a personal link. All in one step (no waiting in between), so two phones can't both take the
   * last place. A phone already on the list keeps its place; a new one gets a free place or is turned away.
   */
  /** A link's key: a buyer's own link (solo, or a team made before personal rep links), or one rep's personal link. */
  #resolve(key) {
    const b = this.#buyer(key);
    if (b) return { b, slot: null };
    const s = this.sql.exec("SELECT buyer FROM team_slots WHERE key = ?", key).toArray()[0];
    return s ? { b: this.#buyer(s.buyer), slot: key } : { b: null, slot: null };
  }

  activate(key, device, label, { onlyKnown = false } = {}) {
    const { b, slot } = this.#resolve(key);
    const id = b?.id;
    if (!b) return { ok: false, reason: "unknown" };
    if (b.off) return { ok: false, reason: "off" };
    const now = new Date().toISOString();
    const d = b.phones.find((x) => x.device === device);
    if (d) {
      if (d.off) return { ok: false, reason: "off" };
      this.sql.exec("UPDATE buyer_devices SET last_at = ? WHERE buyer = ? AND device = ?", now, id, device);
      return { ok: true, team: b.kind === "team", company: b.kind === "team" ? b.name : "", pro: b.pro };
    }
    if (onlyKnown) return { ok: false, reason: "off" };
    // A rep's personal link belongs to the first phone that opened it: any other phone is turned away.
    // (A rep the boss switched off has "released" the link: the next phone may take it.)
    if (slot && b.phones.some((x) => x.slotKey === slot && !x.released)) return { ok: false, reason: "full" };
    if (b.active >= b.devices) return { ok: false, reason: "full" };
    const slotName = slot ? b.slots.find((x) => x.key === slot)?.name || "" : "";
    this.sql.exec("INSERT INTO buyer_devices (buyer, device, label, first_at, last_at, slot_key, boss_name) VALUES (?, ?, ?, ?, ?, ?, ?)", id, device, label, now, now, slot, slotName);
    return { ok: true, team: b.kind === "team", company: b.kind === "team" ? b.name : "", repName: slotName, pro: b.pro };
  }

  /** What a link is, without using it up (shown before switching a phone to it). */
  linkInfo(key) {
    const { b, slot } = this.#resolve(key);
    if (!b) return { ok: false };
    const n = slot ? b.slots.find((x) => x.key === slot)?.n : null;
    return { ok: true, kind: b.kind, company: b.kind === "team" ? b.name : "", rep: n ?? null };
  }

  // ── Teams: reps send their invoices; the boss sees them all ───────────

  /** Invoices from a rep phone (saved there first). Only an active rep of an active team; the same id overwrites. */
  /** A new personal link for rep n; the old link stops working and the phone on it is switched off. */
  replaceRepLink(id, n) {
    const row = this.sql.exec("SELECT key FROM team_slots WHERE buyer = ? AND n = ?", id, n).toArray()[0];
    if (!row) return null;
    const key = randomHex(16);
    this.sql.exec("UPDATE buyer_devices SET off = 1 WHERE buyer = ? AND slot_key = ?", id, row.key);
    this.sql.exec("DELETE FROM team_slots WHERE key = ?", row.key);
    this.sql.exec("INSERT INTO team_slots (key, buyer, n, created) VALUES (?, ?, ?, ?)", key, id, n, new Date().toISOString());
    return { key, buyer: this.#buyer(id) };
  }

  teamSync(key, device, repName, invoices, credits = [], orders = []) {
    const { b } = this.#resolve(key);
    const id = b?.id;
    if (!b || b.kind !== "team") return { ok: false, reason: "unknown" };
    const d = b.phones.find((x) => x.device === device);
    if (b.off || !d || d.off) return { ok: false, reason: "off" };
    const now = new Date().toISOString();
    this.sql.exec("UPDATE buyer_devices SET last_at = ?, rep_name = ? WHERE buyer = ? AND device = ?", now, repName, id, device);
    const stored = [];
    const bossPaid = new Map(this.sql.exec("SELECT id, paid_at FROM boss_paid WHERE buyer = ?", id).toArray().map((r) => [r.id, r.paid_at]));
    for (const inv of invoices) {
      // The boss marked it paid: an older "not paid" copy from the phone never undoes that.
      if (bossPaid.has(inv.id) && inv.payment?.status !== "paid") {
        inv.payment = { ...(inv.payment || { method: "boss", termsDays: null, dueDate: "" }), status: "paid", paidAt: bossPaid.get(inv.id), markedBy: "boss" };
      }
      this.sql.exec(`INSERT INTO team_invoices (buyer, device, id, data, updated) VALUES (?, ?, ?, ?, ?)
        ON CONFLICT(buyer, id) DO UPDATE SET data = excluded.data, updated = excluded.updated, device = excluded.device`, id, device, inv.id, JSON.stringify(inv), now);
      stored.push(inv.id);
    }
    const storedCredits = [];
    for (const cn of credits) {
      this.sql.exec(`INSERT INTO team_credits (buyer, device, id, data, updated) VALUES (?, ?, ?, ?, ?)
        ON CONFLICT(buyer, id) DO UPDATE SET data = excluded.data, updated = excluded.updated, device = excluded.device`, id, device, cn.id, JSON.stringify(cn), now);
      storedCredits.push(cn.id);
    }
    // Shelf orders: Marlon Pro only (the name and signature arrive already encrypted in `sealed`).
    const storedOrders = [];
    if (b.pro) {
      for (const { order, sealed } of orders) {
        this.sql.exec(`INSERT INTO team_orders (buyer, device, id, data, sealed, updated) VALUES (?, ?, ?, ?, ?, ?)
          ON CONFLICT(buyer, id) DO UPDATE SET data = excluded.data, sealed = excluded.sealed, updated = excluded.updated, device = excluded.device`, id, device, order.id, JSON.stringify(order), sealed, now);
        storedOrders.push(order.id);
      }
    }
    // What the boss marked paid on this phone's invoices, so the phone shows it too.
    const paid = this.sql.exec("SELECT p.id, p.paid_at FROM boss_paid p JOIN team_invoices t ON t.buyer = p.buyer AND t.id = p.id WHERE p.buyer = ? AND t.device = ?", id, device)
      .toArray().map((r) => ({ id: r.id, paidAt: r.paid_at }));
    return { ok: true, stored, storedCredits, storedOrders, paid };
  }

  /** The boss ticks an invoice as paid (the only change the boss can make). */
  bossMarkPaid(token, invoiceId) {
    const s = this.sql.exec("SELECT buyer, device FROM boss_sessions WHERE token = ? AND expires > ?", token, Date.now()).toArray()[0];
    if (!s) return { error: "signin" };
    const b = this.#buyer(s.buyer);
    if (!this.#bossDeviceOk(b, s.device)) return { error: "off" };
    const row = this.sql.exec("SELECT data FROM team_invoices WHERE buyer = ? AND id = ?", b.id, invoiceId).toArray()[0];
    if (!row) return { error: "unknown" };
    const inv = JSON.parse(row.data);
    if (inv.payment?.status === "paid") return { ok: true, invoice: inv };
    const paidAt = new Date().toISOString();
    this.sql.exec("INSERT OR IGNORE INTO boss_paid (buyer, id, paid_at) VALUES (?, ?, ?)", b.id, invoiceId, paidAt);
    inv.payment = { ...(inv.payment || { method: "boss", termsDays: null, dueDate: "" }), status: "paid", paidAt, markedBy: "boss" };
    this.sql.exec("UPDATE team_invoices SET data = ? WHERE buyer = ? AND id = ?", JSON.stringify(inv), b.id, invoiceId);
    return { ok: true, invoice: inv };
  }

  #bossBuyer(bossKey) {
    const r = this.sql.exec("SELECT id FROM buyers WHERE boss_key = ?", bossKey).toArray()[0];
    return r ? this.#buyer(r.id) : null;
  }

  /** The boss's phone opening the boss link (BOSS_PLACES phones: on iPhone, Safari and the Home Screen count apart). */
  bossActivate(bossKey, device, label) {
    const b = this.#bossBuyer(bossKey);
    if (!b) return { ok: false, reason: "unknown" };
    if (b.off) return { ok: false, reason: "off" };
    const d = b.bossPhones.find((x) => x.device === device);
    const now = new Date().toISOString();
    const claimed = Boolean(this.sql.exec("SELECT boss_hash FROM buyers WHERE id = ?", b.id).toArray()[0].boss_hash);
    if (d) {
      if (d.off) return { ok: false, reason: "off" };
      this.sql.exec("UPDATE buyer_devices SET last_at = ? WHERE buyer = ? AND device = ?", now, b.id, device);
      return { ok: true, claimed, company: b.name };
    }
    if (b.bossPhones.filter((x) => !x.off).length >= BOSS_PLACES) return { ok: false, reason: "full" };
    this.sql.exec("INSERT INTO buyer_devices (buyer, device, label, first_at, last_at, role) VALUES (?, ?, ?, ?, ?, 'boss')", b.id, device, label, now, now);
    return { ok: true, claimed, company: b.name };
  }

  #bossDeviceOk(b, device) { const d = b?.bossPhones.find((x) => x.device === device); return Boolean(b && !b.off && d && !d.off); }

  bossPasscode(bossKey, device, passcode, claim) {
    return this.ctx.blockConcurrencyWhile(async () => {
      const b = this.#bossBuyer(bossKey);
      if (!this.#bossDeviceOk(b, device)) return { error: "off" };
      const row = this.sql.exec("SELECT boss_salt, boss_hash, boss_fails FROM buyers WHERE id = ?", b.id).toArray()[0];
      const now = Date.now();
      if (claim) {
        if (row.boss_hash) return { error: "taken" };
        const salt = randomHex(16);
        this.sql.exec("UPDATE buyers SET boss_salt = ?, boss_hash = ?, boss_fails = '[]' WHERE id = ?", salt, await hashPasscode(passcode, salt), b.id);
      } else {
        const fails = JSON.parse(row.boss_fails || "[]").filter((t) => now - t < 15 * 60 * 1000);
        if (fails.length >= 5) return { error: "wait", retryAfter: Math.ceil((15 * 60 * 1000 - (now - fails[0])) / 1000) };
        if (!row.boss_hash) return { error: "unclaimed" };
        if (!sameText(await hashPasscode(passcode, row.boss_salt), row.boss_hash)) {
          fails.push(now);
          this.sql.exec("UPDATE buyers SET boss_fails = ? WHERE id = ?", JSON.stringify(fails), b.id);
          return { error: "wrong", left: Math.max(0, 5 - fails.length) };
        }
        this.sql.exec("UPDATE buyers SET boss_fails = '[]' WHERE id = ?", b.id);
      }
      const token = randomHex(32);
      this.sql.exec("DELETE FROM boss_sessions WHERE expires < ?", now);
      this.sql.exec("INSERT INTO boss_sessions (token, buyer, device, expires) VALUES (?, ?, ?, ?)", token, b.id, device, now + 12 * 60 * 60 * 1000);
      return { token };
    });
  }

  /** Everything the boss dashboard shows, for a signed-in boss phone that's still switched on. */
  async bossData(token) {
    const s = this.sql.exec("SELECT buyer, device FROM boss_sessions WHERE token = ? AND expires > ?", token, Date.now()).toArray()[0];
    if (!s) return { error: "signin" };
    const b = this.#buyer(s.buyer);
    if (!this.#bossDeviceOk(b, s.device)) return { error: "off" };
    // Shelf orders (Pro): who ordered is decrypted for the list; the signature itself comes on demand (order-signature).
    const orders = [];
    if (b.pro) {
      for (const r of this.sql.exec("SELECT device, data, sealed, updated FROM team_orders WHERE buyer = ?", b.id).toArray()) {
        let signer = "";
        try { signer = JSON.parse(await unseal(this.env, r.sealed)).signer || ""; } catch { /* key changed: the name can't be read */ }
        orders.push({ ...JSON.parse(r.data), signer, rep: r.device, receivedAt: r.updated });
      }
    }
    const invoices = this.sql.exec("SELECT device, data, updated FROM team_invoices WHERE buyer = ?", b.id).toArray()
      .map((r) => ({ ...JSON.parse(r.data), rep: r.device, receivedAt: r.updated }));
    const credits = b.pro ? this.sql.exec("SELECT device, data, updated FROM team_credits WHERE buyer = ?", b.id).toArray()
      .map((r) => ({ ...JSON.parse(r.data), rep: r.device, receivedAt: r.updated })) : [];
    return { company: b.name, places: b.devices, slots: this.#bossSlots(b), pro: b.pro, credits, orders,
      reps: b.phones.map((d, i) => ({ device: d.device, name: d.repName || `Rep ${i + 1}`, label: d.label, off: d.off, lastSeen: d.lastAt })), invoices };
  }

  bossLogout(token) { this.sql.exec("DELETE FROM boss_sessions WHERE token = ?", token); }

  /** One shelf order's signature and the orderer's name, for a signed-in boss phone (Pro only). */
  async bossOrderSignature(token, orderId) {
    const s = this.sql.exec("SELECT buyer, device FROM boss_sessions WHERE token = ? AND expires > ?", token, Date.now()).toArray()[0];
    if (!s) return { error: "signin" };
    const b = this.#buyer(s.buyer);
    if (!this.#bossDeviceOk(b, s.device)) return { error: "off" };
    if (!b.pro) return { error: "unknown" };
    const row = this.sql.exec("SELECT sealed FROM team_orders WHERE buyer = ? AND id = ?", b.id, orderId).toArray()[0];
    if (!row) return { error: "unknown" };
    try { const x = JSON.parse(await unseal(this.env, row.sealed)); return { signer: x.signer || "", signature: x.signature || "", signedAt: x.signedAt || "" }; }
    catch { return { error: "unreadable" }; }
  }

  #bossSession(token) {
    const s = this.sql.exec("SELECT buyer, device FROM boss_sessions WHERE token = ? AND expires > ?", token, Date.now()).toArray()[0];
    if (!s) return { error: "signin" };
    const b = this.#buyer(s.buyer);
    if (!this.#bossDeviceOk(b, s.device)) return { error: "off" };
    return { b };
  }

  /** The boss's reps: one row per rep place the company paid for (the boss can't make more). */
  #bossSlots(b) {
    return b.slots.map((x) => ({ n: x.n, key: x.key, name: x.name || x.phone?.repName || "", used: x.used,
      phone: x.phone ? { label: x.phone.label, since: x.phone.firstAt, lastSeen: x.phone.lastAt, off: x.phone.off } : null }));
  }

  /** "Add rep": gives a name to a free rep place (place n, or the first free one) and returns its link. */
  bossAddRep(token, name, n = null) {
    const { b, error } = this.#bossSession(token);
    if (error) return { error };
    if (!b.slots.length) return { error: "legacy" };
    const free = (x) => !x.name && !x.phone;
    const slot = n ? b.slots.find((x) => x.n === n && free(x)) : b.slots.find(free);
    if (!slot) return { error: "full", places: b.devices };
    this.sql.exec("UPDATE team_slots SET name = ? WHERE key = ?", name, slot.key);
    return { ok: true, n: slot.n, key: slot.key, slots: this.#bossSlots(this.#buyer(b.id)) };
  }

  /**
   * "Switch off" a rep (e.g. they left): their phone stops working and the place — the same link — is free for a
   * new rep. Their invoices stay, under their name.
   */
  bossRepOff(token, n) {
    const { b, error } = this.#bossSession(token);
    if (error) return { error };
    const slot = b.slots.find((x) => x.n === n);
    if (!slot) return { error: "unknown" };
    this.sql.exec("UPDATE buyer_devices SET off = 1, released = 1 WHERE buyer = ? AND slot_key = ? AND released = 0", b.id, slot.key);
    this.sql.exec("UPDATE team_slots SET name = '' WHERE key = ?", slot.key);
    return { ok: true, slots: this.#bossSlots(this.#buyer(b.id)) };
  }

  stats() {
    const today = todayUTC();
    const one = (q, ...a) => this.sql.exec(q, ...a).toArray()[0] || {};
    const days = Array.from({ length: 30 }, (_, k) => addDays(today, k - 29));
    const byDay = new Map(days.map((d) => [d, { day: d, active: 0, invoices: 0, setups: 0 }]));
    for (const r of this.sql.exec("SELECT day, COUNT(*) AS n FROM active WHERE day >= ? GROUP BY day", days[0]).toArray()) if (byDay.has(r.day)) byDay.get(r.day).active = r.n;
    for (const r of this.sql.exec("SELECT day, kind, n FROM daily WHERE day >= ? AND kind IN ('invoice', 'setup')", days[0]).toArray()) {
      if (byDay.has(r.day)) byDay.get(r.day)[r.kind === "invoice" ? "invoices" : "setups"] = r.n;
    }
    const totals = Object.fromEntries(KINDS.map((k) => [k, 0]));
    for (const r of this.sql.exec("SELECT kind, SUM(n) AS n FROM daily GROUP BY kind").toArray()) totals[r.kind] = r.n;
    const last30 = Object.fromEntries(KINDS.map((k) => [k, 0]));
    for (const r of this.sql.exec("SELECT kind, SUM(n) AS n FROM daily WHERE day >= ? GROUP BY kind", days[0]).toArray()) last30[r.kind] = r.n;
    return {
      today,
      businesses: one("SELECT COUNT(*) AS n FROM phones WHERE setup_day IS NOT NULL").n || 0,
      phones: one("SELECT COUNT(*) AS n FROM phones").n || 0,
      activeToday: one("SELECT COUNT(*) AS n FROM active WHERE day = ?", today).n || 0,
      active7: one("SELECT COUNT(DISTINCT id) AS n FROM active WHERE day >= ?", addDays(today, -6)).n || 0,
      active30: one("SELECT COUNT(DISTINCT id) AS n FROM active WHERE day >= ?", days[0]).n || 0,
      totals, last30, days: [...byDay.values()], passcodeSince: this.#meta("since"),
    };
  }
}

const json = (data, status = 200, extra = {}) => new Response(JSON.stringify(data), {
  status, headers: { "Content-Type": "application/json", "Cache-Control": "no-store", "X-Content-Type-Options": "nosniff", ...extra },
});

async function readJson(request, limit = 8192) {
  const text = await request.text();
  if (text.length > limit) throw new Error("too big");
  return JSON.parse(text || "{}");
}

async function api(request, env, path) {
  if (!env.STATS) return json({ error: "The maker's counts aren't set up on this server." }, 503);
  const stub = env.STATS.get(env.STATS.idFromName("all"));
  if (path === "/api/ping") {
    if (request.method !== "POST") return json({ error: "POST only" }, 405);
    let body;
    try { body = await readJson(request, 6000); } catch { return json({ error: "bad request" }, 400); }
    const device = typeof body.device === "string" && /^[a-z0-9-]{8,64}$/i.test(body.device) ? body.device.toLowerCase() : null;
    const events = Array.isArray(body.events) ? body.events.slice(0, 50).filter((e) => e && KINDS.includes(e.kind)).map((e) => ({ kind: e.kind, day: String(e.day || "") })) : [];
    if (!device || !events.length) return json({ error: "bad request" }, 400);
    await stub.record(device, events);
    return new Response(null, { status: 204, headers: { "Cache-Control": "no-store" } });
  }
  if (path === "/api/console/state" && request.method === "GET") return json(await stub.state());
  if (path === "/api/console/claim" || path === "/api/console/login") {
    if (request.method !== "POST") return json({ error: "POST only" }, 405);
    let body;
    try { body = await readJson(request, 1000); } catch { return json({ error: "bad request" }, 400); }
    const passcode = typeof body.passcode === "string" ? body.passcode : "";
    if (passcode.length < 8 || passcode.length > 200) return json({ error: "The passcode needs at least 8 characters." }, 400);
    const r = path.endsWith("claim") ? await stub.claim(passcode) : await stub.login(passcode);
    if (r.token) return json({ token: r.token });
    if (r.error === "taken") return json({ error: "A passcode is already set. Enter it to open the console." }, 409);
    if (r.error === "unclaimed") return json({ error: "No passcode is set yet." }, 409);
    if (r.error === "wait") return json({ error: "Too many wrong tries. Wait a few minutes, then try again.", retryAfter: r.retryAfter }, 429, { "Retry-After": String(r.retryAfter) });
    return json({ error: `That passcode isn't right.${r.left ? ` ${r.left} more tr${r.left === 1 ? "y" : "ies"} before a short wait.` : ""}` }, 401);
  }
  if (path === "/api/activate" || path === "/api/check") {
    if (request.method !== "POST") return json({ error: "POST only" }, 405);
    let body;
    try { body = await readJson(request, 1000); } catch { return json({ error: "bad request" }, 400); }
    const key = typeof body.key === "string" && /^[0-9a-f]{32}$/.test(body.key) ? body.key : null;
    const device = typeof body.device === "string" && /^[0-9a-f]{32}$/.test(body.device) ? body.device : null;
    if (!key || !device) return json({ ok: false, reason: "unknown", contact: await stub.contact() }, 403);
    const r = await stub.activate(key, device, deviceLabel(request.headers.get("User-Agent") || ""), { onlyKnown: path === "/api/check" });
    return r.ok ? json({ ok: true, team: Boolean(r.team), company: r.company || "", repName: r.repName || "", pro: Boolean(r.pro) }) : json({ ok: false, reason: r.reason, contact: await stub.contact() }, 403);
  }
  if (path === "/api/contact" && request.method === "GET") return json({ contact: await stub.contact() });
  if (path === "/api/link-info" && request.method === "POST") {
    let body;
    try { body = await readJson(request, 500); } catch { return json({ ok: false }, 400); }
    const key = typeof body.key === "string" && /^[0-9a-f]{32}$/.test(body.key) ? body.key : null;
    return json(key ? await stub.linkInfo(key) : { ok: false });
  }

  // Teams.
  const hex32 = (v) => (typeof v === "string" && /^[0-9a-f]{32}$/.test(v) ? v : null);

  // Web push for seller phones (alerts when an invoice is signed, even with Marlon closed).
  if (path === "/api/push/key" && request.method === "GET") {
    const r = await stub.pushKey();
    return r.error ? json({ error: "Alerts aren't set up on this server yet." }, 503) : json(r);
  }
  if ((path === "/api/push/subscribe" || path === "/api/push/unsubscribe") && request.method === "POST") {
    let body;
    try { body = await readJson(request, 4000); } catch { return json({ error: "bad request" }, 400); }
    const key = hex32(body.key), device = hex32(body.device), sub = body.subscription || {};
    if (!key || !device) return json({ error: "This phone isn't set up for alerts." }, 400);
    const endpoint = typeof sub.endpoint === "string" && sub.endpoint.length < 1000 ? sub.endpoint : "";
    if (!pushEndpointOk(endpoint, { allowLocal: env.ALLOW_TEST_CLOCK === "1" })) return json({ error: "That isn't a push service this server can use." }, 400);
    let r;
    if (path === "/api/push/unsubscribe") r = await stub.pushUnsubscribe(key, device, endpoint);
    else {
      const p256dh = sub.keys?.p256dh, auth = sub.keys?.auth, b64u = (v, n) => typeof v === "string" && new RegExp(`^[A-Za-z0-9_-]{${n}}$`).test(v);
      if (!b64u(p256dh, 87) || !b64u(auth, 22)) return json({ error: "That subscription is missing its keys." }, 400);
      r = await stub.pushSubscribe(key, device, { endpoint, keys: { p256dh, auth } });
    }
    if (r.error === "off") return json({ error: "This phone is switched off." }, 403);
    if (r.error === "setup") return json({ error: "Alerts aren't set up on this server yet." }, 503);
    return json({ ok: true });
  }

  // Send for signature. The seller's phone proves itself with its personal link key + phone id; the buyer has only the
  // secret link. The buyer can send nothing but a name and a signature for the exact copy they saw.
  if (path.startsWith("/api/sign/") && request.method === "POST") {
    let body;
    try { body = await readJson(request, path === "/api/sign/submit" ? 300000 : 400000); } catch { return json({ error: "That request was too big or not readable." }, 400); }
    const token = typeof body.token === "string" && /^[0-9a-f]{64}$/.test(body.token) ? body.token : null;
    const sealed = (r) => (r.error === "setup" ? json({ error: "Sending for signature isn't set up on this server yet." }, 503) : null);
    const gone = { unknown: [404, "This link doesn't exist. Check you have the whole link, or ask the seller to send it again."],
      expired: [410, "This link has expired. Ask the seller to send it again."], replaced: [410, "The seller sent a newer link for this invoice. Use the newest one they sent you."],
      cancelled: [410, "The seller cancelled this link. Ask them to send it again."], changed: [409, "This invoice isn't the one that was sent. Reload the page and try again."] };
    // Tests only (ALLOW_TEST_CLOCK=1, never on the live site): "now" can be moved forward to check the 7-day expiry.
    const testNow = env.ALLOW_TEST_CLOCK === "1" && /^\d{13}$/.test(request.headers.get("X-Test-Now") || "") ? Number(request.headers.get("X-Test-Now")) : undefined;
    const answer = (r) => (gone[r.state] ? json({ state: r.state, error: gone[r.state][1], seller: r.seller || "" }, gone[r.state][0]) : json(r));
    if (path === "/api/sign/create") {
      const key = hex32(body.key), device = hex32(body.device);
      if (!key || !device) return json({ error: "This phone isn't set up for sending." }, 400);
      const c = cleanSignInvoice(body.invoice);
      if (c.error) return json({ error: c.error }, 400);
      const r = await stub.signCreate(key, device, c.inv);
      if (r.error === "off") return json({ error: "This phone is switched off.", contact: await stub.contact() }, 403);
      if (r.error === "signed") return json({ error: "This invoice is already signed, so it can't be sent again or changed." }, 409);
      if (r.error === "limit") return json({ error: "That's a lot of links today. Please try again tomorrow." }, 429);
      return sealed(r) || json({ ok: true, token: r.token, expires: r.expires, digest: r.digest, invoice: c.inv });
    }
    if (path === "/api/sign/view") {
      if (!token) return answer({ state: "unknown" });
      return answer(await stub.signView(token, testNow));
    }
    if (path === "/api/sign/submit") {
      const extra = Object.keys(body).filter((k) => !["token", "name", "signature", "digest"].includes(k));
      if (extra.length) return json({ error: "Only your name and signature can be sent. The invoice itself can't be changed." }, 400);
      if (!token) return answer({ state: "unknown" });
      const name = typeof body.name === "string" ? body.name.replace(/\s+/g, " ").trim() : "";
      if (name.length < 2 || name.length > 80) return json({ error: "Please type your full name." }, 400);
      const sig = typeof body.signature === "string" ? body.signature : "";
      let png = false;
      try { png = sig.length < 280000 && sig.startsWith("data:image/png;base64,") && atob(sig.slice(22, 54)).startsWith("\x89PNG"); } catch { png = false; }
      if (!png) return json({ error: "Please sign in the box first." }, 400);
      if (typeof body.digest !== "string" || !/^[0-9a-f]{64}$/.test(body.digest)) return answer({ state: "changed" });
      return answer(await stub.signSubmit(token, name, sig, body.digest, testNow, new URL(request.url).origin));
    }
    if (path === "/api/sign/status" || path === "/api/sign/cancel") {
      const key = hex32(body.key), device = hex32(body.device);
      if (!key || !device) return json({ error: "This phone isn't set up for sending." }, 400);
      const id = (v) => (typeof v === "string" && /^[A-Za-z0-9_-]{1,64}$/.test(v) ? v : null);
      const r = path === "/api/sign/status" ? await stub.signStatus(key, device, (Array.isArray(body.ack) ? body.ack : []).slice(0, 200).map(id).filter(Boolean), testNow)
        : await stub.signCancel(key, device, id(body.invoiceId) || "");
      if (r.error === "off") return json({ error: "This phone is switched off." }, 403);
      if (r.error === "signed") return json({ error: "This invoice is signed, so its link can't be cancelled." }, 409);
      return json(r);
    }
    return json({ error: "Not found" }, 404);
  }
  if (path === "/api/team/sync" && request.method === "POST") {
    let body;
    try { body = await readJson(request, 1000000); } catch { return json({ error: "too big or not JSON" }, 400); }
    const key = hex32(body.key), device = hex32(body.device);
    const list = Array.isArray(body.invoices) ? body.invoices.slice(0, 50) : null;
    if (!key || !device || !list) return json({ ok: false, reason: "unknown" }, 400);
    const clean = list.map(cleanInvoice).filter(Boolean);
    const credits = (Array.isArray(body.credits) ? body.credits.slice(0, 50) : []).map(cleanCreditNote).filter(Boolean);
    // Shelf orders: the orderer's name and signature are encrypted here, before they're stored.
    const orders = [];
    if (SIGN_KEY_OK(env)) {
      for (const c of (Array.isArray(body.orders) ? body.orders.slice(0, 10) : []).map(cleanOrder).filter(Boolean)) orders.push({ order: c.order, sealed: await seal(env, JSON.stringify(c.secret)) });
    }
    const r = await stub.teamSync(key, device, String(body.rep || "").replace(/\s+/g, " ").trim().slice(0, 60), clean, credits, orders);
    return r.ok ? json({ ok: true, stored: r.stored, storedCredits: r.storedCredits, storedOrders: r.storedOrders, paid: r.paid }) : json({ ok: false, reason: r.reason, contact: await stub.contact() }, 403);
  }
  if (path === "/api/pro/shelf" && request.method === "POST") {
    let body;
    try { body = await readJson(request, 3_000_000); } catch { return json({ error: "That photo is too big. Try again." }, 400); }
    const key = hex32(body.key), device = hex32(body.device);
    if (!key || !device) return json({ error: "This phone isn't set up for Pro." }, 400);
    const mime = body.mime === "image/png" ? "image/png" : body.mime === "image/webp" ? "image/webp" : "image/jpeg";
    const image = typeof body.image === "string" && body.image.length > 100 && body.image.length < 2_900_000 && /^[A-Za-z0-9+/=]+$/.test(body.image) ? body.image : null;
    if (!image) return json({ error: "That photo couldn't be read. Take it again." }, 400);
    // Matched ONLY against the company's saved products (My Products), never names sent by the phone.
    const allow = await stub.shelfAllow(key, device, typeof body.today === "string" ? body.today : null);
    if (allow.error === "off") return json({ error: "This phone is switched off.", contact: await stub.contact() }, 403);
    if (allow.error === "notpro") return json({ error: "Shelf photo is part of Marlon Pro. Ask the seller to switch Pro on for your company." }, 403);
    if (allow.error === "noproducts") return json({ error: allow.team ? "Your boss needs to add your company's products in My Products first." : "Add your products in My Products first (dashboard → Pro), so Marlon knows what to look for." }, 400);
    if (allow.error === "daily") return json({ error: `You've reached today's ${SHELF_REP_DAILY} shelf checks. More are available tomorrow.` }, 429);
    const r = await shelfCount(env, { image, mime, products: allow.products, refs: allow.refs });
    if (r.error === "setup") return json({ error: r.message }, 503);
    if (r.error === "limit") return json({ error: r.message }, 429);
    if (r.error) return json({ error: r.message }, 502);
    return json({ ok: true, found: r.found, unknown: r.unknown });
  }
  if (path.startsWith("/api/pro/products") && request.method === "POST") {
    let body;
    try { body = await readJson(request, 600000); } catch { return json({ error: "That's too big. Try a smaller photo." }, 400); }
    const bearer = (request.headers.get("Authorization") || "").replace(/^Bearer\s+/i, "");
    const who = body.key ? { key: hex32(body.key), device: hex32(body.device) } : { boss: bearer };
    const txt = (v, n) => String(v ?? "").replace(/\s+/g, " ").trim().slice(0, n);
    const oid = (v) => (typeof v === "string" && /^[A-Za-z0-9_-]{1,64}$/.test(v) ? v : null);
    const jpeg = (v, max) => (typeof v === "string" && v.length > 100 && v.length < max && /^[A-Za-z0-9+/=]+$/.test(v) ? v : null);
    const sub = path.slice("/api/pro/products".length);
    let r;
    if (sub === "") r = await stub.catalog(who);
    else if (sub === "/save") {
      const p = body.product || {};
      const name = txt(p.name, 80), size = txt(p.size, 40);
      if (!name) return json({ error: "Type the product's name." }, 400);
      const price = p.price === null || p.price === undefined || p.price === "" ? null : Number(String(p.price).replace(/[$,\s]/g, ""));
      if (price !== null && (!Number.isFinite(price) || price < 0 || price > 1e7)) return json({ error: "The price should be a number, like 2.50." }, 400);
      r = await stub.catalogSave(who, { id: p.id ? oid(p.id) : null, name, size, priceCents: price === null ? null : Math.round(price * 100), unit: normalizeUnit(p.unit) });
    } else if (sub === "/delete") r = await stub.catalogDelete(who, oid(body.id) || "");
    else if (sub === "/photo") {
      const image = jpeg(body.image, 400000), thumb = jpeg(body.thumb, 30000);
      if (!image || !thumb) return json({ error: "That photo couldn't be used. Take it again." }, 400);
      r = await stub.catalogPhoto(who, oid(body.productId) || "", image, thumb);
    } else if (sub === "/photo-delete") r = await stub.catalogPhotoDelete(who, oid(body.productId) || "", oid(body.photoId) || "");
    else if (sub === "/photo-get") r = await stub.catalogPhotoGet(who, oid(body.photoId) || "");
    else if (sub === "/seed") {
      const list = (Array.isArray(body.products) ? body.products : []).map((x) => {
        const price = x?.price === null || x?.price === undefined ? null : Number(x.price);
        return { name: txt(x?.name, 80), priceCents: Number.isFinite(price) && price >= 0 ? Math.round(price * 100) : null, unit: normalizeUnit(x?.unit) };
      }).filter((x) => x.name);
      r = await stub.catalogSeed(who, list);
    } else return json({ error: "Not found" }, 404);
    if (r.error === "signin") return json({ error: "Please enter your passcode again." }, 401);
    if (r.error === "off") return json({ error: "This phone's access has been switched off.", contact: await stub.contact() }, 403);
    if (r.error === "notpro") return json({ error: "My Products is part of Marlon Pro. Ask the seller to switch Pro on for your company." }, 403);
    if (r.error === "readonly") return json({ error: "Your boss manages your company's products." }, 403);
    if (r.error === "duplicate") return json({ error: "You already have a product with that name and size." }, 409);
    if (r.error === "limit") return json({ error: `A company can save up to ${SHELF_MAX_PRODUCTS} products.` }, 409);
    if (r.error === "photos") return json({ error: `Each product can have up to ${PRODUCT_PHOTOS} photos. Delete one first.` }, 409);
    if (r.error === "unknown") return json({ error: "That product or photo isn't in your company's list." }, 404);
    return json(r);
  }
  if (path === "/api/boss/activate" && request.method === "POST") {
    let body;
    try { body = await readJson(request, 1000); } catch { return json({ error: "bad request" }, 400); }
    const boss = hex32(body.boss), device = hex32(body.device);
    if (!boss || !device) return json({ ok: false, reason: "unknown", contact: await stub.contact() }, 403);
    const r = await stub.bossActivate(boss, device, deviceLabel(request.headers.get("User-Agent") || ""));
    return r.ok ? json(r) : json({ ok: false, reason: r.reason, contact: await stub.contact() }, 403);
  }
  if ((path === "/api/boss/claim" || path === "/api/boss/login") && request.method === "POST") {
    let body;
    try { body = await readJson(request, 1000); } catch { return json({ error: "bad request" }, 400); }
    const boss = hex32(body.boss), device = hex32(body.device);
    const passcode = typeof body.passcode === "string" ? body.passcode : "";
    if (!boss || !device) return json({ error: "bad request" }, 400);
    if (passcode.length < 6 || passcode.length > 200) return json({ error: "The passcode needs at least 6 characters." }, 400);
    const r = await stub.bossPasscode(boss, device, passcode, path.endsWith("claim"));
    if (r.token) return json({ token: r.token });
    if (r.error === "off") return json({ error: "This phone's access has been switched off.", reason: "off", contact: await stub.contact() }, 403);
    if (r.error === "taken") return json({ error: "A boss passcode is already set. Enter it to open the dashboard." }, 409);
    if (r.error === "unclaimed") return json({ error: "No boss passcode is set yet." }, 409);
    if (r.error === "wait") return json({ error: "Too many wrong tries. Wait a few minutes, then try again." }, 429, { "Retry-After": String(r.retryAfter) });
    return json({ error: `That passcode isn't right.${r.left ? ` ${r.left} more tr${r.left === 1 ? "y" : "ies"} before a short wait.` : ""}` }, 401);
  }
  const bossToken = (request.headers.get("Authorization") || "").replace(/^Bearer\s+/i, "");
  if (path === "/api/boss/data" && request.method === "GET") {
    const r = await stub.bossData(bossToken);
    if (r.error === "signin") return json({ error: "Please enter your passcode again." }, 401);
    if (r.error === "off") return json({ error: "This phone's access has been switched off.", reason: "off", contact: await stub.contact() }, 403);
    const origin = new URL(request.url).origin;
    return json({ ...r, slots: r.slots.map((x) => ({ ...x, link: `${origin}/?k=${x.key}`, key: undefined })) });
  }
  if (path === "/api/boss/order-signature" && request.method === "POST") {
    let body;
    try { body = await readJson(request, 500); } catch { return json({ error: "bad request" }, 400); }
    const oid = typeof body.id === "string" && /^[A-Za-z0-9_-]{1,64}$/.test(body.id) ? body.id : null;
    if (!oid) return json({ error: "bad request" }, 400);
    const r = await stub.bossOrderSignature(bossToken, oid);
    if (r.error === "signin") return json({ error: "Please enter your passcode again." }, 401);
    if (r.error === "off") return json({ error: "This phone's access has been switched off.", reason: "off", contact: await stub.contact() }, 403);
    if (r.error) return json({ error: "That order's signature isn't here." }, 404);
    return json(r);
  }
  if (path === "/api/boss/paid" && request.method === "POST") {
    let body;
    try { body = await readJson(request, 500); } catch { return json({ error: "bad request" }, 400); }
    const invId = typeof body.id === "string" && /^[A-Za-z0-9_-]{1,64}$/.test(body.id) ? body.id : null;
    if (!invId) return json({ error: "bad request" }, 400);
    const r = await stub.bossMarkPaid(bossToken, invId);
    if (r.error === "signin") return json({ error: "Please enter your passcode again." }, 401);
    if (r.error === "off") return json({ error: "This phone's access has been switched off.", reason: "off", contact: await stub.contact() }, 403);
    if (r.error === "unknown") return json({ error: "That invoice isn't here." }, 404);
    return json({ ok: true, invoice: r.invoice });
  }
  if ((path === "/api/boss/add-rep" || path === "/api/boss/rep-off") && request.method === "POST") {
    let body;
    try { body = await readJson(request, 500); } catch { return json({ error: "bad request" }, 400); }
    const n = body.n === undefined || body.n === null ? null : Number(body.n);
    if (n !== null && (!Number.isInteger(n) || n < 1)) return json({ error: "bad request" }, 400);
    let r;
    if (path === "/api/boss/add-rep") {
      const name = typeof body.name === "string" ? body.name.replace(/\s+/g, " ").trim().slice(0, 60) : "";
      if (!name) return json({ error: "Type the rep's name." }, 400);
      r = await stub.bossAddRep(bossToken, name, n);
    } else {
      if (n === null) return json({ error: "bad request" }, 400);
      r = await stub.bossRepOff(bossToken, n);
    }
    if (r.error === "signin") return json({ error: "Please enter your passcode again." }, 401);
    if (r.error === "off") return json({ error: "This phone's access has been switched off.", reason: "off", contact: await stub.contact() }, 403);
    if (r.error === "full") return json({ error: `All ${r.places} rep places your company paid for are in use. Switch off a rep to free a place, or contact the seller to add more.` }, 409);
    if (r.error === "legacy") return json({ error: "This team uses one shared rep link, so reps can't be added here. Contact the seller." }, 409);
    if (r.error === "unknown") return json({ error: "That rep place isn't here." }, 404);
    const origin = new URL(request.url).origin;
    return json({ ok: true, link: r.key ? `${origin}/?k=${r.key}` : null, n: r.n ?? n, slots: r.slots.map((x) => ({ ...x, link: `${origin}/?k=${x.key}`, key: undefined })) });
  }
  if (path === "/api/boss/logout" && request.method === "POST") { await stub.bossLogout(bossToken); return new Response(null, { status: 204 }); }

  const token = (request.headers.get("Authorization") || "").replace(/^Bearer\s+/i, "");
  if (path.startsWith("/api/console/") && !["/api/console/state", "/api/console/claim", "/api/console/login", "/api/console/logout"].includes(path)
    && !(await stub.check(token))) return json({ error: "Please enter your passcode again." }, 401);
  if (path === "/api/console/buyers" && request.method === "GET") return json(await stub.buyers());
  if (path === "/api/console/pay" || path === "/api/console/pay/set") {
    const origin = String(env.PAY_ORIGIN || "https://marlon-pay.marlon615.workers.dev").replace(/\/$/, "");
    const withLink = (s) => ({ ...s, ownerLink: `${origin}/?k=${s.ownerKey}`, ownerKey: undefined });
    if (!env.PAY) return json({ connected: false, error: "Marlon Pay isn't connected yet (deploy marlon-pay, then this app)." });
    try {
      if (request.method === "GET") return json({ connected: true, payOrigin: origin, stores: (await env.PAY.stores()).stores.map(withLink) });
      let body;
      try { body = await readJson(request, 2000); } catch { return json({ error: "bad request" }, 400); }
      const r = path === "/api/console/pay" ? await env.PAY.createStore(body.name, body.places) : await env.PAY.setStore(body.id, { paid: body.paid, off: body.off, places: body.places });
      if (r.error) return json({ error: r.error === "unknown" ? "That store isn't there." : r.error }, 400);
      return json({ connected: true, store: withLink(r.store) });
    } catch { return json({ connected: false, error: "Marlon Pay couldn't be reached. Try again in a moment." }); }
  }
  if (path === "/api/console/buyers" && request.method === "POST") {
    let body;
    try { body = await readJson(request, 2000); } catch { return json({ error: "bad request" }, 400); }
    const name = typeof body.name === "string" ? body.name.replace(/\s+/g, " ").trim().slice(0, 80) : "";
    const devices = Number(body.devices);
    const amount = typeof body.amount === "number" ? body.amount : Number(String(body.amount ?? "").replace(/[$,\s]/g, ""));
    if (!name) return json({ error: "Type the buyer's name." }, 400);
    if (!Number.isInteger(devices) || devices < 1 || devices > 1000) return json({ error: "Choose how many devices (1 or more)." }, 400);
    if (String(body.amount ?? "").trim() === "" || !Number.isFinite(amount) || amount < 0 || amount > 1e9) return json({ error: "Type how much the buyer paid (0 or more)." }, 400);
    const kind = body.kind === "team" ? "team" : "solo";
    const ph = cleanPhone(body.phone), em = cleanEmail(body.email);
    if (ph.error) return json({ error: ph.error }, 400);
    if (em.error) return json({ error: em.error }, 400);
    const buyer = await stub.createBuyer(name, devices, Math.round(amount * 100), kind, ph.phone, em.email);
    const origin = new URL(request.url).origin;
    return json({ buyer, link: `${origin}/?k=${buyer.id}`, bossLink: buyer.bossKey ? `${origin}/boss?b=${buyer.bossKey}` : null,
      repLinks: buyer.slots.map((x) => `${origin}/?k=${x.key}`) });
  }
  if ((path === "/api/console/buyer-off" || path === "/api/console/device-off") && request.method === "POST") {
    let body;
    try { body = await readJson(request, 1000); } catch { return json({ error: "bad request" }, 400); }
    const id = typeof body.id === "string" && /^[0-9a-f]{32}$/.test(body.id) ? body.id : null;
    if (!id) return json({ error: "bad request" }, 400);
    if (path === "/api/console/buyer-off") {
      const buyer = await stub.setBuyerOff(id, Boolean(body.off));
      return buyer ? json({ buyer }) : json({ error: "not found" }, 404);
    }
    const device = typeof body.device === "string" && /^[0-9a-f]{32}$/.test(body.device) ? body.device : null;
    if (!device) return json({ error: "bad request" }, 400);
    const r = await stub.setDeviceOff(id, device, Boolean(body.off));
    if (r.error === "full") return json({ error: "All this buyer's places are in use. Switch another of their phones off first." }, 409);
    if (r.error === "replaced") return json({ error: "This rep's link was replaced, so this phone can't come back. Send the new link instead." }, 409);
    if (r.error === "released") return json({ error: "The boss switched this rep off and freed their link, so this phone can't come back." }, 409);
    return r.buyer ? json({ buyer: r.buyer }) : json({ error: "not found" }, 404);
  }
  if (path === "/api/console/delete-buyer" && request.method === "POST") {
    let body;
    try { body = await readJson(request, 500); } catch { return json({ error: "bad request" }, 400); }
    const id = hex32(body.id);
    if (!id) return json({ error: "bad request" }, 400);
    const left = await stub.leftovers(id);
    if (!(await stub.deleteBuyer(id))) return json({ error: "not found" }, 404);
    return json({ ok: true, removed: left, left: await stub.leftovers(id) });
  }
  if (path === "/api/console/replace-rep-link" && request.method === "POST") {
    let body;
    try { body = await readJson(request, 500); } catch { return json({ error: "bad request" }, 400); }
    const id = hex32(body.id), n = Number(body.n);
    if (!id || !Number.isInteger(n) || n < 1) return json({ error: "bad request" }, 400);
    const r = await stub.replaceRepLink(id, n);
    return r ? json({ buyer: r.buyer, link: `${new URL(request.url).origin}/?k=${r.key}` }) : json({ error: "not found" }, 404);
  }
  if (path === "/api/console/pro" && request.method === "POST") {
    let body;
    try { body = await readJson(request, 500); } catch { return json({ error: "bad request" }, 400); }
    const id = hex32(body.id);
    const pct = typeof body.discountPct === "number" ? body.discountPct : Number(String(body.discountPct ?? "0").replace(/[%\s]/g, "") || 0);
    if (!id) return json({ error: "bad request" }, 400);
    if (!Number.isFinite(pct) || pct < 0 || pct > 100) return json({ error: "The special deal must be between 0 and 100 %." }, 400);
    const reps = body.reps === undefined || body.reps === null ? null : cleanReps(body.reps);
    if (body.reps !== undefined && body.reps !== null && reps === null) return json({ error: "Type how many reps they have (a whole number, 1 or more)." }, 400);
    const cur = (await stub.buyers()).buyers.find((x) => x.id === id);
    if (!cur) return json({ error: "not found" }, 404);
    if (body.pro && reps === null && !cur.pro && !cur.proRepsSaved) return json({ error: "Say how many reps they have before switching Pro on." }, 400);
    const r = await stub.setPro(id, Boolean(body.pro), Math.round(pct * 100) / 100, reps, typeof body.startDate === "string" ? body.startDate : null);
    return r ? json(r) : json({ error: "not found" }, 404);
  }
  if (path === "/api/console/buyer-contact" && request.method === "POST") {
    let body;
    try { body = await readJson(request, 500); } catch { return json({ error: "bad request" }, 400); }
    const id = hex32(body.id);
    if (!id) return json({ error: "bad request" }, 400);
    const ph = cleanPhone(body.phone), em = cleanEmail(body.email);
    if (ph.error) return json({ error: ph.error }, 400);
    if (em.error) return json({ error: em.error }, 400);
    const buyer = await stub.setBuyerContact(id, ph.phone, em.email);
    return buyer ? json({ buyer }) : json({ error: "not found" }, 404);
  }
  if (path === "/api/console/buyer-update" && request.method === "POST") {
    let body;
    try { body = await readJson(request, 1000); } catch { return json({ error: "bad request" }, 400); }
    const id = hex32(body.id);
    if (!id) return json({ error: "bad request" }, 400);
    const cur = (await stub.buyers()).buyers.find((x) => x.id === id);
    if (!cur) return json({ error: "not found" }, 404);
    // Check everything first: nothing is saved unless all of it is right.
    const name = typeof body.name === "string" ? body.name.replace(/\s+/g, " ").trim().slice(0, 80) : "";
    if (!name) return json({ error: "Type the customer's name.", field: "name" }, 400);
    const ph = cleanPhone(body.phone), em = cleanEmail(body.email);
    if (ph.error) return json({ error: ph.error, field: "phone" }, 400);
    if (em.error) return json({ error: em.error, field: "email" }, 400);
    const pro = Boolean(body.pro);
    const pct = typeof body.discountPct === "number" ? body.discountPct : Number(String(body.discountPct ?? "0").replace(/[%\s]/g, "") || 0);
    if (!Number.isFinite(pct) || pct < 0 || pct > 100) return json({ error: "The special deal must be between 0 and 100 %.", field: "deal" }, 400);
    const reps = body.reps === undefined || body.reps === null || body.reps === "" ? null : cleanReps(body.reps);
    if (body.reps !== undefined && body.reps !== null && body.reps !== "" && reps === null) return json({ error: "Type how many reps they have (a whole number, 1 or more).", field: "reps" }, 400);
    if (pro && reps === null && !cur.pro && !cur.proRepsSaved) return json({ error: "Type how many reps they have before switching Pro on.", field: "reps" }, 400);
    await stub.renameBuyer(id, name);
    await stub.setBuyerContact(id, ph.phone, em.email);
    const r = await stub.setPro(id, pro, Math.round(pct * 100) / 100, reps, typeof body.startDate === "string" ? body.startDate : null);
    return json(r);
  }
  if (path === "/api/console/pro-notice" && request.method === "POST") {
    let body;
    try { body = await readJson(request, 300); } catch { return json({ error: "bad request" }, 400); }
    const id = hex32(body.id);
    if (!id) return json({ error: "bad request" }, 400);
    const b = (await stub.buyers()).buyers.find((x) => x.id === id);
    if (!b) return json({ error: "not found" }, 404);
    if (!b.pro) return json({ error: "Switch Marlon Pro on for this company first." }, 409);
    const notice = await stub.proNotice(id, typeof body.startDate === "string" ? body.startDate : null);
    return json({ notice });
  }
  if (path === "/api/console/contact" && request.method === "POST") {
    let body;
    try { body = await readJson(request, 2000); } catch { return json({ error: "bad request" }, 400); }
    return json({ contact: await stub.setContact(typeof body.contact === "string" ? body.contact.trim().slice(0, 200) : "") });
  }
  if (path === "/api/console/stats" && request.method === "GET") {
    if (!(await stub.check(token))) return json({ error: "Please enter your passcode again." }, 401);
    return json(await stub.stats());
  }
  if (path === "/api/console/logout" && request.method === "POST") {
    await stub.logout(token);
    return new Response(null, { status: 204 });
  }
  return json({ error: "not found" }, 404);
}

const bodies = new Map(); // decoded binary bodies, made once per isolate
const bodyOf = (path, f) => {
  if (f.text !== undefined) return f.text;
  if (!bodies.has(path)) bodies.set(path, Uint8Array.from(atob(f.b64), (c) => c.charCodeAt(0)));
  return bodies.get(path);
};
const matches = (pattern, path) => (pattern.endsWith("*") ? path.startsWith(pattern.slice(0, -1)) : pattern === path);

function respond(request, path, f, status = 200) {
  const headers = new Headers({ "Content-Type": f.type, "Cache-Control": "no-cache", ETag: f.etag });
  for (const r of RULES) if (matches(r.pattern, path)) for (const [k, v] of Object.entries(r.headers)) headers.set(k, v);
  if (status === 200 && request.headers.get("If-None-Match") === f.etag) return new Response(null, { status: 304, headers });
  return new Response(request.method === "HEAD" ? null : bodyOf(path, f), { status, headers });
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    if (url.pathname.startsWith("/api/")) {
      try { return await api(request, env, url.pathname); } catch (err) { return json({ error: "Something went wrong." }, 500); }
    }
    if (request.method !== "GET" && request.method !== "HEAD") return new Response("Method not allowed", { status: 405, headers: { Allow: "GET, HEAD" } });
    let path;
    try { path = decodeURIComponent(url.pathname); } catch { path = url.pathname; }
    // Canonical URLs: "/index.html" → "/", "/v.html" → "/v".
    if (/\/index\.html$/.test(path)) return Response.redirect(new URL(path.replace(/index\.html$/, "") + url.search, url), 307);
    if (/\.html$/.test(path) && path !== "/404.html") return Response.redirect(new URL(path.replace(/\.html$/, "") + url.search, url), 307);
    // An iPhone adds the app to its home screen with its own storage, so the personal link has to travel with it:
    // "/manifest.webmanifest?k=…" starts the home-screen app at "/?k=…".
    const k = url.searchParams.get("k");
    if (path === "/manifest.webmanifest" && k && /^[0-9a-f]{32}$/.test(k) && FILES[path]) {
      const m = JSON.parse(FILES[path].text);
      m.start_url = `/?k=${k}`;
      m.id = `/?k=${k}`; // each personal link installs as its own app (its own storage), never as another link's app
      return new Response(JSON.stringify(m), { headers: { "Content-Type": FILES[path].type, "Cache-Control": "no-cache", "X-Content-Type-Options": "nosniff" } });
    }
    // A buyer's signing link: "/s/<secret>" always opens the signing page (the page reads the secret from the address).
    if (/^\/s\/[0-9a-f]{64}$/.test(path) && FILES["/sign.html"]) return respond(request, "/s/*", FILES["/sign.html"]);
    const key = path.endsWith("/") ? path + "index.html" : FILES[path] ? path : FILES[path + ".html"] ? path + ".html" : null;
    if (key && FILES[key]) return respond(request, path, FILES[key]);
    return respond(request, path, FILES["/404.html"], 404);
  },
};
