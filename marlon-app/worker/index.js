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
 */
import { DurableObject } from "cloudflare:workers";
import { FILES, RULES } from "./assets.generated.js";

const KINDS = ["open", "setup", "invoice", "voice", "print", "pdf", "picture"];
const DAY = /^\d{4}-\d{2}-\d{2}$/;
const todayUTC = () => new Date().toISOString().slice(0, 10);
const addDays = (iso, n) => { const d = new Date(`${iso}T12:00:00Z`); d.setUTCDate(d.getUTCDate() + n); return d.toISOString().slice(0, 10); };
const hex = (buf) => Array.from(new Uint8Array(buf), (b) => b.toString(16).padStart(2, "0")).join("");
const randomHex = (n) => hex(crypto.getRandomValues(new Uint8Array(n)));

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
  }

  #meta(k) { return this.sql.exec("SELECT v FROM meta WHERE k = ?", k).toArray()[0]?.v ?? null; }
  #setMeta(k, v) { this.sql.exec("INSERT INTO meta (k, v) VALUES (?, ?) ON CONFLICT(k) DO UPDATE SET v = excluded.v", k, String(v)); }

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

  createBuyer(name, devices, amountCents) {
    const id = randomHex(16);
    this.sql.exec("INSERT INTO buyers (id, name, devices, amount_cents, created) VALUES (?, ?, ?, ?, ?)", id, name, devices, amountCents, new Date().toISOString());
    return this.#buyer(id);
  }

  #buyer(id) {
    const b = this.sql.exec("SELECT * FROM buyers WHERE id = ?", id).toArray()[0];
    if (!b) return null;
    const devices = this.sql.exec("SELECT device, label, first_at, last_at, off FROM buyer_devices WHERE buyer = ? ORDER BY first_at", id).toArray()
      .map((d) => ({ device: d.device, label: d.label, firstAt: d.first_at, lastAt: d.last_at, off: Boolean(d.off) }));
    return { id: b.id, name: b.name, devices: b.devices, amountCents: b.amount_cents, created: b.created, off: Boolean(b.off), phones: devices,
      active: devices.filter((d) => !d.off).length };
  }

  buyers() {
    const list = this.sql.exec("SELECT id FROM buyers ORDER BY created DESC").toArray().map((r) => this.#buyer(r.id));
    const totalCents = this.sql.exec("SELECT COALESCE(SUM(amount_cents), 0) AS t FROM buyers").toArray()[0].t;
    return { buyers: list, totalCents, contact: this.contact() };
  }

  setBuyerOff(id, off) {
    this.sql.exec("UPDATE buyers SET off = ? WHERE id = ?", off ? 1 : 0, id);
    return this.#buyer(id);
  }

  /** Switching a phone back on needs a free place (the buyer may have used it for another phone meanwhile). */
  setDeviceOff(id, device, off) {
    const b = this.#buyer(id);
    const d = b?.phones.find((x) => x.device === device);
    if (!d) return { error: "unknown" };
    if (!off && d.off && b.active >= b.devices) return { error: "full" };
    this.sql.exec("UPDATE buyer_devices SET off = ? WHERE buyer = ? AND device = ?", off ? 1 : 0, id, device);
    return { buyer: this.#buyer(id) };
  }

  /**
   * A phone opening a personal link. All in one step (no waiting in between), so two phones can't both take the
   * last place. A phone already on the list keeps its place; a new one gets a free place or is turned away.
   */
  activate(id, device, label, { onlyKnown = false } = {}) {
    const b = this.#buyer(id);
    if (!b) return { ok: false, reason: "unknown" };
    if (b.off) return { ok: false, reason: "off" };
    const now = new Date().toISOString();
    const d = b.phones.find((x) => x.device === device);
    if (d) {
      if (d.off) return { ok: false, reason: "off" };
      this.sql.exec("UPDATE buyer_devices SET last_at = ? WHERE buyer = ? AND device = ?", now, id, device);
      return { ok: true };
    }
    if (onlyKnown) return { ok: false, reason: "off" };
    if (b.active >= b.devices) return { ok: false, reason: "full" };
    this.sql.exec("INSERT INTO buyer_devices (buyer, device, label, first_at, last_at) VALUES (?, ?, ?, ?, ?)", id, device, label, now, now);
    return { ok: true };
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
    return r.ok ? json({ ok: true }) : json({ ok: false, reason: r.reason, contact: await stub.contact() }, 403);
  }
  if (path === "/api/contact" && request.method === "GET") return json({ contact: await stub.contact() });

  const token = (request.headers.get("Authorization") || "").replace(/^Bearer\s+/i, "");
  if (path.startsWith("/api/console/") && !["/api/console/state", "/api/console/claim", "/api/console/login", "/api/console/logout"].includes(path)
    && !(await stub.check(token))) return json({ error: "Please enter your passcode again." }, 401);
  if (path === "/api/console/buyers" && request.method === "GET") return json(await stub.buyers());
  if (path === "/api/console/buyers" && request.method === "POST") {
    let body;
    try { body = await readJson(request, 2000); } catch { return json({ error: "bad request" }, 400); }
    const name = typeof body.name === "string" ? body.name.replace(/\s+/g, " ").trim().slice(0, 80) : "";
    const devices = Number(body.devices);
    const amount = typeof body.amount === "number" ? body.amount : Number(String(body.amount ?? "").replace(/[$,\s]/g, ""));
    if (!name) return json({ error: "Type the buyer's name." }, 400);
    if (!Number.isInteger(devices) || devices < 1 || devices > 1000) return json({ error: "Choose how many devices (1 or more)." }, 400);
    if (String(body.amount ?? "").trim() === "" || !Number.isFinite(amount) || amount < 0 || amount > 1e9) return json({ error: "Type how much the buyer paid (0 or more)." }, 400);
    const buyer = await stub.createBuyer(name, devices, Math.round(amount * 100));
    return json({ buyer, link: `${new URL(request.url).origin}/?k=${buyer.id}` });
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
    return r.buyer ? json({ buyer: r.buyer }) : json({ error: "not found" }, 404);
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
      return new Response(JSON.stringify(m), { headers: { "Content-Type": FILES[path].type, "Cache-Control": "no-cache", "X-Content-Type-Options": "nosniff" } });
    }
    const key = path.endsWith("/") ? path + "index.html" : FILES[path] ? path : FILES[path + ".html"] ? path + ".html" : null;
    if (key && FILES[key]) return respond(request, path, FILES[key]);
    return respond(request, path, FILES["/404.html"], 404);
  },
};
