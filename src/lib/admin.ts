import "server-only";
import { and, count, desc, eq, gte, ilike, max, or, sql } from "drizzle-orm";
import { db, churches, visitors, messages, type Church } from "@/db";
import { planState, type PlanState } from "@/lib/billing";
import { PRICE_MONTHLY_USD } from "@/lib/config";

/** Time zone used for "per day" / "per week" buckets in the owner dashboard. */
export const OWNER_TZ = process.env.OWNER_TIMEZONE || "America/New_York";

// ───────────── Status grouping (for the filter + badges) ─────────────

export type StatusGroup = "trial" | "paying" | "past_due" | "canceling" | "canceled" | "expired";

export const STATUS_FILTERS = [
  { key: "all", label: "All" },
  { key: "trial", label: "Trial" },
  { key: "paying", label: "Paying" },
  { key: "canceled", label: "Canceled" },
  { key: "expired", label: "Trial ended" },
] as const;
export type StatusFilter = (typeof STATUS_FILTERS)[number]["key"];

export function statusGroup(c: Pick<Church, "subscriptionStatus" | "trialEndsAt" | "currentPeriodEnd">, plan: PlanState = planState(c)): StatusGroup {
  if (plan.kind === "trial") return "trial";
  if (plan.kind === "past_due") return "past_due";
  if (plan.kind === "active") return plan.cancelsAt ? "canceling" : "paying";
  return c.subscriptionStatus === "canceled" ? "canceled" : "expired";
}

/** Which filter chip a status group belongs to. Past-due counts as paying; canceling as canceled. */
export function matchesFilter(group: StatusGroup, filter: StatusFilter): boolean {
  if (filter === "all") return true;
  if (filter === "paying") return group === "paying" || group === "past_due";
  if (filter === "canceled") return group === "canceled" || group === "canceling";
  return group === filter;
}

export const STATUS_BADGE: Record<StatusGroup, { label: string; cls: string }> = {
  trial: { label: "Trial", cls: "badge-scheduled" },
  paying: { label: "Paying", cls: "badge-sent" },
  past_due: { label: "Past due", cls: "badge-failed" },
  canceling: { label: "Canceling", cls: "badge-skipped" },
  canceled: { label: "Canceled", cls: "badge-skipped" },
  expired: { label: "Trial ended", cls: "badge-skipped" },
};

// ───────────── Date helpers (owner time zone) ─────────────

const dayFmt = new Intl.DateTimeFormat("en-CA", { timeZone: OWNER_TZ, year: "numeric", month: "2-digit", day: "2-digit" });
/** YYYY-MM-DD of an instant, in the owner's time zone. */
export const localDay = (d: Date) => dayFmt.format(d);

/** The last `n` local days, oldest first, as YYYY-MM-DD. */
function lastDays(n: number): string[] {
  const today = new Date(`${localDay(new Date())}T00:00:00Z`);
  return Array.from({ length: n }, (_, i) => new Date(today.getTime() - (n - 1 - i) * 86400000).toISOString().slice(0, 10));
}

/** Mondays of the last `n` local weeks, oldest first, as YYYY-MM-DD. */
function lastWeeks(n: number): string[] {
  const today = new Date(`${localDay(new Date())}T00:00:00Z`);
  const monday = new Date(today.getTime() - ((today.getUTCDay() + 6) % 7) * 86400000);
  return Array.from({ length: n }, (_, i) => new Date(monday.getTime() - (n - 1 - i) * 7 * 86400000).toISOString().slice(0, 10));
}

const localDayExpr = (col: unknown) => sql<string>`to_char((${col} at time zone ${OWNER_TZ})::date, 'YYYY-MM-DD')`;

// ───────────── Overview ─────────────

