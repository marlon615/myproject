import "server-only";
import { SignJWT, jwtVerify } from "jose";
import { cookies } from "next/headers";
import { redirect } from "next/navigation";
import { eq } from "drizzle-orm";
import { db, contractors, type Contractor } from "@/db";
import { OWNER_EMAIL } from "@/lib/config";

const USER_COOKIE = "cc_session";
const ADMIN_COOKIE = "cc_owner";

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

// ---------- Contractor sessions ----------

export async function startUserSession(contractorId: string) {
  const jar = await cookies();
  jar.set(USER_COOKIE, await sign({ sub: contractorId, role: "contractor" }, 30), cookieOpts(30));
}

export async function endUserSession() {
  (await cookies()).delete(USER_COOKIE);
}

export async function currentContractor(): Promise<Contractor | null> {
  const payload = await verify((await cookies()).get(USER_COOKIE)?.value);
  if (!payload || payload.role !== "contractor" || typeof payload.sub !== "string") return null;
  const [c] = await db.select().from(contractors).where(eq(contractors.id, payload.sub)).limit(1);
  return c ?? null;
}

export async function requireContractor(): Promise<Contractor> {
  const c = await currentContractor();
  if (!c) redirect("/login");
  return c;
}

// ---------- Owner (admin) sessions ----------
// Only OWNER_EMAIL can hold an owner session; the email is inside the signed token and
// re-checked on every request, so changing OWNER_EMAIL instantly locks out old sessions.

export async function startAdminSession(email: string) {
  if (email !== OWNER_EMAIL) throw new Error("Not the owner");
  (await cookies()).set(ADMIN_COOKIE, await sign({ role: "owner", email }, 7), {
    ...cookieOpts(7),
    sameSite: "strict",
  });
}

export async function endAdminSession() {
  (await cookies()).delete(ADMIN_COOKIE);
}

export async function isAdmin(): Promise<boolean> {
  const payload = await verify((await cookies()).get(ADMIN_COOKIE)?.value);
  return payload?.role === "owner" && payload.email === OWNER_EMAIL;
}

export async function requireAdmin() {
  if (!(await isAdmin())) redirect("/admin/login");
}

/** Record that the contractor was here, at most once an hour (powers "last activity" in /admin). */
export async function touchLastSeen(c: Contractor) {
  const last = c.lastSeenAt ? new Date(c.lastSeenAt).getTime() : 0;
  if (Date.now() - last < 60 * 60 * 1000) return;
  await db.update(contractors).set({ lastSeenAt: new Date() }).where(eq(contractors.id, c.id));
}
