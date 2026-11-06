import { and, eq, isNull } from "drizzle-orm";
import { db, calls, conversations } from "@/db";
import { readTwilioForm, contractorForNumber } from "@/lib/voice";
import { textBackMessage } from "@/lib/agent";
import { sendText } from "@/lib/messaging";
import { serviceActive } from "@/lib/billing";

const FINAL = new Set(["completed", "busy", "no-answer", "failed", "canceled"]);

/**
 * Twilio's call status callback. When a call ends without a booking (caller hung up, got cut
 * off, went quiet), CallCairn texts them back so the conversation can continue by text.
 */
export async function POST(req: Request) {
  const p = await readTwilioForm(req);
  if (!p) return new Response("Invalid signature", { status: 403 });
  const callSid = p.get("CallSid") ?? "";
  const status = p.get("CallStatus") ?? "";
  if (!FINAL.has(status)) return new Response(null, { status: 204 });

  const c = await contractorForNumber(p.get("To"));
  const [call] = await db.select().from(calls).where(eq(calls.callSid, callSid)).limit(1);
  if (!c || !call) return new Response(null, { status: 204 });

  await db
    .update(calls)
    .set({ status, durationSec: Number(p.get("CallDuration") ?? 0) || 0, endedAt: new Date() })
    .where(eq(calls.id, call.id));
  if (call.outcome || !call.conversationId) return new Response(null, { status: 204 });

  const [conv] = await db.select().from(conversations).where(eq(conversations.id, call.conversationId)).limit(1);
  let outcome: string;
  if (!conv) outcome = "hung_up";
  else if (conv.status === "booked") outcome = "booked";
  else if (conv.hazard) outcome = "safety";
  else if (conv.status === "handoff") outcome = conv.urgency === "emergency" ? "emergency" : "handoff";
  else if (conv.status === "closed") outcome = "closed";
  else outcome = "texted_back";

  // Claim the outcome once, so a repeated callback can't text twice.
  const [claimed] = await db.update(calls).set({ outcome }).where(and(eq(calls.id, call.id), isNull(calls.outcome))).returning({ id: calls.id });
  if (claimed && outcome === "texted_back" && conv && serviceActive(c)) {
    // The texted conversation picks up where the call left off.
    const result = await sendText(c, conv.phone, textBackMessage(c, conv), "textback", conv.id);
    if (result !== "sent") await db.update(calls).set({ outcome: "hung_up" }).where(eq(calls.id, call.id));
  }
  return new Response(null, { status: 204 });
}