export async function overviewData() {
  const now = new Date();
  const days = lastDays(30);
  const weeks = lastWeeks(12);
  const since = new Date(now.getTime() - 32 * 86400000);
  const weeksSince = new Date(now.getTime() - (12 * 7 + 7) * 86400000);

  const [allChurches, visitorDays, textDays, weekly, failed, [{ failed30 }], visitorTotals] = await Promise.all([
    db.select().from(churches),
    db.select({ day: localDayExpr(visitors.createdAt), n: count() }).from(visitors)
      .where(gte(visitors.createdAt, since)).groupBy(sql`1`),
    db.select({ day: localDayExpr(messages.sentAt), n: count() }).from(messages)
      .where(and(eq(messages.direction, "outbound"), eq(messages.status, "sent"), gte(messages.sentAt, since))).groupBy(sql`1`),
    db.select({
      week: sql<string>`to_char(date_trunc('week', ${churches.createdAt} at time zone ${OWNER_TZ}), 'YYYY-MM-DD')`,
      n: count(),
    }).from(churches).where(gte(churches.createdAt, weeksSince)).groupBy(sql`1`),
    failedTexts(5),
    db.select({ failed30: count() }).from(messages)
      .where(and(eq(messages.status, "failed"), gte(messages.scheduledFor, new Date(now.getTime() - 30 * 86400000)))),
    db.select({ churchId: visitors.churchId, n: count() }).from(visitors).groupBy(visitors.churchId),
  ]);

  const vByChurch = new Map(visitorTotals.map((v) => [v.churchId, v.n]));
  const withPlan = allChurches.map((c) => {
    const plan = planState(c, now);
    return { c, plan, group: statusGroup(c, plan) };
  });
  const paying = withPlan.filter((x) => x.group === "paying").length;
  const pastDue = withPlan.filter((x) => x.group === "past_due").length;
  const canceling = withPlan.filter((x) => x.group === "canceling").length;
  const trials = withPlan.filter((x) => x.group === "trial").length;
  const soon = now.getTime() + 3 * 86400000;
  const trialsEnding = withPlan
    .filter((x) => x.plan.kind === "trial" && x.plan.endsAt.getTime() <= soon)
    .map((x) => ({ church: x.c, endsAt: (x.plan as Extract<PlanState, { kind: "trial" }>).endsAt, visitors: vByChurch.get(x.c.id) ?? 0 }))
    .sort((a, b) => a.endsAt.getTime() - b.endsAt.getTime());

  const vMap = new Map(visitorDays.map((r) => [r.day, r.n]));
  const tMap = new Map(textDays.map((r) => [r.day, r.n]));
  const wMap = new Map(weekly.map((r) => [r.week, r.n]));

  return {
    revenue: {
      mrr: paying * PRICE_MONTHLY_USD,
      paying,
      pastDue,
      canceling,
      trials,
      totalChurches: allChurches.length,
    },
    trialsEnding,
    daily: days.map((day) => ({ day, visitors: vMap.get(day) ?? 0, texts: tMap.get(day) ?? 0 })),
    weekly: weeks.map((week) => ({ week, churches: wMap.get(week) ?? 0 })),
    failed,
    failed30,
  };
}

// ───────────── Failed texts ─────────────

export function failedTexts(limit: number) {
  return db
    .select({
      id: messages.id, kind: messages.kind, error: messages.error, at: messages.scheduledFor,
      churchId: churches.id, churchName: churches.name, guest: visitors.firstName, phone: visitors.phone,
    })
    .from(messages)
    .innerJoin(churches, eq(churches.id, messages.churchId))
    .innerJoin(visitors, eq(visitors.id, messages.visitorId))
    .where(eq(messages.status, "failed"))
    .orderBy(desc(messages.scheduledFor))
    .limit(limit);
}

/** Failed texts grouped by reason, most common first: shows at a glance whether it's one systemic problem. */
export function failureReasons(sinceDays = 30) {
  return db
    .select({ reason: sql<string>`coalesce(${messages.error}, 'No reason given')`, n: count() })
    .from(messages)
    .where(and(eq(messages.status, "failed"), gte(messages.scheduledFor, new Date(Date.now() - sinceDays * 86400000))))
    .groupBy(sql`1`)
    .orderBy(desc(count()));
}

// ───────────── Churches list ─────────────

export async function churchList(q: string, filter: StatusFilter) {
  const term = q.trim().slice(0, 100);
  const like = `%${term.replace(/[\\%_]/g, (m) => "\\" + m)}%`;
  const where = term
    ? or(ilike(churches.name, like), ilike(churches.pastorName, like), ilike(churches.email, like), ilike(churches.city, like), ilike(churches.slug, like))
    : undefined;

  const [rows, vStats, tStats, rStats] = await Promise.all([
    db.select().from(churches).where(where).orderBy(desc(churches.createdAt)),
    db.select({ churchId: visitors.churchId, n: count(), last: max(visitors.createdAt) }).from(visitors).groupBy(visitors.churchId),
    db.select({ churchId: messages.churchId, n: count(), last: max(messages.sentAt) }).from(messages)
      .where(and(eq(messages.direction, "outbound"), eq(messages.status, "sent"))).groupBy(messages.churchId),
    db.select({ churchId: messages.churchId, last: max(messages.createdAt) }).from(messages)
      .where(eq(messages.direction, "inbound")).groupBy(messages.churchId),
  ]);
  const rMap = new Map(rStats.map((r) => [r.churchId, r.last]));
  const vMap = new Map(vStats.map((v) => [v.churchId, v]));
  const tMap = new Map(tStats.map((t) => [t.churchId, t]));

  const all = rows.map((c) => {
    const plan = planState(c);
    const v = vMap.get(c.id);
    return {
      church: c,
      plan,
      group: statusGroup(c, plan),
      visitors: v?.n ?? 0,
      texts: tMap.get(c.id)?.n ?? 0,
      lastActivity: latest(c.lastSeenAt, v?.last ?? null, tMap.get(c.id)?.last ?? null, rMap.get(c.id) ?? null, c.createdAt),
    };
  });
  const counts = Object.fromEntries(STATUS_FILTERS.map((f) => [f.key, all.filter((r) => matchesFilter(r.group, f.key)).length])) as Record<StatusFilter, number>;
  return { rows: all.filter((r) => matchesFilter(r.group, filter)), counts };
}

