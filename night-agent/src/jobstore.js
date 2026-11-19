/**
 * The permanent job-ad database (SQLite). Every job ad the Scout fetches is saved here in the same step it's fetched,
 * before the night's working storage drops any text. Rows are only ever inserted or updated: there is no DELETE or
 * DROP anywhere, so nothing is ever removed.
 *
 *   job_ads        one row per ad (its link is the key): company, role, link, source, listed pay, location,
 *                  the date it was first found, last seen, how many runs saw it, and whether it qualified
 *   job_sightings  one row per (ad, run): which runs found it, so each morning report can list that night's ads
 *
 * "Qualified" = Gemini found a word-for-word quote in the ad showing paid repetitive work software could do, and the
 * Scout kept it as proof. Once qualified, an ad stays qualified.
 *
 * Works on any SQLite with the Durable Objects interface: sql.exec(query, ...bindings) → cursor (toArray / one),
 * plus transactionSync(fn). The Worker uses a SQLite Durable Object (jobdb.js); the tests use Node's SQLite.
 */
const SCHEMA = [
  `CREATE TABLE IF NOT EXISTS job_ads (url TEXT PRIMARY KEY, company TEXT NOT NULL DEFAULT '', role TEXT NOT NULL DEFAULT '', source TEXT NOT NULL DEFAULT '',
    pay TEXT NOT NULL DEFAULT '', location TEXT NOT NULL DEFAULT '', first_found TEXT NOT NULL, first_run TEXT NOT NULL, first_at TEXT NOT NULL,
    last_seen TEXT NOT NULL, times_seen INTEGER NOT NULL DEFAULT 1, qualified INTEGER NOT NULL DEFAULT 0, qualified_on TEXT, quote TEXT)`,
  `CREATE TABLE IF NOT EXISTS job_sightings (url TEXT NOT NULL, run TEXT NOT NULL, at TEXT NOT NULL, PRIMARY KEY (url, run))`,
  `CREATE INDEX IF NOT EXISTS job_ads_first ON job_ads (first_at)`,
  `CREATE INDEX IF NOT EXISTS job_sightings_run ON job_sightings (run)`,
];
const str = (v, n) => String(v ?? "").slice(0, n);
const row = (r) => ({ url: r.url, company: r.company, role: r.role, source: r.source, pay: r.pay, location: r.location, firstFound: r.first_found, firstRun: r.first_run,
  lastSeen: r.last_seen, timesSeen: Number(r.times_seen), qualified: Boolean(r.qualified), qualifiedOn: r.qualified_on || null, quote: r.quote || null });

export class JobAdsStore {
  constructor(sql, transactionSync = (fn) => fn()) {
    this.sql = sql; this.tx = transactionSync;
    for (const s of SCHEMA) this.sql.exec(s);
  }
  all(q, ...b) { return this.sql.exec(q, ...b).toArray(); }

  /** Saves found ads; each carries the run that found it ({ url, company, role, source, pay, location, run, date, at }).
   *  New ads are inserted; ads already saved keep their first-found date and get one more sighting. Saving the same
   *  ad for the same run twice changes nothing, so a retry is always safe. */
  save(ads, defaults = {}) {
    let added = 0, seenAgain = 0;
    this.tx(() => {
      for (const a of ads || []) {
        const url = str(a.url, 600), run = str(a.run || defaults.run, 40), date = str(a.date || defaults.date, 10), at = str(a.at || defaults.at || new Date().toISOString(), 40);
        if (!/^https:\/\//.test(url) || !run || !/^\d{4}-\d{2}-\d{2}$/.test(date)) continue;
        if (!this.all("SELECT 1 FROM job_ads WHERE url = ?", url).length) {
          this.sql.exec("INSERT INTO job_ads (url, company, role, source, pay, location, first_found, first_run, first_at, last_seen) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
            url, str(a.company, 120), str(a.role, 160), str(a.source, 40), str(a.pay, 100), str(a.location, 100), date, run, at, date);
          this.sql.exec("INSERT INTO job_sightings (url, run, at) VALUES (?, ?, ?)", url, run, at);
          added++;
        } else if (!this.all("SELECT 1 FROM job_sightings WHERE url = ? AND run = ?", url, run).length) {
          this.sql.exec("INSERT INTO job_sightings (url, run, at) VALUES (?, ?, ?)", url, run, at);
          this.sql.exec("UPDATE job_ads SET last_seen = ?, times_seen = times_seen + 1 WHERE url = ?", date, url);
          seenAgain++;
        }
      }
    });
    return { added, seenAgain };
  }

  /** Marks ads as qualified (kept as proof), with the quote. Never un-marks. */
  qualify(items, defaults = {}) {
    let marked = 0;
    this.tx(() => {
      for (const it of items || []) {
        const url = str(it.url, 600), date = str(it.date || defaults.date, 10);
        if (this.all("SELECT 1 FROM job_ads WHERE url = ? AND qualified = 0", url).length) {
          this.sql.exec("UPDATE job_ads SET qualified = 1, qualified_on = ?, quote = ? WHERE url = ?", date, str(it.quote, 500), url);
          marked++;
        }
      }
    });
    return { marked };
  }

  stats() {
    const r = this.sql.exec("SELECT COUNT(*) AS total, COALESCE(SUM(qualified), 0) AS qualified FROM job_ads").one();
    return { total: Number(r.total), qualified: Number(r.qualified) };
  }

  /** Every saved ad, newest first, a page at a time. */
  list({ offset = 0, limit = 100, qualifiedOnly = false } = {}) {
    const where = qualifiedOnly ? "WHERE qualified = 1" : "";
    const rows = this.all(`SELECT * FROM job_ads ${where} ORDER BY first_at DESC, rowid DESC LIMIT ? OFFSET ?`, Math.min(500, Math.max(1, limit | 0)), Math.max(0, offset | 0));
    return { rows: rows.map(row), ...this.stats() };
  }

  /** The ads one run found (new or seen before), qualified first. */
  forRun(run) {
    return this.all("SELECT a.* FROM job_sightings s JOIN job_ads a ON a.url = s.url WHERE s.run = ? ORDER BY a.qualified DESC, a.company, a.role", run).map(row);
  }
}
