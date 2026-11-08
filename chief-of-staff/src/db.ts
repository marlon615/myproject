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
}
