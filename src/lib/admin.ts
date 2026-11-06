import "server-only";
import { and, count, desc, eq, gte, ilike, max, or, sql, sum, type SQL } from "drizzle-orm";
import { db, contractors, calls, texts, bookings, payments, conversations, type Contractor } from "@/db";
import { planState, type PlanState } from "@/lib/billing";
import { PRICE_MONTHLY_USD } from "@/lib/config";
import { APP_TZ } from "@/lib/utils";

/** Time zone used for "per day" / "per week" buckets in the owner dashboard. */
export const OWNER_TZ = APP_TZ;
export const PAGE_SIZE = 50;

// ───────────── Status grouping ─────────────

export type StatusGroup = "trial" | "paying" | "past_due" | "canceling" | "canceled" | "expired";

export const STATUS_FILTERS = [
  { key: "all", label: "All" },
  { key: "trial", label: "Pilot" },
  { key: "paying", label: "Paying" },
  { key: "canceled", label: "Canceled" },
  { key: "expired", label: "Pilot ended" },
] as const;
export type StatusFilter = (typeof STATUS_FILTERS)[number]["key"];

export function statusGroup(c: Pick<Contractor, "subscriptionStatus" | "trialEndsAt" | "currentPeriodEnd">, plan: PlanState = planState(c)): StatusGroup {
  if (plan.kind === "trial") return "trial";
  if (plan.kind === "past_due") return "past_due";
  if (plan.kind === "active") return plan.cancelsAt ? "canceling" : "paying";
  return c.subscriptionStatus === "canceled" ? "canceled" : "expired";
}

export function matchesFilter(group: StatusGroup, filter: StatusFilter): boolean {
  if (filter === "all") return true;
  if (filter === "paying") return group === "paying" || group === "past_due";
  if (filter === "canceled") return group === "canceled" || group === "canceling";
  return group === filter;
}

export const STATUS_BADGE: Record<StatusGroup, { label: string; cls: string }> = {
  trial: { label: "Pilot", cls: "badge-scheduled" },
  paying: { label: "Paying", cls: "badge-sent" },
  past_due: { label: "Past due", cls: "badge-failed" },
  canceling: { label: "Canceling", cls: "badge-skipped" },
  canceled: { label: "Canceled", cls: "badge-skipped" },
  expired: { label: "Pilot ended", cls: "badge-skipped" },
};

// ───────────── Date helpers ─────────────

const dayFmt = new Intl.DateTimeFormat("en-CA", { timeZone: OWNER_TZ, year: "numeric", month: "2-digit", day: "2-digit" });
export const localDay = (d: Date) => dayFmt.format(d);

function lastDays(n: number): string[] {
  const today = new Date(`${localDay(new Date())}T00:00:00Z`);
  return Array.from({ length: n }, (_, i) => new Date(today.getTime() - (n - 1 - i) * 86400000).toISOString().slice(0, 10));
}

function lastWeeks(n: number): string[] {
  const today = new Date(`${localDay(new Date())}T00:00:00Z`);
  const monday = new Date(today.getTime() - ((today.getUTCDay() + 6) % 7) * 86400000);
  return Array.from({ length: n }, (_, i) => new Date(monday.getTime() - (n - 1 - i) * 7 * 86400000).toISOString().slice(0, 10));
}

const localDayExpr = (col: unknown) => sql<string>`to_char((${col} at time zone ${OWNER_TZ})::date, 'YYYY-MM-DD')`;
const centsSum = (where?: SQL) =>
  db.select({ n: sql<number>`coalesce(${sum(payments.amountCents)}, 0)`.mapWith(Number) }).from(payments).where(where);

export const usd = (cents: number) =>
  (cents / 100).toLocaleString("en-US", { style: "currency", currency: "USD", minimumFractionDigits: cents % 100 ? 2 : 0 });

// ───────────── Overview ─────────────

