/**
 * A tiny database layer over the Durable Object's built-in SQLite storage.
 * It mirrors the small part of Cloudflare D1's API this app uses (prepare/bind/all/first/run/batch).
 */

export interface RunResult { meta: { changes: number } }
export interface Stmt {
  bind(...values: unknown[]): Stmt;
  all<T = Record<string, unknown>>(): Promise<{ results: T[] }>;
  first<T = Record<string, unknown>>(): Promise<T | null>;
  run(): Promise<RunResult>;
  /** internal */ exec(): RunResult;
}
export interface DB {
  prepare(query: string): Stmt;
  batch(stmts: Stmt[]): Promise<RunResult[]>;
}

type Bindable = string | number | null | ArrayBuffer;

function toBindable(v: unknown): Bindable {
  if (v === undefined || v === null) return null;
  if (typeof v === "boolean") return v ? 1 : 0;
  if (typeof v === "number" || typeof v === "string" || v instanceof ArrayBuffer) return v;
  return String(v);
}

export function sqliteDB(storage: DurableObjectStorage): DB {
  const sql = storage.sql;
  const make = (query: string, values: Bindable[]): Stmt => ({
    bind: (...v: unknown[]) => make(query, v.map(toBindable)),
    all: async <T>() => ({ results: sql.exec(query, ...values).toArray() as T[] }),
    first: async <T>() => (sql.exec(query, ...values).toArray()[0] as T | undefined) ?? null,
    run: async () => run(query, values),
    exec: () => run(query, values),
  });
  const run = (query: string, values: Bindable[]): RunResult => {
    sql.exec(query, ...values).toArray();
    const row = sql.exec("select changes() as c").toArray()[0] as { c: number } | undefined;
    return { meta: { changes: Number(row?.c ?? 0) } };
  };
  return {
    prepare: (q) => make(q, []),
    batch: async (stmts) => storage.transactionSync(() => stmts.map((s) => s.exec())),
  };
}

/** Runs the schema file's statements. Safe to repeat (everything is "if not exists"). */
export function migrate(storage: DurableObjectStorage, schema: string) {
  const statements = schema
    .split("\n")
    .filter((l) => !l.trim().startsWith("--"))
    .join("\n")
    .split(";")
    .map((s) => s.trim())
    .filter(Boolean);
  for (const s of statements) storage.sql.exec(s);
  // Columns added after the first release. "duplicate column" just means it's already there.
  for (const alter of [
    "alter table todos add column due_at text",
    "alter table todos add column notified_at text",
    "alter table todos add column spoken_at text",
  ]) {
    try { storage.sql.exec(alter); } catch {}
  }
  // Approvals used to allow only two kinds; rebuild the table without that limit (keeps every row).
  const def = storage.sql.exec("select sql from sqlite_master where type = 'table' and name = 'approvals'").toArray()[0] as { sql?: string } | undefined;
  if (def?.sql?.includes("check (kind in")) {
    storage.transactionSync(() => {
      storage.sql.exec(`create table approvals_new (
        id integer primary key autoincrement, token_hash text not null unique, kind text not null, ref text not null,
        title text not null default '', created_at text not null default (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
        expires_at text not null, used_at text)`);
      storage.sql.exec("insert into approvals_new select id, token_hash, kind, ref, title, created_at, expires_at, used_at from approvals");
      storage.sql.exec("drop table approvals");
      storage.sql.exec("alter table approvals_new rename to approvals");
    });
  }
}
