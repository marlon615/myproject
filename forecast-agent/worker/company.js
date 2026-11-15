/**
 * One company's private store (one Durable Object per company). Everything about that company's sales lives here
 * and only here: series (product × location × region, by month), forecasts, stock levels, connections, the activity
 * log and email schedules. Sales numbers, product/location names and credentials are encrypted (AES-256-GCM).
 *
 * Heavy work runs as background jobs in small steps (one step per alarm), so a business with tens of thousands of
 * product × store combinations never needs one long request:
 *   compute  — backtest or forecast every series in batches of 40, then add the batches up into views
 *   sync     — pull one page from a connected system per step, then merge it in
 *   file     — read a dropped CSV file in 512 KB pieces, then merge it in
 *   merge    — combine pages, apply them to the stored series, add new series
 *   reorder  — reorder suggestions for every stock item, then low-stock emails
 *   report   — the weekly forecast email
 */
import { DurableObject } from "cloudflare:workers";
import * as C from "./crypto.js";
import { newAccumulator, addSeries, finish, mergePartial, partialOf } from "./aggregate.js";
import { monthLabel, addMonths } from "./forecast.js";
import { suggest, sortSuggestions, DEFAULT_SETTINGS } from "./reorder.js";
import { CONNECTORS, ConnectorError } from "./connectors.js";
import { sendEmail, weeklyReport, lowStockEmail } from "./email.js";
import { parseCSV, detectColumns, detectExtra, dateOrderOf, toYearMonth, parseNumber } from "../public/parse.js";

// Batch sizes per background step. Cloudflare's free plan allows ~10 ms of CPU per step, so these are small; on the
// Workers Paid plan (30 s per step) set CPU_PLAN = "paid" in wrangler.toml and every batch is 10× bigger (fewer steps).
const SIZES = { free: { CHUNK: 12, MERGE_FAN: 12, APPLY_CHUNK: 40, INV_CHUNK: 60, INLINE_MAX: 24 }, paid: { CHUNK: 120, MERGE_FAN: 60, APPLY_CHUNK: 400, INV_CHUNK: 600, INLINE_MAX: 240 } };
const INDEX_PART = 2000;
export const MAX_SERIES = 50_000, MAX_MONTHS = 120, MAX_UPLOADS = 50;
const HOUR = 3_600_000, DAY = 86_400_000;
const SEP = "\u0001";