export async function overviewData() {
  const now = new Date();
  const days = lastDays(30);
  const weeks = lastWeeks(12);
  const since = new Date(now.getTime() - 32 * 86400000);
  const d30 = new Date(now.getTime() - 30 * 86400000);
  const weeksSince = new Date(now.getTime() - (12 * 7 + 7) * 86400000);
  const collected = or(eq(payments.status, "completed"), eq(payments.status, "refunded"), eq(payments.status, "reversed"));

  const [
    all, callDays, textDays, bookingDays, weekly,
    [calls30], [texts30], [bookings30], [emerg30], [allTime], [last30], recentPayments, recentSignups,
  ] = await Promise.all([
    db.select().from(contractors),
    db.select({ day: localDayExpr(calls.startedAt), n: count() }).from(calls).where(gte(calls.startedAt, since)).groupBy(sql`1`),
    db.select({ day: localDayExpr(texts.createdAt), n: count() }).from(texts).where(gte(texts.createdAt, since)).groupBy(sql`1`),
    db.select({ day: localDayExpr(bookings.createdAt), n: count() }).from(bookings).where(gte(bookings.createdAt, since)).groupBy(sql`1`),
    db.select({ week: sql<string>`to_char(date_trunc('week', ${contractors.createdAt} at time zone ${OWNER_TZ}), 'YYYY-MM-DD')`, n: count() })
      .from(contractors).where(gte(contractors.createdAt, weeksSince)).groupBy(sql`1`),
    db.select({ n: count() }).from(calls).where(gte(calls.startedAt, d30)),
    db.select({ n: count() }).from(texts).where(gte(texts.createdAt, d30)),
    db.select({ n: count() }).from(bookings).where(gte(bookings.createdAt, d30)),
    db.select({ n: count() }).from(bookings).where(and(gte(bookings.createdAt, d30), eq(bookings.urgency, "emergency"))),
    centsSum(collected),
    centsSum(and(collected, gte(payments.occurredAt, d30))),
    paymentList(1).then((r) => r.rows.slice(0, 5)),
    db.select().from(contractors).orderBy(desc(contractors.createdAt)).limit(5),
  ]);

  const groups = all.map((c) => statusGroup(c, planState(c, now)));
  const paying = groups.filter((g) => g === "paying").length;
  const soon = now.getTime() + 3 * 86400000;
  const pilotsEnding = all
    .filter((c) => { const p = planState(c, now); return p.kind === "trial" && p.endsAt.getTime() <= soon; })
    .sort((a, b) => new Date(a.trialEndsAt).getTime() - new Date(b.trialEndsAt).getTime());

  const map = (rows: { day: string; n: number }[]) => new Map(rows.map((r) => [r.day, r.n]));
  const cMap = map(callDays), tMap = map(textDays), bMap = map(bookingDays);
  const wMap = new Map(weekly.map((r) => [r.week, r.n]));

  return {
    revenue: {
      mrr: paying * PRICE_MONTHLY_USD,
      paying,
      pastDue: groups.filter((g) => g === "past_due").length,
      canceling: groups.filter((g) => g === "canceling").length,
      trials: groups.filter((g) => g === "trial").length,
      totalSignups: all.length,
      collectedAllTime: allTime.n,
      collected30: last30.n,
    },
    totals30: { calls: calls30.n, texts: texts30.n, bookings: bookings30.n, emergencies: emerg30.n },
    pilotsEnding,
    daily: days.map((day) => ({ day, calls: cMap.get(day) ?? 0, texts: tMap.get(day) ?? 0, bookings: bMap.get(day) ?? 0 })),
    weekly: weeks.map((week) => ({ week, signups: wMap.get(week) ?? 0 })),
    recentPayments,
    recentSignups,
  };
}

// ───────────── Lists (every signup, call, text, booking, payment) ─────────────

const pageOf = (page: number) => ({ limit: PAGE_SIZE, offset: (Math.max(1, page) - 1) * PAGE_SIZE });
const likeTerm = (q: string) => `%${q.trim().slice(0, 100).replace(/[\\%_]/g, (m) => "\\" + m)}%`;
const biz = { contractorId: contractors.id, businessName: contractors.businessName };

export async function signupList(q: string, filter: StatusFilter) {
  const where = q.trim()
    ? or(ilike(contractors.businessName, likeTerm(q)), ilike(contractors.ownerName, likeTerm(q)), ilike(contractors.email, likeTerm(q)), ilike(contractors.serviceArea, likeTerm(q)), ilike(contractors.businessPhone, likeTerm(q)))
    : undefined;
  const [rows, callStats, bookingStats] = await Promise.all([
    db.select().from(contractors).where(where).orderBy(desc(contractors.createdAt)),
    db.select({ id: calls.contractorId, n: count(), last: max(calls.startedAt) }).from(calls).groupBy(calls.contractorId),
    db.select({ id: bookings.contractorId, n: count() }).from(bookings).groupBy(bookings.contractorId),
  ]);
  const cMap = new Map(callStats.map((r) => [r.id, r]));
  const bMap = new Map(bookingStats.map((r) => [r.id, r.n]));
  const all = rows.map((c) => {
    const plan = planState(c);
    return { c, plan, group: statusGroup(c, plan), calls: cMap.get(c.id)?.n ?? 0, lastCall: cMap.get(c.id)?.last ?? null, bookings: bMap.get(c.id) ?? 0 };
  });
  const counts = Object.fromEntries(STATUS_FILTERS.map((f) => [f.key, all.filter((r) => matchesFilter(r.group, f.key)).length])) as Record<StatusFilter, number>;
  return { rows: all.filter((r) => matchesFilter(r.group, filter)), counts };
}

