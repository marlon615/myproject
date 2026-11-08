/** Chief's phone line, through Twilio: buy a number, point it at Chief, and verify every call really comes from Twilio. */
import { b64url, safeEqual } from "./crypto";
import { getSecret, setSecret } from "./settings";
import type { Env } from "./types";

export interface TwilioCreds { sid: string; token: string }

export async function twilioCreds(env: Env): Promise<TwilioCreds | null> {
  const raw = await getSecret(env, "twilio");
  if (!raw) return null;
  try { return JSON.parse(raw) as TwilioCreds; } catch { return null; }
}

async function setting(env: Env, key: string) {
  return (await env.DB.prepare("select value from settings where key = ?").bind(key).first<{ value: string }>())?.value ?? null;
}
async function put(env: Env, key: string, value: string) {
  await env.DB.prepare("insert into settings (key, value) values (?, ?) on conflict(key) do update set value = excluded.value").bind(key, value).run();
}

export const chiefNumber = (env: Env) => setting(env, "phone:chief");
export const ownerNumber = (env: Env) => setting(env, "phone:owner");
export const setOwnerNumber = (env: Env, n: string) => put(env, "phone:owner", n);

/** A secret piece of the webhook address, so nobody can guess where Chief listens. */
export async function voiceSecret(env: Env) {
  let s = await setting(env, "voice:secret");
  if (!s) { s = b64url(crypto.getRandomValues(new Uint8Array(18))); await put(env, "voice:secret", s); }
  return s;
}

function api(c: TwilioCreds, path: string, init: RequestInit = {}) {
  return fetch(`https://api.twilio.com/2010-04-01/Accounts/${c.sid}${path}`, {
    ...init,
    headers: { Authorization: "Basic " + btoa(`${c.sid}:${c.token}`), ...(init.body ? { "Content-Type": "application/x-www-form-urlencoded" } : {}), ...(init.headers ?? {}) },
  });
}

export function cleanUS(raw: string): string | null {
  const d = raw.replace(/[^\d+]/g, "");
  const n = d.replace(/^\+?1(?=\d{10}$)/, "");
  if (/^\d{10}$/.test(n)) return `+1${n}`;
  if (/^\+\d{10,15}$/.test(d)) return d;
  return null;
}

/**
 * Saves Twilio details after checking them, then makes sure Chief has a number whose calls come to this app.
 * Buys a local number near the owner's area code the first time (about $1.15 a month on Twilio).
 */
export async function connectTwilio(env: Env, creds: TwilioCreds, origin: string): Promise<{ ok: true; number: string } | { ok: false; error: string }> {
  if (!/^AC[0-9a-f]{32}$/i.test(creds.sid) || creds.token.length < 20) return { ok: false, error: "That Account SID or Auth Token doesn't look right. Copy both again from the Twilio console." };
  const check = await api(creds, ".json");
  if (check.status === 401) return { ok: false, error: "Twilio didn't accept that Account SID and Auth Token." };
  if (!check.ok) return { ok: false, error: `Twilio answered ${check.status}.` };
  await setSecret(env, "twilio", JSON.stringify(creds));
  const voiceUrl = `${origin}/voice/${await voiceSecret(env)}/start`;

  // Already have a number? Point it at Chief again.
  const existingSid = await setting(env, "phone:sid");
  if (existingSid) {
    const r = await api(creds, `/IncomingPhoneNumbers/${existingSid}.json`, { method: "POST", body: new URLSearchParams({ VoiceUrl: voiceUrl, VoiceMethod: "POST" }) });
    if (r.ok) return { ok: true, number: (await chiefNumber(env))! };
  }
  // Reuse a number already on the account if there's exactly one, else buy one.
  const owned = (await (await api(creds, "/IncomingPhoneNumbers.json?PageSize=20")).json()) as { incoming_phone_numbers?: { sid: string; phone_number: string }[] };
  let num = owned.incoming_phone_numbers?.length === 1 ? owned.incoming_phone_numbers[0] : null;
  if (!num) {
    const owner = await ownerNumber(env);
    const area = owner?.startsWith("+1") ? owner.slice(2, 5) : "";
    let avail = (await (await api(creds, `/AvailablePhoneNumbers/US/Local.json?VoiceEnabled=true&PageSize=1${area ? `&AreaCode=${area}` : ""}`)).json()) as { available_phone_numbers?: { phone_number: string }[] };
    if (!avail.available_phone_numbers?.length && area) avail = (await (await api(creds, `/AvailablePhoneNumbers/US/Local.json?VoiceEnabled=true&PageSize=1`)).json()) as typeof avail;
    const pick = avail.available_phone_numbers?.[0]?.phone_number;
    if (!pick) return { ok: false, error: "Twilio has no phone numbers available right now. Try again in a minute." };
    const buy = await api(creds, "/IncomingPhoneNumbers.json", { method: "POST", body: new URLSearchParams({ PhoneNumber: pick, VoiceUrl: voiceUrl, VoiceMethod: "POST", FriendlyName: "Chief" }) });
    const bought = (await buy.json()) as { sid?: string; phone_number?: string; message?: string };
    if (!buy.ok || !bought.sid) return { ok: false, error: `Twilio couldn't buy a number: ${bought.message ?? buy.status}. A trial account may need a payment method first.` };
    num = { sid: bought.sid, phone_number: bought.phone_number! };
  } else {
    await api(creds, `/IncomingPhoneNumbers/${num.sid}.json`, { method: "POST", body: new URLSearchParams({ VoiceUrl: voiceUrl, VoiceMethod: "POST" }) });
  }
  await put(env, "phone:sid", num.sid);
  await put(env, "phone:chief", num.phone_number);
  return { ok: true, number: num.phone_number };
}

/** Checks Twilio's signature on a webhook (HMAC-SHA1 of the full URL plus the sorted form fields). */
export async function validTwilioRequest(env: Env, url: string, form: FormData, signature: string | null): Promise<boolean> {
  const c = await twilioCreds(env);
  if (!c || !signature) return false;
  const keys = [...new Set([...form.keys()])].sort();
  let data = url;
  for (const k of keys) data += k + (form.get(k) ?? "");
  const key = await crypto.subtle.importKey("raw", new TextEncoder().encode(c.token), { name: "HMAC", hash: "SHA-1" }, false, ["sign"]);
  const mac = new Uint8Array(await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(data)));
  let bin = "";
  for (const b of mac) bin += String.fromCharCode(b);
  return safeEqual(btoa(bin), signature);
}

export function prettyNumber(e164: string | null) {
  if (!e164) return "";
  const m = e164.match(/^\+1(\d{3})(\d{3})(\d{4})$/);
  return m ? `(${m[1]}) ${m[2]}-${m[3]}` : e164;
}
