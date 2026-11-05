import "server-only";
import Stripe from "stripe";
import { eq } from "drizzle-orm";
import { db, churches } from "@/db";

/**
 * Stripe keys (Vercel → Settings → Environment Variables):
 *   STRIPE_SECRET_KEY       sk_live_... / sk_test_...
 *   STRIPE_PRICE_ID         price_...  (a $39/month recurring price)
 *   STRIPE_WEBHOOK_SECRET   whsec_...  (webhook endpoint: https://YOUR-DOMAIN/api/stripe/webhook)
 */
export function stripeConfigured() {
  return Boolean(process.env.STRIPE_SECRET_KEY && process.env.STRIPE_PRICE_ID);
}

let _stripe: Stripe | null = null;
export function stripe(): Stripe {
  if (!process.env.STRIPE_SECRET_KEY) throw new Error("STRIPE_SECRET_KEY is not set");
  _stripe ??= new Stripe(process.env.STRIPE_SECRET_KEY);
  return _stripe;
}

/** Copy a Stripe subscription's state onto the church row. */
export async function syncSubscription(sub: Stripe.Subscription) {
  const churchId = sub.metadata?.churchId;
  const customerId = typeof sub.customer === "string" ? sub.customer : sub.customer.id;
  // current_period_end moved onto subscription items in newer API versions.
  const periodEnd =
    (sub as unknown as { current_period_end?: number }).current_period_end ??
    sub.items?.data?.[0]?.current_period_end;

  const values = {
    subscriptionStatus: sub.status,
    stripeSubscriptionId: sub.id,
    stripeCustomerId: customerId,
    currentPeriodEnd: periodEnd ? new Date(periodEnd * 1000) : null,
  };
  if (churchId) {
    await db.update(churches).set(values).where(eq(churches.id, churchId));
  } else {
    await db.update(churches).set(values).where(eq(churches.stripeCustomerId, customerId));
  }
}
