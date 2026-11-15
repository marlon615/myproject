/**
 * Forecasting Agent — the Worker.
 *
 * Storage (Cloudflare Durable Objects, SQLite):
 *   Directory (one)        companies' logins and sessions, the owner's passcode, payments, the on/off switches.
 *   Company (one per company, named by its account id)   that company's uploads, backtests and forecasts — nothing
 *                          else lives there, and the only way in is a session token that belongs to that company.
 *
 * The browser reads the spreadsheet itself and sends only monthly totals per product.
 *
 * Customer API (Bearer = customer session)
 *   POST /api/signup  { company, email, password } → { token, me }
 *   POST /api/login   { email, password } → { token, me }            5 wrong tries per 15 minutes per email
 *   POST /api/logout
 *   GET  /api/me → { me, contact }
 *   GET  /api/uploads → { uploads }
 *   POST /api/uploads { name, months, products, kind } → { upload }    runs the free backtest right away
 *   GET  /api/uploads/:id → { upload (with backtest, forecast) }
 *   POST /api/uploads/:id/forecast → { forecast }                      402 unless forecasts are switched on
 *   DELETE /api/uploads/:id
 *
 * Owner API (Bearer = owner session)
 *   GET  /api/owner/state → { claimed }
 *   POST /api/owner/claim { passcode } (first visit only) · POST /api/owner/login { passcode } · POST /api/owner/logout
 *   GET  /api/owner/customers → { customers, totals, contact }
 *   GET  /api/owner/customers/:id/uploads → { uploads }
 *   GET  /api/owner/customers/:id/uploads/:uid → { upload }
 *   POST /api/owner/customers/:id/uploads/:uid/forecast → { forecast }  (the owner can always run one)
 *   DELETE /api/owner/customers/:id/uploads/:uid
 *   POST /api/owner/switch   { id, account?: bool, forecasts?: bool }     on/off switches
 *   POST /api/owner/payment  { id, amount, note }   records money received (and switches forecasts on)
 *   POST /api/owner/payment-delete { id, paymentId }
 *   POST /api/owner/delete-customer { id }          removes the company and all its data
 *   POST /api/owner/contact  { contact }            what customers are told when something is locked
 */
import { DurableObject } from "cloudflare:workers";
import { FILES, RULES } from "./assets.generated.js";
import { runBacktest, runForecast, MIN_FORECAST_MONTHS, MIN_BACKTEST_MONTHS } from "./forecast.js";

const MAX_UPLOADS = 50, MAX_MONTHS = 120, MAX_PRODUCTS_IN = 2000, MAX_BODY = 1_500_000;
const hex = (buf) => Array.from(new Uint8Array(buf), (b) => b.toString(16).padStart(2, "0")).join("");
const randomHex = (n) => hex(crypto.getRandomValues(new Uint8Array(n)));
const ID = /^[0-9a-f]{32}$/;
const EMAIL = /^[^\s@]{1,64}@[^\s@]{1,190}\.[^\s@]{2,}$/;
const YM = /^\d{4}-(0[1-9]|1[0-2])$/;

async function hashSecret(secret, salt) {
  const key = await crypto.subtle.importKey("raw", new TextEncoder().encode(secret), "PBKDF2", false, ["deriveBits"]);
  const bits = await crypto.subtle.deriveBits({ name: "PBKDF2", hash: "SHA-256", salt: new TextEncoder().encode(salt), iterations: 5000 }, key, 256);
  return hex(bits);
}
const sameText = (a, b) => { if (a.length !== b.length) return false; let x = 0; for (let i = 0; i < a.length; i++) x |= a.charCodeAt(i) ^ b.charCodeAt(i); return x === 0; };