// ───────────── Church detail ─────────────

export async function churchDetail(id: string) {
  const [church] = await db.select().from(churches).where(eq(churches.id, id)).limit(1);
  if (!church) return null;
  const monthStart = new Date(Date.now() - 30 * 86400000);

  const [[v], [vMonth], msgStats, [lastMsg], recentGuests, failed] = await Promise.all([
    db.select({ n: count(), returned: sql<number>`count(${visitors.returnedAt})`.mapWith(Number), optedOut: sql<number>`count(*) filter (where ${visitors.optedOut})`.mapWith(Number), last: max(visitors.createdAt) })
      .from(visitors).where(eq(visitors.churchId, id)),
    db.select({ n: count() }).from(visitors).where(and(eq(visitors.churchId, id), gte(visitors.createdAt, monthStart))),
    db.select({ status: messages.status, kind: messages.kind, n: count() }).from(messages).where(eq(messages.churchId, id)).groupBy(messages.status, messages.kind),
    db.select({ at: max(sql`case when ${messages.direction} = 'inbound' then ${messages.createdAt} else ${messages.sentAt} end`) }).from(messages)
      .where(and(eq(messages.churchId, id), or(eq(messages.status, "sent"), eq(messages.status, "received")))),
    db.select().from(visitors).where(eq(visitors.churchId, id)).orderBy(desc(visitors.createdAt)).limit(8),
    db.select({ id: messages.id, kind: messages.kind, error: messages.error, at: messages.scheduledFor, guest: visitors.firstName })
      .from(messages).innerJoin(visitors, eq(visitors.id, messages.visitorId))
      .where(and(eq(messages.churchId, id), eq(messages.status, "failed"))).orderBy(desc(messages.scheduledFor)).limit(10),
  ]);

  const sum = (pred: (r: (typeof msgStats)[number]) => boolean) => msgStats.filter(pred).reduce((a, r) => a + r.n, 0);
  const plan = planState(church);
  const lastText = lastMsg?.at ? new Date(lastMsg.at as string) : null;

  return {
    church,
    plan,
    group: statusGroup(church, plan),
    stats: {
      visitors: v?.n ?? 0,
      visitors30: vMonth?.n ?? 0,
      returned: v?.returned ?? 0,
      optedOut: v?.optedOut ?? 0,
      textsSent: sum((r) => r.status === "sent"),
      replies: sum((r) => r.kind === "reply"),
      failed: sum((r) => r.status === "failed"),
      scheduled: sum((r) => r.status === "scheduled"),
    },
    activity: {
      pastorSeen: church.lastSeenAt,
      lastGuest: v?.last ?? null,
      lastText,
      last: latest(church.lastSeenAt, v?.last ?? null, lastText, church.createdAt),
    },
    recentGuests,
    failed,
  };
}

function latest(...dates: (Date | string | null | undefined)[]): Date {
  return new Date(Math.min(Date.now(), Math.max(...dates.filter(Boolean).map((d) => new Date(d as Date).getTime()))));
}

export function timeAgo(d: Date | string | null | undefined): string {
  if (!d) return "never";
  const s = Math.max(0, (Date.now() - new Date(d).getTime()) / 1000);
  if (s < 90) return "just now";
  if (s < 3600) return `${Math.round(s / 60)} min ago`;
  if (s < 86400) return `${Math.round(s / 3600)} h ago`;
  const days = Math.round(s / 86400);
  if (days < 45) return `${days} day${days === 1 ? "" : "s"} ago`;
  return new Date(d).toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric" });
}
