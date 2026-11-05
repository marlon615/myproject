import "server-only";
import { and, asc, eq, inArray, lte, desc } from "drizzle-orm";
import { db, churches, visitors, messages, type Church, type Visitor } from "@/db";
import { getSmsProvider } from "@/lib/sms";
import { canSendTexts } from "@/lib/billing";
import { addDays } from "@/lib/utils";
import { CHECKIN_AFTER_DAYS, INVITE_AFTER_DAYS } from "@/lib/config";

export type MessageKind = "welcome" | "checkin" | "invite";

export const KIND_LABELS: Record<string, string> = {
  welcome: "Thank-you",
  checkin: "Day-3 check-in",
  invite: "Day-7 invite",
  reply: "Reply",
  optout: "Opted out (STOP)",
  optin: "Opted back in",
};

const oneLine = (s: string) =>
  s
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter(Boolean)
    .join("; ");

/** The three automatic texts. Edit the wording here. */
export function buildMessage(kind: MessageKind, church: Church, visitor: Pick<Visitor, "firstName">, welcomeUrl: string): string {
  const name = visitor.firstName.trim();
  switch (kind) {
    case "welcome":
      return [
        `Hi ${name}! Thank you so much for visiting ${church.name} today. We're really glad you came.`,
        `"${church.welcomeMessage.trim()}" – ${church.pastorName}`,
        `Here's your welcome pack with service times and what to expect: ${welcomeUrl}`,
        `Reply STOP to opt out.`,
      ].join("\n\n");
    case "checkin":
      return `Hi ${name}, it's ${church.pastorName} from ${church.name}. Just checking in – how was your visit? If there's anything we can pray about for you this week, simply reply to this text.`;
    case "invite":
      return `Hi ${name}! We'd love to see you again at ${church.name}. Our services: ${oneLine(church.serviceTimes)}. Save you a seat this week? ${welcomeUrl}`;
  }
}

export function welcomeUrlFor(baseUrl: string, church: Pick<Church, "slug">) {
  return `${baseUrl}/g/${church.slug}/welcome`;
}

/** Queue the thank-you (now), check-in (+3 days) and invite (+7 days). Returns the thank-you message id. */
export async function scheduleFollowUps(church: Church, visitor: Visitor, baseUrl: string): Promise<string> {
  const url = welcomeUrlFor(baseUrl, church);
  const now = new Date();
  const rows = await db
    .insert(messages)
    .values([
      { kind: "welcome", scheduledFor: now },
      { kind: "checkin", scheduledFor: addDays(now, CHECKIN_AFTER_DAYS) },
      { kind: "invite", scheduledFor: addDays(now, INVITE_AFTER_DAYS) },
    ].map((m) => ({
      ...m,
      churchId: church.id,
      visitorId: visitor.id,
      direction: "outbound",
      status: "scheduled",
      body: buildMessage(m.kind as MessageKind, church, visitor, url),
    })))
    .returning({ id: messages.id, kind: messages.kind });
  return rows.find((r) => r.kind === "welcome")!.id;
}

/**
 * Send one scheduled message. Safe to call concurrently: the row is claimed
 * atomically (scheduled → sending) so a text is never sent twice.
 */
export async function sendMessage(messageId: string): Promise<"sent" | "failed" | "skipped" | "noop"> {
  const [claimed] = await db
    .update(messages)
    .set({ status: "sending" })
    .where(and(eq(messages.id, messageId), eq(messages.status, "scheduled")))
    .returning();
  if (!claimed) return "noop";

  const [row] = await db
    .select({ church: churches, visitor: visitors })
    .from(visitors)
    .innerJoin(churches, eq(churches.id, visitors.churchId))
    .where(eq(visitors.id, claimed.visitorId))
    .limit(1);

  const skip = async (reason: string) => {
    await db.update(messages).set({ status: "skipped", error: reason }).where(eq(messages.id, messageId));
    return "skipped" as const;
  };

  if (!row) return skip("Guest no longer exists");
  if (row.visitor.optedOut) return skip("Guest opted out");
  if (!canSendTexts(row.church)) return skip("Church trial ended / subscription inactive");
  if (claimed.kind === "invite" && row.visitor.returnedAt) return skip("Guest already returned");

  const provider = getSmsProvider();
  const result = await provider.send(row.visitor.phone, claimed.body);

  await db
    .update(messages)
    .set(
      result.ok
        ? { status: "sent", sentAt: new Date(), provider: provider.name, providerMessageId: result.providerMessageId ?? null, error: null }
        : { status: "failed", provider: provider.name, error: result.error.slice(0, 500) },
    )
    .where(eq(messages.id, messageId));
  return result.ok ? "sent" : "failed";
}

/** Send everything that's due. Called by the cron route. */
export async function processDueMessages(limit = 200) {
  // A send that was cut off mid-flight (e.g. the serverless function was stopped) would
  // otherwise sit in "sending" forever. Surface it as failed rather than retrying, since
  // the provider may already have delivered it and a duplicate text is worse.
  const interrupted = await db
    .update(messages)
    .set({ status: "failed", error: "Interrupted while sending – not retried to avoid a duplicate text" })
    .where(and(eq(messages.status, "sending"), lte(messages.scheduledFor, new Date(Date.now() - 10 * 60 * 1000))))
    .returning({ id: messages.id });

  const due = await db
    .select({ id: messages.id })
    .from(messages)
    .where(and(eq(messages.status, "scheduled"), lte(messages.scheduledFor, new Date())))
    .orderBy(asc(messages.scheduledFor))
    .limit(limit);

  const tally = { sent: 0, failed: 0, skipped: 0, noop: 0 };
  for (const { id } of due) tally[await sendMessage(id)]++;
  return { processed: due.length, ...tally, interrupted: interrupted.length };
}

const STOP_WORDS = new Set(["stop", "stopall", "unsubscribe", "cancel", "end", "quit", "optout"]);
const START_WORDS = new Set(["start", "unstop", "yes"]);

/** Record an inbound reply and honor STOP / START keywords. */
export async function recordInbound(from: string, body: string, providerMessageId?: string) {
  const matches = await db
    .select()
    .from(visitors)
    .where(eq(visitors.phone, from))
    .orderBy(desc(visitors.createdAt));
  if (matches.length === 0) return { matched: false };

  const keyword = body.trim().toLowerCase().replace(/[^a-z]/g, "");
  const ids = matches.map((v) => v.id);
  const isStop = STOP_WORDS.has(keyword);
  const isStart = START_WORDS.has(keyword);

  if (isStop) {
    await db.update(visitors).set({ optedOut: true }).where(inArray(visitors.id, ids));
    await db
      .update(messages)
      .set({ status: "skipped", error: "Guest opted out" })
      .where(and(inArray(messages.visitorId, ids), eq(messages.status, "scheduled")));
  } else if (isStart) {
    await db.update(visitors).set({ optedOut: false }).where(inArray(visitors.id, ids));
  }

  // Attribute the reply to the most recent visit.
  const visitor = matches[0];
  const now = new Date();
  await db.insert(messages).values({
    churchId: visitor.churchId,
    visitorId: visitor.id,
    // Opt-out/opt-in keywords are logged but don't count as a "reply" on the dashboard.
    kind: isStop ? "optout" : isStart ? "optin" : "reply",
    direction: "inbound",
    body: body.slice(0, 1600),
    status: "received",
    scheduledFor: now,
    sentAt: now,
    providerMessageId: providerMessageId ?? null,
  });
  if (!isStop && !isStart) {
    await db.update(visitors).set({ lastReplyAt: now }).where(eq(visitors.id, visitor.id));
  }
  return { matched: true };
}
