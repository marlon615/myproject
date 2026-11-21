/**
 * Marlon website Worker: serves the pages, pictures and demo video packed in from public/, and answers /api/*.
 *
 *   POST /api/contact            the contact form → saved in the private inbox
 *   GET  /api/inbox/state        { claimed }  (has the inbox passcode been set?)
 *   POST /api/inbox/claim        { passcode }  first visit only: sets the passcode → { token }
 *   POST /api/inbox/login        { passcode }  → { token }   (5 wrong tries per 15 minutes, then it waits)
 *   GET  /api/inbox/messages     (Bearer token) → { messages }
 *   POST /api/inbox/mark         (Bearer) { id, done }   mark a message handled / not handled
 *   POST /api/inbox/delete       (Bearer) { id }
 *   POST /api/inbox/logout       (Bearer)
 *
 * One Durable Object (SQLite), "Inbox", keeps the messages, the passcode hash and sign-in sessions.
 * Privacy: no cookies; the visitor's IP address is never stored, only a salted SHA-256 hash of it (for rate limits).
 */
import { FILES, HEADER_RULES } from "./assets.generated.js";

const MAX = { name: 100, company: 120, email: 160, role: 100, reps: 20, topic: 60, message: 4000 };
const TOPICS = ["Buy Marlon for my business", "Marlon Pro", "A question before buying", "Help with Marlon I already have", "Something else"];
const REPS = ["Just me (solo business)", "2–4 reps", "5–9 reps", "10–24 reps", "25–49 reps", "50–99 reps", "100+ reps", "Not sure yet"];
const PBKDF2_ROUNDS = 5000; // Cloudflare's free plan allows ~10 ms of CPU per request; passcodes must be 10+ characters.
const SESSION_MS = 12 * 60 * 60 * 1000;

const json = (data, status = 200) => new Response(JSON.stringify(data), {
  status, headers: { "content-type": "application/json; charset=utf-8", "cache-control": "no-store", "x-content-type-options": "nosniff", "x-robots-tag": "noindex" },
});
const hex = (buf) => [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, "0")).join("");
const sha256 = async (s) => hex(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(s)));
const randomHex = (n) => hex(crypto.getRandomValues(new Uint8Array(n)));
async function pbkdf2(passcode, salt) {
  const key = await crypto.subtle.importKey("raw", new TextEncoder().encode(passcode), "PBKDF2", false, ["deriveBits"]);
  return hex(await crypto.subtle.deriveBits({ name: "PBKDF2", hash: "SHA-256", salt: new TextEncoder().encode(salt), iterations: PBKDF2_ROUNDS }, key, 256));
}
function sameHex(a, b) { // constant-time compare
  if (typeof a !== "string" || typeof b !== "string" || a.length !== b.length) return false;
  let d = 0; for (let i = 0; i < a.length; i++) d |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return d === 0;
}
async function readJson(request, limit) {
  const text = await request.text();
  if (text.length > limit) throw new Error("too big");
  const v = JSON.parse(text);
  if (!v || typeof v !== "object" || Array.isArray(v)) throw new Error("bad");
  return v;
}
const clean = (v, n) => (typeof v === "string" ? v.replace(/\r\n?/g, "\n").replace(/[\u0000-\u0008\u000b-\u001f\u007f]/g, "").trim().slice(0, n) : "");
const oneLine = (v, n) => clean(v, n).replace(/\s+/g, " ");

