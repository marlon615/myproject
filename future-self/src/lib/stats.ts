import "server-only";
import { APP_TZ } from "@/lib/config";
import { ready } from "@/lib/db";

export type DayRow = { day: string; signups: number; chats: number; checkins: number; wins: number };

export type OwnerStats = {
  totalUsers: number;
  activeToday: number;
  signups: { today: number; week: number; month: number };
  chats: { today: number; total: number };
  checkins: { today: number; total: number };
  wins: { today: number; total: number };
  days: DayRow[];
};

const DAYS = 14;

function lastDays(n: number): string[] {
  const fmt = new Intl.DateTimeFormat("en-CA", { timeZone: APP_TZ, year: "numeric", month: "2-digit", day: "2-digit" });
  const today = new Date(`${fmt.format(new Date())}T00:00:00Z`);
  return Array.from({ length: n }, (_, i) => new Date(today.getTime() - (n - 1 - i) * 86400000).toISOString().slice(0, 10));
}

export async function ownerStats(): Promise<OwnerStats | null> {
  const db = await ready();
  if (!db) return null;
  const tz = APP_TZ;

  const [[u], events, signupDays, eventDays] = await Promise.all([
    db<{ total: number; today: number; week: number; month: number; active: number }[]>`
      select count(*)::int as total,
        count(*) filter (where (created_at at time zone ${tz})::date = (now() at time zone ${tz})::date)::int as today,
        count(*) filter (where created_at > now() - interval '7 days')::int as week,
        count(*) filter (where created_at > now() - interval '30 days')::int as month,
        count(*) filter (where (last_seen_at at time zone ${tz})::date = (now() at time zone ${tz})::date)::int as active
      from fs_users`,
    db<{ kind: string; total: number; today: number }[]>`
      select kind, count(*)::int as total,
        count(*) filter (where (created_at at time zone ${tz})::date = (now() at time zone ${tz})::date)::int as today
      from fs_events group by kind`,
    db<{ day: string; n: number }[]>`
      select to_char((created_at at time zone ${tz})::date, 'YYYY-MM-DD') as day, count(*)::int as n
      from fs_users where created_at > now() - interval '16 days' group by 1`,
    db<{ day: string; kind: string; n: number }[]>`
      select to_char((created_at at time zone ${tz})::date, 'YYYY-MM-DD') as day, kind, count(*)::int as n
      from fs_events where created_at > now() - interval '16 days' group by 1, 2`,
  ]);

  const k = (kind: string) => events.find((e) => e.kind === kind) ?? { total: 0, today: 0 };
  const sMap = new Map(signupDays.map((r) => [r.day, r.n]));
  const eMap = new Map(eventDays.map((r) => [`${r.day}|${r.kind}`, r.n]));

  return {
    totalUsers: u?.total ?? 0,
    activeToday: u?.active ?? 0,
    signups: { today: u?.today ?? 0, week: u?.week ?? 0, month: u?.month ?? 0 },
    chats: { today: k("chat").today, total: k("chat").total },
    checkins: { today: k("checkin").today, total: k("checkin").total },
    wins: { today: k("win").today, total: k("win").total },
    days: lastDays(DAYS).map((day) => ({
      day,
      signups: sMap.get(day) ?? 0,
      chats: eMap.get(`${day}|chat`) ?? 0,
      checkins: eMap.get(`${day}|checkin`) ?? 0,
      wins: eMap.get(`${day}|win`) ?? 0,
    })),
  };
}
