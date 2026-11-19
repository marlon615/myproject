/**
 * The permanent memory of every idea the Night Agent has ever reported (in any morning report, real or test), in the
 * same SQLite database as the job ads. Rows are only ever inserted or updated: nothing is deleted, so an idea that was
 * sent once is never sent as new again.
 *
 *   ideas_sent   one row per idea: its title, the run and date it was first reported, the links of every proof shown
 *                for it, and how many times it was updated with new proof
 *   ideas_meta   small flags (e.g. "seeded": the ideas from reports sent before this memory existed were loaded in)
 */
const SCHEMA = [
  `CREATE TABLE IF NOT EXISTS ideas_sent (key TEXT PRIMARY KEY, title TEXT NOT NULL, first_run TEXT NOT NULL, first_date TEXT NOT NULL,
    sources TEXT NOT NULL DEFAULT '[]', updates INTEGER NOT NULL DEFAULT 0, last_update TEXT)`,
  `CREATE TABLE IF NOT EXISTS ideas_meta (k TEXT PRIMARY KEY, v TEXT NOT NULL)`,
];
export const ideaKey = (title) => String(title || "").toLowerCase().replace(/[^a-z0-9]+/g, " ").trim().slice(0, 200);
const urls = (list) => [...new Set((list || []).map((u) => String(u || "").slice(0, 600)).filter((u) => /^https:\/\//.test(u)))];
const row = (r) => ({ key: r.key, title: r.title, firstRun: r.first_run, firstDate: r.first_date, sources: JSON.parse(r.sources || "[]"), updates: Number(r.updates), lastUpdate: r.last_update || null });

export class IdeasStore {
  constructor(sql, transactionSync = (fn) => fn()) {
    this.sql = sql; this.tx = transactionSync;
    for (const s of SCHEMA) this.sql.exec(s);
  }
  all(q, ...b) { return this.sql.exec(q, ...b).toArray(); }

  /** Remembers ideas as sent: [{ title, sources: [url], run, date }]. An idea already remembered keeps its first date. */
  record(ideas) {
    let added = 0;
    this.tx(() => {
      for (const i of ideas || []) {
        const key = ideaKey(i.title), date = String(i.date || "").slice(0, 10);
        if (!key || !/^\d{4}-\d{2}-\d{2}$/.test(date)) continue;
        const old = this.all("SELECT sources FROM ideas_sent WHERE key = ?", key)[0];
        if (!old) { this.sql.exec("INSERT INTO ideas_sent (key, title, first_run, first_date, sources) VALUES (?, ?, ?, ?, ?)", key, String(i.title).slice(0, 200), String(i.run || "").slice(0, 40), date, JSON.stringify(urls(i.sources).slice(0, 300))); added++; }
        else this.sql.exec("UPDATE ideas_sent SET sources = ? WHERE key = ?", JSON.stringify(urls([...JSON.parse(old.sources || "[]"), ...urls(i.sources)]).slice(0, 300)), key);
      }
    });
    return { added };
  }

  /** New proof for ideas already sent: [{ key, sources: [url], date }]. */
  update(items) {
    let updated = 0;
    this.tx(() => {
      for (const i of items || []) {
        const old = this.all("SELECT sources FROM ideas_sent WHERE key = ?", String(i.key || ""))[0];
        if (!old) continue;
        this.sql.exec("UPDATE ideas_sent SET sources = ?, updates = updates + 1, last_update = ? WHERE key = ?",
          JSON.stringify(urls([...JSON.parse(old.sources || "[]"), ...urls(i.sources)]).slice(0, 300)), String(i.date || "").slice(0, 10), String(i.key));
        updated++;
      }
    });
    return { updated };
  }

  /** Every idea ever sent, oldest first. */
  list() { return this.all("SELECT * FROM ideas_sent ORDER BY first_date, rowid").map(row); }
  count() { return Number(this.sql.exec("SELECT COUNT(*) AS n FROM ideas_sent").one().n); }
  getFlag(k) { return this.all("SELECT v FROM ideas_meta WHERE k = ?", k)[0]?.v ?? null; }
  setFlag(k, v) { this.sql.exec("INSERT INTO ideas_meta (k, v) VALUES (?, ?) ON CONFLICT(k) DO UPDATE SET v = excluded.v", k, String(v)); }
}
