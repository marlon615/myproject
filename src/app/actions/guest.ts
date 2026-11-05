"use server";
import { after } from "next/server";
import { redirect } from "next/navigation";
import { and, desc, eq, gte } from "drizzle-orm";
import { db, churches, visitors } from "@/db";
import { normalizeUsPhone } from "@/lib/utils";
import { scheduleFollowUps, sendMessage } from "@/lib/messaging";
import { appUrl } from "@/lib/config";

export type GuestFormState = { error?: string; firstName?: string; phone?: string };

export async function submitGuest(slug: string, _prev: GuestFormState, fd: FormData): Promise<GuestFormState> {
  const firstName = String(fd.get("firstName") ?? "").trim().slice(0, 40);
  const phoneRaw = String(fd.get("phone") ?? "").trim();
  const consent = fd.get("consent") === "on";

  // Honeypot: real people never fill this hidden field.
  if (String(fd.get("website") ?? "")) redirect(`/g/${slug}/welcome`);

  if (!firstName) return { error: "Please tell us your first name.", firstName, phone: phoneRaw };
  const phone = normalizeUsPhone(phoneRaw);
  if (!phone) return { error: "Please enter a valid US mobile number.", firstName, phone: phoneRaw };
  if (!consent) return { error: "Please check the box so we can text you.", firstName, phone: phoneRaw };

  const [church] = await db.select().from(churches).where(eq(churches.slug, slug)).limit(1);
  if (!church) return { error: "We couldn't find this church. Please ask an usher for help." };

  // Don't double-text someone who submits twice in the same visit.
  const recentCutoff = new Date(Date.now() - 12 * 60 * 60 * 1000);
  const [recent] = await db
    .select({ id: visitors.id })
    .from(visitors)
    .where(and(eq(visitors.churchId, church.id), eq(visitors.phone, phone), gte(visitors.createdAt, recentCutoff)))
    .orderBy(desc(visitors.createdAt))
    .limit(1);

  if (!recent) {
    const [visitor] = await db.insert(visitors).values({ churchId: church.id, firstName, phone }).returning();
    const welcomeId = await scheduleFollowUps(church, visitor, await appUrl());
    // Send the thank-you right after responding so the guest isn't kept waiting.
    // If this fails, the cron job picks it up on its next run.
    after(async () => {
      try {
        await sendMessage(welcomeId);
      } catch (err) {
        console.error("[guest] immediate send failed", err);
      }
    });
  }

  redirect(`/g/${slug}/welcome?name=${encodeURIComponent(firstName)}`);
}