export class Inbox {
  constructor(state, env) {
    this.env = env;
    this.sql = state.storage.sql;
    this.sql.exec(`CREATE TABLE IF NOT EXISTS messages (id TEXT PRIMARY KEY, created TEXT NOT NULL, name TEXT NOT NULL, company TEXT NOT NULL,
      email TEXT NOT NULL, role TEXT NOT NULL, reps TEXT NOT NULL, topic TEXT NOT NULL, message TEXT NOT NULL, page TEXT NOT NULL, done INTEGER NOT NULL DEFAULT 0)`);
    this.sql.exec(`CREATE TABLE IF NOT EXISTS meta (k TEXT PRIMARY KEY, v TEXT NOT NULL)`);
    this.sql.exec(`CREATE TABLE IF NOT EXISTS sessions (hash TEXT PRIMARY KEY, expires INTEGER NOT NULL)`);
    this.sql.exec(`CREATE TABLE IF NOT EXISTS hits (who TEXT NOT NULL, kind TEXT NOT NULL, at INTEGER NOT NULL)`);
  }
  #meta(k) { return this.sql.exec("SELECT v FROM meta WHERE k = ?", k).toArray()[0]?.v ?? null; }
  #setMeta(k, v) { this.sql.exec("INSERT INTO meta (k, v) VALUES (?, ?) ON CONFLICT(k) DO UPDATE SET v = excluded.v", k, v); }
  #salt() { let s = this.#meta("salt"); if (!s) { s = randomHex(16); this.#setMeta("salt", s); } return s; }
  /** How many times `who` did `kind` in the last `ms` (and record this one when `record`). */
  #count(who, kind, ms, record = false) {
    const now = Date.now();
    this.sql.exec("DELETE FROM hits WHERE at < ?", now - 24 * 60 * 60 * 1000);
    if (record) this.sql.exec("INSERT INTO hits (who, kind, at) VALUES (?, ?, ?)", who, kind, now);
    return this.sql.exec("SELECT COUNT(*) AS n FROM hits WHERE who = ? AND kind = ? AND at >= ?", who, kind, now - ms).toArray()[0].n;
  }
  #generation() { return String(this.env.INBOX_GENERATION || "1"); }
  #claimed() { return this.#meta("gen") === this.#generation() && Boolean(this.#meta("pass")); }

  async fetch(request) {
    const url = new URL(request.url), path = url.pathname, method = request.method;
    const ip = request.headers.get("cf-connecting-ip") || "local";
    const who = await sha256(`${this.#salt()}|${ip}`);

    if (path === "/api/contact" && method === "POST") {
      let b; try { b = await readJson(request, 12000); } catch { return json({ error: "That didn't send. Please try again." }, 400); }
      if (clean(b.website, 200)) return json({ ok: true }); // the hidden trap field: a bot filled it in. Pretend it worked.
      const m = {
        name: oneLine(b.name, MAX.name), company: oneLine(b.company, MAX.company), email: oneLine(b.email, MAX.email),
        role: oneLine(b.role, MAX.role), reps: oneLine(b.reps, MAX.reps), topic: oneLine(b.topic, MAX.topic), message: clean(b.message, MAX.message),
        page: oneLine(b.page, 80),
      };
      if (!m.name) return json({ error: "Please add your name.", field: "name" }, 400);
      if (!m.company) return json({ error: "Please add your company or business name.", field: "company" }, 400);
      if (!/^[^\s@<>()",;:]+@[^\s@<>()",;:]+\.[A-Za-z]{2,}$/.test(m.email)) return json({ error: "Please check your email address.", field: "email" }, 400);
      if (m.message.length < 2) return json({ error: "Please add a short message.", field: "message" }, 400);
      if (!TOPICS.includes(m.topic)) m.topic = "Something else";
      if (!REPS.includes(m.reps)) m.reps = "Not sure yet";
      if (this.#count(who, "contact", 60 * 60 * 1000) >= 5) return json({ error: "You've sent several messages in the last hour. Please try again later, or email marlonapp.sales@gmail.com." }, 429);
      if (this.#count("all", "contact", 24 * 60 * 60 * 1000) >= 300) return json({ error: "Our inbox is busy right now. Please email marlonapp.sales@gmail.com." }, 429);
      this.#count(who, "contact", 0, true); this.#count("all", "contact", 0, true);
      const id = randomHex(12);
      this.sql.exec("INSERT INTO messages (id, created, name, company, email, role, reps, topic, message, page) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
        id, new Date().toISOString(), m.name, m.company, m.email, m.role, m.reps, m.topic, m.message, m.page);
      return json({ ok: true });
    }

    if (path === "/api/inbox/state" && method === "GET") return json({ claimed: this.#claimed() });

    if ((path === "/api/inbox/claim" || path === "/api/inbox/login") && method === "POST") {
      let b; try { b = await readJson(request, 1000); } catch { return json({ error: "bad request" }, 400); }
      const pass = typeof b.passcode === "string" ? b.passcode : "";
      if (path === "/api/inbox/claim") {
        if (this.#claimed()) return json({ error: "The passcode is already set. Sign in with it." }, 409);
        if (pass.length < 10 || pass.length > 200) return json({ error: "Choose a passcode of at least 10 characters." }, 400);
        const salt = randomHex(16);
        this.#setMeta("pass", `${salt}:${await pbkdf2(pass, salt)}`); this.#setMeta("gen", this.#generation());
        this.sql.exec("DELETE FROM sessions");
      } else {
        if (!this.#claimed()) return json({ error: "Set the passcode first." }, 409);
        if (this.#count(who, "fail", 15 * 60 * 1000) >= 5) return json({ error: "Too many wrong tries. Wait 15 minutes, then try again." }, 429);
        const [salt, want] = this.#meta("pass").split(":");
        if (!sameHex(await pbkdf2(pass, salt), want)) { this.#count(who, "fail", 0, true); return json({ error: "That passcode isn't right." }, 401); }
      }
      const token = randomHex(32);
      this.sql.exec("DELETE FROM sessions WHERE expires < ?", Date.now());
      this.sql.exec("INSERT INTO sessions (hash, expires) VALUES (?, ?)", await sha256(token), Date.now() + SESSION_MS);
      return json({ token });
    }

    if (path.startsWith("/api/inbox/")) {
      const token = (request.headers.get("authorization") || "").replace(/^Bearer\s+/i, "");
      const ok = /^[0-9a-f]{64}$/.test(token) && this.#claimed()
        && this.sql.exec("SELECT 1 FROM sessions WHERE hash = ? AND expires > ?", await sha256(token), Date.now()).toArray().length > 0;
      if (!ok) return json({ error: "Please sign in." }, 401);
      if (path === "/api/inbox/messages" && method === "GET") {
        return json({ messages: this.sql.exec("SELECT id, created, name, company, email, role, reps, topic, message, page, done FROM messages ORDER BY created DESC LIMIT 500").toArray()
          .map((r) => ({ ...r, done: Boolean(r.done) })) });
      }
      if ((path === "/api/inbox/mark" || path === "/api/inbox/delete") && method === "POST") {
        let b; try { b = await readJson(request, 500); } catch { return json({ error: "bad request" }, 400); }
        const id = typeof b.id === "string" && /^[0-9a-f]{24}$/.test(b.id) ? b.id : null;
        if (!id) return json({ error: "bad request" }, 400);
        if (path === "/api/inbox/mark") this.sql.exec("UPDATE messages SET done = ? WHERE id = ?", b.done ? 1 : 0, id);
        else this.sql.exec("DELETE FROM messages WHERE id = ?", id);
        return json({ ok: true });
      }
      if (path === "/api/inbox/logout" && method === "POST") { this.sql.exec("DELETE FROM sessions WHERE hash = ?", await sha256(token)); return json({ ok: true }); }
    }
    return json({ error: "not found" }, 404);
  }
}

// ── The website's files (packed in by scripts/build-worker.cjs) ─────────────────────────────────────────────────
const matches = (pattern, p) => pattern === p || (pattern.endsWith("/*") && (p.startsWith(pattern.slice(0, -1)) || pattern === "/*"));
function headersFor(p, file) {
  const h = new Headers({ "content-type": file.type, etag: file.etag, "accept-ranges": "bytes" });
  h.set("cache-control", p.endsWith(".html") || file.type.startsWith("text/html") ? "public, max-age=0, must-revalidate" : "public, max-age=3600");
  for (const r of HEADER_RULES) if (matches(r.pattern, p)) for (const [k, v] of Object.entries(r.headers)) h.set(k, v);
  return h;
}
function serveFile(request, file, key, status = 200, page = key) {
  const h = headersFor(page, file);
  if (status === 200 && (request.headers.get("if-none-match") || "").split(",").some((t) => t.trim().replace(/^W\//, "") === file.etag)) return new Response(null, { status: 304, headers: h });
  const body = file.text !== undefined ? new TextEncoder().encode(file.text) : new Uint8Array(file.data);
  const range = status === 200 && /^bytes=(\d*)-(\d*)$/.exec(request.headers.get("range") || "");
  if (range && (range[1] || range[2])) { // byte ranges: Safari needs them to play the video
    const size = body.length;
    let start = range[1] ? Number(range[1]) : Math.max(0, size - Number(range[2]));
    let end = range[1] && range[2] ? Math.min(Number(range[2]), size - 1) : size - 1;
    if (start >= size || start > end) { h.set("content-range", `bytes */${size}`); return new Response(null, { status: 416, headers: h }); }
    h.set("content-range", `bytes ${start}-${end}/${size}`);
    h.set("content-length", String(end - start + 1));
    return new Response(request.method === "HEAD" ? null : body.slice(start, end + 1), { status: 206, headers: h });
  }
  h.set("content-length", String(body.length));
  return new Response(request.method === "HEAD" ? null : body, { status, headers: h });
}
function site(request) {
  const url = new URL(request.url);
  if (request.method !== "GET" && request.method !== "HEAD") return new Response("Method not allowed", { status: 405, headers: { allow: "GET, HEAD" } });
  let p;
  try { p = decodeURIComponent(url.pathname); } catch { p = "/"; }
  if (p.length > 1 && p.endsWith("/")) return Response.redirect(url.origin + p.replace(/\/+$/, "") + url.search, 301);
  if (p.endsWith(".html") && p !== "/404.html") return Response.redirect(url.origin + (p === "/index.html" ? "/" : p.slice(0, -5)) + url.search, 301);
  const key = p === "/" ? "/index.html" : FILES[p] ? p : FILES[`${p}.html`] ? `${p}.html` : null;
  if (key) return serveFile(request, FILES[key], key, 200, p);
  return serveFile(request, FILES["/404.html"], "/404.html", 404);
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    if (url.pathname.startsWith("/api/")) {
      if (request.method === "POST") {
        const origin = request.headers.get("origin");
        if (origin && origin !== url.origin) return json({ error: "Not allowed." }, 403); // only this website's own pages
        if (!/^application\/json\b/i.test(request.headers.get("content-type") || "")) return json({ error: "bad request" }, 415);
      }
      return env.INBOX.get(env.INBOX.idFromName("inbox")).fetch(request);
    }
    return site(request);
  },
};
