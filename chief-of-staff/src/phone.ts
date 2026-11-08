import Anthropic from "@anthropic-ai/sdk";
import { addEventUrl, agendaSpeech } from "./calendar";
import { cleanPhone, contactCount, findPerson, harvestSent, upsertContact, type Person } from "./contacts";
import { gmailCreds } from "./inbox";
import { allowed, PERM_ASK, PERM_LABEL, PERMS, setPerm, type Perm } from "./permissions";
import { getSecret, getSettings } from "./settings";
import { addTodo } from "./todos";
import { PRODUCT_NAME, type Env, type Product } from "./types";
import { parseWhen } from "./when";

/** Something to read aloud. decideUrl: wait for yes/no and post it. openUrl: open it (after a yes if confirm). */
/** The draft shown on screen (and read aloud in full) before the question. */
export interface DraftShow { heading: string; to?: string; subject?: string; body?: string; context?: string }
export interface QueueItem {
  say: string; decideUrl?: string; ackUrl?: string; openUrl?: string; confirm?: boolean;
  show?: DraftShow; ask?: string; yesLabel?: string;
}
export interface VoiceReply { say: string; queue?: QueueItem[]; end?: boolean }

export const isIOS = (ua: string) => /iPhone|iPad|iPod/i.test(ua);

function first(n: string) {
  const w = n.replace(/"/g, "").trim().split(/\s+/).filter(Boolean);
  if (!w.length) return "";
  if (/^(pastor|father|bishop|elder)$/i.test(w[0]) && w[1]) return `${w[0]} ${w[1]}`;
  if (/^(dr|mr|mrs|ms|rev)\.?$/i.test(w[0]) && w[1]) return w[1];
  return w[0];
}
const cap = (s: string) => s.charAt(0).toUpperCase() + s.slice(1);
/** Reads a phone number digit by digit. */
const sayNumber = (p: string) => p.replace(/^\+1/, "").replace(/\D/g, "").split("").join(" ");

const OFF_SAY: Record<Perm, string> = {
  email: "Email is turned off", contacts: "Contacts are turned off", calls: "Calls are turned off", texts: "Texts are turned off",
  calendar: "Calendar is turned off", reminders: "Reminders are turned off", maps: "Maps are turned off",
};
async function off(env: Env, p: Perm): Promise<VoiceReply | null> {
  return (await allowed(env, p)) ? null : { say: `${OFF_SAY[p]}. Say: turn on ${PERM_LABEL[p]}, if you want me to use them.` };
}

// ── Setup: one yes per permission ──

export function setupQueue(): VoiceReply {
  return {
    say: "Let's set me up. I'll ask seven quick questions. Just say yes or no.",
    queue: [
      ...PERMS.map((p) => ({ say: `${PERM_ASK[p]} Yes or no?`, decideUrl: `/api/permission/${p}` })),
      { say: "All set. From now on, just say Hey Chief and tell me what you need. I'll always ask before anything is sent." },
    ],
  };
}

/** Runs after each spoken yes/no during setup; returns what to say next. */
export async function answerPermission(env: Env, p: Perm, yes: boolean): Promise<string> {
  await setPerm(env, p, yes);
  if (!yes) return `Okay, no ${PERM_LABEL[p]}.`;
  const gmail = await gmailCreds(env);
  switch (p) {
    case "email":
      return gmail ? "Email is on." : "Email is on. One step only you can do: in Settings, paste your Gmail app password. Everything else I do by voice.";
    case "contacts": {
      if (!gmail) return "Contacts are on. I'll learn the people in your Gmail as soon as it's connected.";
      try {
        await harvestSent(env, gmail.user, gmail.pass);
        return `Contacts are on. I know ${await contactCount(env)} people from your Gmail.`;
      } catch {
        return "Contacts are on. I'll learn the people in your Gmail on my next check.";
      }
    }
    case "calls": return "Calls are on.";
    case "texts": return "Texts are on.";
    case "calendar":
      return (await getSecret(env, "calendar")) ? "Calendar is on." : "Calendar is on. I can add events now. To read your schedule to you, paste your calendar's secret address in Settings.";
    case "reminders":
      return gmail ? "Reminders are on. I'll say them when the app is open, and email you when one is due." : "Reminders are on. I'll say them when the app is open.";
    case "maps": return "Maps are on.";
  }
}

export async function togglePerm(env: Env, p: Perm, yes: boolean): Promise<VoiceReply> {
  return { say: await answerPermission(env, p, yes) };
}

// ── Calls and texts ──

export async function call(env: Env, target: string, ua: string): Promise<VoiceReply> {
  const o = await off(env, "calls"); if (o) return o;
  const p = await findPerson(env, target);
  if (!p) return { say: `I don't know ${target} yet. Say: save ${target}'s number as, and the number.` };
  if (!p.phone) return { say: `I don't have a number for ${p.name}. Say: save ${first(p.name) || p.name}'s number as, and the number.` };
  void ua;
  return { say: "", queue: [{ say: "", ask: `Call ${p.name} at ${sayNumber(p.phone)}?`, show: { heading: `Call ${p.name}`, body: p.phone }, yesLabel: "Yes, call", openUrl: `tel:${p.phone}`, confirm: true }] };
}

export async function text(env: Env, target: string, message: string, ua: string): Promise<VoiceReply> {
  const o = await off(env, "texts"); if (o) return o;
  const p = await findPerson(env, target);
  if (!p) return { say: `I don't know ${target} yet. Say: save ${target}'s number as, and the number.` };
  if (!p.phone) return { say: `I don't have a number for ${p.name}. Say: save ${first(p.name) || p.name}'s number as, and the number.` };
  const body = cap(message.trim());
  const sep = isIOS(ua) ? "&" : "?";
  return { say: "", queue: [{ say: `Text to ${p.name}.`, show: { heading: "Text message", to: `${p.name} (${p.phone})`, body }, ask: "Should I send it?", openUrl: `sms:${p.phone}${sep}body=${encodeURIComponent(body)}`, confirm: true }] };
}

export async function saveNumber(env: Env, who: string, raw: string): Promise<VoiceReply> {
  const phone = cleanPhone(raw);
  if (!phone) return { say: "That didn't sound like a full phone number. Say all ten digits." };
  const p = await findPerson(env, who);
  if (p?.email) {
    await upsertContact(env, { email: p.email, name: p.name, source: "voice" });
    await env.DB.prepare("update contacts set phone = ? where email = ?").bind(phone, p.email.toLowerCase()).run();
    return { say: `Saved. ${p.name}'s number is ${sayNumber(phone)}.` };
  }
  const name = who.replace(/'s$/, "").trim();
  const existing = await env.DB.prepare("select id from contacts where lower(name) = lower(?) limit 1").bind(name).first<{ id: number }>();
  if (existing) await env.DB.prepare("update contacts set phone = ? where id = ?").bind(phone, existing.id).run();
  else await upsertContact(env, { name: name.replace(/\b\w/g, (c) => c.toUpperCase()), phone, source: "voice" });
  return { say: `Saved. ${name}'s number is ${sayNumber(phone)}.` };
}

// ── Email anyone ──

const EMAIL_SCHEMA = {
  type: "object",
  properties: { subject: { type: "string" }, body: { type: "string" } },
  required: ["subject", "body"],
  additionalProperties: false,
} as const;

export async function emailPerson(env: Env, target: string, message: string): Promise<VoiceReply> {
  const o = await off(env, "email"); if (o) return o;
  if (!(await gmailCreds(env))) return { say: "Gmail isn't connected yet. Paste your Gmail app password in Settings, and I can send emails for you." };
  const p = await findPerson(env, target);
  if (!p) return { say: `I don't know ${target} yet. Once you've emailed each other, I'll know them.` };
  if (!p.email) return { say: `I don't have an email address for ${p.name}.` };
  const s = await getSettings(env);
  const me = first(s.senderName);
  const words = message.trim().split(/\s+/).slice(0, 6);
  while (words.length > 2 && /^(for|to|at|the|a|an|and|of|with|on|in|me|my|your)$/i.test(words[words.length - 1].replace(/[.,!?]/g, ""))) words.pop();
  let subject = cap(words.join(" ")).replace(/[.,!?]+$/, "");
  let body = `Hi ${first(p.name) || "there"},\n\n${cap(message.trim()).replace(/([^.!?])$/, "$1.")}\n\n${me}`.trim();
  const key = await getSecret(env, "anthropic");
  if (key) {
    try {
      const client = new Anthropic({ apiKey: key });
      const res = await client.beta.messages.create({
        model: "claude-opus-5-5",
        max_tokens: 3000,
        betas: ["server-side-fallback-2026-07-01"],
        fallbacks: "default",
        output_config: { effort: "low", format: { type: "json_schema", schema: EMAIL_SCHEMA } },
        system: "Write a short, warm, plain-text email in the owner's voice from their spoken instruction. Keep their meaning exactly; don't add promises, prices or dates they didn't say. 2 to 5 sentences, signed with the owner's first name. Subject under 7 words.",
        messages: [{ role: "user", content: `<owner>${s.senderName || "the owner"}</owner>\n<to>${p.name}${p.organization ? `, ${p.organization}` : ""}</to>\n<instruction>${message}</instruction>` }],
      });
      if (res.stop_reason !== "refusal") {
        const out = JSON.parse(res.content.filter((b) => b.type === "text").map((b) => b.text).join("")) as { subject: string; body: string };
        if (out.subject && out.body) { subject = out.subject; body = out.body; }
      }
    } catch (e) {
      console.error("email writing failed, using dictation:", (e as Error).message);
    }
  }
  const row = await env.DB.prepare("insert into outbox (to_email, to_name, subject, body) values (?, ?, ?, ?) returning id")
    .bind(p.email, p.name, subject.slice(0, 200), body.slice(0, 5000)).first<{ id: number }>();
  const spoken = body.split(/\n+/).map((l) => l.trim()).filter(Boolean).map((l) => (/[.!?,:;]$/.test(l) ? l : l + ".")).join(" ");
  void spoken;
  return { say: "", queue: [{ say: `Email to ${p.name}.`, show: { heading: "Email", to: `${p.name} <${p.email}>`, subject, body }, ask: "Should I send it?", decideUrl: `/outbox/${row!.id}/decide` }] };
}

// ── Calendar ──

export async function readCalendar(env: Env, dayOffset: number): Promise<VoiceReply> {
  const o = await off(env, "calendar"); if (o) return o;
  try {
    return { say: await agendaSpeech(env, dayOffset) };
  } catch (e) {
    return { say: `I couldn't read your calendar. ${(e as Error).message}` };
  }
}

export async function addToCalendar(env: Env, what: string): Promise<VoiceReply> {
  const o = await off(env, "calendar"); if (o) return o;
  const tz = env.APP_TIMEZONE || "America/Chicago";
  const w = parseWhen(what, tz);
  if (!w) return { say: "When should I put it? Say it again with a day or time, like: lunch with Dave tomorrow at noon." };
  const title = cap(w.rest.replace(/^(an? |the )?(event|meeting|appointment)( for| called)? /, "").replace(/\s+(on|to) (my )?calendar$/, "")) || "Event";
  return { say: "", queue: [{ say: "", ask: `Add ${title}, ${w.label}, to your calendar?`, show: { heading: "Calendar event", body: `${title}\n${w.label.charAt(0).toUpperCase() + w.label.slice(1)}` }, yesLabel: "Yes, add it", openUrl: addEventUrl(title, w.at, 60, !w.hasTime), confirm: true }] };
}

// ── Reminders ──

export async function remind(env: Env, what: string): Promise<VoiceReply> {
  const tz = env.APP_TIMEZONE || "America/Chicago";
  const w = parseWhen(what, tz);
  if (w && !(await allowed(env, "reminders"))) return (await off(env, "reminders"))!;
  const t = await addTodo(env, cap(w ? w.rest : what), w ? w.at : null);
  if (!t) return { say: "I didn't catch what to remember." };
  return { say: w ? `Got it. I'll remind you ${w.label}: ${t.text}.` : `Got it. I'll remember: ${t.text}.` };
}

// ── Maps ──

export async function directions(env: Env, place: string, ua: string): Promise<VoiceReply> {
  const o = await off(env, "maps"); if (o) return o;
  const dest = place.replace(/[.?!]+$/, "").trim();
  if (!dest) return { say: "Where to?" };
  const url = isIOS(ua) ? `https://maps.apple.com/?daddr=${encodeURIComponent(dest)}` : `https://www.google.com/maps/dir/?api=1&destination=${encodeURIComponent(dest)}`;
  return { say: "", queue: [{ say: `Opening directions to ${dest}.`, openUrl: url }] };
}

// ── Prospects without typing ──

export async function makeProspect(env: Env, target: string, product: Product | null): Promise<VoiceReply> {
  const p: Person | null = await findPerson(env, target);
  if (!p) return { say: `I don't know ${target} yet. Once they're in your Gmail, I can add them.` };
  if (!p.email) return { say: `I need an email address for ${p.name} to add them as a prospect.` };
  if (!product) return { say: `For ChurchFollow or ClientPulse? Say: add ${first(p.name) || p.name} as a ChurchFollow prospect.` };
  const r = await env.DB.prepare("insert into prospects (product, name, email, organization) values (?, ?, ?, ?) on conflict(product, email) do nothing")
    .bind(product, p.name, p.email.toLowerCase(), p.organization ?? "").run();
  return { say: r.meta.changes ? `Added ${p.name} as a ${PRODUCT_NAME[product]} prospect. They'll get a first email in the next batch, after your yes.` : `${p.name} is already a ${PRODUCT_NAME[product]} prospect.` };
}
