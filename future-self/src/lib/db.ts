import "server-only";
import postgres from "postgres";

type Sql = ReturnType<typeof postgres>;

const g = globalThis as unknown as { __fsSql?: Sql; __fsReady?: Promise<void> };

/** The shared Postgres client, or null when DATABASE_URL isn't set (the app still works, just without stats). */
export function sql(): Sql | null {
  const url = process.env.DATABASE_URL;
  if (!url) return null;
  if (!g.__fsSql) {
    g.__fsSql = postgres(url, { max: 5, idle_timeout: 20, prepare: false, onnotice: () => {} });
  }
  return g.__fsSql;
}

/** Creates the two tables on first use. Only anonymous ids and counts are stored: never goals, chats or wins. */
export async function ready(): Promise<Sql | null> {
  const db = sql();
  if (!db) return null;
  if (!g.__fsReady) {
    g.__fsReady = (async () => {
      await db`
        create table if not exists fs_users (
          id uuid primary key,
          created_at timestamptz not null default now(),
          last_seen_at timestamptz not null default now()
        )`;
      await db`
        create table if not exists fs_events (
          id bigserial primary key,
          user_id uuid not null references fs_users(id) on delete cascade,
          kind text not null check (kind in ('chat', 'checkin', 'win')),
          created_at timestamptz not null default now()
        )`;
      await db`create index if not exists fs_events_kind_time on fs_events (kind, created_at)`;
      await db`create index if not exists fs_events_user_time on fs_events (user_id, created_at)`;
    })().catch((e) => {
      g.__fsReady = undefined;
      throw e;
    });
  }
  await g.__fsReady;
  return db;
}

export type EventKind = "chat" | "checkin" | "win";

/** Records that something happened. Never throws: stats must not break the app. */
export async function track(userId: string, kind: EventKind) {
  try {
    const db = await ready();
    if (!db) return;
    await db`insert into fs_users (id) values (${userId}) on conflict (id) do update set last_seen_at = now()`;
    await db`insert into fs_events (user_id, kind) values (${userId}, ${kind})`;
  } catch (e) {
    console.error("[future-self] could not record event:", (e as Error).message);
  }
}
