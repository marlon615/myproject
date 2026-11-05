"use server";
import { redirect } from "next/navigation";
import { eq } from "drizzle-orm";
import { db, churches } from "@/db";
import { requireChurch } from "@/lib/session";
import { stripe, stripeConfigured } from "@/lib/stripe";
import { appUrl } from "@/lib/config";

export async function startCheckout() {
  const church = await requireChurch();
  if (!stripeConfigured()) redirect("/dashboard/billing?error=not_configured");
  const s = stripe();
  const base = await appUrl();

  let customerId = church.stripeCustomerId;
  if (!customerId) {
    const customer = await s.customers.create({
      email: church.email,
      name: church.name,
      metadata: { churchId: church.id },
    });
    customerId = customer.id;
    await db.update(churches).set({ stripeCustomerId: customerId }).where(eq(churches.id, church.id));
  }

  // Subscribing mid-trial? Keep the remaining free days (Stripe needs the trial end ≥48h away).
  const trialEnd = Math.floor(new Date(church.trialEndsAt).getTime() / 1000);
  const keepTrial = trialEnd - Math.floor(Date.now() / 1000) > 49 * 3600;

  const session = await s.checkout.sessions.create({
    mode: "subscription",
    customer: customerId,
    line_items: [{ price: process.env.STRIPE_PRICE_ID!, quantity: 1 }],
    client_reference_id: church.id,
    subscription_data: {
      metadata: { churchId: church.id },
      ...(keepTrial && { trial_end: trialEnd }),
    },
    allow_promotion_codes: true,
    success_url: `${base}/dashboard/billing?success=1`,
    cancel_url: `${base}/dashboard/billing`,
  });
  redirect(session.url!);
}

export async function openPortal() {
  const church = await requireChurch();
  if (!stripeConfigured() || !church.stripeCustomerId) redirect("/dashboard/billing");
  const session = await stripe().billingPortal.sessions.create({
    customer: church.stripeCustomerId,
    return_url: `${await appUrl()}/dashboard/billing`,
  });
  redirect(session.url);
}
