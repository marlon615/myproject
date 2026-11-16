/**
 * The Directory (one for the whole service): companies and their users, sign-in (passwords, two-factor codes,
 * single sign-on), sessions, invites, API keys, the owner's passcode and settings, contracts, payments and
 * feature switches. Sales data never lives here — each company's data is in its own Company object.
 *
 * Older data is upgraded in place: each existing company login becomes that company's first admin user, and its
 * sessions keep working.
 */
import { DurableObject } from "cloudflare:workers";
import * as C from "./crypto.js";
import * as B from "./billing.js";
import { invoicePdf, toBase64 } from "./pdf.js";
import { sendEmail, invoiceEmail, reminderEmail, leadEmail } from "./email.js";

export const FEATURES = ["forecasts", "multiLocation", "inventory", "reports", "connectors", "api", "sso"];
export const ROLES = ["admin", "manager", "viewer"];
export const MIN_CONTRACT_CENTS = 30_000_00;
const DEFAULT_FEATURES = { forecasts: false, multiLocation: true, inventory: false, reports: false, connectors: false, api: false, sso: false };
const MIN = 60_000, HOUR = 3_600_000, DAY = 86_400_000;
const SESSION_DAYS = 30, TICKET_MIN = 5, INVITE_DAYS = 7, RESET_HOURS = 24;

const CODE_ALPHABET = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
function newCode(groups = 4) {
  const b = crypto.getRandomValues(new Uint8Array(groups * 5));
  return Array.from(b, (x) => CODE_ALPHABET[x % 32]).join("").match(/.{5}/g).join("-");
}
const normCode = (c) => String(c ?? "").toUpperCase().replace(/[^A-Z0-9]/g, "").replace(/O/g, "0").replace(/[IL]/g, "1");

export class Directory extends DurableObject {
  constructor(ctx, env) {
    super(ctx, env);
    this.sql = ctx.storage.sql;
    const x = (q) => this.sql.exec(q);
    x(`CREATE TABLE IF NOT EXISTS meta (k TEXT PRIMARY KEY, v TEXT NOT NULL)`);
    x(`CREATE TABLE IF NOT EXISTS owner_sessions (token TEXT PRIMARY KEY, expires INTEGER NOT NULL)`);
    x(`CREATE TABLE IF NOT EXISTS accounts (id TEXT PRIMARY KEY, company TEXT NOT NULL, email TEXT NOT NULL UNIQUE,
      salt TEXT NOT NULL, hash TEXT NOT NULL, created TEXT NOT NULL, last_seen TEXT, off INTEGER NOT NULL DEFAULT 0,
      forecasts INTEGER NOT NULL DEFAULT 0, uploads INTEGER NOT NULL DEFAULT 0, last_upload TEXT, last_accuracy REAL, last_months INTEGER)`);
    x(`CREATE TABLE IF NOT EXISTS sessions (token TEXT PRIMARY KEY, account TEXT NOT NULL, expires INTEGER NOT NULL)`);
    x(`CREATE TABLE IF NOT EXISTS payments (id TEXT PRIMARY KEY, account TEXT NOT NULL, cents INTEGER NOT NULL, note TEXT NOT NULL, created TEXT NOT NULL)`);
    x(`CREATE TABLE IF NOT EXISTS login_fails (email TEXT PRIMARY KEY, times TEXT NOT NULL)`);
    x(`CREATE TABLE IF NOT EXISTS signups (t INTEGER NOT NULL, ip TEXT NOT NULL)`);
    const add = (table, name, decl) => {
      const cols = new Set(this.sql.exec(`PRAGMA table_info(${table})`).toArray().map((c) => c.name));
      if (!cols.has(name)) this.sql.exec(`ALTER TABLE ${table} ADD COLUMN ${name} ${decl}`);
    };
    for (const [n, d] of [["recovery_hash", "TEXT"], ["reset_hash", "TEXT"], ["reset_expires", "INTEGER"], ["reset_requested", "TEXT"],
      ["plan", "TEXT NOT NULL DEFAULT 'Free trial'"], ["contract_cents", "INTEGER NOT NULL DEFAULT 0"], ["contract_start", "TEXT"], ["contract_end", "TEXT"],
      ["features", "TEXT"], ["require_2fa", "INTEGER NOT NULL DEFAULT 0"], ["require_sso", "INTEGER NOT NULL DEFAULT 0"], ["sso_domains", "TEXT NOT NULL DEFAULT ''"],
      ["timezone", "TEXT NOT NULL DEFAULT 'UTC'"], ["connections", "TEXT NOT NULL DEFAULT '[]'"], ["contract_note", "TEXT NOT NULL DEFAULT ''"]]) add("accounts", n, d);
    add("sessions", "user", "TEXT");
    add("sessions", "demo", "INTEGER NOT NULL DEFAULT 0");
    add("accounts", "demo", "INTEGER NOT NULL DEFAULT 0");
    x(`CREATE TABLE IF NOT EXISTS agreements (account TEXT PRIMARY KEY, plan TEXT NOT NULL, billing TEXT NOT NULL, start TEXT NOT NULL, term_start TEXT NOT NULL,
      term_end TEXT NOT NULL, auto_renew INTEGER NOT NULL DEFAULT 1, cancelled_at TEXT, remainder_billed INTEGER NOT NULL DEFAULT 0, created TEXT NOT NULL)`);
    x(`CREATE TABLE IF NOT EXISTS invoices (id TEXT PRIMARY KEY, number TEXT NOT NULL UNIQUE, account TEXT NOT NULL, kind TEXT NOT NULL DEFAULT 'regular',
      period_start TEXT NOT NULL, period_end TEXT NOT NULL, description TEXT NOT NULL, amount_cents INTEGER NOT NULL, issued TEXT NOT NULL, due TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'open', paid_at TEXT, paid_note TEXT, sent_count INTEGER NOT NULL DEFAULT 0, last_sent TEXT, reminders INTEGER NOT NULL DEFAULT 0,
      last_reminder TEXT, UNIQUE (account, period_start, kind))`);
    x(`CREATE TABLE IF NOT EXISTS demo_visits (id INTEGER PRIMARY KEY AUTOINCREMENT, t TEXT NOT NULL, city TEXT NOT NULL DEFAULT '', region TEXT NOT NULL DEFAULT '',
      country TEXT NOT NULL DEFAULT '', device TEXT NOT NULL DEFAULT '', referrer TEXT NOT NULL DEFAULT '', source TEXT NOT NULL DEFAULT '', lead TEXT)`);
    x(`CREATE TABLE IF NOT EXISTS leads (id TEXT PRIMARY KEY, t TEXT NOT NULL, name TEXT NOT NULL, email TEXT NOT NULL, company TEXT NOT NULL, title TEXT NOT NULL DEFAULT '',
      phone TEXT NOT NULL DEFAULT '', locations TEXT NOT NULL DEFAULT '', message TEXT NOT NULL DEFAULT '', wants_call INTEGER NOT NULL DEFAULT 0, visit INTEGER,
      city TEXT NOT NULL DEFAULT '', country TEXT NOT NULL DEFAULT '', status TEXT NOT NULL DEFAULT 'new', emailed INTEGER NOT NULL DEFAULT 0, alerted INTEGER NOT NULL DEFAULT 0)`);
    x(`CREATE TABLE IF NOT EXISTS lead_limits (k TEXT PRIMARY KEY, times TEXT NOT NULL)`);
    x(`CREATE TABLE IF NOT EXISTS users (id TEXT PRIMARY KEY, account TEXT NOT NULL, email TEXT NOT NULL UNIQUE, name TEXT NOT NULL DEFAULT '',
      role TEXT NOT NULL, pw TEXT, salt TEXT, recovery_hash TEXT, reset_hash TEXT, reset_expires INTEGER, reset_requested TEXT,
      invite_hash TEXT, invite_expires INTEGER, totp_enc TEXT, totp_pending TEXT, totp_on INTEGER NOT NULL DEFAULT 0, totp_last INTEGER,
      backup_codes TEXT NOT NULL DEFAULT '[]', sso TEXT, created TEXT NOT NULL, last_login TEXT, off INTEGER NOT NULL DEFAULT 0,
      prefs TEXT NOT NULL DEFAULT '{"reports":true,"lowStock":true}')`);
    x(`CREATE INDEX IF NOT EXISTS users_account ON users(account)`);
    x(`CREATE TABLE IF NOT EXISTS tickets (ticket TEXT PRIMARY KEY, user TEXT NOT NULL, expires INTEGER NOT NULL, tries INTEGER NOT NULL DEFAULT 0)`);
    x(`CREATE TABLE IF NOT EXISTS sso_states (state TEXT PRIMARY KEY, provider TEXT NOT NULL, verifier TEXT NOT NULL, nonce TEXT NOT NULL, invite TEXT, expires INTEGER NOT NULL)`);
    x(`CREATE TABLE IF NOT EXISTS sso_codes (code TEXT PRIMARY KEY, token TEXT NOT NULL, expires INTEGER NOT NULL)`);
    x(`CREATE TABLE IF NOT EXISTS api_keys (hash TEXT PRIMARY KEY, account TEXT NOT NULL, prefix TEXT NOT NULL, name TEXT NOT NULL, scopes TEXT NOT NULL,
      created TEXT NOT NULL, created_by TEXT, last_used TEXT, revoked INTEGER NOT NULL DEFAULT 0, calls TEXT NOT NULL DEFAULT '[]')`);
    x(`CREATE TABLE IF NOT EXISTS owner_log (id INTEGER PRIMARY KEY AUTOINCREMENT, t TEXT NOT NULL, action TEXT NOT NULL, account TEXT, detail TEXT NOT NULL DEFAULT '')`);
    // Upgrade: each company login from before becomes that company's first admin; its sessions keep working.
    for (const a of this.sql.exec("SELECT a.* FROM accounts a WHERE NOT EXISTS (SELECT 1 FROM users u WHERE u.account = a.id)").toArray()) {
      this.sql.exec(`INSERT INTO users (id, account, email, name, role, pw, salt, recovery_hash, reset_hash, reset_expires, reset_requested, created, last_login)
        VALUES (?, ?, ?, '', 'admin', ?, ?, ?, ?, ?, ?, ?, ?)`, C.randomHex(16), a.id, a.email, a.hash, a.salt, a.recovery_hash, a.reset_hash, a.reset_expires, a.reset_requested, a.created, a.last_seen);
    }
    this.sql.exec("UPDATE sessions SET user = (SELECT id FROM users WHERE users.account = sessions.account AND role = 'admin' ORDER BY created LIMIT 1) WHERE user IS NULL");
  }

