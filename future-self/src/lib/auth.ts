import "server-only";
import { SignJWT, jwtVerify } from "jose";
import { cookies } from "next/headers";
import { createHash, timingSafeEqual } from "node:crypto";

export const USER_COOKIE = "fs_uid";
export const OWNER_COOKIE = "fs_owner";

function secret() {
  const s = process.env.SESSION_SECRET;
  if (!s || s.length < 32) throw new Error("SESSION_SECRET must be set to a random string of at least 32 characters.");
  return new TextEncoder().encode(s);
}

async function sign(payload: Record<string, unknown>, days: number) {
  return new SignJWT(payload).setProtectedHeader({ alg: "HS256" }).setIssuedAt().setExpirationTime(`${days}d`).sign(secret());
}

async function verify(token: string | undefined) {
  if (!token) return null;
  try {
    return (await jwtVerify(token, secret(), { algorithms: ["HS256"] })).payload;
  } catch {
    return null;
  }
}

const secure = process.env.NODE_ENV === "production";

// ───────────── App users (anonymous device id) ─────────────

const USER_DAYS = 400;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

export async function currentUserId(): Promise<string | null> {
  const p = await verify((await cookies()).get(USER_COOKIE)?.value);
  return p?.typ === "user" && typeof p.sub === "string" && UUID.test(p.sub) ? p.sub : null;
}

export async function setUserCookie(userId: string) {
  (await cookies()).set(USER_COOKIE, await sign({ typ: "user", sub: userId }, USER_DAYS), {
    httpOnly: true, secure, sameSite: "strict", path: "/", maxAge: USER_DAYS * 86400,
  });
}

// ───────────── Owner ─────────────

const OWNER_DAYS = 7;

export function ownerConfigured() {
  return (process.env.OWNER_PASSWORD ?? "").length >= 12;
}

/** Constant-time password check (hashing first makes lengths equal). */
export function ownerPasswordMatches(input: string) {
  const real = process.env.OWNER_PASSWORD ?? "";
  if (real.length < 12) return false;
  const a = createHash("sha256").update(input).digest();
  const b = createHash("sha256").update(real).digest();
  return timingSafeEqual(a, b);
}

/** A fingerprint of the current password, so changing OWNER_PASSWORD signs out every old owner session. */
function passwordTag() {
  return createHash("sha256").update("owner:" + (process.env.OWNER_PASSWORD ?? "")).digest("base64url").slice(0, 16);
}

export async function setOwnerCookie() {
  (await cookies()).set(OWNER_COOKIE, await sign({ typ: "owner", pw: passwordTag() }, OWNER_DAYS), {
    httpOnly: true, secure, sameSite: "strict", path: "/owner", maxAge: OWNER_DAYS * 86400,
  });
}

export async function clearOwnerCookie() {
  (await cookies()).set(OWNER_COOKIE, "", { httpOnly: true, secure, sameSite: "strict", path: "/owner", maxAge: 0 });
}

export async function isOwner(): Promise<boolean> {
  if (!ownerConfigured()) return false;
  const p = await verify((await cookies()).get(OWNER_COOKIE)?.value);
  return p?.typ === "owner" && p.pw === passwordTag();
}
