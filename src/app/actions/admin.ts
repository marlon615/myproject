"use server";
import { timingSafeEqual, createHash } from "node:crypto";
import { redirect } from "next/navigation";
import { revalidatePath } from "next/cache";
import { eq } from "drizzle-orm";
import { db, contractors } from "@/db";
import { startAdminSession, endAdminSession, requireAdmin } from "@/lib/session";
import { OWNER_EMAIL } from "@/lib/config";
import { normalizeUsPhone } from "@/lib/utils";

const attempts = new Map<string, { n: number; at: number }>();

function same(a: string, b: string) {
  const ha = createHash("sha256").update(a).digest();
  const hb = createHash("sha256").update(b).digest();
  return timingSafeEqual(ha, hb);
}

/** Owner login: the email must be OWNER_EMAIL and the password must match ADMIN_PASSWORD. */
export async function adminLogin(_prev: { error?: string }, fd: FormData): Promise<{ error?: string }> {
  const expected = process.env.ADMIN_PASSWORD;
  if (!expected || expected.length < 12) {
    return { error: "Owner dashboard is disabled. Set ADMIN_PASSWORD (12+ characters) in your environment." };
  }
  // Light brute-force protection (per server instance).
  const key = "owner";
  const a = attempts.get(key);
  if (a && a.n >= 5 && Date.now() - a.at < 10 * 60 * 1000) {
    return { error: "Too many attempts. Try again in 10 minutes." };
  }
  await new Promise((r) => setTimeout(r, 400));
  const email = String(fd.get("email") ?? "").trim().toLowerCase();
  const okEmail = same(email, OWNER_EMAIL);
  const okPassword = same(String(fd.get("password") ?? ""), expected);
  if (!okEmail || !okPassword) {
    attempts.set(key, { n: (a && Date.now() - a.at < 10 * 60 * 1000 ? a.n : 0) + 1, at: Date.now() });
    return { error: "This dashboard is private to the CallCairn owner." };
  }
  attempts.delete(key);
  await startAdminSession(OWNER_EMAIL);
  redirect("/admin");
}

export async function adminLogout() {
  await endAdminSession();
  redirect("/admin/login");
}

/** Owner: set or clear a contractor's CallCairn number by hand (e.g. one bought in Twilio's console). */
export async function adminSetNumber(fd: FormData) {
  await requireAdmin();
  const id = String(fd.get("id") ?? "");
  if (!/^[0-9a-f-]{36}$/i.test(id)) redirect("/admin/signups");
  const raw = String(fd.get("aiNumber") ?? "").trim();
  const aiNumber = raw ? normalizeUsPhone(raw) : null;
  if (raw && !aiNumber) redirect(`/admin/signups/${id}?error=number`);
  let ok = true;
  try {
    await db.update(contractors).set({ aiNumber, twilioNumberSid: null }).where(eq(contractors.id, id));
  } catch {
    ok = false;
  }
  revalidatePath(`/admin/signups/${id}`);
  redirect(`/admin/signups/${id}?${ok ? "saved=1" : "error=taken"}`);
}
