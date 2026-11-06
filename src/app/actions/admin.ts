"use server";
import { timingSafeEqual, createHash } from "node:crypto";
import { redirect } from "next/navigation";
import { startAdminSession, endAdminSession } from "@/lib/session";

const attempts = new Map<string, { n: number; at: number }>();

function same(a: string, b: string) {
  const ha = createHash("sha256").update(a).digest();
  const hb = createHash("sha256").update(b).digest();
  return timingSafeEqual(ha, hb);
}

export async function adminLogin(_prev: { error?: string }, fd: FormData): Promise<{ error?: string }> {
  const expected = process.env.ADMIN_PASSWORD;
  if (!expected || expected.length < 8) {
    return { error: "Owner dashboard is disabled. Set ADMIN_PASSWORD (8+ characters) in your environment." };
  }
  // Light brute-force protection (per server instance).
  const key = "owner";
  const a = attempts.get(key);
  if (a && a.n >= 5 && Date.now() - a.at < 10 * 60 * 1000) {
    return { error: "Too many attempts. Try again in 10 minutes." };
  }
  await new Promise((r) => setTimeout(r, 400));
  if (!same(String(fd.get("password") ?? ""), expected)) {
    attempts.set(key, { n: (a && Date.now() - a.at < 10 * 60 * 1000 ? a.n : 0) + 1, at: Date.now() });
    return { error: "Incorrect password." };
  }
  attempts.delete(key);
  await startAdminSession();
  redirect("/admin");
}

export async function adminLogout() {
  await endAdminSession();
  redirect("/admin/login");
}
