import { db, calls, conversations } from "@/db";
import { readTwilioForm, contractorForNumber, twiml, say, gather, appendTranscript } from "@/lib/voice";
import { voiceGreeting } from "@/lib/agent";
import { serviceActive } from "@/lib/billing";
import { normalizeUsPhone, formatPhone } from "@/lib/utils";

export const maxDuration = 30;

/**
 * Twilio calls this when someone dials a contractor's CallCairn line (usually a missed or
 * after-hours call forwarded from the contractor's main number).
 */
export async function POST(req: Request) {
  const p = await readTwilioForm(req);
  if (!p) return new Response("Invalid signature", { status: 403 });
  const callSid = p.get("CallSid") ?? "";
  const from = normalizeUsPhone(p.get("From") ?? "") ?? p.get("From") ?? "unknown";
  const c = await contractorForNumber(p.get("To"));
  if (!c) return twiml(say("Sorry, this number is not in service."), "<Hangup/>");

  const forwardedFrom = p.get("ForwardedFrom") ? normalizeUsPhone(p.get("ForwardedFrom")!) ?? p.get("ForwardedFrom") : null;

  if (!serviceActive(c)) {
    await db.insert(calls).values({ contractorId: c.id, callSid, fromPhone: from, toPhone: c.aiNumber!, forwardedFrom, outcome: "inactive" }).onConflictDoNothing();
    return twiml(say(`Thanks for calling ${c.businessName}. This automated line isn't active right now. Please call ${formatPhone(c.businessPhone)} during business hours.`), "<Hangup/>");
  }

  // Each call starts a fresh conversation; texts that follow the call continue it.
  const [conv] = await db.insert(conversations).values({ contractorId: c.id, phone: from, channel: "voice" }).returning();
  await db.insert(calls).values({ contractorId: c.id, conversationId: conv.id, callSid, fromPhone: from, toPhone: c.aiNumber!, forwardedFrom }).onConflictDoNothing();

  const greeting = voiceGreeting(c);
  await appendTranscript(callSid, [{ role: "assistant", text: greeting }]);
  return twiml(gather(greeting, `/api/voice/turn?conv=${conv.id}`));
}
