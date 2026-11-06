import { drizzle, type PostgresJsDatabase } from "drizzle-orm/postgres-js";
import postgres from "postgres";
import * as schema from "./schema";

type DB = PostgresJsDatabase<typeof schema>;

declare global {
  // eslint-disable-next-line no-var
  var __cfDb: DB | undefined;
}

function getDb(): DB {
  if (!globalThis.__cfDb) {
    const url = process.env.DATABASE_URL;
    if (!url) throw new Error("DATABASE_URL is not set. See .env.example.");
    // prepare:false keeps us compatible with pooled connections (Neon, Supabase, PgBouncer).
    const client = postgres(url, { prepare: false, max: 5 });
    globalThis.__cfDb = drizzle({ client, schema });
  }
  return globalThis.__cfDb;
}

/** Lazily-connected database, so builds without DATABASE_URL don't crash at import time. */
export const db: DB = new Proxy({} as DB, {
  get(_target, prop) {
    const real = getDb();
    const value = Reflect.get(real, prop, real);
    return typeof value === "function" ? value.bind(real) : value;
  },
});

export * from "./schema";
