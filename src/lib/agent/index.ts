import "server-only";
import { and, desc, eq, gte } from "drizzle-orm";
import { db, conversations, type Contractor, type Conversation, type Slot } from "@/db";
import { understand, type Understanding } from "./understand";
import { emergencySlot, isOpenNow, openSlots, bookSlot, type TimePref } from "@/lib/schedule";
import { sendText } from "@/lib/messaging";
import { formatPhone, spokenWindow, windowLabel } from "@/lib/utils";

/**
 * CallCairn's conversation engine, shared by phone calls and texts.
 *
 * The flow is fixed in code so it's predictable and safe:
 *   issue → (urgency, if unclear) → name → address → (time of day, routine only) → pick a window → booked
 * Gas, carbon monoxide or smoke at any point → safety instructions + immediate alert to the contractor.
 * Asked "are you a real person?" at any point → the reply always says it's an automated assistant.
 */

export type Channel = "voice" | "sms";
export type Turn = { reply: string; end: boolean };

const SAFETY: Record<Exclude<Understanding["hazard"], "none">, string> = {
  gas: "If you smell gas, please leave the building now, don't use light switches or anything that could spark, and call 911 or your gas company from outside.",
  carbon_monoxide: "If a carbon monoxide alarm is going off or anyone feels dizzy, sick or sleepy, get everyone outside to fresh air now and call 911.",
  fire_smoke: "If there's smoke, burning or sparks, turn the system off only if it's safe to, get everyone out, and call 911.",
};

export const QUESTIONS = {
  issue: "Briefly, what's going on with your heating or cooling?",
  urgency:
    "Is this an emergency, like no heat in cold weather, no cooling with someone vulnerable at home, or water leaking? Or can it wait for a regular appointment?",
  name: "What's your name?",
  address: "What's the address where you need service, including the city?",
  time: "Do mornings or afternoons work better for you?",
} as const;

const STEP_TEXT: Record<string, string> = {
  issue: "what's going on with their heating or cooling",
  urgency: "whether it's an emergency or can wait for a regular appointment (yes/no style)",
  name: "their name",
  address: "the service address",
  time: "whether mornings or afternoons work better",
  pick: "which of the numbered appointment windows works (or yes/no if only one was offered)",
  done: "anything else",
};

/**
 * The caller's open conversation from the last 3 days, or any conversation from the last
 * 12 hours (so a follow-up text after a booking or callback request stays in the same thread).
 */
export async function findOrStartConversation(c: Contractor, phone: string, channel: Channel): Promise<Conversation> {
  const [recent] = await db
    .select()
    .from(conversations)
    .where(and(eq(conversations.contractorId, c.id), eq(conversations.phone, phone), gte(conversations.lastActivityAt, new Date(Date.now() - 3 * 86400000))))
    .orderBy(desc(conversations.lastActivityAt))
    .limit(1);
  if (recent && (recent.status === "open" || recent.lastActivityAt.getTime() > Date.now() - 12 * 3600000)) return recent;
  const [created] = await db.insert(conversations).values({ contractorId: c.id, phone, channel }).returning();
  return created;
}

export function voiceGreeting(c: Contractor): string {
  const closed = isOpenNow(c) ? "" : " Our office is closed right now, but I can still help.";
  return `Hi, thanks for calling ${c.businessName}. I'm an automated assistant, not a person, and I can get you on the schedule.${closed} This call is transcribed so we can book your visit. ${QUESTIONS.issue}`;
}

