import "server-only";
import { and, eq, gt, lt } from "drizzle-orm";
import { db, bookings, type Contractor, type Slot } from "@/db";
import { zonedParts, zonedTime } from "@/lib/utils";

/** Earliest a routine window may start, so the tech has time to get there. */
const LEAD_MINUTES = 90;
const LOOKAHEAD_DAYS = 21;

export type TimePref = "morning" | "afternoon" | "any";

export function workDays(c: Pick<Contractor, "workDays">): Set<number> {
  return new Set(c.workDays.split(",").map((d) => Number(d.trim())).filter((d) => d >= 0 && d <= 6));
}

/** Is the business open right now (its own time zone)? */
export function isOpenNow(c: Contractor, now = new Date()): boolean {
  const p = zonedParts(now, c.timezone);
  const h = p.hour + p.minute / 60;
  return workDays(c).has(p.weekday) && h >= c.hoursStart && h < c.hoursEnd;
}

/** All arrival windows in business hours from `from` onward (before capacity is checked). */
function* candidateWindows(c: Contractor, from: Date): Generator<Slot> {
  const days = workDays(c);
  const len = Math.max(30, c.slotMinutes) * 60000;
  const start = zonedParts(from, c.timezone);
  for (let i = 0; i < LOOKAHEAD_DAYS; i++) {
    // Noon local avoids DST edge cases when stepping through days.
    const noon = zonedTime(start.year, start.month, start.day, 12, 0, c.timezone);
    const dayAt = zonedParts(new Date(noon.getTime() + i * 86400000), c.timezone);
    if (!days.has(dayAt.weekday)) continue;
    let t = zonedTime(dayAt.year, dayAt.month, dayAt.day, c.hoursStart, 0, c.timezone).getTime();
    const close = zonedTime(dayAt.year, dayAt.month, dayAt.day, Math.min(c.hoursEnd, 24), 0, c.timezone).getTime();
    for (; t + len <= close; t += len) {
      if (t < from.getTime()) continue;
      yield { start: new Date(t).toISOString(), end: new Date(t + len).toISOString() };
    }
  }
}

async function bookedIn(contractorId: string, from: Date, to: Date) {
  return db
    .select({ startsAt: bookings.startsAt, endsAt: bookings.endsAt })
    .from(bookings)
    .where(and(eq(bookings.contractorId, contractorId), eq(bookings.status, "booked"), lt(bookings.startsAt, to), gt(bookings.endsAt, from)));
}

/** The next `count` open windows that match the caller's preference, skipping `skip` earlier matches. */
export async function openSlots(c: Contractor, opts: { count?: number; pref?: TimePref; skip?: number; now?: Date } = {}): Promise<Slot[]> {
  const { count = 3, pref = "any", skip = 0, now = new Date() } = opts;
  const from = new Date(now.getTime() + LEAD_MINUTES * 60000);
  const existing = await bookedIn(c.id, from, new Date(from.getTime() + LOOKAHEAD_DAYS * 86400000));
  const out: Slot[] = [];
  let skipped = 0;
  for (const w of candidateWindows(c, from)) {
    const s = new Date(w.start).getTime();
    const e = new Date(w.end).getTime();
    const hour = zonedParts(new Date(w.start), c.timezone).hour;
    if (pref === "morning" && hour >= 12) continue;
    if (pref === "afternoon" && hour < 12) continue;
    const taken = existing.filter((b) => b.startsAt.getTime() < e && b.endsAt.getTime() > s).length;
    if (taken >= Math.max(1, c.jobsPerSlot)) continue;
    if (skipped++ < skip) continue;
    out.push(w);
    if (out.length >= count) break;
  }
  return out;
}

/**
 * Window for an emergency. During business hours: the soonest open window today, if any.
 * Otherwise (or if today is full): an ASAP window starting at the next half hour, when the
 * contractor offers after-hours emergency dispatch. Returns null if neither applies.
 */
export async function emergencySlot(c: Contractor, now = new Date()): Promise<Slot | null> {
  if (isOpenNow(c, now)) {
    const [soonest] = await openSlots(c, { count: 1, now: new Date(now.getTime() - 60 * 60000) });
    if (soonest && zonedParts(new Date(soonest.start), c.timezone).day === zonedParts(now, c.timezone).day) return soonest;
  }
  if (!c.emergencyDispatch) return null;
  const half = 30 * 60000;
  const start = Math.ceil((now.getTime() + 15 * 60000) / half) * half;
  return { start: new Date(start).toISOString(), end: new Date(start + Math.max(60, c.slotMinutes) * 60000).toISOString() };
}

/** Book a window. Re-checks capacity for routine jobs so two callers can't take the last spot. */
export async function bookSlot(
  c: Contractor,
  slot: Slot,
  job: { conversationId: string; customerName: string; phone: string; address: string; issue: string; urgency: string; source: string },
) {
  const start = new Date(slot.start);
  const end = new Date(slot.end);
  if (job.urgency !== "emergency") {
    const taken = await bookedIn(c.id, start, end);
    if (taken.length >= Math.max(1, c.jobsPerSlot)) return null;
  }
  const [row] = await db.insert(bookings).values({ ...job, contractorId: c.id, startsAt: start, endsAt: end }).returning();
  return row;
}
