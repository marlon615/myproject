import { PRODUCTS, type Env } from "./types";
import type { DashData } from "./views";

function localDay(d: Date, tz: string) {
  return new Intl.DateTimeFormat("en-CA", { timeZone: tz, year: "numeric", month: "2-digit", day: "2-digit" }).format(d);
}

export async function dashboard(env: Env): Promise<DashData> {
  const tz = env.APP_TIMEZONE || "America/Chicago";
  const since = new Date(Date.now() - 16 * 86400_000).toISOString();
  const [pending, sentTotal, recent, prospectRows, byProductRows, repliedRows, runs, last30] = await Promise.all([
    env.DB.prepare("select count(*) as n from drafts where status = 'pending'").first<{ n: number }>(),
    env.DB.prepare("select count(*) as n from drafts where status = 'sent'").first<{ n: number }>(),
    env.DB.prepare("select status, decided_at from drafts where decided_at >= ? and status in ('sent', 'rejected')").bind(since).all<{ status: string; decided_at: string }>(),
    env.DB.prepare("select status, count(*) as n from prospects group by status").all<{ status: string; n: number }>(),
    env.DB.prepare("select product, status, count(*) as n from drafts where status in ('sent', 'rejected') group by product, status").all<{ product: string; status: string; n: number }>(),
    env.DB.prepare("select product, count(*) as n from prospects where status = 'replied' group by product").all<{ product: string; n: number }>(),
    env.DB.prepare("select at, trigger, created, note from runs order by id desc limit 8").all<{ at: string; trigger: string; created: number; note: string | null }>(),
    env.DB.prepare("select status, count(*) as n from drafts where decided_at >= ? and status in ('sent', 'rejected') group by status").bind(new Date(Date.now() - 30 * 86400_000).toISOString()).all<{ status: string; n: number }>(),
  ]);

  const today = localDay(new Date(), tz);
  const todayDate = new Date(`${today}T12:00:00Z`);
  const days = Array.from({ length: 14 }, (_, i) => new Date(todayDate.getTime() - (13 - i) * 86400_000).toISOString().slice(0, 10)).map((day) => ({ day, sent: 0, rejected: 0 }));
  const byDay = new Map(days.map((d) => [d.day, d]));
  for (const r of recent.results) {
    const b = byDay.get(localDay(new Date(r.decided_at), tz));
    if (b) r.status === "sent" ? b.sent++ : b.rejected++;
  }
  const t = byDay.get(today)!;
  const yes30 = last30.results.find((r) => r.status === "sent")?.n ?? 0;
  const no30 = last30.results.find((r) => r.status === "rejected")?.n ?? 0;

  return {
    pending: pending?.n ?? 0,
    sentToday: t.sent,
    noToday: t.rejected,
    sentTotal: sentTotal?.n ?? 0,
    approval30: yes30 + no30 ? Math.round((yes30 / (yes30 + no30)) * 100) : null,
    prospects: Object.fromEntries(prospectRows.results.map((r) => [r.status, r.n])),
    byProduct: PRODUCTS.map((p) => ({
      product: p,
      sent: byProductRows.results.find((r) => r.product === p && r.status === "sent")?.n ?? 0,
      rejected: byProductRows.results.find((r) => r.product === p && r.status === "rejected")?.n ?? 0,
      replied: repliedRows.results.find((r) => r.product === p)?.n ?? 0,
    })),
    days,
    runs: runs.results,
    tz,
    ...(await extras(env, tz)),
  };
}


async function extras(env: Env, tz: string) {
  const gmail = await env.DB.prepare("select 1 from settings where key = 'secret:gmail'").first();
  const todo = await env.DB.prepare("select count(*) as n from todos where status = 'open'").first<{ n: number }>();
  const lastRow = await env.DB.prepare("select value from settings where key = 'agent:last_tick'").first<{ value: string }>();
  const lastTick = lastRow ? (JSON.parse(lastRow.value) as { at: string; note: string }) : null;
  if (!gmail) return { inbox: null, todosOpen: todo?.n ?? 0, lastTick };
  const [n, rp, sent] = await Promise.all([
    env.DB.prepare("select count(*) as n from inbox where status = 'new'").first<{ n: number }>(),
    env.DB.prepare("select count(*) as n from replies where status = 'pending'").first<{ n: number }>(),
    env.DB.prepare("select sent_at from replies where status = 'sent' and sent_at > ?").bind(new Date(Date.now() - 2 * 86400_000).toISOString()).all<{ sent_at: string }>(),
  ]);
  const today = localDay(new Date(), tz);
  return {
    inbox: { newCount: n?.n ?? 0, repliesPending: rp?.n ?? 0, repliesSentToday: sent.results.filter((r) => localDay(new Date(r.sent_at), tz) === today).length },
    todosOpen: todo?.n ?? 0,
    lastTick,
  };
}