/** Logins, sessions, payments, switches and the owner's passcode. */
export class Directory extends DurableObject {
  constructor(ctx, env) {
    super(ctx, env);
    this.sql = ctx.storage.sql;
    this.sql.exec(`CREATE TABLE IF NOT EXISTS meta (k TEXT PRIMARY KEY, v TEXT NOT NULL)`);
    this.sql.exec(`CREATE TABLE IF NOT EXISTS owner_sessions (token TEXT PRIMARY KEY, expires INTEGER NOT NULL)`);
    this.sql.exec(`CREATE TABLE IF NOT EXISTS accounts (id TEXT PRIMARY KEY, company TEXT NOT NULL, email TEXT NOT NULL UNIQUE,
      salt TEXT NOT NULL, hash TEXT NOT NULL, created TEXT NOT NULL, last_seen TEXT, off INTEGER NOT NULL DEFAULT 0,
      forecasts INTEGER NOT NULL DEFAULT 0, uploads INTEGER NOT NULL DEFAULT 0, last_upload TEXT, last_accuracy REAL, last_months INTEGER)`);
    this.sql.exec(`CREATE TABLE IF NOT EXISTS sessions (token TEXT PRIMARY KEY, account TEXT NOT NULL, expires INTEGER NOT NULL)`);
    this.sql.exec(`CREATE TABLE IF NOT EXISTS payments (id TEXT PRIMARY KEY, account TEXT NOT NULL, cents INTEGER NOT NULL, note TEXT NOT NULL, created TEXT NOT NULL)`);
    this.sql.exec(`CREATE TABLE IF NOT EXISTS login_fails (email TEXT PRIMARY KEY, times TEXT NOT NULL)`);
    this.sql.exec(`CREATE TABLE IF NOT EXISTS signups (t INTEGER NOT NULL, ip TEXT NOT NULL)`);
  }

  #meta(k) { return this.sql.exec("SELECT v FROM meta WHERE k = ?", k).toArray()[0]?.v ?? null; }
  #setMeta(k, v) { this.sql.exec("INSERT INTO meta (k, v) VALUES (?, ?) ON CONFLICT(k) DO UPDATE SET v = excluded.v", k, v); }

