import "server-only";
import { and, eq } from "drizzle-orm";
import { db, texts, optouts, type Contractor } from "@/db";
import { getSmsProvider } from "@/lib/sms";

export type TextKind = "textback" | "assistant" | "confirmation" | "reminder" | "alert" | "reply" | "optout" | "optin";

export const KIND_LABELS: Record<string, string> = {
  textback: "Missed-call text-back",
  assistant: "Assistant reply",
  confirmation: "Booking confirmation",
  reminder: "Appointment reminder",
  alert: "Alert to contractor",
  reply: "Caller text",
  optout: "Opted out (STOP)",
  optin: "Opted back in",
};

/**
 * Every text a caller receives from the assistant starts with this, so the automated nature is
 * stated in each message (not left to the model to remember).
 */
export function assistantPrefix(c: Pick<Contractor, "businessName">) {
  return `${c.businessName} automated assistant: `;
}

export async function isOptedOut(contractorId: string, phone: string) {
  const [row] = await db.select().from(optouts).where(and(eq(optouts.contractorId, contractorId), eq(optouts.phone, phone))).limit(1);
  return Boolean(row);
}

/**
 * Send a text from the contractor's CallCairn line and log it.
 * Texts to callers (not alerts to the contractor) are skipped if the caller opted out.
 */
export async function sendText(
  c: Contractor,
  to: string,
  body: string,
  kind: TextKind,
  conversationId: string | null = null,
): Promise<"sent" | "failed" | "skipped"> {
  const toCaller = kind !== "alert";
  const finalBody = toCaller && !body.startsWith(assistantPrefix(c)) ? assistantPrefix(c) + body : body;
  const [row] = await db
    .insert(texts)
    .values({ contractorId: c.id, conversationId, direction: "outbound", phone: to, kind, body: finalBody.slice(0, 1600), status: "sending" })
    .returning({ id: texts.id });

  if (toCaller && (await isOptedOut(c.id, to))) {
    await db.update(texts).set({ status: "skipped", error: "Caller opted out (STOP)" }).where(eq(texts.id, row.id));
    return "skipped";
  }
  const provider = getSmsProvider();
  const result = await provider.send(to, finalBody, c.aiNumber ?? undefined);
  await db
    .update(texts)
    .set(
      result.ok
        ? { status: "sent", provider: provider.name, providerMessageId: result.providerMessageId ?? null }
        : { status: "failed", provider: provider.name, error: result.error.slice(0, 500) },
    )
    .where(eq(texts.id, row.id));
  return result.ok ? "sent" : "failed";
}

export async function logInbound(c: Contractor, from: string, body: string, kind: TextKind, conversationId: string | null, providerMessageId?: string) {
  await db.insert(texts).values({
    contractorId: c.id,
    conversationId,
    direction: "inbound",
    phone: from,
    kind,
    body: body.slice(0, 1600),
    status: "received",
    providerMessageId: providerMessageId ?? null,
  });
}

const STOP_WORDS = new Set(["stop", "stopall", "unsubscribe", "cancel", "end", "quit", "optout", "revoke"]);
const START_WORDS = new Set(["start", "unstop"]);

/** Returns "stop" / "start" if the text is an opt-out keyword, recording the change. */
export async function handleKeywords(c: Contractor, from: string, body: string): Promise<"stop" | "start" | null> {
  const word = body.trim().toLowerCase().replace(/[^a-z]/g, "");
  if (STOP_WORDS.has(word)) {
    await db.insert(optouts).values({ contractorId: c.id, phone: from }).onConflictDoNothing();
    return "stop";
  }
  if (START_WORDS.has(word)) {
    await db.delete(optouts).where(and(eq(optouts.contractorId, c.id), eq(optouts.phone, from)));
    return "start";
  }
  return null;
}
