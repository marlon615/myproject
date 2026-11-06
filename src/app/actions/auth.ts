"use server";
import bcrypt from "bcryptjs";
import { and, eq } from "drizzle-orm";
import { redirect } from "next/navigation";
import { revalidatePath } from "next/cache";
import { db, contractors, bookings } from "@/db";
import { startUserSession, endUserSession, requireContractor } from "@/lib/session";
import { randomToken, addDays, normalizeUsPhone } from "@/lib/utils";
import { TRIAL_DAYS, US_TIMEZONES, appUrl } from "@/lib/config";
import { canProvisionNumbers, provisionNumber } from "@/lib/twilio-numbers";
import { serviceActive } from "@/lib/billing";

export type FormState = { error?: string; fieldErrors?: Record<string, string>; ok?: string; values?: Record<string, string> };

const str = (fd: FormData, key: string) => String(fd.get(key) ?? "").trim();
const ZONES = new Set<string>(US_TIMEZONES.map((z) => z.value));

function businessFields(fd: FormData) {
  const v = {
    businessName: str(fd, "businessName"),
    ownerName: str(fd, "ownerName"),
    businessPhone: str(fd, "businessPhone"),
    alertPhone: str(fd, "alertPhone"),
    serviceArea: str(fd, "serviceArea"),
    timezone: str(fd, "timezone") || "America/Chicago",
  };
  const errors: Record<string, string> = {};
  if (!v.businessName) errors.businessName = "Enter your company name.";
  if (v.businessName.length > 80) errors.businessName = "Keep it under 80 characters.";
  if (!v.ownerName) errors.ownerName = "Enter your name.";
  if (v.ownerName.length > 80) errors.ownerName = "Keep it under 80 characters.";
  if (v.serviceArea.length > 160) errors.serviceArea = "Keep it under 160 characters.";
  const businessPhone = normalizeUsPhone(v.businessPhone);
  if (!businessPhone) errors.businessPhone = "Enter a 10-digit US phone number.";
  const alertPhone = normalizeUsPhone(v.alertPhone || v.businessPhone);
  if (!alertPhone) errors.alertPhone = "Enter a 10-digit US mobile number.";
  if (!ZONES.has(v.timezone)) errors.timezone = "Pick your time zone.";
  return { v, errors, businessPhone: businessPhone!, alertPhone: alertPhone! };
}

export async function signup(_prev: FormState, fd: FormData): Promise<FormState> {
  const { v, errors, businessPhone, alertPhone } = businessFields(fd);
  const email = str(fd, "email").toLowerCase();
  const password = String(fd.get("password") ?? "");
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) errors.email = "Enter a valid email.";
  if (password.length < 8) errors.password = "Use at least 8 characters.";
  if (fd.get("agree") !== "on") errors.agree = "Please confirm to continue.";
  const values = { ...v, email };
  if (Object.keys(errors).length) return { fieldErrors: errors, values };

  const [existing] = await db.select({ id: contractors.id }).from(contractors).where(eq(contractors.email, email)).limit(1);
  if (existing) return { fieldErrors: { email: "An account with this email already exists. Try logging in." }, values };

  const [c] = await db
    .insert(contractors)
    .values({
      businessName: v.businessName,
      ownerName: v.ownerName,
      serviceArea: v.serviceArea || null,
      timezone: v.timezone,
      businessPhone,
      alertPhone,
      email,
      passwordHash: await bcrypt.hash(password, 10),
      calendarToken: randomToken(32),
      trialEndsAt: addDays(new Date(), TRIAL_DAYS),
    })
    .returning();
  await startUserSession(c.id);
  redirect("/dashboard/setup?welcome=1");
}

export async function login(_prev: FormState, fd: FormData): Promise<FormState> {
  const email = str(fd, "email").toLowerCase();
  const password = String(fd.get("password") ?? "");
  const [c] = await db.select().from(contractors).where(eq(contractors.email, email)).limit(1);
  // Compare against a dummy hash when the account doesn't exist to keep timing similar.
  const ok = await bcrypt.compare(password, c?.passwordHash ?? "$2b$10$2GvcYJGk9Pe.PXQBoxO7AO2SlprGHN4pBAEFC.k3nM6ELu96zfyaa");
  if (!c || !ok) return { error: "That email and password don't match.", values: { email } };
  await startUserSession(c.id);
  redirect("/dashboard");
}