function monthsBetween(first, last) {
  const out = [];
  if (!first || !last) return out;
  for (let m = first; m <= last && out.length <= 600; m = addMonths(m, 1)) out.push(m);
  return out;
}
const fmtCache = new Map();
function localParts(ts, tz) {
  if (!fmtCache.has(tz)) fmtCache.set(tz, new Intl.DateTimeFormat("en-US", { timeZone: tz, weekday: "short", hour: "numeric", minute: "numeric", hourCycle: "h23" }));
  const p = Object.fromEntries(fmtCache.get(tz).formatToParts(new Date(ts)).map((x) => [x.type, x.value]));
  return { weekday: ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"].indexOf(p.weekday), hour: Number(p.hour), minute: Number(p.minute) };
}
/** The next moment it is `hour` o'clock (on `weekday`, if given) in time zone `tz`, plus `minute` minutes. */
export function nextLocal(tz, hour, minute = 0, weekday = null, now = Date.now()) {
  const start = Math.floor(now / (30 * 60_000)) * 30 * 60_000;
  for (let i = 1; i <= 8 * 48; i++) {
    const t = start + i * 30 * 60_000, p = localParts(t, tz);
    if (p.hour === hour && p.minute < 30 && (weekday === null || p.weekday === weekday)) return t - p.minute * 60_000 + minute * 60_000;
  }
  return now + DAY;
}

export class Company extends DurableObject {
  constructor(ctx, env) {
    super(ctx, env);
    this.sql = ctx.storage.sql;
    this.#schema();
    ctx.blockConcurrencyWhile(() => this.#migrateLegacy());
  }

  /** Creates the tables (also again after wipe(), so a wiped store can be used straight away). */
  #schema() {
    const x = (q) => this.sql.exec(q);
    x(`CREATE TABLE IF NOT EXISTS uploads (id TEXT PRIMARY KEY, name TEXT NOT NULL, created TEXT NOT NULL, kind TEXT NOT NULL,
      months INTEGER NOT NULL, products INTEGER NOT NULL, first TEXT NOT NULL, last TEXT NOT NULL, data TEXT NOT NULL,
      backtest TEXT, accuracy REAL, forecast TEXT, forecast_at TEXT)`);
    const cols = new Set(this.sql.exec("PRAGMA table_info(uploads)").toArray().map((c) => c.name));
    for (const [n, d] of [["source", "TEXT NOT NULL DEFAULT 'file'"], ["status", "TEXT NOT NULL DEFAULT 'ready'"], ["error", "TEXT"], ["measures", "TEXT NOT NULL DEFAULT '[\"amount\"]'"],
      ["locations", "INTEGER NOT NULL DEFAULT 0"], ["regions", "INTEGER NOT NULL DEFAULT 0"], ["series", "INTEGER NOT NULL DEFAULT 0"], ["updated", "TEXT"], ["conn", "TEXT"], ["migrated", "INTEGER NOT NULL DEFAULT 0"]])
      if (!cols.has(n)) this.sql.exec(`ALTER TABLE uploads ADD COLUMN ${n} ${d}`);
    x(`CREATE TABLE IF NOT EXISTS series (upload TEXT NOT NULL, key TEXT NOT NULL, measure TEXT NOT NULL, blob TEXT NOT NULL, PRIMARY KEY (upload, measure, key))`);
    x(`CREATE TABLE IF NOT EXISTS idx (upload TEXT NOT NULL, part INTEGER NOT NULL, blob TEXT NOT NULL, PRIMARY KEY (upload, part))`);
    x(`CREATE TABLE IF NOT EXISTS results (upload TEXT NOT NULL, measure TEXT NOT NULL, mode TEXT NOT NULL, key TEXT NOT NULL, blob TEXT NOT NULL, PRIMARY KEY (upload, measure, mode, key))`);
    x(`CREATE TABLE IF NOT EXISTS views (upload TEXT NOT NULL, measure TEXT NOT NULL, mode TEXT NOT NULL, blob TEXT NOT NULL, updated TEXT NOT NULL, PRIMARY KEY (upload, measure, mode))`);
    x(`CREATE TABLE IF NOT EXISTS jobs (id INTEGER PRIMARY KEY AUTOINCREMENT, upload TEXT, kind TEXT NOT NULL, measure TEXT, mode TEXT, phase TEXT NOT NULL,
      cursor TEXT NOT NULL DEFAULT '', total INTEGER NOT NULL DEFAULT 0, done INTEGER NOT NULL DEFAULT 0, status TEXT NOT NULL DEFAULT 'pending',
      error TEXT, payload TEXT NOT NULL DEFAULT '{}', created TEXT NOT NULL, updated TEXT NOT NULL)`);
    x(`CREATE TABLE IF NOT EXISTS partials (id INTEGER PRIMARY KEY AUTOINCREMENT, job INTEGER NOT NULL, blob TEXT NOT NULL)`);
    x(`CREATE TABLE IF NOT EXISTS stage (id INTEGER PRIMARY KEY AUTOINCREMENT, job INTEGER NOT NULL, type TEXT NOT NULL, blob TEXT NOT NULL)`);
    x(`CREATE TABLE IF NOT EXISTS inventory (k TEXT PRIMARY KEY, blob TEXT NOT NULL, updated TEXT NOT NULL, source TEXT NOT NULL DEFAULT 'file')`);
    x(`CREATE TABLE IF NOT EXISTS audit (id INTEGER PRIMARY KEY AUTOINCREMENT, t TEXT NOT NULL, user TEXT NOT NULL, action TEXT NOT NULL, detail TEXT NOT NULL DEFAULT '', ip TEXT NOT NULL DEFAULT '')`);
    x(`CREATE TABLE IF NOT EXISTS connections (id TEXT PRIMARY KEY, kind TEXT NOT NULL, name TEXT NOT NULL, creds TEXT NOT NULL, status TEXT NOT NULL DEFAULT 'new',
      last_sync TEXT, last_ok TEXT, last_error TEXT, rows_last INTEGER, created TEXT NOT NULL, upload TEXT, history_months INTEGER NOT NULL DEFAULT 24, synced_once INTEGER NOT NULL DEFAULT 0)`);
    x(`CREATE TABLE IF NOT EXISTS schedule (task TEXT PRIMARY KEY, next_run INTEGER NOT NULL)`);
    x(`CREATE TABLE IF NOT EXISTS meta (k TEXT PRIMARY KEY, v TEXT NOT NULL)`);
  }

  // ── Small helpers ────────────────────────────────────────────────────────────────────────────────────────────
  get #secret() { return this.env.ENCRYPTION_KEY; }
  get #z() { return SIZES[this.env.CPU_PLAN === "paid" ? "paid" : "free"]; }
  async #enc(obj) { return C.encrypt(this.#secret, JSON.stringify(obj)); }
  async #dec(blob) { return JSON.parse(await C.decrypt(this.#secret, blob)); }
  async #key(p, l, r) { return C.hex(await C.hmac("SHA-256", this.#secret, `${p}${SEP}${l}${SEP}${r}`)).slice(0, 32); }
  #meta(k) { return this.sql.exec("SELECT v FROM meta WHERE k = ?", k).toArray()[0]?.v ?? null; }
  #setMeta(k, v) { if (v === null || v === undefined) this.sql.exec("DELETE FROM meta WHERE k = ?", k); else this.sql.exec("INSERT INTO meta (k, v) VALUES (?, ?) ON CONFLICT(k) DO UPDATE SET v = excluded.v", k, String(v)); }
  #bind(account) { if (account && this.#meta("account") !== account) this.#setMeta("account", account); }
  get #account() { return this.#meta("account"); }
  #dir() { return this.env.DIRECTORY.get(this.env.DIRECTORY.idFromName("main")); }
  async #company() { return this.#account ? this.#dir().company(this.#account) : null; }
  #origin() { return this.#meta("origin") || "https://forecast-agent.marlon615.workers.dev"; }
  setOrigin(o) { if (/^https?:\/\/[^/]+$/.test(o || "") && this.#meta("origin") !== o) this.#setMeta("origin", o); }
  #now() { return new Date().toISOString(); }

  log(entry) {
    this.sql.exec("INSERT INTO audit (t, user, action, detail, ip) VALUES (?, ?, ?, ?, ?)", this.#now(), String(entry.user || "system").slice(0, 200), String(entry.action).slice(0, 120), String(entry.detail || "").slice(0, 1000), String(entry.ip || "").slice(0, 64));
    return { ok: true };
  }
  audit({ limit = 100, before = null } = {}) {
    return before ? this.sql.exec("SELECT * FROM audit WHERE id < ? ORDER BY id DESC LIMIT ?", before, Math.min(500, limit)).toArray()
      : this.sql.exec("SELECT * FROM audit ORDER BY id DESC LIMIT ?", Math.min(500, limit)).toArray();
  }

  // Uploads from before (one JSON blob each) become series, and their results become views.
  async #migrateLegacy() {
    for (const u of this.sql.exec("SELECT * FROM uploads WHERE migrated = 0").toArray()) {
      const d = u.data && u.data !== "{}" ? JSON.parse(await C.decrypt(this.#secret, u.data)) : null;
      const measure = u.kind === "units" ? "units" : "amount";
      if (d?.months && d.products) {
        const series = Object.entries(d.products).map(([p, vals]) => ({ product: p, location: "", region: "", [measure]: vals }));
        await this.#writeSeries(u.id, d.months, series);
      }
      for (const [col, mode] of [["backtest", "backtest"], ["forecast", "forecast"]]) if (u[col]) {
        const v = JSON.parse(await C.decrypt(this.#secret, u[col]));
        this.sql.exec("INSERT OR REPLACE INTO views (upload, measure, mode, blob, updated) VALUES (?, ?, ?, ?, ?)", u.id, measure, mode, await this.#enc({ ...v, locations: v.locations || [], regions: v.regions || [] }), u.forecast_at || u.created);
      }
      this.sql.exec("UPDATE uploads SET data = '{}', backtest = NULL, forecast = NULL, migrated = 1, measures = ?, updated = COALESCE(updated, created) WHERE id = ?", JSON.stringify([measure]), u.id);
    }
  }

  // ── Series storage ───────────────────────────────────────────────────────────────────────────────────────────
  /** Adds series values (by month) to an upload. Same names → same series (values add up). Keeps the name index. */
  async #writeSeries(uploadId, months, list) {
    const newIdx = [];
    const seen = new Map();
    for (const s of list) {
      const p = String(s.product ?? "").trim() || "(no name)", l = String(s.location ?? "").trim(), r = String(s.region ?? "").trim();
      const key = seen.get(`${p}${SEP}${l}${SEP}${r}`) || await this.#key(p, l, r);
      seen.set(`${p}${SEP}${l}${SEP}${r}`, key);
      let isNew = !this.sql.exec("SELECT 1 FROM series WHERE upload = ? AND key = ? LIMIT 1", uploadId, key).toArray().length;
      for (const measure of ["amount", "units"]) {
        const vals = s[measure];
        if (!Array.isArray(vals)) continue;
        const row = this.sql.exec("SELECT blob FROM series WHERE upload = ? AND measure = ? AND key = ?", uploadId, measure, key).toArray()[0];
        const cur = row ? await this.#dec(row.blob) : { p, l, r, v: {} };
        months.forEach((ym, i) => { const v = Number(vals[i]) || 0; if (v) cur.v[ym] = Math.round(((cur.v[ym] || 0) + v) * 100) / 100; });
        this.sql.exec("INSERT OR REPLACE INTO series (upload, key, measure, blob) VALUES (?, ?, ?, ?)", uploadId, key, measure, await this.#enc(cur));
      }
      if (isNew && !newIdx.some((e) => e[0] === key)) newIdx.push([key, p, l, r]);
    }
    if (newIdx.length) await this.#indexAdd(uploadId, newIdx);
  }
  async #indexAdd(uploadId, entries) {
    let last = this.sql.exec("SELECT part, blob FROM idx WHERE upload = ? ORDER BY part DESC LIMIT 1", uploadId).toArray()[0];
    let part = last ? last.part : 0, list = last ? await this.#dec(last.blob) : [];
    for (const e of entries) {
      if (list.length >= INDEX_PART) { this.sql.exec("INSERT OR REPLACE INTO idx (upload, part, blob) VALUES (?, ?, ?)", uploadId, part, await this.#enc(list)); part++; list = []; }
      list.push(e);
    }
    this.sql.exec("INSERT OR REPLACE INTO idx (upload, part, blob) VALUES (?, ?, ?)", uploadId, part, await this.#enc(list));
  }
  async #index(uploadId) {
    const out = [];
    for (const r of this.sql.exec("SELECT blob FROM idx WHERE upload = ? ORDER BY part", uploadId).toArray()) out.push(...(await this.#dec(r.blob)));
    return out;
  }
  #range(uploadId) {
    const r = this.sql.exec("SELECT first, last FROM uploads WHERE id = ?", uploadId).toArray()[0];
    return r ? monthsBetween(r.first, r.last) : [];
  }

  // ── Uploads ──────────────────────────────────────────────────────────────────────────────────────────────────
  #summary(u) {
    const measures = JSON.parse(u.measures || '["amount"]'), primary = measures.includes("amount") ? "amount" : "units";
    const pending = this.sql.exec("SELECT SUM(total) AS t, SUM(done) AS d FROM jobs WHERE upload = ? AND status = 'pending' AND kind = 'compute'", u.id).toArray()[0];
    return {
      id: u.id, name: u.name, created: u.created, updated: u.updated || u.created, kind: primary === "amount" ? "money" : "units", months: u.months, products: u.products,
      first: u.first, last: u.last, accuracy: u.accuracy, source: u.source, conn: u.conn, status: u.status, error: u.error, measures, primary,
      locations: u.locations, regions: u.regions, series: u.series,
      progress: pending?.t ? Math.round((100 * (pending.d || 0)) / pending.t) : null,
      hasForecast: this.sql.exec("SELECT 1 FROM views WHERE upload = ? AND mode = 'forecast'", u.id).toArray().length > 0,
    };
  }
  #upload(id) { return this.sql.exec("SELECT * FROM uploads WHERE id = ?", id).toArray()[0] || null; }
  list() { return this.sql.exec("SELECT * FROM uploads WHERE status != 'receiving' ORDER BY created DESC").toArray().map((u) => this.#summary(u)); }
  #count() { return this.sql.exec("SELECT COUNT(*) AS n FROM uploads WHERE source = 'file' AND status != 'receiving'").one().n; }

  /** A new upload. `u` = { name, months, series: [{ product, location, region, amount?, units? }], source, final }. */
  addUpload(account, u, opts = {}) {
    return this.ctx.blockConcurrencyWhile(async () => {
      this.#bind(account);
      if ((u.source || "file") === "file" && this.#count() >= MAX_UPLOADS) return { error: "full" };
      const id = C.randomHex(16);
      this.sql.exec("INSERT INTO uploads (id, name, created, kind, months, products, first, last, data, source, status, updated, conn, migrated) VALUES (?, ?, ?, 'money', 0, 0, ?, ?, '{}', ?, 'receiving', ?, ?, 1)",
        id, u.name, this.#now(), u.months[0] || "", u.months[u.months.length - 1] || "", u.source || "file", this.#now(), u.conn || null);
      if (u.series?.length) await this.#appendInner(id, u.months, u.series);
      if (u.final !== false) return this.#finalizeInner(id, opts);
      return { upload: this.#summary(this.#upload(id)) };
    });
  }
  appendSeries(id, months, series) {
    return this.ctx.blockConcurrencyWhile(async () => {
      const up = this.#upload(id);
      if (!up || up.status !== "receiving") return { error: "notReceiving" };
      const r = await this.#appendInner(id, months, series);
      return r.error ? r : { ok: true, series: this.sql.exec("SELECT COUNT(DISTINCT key) AS n FROM series WHERE upload = ?", id).one().n };
    });
  }
  async #appendInner(id, months, series) {
    if (this.sql.exec("SELECT COUNT(DISTINCT key) AS n FROM series WHERE upload = ?", id).one().n + series.length > MAX_SERIES) return { error: "tooMany" };
    await this.#writeSeries(id, months, series);
    const up = this.#upload(id);
    const first = [up.first, months[0]].filter(Boolean).sort()[0], last = [up.last, months[months.length - 1]].filter(Boolean).sort().pop();
    if (monthsBetween(first, last).length > MAX_MONTHS) return { error: "months" };
    this.sql.exec("UPDATE uploads SET first = ?, last = ? WHERE id = ?", first, last, id);
    return { ok: true };
  }
  finishUpload(id, opts = {}) { return this.ctx.blockConcurrencyWhile(() => this.#finalizeInner(id, opts)); }
  async #finalizeInner(id, opts) {
    const up = this.#upload(id);
    if (!up) return { error: "unknown" };
    await this.#refreshCounts(id);
    this.sql.exec("UPDATE uploads SET status = 'processing', updated = ? WHERE id = ?", this.#now(), id);
    for (const m of JSON.parse(this.#upload(id).measures)) this.#startCompute(id, m, "backtest");
    if (opts.forecast) for (const m of JSON.parse(this.#upload(id).measures)) this.#startCompute(id, m, "forecast");
    await this.#runSmall(id);
    await this.#arm();
    return { upload: this.#summary(this.#upload(id)) };
  }
  async #refreshCounts(id) {
    const idx = await this.#index(id);
    const measures = ["amount", "units"].filter((m) => this.sql.exec("SELECT 1 FROM series WHERE upload = ? AND measure = ? LIMIT 1", id, m).toArray().length);
    const range = this.#range(id);
    this.sql.exec("UPDATE uploads SET products = ?, locations = ?, regions = ?, series = ?, measures = ?, months = ?, kind = ? WHERE id = ?",
      new Set(idx.map((e) => e[1])).size, new Set(idx.map((e) => e[2]).filter(Boolean)).size, new Set(idx.map((e) => e[3]).filter(Boolean)).size, idx.length,
      JSON.stringify(measures.length ? measures : ["amount"]), range.length, measures.includes("amount") || !measures.length ? "money" : "units", id);
  }

  async get(id, { forecastAllowed = true } = {}) {
    const up = this.#upload(id);
    if (!up) return null;
    const s = this.#summary(up);
    const view = async (measure, mode) => { const r = this.sql.exec("SELECT blob, updated FROM views WHERE upload = ? AND measure = ? AND mode = ?", id, measure, mode).toArray()[0]; return r ? { ...(await this.#dec(r.blob)), updatedAt: r.updated } : null; };
    const other = s.measures.find((m) => m !== s.primary);
    const out = { ...s, backtest: await view(s.primary, "backtest") || { ok: false, reason: s.status === "processing" ? "Working on it…" : "No accuracy test yet." } };
    const fc = await view(s.primary, "forecast");
    out.forecast = forecastAllowed && fc ? fc : null;
    out.forecastAt = fc?.updatedAt || null;
    out.forecastStale = Boolean(fc && fc.updatedAt < (up.updated || ""));
    if (other) out.alt = { measure: other, backtest: await view(other, "backtest"), forecast: forecastAllowed ? await view(other, "forecast") : null };
    return out;
  }

  /** Forecast for an upload: the stored one if up to date, otherwise worked out now (small) or in the background. */
  requestForecast(id) {
    return this.ctx.blockConcurrencyWhile(async () => {
      const up = this.#upload(id);
      if (!up) return null;
      const measures = JSON.parse(up.measures);
      for (const m of measures) {
        const v = this.sql.exec("SELECT updated FROM views WHERE upload = ? AND measure = ? AND mode = 'forecast'", id, m).toArray()[0];
        const running = this.sql.exec("SELECT 1 FROM jobs WHERE upload = ? AND measure = ? AND mode = 'forecast' AND status = 'pending'", id, m).toArray().length;
        if ((!v || v.updated < (up.updated || "")) && !running) this.#startCompute(id, m, "forecast");
      }
      await this.#runSmall(id);
      await this.#arm();
      const g = await this.get(id);
      return g.forecast ? { forecast: g.forecast } : { processing: true, progress: g.progress };
    });
  }

  remove(id) {
    return this.ctx.blockConcurrencyWhile(async () => {
      for (const t of ["series", "idx", "results", "views"]) this.sql.exec(`DELETE FROM ${t} WHERE upload = ?`, id);
      for (const j of this.sql.exec("SELECT id FROM jobs WHERE upload = ?", id).toArray()) { this.sql.exec("DELETE FROM partials WHERE job = ?", j.id); this.sql.exec("DELETE FROM stage WHERE job = ?", j.id); }
      this.sql.exec("DELETE FROM jobs WHERE upload = ?", id);
      this.sql.exec("DELETE FROM uploads WHERE id = ?", id);
      if (this.#meta("main_upload") === id) this.#setMeta("main_upload", null);
      await this.#noteUploads();
      return { ok: true };
    });
  }

  /** Series-level detail: e.g. one product in every store, or every product in one region (up to 500 rows). */
  async drill(id, { measure, mode = "forecast", product, location, region, limit = 500 }) {
    const up = this.#upload(id);
    if (!up) return null;
    measure ||= JSON.parse(up.measures).includes("amount") ? "amount" : "units";
    const idx = (await this.#index(id)).filter((e) => (product === undefined || e[1] === product) && (location === undefined || e[2] === location) && (region === undefined || e[3] === region)).slice(0, Math.min(limit, 500));
    const rows = [], range = this.#range(id);
    for (const [key, p, l, r] of idx) {
      const res = this.sql.exec("SELECT blob FROM results WHERE upload = ? AND measure = ? AND mode = ? AND key = ?", id, measure, mode, key).toArray()[0];
      const ser = this.sql.exec("SELECT blob FROM series WHERE upload = ? AND measure = ? AND key = ?", id, measure, key).toArray()[0];
      if (!res && !ser) continue;
      const x = res ? await this.#dec(res.blob) : null, s = ser ? await this.#dec(ser.blob) : { v: {} };
      const last3 = range.slice(-3).reduce((a, m) => a + (s.v[m] || 0), 0);
      rows.push({ product: p, location: l, region: r, method: x?.method || null, forecast: x?.f || null, next3: x ? Math.round(x.f.reduce((a, b) => a + b, 0) * 100) / 100 : null, last3: Math.round(last3 * 100) / 100, actual: x?.actual || null, accuracy: x?.accuracy ?? null });
    }
    return { measure, mode, rows };
  }

  // ── Background jobs ──────────────────────────────────────────────────────────────────────────────────────────
  #startCompute(upload, measure, mode, payload = {}) {
    const total = this.sql.exec("SELECT COUNT(*) AS n FROM series WHERE upload = ? AND measure = ?", upload, measure).one().n;
    this.sql.exec("UPDATE jobs SET status = 'replaced' WHERE upload = ? AND kind = 'compute' AND measure = ? AND mode = ? AND status = 'pending'", upload, measure, mode);
    this.sql.exec("INSERT INTO jobs (upload, kind, measure, mode, phase, total, payload, created, updated) VALUES (?, 'compute', ?, ?, 'series', ?, ?, ?, ?)", upload, measure, mode, total, JSON.stringify(payload), this.#now(), this.#now());
    this.sql.exec("UPDATE uploads SET status = 'processing' WHERE id = ?", upload);
  }
  #startJob(kind, upload, phase, payload = {}, total = 0) {
    this.sql.exec("INSERT INTO jobs (upload, kind, phase, total, payload, created, updated) VALUES (?, ?, ?, ?, ?, ?, ?)", upload, kind, phase, total, JSON.stringify(payload), this.#now(), this.#now());
    return this.sql.exec("SELECT last_insert_rowid() AS id").one().id;
  }
  /** Small uploads are worked out straight away, so the answer is on screen without waiting. */
  async #runSmall(upload) {
    const work = this.sql.exec("SELECT SUM(total) AS n FROM jobs WHERE upload = ? AND status = 'pending' AND kind = 'compute'", upload).one().n || 0;
    if (work > this.#z.INLINE_MAX) return;
    for (let guard = 0; guard < 200; guard++) {
      const job = this.sql.exec("SELECT * FROM jobs WHERE upload = ? AND status = 'pending' AND kind = 'compute' ORDER BY id LIMIT 1", upload).toArray()[0];
      if (!job) break;
      await this.#step(job);
    }
  }
  async #arm() {
    if (this.sql.exec("SELECT 1 FROM jobs WHERE status = 'pending' LIMIT 1").toArray().length) { await this.ctx.storage.setAlarm(Date.now() + 10); return; }
    const next = this.sql.exec("SELECT MIN(next_run) AS t FROM schedule").one().t;
    if (next) await this.ctx.storage.setAlarm(Math.max(Date.now() + 1000, next));
    else await this.ctx.storage.deleteAlarm();
  }
  ensureAlarm(account) { this.#bind(account); return this.#arm().then(() => ({ ok: true })); }

  async alarm() {
    await this.ctx.blockConcurrencyWhile(async () => {
      await this.#runSchedule();
      const job = this.sql.exec("SELECT * FROM jobs WHERE status = 'pending' ORDER BY id LIMIT 1").toArray()[0];
      if (job) await this.#step(job);
      this.sql.exec("DELETE FROM jobs WHERE status != 'pending' AND updated < ?", new Date(Date.now() - 7 * DAY).toISOString());
    });
    await this.#arm();
  }

  async #step(job) {
    try {
      if (job.kind === "compute") await this.#stepCompute(job);
      else if (job.kind === "sync") await this.#stepSync(job);
      else if (job.kind === "file") await this.#stepFile(job);
      else if (job.kind === "merge") await this.#stepMerge(job);
      else if (job.kind === "reorder") await this.#stepReorder(job);
      else if (job.kind === "report") await this.#stepReport(job);
      else this.#endJob(job, "error", "unknown job");
    } catch (e) {
      const msg = e instanceof ConnectorError ? e.message : `Something went wrong (${String(e?.message || e).slice(0, 160)}).`;
      this.#endJob(job, "error", msg);
      await this.#afterJob({ ...job, status: "error", error: msg });
    }
  }
  #endJob(job, status, error = null) {
    this.sql.exec("UPDATE jobs SET status = ?, error = ?, updated = ? WHERE id = ?", status, error, this.#now(), job.id);
    this.sql.exec("DELETE FROM partials WHERE job = ?", job.id);
    this.sql.exec("DELETE FROM stage WHERE job = ?", job.id);
  }
  #save(job, patch) {
    const p = { ...job, ...patch };
    this.sql.exec("UPDATE jobs SET phase = ?, cursor = ?, done = ?, total = ?, payload = ?, updated = ? WHERE id = ?", p.phase, p.cursor, p.done, p.total, typeof p.payload === "string" ? p.payload : JSON.stringify(p.payload), this.#now(), job.id);
  }

  // compute: batches of 40 series, then add the batches up (24 at a time) into the views.
  async #stepCompute(job) {
    const axis = this.#range(job.upload);
    if (job.phase === "series") {
      const rows = this.sql.exec("SELECT key, blob FROM series WHERE upload = ? AND measure = ? AND key > ? ORDER BY key LIMIT ?", job.upload, job.measure, job.cursor, this.#z.CHUNK).toArray();
      if (!rows.length) return this.#save(job, { phase: "merge" });
      const acc = newAccumulator(job.mode, axis);
      for (const row of rows) {
        const s = await this.#dec(row.blob);
        const res = addSeries(acc, { product: s.p, location: s.l, region: s.r, values: axis.map((m) => s.v[m] || 0) });
        this.sql.exec("INSERT OR REPLACE INTO results (upload, measure, mode, key, blob) VALUES (?, ?, ?, ?, ?)", job.upload, job.measure, job.mode, row.key, await this.#enc(res));
      }
      this.sql.exec("INSERT INTO partials (job, blob) VALUES (?, ?)", job.id, await this.#enc(partialOf(acc)));
      return this.#save(job, { cursor: rows[rows.length - 1].key, done: job.done + rows.length });
    }
    const parts = this.sql.exec("SELECT id, blob FROM partials WHERE job = ? ORDER BY id LIMIT ?", job.id, this.#z.MERGE_FAN).toArray();
    const remaining = this.sql.exec("SELECT COUNT(*) AS n FROM partials WHERE job = ?", job.id).one().n;
    const acc = newAccumulator(job.mode, axis);
    for (const p of parts) mergePartial(acc, await this.#dec(p.blob));
    for (const p of parts) this.sql.exec("DELETE FROM partials WHERE id = ?", p.id);
    if (remaining > parts.length) { this.sql.exec("INSERT INTO partials (job, blob) VALUES (?, ?)", job.id, await this.#enc(partialOf(acc))); return; }
    const view = finish(acc, job.measure === "units" ? "units" : "money");
    this.sql.exec("INSERT OR REPLACE INTO views (upload, measure, mode, blob, updated) VALUES (?, ?, ?, ?, ?)", job.upload, job.measure, job.mode, await this.#enc(view), this.#now());
    this.#endJob(job, "done");
    await this.#afterJob({ ...job, status: "done" }, view);
  }

  async #afterJob(job, view) {
    const up = job.upload && this.#upload(job.upload);
    if (up && !this.sql.exec("SELECT 1 FROM jobs WHERE upload = ? AND status = 'pending' AND kind IN ('compute','merge','file','sync') LIMIT 1", up.id).toArray().length) {
      const s = this.#summary(up);
      const bt = this.sql.exec("SELECT blob FROM views WHERE upload = ? AND measure = ? AND mode = 'backtest'", up.id, s.primary).toArray()[0];
      const acc = bt ? (await this.#dec(bt.blob)).accuracy ?? null : null;
      const failed = job.status === "error" && ["compute", "merge", "file", "sync"].includes(job.kind);
      this.sql.exec("UPDATE uploads SET status = ?, error = ?, accuracy = ? WHERE id = ?", failed ? "error" : "ready", failed ? job.error : null, acc, up.id);
      await this.#noteUploads();
    }
    // A fresh units forecast → fresh reorder suggestions (if stock levels are in and the feature is on).
    if (job.kind === "compute" && job.mode === "forecast" && job.measure === "units" && job.status === "done" && job.upload === (await this.#mainUploadId())) {
      if (this.sql.exec("SELECT 1 FROM inventory LIMIT 1").toArray().length && (await this.#company())?.features.inventory) this.#queueReorder();
    }
    const after = JSON.parse(job.payload || "{}").after;
    if (after === "report" && job.status === "done") this.#startJob("report", null, "send");
  }
  async #noteUploads() {
    if (!this.#account) return;
    const latest = this.sql.exec("SELECT * FROM uploads WHERE status != 'receiving' ORDER BY created DESC LIMIT 1").toArray()[0];
    await this.#dir().noteUploads(this.#account, this.sql.exec("SELECT COUNT(*) AS n FROM uploads WHERE status != 'receiving'").one().n, latest ? { created: latest.created, accuracy: latest.accuracy, months: latest.months } : null);
  }
  jobs() {
    return this.sql.exec("SELECT id, upload, kind, measure, mode, phase, total, done, status, error, created, updated FROM jobs ORDER BY id DESC LIMIT 50").toArray();
  }

  // ── Bringing in data (connections, the API, dropped files): pages → combine → apply ─────────────────────────
  /** rows → { key: { p, l, r, amount: { ym: v }, units: { ym: v } } } (one page's worth, before merging). */
  async #pageMap(rows) {
    const map = {}, keys = new Map();
    let bad = 0;
    for (const x of rows) {
      const ym = toYearMonth(x.date, "ymd") || (typeof x.date === "string" && /^\d{4}-\d{2}$/.test(x.date) ? x.date : null);
      if (!ym) { bad++; continue; }
      const p = String(x.product ?? "").trim().slice(0, 120) || "(no name)", l = String(x.location ?? "").trim().slice(0, 120), r = String(x.region ?? "").trim().slice(0, 120);
      const nk = `${p}${SEP}${l}${SEP}${r}`;
      if (!keys.has(nk)) keys.set(nk, await this.#key(p, l, r));
      const e = (map[keys.get(nk)] ||= { p, l, r, amount: {}, units: {} });
      if (x.amount !== undefined && x.amount !== null && Number.isFinite(Number(x.amount))) e.amount[ym] = Math.round(((e.amount[ym] || 0) + Number(x.amount)) * 100) / 100;
      if (x.units !== undefined && x.units !== null && Number.isFinite(Number(x.units))) e.units[ym] = Math.round(((e.units[ym] || 0) + Number(x.units)) * 100) / 100;
    }
    return { map, bad };
  }
  static #combine(into, add) {
    for (const [k, e] of Object.entries(add)) {
      const t = (into[k] ||= { p: e.p, l: e.l, r: e.r, amount: {}, units: {} });
      for (const m of ["amount", "units"]) for (const [ym, v] of Object.entries(e[m])) t[m][ym] = Math.round(((t[m][ym] || 0) + v) * 100) / 100;
    }
    return into;
  }
  /** The upload a source writes into (one per connection, one for the API), created on first use. */
  #sourceUpload(source, name, conn = null) {
    const metaKey = conn ? null : `upload_${source}`;
    let id = conn ? this.sql.exec("SELECT upload FROM connections WHERE id = ?", conn).toArray()[0]?.upload : this.#meta(metaKey);
    if (id && this.#upload(id)) return id;
    id = C.randomHex(16);
    this.sql.exec("INSERT INTO uploads (id, name, created, kind, months, products, first, last, data, source, status, updated, conn, migrated) VALUES (?, ?, ?, 'money', 0, 0, '', '', '{}', ?, 'waiting', ?, ?, 1)", id, name, this.#now(), source, this.#now(), conn);
    if (conn) this.sql.exec("UPDATE connections SET upload = ? WHERE id = ?", id, conn); else this.#setMeta(metaKey, id);
    return id;
  }

  /** The API: sales rows in. mode "replace_months" (default: the months sent are complete) or "add". */
  apiSales(account, rows, mode = "replace_months") {
    return this.ctx.blockConcurrencyWhile(async () => {
      this.#bind(account);
      const upload = this.#sourceUpload("api", "Data sent through the API");
      const { map, bad } = await this.#pageMap(rows);
      if (!Object.keys(map).length) return { error: "noRows", bad };
      const months = [...new Set(Object.values(map).flatMap((e) => [...Object.keys(e.amount), ...Object.keys(e.units)]))].sort();
      const job = this.#startJob("merge", upload, "combine", { mode, months, source: "api" });
      this.sql.exec("INSERT INTO stage (job, type, blob) VALUES (?, 'rows', ?)", job, await this.#enc(map));
      await this.#drainSmall(job, Object.keys(map).length);
      await this.#arm();
      return { ok: true, upload, job, accepted: rows.length - bad, rejected: bad, series: Object.keys(map).length, months };
    });
  }
  /** Runs a merge job to the end now when it's small (so an API caller sees the result), else leaves it to the alarm. */
  async #drainSmall(jobId, size) {
    if (size > this.#z.APPLY_CHUNK) return;
    for (let i = 0; i < 20; i++) {
      const job = this.sql.exec("SELECT * FROM jobs WHERE id = ? AND status = 'pending'", jobId).toArray()[0];
      if (!job) break;
      await this.#step(job);
    }
  }

  /** A CSV file dropped through the API (or pulled from a web address): stored in pieces, read in the background. */
  apiFile(account, text, opts = {}) {
    return this.ctx.blockConcurrencyWhile(async () => {
      this.#bind(account);
      const upload = opts.conn ? this.#sourceUpload("connection", opts.name || "File", opts.conn) : this.#sourceUpload("filedrop", "Files dropped through the API");
      const job = this.#startJob("file", upload, "parse", { mode: opts.mode || "replace_months", mapping: opts.mapping || {}, conn: opts.conn || null, months: [] });
      await this.#storeChunks(job, text);
      await this.#arm();
      return { ok: true, upload, job, bytes: text.length };
    });
  }
  async #storeChunks(job, text) {
    const SIZE = 512 * 1024;
    let i = 0, n = 0;
    while (i < text.length) {
      let end = Math.min(text.length, i + SIZE);
      if (end < text.length) { const nl = text.lastIndexOf("\n", end); const cr = text.lastIndexOf("\r", end); const cut = Math.max(nl, cr); if (cut > i) end = cut + 1; }
      this.sql.exec("INSERT INTO stage (job, type, blob) VALUES (?, 'chunk', ?)", job, await C.encrypt(this.#secret, text.slice(i, end)));
      i = end; n++;
    }
    this.sql.exec("UPDATE jobs SET total = ? WHERE id = ?", n, job);
  }
  async #stepFile(job) {
    const p = JSON.parse(job.payload);
    const chunk = this.sql.exec("SELECT id, blob FROM stage WHERE job = ? AND type = 'chunk' ORDER BY id LIMIT 1", job.id).toArray()[0];
    if (!chunk) {
      this.sql.exec("UPDATE jobs SET kind = 'merge', phase = 'combine', cursor = '', updated = ? WHERE id = ?", this.#now(), job.id);
      return;
    }
    let rows = parseCSV(await C.decrypt(this.#secret, chunk.blob));
    if (!p.header) {
      const header = rows[0] || [], body = rows.slice(1);
      const m = p.mapping || {}, idxOf = (name) => (name ? header.findIndex((h) => String(h).trim().toLowerCase() === String(name).trim().toLowerCase()) : -1);
      const d = detectColumns(header, body);
      const date = m.date ? idxOf(m.date) : d.date, product = m.product ? idxOf(m.product) : d.product;
      let value = m.amount ? idxOf(m.amount) : d.kind === "money" ? d.value : -1;
      const extra = detectExtra(header, [date, product, value]);
      const units = m.units ? idxOf(m.units) : d.kind === "units" ? d.value : extra.units;
      const location = m.location ? idxOf(m.location) : extra.location, region = m.region ? idxOf(m.region) : extra.region;
      if (date < 0 || (value < 0 && units < 0)) throw new ConnectorError("The file's date or sales columns couldn't be found. Name them in the request (date=…&amount=…), or check the file.", 0);
      p.header = { date, product, value, units, location, region, order: m.dateOrder || dateOrderOf(body, date) || "mdy" };
      rows = body;
    }
    const h = p.header, out = [];
    let bad = 0;
    for (const r of rows) {
      const ym = toYearMonth(r[h.date], h.order === "ymd" ? "dmy" : h.order);
      if (!ym) { bad++; continue; }
      out.push({ date: ym, product: h.product >= 0 ? r[h.product] : "All sales", location: h.location >= 0 ? r[h.location] : "", region: h.region >= 0 ? r[h.region] : "",
        amount: h.value >= 0 ? parseNumber(r[h.value]) : undefined, units: h.units >= 0 ? parseNumber(r[h.units]) : undefined });
    }
    const { map } = await this.#pageMap(out);
    p.months = [...new Set([...p.months, ...Object.values(map).flatMap((e) => [...Object.keys(e.amount), ...Object.keys(e.units)])])].sort();
    p.bad = (p.bad || 0) + bad; p.rows = (p.rows || 0) + out.length;
    this.sql.exec("INSERT INTO stage (job, type, blob) VALUES (?, 'rows', ?)", job.id, await this.#enc(map));
    this.sql.exec("DELETE FROM stage WHERE id = ?", chunk.id);
    this.#save(job, { payload: p, done: job.done + 1 });
  }

  // merge: combine pages (20 at a time) → apply to existing series (200 at a time) → add new series → finish.
  async #stepMerge(job) {
    const p = JSON.parse(job.payload);
    if (job.phase === "combine") {
      const pages = this.sql.exec("SELECT id, blob FROM stage WHERE job = ? AND type = 'rows' ORDER BY id LIMIT 20", job.id).toArray();
      const combined = this.sql.exec("SELECT id, blob FROM stage WHERE job = ? AND type = 'combined'", job.id).toArray()[0];
      const map = combined ? await this.#dec(combined.blob) : {};
      for (const pg of pages) Company.#combine(map, await this.#dec(pg.blob));
      for (const pg of pages) this.sql.exec("DELETE FROM stage WHERE id = ?", pg.id);
      if (combined) this.sql.exec("UPDATE stage SET blob = ? WHERE id = ?", await this.#enc(map), combined.id);
      else this.sql.exec("INSERT INTO stage (job, type, blob) VALUES (?, 'combined', ?)", job.id, await this.#enc(map));
      if (!this.sql.exec("SELECT 1 FROM stage WHERE job = ? AND type = 'rows' LIMIT 1", job.id).toArray().length) this.#save(job, { phase: "apply", cursor: "", payload: { ...p, staged: Object.keys(map).length } });
      return;
    }
    const comb = this.sql.exec("SELECT id, blob FROM stage WHERE job = ? AND type = 'combined'", job.id).toArray()[0];
    const map = comb ? await this.#dec(comb.blob) : {};
    const months = new Set(p.months || []);
    const replace = p.mode !== "add";
    const apply = (cur, add) => {
      if (replace) for (const ym of months) delete cur[ym];
      for (const [ym, v] of Object.entries(add || {})) { const n = Math.round(((replace ? 0 : cur[ym] || 0) + v) * 100) / 100; if (n) cur[ym] = n; else delete cur[ym]; }
      return cur;
    };
    if (job.phase === "apply") {
      // Existing series: replace the months covered (missing → 0), or add.
      const [cm, ck] = job.cursor ? job.cursor.split("|") : ["", ""];
      const rows = this.sql.exec("SELECT key, measure, blob FROM series WHERE upload = ? AND (measure > ? OR (measure = ? AND key > ?)) ORDER BY measure, key LIMIT ?", job.upload, cm, cm, ck, this.#z.APPLY_CHUNK).toArray();
      if (rows.length) {
        for (const row of rows) {
          const s = await this.#dec(row.blob), e = map[row.key];
          if (!replace && !e) continue;
          s.v = apply(s.v, e?.[row.measure]);
          this.sql.exec("UPDATE series SET blob = ? WHERE upload = ? AND measure = ? AND key = ?", await this.#enc(s), job.upload, row.measure, row.key);
        }
        return this.#save(job, { cursor: `${rows[rows.length - 1].measure}|${rows[rows.length - 1].key}`, done: job.done + rows.length });
      }
      return this.#save(job, { phase: "insert", cursor: "" });
    }
    if (job.phase === "insert") {
      const keys = Object.keys(map).filter((k) => k > job.cursor).sort().slice(0, this.#z.APPLY_CHUNK);
      if (keys.length) {
        const newIdx = [];
        for (const k of keys) {
          const e = map[k];
          let isNew = !this.sql.exec("SELECT 1 FROM series WHERE upload = ? AND key = ? LIMIT 1", job.upload, k).toArray().length;
          for (const m of ["amount", "units"]) {
            if (!Object.keys(e[m]).length) continue;
            if (this.sql.exec("SELECT 1 FROM series WHERE upload = ? AND measure = ? AND key = ?", job.upload, m, k).toArray().length) continue; // applied above
            this.sql.exec("INSERT INTO series (upload, key, measure, blob) VALUES (?, ?, ?, ?)", job.upload, k, m, await this.#enc({ p: e.p, l: e.l, r: e.r, v: apply({}, e[m]) }));
          }
          if (isNew) newIdx.push([k, e.p, e.l, e.r]);
        }
        if (newIdx.length) await this.#indexAdd(job.upload, newIdx);
        if (this.sql.exec("SELECT COUNT(DISTINCT key) AS n FROM series WHERE upload = ?", job.upload).one().n > MAX_SERIES) throw new ConnectorError(`More than ${MAX_SERIES.toLocaleString("en-US")} product × location combinations — split the data.`, 0);
        return this.#save(job, { cursor: keys[keys.length - 1] });
      }
      // Finish: new month range, counts, then accuracy test (and forecast, if switched on) in the background.
      const up = this.#upload(job.upload);
      const sorted = [up.first, up.last, ...Object.values(map).flatMap((e) => [...Object.keys(e.amount), ...Object.keys(e.units)])].filter(Boolean).sort();
      let first = sorted[0] || "", last = sorted[sorted.length - 1] || "";
      if (monthsBetween(first, last).length > MAX_MONTHS) first = addMonths(last, -(MAX_MONTHS - 1));
      this.sql.exec("UPDATE uploads SET first = ?, last = ?, updated = ? WHERE id = ?", first, last, this.#now(), up.id);
      await this.#refreshCounts(up.id);
      this.#endJob(job, "done");
      if (p.conn) await this.#connDone(p.conn, { rows: p.rows ?? null, ok: true });
      const co = await this.#company();
      if (first && last && monthsBetween(first, last).length >= 1) {
        for (const m of JSON.parse(this.#upload(up.id).measures)) {
          this.#startCompute(up.id, m, "backtest");
          if (co?.features.forecasts) this.#startCompute(up.id, m, "forecast");
        }
        await this.#runSmall(up.id);
      }
      if (p.inventory) await this.#applyInventoryStage(p.inventory, p.conn ? `connection:${p.conn}` : "api");
      await this.#afterJob({ ...job, status: "done" });
      return;
    }
  }

  // ── Connections ──────────────────────────────────────────────────────────────────────────────────────────────
  #connOut(c) {
    const kind = CONNECTORS[c.kind];
    return { id: c.id, kind: c.kind, kindName: kind?.name || c.kind, name: c.name, status: c.status, lastSync: c.last_sync, lastOk: c.last_ok, lastError: c.last_error,
      rows: c.rows_last, created: c.created, upload: c.upload, historyMonths: c.history_months, nextRun: this.sql.exec("SELECT next_run FROM schedule WHERE task = ?", `sync:${c.id}`).toArray()[0]?.next_run || null };
  }
  connections() { return this.sql.exec("SELECT * FROM connections ORDER BY created").toArray().map((c) => this.#connOut(c)); }
  async #noteConnections() { if (this.#account) await this.#dir().noteConnections(this.#account, this.connections().map((c) => ({ id: c.id, kind: c.kind, kindName: c.kindName, name: c.name, status: c.status, lastSync: c.lastSync, lastOk: c.lastOk, lastError: c.lastError, rows: c.rows }))); }
  /** Saves a connection (credentials encrypted). Secret fields left blank keep their saved value. */
  saveConnection(account, { id, kind, name, creds, historyMonths }) {
    return this.ctx.blockConcurrencyWhile(async () => {
      this.#bind(account);
      const def = CONNECTORS[kind];
      if (!def) return { error: "kind" };
      const existing = id ? this.sql.exec("SELECT * FROM connections WHERE id = ?", id).toArray()[0] : null;
      if (id && !existing) return { error: "unknown" };
      const merged = { ...(existing ? await this.#dec(existing.creds) : {}) };
      for (const f of def.fields) { const v = creds?.[f.k]; if (f.type === "checkbox") merged[f.k] = Boolean(v); else if (typeof v === "string" && (v.trim() || !f.secret)) merged[f.k] = v.trim(); }
      for (const k of ["realmId", "refreshToken", "accessToken", "accessExpires"]) if (creds?.[k] !== undefined) merged[k] = creds[k];
      const problem = def.auth === "oauth" && !merged.refreshToken ? null : def.validate(merged);
      if (problem) return { error: "invalid", message: problem };
      const hm = Math.max(3, Math.min(60, Number(historyMonths) || existing?.history_months || 24));
      const cid = existing?.id || C.randomHex(12);
      if (existing) this.sql.exec("UPDATE connections SET name = ?, creds = ?, history_months = ? WHERE id = ?", name || existing.name, await this.#enc(merged), hm, cid);
      else this.sql.exec("INSERT INTO connections (id, kind, name, creds, created, history_months, status) VALUES (?, ?, ?, ?, ?, ?, ?)", cid, kind, name || def.name, await this.#enc(merged), this.#now(), hm, def.auth === "oauth" && !merged.refreshToken ? "needs-auth" : "new");
      this.#sourceUpload("connection", name || def.name, cid);
      await this.#scheduleSync(cid);
      await this.#noteConnections();
      await this.#arm();
      return { connection: this.#connOut(this.sql.exec("SELECT * FROM connections WHERE id = ?", cid).toArray()[0]) };
    });
  }
  async removeConnection(id) {
    const c = this.sql.exec("SELECT * FROM connections WHERE id = ?", id).toArray()[0];
    if (!c) return { error: "unknown" };
    this.sql.exec("DELETE FROM connections WHERE id = ?", id);
    this.sql.exec("DELETE FROM schedule WHERE task = ?", `sync:${id}`);
    this.sql.exec("UPDATE jobs SET status = 'cancelled' WHERE kind IN ('sync','merge','file') AND status = 'pending' AND payload LIKE ?", `%"conn":"${id}"%`);
    await this.#noteConnections();
    await this.#arm();
    return { ok: true, name: c.name, upload: c.upload };
  }
  #ctx(c, cfg) {
    return {
      env: this.env, since: "", wantInventory: false,
      platformSecret: (k) => this.#dir().secret(k),
      saveCreds: async (next) => { this.sql.exec("UPDATE connections SET creds = ? WHERE id = ?", await this.#enc(next), c.id); },
    };
  }
  async testConnection(id) {
    const c = this.sql.exec("SELECT * FROM connections WHERE id = ?", id).toArray()[0];
    if (!c) return { error: "unknown" };
    const def = CONNECTORS[c.kind], cfg = await this.#dec(c.creds);
    try { return { ok: true, message: await def.test(cfg, this.#ctx(c, cfg)) }; }
    catch (e) { return { ok: false, message: e instanceof ConnectorError ? e.message : "The test failed unexpectedly." }; }
  }
  /** Starts a sync now (also what the nightly schedule does). */
  syncNow(id, by = "schedule") {
    return this.ctx.blockConcurrencyWhile(async () => {
      const r = await this.#startSync(id, by);
      await this.#arm();
      return r;
    });
  }
  async #startSync(id, by) {
    const c = this.sql.exec("SELECT * FROM connections WHERE id = ?", id).toArray()[0];
    if (!c) return { error: "unknown" };
    if (this.sql.exec("SELECT 1 FROM jobs WHERE status = 'pending' AND kind IN ('sync','merge','file') AND payload LIKE ?", `%"conn":"${id}"%`).toArray().length) return { ok: true, already: true };
    const now = new Date();
    const since = c.synced_once
      ? new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1) - 45 * DAY).toISOString().slice(0, 7) + "-01" // re-read the last ~2 months each night (late edits)
      : `${addMonths(now.toISOString().slice(0, 7), -(c.history_months - 1))}-01`;
    const months = monthsBetween(since.slice(0, 7), now.toISOString().slice(0, 7));
    const upload = this.#sourceUpload("connection", c.name, c.id);
    const def = CONNECTORS[c.kind];
    const co = await this.#company();
    this.#startJob(def.file ? "sync" : "sync", upload, def.file ? "download" : "pull", { conn: c.id, since, months, mode: def.file ? "replace_months" : "replace_months", state: null, rows: 0, by, wantInventory: Boolean(co?.features.inventory) });
    this.sql.exec("UPDATE connections SET status = 'syncing', last_sync = ? WHERE id = ?", this.#now(), c.id);
    this.log({ user: by, action: "sync started", detail: `${c.name} (${def.name}) from ${since}` });
    await this.#noteConnections();
    return { ok: true, since };
  }
  async #stepSync(job) {
    const p = JSON.parse(job.payload);
    const c = this.sql.exec("SELECT * FROM connections WHERE id = ?", p.conn).toArray()[0];
    if (!c) return this.#endJob(job, "cancelled");
    const def = CONNECTORS[c.kind], cfg = await this.#dec(c.creds);
    const ctx = { ...this.#ctx(c, cfg), since: p.since, wantInventory: p.wantInventory };
    try {
      if (job.phase === "download") {
        const res = await fetch(this.env.CONNECTOR_TEST_BASE ? `${this.env.CONNECTOR_TEST_BASE}/${new URL(cfg.url).host}${new URL(cfg.url).pathname}${new URL(cfg.url).search}` : cfg.url, { headers: def.hdr(cfg), signal: AbortSignal.timeout(60000) });
        if (!res.ok) throw new ConnectorError(`The file address answered ${res.status}.`, res.status);
        const buf = await res.arrayBuffer();
        if (buf.byteLength > 20 * 1024 * 1024) throw new ConnectorError("The file is over 20 MB. Export fewer months, or send it through the API in parts.", 0);
        let text; try { text = new TextDecoder("utf-8", { fatal: true }).decode(buf); } catch { text = new TextDecoder("windows-1252").decode(buf); }
        await this.#storeChunks(job.id, text);
        this.sql.exec("UPDATE jobs SET kind = 'file', phase = 'parse', payload = ?, updated = ? WHERE id = ?", JSON.stringify({ mode: "replace_months", mapping: {}, conn: c.id, months: [] }), this.#now(), job.id);
        return;
      }
      const r = await def.pull(cfg, p.state, ctx);
      if (r.rows?.length) {
        const { map } = await this.#pageMap(r.rows);
        this.sql.exec("INSERT INTO stage (job, type, blob) VALUES (?, 'rows', ?)", job.id, await this.#enc(map));
      }
      if (r.inventory?.length) this.sql.exec("INSERT INTO stage (job, type, blob) VALUES (?, 'inventory', ?)", job.id, await this.#enc(r.inventory));
      p.rows += r.rows?.length || 0; p.pages = (p.pages || 0) + 1;
      if (r.state && p.pages < 5000) return this.#save(job, { payload: { ...p, state: r.state }, done: job.done + 1 });
      // Pulled everything: merge it in (inventory pages collected for after).
      const inv = [];
      for (const s of this.sql.exec("SELECT id, blob FROM stage WHERE job = ? AND type = 'inventory'", job.id).toArray()) { inv.push(...(await this.#dec(s.blob))); this.sql.exec("DELETE FROM stage WHERE id = ?", s.id); }
      let invId = null;
      if (inv.length) { invId = `inv_${job.id}`; this.#setMeta(invId, await this.#enc(inv)); }
      this.sql.exec("UPDATE jobs SET kind = 'merge', phase = 'combine', cursor = '', payload = ?, updated = ? WHERE id = ?",
        JSON.stringify({ mode: "replace_months", months: p.months, conn: c.id, rows: p.rows, inventory: invId }), this.#now(), job.id);
    } catch (e) {
      const msg = e instanceof ConnectorError ? e.message : `Something went wrong (${String(e?.message || e).slice(0, 160)}).`;
      this.#endJob(job, "error", msg);
      await this.#connDone(c.id, { ok: false, error: msg });
      await this.#afterJob({ ...job, status: "error", error: msg });
    }
  }
  async #connDone(id, { ok, rows, error }) {
    const c = this.sql.exec("SELECT * FROM connections WHERE id = ?", id).toArray()[0];
    if (!c) return;
    if (ok) {
      this.sql.exec("UPDATE connections SET status = 'ok', last_ok = ?, last_error = NULL, rows_last = ?, synced_once = 1 WHERE id = ?", this.#now(), rows, id);
      this.log({ user: "system", action: "sync finished", detail: `${c.name}: ${rows ?? "?"} sales lines read` });
    } else {
      this.sql.exec("UPDATE connections SET status = 'error', last_error = ? WHERE id = ?", error, id);
      this.log({ user: "system", action: "sync failed", detail: `${c.name}: ${error}` });
    }
    await this.#noteConnections();
  }
  async #scheduleSync(id) {
    const tz = (await this.#company())?.timezone || "UTC";
    const jitter = parseInt(id.slice(0, 4), 16) % 50;
    this.sql.exec("INSERT OR REPLACE INTO schedule (task, next_run) VALUES (?, ?)", `sync:${id}`, nextLocal(tz, 2, jitter));
  }
  /** QuickBooks sign-in finished: keep the tokens, then sync. */
  async connectionAuthorized(id, creds) {
    const c = this.sql.exec("SELECT * FROM connections WHERE id = ?", id).toArray()[0];
    if (!c) return { error: "unknown" };
    const cur = await this.#dec(c.creds);
    this.sql.exec("UPDATE connections SET creds = ?, status = 'new' WHERE id = ?", await this.#enc({ ...cur, ...creds }), id);
    this.log({ user: "system", action: "connection authorized", detail: c.name });
    return this.syncNow(id, "connect");
  }

  // ── Scheduled work ───────────────────────────────────────────────────────────────────────────────────────────
  async #runSchedule() {
    const due = this.sql.exec("SELECT * FROM schedule WHERE next_run <= ?", Date.now()).toArray();
    if (!due.length) return;
    const co = await this.#company();
    if (!co) { this.sql.exec("DELETE FROM schedule"); return; }
    for (const t of due) {
      if (t.task.startsWith("sync:")) {
        const id = t.task.slice(5);
        if (co.features.connectors && !co.off) await this.#startSync(id, "nightly schedule");
        await this.#scheduleSync(id);
      } else if (t.task === "report") {
        if (co.features.reports && !co.off) this.#startJob("report", null, "send");
        this.#scheduleReport(co.timezone);
      }
    }
  }

  // ── Stock levels and reorder suggestions ─────────────────────────────────────────────────────────────────────
  async #invKey(product, location) { return C.hex(await C.hmac("SHA-256", this.#secret, `inv${SEP}${String(product).trim().toLowerCase()}${SEP}${String(location || "").trim().toLowerCase()}`)).slice(0, 32); }
  /** items: [{ product, location, onHand, onOrder, leadDays, casePack, minOrder, unitCost }]. replace: clear the old list first. */
  upsertInventory(account, items, { replace = false, source = "file", by = "" } = {}) {
    return this.ctx.blockConcurrencyWhile(async () => {
      this.#bind(account);
      if (replace) this.sql.exec("DELETE FROM inventory");
      let n = 0;
      for (const it of items.slice(0, 20000)) {
        if (!it.product) continue;
        const k = await this.#invKey(it.product, it.location);
        const old = this.sql.exec("SELECT blob FROM inventory WHERE k = ?", k).toArray()[0];
        const cur = old ? await this.#dec(old.blob) : {};
        const next = { ...cur, product: String(it.product).trim().slice(0, 120), location: String(it.location || "").trim().slice(0, 120) };
        for (const f of ["onHand", "onOrder", "leadDays", "casePack", "minOrder", "unitCost"]) if (it[f] !== undefined && it[f] !== null && it[f] !== "" && Number.isFinite(Number(it[f]))) next[f] = Number(it[f]);
        this.sql.exec("INSERT OR REPLACE INTO inventory (k, blob, updated, source) VALUES (?, ?, ?, ?)", k, await this.#enc(next), this.#now(), source);
        n++;
      }
      if (by) this.log({ user: by, action: "stock levels updated", detail: `${n} items (${source})${replace ? ", replaced the list" : ""}` });
      this.#queueReorder();
      await this.#arm();
      return { ok: true, items: n };
    });
  }
  async #applyInventoryStage(metaKey, source) {
    const blob = this.#meta(metaKey);
    if (!blob) return;
    const items = await this.#dec(blob);
    this.#setMeta(metaKey, null);
    for (const it of items) {
      const k = await this.#invKey(it.product, it.location);
      const old = this.sql.exec("SELECT blob FROM inventory WHERE k = ?", k).toArray()[0];
      const cur = old ? await this.#dec(old.blob) : { product: it.product, location: it.location || "" };
      this.sql.exec("INSERT OR REPLACE INTO inventory (k, blob, updated, source) VALUES (?, ?, ?, ?)", k, await this.#enc({ ...cur, onHand: Number(it.onHand) || 0 }), this.#now(), source);
    }
    this.#queueReorder();
  }
  inventorySettings() { return { ...DEFAULT_SETTINGS, ...JSON.parse(this.#meta("inv_settings") || "{}"), mainUpload: this.#meta("main_upload") }; }
  setInventorySettings(patch) {
    const s = this.inventorySettings();
    if ([0.9, 0.95, 0.975, 0.99].includes(Number(patch.serviceLevel))) s.serviceLevel = Number(patch.serviceLevel);
    for (const k of ["reviewDays", "leadDays"]) if (Number(patch[k]) >= 1 && Number(patch[k]) <= 365) s[k] = Math.round(Number(patch[k]));
    this.#setMeta("inv_settings", JSON.stringify({ serviceLevel: s.serviceLevel, reviewDays: s.reviewDays, leadDays: s.leadDays }));
    if (patch.mainUpload !== undefined) this.#setMeta("main_upload", patch.mainUpload && this.#upload(patch.mainUpload) ? patch.mainUpload : null);
    this.#queueReorder();
    return this.inventorySettings();
  }
  async inventory(limit = 1000) {
    const out = [];
    for (const r of this.sql.exec("SELECT blob, updated, source FROM inventory LIMIT ?", Math.min(limit, 5000)).toArray()) out.push({ ...(await this.#dec(r.blob)), updated: r.updated, source: r.source });
    return { items: out.sort((a, b) => a.product.localeCompare(b.product) || a.location.localeCompare(b.location)), total: this.sql.exec("SELECT COUNT(*) AS n FROM inventory").one().n };
  }
  /** Which upload the reorder suggestions and weekly report use: the one chosen, else the newest connected/API one, else the newest. */
  async #mainUploadId() {
    const chosen = this.#meta("main_upload");
    if (chosen && this.#upload(chosen)) return chosen;
    const r = this.sql.exec("SELECT id FROM uploads WHERE status IN ('ready','processing') ORDER BY CASE WHEN source IN ('connection','api','filedrop') THEN 0 ELSE 1 END, updated DESC LIMIT 1").toArray()[0];
    return r?.id || null;
  }
  #queueReorder() {
    this.sql.exec("UPDATE jobs SET status = 'replaced' WHERE kind = 'reorder' AND status = 'pending'");
    this.#startJob("reorder", null, "prepare");
  }
  async #stepReorder(job) {
    const p = JSON.parse(job.payload);
    if (job.phase === "prepare") {
      const upload = await this.#mainUploadId();
      const save = async (view) => { this.sql.exec("INSERT OR REPLACE INTO views (upload, measure, mode, blob, updated) VALUES ('_reorder', 'units', 'reorder', ?, ?)", await this.#enc(view), this.#now()); this.#endJob(job, "done"); };
      if (!upload) return save({ ok: false, reason: "Upload sales or connect a system first." });
      const up = this.#upload(upload);
      if (!JSON.parse(up.measures).includes("units")) return save({ ok: false, reason: "Reorder suggestions need sales quantities (units). Include a quantity column, or connect a system that sends quantities." });
      const fc = this.sql.exec("SELECT updated FROM views WHERE upload = ? AND measure = 'units' AND mode = 'forecast'", upload).toArray()[0];
      if (!fc || fc.updated < (up.updated || "")) {
        if (!this.sql.exec("SELECT 1 FROM jobs WHERE upload = ? AND measure = 'units' AND mode = 'forecast' AND status = 'pending'", upload).toArray().length) this.#startCompute(upload, "units", "forecast");
        this.#endJob(job, "replaced"); // waits for the forecast
        return; // the forecast's completion queues a fresh reorder job
      }
      const view = await this.#dec(this.sql.exec("SELECT blob FROM views WHERE upload = ? AND measure = 'units' AND mode = 'forecast'", upload).one().blob);
      return this.#save(job, { phase: "items", cursor: "", payload: { upload, months: view.months, settings: this.inventorySettings() }, total: this.sql.exec("SELECT COUNT(*) AS n FROM inventory").one().n });
    }
    if (job.phase === "items") {
      const items = this.sql.exec("SELECT k, blob FROM inventory WHERE k > ? ORDER BY k LIMIT ?", job.cursor, this.#z.INV_CHUNK).toArray();
      if (!items.length) return this.#save(job, { phase: "finish" });
      const idx = await this.#index(p.upload);
      const byPL = new Map(), byP = new Map();
      for (const [key, pr, l] of idx) {
        const a = `${pr.trim().toLowerCase()}${SEP}${l.trim().toLowerCase()}`, b = pr.trim().toLowerCase();
        (byPL.get(a) || byPL.set(a, []).get(a)).push(key);
        (byP.get(b) || byP.set(b, []).get(b)).push(key);
      }
      const out = [];
      for (const it of items) {
        const item = await this.#dec(it.blob);
        const keys = item.location ? byPL.get(`${item.product.toLowerCase()}${SEP}${item.location.toLowerCase()}`) : byP.get(item.product.toLowerCase());
        let demand = null;
        if (keys?.length) {
          const f = [0, 0, 0]; let varSum = 0, haveErr = false;
          for (const key of keys) {
            const fr = this.sql.exec("SELECT blob FROM results WHERE upload = ? AND measure = 'units' AND mode = 'forecast' AND key = ?", p.upload, key).toArray()[0];
            if (fr) (await this.#dec(fr.blob)).f.forEach((v, i) => { f[i] += v; });
            const br = this.sql.exec("SELECT blob FROM results WHERE upload = ? AND measure = 'units' AND mode = 'backtest' AND key = ?", p.upload, key).toArray()[0];
            if (br) { const b = await this.#dec(br.blob); if (b.actual) { haveErr = true; varSum += b.f.reduce((s, v, i) => s + (v - b.actual[i]) ** 2, 0) / b.f.length; } }
          }
          demand = { forecast: f, months: p.months, rmse: haveErr ? Math.sqrt(varSum) : null };
        }
        out.push(suggest(item, demand, p.settings));
      }
      this.sql.exec("INSERT INTO stage (job, type, blob) VALUES (?, 'reorder', ?)", job.id, await this.#enc(out));
      return this.#save(job, { cursor: items[items.length - 1].k, done: job.done + items.length });
    }
    // finish: one sorted list, then emails for items that just became low.
    const all = [];
    for (const s of this.sql.exec("SELECT blob FROM stage WHERE job = ? AND type = 'reorder'", job.id).toArray()) all.push(...(await this.#dec(s.blob)));
    sortSuggestions(all);
    const view = { ok: true, months: p.months, settings: p.settings, items: all.slice(0, 5000), counts: { out: all.filter((x) => x.status === "out").length, low: all.filter((x) => x.status === "low").length, ok: all.filter((x) => x.status === "ok").length, nodata: all.filter((x) => x.status === "nodata").length },
      orderValue: Math.round(all.reduce((s, x) => s + (x.orderValue || 0), 0) * 100) / 100 };
    this.sql.exec("INSERT OR REPLACE INTO views (upload, measure, mode, blob, updated) VALUES ('_reorder', 'units', 'reorder', ?, ?)", await this.#enc(view), this.#now());
    this.#endJob(job, "done");
    await this.#lowStockAlerts(all.filter((x) => x.status === "out" || x.status === "low"));
  }
  async reorder() {
    const r = this.sql.exec("SELECT blob, updated FROM views WHERE upload = '_reorder' AND mode = 'reorder'").toArray()[0];
    const pending = this.sql.exec("SELECT 1 FROM jobs WHERE kind = 'reorder' AND status = 'pending'").toArray().length > 0;
    return r ? { ...(await this.#dec(r.blob)), updatedAt: r.updated, pending } : { ok: false, reason: pending ? "Working on it…" : "Add stock levels to see reorder suggestions.", pending };
  }
  /** Emails managers about items that became low (not again for 7 days unless they recover first). */
  async #lowStockAlerts(low) {
    const co = await this.#company();
    if (!co?.features.inventory || co.off) return;
    const prev = JSON.parse(this.#meta("low_alerted") || "{}"), now = Date.now(), next = {};
    const fresh = [];
    for (const x of low) {
      const k = `${x.product}${SEP}${x.location}`;
      next[k] = prev[k] && now - prev[k] < 7 * DAY ? prev[k] : now;
      if (next[k] === now) fresh.push(x);
    }
    this.#setMeta("low_alerted", JSON.stringify(next));
    if (!fresh.length) return;
    const to = (await this.#dir().recipients(this.#account, "lowStock")).map((r) => r.email);
    if (!to.length) return;
    const mail = lowStockEmail({ company: co.company, items: fresh, link: `${this.#origin()}/#/stock` });
    const r = await sendEmail(this.env, this.#dir(), { to, ...mail });
    this.log({ user: "system", action: r.ok ? "low-stock email sent" : "low-stock email not sent", detail: r.ok ? `${fresh.length} items to ${r.sent} people` : r.reason });
  }

  // ── Weekly report ────────────────────────────────────────────────────────────────────────────────────────────
  reportSettings() { return { enabled: false, weekday: 1, hour: 7, ...JSON.parse(this.#meta("report") || "{}"), nextRun: this.sql.exec("SELECT next_run FROM schedule WHERE task = 'report'").toArray()[0]?.next_run || null }; }
  async setReportSettings(account, patch) {
    this.#bind(account);
    const s = this.reportSettings();
    if (typeof patch.enabled === "boolean") s.enabled = patch.enabled;
    if (Number.isInteger(patch.weekday) && patch.weekday >= 0 && patch.weekday <= 6) s.weekday = patch.weekday;
    if (Number.isInteger(patch.hour) && patch.hour >= 0 && patch.hour <= 23) s.hour = patch.hour;
    this.#setMeta("report", JSON.stringify({ enabled: s.enabled, weekday: s.weekday, hour: s.hour }));
    this.#scheduleReport((await this.#company())?.timezone || "UTC");
    await this.#arm();
    return this.reportSettings();
  }
  #scheduleReport(tz) {
    const s = this.reportSettings();
    if (!s.enabled) { this.sql.exec("DELETE FROM schedule WHERE task = 'report'"); return; }
    this.sql.exec("INSERT OR REPLACE INTO schedule (task, next_run) VALUES ('report', ?)", nextLocal(tz, s.hour, 0, s.weekday));
  }
  sendReportNow(account, by) {
    return this.ctx.blockConcurrencyWhile(async () => {
      this.#bind(account);
      this.#startJob("report", null, "send", { by, now: true });
      await this.#arm();
      return { ok: true };
    });
  }
  async #stepReport(job) {
    const p = JSON.parse(job.payload);
    const co = await this.#company();
    const upload = await this.#mainUploadId();
    if (!upload || !co) { this.#endJob(job, "done"); this.log({ user: "system", action: "weekly report skipped", detail: "No data yet." }); return; }
    const up = this.#upload(upload), s = this.#summary(up);
    const fcRow = this.sql.exec("SELECT blob, updated FROM views WHERE upload = ? AND measure = ? AND mode = 'forecast'", upload, s.primary).toArray()[0];
    if ((!fcRow || fcRow.updated < (up.updated || "")) && !p.waited) {
      this.#startCompute(upload, s.primary, "forecast", { after: "report" });
      this.#endJob(job, "replaced");
      return;
    }
    if (!fcRow) { this.#endJob(job, "done"); return; }
    const forecast = await this.#dec(this.sql.exec("SELECT blob FROM views WHERE upload = ? AND measure = ? AND mode = 'forecast'", upload, s.primary).one().blob);
    const btRow = this.sql.exec("SELECT blob FROM views WHERE upload = ? AND measure = ? AND mode = 'backtest'", upload, s.primary).toArray()[0];
    const backtest = btRow ? await this.#dec(btRow.blob) : null;
    const ro = await this.reorder();
    const low = ro.ok ? ro.items.filter((x) => x.status === "out" || x.status === "low") : [];
    const to = (await this.#dir().recipients(this.#account, "reports")).map((r) => r.email);
    if (!forecast.ok || !to.length) { this.#endJob(job, "done"); this.log({ user: "system", action: "weekly report skipped", detail: !to.length ? "Nobody has weekly reports switched on." : forecast.reason }); return; }
    const mail = weeklyReport({ company: co.company, uploadName: up.name, forecast, backtest, low, link: `${this.#origin()}/#/u/${upload}`, monthLabel });
    const r = await sendEmail(this.env, this.#dir(), { to, ...mail });
    this.log({ user: p.by || "system", action: r.ok ? "weekly report sent" : "weekly report not sent", detail: r.ok ? `to ${r.sent} people` : r.reason });
    this.#endJob(job, "done");
  }

  // ── For the API ──────────────────────────────────────────────────────────────────────────────────────────────
  async apiForecasts(uploadId, view = "total") {
    const id = uploadId === "api" ? this.#meta("upload_api") : uploadId === "main" || !uploadId ? await this.#mainUploadId() : uploadId;
    const up = id && this.#upload(id);
    if (!up) return null;
    const g = await this.get(id);
    const f = g.forecast;
    const pick = (list) => (list || []).map((x) => ({ name: x.name, months: f.months, forecast: x.forecast, next3: x.next3, last3: x.last3 }));
    return { upload: { id: g.id, name: g.name, status: g.status, updated: g.updated, kind: g.kind }, accuracy: g.backtest?.accuracy ?? null,
      forecast: f ? { months: f.months, summary: f.summary, ...(view === "total" ? { total: f.total.forecast } : { items: pick(view === "product" ? f.products : view === "location" ? f.locations : f.regions) }) } : null };
  }

  /** Company deleted: everything goes. */
  async wipe() {
    await this.ctx.storage.deleteAlarm();
    await this.ctx.storage.deleteAll();
    this.#schema(); // empty tables again, ready for reuse (e.g. "Allow one more run" on a demo link)
    return { ok: true };
  }
}
