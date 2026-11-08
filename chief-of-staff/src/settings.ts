import { decrypt, encrypt } from "./crypto";
import type { Env, Product } from "./types";

export interface Settings {
  senderName: string;
  senderEmail: string;
  replyTo: string;
  mailingAddress: string;
  dailyLimit: number;
  followUpDays: number;
  maxTouches: number;
  tone: string;
  product_clientpulse: string;
  product_churchfollow: string;
  link_clientpulse: string;
  link_churchfollow: string;
}

export const DEFAULTS: Settings = {
  senderName: "",
  senderEmail: "",
  replyTo: "",
  mailingAddress: "",
  dailyLimit: 10,
  followUpDays: 4,
  maxTouches: 3,
  tone: "Warm, short and plain-spoken. No hype, no jargon. One clear ask.",
  product_clientpulse:
    "ClientPulse: (edit this in Settings) one or two sentences on what ClientPulse does, who it is for, and the main result customers get.",
  product_churchfollow:
    "ChurchFollow: done-for-you first-time visitor follow-up for small churches. Guests scan a QR code on a pew card, and ChurchFollow automatically texts them a welcome right away, a check-in from the pastor on day 3, and an invitation back on day 7. Pastors see every visitor, reply and return on a simple dashboard. $39/month, nothing to install, set up in 10 minutes.",
  link_clientpulse: "",
  link_churchfollow: "",
};

const NUM = new Set<string>(["dailyLimit", "followUpDays", "maxTouches"]);

export async function getSettings(env: Env): Promise<Settings> {
  const { results } = await env.DB.prepare("select key, value from settings").all<{ key: string; value: string }>();
  const s: Record<string, unknown> = { ...DEFAULTS };
  for (const r of results) {
    if (!(r.key in DEFAULTS)) continue;
    s[r.key] = NUM.has(r.key) ? Number(r.value) || (DEFAULTS as unknown as Record<string, number>)[r.key] : r.value;
  }
  return s as unknown as Settings;
}

export async function saveSettings(env: Env, s: Partial<Settings>) {
  const stmts = Object.entries(s)
    .filter(([k]) => k in DEFAULTS)
    .map(([k, v]) => env.DB.prepare("insert into settings (key, value) values (?, ?) on conflict(key) do update set value = excluded.value").bind(k, String(v)));
  if (stmts.length) await env.DB.batch(stmts);
}

export function productDescription(s: Settings, p: Product) {
  return p === "clientpulse" ? s.product_clientpulse : s.product_churchfollow;
}
export function productLink(s: Settings, p: Product) {
  return p === "clientpulse" ? s.link_clientpulse : s.link_churchfollow;
}

// ── Keys the owner pastes in Settings, stored encrypted, never shown again ──
export type SecretName = "anthropic" | "resend";

export async function getSecret(env: Env, name: SecretName): Promise<string | null> {
  const row = await env.DB.prepare("select value from settings where key = ?").bind(`secret:${name}`).first<{ value: string }>();
  return row ? decrypt(env.SESSION_SECRET, row.value) : null;
}
export async function setSecret(env: Env, name: SecretName, value: string | null) {
  if (!value) {
    await env.DB.prepare("delete from settings where key = ?").bind(`secret:${name}`).run();
    return;
  }
  await env.DB.prepare("insert into settings (key, value) values (?, ?) on conflict(key) do update set value = excluded.value")
    .bind(`secret:${name}`, await encrypt(env.SESSION_SECRET, value)).run();
}
export async function hasSecret(env: Env, name: SecretName) {
  return Boolean(await env.DB.prepare("select 1 from settings where key = ?").bind(`secret:${name}`).first());
}