  // ── Owner passcode (set on the first visit; raise OWNER_GENERATION in wrangler.toml and redeploy to set it again) ──
  #generation() { return String(this.env?.OWNER_GENERATION ?? "1"); }
  #claimed() { return Boolean(this.#meta("hash")) && this.#meta("gen") === this.#generation(); }
  ownerState() { return { claimed: this.#claimed() }; }

  ownerClaim(passcode) {
    return this.ctx.blockConcurrencyWhile(async () => {
      if (this.#claimed()) return { error: "taken" };
      const salt = randomHex(16);
      this.#setMeta("hash", await hashSecret(passcode, salt));
      this.#setMeta("salt", salt);
      this.#setMeta("gen", this.#generation());
      this.#setMeta("fails", "[]");
      this.sql.exec("DELETE FROM owner_sessions");
      return { token: this.#ownerSession() };
    });
  }

  ownerLogin(passcode) {
    return this.ctx.blockConcurrencyWhile(async () => {
      const now = Date.now();
      const fails = JSON.parse(this.#meta("fails") || "[]").filter((t) => now - t < 15 * 60 * 1000);
      if (fails.length >= 5) return { error: "wait", retryAfter: Math.ceil((15 * 60 * 1000 - (now - fails[0])) / 1000) };
      if (!this.#claimed()) return { error: "unclaimed" };
      if (!sameText(await hashSecret(passcode, this.#meta("salt")), this.#meta("hash"))) {
        fails.push(now);
        this.#setMeta("fails", JSON.stringify(fails));
        return { error: "wrong", left: Math.max(0, 5 - fails.length) };
      }
      this.#setMeta("fails", "[]");
      return { token: this.#ownerSession() };
    });
  }

  #ownerSession() {
    const token = randomHex(32);
    this.sql.exec("DELETE FROM owner_sessions WHERE expires < ?", Date.now());
    this.sql.exec("INSERT INTO owner_sessions (token, expires) VALUES (?, ?)", token, Date.now() + 12 * 3600 * 1000);
    return token;
  }
  ownerCheck(token) {
    return Boolean(token) && this.#claimed() && this.sql.exec("SELECT 1 FROM owner_sessions WHERE token = ? AND expires > ?", token, Date.now()).toArray().length > 0;
  }
  ownerLogout(token) { this.sql.exec("DELETE FROM owner_sessions WHERE token = ?", token); }

  contact() { return this.#meta("contact") || ""; }
  setContact(text) { this.#setMeta("contact", text); return this.contact(); }

  // ── Customers ────────────────────────────────────────────────────────────────────────────────────────────────
  #me(row) {
    return { id: row.id, company: row.company, email: row.email, off: Boolean(row.off), forecasts: Boolean(row.forecasts), created: row.created };
  }

  signup(company, email, password, ip) {
    return this.ctx.blockConcurrencyWhile(async () => {
      const now = Date.now();
      this.sql.exec("DELETE FROM signups WHERE t < ?", now - 3600 * 1000);
      if (this.sql.exec("SELECT COUNT(*) AS n FROM signups WHERE ip = ?", ip).one().n >= 10) return { error: "busy" };
      if (this.sql.exec("SELECT 1 FROM accounts WHERE email = ?", email).toArray().length) return { error: "exists" };
      const id = randomHex(16), salt = randomHex(16);
      this.sql.exec("INSERT INTO accounts (id, company, email, salt, hash, created, last_seen) VALUES (?, ?, ?, ?, ?, ?, ?)",
        id, company, email, salt, await hashSecret(password, salt), new Date().toISOString(), new Date().toISOString());
      this.sql.exec("INSERT INTO signups (t, ip) VALUES (?, ?)", now, ip);
      return { token: this.#session(id), me: this.#me(this.#row(id)) };
    });
  }

  login(email, password) {
    return this.ctx.blockConcurrencyWhile(async () => {
      const now = Date.now();
      const fails = JSON.parse(this.sql.exec("SELECT times FROM login_fails WHERE email = ?", email).toArray()[0]?.times || "[]").filter((t) => now - t < 15 * 60 * 1000);
      if (fails.length >= 5) return { error: "wait", retryAfter: Math.ceil((15 * 60 * 1000 - (now - fails[0])) / 1000) };
      const row = this.sql.exec("SELECT * FROM accounts WHERE email = ?", email).toArray()[0];
      // Same work whether or not the email exists, so the answer time doesn't reveal who has an account.
      const hash = await hashSecret(password, row?.salt || "no-such-account");
      if (!row || !sameText(hash, row.hash)) {
        fails.push(now);
        this.sql.exec("INSERT INTO login_fails (email, times) VALUES (?, ?) ON CONFLICT(email) DO UPDATE SET times = excluded.times", email, JSON.stringify(fails));
        return { error: "wrong" };
      }
      this.sql.exec("DELETE FROM login_fails WHERE email = ?", email);
      if (row.off) return { error: "off" };
      return { token: this.#session(row.id), me: this.#me(row) };
    });
  }

  #session(account) {
    const token = randomHex(32);
    this.sql.exec("DELETE FROM sessions WHERE expires < ?", Date.now());
    this.sql.exec("INSERT INTO sessions (token, account, expires) VALUES (?, ?, ?)", token, account, Date.now() + 30 * 24 * 3600 * 1000);
    return token;
  }
  #row(id) { return this.sql.exec("SELECT * FROM accounts WHERE id = ?", id).toArray()[0] || null; }

  /** The company a session token belongs to (or null). The only way any customer request finds its data. */
  who(token) {
    if (!token) return null;
    const s = this.sql.exec("SELECT account FROM sessions WHERE token = ? AND expires > ?", token, Date.now()).toArray()[0];
    if (!s) return null;
    const row = this.#row(s.account);
    if (!row) return null;
    const today = new Date().toISOString().slice(0, 10);
    if ((row.last_seen || "").slice(0, 10) !== today) this.sql.exec("UPDATE accounts SET last_seen = ? WHERE id = ?", new Date().toISOString(), row.id);
    return this.#me(row);
  }
  logout(token) { this.sql.exec("DELETE FROM sessions WHERE token = ?", token); }

  /** Kept up to date after every upload change, so the owner's list needs only this one place. */
  noteUploads(id, count, last) {
    this.sql.exec("UPDATE accounts SET uploads = ?, last_upload = ?, last_accuracy = ?, last_months = ? WHERE id = ?",
      count, last?.created ?? null, last?.accuracy ?? null, last?.months ?? null, id);
  }

  // ── Owner ────────────────────────────────────────────────────────────────────────────────────────────────────
  customers() {
    const pays = this.sql.exec("SELECT * FROM payments ORDER BY created DESC").toArray();
    const customers = this.sql.exec("SELECT * FROM accounts ORDER BY created DESC").toArray().map((r) => {
      const mine = pays.filter((p) => p.account === r.id);
      return {
        ...this.#me(r), lastSeen: r.last_seen, uploads: r.uploads, lastUpload: r.last_upload, lastAccuracy: r.last_accuracy, lastMonths: r.last_months,
        paidCents: mine.reduce((a, p) => a + p.cents, 0), payments: mine.map((p) => ({ id: p.id, cents: p.cents, note: p.note, created: p.created })),
      };
    });
    const acc = customers.filter((c) => c.lastAccuracy !== null && c.lastAccuracy !== undefined);
    return {
      customers,
      totals: {
        customers: customers.length, paying: customers.filter((c) => c.paidCents > 0).length, off: customers.filter((c) => c.off).length,
        collectedCents: pays.reduce((a, p) => a + p.cents, 0), uploads: customers.reduce((a, c) => a + c.uploads, 0),
        avgAccuracy: acc.length ? Math.round((acc.reduce((a, c) => a + c.lastAccuracy, 0) / acc.length) * 10) / 10 : null,
      },
      contact: this.contact(),
    };
  }

  exists(id) { return Boolean(this.#row(id)); }

  setSwitch(id, { account, forecasts }) {
    if (!this.#row(id)) return { error: "unknown" };
    if (typeof account === "boolean") {
      this.sql.exec("UPDATE accounts SET off = ? WHERE id = ?", account ? 0 : 1, id);
      if (!account) this.sql.exec("DELETE FROM sessions WHERE account = ?", id); // switched off: signed out everywhere
    }
    if (typeof forecasts === "boolean") this.sql.exec("UPDATE accounts SET forecasts = ? WHERE id = ?", forecasts ? 1 : 0, id);
    return { ok: true, me: this.#me(this.#row(id)) };
  }

  addPayment(id, cents, note) {
    if (!this.#row(id)) return { error: "unknown" };
    const pid = randomHex(16);
    this.sql.exec("INSERT INTO payments (id, account, cents, note, created) VALUES (?, ?, ?, ?, ?)", pid, id, cents, note, new Date().toISOString());
    this.sql.exec("UPDATE accounts SET forecasts = 1 WHERE id = ?", id); // paid: forecasts unlocked
    return { ok: true, id: pid };
  }
  deletePayment(id, pid) {
    this.sql.exec("DELETE FROM payments WHERE id = ? AND account = ?", pid, id);
    return { ok: true };
  }

  deleteCustomer(id) {
    if (!this.#row(id)) return { error: "unknown" };
    this.sql.exec("DELETE FROM sessions WHERE account = ?", id);
    this.sql.exec("DELETE FROM payments WHERE account = ?", id);
    this.sql.exec("DELETE FROM accounts WHERE id = ?", id);
    return { ok: true };
  }
}

/** One company's uploads. Each company has its own one of these; nothing in it refers to any other company. */
export class Company extends DurableObject {
  constructor(ctx, env) {
    super(ctx, env);
    this.sql = ctx.storage.sql;
    this.sql.exec(`CREATE TABLE IF NOT EXISTS uploads (id TEXT PRIMARY KEY, name TEXT NOT NULL, created TEXT NOT NULL, kind TEXT NOT NULL,
      months INTEGER NOT NULL, products INTEGER NOT NULL, first TEXT NOT NULL, last TEXT NOT NULL, data TEXT NOT NULL,
      backtest TEXT, accuracy REAL, forecast TEXT, forecast_at TEXT)`);
  }

  #summary(r) {
    return { id: r.id, name: r.name, created: r.created, kind: r.kind, months: r.months, products: r.products, first: r.first, last: r.last, accuracy: r.accuracy, hasForecast: Boolean(r.forecast) };
  }
  #latest() {
    const r = this.sql.exec("SELECT * FROM uploads ORDER BY created DESC LIMIT 1").toArray()[0];
    return r ? this.#summary(r) : null;
  }
  #count() { return this.sql.exec("SELECT COUNT(*) AS n FROM uploads").one().n; }

  list() { return this.sql.exec("SELECT * FROM uploads ORDER BY created DESC").toArray().map((r) => this.#summary(r)); }

  add(u) {
    if (this.#count() >= MAX_UPLOADS) return { error: "full" };
    const backtest = runBacktest(u);
    const id = randomHex(16);
    this.sql.exec("INSERT INTO uploads (id, name, created, kind, months, products, first, last, data, backtest, accuracy) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
      id, u.name, new Date().toISOString(), u.kind, u.months.length, Object.keys(u.products).length, u.months[0], u.months[u.months.length - 1],
      JSON.stringify(u), JSON.stringify(backtest), backtest.ok ? backtest.accuracy : null);
    return { upload: this.get(id), count: this.#count(), latest: this.#latest() };
  }

  get(id) {
    const r = this.sql.exec("SELECT * FROM uploads WHERE id = ?", id).toArray()[0];
    if (!r) return null;
    return { ...this.#summary(r), backtest: JSON.parse(r.backtest), forecast: r.forecast ? JSON.parse(r.forecast) : null, forecastAt: r.forecast_at };
  }

  forecast(id) {
    const r = this.sql.exec("SELECT data FROM uploads WHERE id = ?", id).toArray()[0];
    if (!r) return null;
    const fc = runForecast(JSON.parse(r.data));
    this.sql.exec("UPDATE uploads SET forecast = ?, forecast_at = ? WHERE id = ?", JSON.stringify(fc), new Date().toISOString(), id);
    return fc;
  }

  remove(id) {
    this.sql.exec("DELETE FROM uploads WHERE id = ?", id);
    return { count: this.#count(), latest: this.#latest() };
  }

  /** Everything gone (the company was deleted). */
  async wipe() {
    await this.ctx.storage.deleteAll();
    return { ok: true };
  }
}

// ── HTTP ─────────────────────────────────────────────────────────────────────────────────────────────────────────
const json = (data, status = 200, extra = {}) => new Response(JSON.stringify(data), {
  status, headers: { "Content-Type": "application/json", "Cache-Control": "no-store", "X-Content-Type-Options": "nosniff", ...extra },
});
const bearer = (request) => (request.headers.get("Authorization") || "").replace(/^Bearer\s+/i, "").trim();

async function readJson(request) {
  const len = Number(request.headers.get("Content-Length") || 0);
  if (len > MAX_BODY) return null;
  const text = await request.text();
  if (text.length > MAX_BODY) return null;
  try { const v = JSON.parse(text); return v && typeof v === "object" ? v : null; } catch { return null; }
}

/** Checks an upload's monthly totals: real months in order with no gaps, numbers only, sane sizes. */
function cleanUpload(b) {
  const name = String(b?.name ?? "").trim().slice(0, 120) || "Sales data";
  const kind = b?.kind === "units" ? "units" : "money";
  const months = Array.isArray(b?.months) ? b.months : null;
  if (!months || !months.length || months.length > MAX_MONTHS || !months.every((m) => typeof m === "string" && YM.test(m))) return { error: `The file needs real months (at most ${MAX_MONTHS}).` };
  for (let i = 1; i < months.length; i++) {
    const [y, m] = months[i - 1].split("-").map(Number);
    if (months[i] !== (m === 12 ? `${y + 1}-01` : `${y}-${String(m + 1).padStart(2, "0")}`)) return { error: "The months must follow each other with no gaps." };
  }
  if (!b.products || typeof b.products !== "object" || Array.isArray(b.products)) return { error: "No products found." };
  const entries = Object.entries(b.products);
  if (!entries.length || entries.length > MAX_PRODUCTS_IN) return { error: `Between 1 and ${MAX_PRODUCTS_IN} products, please.` };
  const products = {};
  for (const [rawName, vals] of entries) {
    const pn = String(rawName).trim().slice(0, 80) || "(no name)";
    if (!Array.isArray(vals) || vals.length !== months.length || !vals.every((v) => typeof v === "number" && Number.isFinite(v) && Math.abs(v) < 1e13)) return { error: "Every product needs one number per month." };
    products[pn] = products[pn] ? products[pn].map((v, i) => v + vals[i]) : vals.map((v) => Math.round(v * 100) / 100);
  }
  return { upload: { name, kind, months, products } };
}

const company = (env, id) => env.COMPANY.get(env.COMPANY.idFromName(id));

async function api(request, env, path) {
  const dir = env.DIRECTORY.get(env.DIRECTORY.idFromName("main"));
  const method = request.method;
  const token = bearer(request);

  if (path.startsWith("/api/owner/")) return ownerApi(request, env, path, dir, token);

  if (path === "/api/signup" && method === "POST") {
    const b = await readJson(request);
    const companyName = String(b?.company ?? "").trim().slice(0, 100);
    const email = String(b?.email ?? "").trim().toLowerCase();
    const password = String(b?.password ?? "");
    if (!companyName) return json({ error: "Type your company's name." }, 400);
    if (!EMAIL.test(email)) return json({ error: "That email doesn't look right." }, 400);
    if (password.length < 8 || password.length > 200) return json({ error: "The password needs at least 8 characters." }, 400);
    const r = await dir.signup(companyName, email, password, request.headers.get("CF-Connecting-IP") || "local");
    if (r.error === "exists") return json({ error: "There's already an account with that email. Sign in instead." }, 409);
    if (r.error === "busy") return json({ error: "Too many new accounts from here. Try again in an hour." }, 429);
    return json(r);
  }
  if (path === "/api/login" && method === "POST") {
    const b = await readJson(request);
    const r = await dir.login(String(b?.email ?? "").trim().toLowerCase(), String(b?.password ?? "").slice(0, 200));
    if (r.error === "wait") return json({ error: "Too many wrong tries. Wait a few minutes, then try again." }, 429, { "Retry-After": String(r.retryAfter) });
    if (r.error === "wrong") return json({ error: "That email and password don't match." }, 401);
    if (r.error === "off") return json({ error: "This account is switched off.", off: true, contact: await dir.contact() }, 403);
    return json(r);
  }
  if (path === "/api/logout" && method === "POST") {
    if (token) await dir.logout(token);
    return new Response(null, { status: 204 });
  }

  // Everything below needs a signed-in company that is switched on. The company comes only from the token.
  const me = await dir.who(token);
  if (!me) return json({ error: "Please sign in." }, 401);
  if (me.off) return json({ error: "This account is switched off.", off: true, contact: await dir.contact() }, 403);
  const box = company(env, me.id);

  if (path === "/api/me" && method === "GET") return json({ me, contact: await dir.contact(), minForecast: MIN_FORECAST_MONTHS, minBacktest: MIN_BACKTEST_MONTHS });
  if (path === "/api/uploads" && method === "GET") return json({ uploads: await box.list() });
  if (path === "/api/uploads" && method === "POST") {
    const b = await readJson(request);
    if (!b) return json({ error: "That file is too big or couldn't be read." }, 413);
    const c = cleanUpload(b);
    if (c.error) return json({ error: c.error }, 400);
    const r = await box.add(c.upload);
    if (r.error === "full") return json({ error: `You have ${MAX_UPLOADS} uploads. Delete an old one first.` }, 409);
    await dir.noteUploads(me.id, r.count, r.latest);
    return json({ upload: r.upload });
  }
  const m = /^\/api\/uploads\/([0-9a-f]{32})(\/forecast)?$/.exec(path);
  if (m) {
    const [, uid, fc] = m;
    if (fc && method === "POST") {
      if (!me.forecasts) return json({ error: "The 3-month forecast isn't switched on for your account yet.", locked: true, contact: await dir.contact() }, 402);
      const f = await box.forecast(uid);
      return f ? json({ forecast: f }) : json({ error: "Not found." }, 404);
    }
    if (!fc && method === "GET") {
      const u = await box.get(uid);
      return u ? json({ upload: u }) : json({ error: "Not found." }, 404);
    }
    if (!fc && method === "DELETE") {
      const r = await box.remove(uid);
      await dir.noteUploads(me.id, r.count, r.latest);
      return new Response(null, { status: 204 });
    }
  }
  return json({ error: "Not found." }, 404);
}

async function ownerApi(request, env, path, dir, token) {
  const method = request.method;
  if (path === "/api/owner/state" && method === "GET") return json(await dir.ownerState());
  if ((path === "/api/owner/claim" || path === "/api/owner/login") && method === "POST") {
    const b = await readJson(request);
    const passcode = String(b?.passcode ?? "");
    if (passcode.length < 8 || passcode.length > 200) return json({ error: "The passcode needs at least 8 characters." }, 400);
    const r = path.endsWith("claim") ? await dir.ownerClaim(passcode) : await dir.ownerLogin(passcode);
    if (r.error === "taken") return json({ error: "The passcode is already set. Sign in with it." }, 409);
    if (r.error === "unclaimed") return json({ error: "No passcode yet — set one first." }, 409);
    if (r.error === "wait") return json({ error: "Too many wrong tries. Wait a few minutes, then try again." }, 429, { "Retry-After": String(r.retryAfter) });
    if (r.error === "wrong") return json({ error: `Wrong passcode. ${r.left} ${r.left === 1 ? "try" : "tries"} left before a 15-minute wait.` }, 401);
    return json(r);
  }
  if (!(await dir.ownerCheck(token))) return json({ error: "Please sign in." }, 401);
  if (path === "/api/owner/logout" && method === "POST") { await dir.ownerLogout(token); return new Response(null, { status: 204 }); }
  if (path === "/api/owner/customers" && method === "GET") return json(await dir.customers());

  const u = /^\/api\/owner\/customers\/([0-9a-f]{32})\/uploads(?:\/([0-9a-f]{32})(\/forecast)?)?$/.exec(path);
  if (u) {
    const [, cid, uid, fc] = u;
    if (!(await dir.exists(cid))) return json({ error: "Not found." }, 404);
    const box = company(env, cid);
    if (!uid && method === "GET") return json({ uploads: await box.list() });
    if (uid && fc && method === "POST") { const f = await box.forecast(uid); return f ? json({ forecast: f }) : json({ error: "Not found." }, 404); }
    if (uid && !fc && method === "GET") { const x = await box.get(uid); return x ? json({ upload: x }) : json({ error: "Not found." }, 404); }
    if (uid && !fc && method === "DELETE") { const r = await box.remove(uid); await dir.noteUploads(cid, r.count, r.latest); return new Response(null, { status: 204 }); }
  }

  if (method !== "POST") return json({ error: "Not found." }, 404);
  const b = (await readJson(request)) || {};
  const id = String(b.id ?? "");
  if (path === "/api/owner/contact") return json({ contact: await dir.setContact(String(b.contact ?? "").trim().slice(0, 300)) });
  if (!ID.test(id)) return json({ error: "Which customer?" }, 400);
  if (path === "/api/owner/switch") {
    const r = await dir.setSwitch(id, { account: b.account, forecasts: b.forecasts });
    return r.error ? json({ error: "Not found." }, 404) : json(r);
  }
  if (path === "/api/owner/payment") {
    const amount = Number(b.amount);
    if (!Number.isFinite(amount) || amount <= 0 || amount > 1_000_000) return json({ error: "Type the amount received (more than 0)." }, 400);
    const r = await dir.addPayment(id, Math.round(amount * 100), String(b.note ?? "").trim().slice(0, 200));
    return r.error ? json({ error: "Not found." }, 404) : json(r);
  }
  if (path === "/api/owner/payment-delete") return json(await dir.deletePayment(id, String(b.paymentId ?? "")));
  if (path === "/api/owner/delete-customer") {
    const r = await dir.deleteCustomer(id);
    if (r.error) return json({ error: "Not found." }, 404);
    await company(env, id).wipe();
    return json({ ok: true });
  }
  return json({ error: "Not found." }, 404);
}

// ── Files ────────────────────────────────────────────────────────────────────────────────────────────────────────
const bodies = new Map();
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
      try { return await api(request, env, url.pathname); } catch (err) { console.error(err?.stack || err); return json({ error: "Something went wrong. Please try again." }, 500); }
    }
    if (request.method !== "GET" && request.method !== "HEAD") return new Response("Method not allowed", { status: 405, headers: { Allow: "GET, HEAD" } });
    let path;
    try { path = decodeURIComponent(url.pathname); } catch { path = url.pathname; }
    if (/\/index\.html$/.test(path)) return Response.redirect(new URL(path.replace(/index\.html$/, "") + url.search, url), 307);
    if (/\.html$/.test(path) && path !== "/404.html") return Response.redirect(new URL(path.replace(/\.html$/, "") + url.search, url), 307);
    const key = path.endsWith("/") ? path + "index.html" : FILES[path] ? path : FILES[path + ".html"] ? path + ".html" : null;
    if (key && FILES[key]) return respond(request, path, FILES[key]);
    return respond(request, path, FILES["/404.html"], 404);
  },
};
