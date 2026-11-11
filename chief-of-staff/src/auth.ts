import { hashPassword, hmac, safeEqual, sha256, verifyPassword } from "./crypto";
import type { Env } from "./types";

const COOKIE = "cos_session";
const DAYS = 30;

async function storedHash(env: Env) {
  return (await env.DB.prepare("select value from settings where key = 'auth:password'").first<{ value: string }>())?.value ?? null;
}

/** Changes whenever the password changes, so old sessions stop working. */
async function passwordVersion(env: Env): Promise<string> {
  return (await sha256("v:" + ((await storedHash(env)) ?? env.OWNER_PASSWORD))).slice(0, 16);
}

export async function checkPassword(env: Env, pw: string): Promise<boolean> {
  const stored = await storedHash(env);
  if (stored) return verifyPassword(pw, stored);
  if (!env.OWNER_PASSWORD) return false;
  return safeEqual(await sha256(pw), await sha256(env.OWNER_PASSWORD));
}

export async function changePassword(env: Env, pw: string) {
  await env.DB.prepare("insert into settings (key, value) values ('auth:password', ?) on conflict(key) do update set value = excluded.value")
    .bind(await hashPassword(pw)).run();
}

export async function sessionCookie(env: Env): Promise<string> {
  const exp = Date.now() + DAYS * 86400_000;
  const payload = `${exp}.${await passwordVersion(env)}`;
  const sig = await hmac(env.SESSION_SECRET, payload);
  return `${COOKIE}=${payload}.${sig}; Path=/; HttpOnly; Secure; SameSite=Strict; Max-Age=${DAYS * 86400}`;
}
export const clearCookie = `${COOKIE}=; Path=/; HttpOnly; Secure; SameSite=Strict; Max-Age=0`;

export async function isSignedIn(req: Request, env: Env): Promise<boolean> {
  const m = (req.headers.get("cookie") ?? "").match(/(?:^|;\s*)cos_session=([^;]+)/);
  if (!m) return false;
  const [exp, ver, sig] = m[1].split(".");
  if (!exp || !ver || !sig || Number(exp) < Date.now()) return false;
  if (!safeEqual(sig, await hmac(env.SESSION_SECRET, `${exp}.${ver}`))) return false;
  return safeEqual(ver, await passwordVersion(env));
}

// ── Login rate limit: 5 wrong tries per 15 minutes per IP ──
export async function loginAllowed(env: Env, ip: string): Promise<boolean> {
  const since = Date.now() - 15 * 60_000;
  await env.DB.prepare("delete from login_attempts where at < ?").bind(since).run();
  const row = await env.DB.prepare("select count(*) as n from login_attempts where ip = ? and at >= ?").bind(ip, since).first<{ n: number }>();
  return (row?.n ?? 0) < 5;
}
export async function recordFailedLogin(env: Env, ip: string) {
  await env.DB.prepare("insert into login_attempts (ip, at) values (?, ?)").bind(ip, Date.now()).run();
}
export async function clearLogins(env: Env, ip: string) {
  await env.DB.prepare("delete from login_attempts where ip = ?").bind(ip).run();
}

// ── 6-digit passcode (used to unlock instead of the long password) ──

export async function hasPin(env: Env): Promise<boolean> {
  return Boolean(await env.DB.prepare("select 1 from settings where key = 'auth:pin'").first());
}
export async function setPin(env: Env, pin: string) {
  await env.DB.prepare("insert into settings (key, value) values ('auth:pin', ?) on conflict(key) do update set value = excluded.value")
    .bind(await hashPassword(pin)).run();
}
export async function checkPin(env: Env, pin: string): Promise<boolean> {
  if (!/^\d{6}$/.test(pin)) return false;
  const row = await env.DB.prepare("select value from settings where key = 'auth:pin'").first<{ value: string }>();
  return row ? verifyPassword(pin, row.value) : false;
}
