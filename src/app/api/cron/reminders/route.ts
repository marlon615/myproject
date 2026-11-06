import { and, eq, gte, isNull, lte } from "drizzle-orm";
import { db, bookings, contractors } from "@/db";
import { sendText } from "@/lib/messaging";
import { serviceActive } from "@/lib/billing";
import { formatPhone, windowLabel } from "@/lib/utils";

export const maxDuration = 60;

/**
 * Daily: text each customer a reminder about tomorrow's appointment.
 * Vercel Cron calls this with `Authorization: Bearer $CRON_SECRET`.
 */
export async function GET(req: Request) {
  const secret = process.env.CRON_SECRET;
  if (!secret) return new Response("CRON_SECRET not set", { status: 500 });
  if (req.headers.get("authorization") !== `Bearer ${secret}`) return new Response("Unauthorized", { status: 401 });

  const now = Date.now();
  const due = await db
    .select({ b: bookings, c: contractors })
    .from(bookings)
    .innerJoin(contractors, eq(contractors.id, bookings.contractorId))
    .where(and(eq(bookings.status, "booked"), isNull(bookings.reminderSentAt), gte(bookings.startsAt, new Date(now + 6 * 3600000)), lte(bookings.startsAt, new Date(now + 36 * 3600000))))
    .limit(500);

  let sent = 0;
  for (const { b, c } of due) {
    // Claim first so overlapping runs never double-text.
    const [claimed] = await db.update(bookings).set({ reminderSentAt: new Date() }).where(and(eq(bookings.id, b.id), isNull(bookings.reminderSentAt))).returning({ id: bookings.id });
    if (!claimed || !serviceActive(c)) continue;
    const r = await sendText(
      c,
      b.phone,
      `Reminder: ${c.businessName} is scheduled to visit ${b.address} on ${windowLabel(b.startsAt, b.endsAt, c.timezone)}. To reschedule, call ${formatPhone(c.businessPhone)}. Reply STOP to opt out.`,
      "reminder",
      b.conversationId,
    );
    if (r === "sent") sent++;
  }
  return Response.json({ due: due.length, sent });
}
