"use server";

import { headers } from "next/headers";
import { redirect } from "next/navigation";
import { clearOwnerCookie, ownerConfigured, ownerPasswordMatches, setOwnerCookie } from "@/lib/auth";
import { allow, clientIp } from "@/lib/ratelimit";

export async function ownerLogin(_prev: string | null, form: FormData): Promise<string | null> {
  if (!ownerConfigured()) return "The owner password isn't set up on the server yet (OWNER_PASSWORD, 12+ characters).";
  const ip = clientIp(await headers());
  if (!allow(`owner-login:${ip}`, 5, 15 * 60 * 1000)) return "Too many tries. Wait 15 minutes.";
  const password = String(form.get("password") ?? "");
  if (!ownerPasswordMatches(password)) {
    await new Promise((r) => setTimeout(r, 600));
    return "Wrong password.";
  }
  await setOwnerCookie();
  redirect("/owner");
}

export async function ownerLogout() {
  await clearOwnerCookie();
  redirect("/owner/login");
}