export async function logout() {
  await endUserSession();
  redirect("/");
}

export async function updateSettings(_prev: FormState, fd: FormData): Promise<FormState> {
  const c = await requireContractor();
  const { v, errors, businessPhone, alertPhone } = businessFields(fd);
  const hoursStart = Number(str(fd, "hoursStart"));
  const hoursEnd = Number(str(fd, "hoursEnd"));
  const slotMinutes = Number(str(fd, "slotMinutes"));
  const jobsPerSlot = Number(str(fd, "jobsPerSlot"));
  const days = fd.getAll("workDays").map(String).filter((d) => /^[0-6]$/.test(d));
  const emergencyNote = str(fd, "emergencyNote");
  if (!Number.isInteger(hoursStart) || !Number.isInteger(hoursEnd) || hoursStart < 0 || hoursEnd > 24 || hoursEnd <= hoursStart) {
    errors.hours = "Closing time must be after opening time.";
  }
  if (![60, 90, 120, 180, 240].includes(slotMinutes)) errors.slotMinutes = "Pick a window length.";
  if (!Number.isInteger(jobsPerSlot) || jobsPerSlot < 1 || jobsPerSlot > 20) errors.jobsPerSlot = "Between 1 and 20.";
  if (!days.length) errors.workDays = "Pick at least one day.";
  if (emergencyNote.length > 200) errors.emergencyNote = "Keep it under 200 characters.";
  const values = { ...v, emergencyNote };
  if (Object.keys(errors).length) return { fieldErrors: errors, values };

  await db
    .update(contractors)
    .set({
      businessName: v.businessName,
      ownerName: v.ownerName,
      serviceArea: v.serviceArea || null,
      timezone: v.timezone,
      businessPhone,
      alertPhone,
      hoursStart,
      hoursEnd,
      slotMinutes,
      jobsPerSlot,
      workDays: days.join(","),
      emergencyDispatch: fd.get("emergencyDispatch") === "on",
      emergencyNote: emergencyNote || null,
    })
    .where(eq(contractors.id, c.id));
  revalidatePath("/dashboard", "layout");
  return { ok: "Saved. The assistant uses these settings on the next call." };
}

/** Buy a local CallCairn number in Twilio and wire it up. */
export async function getNumber(): Promise<void> {
  const c = await requireContractor();
  if (c.aiNumber) redirect("/dashboard/setup");
  if (!serviceActive(c)) redirect("/dashboard/billing");
  if (!canProvisionNumbers()) redirect("/dashboard/setup?error=not_configured");
  try {
    const n = await provisionNumber({ businessPhone: c.businessPhone, baseUrl: await appUrl(), label: c.businessName });
    await db.update(contractors).set({ aiNumber: n.phoneNumber, twilioNumberSid: n.sid }).where(eq(contractors.id, c.id));
  } catch (err) {
    console.error("[setup] number provisioning failed", err);
    redirect("/dashboard/setup?error=provision_failed");
  }
  revalidatePath("/dashboard", "layout");
  redirect("/dashboard/setup?number=1");
}

export async function cancelBooking(fd: FormData) {
  const c = await requireContractor();
  const id = String(fd.get("id") ?? "");
  if (!/^[0-9a-f-]{36}$/i.test(id)) return;
  await db
    .update(bookings)
    .set({ status: "canceled", updatedAt: new Date() })
    .where(and(eq(bookings.id, id), eq(bookings.contractorId, c.id)));
  revalidatePath("/dashboard", "layout");
}

export async function rotateCalendarLink() {
  const c = await requireContractor();
  await db.update(contractors).set({ calendarToken: randomToken(32) }).where(eq(contractors.id, c.id));
  revalidatePath("/dashboard/setup");
}
