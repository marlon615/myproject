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
 *   POST /api/recover { email, code, password } → { token, me, recoveryCode }   forgot password, with the recovery code
 *   POST /api/reset-request { email } → { ok }        "I don't have my code": flags it on the owner dashboard
 *   POST /api/reset   { token, password } → { token, me, recoveryCode }         the one-time link the owner sent
 *   POST /api/password { current, password }  (signed in) change password
 *   POST /api/recovery-code { password } → { recoveryCode }  (signed in) a new code; the old one stops working
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
 *   POST /api/owner/reset-link { id } → { token, expires }   one-time password-reset link (24 hours) to send
 *   GET  /api/owner/alerts → { topic }                 phone alerts through ntfy (free app); null = off
 *   POST /api/owner/alerts { make: true } | { off: true }   make a new random topic, or switch alerts off
 *   POST /api/owner/alerts/test → { ok, status }        sends a test alert and reports what ntfy answered
 *
 * Phone alert: when a customer taps "Ask for a reset link" (the first time, real accounts only), the owner's phone
 * gets an ntfy notification with the company and email; tapping it opens /owner. Sent after the reply, so the
 * answer looks the same for any email. At most 30 alerts an hour.
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
const sha256 = async (text) => hex(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text)));
const RESET_HOURS = 24;
/** A recovery code like "K7QM2-XW9TD-4HB8N-RC3PZ" (20 characters from 32, about 100 bits). No 0/O/1/I to misread. */
function newRecoveryCode() {
  const A = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
  const b = crypto.getRandomValues(new Uint8Array(20));
  const c = Array.from(b, (x) => A[x % 32]).join("");
  return c.match(/.{5}/g).join("-");
}
const normCode = (c) => String(c ?? "").toUpperCase().replace(/[^A-Z0-9]/g, "").replace(/O/g, "0").replace(/[IL]/g, "1");
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
    // Password reset (added later; safe on an existing table).
    const cols = new Set(this.sql.exec("PRAGMA table_info(accounts)").toArray().map((c) => c.name));
    const addColumn = (name, decl) => { if (!cols.has(name)) this.sql.exec(`ALTER TABLE accounts ADD COLUMN ${name} ${decl}`); };
    addColumn("recovery_hash", "TEXT");     // sha-256 of the recovery code (the code itself is never kept)
    addColumn("reset_hash", "TEXT");        // sha-256 of the owner's one-time reset link token
    addColumn("reset_expires", "INTEGER");
    addColumn("reset_requested", "TEXT");   // when the customer asked for a reset link
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
      const id = randomHex(16), salt = randomHex(16), code = newRecoveryCode();
      this.sql.exec("INSERT INTO accounts (id, company, email, salt, hash, created, last_seen, recovery_hash) VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
        id, company, email, salt, await hashSecret(password, salt), new Date().toISOString(), new Date().toISOString(), await sha256(normCode(code)));
      this.sql.exec("INSERT INTO signups (t, ip) VALUES (?, ?)", now, ip);
      return { token: this.#session(id), me: this.#me(this.#row(id)), recoveryCode: code };
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

  // ── Passwords ────────────────────────────────────────────────────────────────────────────────────────────────
  /** 5 wrong tries per 15 minutes for each key (an email, or "code:" + email). Returns null when allowed. */
  #tooMany(key) {
    const now = Date.now();
    const fails = JSON.parse(this.sql.exec("SELECT times FROM login_fails WHERE email = ?", key).toArray()[0]?.times || "[]").filter((t) => now - t < 15 * 60 * 1000);
    return fails.length >= 5 ? { error: "wait", retryAfter: Math.ceil((15 * 60 * 1000 - (now - fails[0])) / 1000) } : null;
  }
  #fail(key) {
    const now = Date.now();
    const fails = JSON.parse(this.sql.exec("SELECT times FROM login_fails WHERE email = ?", key).toArray()[0]?.times || "[]").filter((t) => now - t < 15 * 60 * 1000);
    fails.push(now);
    this.sql.exec("INSERT INTO login_fails (email, times) VALUES (?, ?) ON CONFLICT(email) DO UPDATE SET times = excluded.times", key, JSON.stringify(fails));
  }

  /** New password + a fresh recovery code; signed out everywhere, then one new session. Any reset link is used up. */
  async #setPassword(id, password, { keepToken } = {}) {
    const salt = randomHex(16), code = newRecoveryCode();
    this.sql.exec("UPDATE accounts SET salt = ?, hash = ?, recovery_hash = ?, reset_hash = NULL, reset_expires = NULL, reset_requested = NULL WHERE id = ?",
      salt, await hashSecret(password, salt), await sha256(normCode(code)), id);
    this.sql.exec("DELETE FROM sessions WHERE account = ? AND token != ?", id, keepToken || "");
    return { token: keepToken || this.#session(id), me: this.#me(this.#row(id)), recoveryCode: code };
  }

  /** Forgot password: email + recovery code. */
  recover(email, code, password) {
    return this.ctx.blockConcurrencyWhile(async () => {
      const key = `code:${email}`;
      const wait = this.#tooMany(key);
      if (wait) return wait;
      const row = this.sql.exec("SELECT * FROM accounts WHERE email = ?", email).toArray()[0];
      const h = await sha256(normCode(code));
      if (!row || !row.recovery_hash || !sameText(h, row.recovery_hash)) { this.#fail(key); return { error: "wrong" }; }
      this.sql.exec("DELETE FROM login_fails WHERE email IN (?, ?)", key, email);
      if (row.off) return { error: "off" };
      return this.#setPassword(row.id, password);
    });
  }

  /** "I don't have my code": noted for the owner. Same answer whether or not the email has an account.
   *  Returns an alert to send (only the first time for that account, only when alerts are on, at most 30 an hour). */
  requestReset(email) {
    const row = this.sql.exec("SELECT id, company, email, reset_requested FROM accounts WHERE email = ?", email).toArray()[0];
    if (!row || row.reset_requested) return { ok: true };
    this.sql.exec("UPDATE accounts SET reset_requested = ? WHERE id = ?", new Date().toISOString(), row.id);
    const topic = this.alertTopic();
    if (!topic || !this.#alertAllowed()) return { ok: true };
    return { ok: true, alert: { topic, company: row.company, email: row.email } };
  }

  // ── Phone alerts (ntfy) ──────────────────────────────────────────────────────────────────────────────────────
  alertTopic() { return this.#meta("ntfy_topic") || null; }
  /** A new random topic name (about 100 bits), which is what keeps the alerts private on ntfy.sh. */
  makeTopic() {
    const A = "abcdefghijkmnpqrstuvwxyz23456789";
    const topic = "forecast-" + Array.from(crypto.getRandomValues(new Uint8Array(20)), (x) => A[x % 32]).join("");
    this.#setMeta("ntfy_topic", topic);
    return topic;
  }
  alertsOff() { this.sql.exec("DELETE FROM meta WHERE k = 'ntfy_topic'"); return null; }
  #alertAllowed() {
    const now = Date.now();
    const sent = JSON.parse(this.#meta("alerts_sent") || "[]").filter((t) => now - t < 3600 * 1000);
    if (sent.length >= 30) return false;
    sent.push(now);
    this.#setMeta("alerts_sent", JSON.stringify(sent));
    return true;
  }

  /** The owner makes a one-time link (a new one replaces the old). Only its hash is kept. */
  async ownerResetLink(id) {
    if (!this.#row(id)) return { error: "unknown" };
    const token = randomHex(32), expires = Date.now() + RESET_HOURS * 3600 * 1000;
    this.sql.exec("UPDATE accounts SET reset_hash = ?, reset_expires = ? WHERE id = ?", await sha256(token), expires, id);
    return { token, expires };
  }

  /** The customer opens the owner's link and chooses a new password. */
  resetWithToken(token, password) {
    return this.ctx.blockConcurrencyWhile(async () => {
      const row = this.sql.exec("SELECT * FROM accounts WHERE reset_hash = ? AND reset_expires > ?", await sha256(token), Date.now()).toArray()[0];
      if (!row) return { error: "invalid" };
      if (row.off) return { error: "off" };
      return this.#setPassword(row.id, password);
    });
  }

  /** Signed in: change the password (the current one is needed). Other devices are signed out. */
  changePassword(id, token, current, password) {
    return this.ctx.blockConcurrencyWhile(async () => {
      const row = this.#row(id);
      if (!row) return { error: "unknown" };
      const wait = this.#tooMany(row.email);
      if (wait) return wait;
      if (!sameText(await hashSecret(current, row.salt), row.hash)) { this.#fail(row.email); return { error: "wrong" }; }
      return this.#setPassword(id, password, { keepToken: token });
    });
  }

  /** Signed in: a new recovery code (the password is needed); the old code stops working. */
  newRecovery(id, password) {
    return this.ctx.blockConcurrencyWhile(async () => {
      const row = this.#row(id);
      if (!row) return { error: "unknown" };
      const wait = this.#tooMany(row.email);
      if (wait) return wait;
      if (!sameText(await hashSecret(password, row.salt), row.hash)) { this.#fail(row.email); return { error: "wrong" }; }
      const code = newRecoveryCode();
      this.sql.exec("UPDATE accounts SET recovery_hash = ? WHERE id = ?", await sha256(normCode(code)), id);
      return { recoveryCode: code };
    });
  }

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
        ...this.#me(r), lastSeen: r.last_seen, resetRequested: r.reset_requested, resetLinkUntil: r.reset_expires > Date.now() ? r.reset_expires : null, hasRecoveryCode: Boolean(r.recovery_hash), uploads: r.uploads, lastUpload: r.last_upload, lastAccuracy: r.last_accuracy, lastMonths: r.last_months,
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
  if (!months || !months.length || !months.every((m) => typeof m === "string" && YM.test(m))) return { error: "No months could be read from the file." };
  if (months.length > MAX_MONTHS) return { error: `That's ${months.length} months; send the latest ${MAX_MONTHS} at most (refresh the page to get the latest version, which does this for you).` };
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

/** Posts one notification to ntfy (https://ntfy.sh unless NTFY_URL says otherwise, e.g. in tests). */
async function sendAlert(env, topic, { title, message, click, tags, priority = 4 }) {
  const res = await fetch(env.NTFY_URL || "https://ntfy.sh/", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    // JSON publishing keeps names with accents or emoji intact. The dashboard link is the tap action, an
    // "Open dashboard" button, and in the text, so it's reachable however the phone shows the alert.
    body: JSON.stringify({ topic, title, message, click, tags, priority, actions: click ? [{ action: "view", label: "Open dashboard", url: click, clear: true }] : undefined }),
  });
  return { ok: res.ok, status: res.status };
}

const company = (env, id) => env.COMPANY.get(env.COMPANY.idFromName(id));

async function api(request, env, path, ctx) {
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
  const pwError = (p) => (p.length < 8 || p.length > 200 ? "The new password needs at least 8 characters." : null);
  if (path === "/api/recover" && method === "POST") {
    const b = await readJson(request);
    const password = String(b?.password ?? "");
    if (pwError(password)) return json({ error: pwError(password) }, 400);
    const r = await dir.recover(String(b?.email ?? "").trim().toLowerCase(), String(b?.code ?? "").slice(0, 60), password);
    if (r.error === "wait") return json({ error: "Too many wrong tries. Wait a few minutes, then try again." }, 429, { "Retry-After": String(r.retryAfter) });
    if (r.error === "wrong") return json({ error: "That email and recovery code don't match." }, 401);
    if (r.error === "off") return json({ error: "This account is switched off.", off: true, contact: await dir.contact() }, 403);
    return json(r);
  }
  if (path === "/api/reset-request" && method === "POST") {
    const b = await readJson(request);
    const email = String(b?.email ?? "").trim().toLowerCase();
    if (!EMAIL.test(email)) return json({ error: "Type the email you signed up with." }, 400);
    const r = await dir.requestReset(email);
    if (r.alert) {
      const owner = `${new URL(request.url).origin}/owner`;
      // After the reply (waitUntil), so the answer and its timing are the same whether or not an alert goes out.
      ctx?.waitUntil(sendAlert(env, r.alert.topic, {
        title: "Password reset requested",
        message: `${r.alert.company} (${r.alert.email}) asked for a password reset link.\nOpen your owner dashboard: ${owner}`,
        click: owner, tags: ["key"], priority: 4,
      }).catch(() => {}));
    }
    return json({ ok: true, contact: await dir.contact() });
  }
  if (path === "/api/reset" && method === "POST") {
    const b = await readJson(request);
    const password = String(b?.password ?? ""), t = String(b?.token ?? "");
    if (pwError(password)) return json({ error: pwError(password) }, 400);
    if (!/^[0-9a-f]{64}$/.test(t)) return json({ error: "This reset link isn't valid. Ask for a new one." }, 400);
    const r = await dir.resetWithToken(t, password);
    if (r.error === "invalid") return json({ error: "This reset link has expired or was already used. Ask for a new one." }, 410);
    if (r.error === "off") return json({ error: "This account is switched off.", off: true, contact: await dir.contact() }, 403);
    return json(r);
  }

  // Everything below needs a signed-in company that is switched on. The company comes only from the token.
  const me = await dir.who(token);
  if (!me) return json({ error: "Please sign in." }, 401);
  if (me.off) return json({ error: "This account is switched off.", off: true, contact: await dir.contact() }, 403);
  const box = company(env, me.id);

  if (path === "/api/password" && method === "POST") {
    const b = await readJson(request);
    const password = String(b?.password ?? "");
    if (pwError(password)) return json({ error: pwError(password) }, 400);
    const r = await dir.changePassword(me.id, token, String(b?.current ?? "").slice(0, 200), password);
    if (r.error === "wait") return json({ error: "Too many wrong tries. Wait a few minutes, then try again." }, 429);
    if (r.error === "wrong") return json({ error: "Your current password isn't right." }, 400); // 401 means "not signed in"
    return json({ ok: true, recoveryCode: r.recoveryCode });
  }
  if (path === "/api/recovery-code" && method === "POST") {
    const b = await readJson(request);
    const r = await dir.newRecovery(me.id, String(b?.password ?? "").slice(0, 200));
    if (r.error === "wait") return json({ error: "Too many wrong tries. Wait a few minutes, then try again." }, 429);
    if (r.error === "wrong") return json({ error: "Your password isn't right." }, 400); // 401 means "not signed in"
    return json(r);
  }
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
  if (path === "/api/owner/alerts" && method === "GET") return json({ topic: await dir.alertTopic() });
  if (path === "/api/owner/alerts" && method === "POST") {
    const b = (await readJson(request)) || {};
    if (b.off) return json({ topic: await dir.alertsOff() });
    if (b.make) return json({ topic: await dir.makeTopic() });
    return json({ error: "Nothing to do." }, 400);
  }
  if (path === "/api/owner/alerts/test" && method === "POST") {
    const topic = await dir.alertTopic();
    if (!topic) return json({ error: "Phone alerts are off. Make a topic first." }, 409);
    const owner = `${new URL(request.url).origin}/owner`;
    try {
      const r = await sendAlert(env, topic, { title: "Test alert", message: `Phone alerts are working. Example: Sunny Farm (maria@example.com) asked for a password reset link.\nOpen your owner dashboard: ${owner}`, click: owner, tags: ["white_check_mark"], priority: 4 });
      return json(r);
    } catch { return json({ ok: false, status: 0 }); }
  }

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
  if (path === "/api/owner/reset-link") {
    const r = await dir.ownerResetLink(id);
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
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    if (url.pathname.startsWith("/api/")) {
      try { return await api(request, env, url.pathname, ctx); } catch (err) { console.error(err?.stack || err); return json({ error: "Something went wrong. Please try again." }, 500); }
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