/** The text sent after a call ends without a booking. Picks up at whatever step the call reached. */
export function textBackMessage(c: Contractor, conv: Conversation): string {
  if (!conv.issue) {
    return `Sorry we missed your call. I'm an automated assistant and I can get you on the schedule by text. ${QUESTIONS.issue} Reply STOP to opt out.`;
  }
  const q =
    conv.step === "pick" && conv.offeredSlots?.length
      ? conv.offeredSlots.length === 1
        ? `Should I book ${windowLabel(conv.offeredSlots[0].start, conv.offeredSlots[0].end, c.timezone)}? Reply YES or NO.`
        : `Which time works?\n${listWindows(conv.offeredSlots, c, "sms")}`
      : (QUESTIONS as Record<string, string>)[conv.step] ?? QUESTIONS.issue;
  return `Looks like we got cut off. I'm an automated assistant and can finish booking by text. ${q} Reply STOP to opt out.`;
}

function listWindows(slots: Slot[], c: Contractor, channel: Channel) {
  if (channel === "voice") {
    return slots.map((s, i) => `Option ${i + 1}: ${spokenWindow(s.start, s.end, c.timezone)}.`).join(" ");
  }
  return slots.map((s, i) => `${i + 1}) ${windowLabel(s.start, s.end, c.timezone)}`).join("\n");
}

async function save(conv: Conversation, patch: Partial<Conversation>) {
  Object.assign(conv, patch);
  await db.update(conversations).set({ ...patch, lastActivityAt: new Date() }).where(eq(conversations.id, conv.id));
}

/** Text the contractor's alert phone. Each conversation alerts at most once per kind of event. */
async function alertContractor(c: Contractor, conv: Conversation, headline: string) {
  const lines = [
    `CallCairn: ${headline}`,
    `Caller: ${conv.customerName ?? "name not given"} ${formatPhone(conv.phone)}`,
    conv.address ? `Address: ${conv.address}` : null,
    conv.issue ? `Issue: ${conv.issue}` : null,
  ].filter(Boolean);
  await sendText(c, c.alertPhone, lines.join("\n"), "alert", conv.id);
  await save(conv, { alertedAt: new Date() });
}