  #meta(k) { return this.sql.exec("SELECT v FROM meta WHERE k = ?", k).toArray()[0]?.v ?? null; }
  #setMeta(k, v) { if (v === null || v === undefined) this.sql.exec("DELETE FROM meta WHERE k = ?", k); else this.sql.exec("INSERT INTO meta (k, v) VALUES (?, ?) ON CONFLICT(k) DO UPDATE SET v = excluded.v", k, String(v)); }
  get #key() { return this.env.ENCRYPTION_KEY; }
  get #rounds() { return Math.max(5000, Number(this.env.PBKDF2_ITERATIONS) || 5000); }
  #log(action, account = null, detail = "") { this.sql.exec("INSERT INTO owner_log (t, action, account, detail) VALUES (?, ?, ?, ?)", new Date().toISOString(), action, account, String(detail).slice(0, 500)); }

  // ── Owner passcode ───────────────────────────────────────────────────────────────────────────────────────────
  #generation() { return String(this.env?.OWNER_GENERATION ?? "1"); }
  #claimed() { return Boolean(this.#meta("hash")) && this.#meta("gen") === this.#generation(); }
  ownerState() { return { claimed: this.#claimed() }; }
  ownerClaim(passcode) {
    return this.ctx.blockConcurrencyWhile(async () => {
      if (this.#claimed()) return { error: "taken" };
      this.#setMeta("hash", await C.hashPassword(passcode, this.#rounds)); this.#setMeta("salt", "");
      this.#setMeta("gen", this.#generation()); this.#setMeta("fails", "[]");
      this.sql.exec("DELETE FROM owner_sessions");
      this.#log("owner passcode set");
      return { token: this.#ownerSession() };
    });
  }
  ownerLogin(passcode) {
    return this.ctx.blockConcurrencyWhile(async () => {
      const now = Date.now();
      const fails = JSON.parse(this.#meta("fails") || "[]").filter((t) => now - t < 15 * MIN);
      if (fails.length >= 5) return { error: "wait", retryAfter: Math.ceil((15 * MIN - (now - fails[0])) / 1000) };
      if (!this.#claimed()) return { error: "unclaimed" };
      if (!(await C.checkPassword(passcode, this.#meta("hash"), this.#meta("salt")))) {
        fails.push(now); this.#setMeta("fails", JSON.stringify(fails));
        return { error: "wrong", left: Math.max(0, 5 - fails.length) };
      }
      this.#setMeta("fails", "[]");
      return { token: this.#ownerSession() };
    });
  }
  #ownerSession() {
    const token = C.randomHex(32);
    this.sql.exec("DELETE FROM owner_sessions WHERE expires < ?", Date.now());
    this.sql.exec("INSERT INTO owner_sessions (token, expires) VALUES (?, ?)", token, Date.now() + 12 * HOUR);
    return token;
  }
  ownerCheck(token) { return Boolean(token) && this.#claimed() && this.sql.exec("SELECT 1 FROM owner_sessions WHERE token = ? AND expires > ?", token, Date.now()).toArray().length > 0; }
  ownerLogout(token) { this.sql.exec("DELETE FROM owner_sessions WHERE token = ?", token); }
  ownerLog(limit = 200) { return this.sql.exec("SELECT * FROM owner_log ORDER BY id DESC LIMIT ?", limit).toArray(); }
  logOwner(action, account, detail) { this.#log(action, account, detail); }

  /** Draxly's contact email (wrangler.toml CONTACT_EMAIL). */
  contactEmail() { return String(this.env?.CONTACT_EMAIL || "").trim(); }
  /** What customers are told to do to get in touch: the owner's saved text, or the contact email. Any other email address in it
   *  is replaced by the contact email, so there is only ever one address. */
  contact() { return this.#oneEmail(this.#meta("contact")) || this.contactEmail(); }
  #oneEmail(text) { const e = this.contactEmail(); return text && e ? String(text).replace(/[A-Za-z0-9._%+-]+@[A-Za-z0-9-]+(\.[A-Za-z0-9-]+)+/g, e) : text || ""; }
  setContact(text) { this.#setMeta("contact", text); return this.contact(); }

  // ── Platform settings (email, sign-in apps, QuickBooks app): secrets are encrypted ──────────────────────────────
  static SETTINGS = { emailFrom: false, emailKey: true, msClientId: false, msSecret: true, googleClientId: false, googleSecret: true, qbClientId: false, qbSecret: true,
    billingName: false, paymentInstructions: false, ownerEmail: false };
  /** Settings with a built-in default (wrangler.toml [vars]) used until the owner changes them. */
  #default(k) { return k === "billingName" ? this.env.BILLING_NAME || "Draxly" : k === "ownerEmail" ? this.contactEmail() : ""; }
  #setting(k) { return k === "ownerEmail" ? this.contactEmail() || this.#meta("set_ownerEmail") || "" : this.#meta(`set_${k}`) || this.#default(k); } // one contact email, set in wrangler.toml
  platform() {
    const out = {};
    for (const [k, secret] of Object.entries(Directory.SETTINGS)) out[k] = secret ? Boolean(this.#meta(`set_${k}`)) : this.#setting(k);
    return out;
  }
  async setPlatform(patch) {
    for (const [k, secret] of Object.entries(Directory.SETTINGS)) {
      if (!(k in patch)) continue;
      const v = String(patch[k] ?? "").trim().slice(0, k === "paymentInstructions" ? 1500 : 500);
      this.#setMeta(`set_${k}`, v ? (secret ? await C.encrypt(this.#key, v) : v) : null);
      this.#log("platform setting changed", null, k);
    }
    return this.platform();
  }
  /** Decrypted secret for the Worker's own use (sending email, finishing a sign-in). Never sent to a browser. */
  async secret(k) { const v = this.#meta(`set_${k}`); return Directory.SETTINGS[k] ? C.decrypt(this.#key, v) : v || this.#default(k); }
  ssoProviders() { const p = this.platform(); return { microsoft: Boolean(p.msClientId && p.msSecret), google: Boolean(p.googleClientId && p.googleSecret) }; }

  // ── Phone alerts (ntfy) ──────────────────────────────────────────────────────────────────────────────────────
  alertTopic() { return this.#meta("ntfy_topic") || null; }
  makeTopic() {
    const A = "abcdefghijkmnpqrstuvwxyz23456789";
    const topic = "draxly-" + Array.from(crypto.getRandomValues(new Uint8Array(20)), (x) => A[x % 32]).join("");
    this.#setMeta("ntfy_topic", topic);
    return topic;
  }
  alertsOff() { this.#setMeta("ntfy_topic", null); return null; }
  #alertAllowed() {
    const now = Date.now();
    const sent = JSON.parse(this.#meta("alerts_sent") || "[]").filter((t) => now - t < HOUR);
    if (sent.length >= 30) return false;
    sent.push(now); this.#setMeta("alerts_sent", JSON.stringify(sent));
    return true;
  }

  // ── Companies, users, "me" ───────────────────────────────────────────────────────────────────────────────────
  #account(id) { return this.sql.exec("SELECT * FROM accounts WHERE id = ?", id).toArray()[0] || null; }
  #user(id) { return this.sql.exec("SELECT * FROM users WHERE id = ?", id).toArray()[0] || null; }
  #userByEmail(email) { return this.sql.exec("SELECT * FROM users WHERE email = ?", email).toArray()[0] || null; }
  #features(a) {
    const f = { ...DEFAULT_FEATURES, ...(a.features ? JSON.parse(a.features) : {}) };
    f.forecasts = Boolean(a.forecasts); // the original switch stays the source of truth for forecasts
    return f;
  }
  #me(a, u) {
    return {
      id: a.id, company: a.company, email: u.email, off: Boolean(a.off), forecasts: Boolean(a.forecasts), created: a.created,
      role: u.role, user: { id: u.id, email: u.email, name: u.name, role: u.role, twoFactor: Boolean(u.totp_on), sso: u.sso || null, prefs: JSON.parse(u.prefs || "{}") },
      features: this.#features(a), plan: a.plan, require2fa: Boolean(a.require_2fa), requireSso: Boolean(a.require_sso), timezone: a.timezone,
      mustEnroll2fa: Boolean(a.require_2fa) && !u.totp_on && !u.sso,
    };
  }
  /** Who a session token belongs to (company + user), or null. Every customer request starts here. */
  who(token) {
    if (!token) return null;
    const s = this.sql.exec("SELECT account, user, demo FROM sessions WHERE token = ? AND expires > ?", token, Date.now()).toArray()[0];
    if (!s) return null;
    const a = this.#account(s.account), u = s.user && this.#user(s.user);
    if (!a || !u || u.account !== a.id || u.off) return null;
    const today = new Date().toISOString().slice(0, 10);
    if ((a.last_seen || "").slice(0, 10) !== today) this.sql.exec("UPDATE accounts SET last_seen = ? WHERE id = ?", new Date().toISOString(), a.id);
    return this.#me(a, u);
  }
  logout(token) { this.sql.exec("DELETE FROM sessions WHERE token = ?", token); }
  #session(account, user) {
    const token = C.randomHex(32);
    this.sql.exec("DELETE FROM sessions WHERE expires < ?", Date.now());
    this.sql.exec("INSERT INTO sessions (token, account, user, expires) VALUES (?, ?, ?, ?)", token, account, user, Date.now() + SESSION_DAYS * DAY);
    this.sql.exec("UPDATE users SET last_login = ? WHERE id = ?", new Date().toISOString(), user);
    return token;
  }
  #signedIn(u) { const a = this.#account(u.account); return { token: this.#session(a.id, u.id), me: this.#me(a, u) }; }

  #tooMany(key) {
    const now = Date.now();
    const fails = JSON.parse(this.sql.exec("SELECT times FROM login_fails WHERE email = ?", key).toArray()[0]?.times || "[]").filter((t) => now - t < 15 * MIN);
    return fails.length >= 5 ? { error: "wait", retryAfter: Math.ceil((15 * MIN - (now - fails[0])) / 1000) } : null;
  }
  #fail(key) {
    const now = Date.now();
    const fails = JSON.parse(this.sql.exec("SELECT times FROM login_fails WHERE email = ?", key).toArray()[0]?.times || "[]").filter((t) => now - t < 15 * MIN);
    fails.push(now);
    this.sql.exec("INSERT INTO login_fails (email, times) VALUES (?, ?) ON CONFLICT(email) DO UPDATE SET times = excluded.times", key, JSON.stringify(fails));
  }

  signup(company, email, password, ip) {
    return this.ctx.blockConcurrencyWhile(async () => {
      const now = Date.now();
      this.sql.exec("DELETE FROM signups WHERE t < ?", now - HOUR);
      if (this.sql.exec("SELECT COUNT(*) AS n FROM signups WHERE ip = ?", ip).one().n >= 10) return { error: "busy" };
      if (this.#userByEmail(email) || this.sql.exec("SELECT 1 FROM accounts WHERE email = ?", email).toArray().length) return { error: "exists" };
      const id = C.randomHex(16), uid = C.randomHex(16), code = newCode(), pw = await C.hashPassword(password, this.#rounds), iso = new Date().toISOString();
      this.sql.exec("INSERT INTO accounts (id, company, email, salt, hash, created, last_seen, features) VALUES (?, ?, ?, '', ?, ?, ?, ?)", id, company, email, pw, iso, iso, JSON.stringify(DEFAULT_FEATURES));
      this.sql.exec("INSERT INTO users (id, account, email, role, pw, recovery_hash, created) VALUES (?, ?, ?, 'admin', ?, ?, ?)", uid, id, email, pw, await C.sha256(normCode(code)), iso);
      this.sql.exec("INSERT INTO signups (t, ip) VALUES (?, ?)", now, ip);
      return { ...this.#signedIn(this.#user(uid)), recoveryCode: code };
    });
  }

  /** Password sign-in. With two-factor on, returns a 5-minute ticket for the code instead of a session. */
  login(email, password) {
    return this.ctx.blockConcurrencyWhile(async () => {
      const wait = this.#tooMany(email);
      if (wait) return wait;
      const u = this.#userByEmail(email);
      const ok = await C.checkPassword(password, u?.pw, u?.salt); // same work whether or not the email exists
      if (!u || !ok) { this.#fail(email); return { error: "wrong", account: u?.account }; }
      this.sql.exec("DELETE FROM login_fails WHERE email = ?", email);
      const a = this.#account(u.account);
      if (a.off) return { error: "off", account: a.id };
      if (u.off) return { error: "userOff", account: a.id };
      if (a.require_sso) return { error: "sso", account: a.id };
      if (C.passwordRounds(u.pw) < this.#rounds) this.sql.exec("UPDATE users SET pw = ?, salt = NULL WHERE id = ?", await C.hashPassword(password, this.#rounds), u.id); // stronger hashing as settings rise
      return this.#afterPassword(u);
    });
  }
  #afterPassword(u) {
    if (u.totp_on) {
      const ticket = C.randomHex(24);
      this.sql.exec("DELETE FROM tickets WHERE expires < ?", Date.now());
      this.sql.exec("INSERT INTO tickets (ticket, user, expires) VALUES (?, ?, ?)", ticket, u.id, Date.now() + TICKET_MIN * MIN);
      return { twoFactor: true, ticket, account: u.account };
    }
    return { ...this.#signedIn(u), account: u.account };
  }
  /** The second step: a 6-digit code from the authenticator app, or one of the one-time backup codes. */
  login2fa(ticket, code) {
    return this.ctx.blockConcurrencyWhile(async () => {
      const t = this.sql.exec("SELECT * FROM tickets WHERE ticket = ? AND expires > ?", String(ticket), Date.now()).toArray()[0];
      if (!t) return { error: "expired" };
      const u = this.#user(t.user);
      if (!u || u.off) return { error: "expired" };
      const wait = this.#tooMany(`2fa:${u.email}`);
      if (wait) return { ...wait, account: u.account };
      if (t.tries >= 5) { this.sql.exec("DELETE FROM tickets WHERE ticket = ?", t.ticket); return { error: "expired" }; }
      const step = await C.checkTotp(await C.decrypt(this.#key, u.totp_enc), code);
      let ok = step !== null && step !== u.totp_last; // a code can't be used twice
      let usedBackup = false;
      if (!ok) {
        const codes = JSON.parse(u.backup_codes || "[]"), h = await C.sha256(normCode(code));
        if (codes.includes(h)) { ok = true; usedBackup = true; this.sql.exec("UPDATE users SET backup_codes = ? WHERE id = ?", JSON.stringify(codes.filter((c) => c !== h)), u.id); }
      }
      if (!ok) {
        this.sql.exec("UPDATE tickets SET tries = tries + 1 WHERE ticket = ?", t.ticket);
        this.#fail(`2fa:${u.email}`);
        return { error: "wrong", account: u.account };
      }
      if (step !== null && !usedBackup) this.sql.exec("UPDATE users SET totp_last = ? WHERE id = ?", step, u.id);
      this.sql.exec("DELETE FROM tickets WHERE ticket = ?", t.ticket);
      this.sql.exec("DELETE FROM login_fails WHERE email = ?", `2fa:${u.email}`);
      return { ...this.#signedIn(this.#user(u.id)), usedBackup, backupLeft: JSON.parse(this.#user(u.id).backup_codes).length, account: u.account };
    });
  }

  // Two-factor setup (signed in).
  async totpSetup(userId) {
    const u = this.#user(userId);
    const secret = C.newTotpSecret();
    this.sql.exec("UPDATE users SET totp_pending = ? WHERE id = ?", await C.encrypt(this.#key, secret), userId);
    return { secret, uri: C.totpUri(secret, u.email) };
  }
  totpEnable(userId, code) {
    return this.ctx.blockConcurrencyWhile(async () => {
      const u = this.#user(userId);
      if (!u?.totp_pending) return { error: "setup" };
      const secret = await C.decrypt(this.#key, u.totp_pending);
      const step = await C.checkTotp(secret, code);
      if (step === null) return { error: "wrong" };
      const backup = Array.from({ length: 10 }, () => newCode(2));
      this.sql.exec("UPDATE users SET totp_enc = totp_pending, totp_pending = NULL, totp_on = 1, totp_last = ?, backup_codes = ? WHERE id = ?",
        step, JSON.stringify(await Promise.all(backup.map((c) => C.sha256(normCode(c))))), userId);
      return { ok: true, backupCodes: backup };
    });
  }
  totpDisable(userId, password) {
    return this.ctx.blockConcurrencyWhile(async () => {
      const u = this.#user(userId), a = this.#account(u.account);
      if (a.require_2fa) return { error: "required" };
      if (!(await C.checkPassword(password, u.pw, u.salt))) return { error: "wrong" };
      this.sql.exec("UPDATE users SET totp_on = 0, totp_enc = NULL, totp_pending = NULL, backup_codes = '[]' WHERE id = ?", userId);
      return { ok: true };
    });
  }

  // Password resets (recovery code, owner's or admin's one-time link) and changes.
  async #setPassword(u, password, { keepToken } = {}) {
    const code = newCode();
    this.sql.exec("UPDATE users SET pw = ?, salt = NULL, recovery_hash = ?, reset_hash = NULL, reset_expires = NULL, reset_requested = NULL, invite_hash = NULL, invite_expires = NULL WHERE id = ?",
      await C.hashPassword(password, this.#rounds), await C.sha256(normCode(code)), u.id);
    this.sql.exec("DELETE FROM sessions WHERE user = ? AND token != ?", u.id, keepToken || "");
    if (keepToken) return { token: keepToken, me: this.#me(this.#account(u.account), this.#user(u.id)), recoveryCode: code };
    const next = this.#afterPassword(this.#user(u.id)); // two-factor still applies after a reset
    return { ...next, recoveryCode: code };
  }
  recover(email, code, password) {
    return this.ctx.blockConcurrencyWhile(async () => {
      const key = `code:${email}`;
      const wait = this.#tooMany(key);
      if (wait) return wait;
      const u = this.#userByEmail(email);
      const h = await C.sha256(normCode(code));
      if (!u || !u.recovery_hash || !C.sameText(h, u.recovery_hash)) { this.#fail(key); return { error: "wrong", account: u?.account }; }
      this.sql.exec("DELETE FROM login_fails WHERE email IN (?, ?)", key, email);
      if (this.#account(u.account).off) return { error: "off", account: u.account };
      return { ...(await this.#setPassword(u, password)), account: u.account };
    });
  }
  requestReset(email) {
    const u = this.#userByEmail(email);
    if (!u || u.reset_requested) return { ok: true };
    this.sql.exec("UPDATE users SET reset_requested = ? WHERE id = ?", new Date().toISOString(), u.id);
    const topic = this.alertTopic();
    const a = this.#account(u.account);
    if (!topic || !this.#alertAllowed()) return { ok: true, account: a.id };
    return { ok: true, account: a.id, alert: { topic, company: a.company, email: u.email } };
  }
  /** One-time reset link. `id` is a user id, or a company id (its first admin), for the owner dashboard. */
  async resetLink(id, { account } = {}) {
    let u = this.#user(id);
    if (!u) u = this.sql.exec("SELECT * FROM users WHERE account = ? AND role = 'admin' ORDER BY created LIMIT 1", id).toArray()[0];
    if (!u || (account && u.account !== account)) return { error: "unknown" };
    const token = C.randomHex(32), expires = Date.now() + RESET_HOURS * HOUR;
    this.sql.exec("UPDATE users SET reset_hash = ?, reset_expires = ? WHERE id = ?", await C.sha256(token), expires, u.id);
    return { token, expires, user: u.email, account: u.account };
  }
  resetWithToken(token, password) {
    return this.ctx.blockConcurrencyWhile(async () => {
      const u = this.sql.exec("SELECT * FROM users WHERE reset_hash = ? AND reset_expires > ?", await C.sha256(token), Date.now()).toArray()[0];
      if (!u) return { error: "invalid" };
      if (this.#account(u.account).off) return { error: "off", account: u.account };
      return { ...(await this.#setPassword(u, password)), account: u.account };
    });
  }
  changePassword(userId, token, current, password) {
    return this.ctx.blockConcurrencyWhile(async () => {
      const u = this.#user(userId);
      if (!u) return { error: "unknown" };
      const wait = this.#tooMany(u.email);
      if (wait) return wait;
      if (!(await C.checkPassword(current, u.pw, u.salt))) { this.#fail(u.email); return { error: "wrong" }; }
      return this.#setPassword(u, password, { keepToken: token });
    });
  }
  newRecovery(userId, password) {
    return this.ctx.blockConcurrencyWhile(async () => {
      const u = this.#user(userId);
      if (!u) return { error: "unknown" };
      const wait = this.#tooMany(u.email);
      if (wait) return wait;
      if (!(await C.checkPassword(password, u.pw, u.salt))) { this.#fail(u.email); return { error: "wrong" }; }
      const code = newCode();
      this.sql.exec("UPDATE users SET recovery_hash = ? WHERE id = ?", await C.sha256(normCode(code)), userId);
      return { recoveryCode: code };
    });
  }
  setPrefs(userId, prefs) {
    const u = this.#user(userId);
    const p = { ...JSON.parse(u.prefs || "{}") };
    for (const k of ["reports", "lowStock"]) if (typeof prefs[k] === "boolean") p[k] = prefs[k];
    this.sql.exec("UPDATE users SET prefs = ? WHERE id = ?", JSON.stringify(p), userId);
    return p;
  }

  // ── Team (company admins) ────────────────────────────────────────────────────────────────────────────────────
  #userOut(u) { return { id: u.id, email: u.email, name: u.name, role: u.role, twoFactor: Boolean(u.totp_on), sso: u.sso || null, invited: Boolean(u.invite_hash) && !u.pw, off: Boolean(u.off), lastLogin: u.last_login, created: u.created, prefs: JSON.parse(u.prefs || "{}") }; }
  users(account) { return this.sql.exec("SELECT * FROM users WHERE account = ? ORDER BY created", account).toArray().map((u) => this.#userOut(u)); }
  /** Recipients for emails: switched-on users with a role in `roles` and the preference on. */
  recipients(account, pref, roles = ["admin", "manager"]) {
    return this.sql.exec("SELECT * FROM users WHERE account = ? AND off = 0", account).toArray()
      .filter((u) => roles.includes(u.role) && JSON.parse(u.prefs || "{}")[pref] !== false && (u.pw || u.sso)).map((u) => ({ email: u.email, name: u.name, role: u.role }));
  }
  async invite(account, email, name, role) {
    if (!ROLES.includes(role)) return { error: "role" };
    if (this.#userByEmail(email)) return { error: "exists" };
    const id = C.randomHex(16), token = C.randomHex(32);
    this.sql.exec("INSERT INTO users (id, account, email, name, role, invite_hash, invite_expires, created) VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
      id, account, email, name, role, await C.sha256(token), Date.now() + INVITE_DAYS * DAY, new Date().toISOString());
    return { user: this.#userOut(this.#user(id)), token, expires: Date.now() + INVITE_DAYS * DAY };
  }
  async reinvite(account, userId) {
    const u = this.#user(userId);
    if (!u || u.account !== account || u.pw) return { error: "unknown" };
    const token = C.randomHex(32);
    this.sql.exec("UPDATE users SET invite_hash = ?, invite_expires = ? WHERE id = ?", await C.sha256(token), Date.now() + INVITE_DAYS * DAY, u.id);
    return { token, expires: Date.now() + INVITE_DAYS * DAY, email: u.email };
  }
  async inviteInfo(token) {
    const u = this.sql.exec("SELECT * FROM users WHERE invite_hash = ? AND invite_expires > ?", await C.sha256(String(token)), Date.now()).toArray()[0];
    if (!u) return null;
    const a = this.#account(u.account);
    return { email: u.email, name: u.name, company: a.company, role: u.role, requireSso: Boolean(a.require_sso), sso: this.ssoProviders() };
  }
  acceptInvite(token, name, password) {
    return this.ctx.blockConcurrencyWhile(async () => {
      const u = this.sql.exec("SELECT * FROM users WHERE invite_hash = ? AND invite_expires > ?", await C.sha256(String(token)), Date.now()).toArray()[0];
      if (!u) return { error: "invalid" };
      const a = this.#account(u.account);
      if (a.off) return { error: "off", account: a.id };
      if (a.require_sso) return { error: "sso", account: a.id };
      if (name) this.sql.exec("UPDATE users SET name = ? WHERE id = ?", name, u.id);
      return { ...(await this.#setPassword(this.#user(u.id), password)), account: a.id, email: u.email };
    });
  }
  setUser(account, userId, { role, off, name }) {
    const u = this.#user(userId);
    if (!u || u.account !== account) return { error: "unknown" };
    const admins = this.sql.exec("SELECT COUNT(*) AS n FROM users WHERE account = ? AND role = 'admin' AND off = 0", account).one().n;
    const losingAdmin = u.role === "admin" && !u.off && ((role && role !== "admin") || off === true);
    if (losingAdmin && admins <= 1) return { error: "lastAdmin" };
    if (role) { if (!ROLES.includes(role)) return { error: "role" }; this.sql.exec("UPDATE users SET role = ? WHERE id = ?", role, userId); }
    if (typeof off === "boolean") { this.sql.exec("UPDATE users SET off = ? WHERE id = ?", off ? 1 : 0, userId); if (off) this.sql.exec("DELETE FROM sessions WHERE user = ?", userId); }
    if (typeof name === "string") this.sql.exec("UPDATE users SET name = ? WHERE id = ?", name.slice(0, 100), userId);
    return { ok: true, user: this.#userOut(this.#user(userId)) };
  }
  removeUser(account, userId) {
    const u = this.#user(userId);
    if (!u || u.account !== account) return { error: "unknown" };
    if (u.role === "admin" && this.sql.exec("SELECT COUNT(*) AS n FROM users WHERE account = ? AND role = 'admin' AND off = 0", account).one().n <= 1 && !u.off) return { error: "lastAdmin" };
    this.sql.exec("DELETE FROM sessions WHERE user = ?", userId);
    this.sql.exec("DELETE FROM users WHERE id = ?", userId);
    return { ok: true, email: u.email };
  }
  signOutEveryone(account, exceptToken) { this.sql.exec("DELETE FROM sessions WHERE account = ? AND token != ?", account, exceptToken || ""); return { ok: true }; }

  // Company security settings (admins).
  companySettings(account) {
    const a = this.#account(account);
    return { require2fa: Boolean(a.require_2fa), requireSso: Boolean(a.require_sso), ssoDomains: a.sso_domains, timezone: a.timezone, providers: this.ssoProviders(), features: this.#features(a) };
  }
  setCompanySettings(account, patch) {
    const a = this.#account(account), f = this.#features(a);
    if (typeof patch.require2fa === "boolean") this.sql.exec("UPDATE accounts SET require_2fa = ? WHERE id = ?", patch.require2fa ? 1 : 0, account);
    if (typeof patch.requireSso === "boolean") {
      if (patch.requireSso && (!f.sso || !Object.values(this.ssoProviders()).some(Boolean))) return { error: "sso" };
      this.sql.exec("UPDATE accounts SET require_sso = ? WHERE id = ?", patch.requireSso ? 1 : 0, account);
    }
    if (typeof patch.ssoDomains === "string") {
      const d = patch.ssoDomains.toLowerCase().split(/[\s,]+/).map((x) => x.replace(/^@/, "").trim()).filter((x) => /^[a-z0-9.-]+\.[a-z]{2,}$/.test(x)).slice(0, 20);
      this.sql.exec("UPDATE accounts SET sso_domains = ? WHERE id = ?", d.join(", "), account);
    }
    if (typeof patch.timezone === "string") {
      let ok = true; try { new Intl.DateTimeFormat("en-US", { timeZone: patch.timezone }); } catch { ok = false; }
      if (!ok) return { error: "timezone" };
      this.sql.exec("UPDATE accounts SET timezone = ? WHERE id = ?", patch.timezone, account);
    }
    return { ok: true, settings: this.companySettings(account) };
  }

  // ── Single sign-on (Microsoft, Google) ───────────────────────────────────────────────────────────────────────
  ssoBegin(provider, verifier, invite) {
    const state = C.randomHex(24), nonce = C.randomHex(16);
    this.sql.exec("DELETE FROM sso_states WHERE expires < ?", Date.now());
    this.sql.exec("INSERT INTO sso_states (state, provider, verifier, nonce, invite, expires) VALUES (?, ?, ?, ?, ?, ?)", state, provider, verifier, nonce, invite || null, Date.now() + 10 * MIN);
    return { state, nonce };
  }
  ssoTake(state) {
    const s = this.sql.exec("SELECT * FROM sso_states WHERE state = ? AND expires > ?", String(state), Date.now()).toArray()[0];
    if (s) this.sql.exec("DELETE FROM sso_states WHERE state = ?", s.state);
    return s || null;
  }
  /** A verified identity from Microsoft or Google → a session (existing user, invite, or the company's allowed domain). */
  async ssoSignIn(provider, email, subject, invite) {
    email = String(email).toLowerCase();
    let u = this.#userByEmail(email);
    if (!u && invite) {
      const inv = this.sql.exec("SELECT * FROM users WHERE invite_hash = ? AND invite_expires > ?", await C.sha256(invite), Date.now()).toArray()[0];
      if (inv && inv.email === email) u = inv;
    }
    if (!u) {
      const domain = email.split("@")[1];
      const a = this.sql.exec("SELECT * FROM accounts WHERE require_sso = 1 OR sso_domains != ''").toArray()
        .find((x) => this.#features(x).sso && x.sso_domains.split(/,\s*/).includes(domain));
      if (!a) return { error: "unknown" };
      const id = C.randomHex(16);
      this.sql.exec("INSERT INTO users (id, account, email, role, sso, created) VALUES (?, ?, ?, 'viewer', ?, ?)", id, a.id, email, provider, new Date().toISOString());
      u = this.#user(id);
      return { ...this.#ssoSession(u, provider, subject), joined: true };
    }
    const a = this.#account(u.account);
    if (a.off) return { error: "off", account: a.id };
    if (u.off) return { error: "userOff", account: a.id };
    if (!this.#features(a).sso) return { error: "notEnabled", account: a.id };
    return this.#ssoSession(u, provider, subject);
  }
  #ssoSession(u, provider) {
    this.sql.exec("UPDATE users SET sso = ?, invite_hash = NULL, invite_expires = NULL WHERE id = ?", provider, u.id);
    const s = this.#signedIn(this.#user(u.id));
    const code = C.randomHex(24);
    this.sql.exec("DELETE FROM sso_codes WHERE expires < ?", Date.now());
    this.sql.exec("INSERT INTO sso_codes (code, token, expires) VALUES (?, ?, ?)", code, s.token, Date.now() + 2 * MIN);
    return { code, account: u.account, email: u.email };
  }
  ssoRedeem(code) {
    const c = this.sql.exec("SELECT * FROM sso_codes WHERE code = ? AND expires > ?", String(code), Date.now()).toArray()[0];
    if (!c) return null;
    this.sql.exec("DELETE FROM sso_codes WHERE code = ?", c.code);
    return c.token;
  }

  // ── API keys ─────────────────────────────────────────────────────────────────────────────────────────────────
  async createApiKey(account, name, scopes, by) {
    const prefix = "fa_live_" + C.randomHex(4), key = `${prefix}_${C.randomHex(24)}`;
    this.sql.exec("INSERT INTO api_keys (hash, account, prefix, name, scopes, created, created_by) VALUES (?, ?, ?, ?, ?, ?, ?)",
      await C.sha256(key), account, prefix, name, JSON.stringify(scopes), new Date().toISOString(), by || null);
    return { key, prefix, name, scopes };
  }
  apiKeys(account) {
    return this.sql.exec("SELECT prefix, name, scopes, created, created_by, last_used, revoked FROM api_keys WHERE account = ? ORDER BY created DESC", account).toArray()
      .map((k) => ({ ...k, scopes: JSON.parse(k.scopes), revoked: Boolean(k.revoked) }));
  }
  revokeApiKey(account, prefix) { this.sql.exec("UPDATE api_keys SET revoked = 1 WHERE account = ? AND prefix = ?", account, prefix); return { ok: true }; }
  /** The company and scopes for an API key, with a limit of 120 calls a minute per key. */
  async apiKey(key) {
    if (!/^fa_live_[0-9a-f]{8}_[0-9a-f]{48}$/.test(String(key))) return null;
    const k = this.sql.exec("SELECT * FROM api_keys WHERE hash = ?", await C.sha256(key)).toArray()[0];
    if (!k || k.revoked) return null;
    const a = this.#account(k.account);
    if (!a) return null;
    const now = Date.now(), calls = JSON.parse(k.calls).filter((t) => now - t < MIN);
    if (calls.length >= 120) return { account: k.account, limited: true };
    calls.push(now);
    this.sql.exec("UPDATE api_keys SET calls = ?, last_used = ? WHERE hash = ?", JSON.stringify(calls), new Date().toISOString(), k.hash);
    return { account: k.account, prefix: k.prefix, name: k.name, scopes: JSON.parse(k.scopes), off: Boolean(a.off), features: this.#features(a), company: a.company, kind: "api" };
  }

  // ── Notes kept for the owner's list ──────────────────────────────────────────────────────────────────────────
  noteUploads(id, count, last) {
    this.sql.exec("UPDATE accounts SET uploads = ?, last_upload = ?, last_accuracy = ?, last_months = ? WHERE id = ?", count, last?.created ?? null, last?.accuracy ?? null, last?.months ?? null, id);
  }
  noteConnections(id, list) { this.sql.exec("UPDATE accounts SET connections = ? WHERE id = ?", JSON.stringify(list || []).slice(0, 20000), id); }
  company(id) { const a = this.#account(id); return a ? { id: a.id, company: a.company, timezone: a.timezone, features: this.#features(a), off: Boolean(a.off) } : null; }
  companyIds(after = "", limit = 40) { return this.sql.exec("SELECT id FROM accounts WHERE id > ? ORDER BY id LIMIT ?", after, limit).toArray().map((r) => r.id); }
  setOrigin(o) { if (/^https?:\/\/[^/]+$/.test(o || "") && this.#meta("origin") !== o) this.#setMeta("origin", o); }
  #origin() { return this.#meta("origin") || "https://forecast-agent.marlon615.workers.dev"; }

  // ── Billing: Draxly Enterprise agreements and invoices ──────────────────────────────────────────────────────
  #agreement(account) { return this.sql.exec("SELECT * FROM agreements WHERE account = ?", account).toArray()[0] || null; }
  #invoiceOut(i) { return { id: i.id, number: i.number, kind: i.kind, periodStart: i.period_start, periodEnd: i.period_end, description: i.description, amountCents: i.amount_cents, issued: i.issued, due: i.due, status: i.status, paidAt: i.paid_at, paidNote: i.paid_note, sentCount: i.sent_count, lastSent: i.last_sent, reminders: i.reminders, lastReminder: i.last_reminder }; }
  /** Everything the owner dashboard and the customer's billing page show. */
  /** Today's date for billing (in tests only — ALLOW_TEST_CLOCK — the date of the last test-clock run). */
  #billingToday() { return (this.env.ALLOW_TEST_CLOCK === "1" && this.#meta("test_clock")) || new Date().toISOString().slice(0, 10); }
  billing(account, today = this.#billingToday()) {
    const ag = this.#agreement(account);
    const inv = this.sql.exec("SELECT * FROM invoices WHERE account = ? ORDER BY issued DESC, number DESC", account).toArray();
    const st = B.status(ag, inv, today);
    const open = inv.filter((i) => i.status === "open");
    let upcoming = [];
    if (ag && !ag.remainder_billed) {
      const issuedStarts = new Set(inv.map((i) => i.period_start));
      upcoming = B.schedule(ag.billing, ag.term_start).filter((s) => !issuedStarts.has(s.periodStart) && s.periodStart > today);
      if (!ag.cancelled_at && ag.auto_renew) upcoming.push(...B.schedule(ag.billing, ag.term_end).slice(0, 1).map((x) => ({ ...x, renewal: true })));
    }
    const nextOpen = [...open].sort((a, b) => a.due.localeCompare(b.due))[0];
    const nextPayment = nextOpen ? { date: nextOpen.due, amountCents: nextOpen.amount_cents, invoice: nextOpen.number } : upcoming[0] ? { date: B.addDays(upcoming[0].periodStart, B.PLAN.netDays), amountCents: upcoming[0].amountCents, invoiceOn: upcoming[0].periodStart } : null;
    const termInv = ag ? inv.filter((i) => i.period_start >= ag.term_start && i.period_start < ag.term_end) : [];
    return {
      agreement: ag ? { plan: ag.plan, billing: ag.billing, start: ag.start, termStart: ag.term_start, termEnd: ag.term_end, renewal: ag.cancelled_at || !ag.auto_renew ? null : ag.term_end, autoRenew: Boolean(ag.auto_renew) && !ag.cancelled_at, cancelledAt: ag.cancelled_at,
        amountCents: ag.billing === "annual" ? B.PLAN.annualCents : B.PLAN.monthlyCents } : null,
      status: st, statusWords: st === "cancelled" && open.some((i) => i.due < today) ? "Cancelled (overdue)" : B.STATUS_WORDS[st],
      paidCents: inv.filter((i) => i.status === "paid").reduce((a, i) => a + i.amount_cents, 0),
      paidThisTermCents: termInv.filter((i) => i.status === "paid").reduce((a, i) => a + i.amount_cents, 0),
      owedCents: open.reduce((a, i) => a + i.amount_cents, 0),
      overdueCents: open.filter((i) => i.due < today).reduce((a, i) => a + i.amount_cents, 0),
      remainingTermCents: ag && !ag.remainder_billed ? upcoming.filter((u) => !u.renewal).reduce((a, u) => a + u.amountCents, 0) : 0,
      nextPayment, invoices: inv.map((i) => this.#invoiceOut(i)),
    };
  }
  /** Starts (or replaces) a company's Draxly Enterprise agreement; invoices due by today are issued straight away. */
  async startAgreement(account, { start, billing }, today) {
    const a = this.#account(account);
    if (!a) return { error: "unknown" };
    const cur = this.#agreement(account);
    if (cur && !cur.cancelled_at && cur.term_end > today) return { error: "exists" };
    this.sql.exec("INSERT OR REPLACE INTO agreements (account, plan, billing, start, term_start, term_end, auto_renew, cancelled_at, remainder_billed, created) VALUES (?, ?, ?, ?, ?, ?, 1, NULL, 0, ?)",
      account, B.PLAN.name, billing, start, start, B.termEnd(start), new Date().toISOString());
    this.sql.exec("UPDATE accounts SET plan = ?, contract_cents = ?, contract_start = ?, contract_end = ?, forecasts = 1, features = ? WHERE id = ?",
      B.PLAN.name, B.PLAN.annualCents, start, B.termEnd(start), JSON.stringify(Object.fromEntries(FEATURES.map((f) => [f, true]))), account);
    this.#log("agreement started", account, `${B.PLAN.name}, ${billing === "annual" ? "paid yearly upfront" : "$2,500 a month"}, from ${start}`);
    await this.billingRun(today, account);
    return { ok: true, billing: this.billing(account, today) };
  }
  /** Cancels: no renewal, and the rest of the current year is still owed (monthly plans get one invoice for it now). */
  async cancelAgreement(account, today) {
    if (this.env.ALLOW_TEST_CLOCK === "1") this.#setMeta("test_clock", today);
    const ag = this.#agreement(account);
    if (!ag || ag.cancelled_at) return { error: "none" };
    this.sql.exec("UPDATE agreements SET cancelled_at = ?, auto_renew = 0 WHERE account = ?", today, account);
    let remainder = null;
    if (ag.billing === "monthly") {
      const issued = new Set(this.sql.exec("SELECT period_start FROM invoices WHERE account = ? AND kind = 'regular'", account).toArray().map((r) => r.period_start));
      const left = B.schedule("monthly", ag.term_start).filter((x) => !issued.has(x.periodStart));
      if (left.length) {
        remainder = this.#issue(account, { kind: "remainder", periodStart: left[0].periodStart, periodEnd: left[left.length - 1].periodEnd, amountCents: left.reduce((s, x) => s + x.amountCents, 0),
          description: `${B.PLAN.name} — remaining ${left.length} month${left.length === 1 ? "" : "s"} of the agreement (cancelled early)` }, today);
      }
      this.sql.exec("UPDATE agreements SET remainder_billed = 1 WHERE account = ?", account);
    }
    this.#log("agreement cancelled", account, remainder ? `remainder invoiced: $${(remainder.amount_cents / 100).toLocaleString("en-US")}` : "no renewal; nothing more to invoice");
    if (remainder) await this.#emailInvoice(remainder.id, "invoice");
    return { ok: true, billing: this.billing(account, today) };
  }
  #issue(account, x, today) {
    const n = Number(this.#meta("invoice_seq") || 0) + 1;
    const year = today.slice(0, 4), number = `DRX-${year}-${String(n).padStart(4, "0")}`;
    const r = this.sql.exec(`INSERT OR IGNORE INTO invoices (id, number, account, kind, period_start, period_end, description, amount_cents, issued, due) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      C.randomHex(16), number, account, x.kind || "regular", x.periodStart, x.periodEnd, x.description, x.amountCents, today, B.addDays(today, B.PLAN.netDays));
    if (!r.rowsWritten) return null; // already issued for this period
    this.#setMeta("invoice_seq", String(n));
    return this.sql.exec("SELECT * FROM invoices WHERE number = ?", number).toArray()[0];
  }
  /** The daily billing run: renew agreements that reached their end, issue invoices that are due, send reminders. */
  async billingRun(today = new Date().toISOString().slice(0, 10), only = null) {
    if (this.env.ALLOW_TEST_CLOCK === "1") this.#setMeta("test_clock", today);
    const out = { renewed: [], issued: [], reminders: [] };
    const ags = only ? [this.#agreement(only)].filter(Boolean) : this.sql.exec("SELECT * FROM agreements").toArray();
    for (let ag of ags) {
      while (!ag.cancelled_at && ag.auto_renew && ag.term_end <= today) {
        this.sql.exec("UPDATE agreements SET term_start = ?, term_end = ?, remainder_billed = 0 WHERE account = ?", ag.term_end, B.termEnd(ag.term_end), ag.account);
        this.sql.exec("UPDATE accounts SET contract_start = ?, contract_end = ? WHERE id = ?", ag.term_end, B.termEnd(ag.term_end), ag.account);
        this.#log("agreement renewed", ag.account, `${ag.term_end} to ${B.termEnd(ag.term_end)}`);
        out.renewed.push(ag.account);
        ag = this.#agreement(ag.account);
      }
      if (!ag.remainder_billed) for (const s of B.schedule(ag.billing, ag.term_start).filter((x) => x.periodStart <= today && (!ag.cancelled_at || x.periodStart <= ag.cancelled_at))) {
        const inv = this.#issue(ag.account, s, today);
        if (inv) { out.issued.push(inv.number); await this.#emailInvoice(inv.id, "invoice"); }
      }
    }
    const open = this.sql.exec(`SELECT * FROM invoices WHERE status = 'open'${only ? " AND account = ?" : ""}`, ...(only ? [only] : [])).toArray();
    for (const inv of open) {
      const n = B.reminderDue(inv, today);
      if (!n) continue;
      this.sql.exec("UPDATE invoices SET reminders = ?, last_reminder = ? WHERE id = ? AND reminders = ?", n, today, inv.id, n - 1); // claim it first: never twice
      out.reminders.push(inv.number);
      await this.#emailInvoice(inv.id, "reminder", B.daysBetween(inv.due, today));
    }
    this.#setMeta("billing_last_run", today);
    return out;
  }
  async invoicePdfFor(id, account = null) {
    const i = this.sql.exec("SELECT * FROM invoices WHERE id = ?", id).toArray()[0];
    if (!i || (account && i.account !== account)) return null;
    const a = this.#account(i.account);
    return { number: i.number, bytes: invoicePdf({ seller: this.#setting("billingName"), buyer: a.company, invoice: this.#invoiceOut(i), instructions: this.#meta("set_paymentInstructions"), contact: this.contactEmail() }) };
  }
  /** Emails an invoice (or an overdue reminder) with the PDF attached to the company's admins. */
  async #emailInvoice(id, kind, daysLate = 0) {
    const i = this.sql.exec("SELECT * FROM invoices WHERE id = ?", id).toArray()[0];
    if (!i) return { ok: false, reason: "unknown" };
    const a = this.#account(i.account);
    const to = this.recipients(i.account, "billing", ["admin"]).map((r) => r.email);
    if (!to.length) return { ok: false, reason: "No admin to send it to." };
    const pdf = await this.invoicePdfFor(id);
    const args = { company: a.company, invoice: this.#invoiceOut(i), link: `${this.#origin()}/#/billing`, instructions: this.#meta("set_paymentInstructions"), seller: this.#setting("billingName"), contact: this.contactEmail(), daysLate };
    const mail = kind === "reminder" ? reminderEmail(args) : invoiceEmail(args);
    const r = await sendEmail(this.env, this, { to, ...mail, attachments: [{ filename: `${i.number}.pdf`, content: toBase64(pdf.bytes) }] });
    if (r.ok && kind === "invoice") this.sql.exec("UPDATE invoices SET sent_count = sent_count + 1, last_sent = ? WHERE id = ?", new Date().toISOString(), id);
    this.#log(r.ok ? (kind === "reminder" ? "overdue reminder emailed" : "invoice emailed") : `${kind} not emailed`, i.account, `${i.number}${r.ok ? ` to ${r.sent}` : `: ${r.reason}`}`);
    return r;
  }
  sendInvoice(id) { return this.#emailInvoice(id, "invoice"); }
  markInvoice(id, paid, note = "") {
    const i = this.sql.exec("SELECT * FROM invoices WHERE id = ?", id).toArray()[0];
    if (!i) return { error: "unknown" };
    if (paid) this.sql.exec("UPDATE invoices SET status = 'paid', paid_at = ?, paid_note = ? WHERE id = ?", new Date().toISOString().slice(0, 10), String(note).slice(0, 200), id);
    else this.sql.exec("UPDATE invoices SET status = 'open', paid_at = NULL, paid_note = NULL WHERE id = ?", id);
    this.#log(paid ? "invoice marked paid" : "invoice marked unpaid", i.account, `${i.number} $${(i.amount_cents / 100).toLocaleString("en-US")}${note ? ` (${note})` : ""}`);
    return { ok: true, account: i.account, number: i.number };
  }

  // ── Public demo and access requests ──────────────────────────────────────────────────────────────────────────
  /** Someone used the open demo: when, roughly where (Cloudflare's city/country), device, and where they came from. */
  logDemoVisit(visit) {
    const clip = (v, n = 120) => String(v || "").slice(0, n);
    this.sql.exec("INSERT INTO demo_visits (t, city, region, country, device, referrer, source) VALUES (?, ?, ?, ?, ?, ?, ?)", new Date().toISOString(), clip(visit.city, 80), clip(visit.region, 80), clip(visit.country, 8), clip(visit.device, 60), clip(visit.referrer, 200), clip(visit.source, 120));
    return { visit: this.sql.exec("SELECT last_insert_rowid() AS id").one().id };
  }
  noteDemoRun(id, products, months) { this.sql.exec("UPDATE demo_visits SET source = TRIM(source || ' ' || ?) WHERE id = ?", `forecast: ${products} products, ${months} months`, id); }
  /** "Request access": stored  /** "Request access": stored, then the owner is told (phone alert + email). 5 requests an hour per visitor network. */
  async requestAccess(form, net) {
    const now = Date.now(), k = await C.sha256(`lead:${net}`);
    const times = JSON.parse(this.sql.exec("SELECT times FROM lead_limits WHERE k = ?", k).toArray()[0]?.times || "[]").filter((t) => now - t < HOUR);
    if (times.length >= 5) return { error: "busy" };
    times.push(now);
    this.sql.exec("INSERT OR REPLACE INTO lead_limits (k, times) VALUES (?, ?)", k, JSON.stringify(times));
    const id = C.randomHex(12), clip = (v, n = 200) => String(v || "").trim().slice(0, n);
    const visit = Number(form.visit) > 0 ? Number(form.visit) : null;
    this.sql.exec("INSERT INTO leads (id, t, name, email, company, title, phone, locations, message, wants_call, visit, city, country) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
      id, new Date().toISOString(), clip(form.name, 100), clip(form.email, 200).toLowerCase(), clip(form.company, 150), clip(form.title, 100), "", clip(form.locations, 40), clip(form.message, 2000), 0, visit, clip(form.city, 80), clip(form.country, 8));
    if (visit) this.sql.exec("UPDATE demo_visits SET lead = ? WHERE id = ?", id, visit);
    this.#log("access requested", null, `${clip(form.name, 100)} <${clip(form.email, 200)}>, ${clip(form.company, 150)}`);
    const lead = this.sql.exec("SELECT * FROM leads WHERE id = ?", id).one();
    const topic = this.alertTopic();
    const ownerEmail = this.#setting("ownerEmail");
    let emailed = false;
    if (ownerEmail) {
      const r = await sendEmail(this.env, this, { to: [ownerEmail], ...leadEmail({ lead, link: `${this.#origin()}/owner` }) });
      emailed = r.ok;
      if (r.ok) this.sql.exec("UPDATE leads SET emailed = 1 WHERE id = ?", id);
    }
    return { ok: true, id, emailed, alert: topic && this.#alertAllowed() ? { topic, lead } : null };
  }
  markLeadAlerted(id) { this.sql.exec("UPDATE leads SET alerted = 1 WHERE id = ?", id); }
  demoStats() {
    const visits = this.sql.exec("SELECT * FROM demo_visits ORDER BY id DESC LIMIT 300").toArray();
    const leads = this.sql.exec("SELECT * FROM leads ORDER BY t DESC LIMIT 300").toArray();
    const since = (d) => new Date(Date.now() - d * 86_400_000).toISOString();
    return { visits, leads, counts: { visits7: this.sql.exec("SELECT COUNT(*) AS n FROM demo_visits WHERE t >= ?", since(7)).one().n, visits30: this.sql.exec("SELECT COUNT(*) AS n FROM demo_visits WHERE t >= ?", since(30)).one().n,
      visitsAll: this.sql.exec("SELECT COUNT(*) AS n FROM demo_visits").one().n, leadsNew: leads.filter((l) => l.status === "new").length, leadsAll: leads.length } };
  }
  setLead(id, status) { if (!["new", "contacted", "closed"].includes(status)) return { error: "status" }; this.sql.exec("UPDATE leads SET status = ? WHERE id = ?", status, id); return { ok: true }; }

  // ── Owner ────────────────────────────────────────────────────────────────────────────────────────────────────
  customers() {
    const pays = this.sql.exec("SELECT * FROM payments ORDER BY created DESC").toArray();
    const allUsers = this.sql.exec("SELECT * FROM users WHERE account NOT IN (SELECT id FROM accounts WHERE demo = 1) ORDER BY created").toArray();
    const today = this.#billingToday();
    const customers = this.sql.exec("SELECT * FROM accounts WHERE demo = 0 ORDER BY created DESC").toArray().map((r) => {
      const mine = pays.filter((p) => p.account === r.id);
      const users = allUsers.filter((u) => u.account === r.id);
      const admin = users.find((u) => u.role === "admin") || users[0];
      const asked = users.find((u) => u.reset_requested);
      const link = users.map((u) => u.reset_expires).filter((t) => t > Date.now()).sort().pop();
      const active = r.contract_cents > 0 && (!r.contract_end || r.contract_end >= today) && (!r.contract_start || r.contract_start <= today);
      return {
        id: r.id, company: r.company, email: admin?.email || r.email, off: Boolean(r.off), forecasts: Boolean(r.forecasts), created: r.created,
        lastSeen: r.last_seen, resetRequested: asked?.reset_requested || null, resetRequestedBy: asked?.email || null, resetLinkUntil: link || null, hasRecoveryCode: Boolean(admin?.recovery_hash),
        uploads: r.uploads, lastUpload: r.last_upload, lastAccuracy: r.last_accuracy, lastMonths: r.last_months,
        paidCents: mine.reduce((a, p) => a + p.cents, 0), payments: mine.map((p) => ({ id: p.id, cents: p.cents, note: p.note, created: p.created })),
        plan: r.plan, contractCents: r.contract_cents, contractStart: r.contract_start, contractEnd: r.contract_end, contractNote: r.contract_note, contractActive: active,
        features: this.#features(r), require2fa: Boolean(r.require_2fa), requireSso: Boolean(r.require_sso), ssoDomains: r.sso_domains, timezone: r.timezone,
        users: users.map((u) => this.#userOut(u)), connections: JSON.parse(r.connections || "[]"),
        billing: this.billing(r.id, today),
      };
    });
    const acc = customers.filter((c) => c.lastAccuracy !== null && c.lastAccuracy !== undefined);
    const conns = customers.flatMap((c) => c.connections);
    return {
      customers,
      totals: {
        customers: customers.length, paying: customers.filter((c) => c.paidCents > 0).length, off: customers.filter((c) => c.off).length,
        collectedCents: pays.reduce((a, p) => a + p.cents, 0), uploads: customers.reduce((a, c) => a + c.uploads, 0),
        avgAccuracy: acc.length ? Math.round((acc.reduce((a, c) => a + c.lastAccuracy, 0) / acc.length) * 10) / 10 : null,
        arrCents: customers.filter((c) => c.contractActive).reduce((a, c) => a + c.contractCents, 0), contracts: customers.filter((c) => c.contractActive).length,
        users: allUsers.length, connections: conns.length, failing: conns.filter((x) => x.status === "error").length,
        agreementArrCents: customers.filter((c) => ["paid", "overdue"].includes(c.billing.status)).length * B.PLAN.annualCents, agreements: customers.filter((c) => ["paid", "overdue"].includes(c.billing.status)).length,
        overdueCents: customers.reduce((a, c) => a + c.billing.overdueCents, 0), owedCents: customers.reduce((a, c) => a + c.billing.owedCents, 0),
        invoicePaidCents: customers.reduce((a, c) => a + c.billing.paidCents, 0),
      },
      contact: this.contact(), minContractCents: MIN_CONTRACT_CENTS,
    };
  }
  exists(id) { return Boolean(this.#account(id)); }
  setSwitch(id, { account, forecasts }) {
    if (!this.#account(id)) return { error: "unknown" };
    if (typeof account === "boolean") {
      this.sql.exec("UPDATE accounts SET off = ? WHERE id = ?", account ? 0 : 1, id);
      if (!account) this.sql.exec("DELETE FROM sessions WHERE account = ?", id);
      this.#log(account ? "company switched on" : "company switched off", id);
    }
    if (typeof forecasts === "boolean") { this.sql.exec("UPDATE accounts SET forecasts = ? WHERE id = ?", forecasts ? 1 : 0, id); this.#log(`forecasts ${forecasts ? "on" : "off"}`, id); }
    return { ok: true };
  }
  setFeatures(id, patch) {
    const a = this.#account(id);
    if (!a) return { error: "unknown" };
    const f = this.#features(a);
    for (const k of FEATURES) if (typeof patch[k] === "boolean") f[k] = patch[k];
    this.sql.exec("UPDATE accounts SET features = ?, forecasts = ? WHERE id = ?", JSON.stringify(f), f.forecasts ? 1 : 0, id);
    if (!f.sso) this.sql.exec("UPDATE accounts SET require_sso = 0 WHERE id = ?", id); // never lock a company out
    this.#log("features changed", id, Object.entries(patch).map(([k, v]) => `${k}=${v}`).join(", "));
    return { ok: true, features: f };
  }
  setContract(id, { plan, contractCents, start, end, note }) {
    if (!this.#account(id)) return { error: "unknown" };
    if (plan !== undefined) this.sql.exec("UPDATE accounts SET plan = ? WHERE id = ?", String(plan).slice(0, 60), id);
    if (contractCents !== undefined) this.sql.exec("UPDATE accounts SET contract_cents = ? WHERE id = ?", contractCents, id);
    if (start !== undefined) this.sql.exec("UPDATE accounts SET contract_start = ? WHERE id = ?", start || null, id);
    if (end !== undefined) this.sql.exec("UPDATE accounts SET contract_end = ? WHERE id = ?", end || null, id);
    if (note !== undefined) this.sql.exec("UPDATE accounts SET contract_note = ? WHERE id = ?", String(note).slice(0, 300), id);
    this.#log("contract changed", id, `${plan ?? ""} ${contractCents !== undefined ? `$${(contractCents / 100).toLocaleString("en-US")}/yr` : ""} ${start ?? ""}–${end ?? ""}`);
    return { ok: true };
  }
  addPayment(id, cents, note) {
    if (!this.#account(id)) return { error: "unknown" };
    const pid = C.randomHex(16);
    this.sql.exec("INSERT INTO payments (id, account, cents, note, created) VALUES (?, ?, ?, ?, ?)", pid, id, cents, note, new Date().toISOString());
    this.sql.exec("UPDATE accounts SET forecasts = 1 WHERE id = ?", id);
    this.#log("payment recorded", id, `$${(cents / 100).toFixed(2)} ${note}`);
    return { ok: true, id: pid };
  }
  deletePayment(id, pid) { this.sql.exec("DELETE FROM payments WHERE id = ? AND account = ?", pid, id); this.#log("payment removed", id); return { ok: true }; }
  deleteCustomer(id) {
    const a = this.#account(id);
    if (!a) return { error: "unknown" };
    for (const t of ["sessions", "payments", "users", "api_keys"]) this.sql.exec(`DELETE FROM ${t} WHERE account = ?`, id);
    this.sql.exec("DELETE FROM accounts WHERE id = ?", id);
    this.#log("company deleted", id, a.company);
    return { ok: true };
  }
}
