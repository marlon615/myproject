"use server";
import bcrypt from "bcryptjs";
import { eq } from "drizzle-orm";
import { redirect } from "next/navigation";
import { db, churches } from "@/db";
import { startPastorSession, endPastorSession, requireChurch } from "@/lib/session";
import { slugify, randomSuffix, addDays } from "@/lib/utils";
import { TRIAL_DAYS } from "@/lib/config";

export type FormState = { error?: string; fieldErrors?: Record<string, string>; ok?: string; values?: Record<string, string> };

const LIMITS = {
  name: 100, pastorName: 80, city: 80, serviceTimes: 400, whatToExpect: 1200, welcomeMessage: 320,
};

function str(fd: FormData, key: string) {
  return String(fd.get(key) ?? "").trim();
}

function churchFields(fd: FormData) {
  const v = {
    name: str(fd, "name"),
    city: str(fd, "city"),
    pastorName: str(fd, "pastorName"),
    serviceTimes: str(fd, "serviceTimes"),
    whatToExpect: str(fd, "whatToExpect"),
    welcomeMessage: str(fd, "welcomeMessage"),
  };
  const errors: Record<string, string> = {};
  if (!v.name) errors.name = "Please enter your church's name.";
  if (!v.pastorName) errors.pastorName = "How should guests address you? e.g. Pastor Mike";
  if (!v.serviceTimes) errors.serviceTimes = "Add at least one service time.";
  if (!v.whatToExpect) errors.whatToExpect = "A sentence or two helps guests feel at ease.";
  if (!v.welcomeMessage) errors.welcomeMessage = "Write a short welcome — it goes in the first text.";
  for (const [k, max] of Object.entries(LIMITS)) {
    if ((v as Record<string, string>)[k].length > max) errors[k] = `Please keep this under ${max} characters.`;
  }
  return { v, errors };
}

export async function signup(_prev: FormState, fd: FormData): Promise<FormState> {
  const { v, errors } = churchFields(fd);
  const email = str(fd, "email").toLowerCase();
  const password = String(fd.get("password") ?? "");
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) errors.email = "Please enter a valid email.";
  if (password.length < 8) errors.password = "Use at least 8 characters.";
  const values = { ...v, email };
  if (Object.keys(errors).length) return { fieldErrors: errors, values };

  const [existing] = await db.select({ id: churches.id }).from(churches).where(eq(churches.email, email)).limit(1);
  if (existing) return { fieldErrors: { email: "An account with this email already exists. Try logging in." }, values };

  const passwordHash = await bcrypt.hash(password, 10);
  let church;
  for (let attempt = 0; attempt < 5 && !church; attempt++) {
    const slug = `${slugify(v.name)}-${randomSuffix(attempt < 2 ? 4 : 6)}`;
    try {
      [church] = await db
        .insert(churches)
        .values({
          ...v,
          city: v.city || null,
          slug,
          email,
          passwordHash,
          trialEndsAt: addDays(new Date(), TRIAL_DAYS),
        })
        .returning();
    } catch (err) {
      if (!String((err as Error)?.message ?? err).includes("churches_slug_idx")) throw err;
    }
  }
  if (!church) return { error: "Something went wrong creating your account. Please try again.", values };

  await startPastorSession(church.id);
  redirect("/dashboard/share?welcome=1");
}

export async function login(_prev: FormState, fd: FormData): Promise<FormState> {
  const email = str(fd, "email").toLowerCase();
  const password = String(fd.get("password") ?? "");
  const [church] = await db.select().from(churches).where(eq(churches.email, email)).limit(1);
  // Compare against a dummy hash when the account doesn't exist to keep timing similar.
  const ok = await bcrypt.compare(password, church?.passwordHash ?? "$2b$10$2GvcYJGk9Pe.PXQBoxO7AO2SlprGHN4pBAEFC.k3nM6ELu96zfyaa");
  if (!church || !ok) return { error: "That email and password don't match.", values: { email } };
  await startPastorSession(church.id);
  redirect("/dashboard");
}

export async function logout() {
  await endPastorSession();
  redirect("/");
}

export async function updateChurch(_prev: FormState, fd: FormData): Promise<FormState> {
  const church = await requireChurch();
  const { v, errors } = churchFields(fd);
  if (Object.keys(errors).length) return { fieldErrors: errors, values: v };
  await db.update(churches).set({ ...v, city: v.city || null }).where(eq(churches.id, church.id));
  return { ok: "Saved! New guests will see your updated info." };
}