/** Handle one caller message (speech or text) and return what to say/text back. */
export async function respond(c: Contractor, conv: Conversation, message: string, channel: Channel): Promise<Turn> {
  const offered = conv.step === "pick" ? conv.offeredSlots ?? [] : [];
  const u = await understand(
    {
      businessName: c.businessName,
      serviceArea: c.serviceArea,
      lastQuestion: STEP_TEXT[conv.step] ?? STEP_TEXT.issue,
      offered: offered.map((s) => windowLabel(s.start, s.end, c.timezone)),
      known: { issue: conv.issue, name: conv.customerName, address: conv.address },
      message,
    },
    { timeoutMs: channel === "voice" ? 7000 : 15000 },
  );

  // Always answer "is this a real person?" truthfully, before anything else.
  const disclose = u.asks_if_human ? `I'm an automated assistant for ${c.businessName}, not a person. ` : "";
  const say = (reply: string, end = false): Turn => ({ reply: disclose + reply, end });

  // ── Life safety first ──
  if (u.hazard !== "none") {
    await save(conv, { hazard: u.hazard, urgency: "emergency", status: "handoff", step: "done", issue: conv.issue ?? u.issue ?? u.hazard });
    await alertContractor(c, conv, `⚠ SAFETY: caller reports ${u.hazard.replace("_", " ")}. Call them back now.`);
    return say(`${SAFETY[u.hazard]} I've alerted ${c.businessName} and someone will call you back at this number as soon as possible.`, true);
  }

  if (conv.step === "done") {
    if (u.wants_person && conv.status !== "handoff") {
      await save(conv, { status: "handoff" });
      await alertContractor(c, conv, "Caller asked to talk to a person.");
      return say(`I've asked the team to call you back at this number.`, true);
    }
    return say(
      conv.status === "booked"
        ? `You're all set. If you need to change your appointment, call ${c.businessName} at ${formatPhone(c.businessPhone)}.`
        : `Thanks, I've passed this along to ${c.businessName} and they'll follow up.`,
      true,
    );
  }

  if (u.wants_person) {
    await save(conv, { status: "handoff", step: "done", issue: conv.issue ?? u.issue, customerName: conv.customerName ?? u.name, address: conv.address ?? u.address });
    await alertContractor(c, conv, `Caller asked to talk to a person${conv.urgency === "emergency" ? " (EMERGENCY)" : ""}.`);
    const when = isOpenNow(c) ? "shortly" : "as soon as they're available";
    return say(`No problem. I'm an automated assistant, so I've texted the team to call you back at this number ${when}.`, true);
  }

  if (u.not_hvac && !conv.issue) {
    await save(conv, { status: "closed", step: "done" });
    return say(`I can only help with heating and cooling service for ${c.businessName}. Thanks for calling.`, true);
  }

  // ── Merge whatever we learned ──
  const patch: Partial<Conversation> = {};
  if (u.issue && (!conv.issue || conv.step === "issue")) patch.issue = u.issue;
  if (!u.issue && conv.step === "issue" && message.trim().length > 3) patch.issue = message.trim().slice(0, 140);
  if (u.name && !conv.customerName) patch.customerName = u.name.slice(0, 80);
  if (u.address && (!conv.address || conv.step === "address")) patch.address = u.address.slice(0, 200);
  if (u.time_pref) patch.timePref = u.time_pref;
  if (u.urgency === "emergency") patch.urgency = "emergency";
  else if (u.urgency === "routine" && conv.urgency === "unknown") patch.urgency = "routine";
  else if (conv.step === "urgency" && conv.urgency === "unknown") {
    // A plain yes/no answer to "is this an emergency?"
    if (u.affirmative === true) patch.urgency = "emergency";
    else if (u.affirmative === false) patch.urgency = "routine";
  }
  if (Object.keys(patch).length) await save(conv, patch);

  // ── Picking a window ──
  if (conv.step === "pick" && offered.length) {
    const choice = u.slot_choice && u.slot_choice >= 1 && u.slot_choice <= offered.length ? offered[u.slot_choice - 1] : offered.length === 1 && u.affirmative === true ? offered[0] : null;
    if (choice && new Date(choice.start).getTime() < Date.now() - (conv.urgency === "emergency" ? 60 : -15) * 60000) {
      return say(`Sorry, that time has passed. ${await offerWindows(c, conv, channel, 0)}`);
    }
    if (choice) return say(...(await book(c, conv, choice, channel)));
    if (u.rejects_offered || u.affirmative === false) {
      if (conv.urgency === "emergency") {
        await save(conv, { status: "handoff", step: "done" });
        await alertContractor(c, conv, "EMERGENCY caller couldn't take the ASAP window. Please call to arrange a time.");
        return say(`Okay. I've flagged this as urgent and someone from ${c.businessName} will call you to find a time that works.`, true);
      }
      return say(await offerWindows(c, conv, channel, conv.offerRound + 1));
    }
    const how = channel === "voice" ? "say or press" : "reply with";
    return say(offered.length === 1 ? `Should I book that time? Please say yes or no.` : `Which works best? Please ${how} ${offered.map((_, i) => i + 1).join(", ").replace(/, (\d)$/, " or $1")}, or say none of these work.`);
  }

  return say(await nextQuestion(c, conv, channel));
}

/** Ask for the next missing detail, or offer windows once everything is known. */
async function nextQuestion(c: Contractor, conv: Conversation, channel: Channel): Promise<string> {
  const ack = conv.urgency === "emergency" && conv.step !== "name" && conv.step !== "address" && conv.step !== "time" ? "That sounds urgent, I'll get you in as fast as possible. " : "";
  if (!conv.issue) return ask(conv, "issue", QUESTIONS.issue);
  if (conv.urgency === "unknown" && conv.step !== "urgency") return ask(conv, "urgency", `Got it. ${QUESTIONS.urgency}`);
  if (conv.urgency === "unknown") await save(conv, { urgency: "routine" }); // still unclear after asking: treat as routine
  if (!conv.customerName) return ack + (await ask(conv, "name", QUESTIONS.name));
  if (!conv.address) return ack + (await ask(conv, "address", `Thanks, ${conv.customerName.split(" ")[0]}. ${QUESTIONS.address}`));
  if (conv.urgency !== "emergency" && !conv.timePref) return ask(conv, "time", QUESTIONS.time);
  return offerWindows(c, conv, channel, 0);
}

