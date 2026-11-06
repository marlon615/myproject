import "server-only";
import { eq, sql } from "drizzle-orm";
import { db, calls, contractors, type TranscriptLine } from "@/db";
import { verifyTwilioSignature } from "@/lib/sms/twilio";
import { normalizeUsPhone } from "@/lib/utils";

const esc = (s: string) => s.replace(/[<>&'"]/g, (ch) => ({ "<": "&lt;", ">": "&gt;", "&": "&amp;", "'": "&apos;", '"': "&quot;" })[ch]!);
const VOICE = process.env.TWILIO_VOICE || "Polly.Joanna-Neural";

export const say = (text: string) => `<Say voice="${VOICE}" language="en-US">${esc(text)}</Say>`;

/** Say something, then listen for speech or a keypad press. The action fires even on silence. */
export function gather(text: string, action: string) {
  return `<Gather input="speech dtmf" action="${esc(action)}" method="POST" speechTimeout="auto" timeout="6" numDigits="1" speechModel="phone_call" actionOnEmptyResult="true" language="en-US">${say(text)}</Gather>`;
}

export function twiml(...parts: string[]) {
  return new Response(`<?xml version="1.0" encoding="UTF-8"?><Response>${parts.join("")}</Response>`, {
    headers: { "Content-Type": "text/xml" },
  });
}

/** Parse + verify a Twilio voice webhook. Returns null if the signature is wrong. */
export async function readTwilioForm(req: Request) {
  const params = new URLSearchParams(await req.text());
  if (!verifyTwilioSignature(req, params)) return null;
  return params;
}

export async function contractorForNumber(to: string | null) {
  const number = to ? normalizeUsPhone(to) ?? to : null;
  if (!number) return null;
  const [c] = await db.select().from(contractors).where(eq(contractors.aiNumber, number)).limit(1);
  return c ?? null;
}

export async function appendTranscript(callSid: string, lines: Omit<TranscriptLine, "at">[]) {
  const at = new Date().toISOString();
  const json = JSON.stringify(lines.map((l) => ({ ...l, at })));
  await db.update(calls).set({ transcript: sql`${calls.transcript} || ${json}::jsonb` }).where(eq(calls.callSid, callSid));
}
