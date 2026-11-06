import { and, eq } from "drizzle-orm";
import { db, calls, conversations } from "@/db";
import { readTwilioForm, contractorForNumber, twiml, say, gather, appendTranscript } from "@/lib/voice";
import { respond } from "@/lib/agent";

export const maxDuration = 30;

/** Each time the caller finishes speaking (or presses a key), Twilio posts here. */
export async function POST(req: Request) {
  const p = await readTwilioForm(req);
  if (!p) return new Response("Invalid signature", { status: 403 });
  const url = new URL(req.url);
  const convId = url.searchParams.get("conv") ?? "";
  const silences = Number(url.searchParams.get("quiet") ?? "0");
  const callSid = p.get("CallSid") ?? "";

  const c = await contractorForNumber(p.get("To"));
  if (!c || !/^[0-9a-f-]{36}$/i.test(convId)) return twiml(say("Sorry, something went wrong. Goodbye."), "<Hangup/>");
  const [conv] = await db.select().from(conversations).where(and(eq(conversations.id, convId), eq(conversations.contractorId, c.id))).limit(1);
  if (!conv) return twiml(say("Sorry, something went wrong. Goodbye."), "<Hangup/>");

  const digits = p.get("Digits") ?? "";
  const speech = (p.get("SpeechResult") ?? "").trim();
  const heard = speech || (digits ? digits : "");

  if (!heard) {
    if (silences >= 1) {
      const bye = "I didn't hear anything, so I'll send you a text and we can finish there. Goodbye.";
      await appendTranscript(callSid, [{ role: "assistant", text: bye }]);
      return twiml(say(bye), "<Hangup/>");
    }
    const [call] = await db.select({ transcript: calls.transcript }).from(calls).where(eq(calls.callSid, callSid)).limit(1);
    const last = [...(call?.transcript ?? [])].reverse().find((l) => l.role === "assistant")?.text ?? "How can I help?";
    const again = `Sorry, I didn't catch that. ${last.split(/(?<=[.?!])\s+/).slice(-1)[0]}`;
    await appendTranscript(callSid, [{ role: "assistant", text: again }]);
    return twiml(gather(again, `/api/voice/turn?conv=${conv.id}&quiet=1`));
  }

  const turn = await respond(c, conv, digits && !speech ? `I choose option ${digits}` : heard, "voice");
  await appendTranscript(callSid, [
    { role: "caller", text: digits && !speech ? `(pressed ${digits})` : heard },
    { role: "assistant", text: turn.reply },
  ]);
  if (turn.end) return twiml(say(turn.reply), "<Hangup/>");
  return twiml(gather(turn.reply, `/api/voice/turn?conv=${conv.id}`));
}
