import "server-only";
import { and, asc, count, desc, eq, gte, sql } from "drizzle-orm";
import { db, calls, texts, bookings, conversations, type Contractor } from "@/db";
import { startOfMonth } from "@/lib/utils";

export async function overview(c: Contractor) {
  const month = startOfMonth();
  const now = new Date();
  const [[callsN], [textBacks], [booked], [emerg], upcoming, recent] = await Promise.all([
    db.select({ n: count() }).from(calls).where(and(eq(calls.contractorId, c.id), gte(calls.startedAt, month))),
    db.select({ n: count() }).from(texts).where(and(eq(texts.contractorId, c.id), eq(texts.kind, "textback"), gte(texts.createdAt, month))),
    db.select({ n: count() }).from(bookings).where(and(eq(bookings.contractorId, c.id), gte(bookings.createdAt, month), eq(bookings.status, "booked"))),
    db.select({ n: count() }).from(conversations).where(and(eq(conversations.contractorId, c.id), gte(conversations.createdAt, month), eq(conversations.urgency, "emergency"))),
    db.select().from(bookings).where(and(eq(bookings.contractorId, c.id), eq(bookings.status, "booked"), gte(bookings.endsAt, now))).orderBy(asc(bookings.startsAt)).limit(8),
    conversationList(c, 8),
  ]);
  return { stats: { calls: callsN.n, textBacks: textBacks.n, booked: booked.n, emergencies: emerg.n }, upcoming, recent };
}

/** Conversations newest first, with how many calls/texts each had. */
export async function conversationList(c: Contractor, limit = 100, offset = 0) {
  return db
    .select({
      conv: conversations,
      calls: sql<number>`(select count(*) from "calls" c where c.conversation_id = "conversations"."id")`.mapWith(Number),
      texts: sql<number>`(select count(*) from "texts" t where t.conversation_id = "conversations"."id")`.mapWith(Number),
    })
    .from(conversations)
    .where(eq(conversations.contractorId, c.id))
    .orderBy(desc(conversations.lastActivityAt))
    .limit(limit)
    .offset(offset);
}

export async function conversationDetail(c: Contractor, id: string) {
  if (!/^[0-9a-f-]{36}$/i.test(id)) return null;
  const [conv] = await db.select().from(conversations).where(and(eq(conversations.id, id), eq(conversations.contractorId, c.id))).limit(1);
  if (!conv) return null;
  const [callRows, textRows, bookingRows] = await Promise.all([
    db.select().from(calls).where(eq(calls.conversationId, id)).orderBy(asc(calls.startedAt)),
    db.select().from(texts).where(eq(texts.conversationId, id)).orderBy(asc(texts.createdAt)),
    db.select().from(bookings).where(eq(bookings.conversationId, id)),
  ]);
  return { conv, calls: callRows, texts: textRows, bookings: bookingRows };
}

export async function bookingsFor(c: Contractor, which: "upcoming" | "past") {
  const now = new Date();
  return which === "upcoming"
    ? db.select().from(bookings).where(and(eq(bookings.contractorId, c.id), gte(bookings.endsAt, now))).orderBy(asc(bookings.startsAt)).limit(200)
    : db.select().from(bookings).where(and(eq(bookings.contractorId, c.id), sql`${bookings.endsAt} < ${now}`)).orderBy(desc(bookings.startsAt)).limit(200);
}