async function ask(conv: Conversation, step: string, question: string) {
  await save(conv, { step });
  return question;
}

async function offerWindows(c: Contractor, conv: Conversation, channel: Channel, round: number): Promise<string> {
  if (conv.urgency === "emergency") {
    const slot = await emergencySlot(c);
    if (!slot) {
      await save(conv, { status: "handoff", step: "done" });
      await alertContractor(c, conv, "EMERGENCY call. Please call back first thing.");
      return `I've flagged this as an emergency and sent it to ${c.businessName}. Someone will call you back at this number as soon as possible.`;
    }
    await save(conv, { step: "pick", offeredSlots: [slot], offerRound: round });
    const note = c.emergencyNote ? ` ${c.emergencyNote}` : "";
    const when = channel === "voice" ? spokenWindow(slot.start, slot.end, c.timezone) : windowLabel(slot.start, slot.end, c.timezone);
    return `The soonest we can get a technician to you is ${when}.${note} Should I book that?`;
  }
  const slots = await openSlots(c, { count: 3, pref: (conv.timePref as TimePref) ?? "any", skip: round * 3 });
  if (!slots.length) {
    await save(conv, { status: "handoff", step: "done" });
    await alertContractor(c, conv, "Caller wants an appointment but no open windows matched. Please call to schedule.");
    return `I don't see an open time that matches right now, so I've sent your details to ${c.businessName} and they'll call you to schedule.`;
  }
  await save(conv, { step: "pick", offeredSlots: slots, offerRound: round });
  const lead = round > 0 ? "Here are some other times." : "Here are the next openings.";
  const tail = channel === "voice" ? "Which works best? You can say the option number or press it on your keypad." : "Reply with the number that works best.";
  return `${lead} ${channel === "sms" ? "\n" : ""}${listWindows(slots, c, channel)}${channel === "sms" ? "\n" : " "}${tail}`;
}

async function book(c: Contractor, conv: Conversation, slot: Slot, channel: Channel): Promise<[string, boolean]> {
  const booking = await bookSlot(c, slot, {
    conversationId: conv.id,
    customerName: conv.customerName ?? "Caller",
    phone: conv.phone,
    address: conv.address ?? "(not given)",
    issue: conv.issue ?? "(not given)",
    urgency: conv.urgency === "emergency" ? "emergency" : "routine",
    source: channel,
  });
  if (!booking) return [`Sorry, that time was just taken. ${await offerWindows(c, conv, channel, conv.offerRound)}`, false];

  await save(conv, { status: "booked", step: "done" });
  const label = windowLabel(slot.start, slot.end, c.timezone);
  const emergency = conv.urgency === "emergency";
  await alertContractor(c, conv, `${emergency ? "🚨 EMERGENCY booking" : "New booking"}: ${label}`);

  const confirm = `You're booked with ${c.businessName} for ${label}${emergency ? " (emergency visit)" : ""} at ${conv.address}. The technician will call before arriving. To change it, call ${formatPhone(c.businessPhone)}.`;
  if (channel === "voice") {
    // Spoken confirmation, plus the details by text so the caller has them in writing.
    await sendText(c, conv.phone, confirm, "confirmation", conv.id);
    return [`You're all set for ${spokenWindow(slot.start, slot.end, c.timezone)}. I've texted you the details. The technician will call before arriving. Thanks for calling ${c.businessName}. Goodbye.`, true];
  }
  return [confirm, true];
}
