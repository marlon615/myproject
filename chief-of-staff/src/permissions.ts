import type { Env } from "./types";

/** What Chief may use. Asked one at a time, by voice, the first time the app opens. */
export const PERMS = ["email", "contacts", "calls", "texts", "calendar", "reminders", "maps"] as const;
export type Perm = (typeof PERMS)[number];

export const PERM_ASK: Record<Perm, string> = {
  email: "First: can I read your Gmail inbox and send the emails you approve from your Gmail?",
  contacts: "Can I build your contacts from the people in your Gmail, so you can just say a name?",
  calls: "Can I place calls for you? I'll always ask first, and your phone shows the call button.",
  texts: "Can I write text messages for you? I'll read each one to you, and your phone shows the send button.",
  calendar: "Can I read your Google Calendar and add events for you?",
  reminders: "Can I keep reminders for you, and email you when one is due?",
  maps: "Can I open directions in your maps app when you ask?",
};

export const PERM_LABEL: Record<Perm, string> = {
  email: "email", contacts: "contacts", calls: "calls", texts: "texts", calendar: "calendar", reminders: "reminders", maps: "maps",
};

export async function getPerms(env: Env): Promise<Partial<Record<Perm, boolean>>> {
  const { results } = await env.DB.prepare("select key, value from settings where key like 'perm:%'").all<{ key: string; value: string }>();
  const out: Partial<Record<Perm, boolean>> = {};
  for (const r of results) out[r.key.slice(5) as Perm] = r.value === "yes";
  return out;
}

export async function allowed(env: Env, p: Perm): Promise<boolean> {
  const row = await env.DB.prepare("select value from settings where key = ?").bind(`perm:${p}`).first<{ value: string }>();
  return row?.value === "yes";
}

export async function setPerm(env: Env, p: Perm, yes: boolean) {
  await env.DB.prepare("insert into settings (key, value) values (?, ?) on conflict(key) do update set value = excluded.value")
    .bind(`perm:${p}`, yes ? "yes" : "no").run();
}

export async function setupDone(env: Env) {
  const perms = await getPerms(env);
  return PERMS.every((p) => p in perms);
}

export function isPerm(v: string): v is Perm {
  return (PERMS as readonly string[]).includes(v);
}
