import "server-only";
import { SignJWT, jwtVerify } from "jose";
import { cookies } from "next/headers";
import { redirect } from "next/navigation";
import { eq } from "drizzle-orm";
import { db, churches, type Church } from "@/db";

const PASTOR_COOKIE = "cf_session";
const ADMIN_COOKIE = "cf_admin";

function secret() {
  const s = process.env.SESSION_SECRET;
  if (!s || s.length < 32) {
    throw new Error("SESSION_SECRET must be set to a random string of at least 32 characters.");
  }
  return new TextEncoder().encode(s);
}

async function sign(payload: Record<string, unknown>, maxAgeDays: number) {
  return new SignJWT(payload)
    .setProtectedHeader({ alg: "HS256" })
    .setIssuedAt()
    .setExpirationTime(`${maxAgeDays}d`)
    .sign(secret());
}

async function verify(token: string | undefined) {
  if (!token) return null;
  try {
    const { payload } = await jwtVerify(token, secret());
    return payload;
  } catch {
    return null;
  }
}

const cookieOpts = (maxAgeDays: number) => ({
  httpOnly: true,
  secure: process.env.NODE_ENV === "production",
  sameSite: "lax" as const,
  path: "/",
  maxAge: maxAgeDays * 86400,
});

// ---------- Pastor sessions ----------

export async function startPastorSession(churchId: string) {
  const jar = await cookies();
  jar.set(PASTOR_COOKIE, await sign({ sub: churchId, role: "pastor" }, 30), cookieOpts(30));
}

export async function endPastorSession() {
  (await cookies()).delete(PASTOR_COOKIE);
}

export async function currentChurch(): Promise<Church | null> {
  const payload = await verify((await cookies()).get(PASTOR_COOKIE)?.value);
  if (!payload || payload.role !== "pastor" || typeof payload.sub !== "string") return null;
  const [church] = await db.select().from(churches).where(eq(churches.id, payload.sub)).limit(1);
  return church ?? null;
}

export async function requireChurch(): Promise<Church> {
  const church = await currentChurch();
  if (!church) redirect("/login");
  return church;
}

// ---------- Owner (admin) sessions ----------

export async function startAdminSession() {
  (await cookies()).set(ADMIN_COOKIE, await sign({ role: "owner" }, 7), {
    ...cookieOpts(7),
    sameSite: "strict",
  });
}

export async function endAdminSession() {
  (await cookies()).delete(ADMIN_COOKIE);
}

export async function isAdmin(): Promise<boolean> {
  const payload = await verify((await cookies()).get(ADMIN_COOKIE)?.value);
  return payload?.role === "owner";
}

export async function requireAdmin() {
  if (!(await isAdmin())) redirect("/admin/login");
}