export async function callList(page: number, contractorId?: string) {
  const where = contractorId ? eq(calls.contractorId, contractorId) : undefined;
  const [rows, [{ n }]] = await Promise.all([
    db.select({ call: calls, ...biz, urgency: conversations.urgency, issue: conversations.issue, customerName: conversations.customerName })
      .from(calls).innerJoin(contractors, eq(contractors.id, calls.contractorId))
      .leftJoin(conversations, eq(conversations.id, calls.conversationId))
      .where(where).orderBy(desc(calls.startedAt)).limit(pageOf(page).limit).offset(pageOf(page).offset),
    db.select({ n: count() }).from(calls).where(where),
  ]);
  return { rows, total: n };
}

export async function textList(page: number, contractorId?: string) {
  const where = contractorId ? eq(texts.contractorId, contractorId) : undefined;
  const [rows, [{ n }]] = await Promise.all([
    db.select({ text: texts, ...biz }).from(texts).innerJoin(contractors, eq(contractors.id, texts.contractorId))
      .where(where).orderBy(desc(texts.createdAt)).limit(pageOf(page).limit).offset(pageOf(page).offset),
    db.select({ n: count() }).from(texts).where(where),
  ]);
  return { rows, total: n };
}

export async function bookingList(page: number, contractorId?: string) {
  const where = contractorId ? eq(bookings.contractorId, contractorId) : undefined;
  const [rows, [{ n }]] = await Promise.all([
    db.select({ booking: bookings, ...biz, timezone: contractors.timezone }).from(bookings).innerJoin(contractors, eq(contractors.id, bookings.contractorId))
      .where(where).orderBy(desc(bookings.createdAt)).limit(pageOf(page).limit).offset(pageOf(page).offset),
    db.select({ n: count() }).from(bookings).where(where),
  ]);
  return { rows, total: n };
}

export async function paymentList(page: number, contractorId?: string) {
  const where = contractorId ? eq(payments.contractorId, contractorId) : undefined;
  const [rows, [{ n }]] = await Promise.all([
    db.select({ payment: payments, businessName: contractors.businessName, contractorId: contractors.id })
      .from(payments).leftJoin(contractors, eq(contractors.id, payments.contractorId))
      .where(where).orderBy(desc(payments.occurredAt)).limit(pageOf(page).limit).offset(pageOf(page).offset),
    db.select({ n: count() }).from(payments).where(where),
  ]);
  return { rows, total: n };
}

export async function signupDetail(id: string) {
  const [c] = await db.select().from(contractors).where(eq(contractors.id, id)).limit(1);
  if (!c) return null;
  const [[callN], [textN], [bookN], [paid], recentCalls, recentBookings, recentPayments] = await Promise.all([
    db.select({ n: count() }).from(calls).where(eq(calls.contractorId, id)),
    db.select({ n: count() }).from(texts).where(eq(texts.contractorId, id)),
    db.select({ n: count() }).from(bookings).where(eq(bookings.contractorId, id)),
    centsSum(and(eq(payments.contractorId, id), or(eq(payments.status, "completed"), eq(payments.status, "refunded"), eq(payments.status, "reversed")))),
    callList(1, id).then((r) => r.rows.slice(0, 8)),
    bookingList(1, id).then((r) => r.rows.slice(0, 8)),
    paymentList(1, id).then((r) => r.rows.slice(0, 8)),
  ]);
  const plan = planState(c);
  return { c, plan, group: statusGroup(c, plan), stats: { calls: callN.n, texts: textN.n, bookings: bookN.n, paidCents: paid.n }, recentCalls, recentBookings, recentPayments };
}

export function timeAgo(d: Date | string | null | undefined): string {
  if (!d) return "never";
  const s = Math.max(0, (Date.now() - new Date(d).getTime()) / 1000);
  if (s < 90) return "just now";
  if (s < 3600) return `${Math.round(s / 60)} min ago`;
  if (s < 86400) return `${Math.round(s / 3600)} h ago`;
  const days = Math.round(s / 86400);
  if (days < 45) return `${days} day${days === 1 ? "" : "s"} ago`;
  return new Date(d).toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric", timeZone: APP_TZ });
}

export { OUTCOME_LABEL } from "@/lib/outcomes";
