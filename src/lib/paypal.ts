import "server-only";
import { eq } from "drizzle-orm";
import { db, churches, type Church } from "@/db";

/**
 * PayPal Subscriptions (REST API, no SDK).
 *
 * ┌──────────────────────────── PLUG YOUR KEYS IN HERE ────────────────────────────┐
 * │ Vercel → Project → Settings → Environment Variables (or .env.local):           │
 * │   PAYPAL_ENV=sandbox            (switch to "live" when you're ready for money)  │
 * │   PAYPAL_CLIENT_ID=...          (developer.paypal.com → Apps & Credentials)     │
 * │   PAYPAL_CLIENT_SECRET=...                                                      │
 * │   PAYPAL_PLAN_ID=P-...          (printed by `npm run paypal:setup`)             │
 * │   PAYPAL_WEBHOOK_ID=...         (printed by `npm run paypal:setup`)             │
 * └────────────────────────────────────────────────────────────────────────────────┘
 */

export function paypalConfigured() {
  return Boolean(process.env.PAYPAL_CLIENT_ID && process.env.PAYPAL_CLIENT_SECRET && process.env.PAYPAL_PLAN_ID);
}

export function paypalApiBase() {
  return process.env.PAYPAL_ENV === "live" ? "https://api-m.paypal.com" : "https://api-m.sandbox.paypal.com";
}

/** Where subscribers manage or update payment for their automatic payments. */
export function paypalAutopayUrl() {
  return process.env.PAYPAL_ENV === "live"
    ? "https://www.paypal.com/myaccount/autopay/"
    : "https://www.sandbox.paypal.com/myaccount/autopay/";
}

let cachedToken: { value: string; expiresAt: number } | null = null;

async function accessToken(): Promise<string> {
  if (cachedToken && cachedToken.expiresAt > Date.now() + 60_000) return cachedToken.value;
  const id = process.env.PAYPAL_CLIENT_ID ?? "";
  const secret = process.env.PAYPAL_CLIENT_SECRET ?? "";
  const res = await fetch(`${paypalApiBase()}/v1/oauth2/token`, {
    method: "POST",
    headers: {
      Authorization: "Basic " + Buffer.from(`${id}:${secret}`).toString("base64"),
      "Content-Type": "application/x-www-form-urlencoded",
    },
    body: "grant_type=client_credentials",
    cache: "no-store",
  });
  if (!res.ok) throw new Error(`PayPal auth failed (HTTP ${res.status}). Check PAYPAL_CLIENT_ID / PAYPAL_CLIENT_SECRET / PAYPAL_ENV.`);
  const data = (await res.json()) as { access_token: string; expires_in: number };
  cachedToken = { value: data.access_token, expiresAt: Date.now() + data.expires_in * 1000 };
  return data.access_token;
}

async function paypal<T>(path: string, init: { method?: string; body?: string } = {}): Promise<T> {
  const res = await fetch(`${paypalApiBase()}${path}`, {
    method: init.method ?? "GET",
    headers: {
      Authorization: `Bearer ${await accessToken()}`,
      "Content-Type": "application/json",
      Accept: "application/json",
    },
    body: init.body,
    cache: "no-store",
  });
  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new Error(`PayPal ${init.method ?? "GET"} ${path} failed (HTTP ${res.status}): ${text.slice(0, 300)}`);
  }
  return (res.status === 204 ? undefined : await res.json()) as T;
}

export type PayPalSubscription = {
  id: string;
  status: "APPROVAL_PENDING" | "APPROVED" | "ACTIVE" | "SUSPENDED" | "CANCELLED" | "EXPIRED";
  custom_id?: string;
  plan_id?: string;
  start_time?: string;
  billing_info?: { next_billing_time?: string; failed_payments_count?: number };
  links?: { href: string; rel: string }[];
};

/**
 * Start a $39/month subscription and return PayPal's approval URL.
 * If the church still has trial days left, billing starts when the trial ends.
 */
export async function createSubscription(church: Church, baseUrl: string): Promise<string> {
  const trialEnd = new Date(church.trialEndsAt);
  const deferStart = trialEnd.getTime() - Date.now() > 60 * 60 * 1000;
  const sub = await paypal<PayPalSubscription>("/v1/billing/subscriptions", {
    method: "POST",
    body: JSON.stringify({
      plan_id: process.env.PAYPAL_PLAN_ID,
      custom_id: church.id,
      ...(deferStart && { start_time: trialEnd.toISOString() }),
      subscriber: { email_address: church.email },
      application_context: {
        brand_name: "ChurchFollow",
        user_action: "SUBSCRIBE_NOW",
        shipping_preference: "NO_SHIPPING",
        return_url: `${baseUrl}/dashboard/billing/paypal-return`,
        cancel_url: `${baseUrl}/dashboard/billing?canceled=1`,
      },
    }),
  });
  const approve = sub.links?.find((l) => l.rel === "approve")?.href;
  if (!approve) throw new Error("PayPal did not return an approval link.");
  return approve;
}

export function getSubscription(id: string) {
  if (!/^I-[A-Z0-9]+$/i.test(id)) throw new Error("Invalid PayPal subscription id");
  return paypal<PayPalSubscription>(`/v1/billing/subscriptions/${id}`);
}

/** Like getSubscription, but returns null when PayPal says the subscription doesn't exist. */
export async function findSubscription(id: string): Promise<PayPalSubscription | null> {
  if (!/^I-[A-Z0-9]+$/i.test(id)) return null;
  try {
    return await getSubscription(id);
  } catch (err) {
    if (String((err as Error).message).includes("HTTP 404")) return null;
    throw err;
  }
}

export async function cancelSubscription(id: string, reason = "Canceled from ChurchFollow billing page") {
  if (!/^I-[A-Z0-9]+$/i.test(id)) throw new Error("Invalid PayPal subscription id");
  await paypal<void>(`/v1/billing/subscriptions/${id}/cancel`, {
    method: "POST",
    body: JSON.stringify({ reason }),
  });
}

/** Map PayPal's status onto ours. */
function normalizeStatus(status: PayPalSubscription["status"]): string | null {
  switch (status) {
    case "ACTIVE":
    case "APPROVED":
      return "active";
    case "SUSPENDED":
      return "past_due";
    case "CANCELLED":
    case "EXPIRED":
      return "canceled";
    default:
      return null; // APPROVAL_PENDING: the pastor hasn't finished checkout yet.
  }
}

/**
 * Save a PayPal subscription's state onto its church.
 * Matches by custom_id (our church id), falling back to the stored subscription id.
 * Pass `expectChurchId` to refuse a subscription that belongs to someone else.
 */
export async function syncSubscription(sub: PayPalSubscription, expectChurchId?: string): Promise<boolean> {
  const status = normalizeStatus(sub.status);
  if (!status) return false;
  if (expectChurchId && sub.custom_id !== expectChurchId) return false;
  // Subscriptions we didn't create (e.g. other things sold on the same PayPal account) don't carry
  // one of our church ids. Ignore them unless we already know the subscription id.
  const ours = !!sub.custom_id && /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(sub.custom_id);

  const [church] = ours
    ? await db.select().from(churches).where(eq(churches.id, sub.custom_id!)).limit(1)
    : await db.select().from(churches).where(eq(churches.paypalSubscriptionId, sub.id)).limit(1);
  if (!church) return false;

  // Once a church has a subscription, only a newly *active* one may replace it. This ignores
  // late events about an old, abandoned or canceled subscription.
  if (church.paypalSubscriptionId && church.paypalSubscriptionId !== sub.id && status !== "active") return false;

  const next = sub.billing_info?.next_billing_time ? new Date(sub.billing_info.next_billing_time) : null;
  await db
    .update(churches)
    .set({
      subscriptionStatus: status,
      paypalSubscriptionId: sub.id,
      // Keep the last known paid-through date when PayPal stops reporting one after cancellation.
      currentPeriodEnd: next ?? church.currentPeriodEnd,
    })
    .where(eq(churches.id, church.id));
  return true;
}

/** Mark a church past-due right away when PayPal reports a failed payment. */
export async function markPaymentFailed(subscriptionId: string) {
  await db.update(churches).set({ subscriptionStatus: "past_due" }).where(eq(churches.paypalSubscriptionId, subscriptionId));
}

/**
 * Verify a webhook really came from PayPal, using PayPal's verification API.
 * The raw body is passed through untouched so the signature check matches.
 */
export async function verifyWebhook(headers: Headers, rawBody: string): Promise<boolean> {
  const webhookId = process.env.PAYPAL_WEBHOOK_ID;
  if (!webhookId) return false;
  const h = (k: string) => JSON.stringify(headers.get(k) ?? "");
  const body =
    `{"auth_algo":${h("paypal-auth-algo")},"cert_url":${h("paypal-cert-url")},` +
    `"transmission_id":${h("paypal-transmission-id")},"transmission_sig":${h("paypal-transmission-sig")},` +
    `"transmission_time":${h("paypal-transmission-time")},"webhook_id":${JSON.stringify(webhookId)},` +
    `"webhook_event":${rawBody}}`;
  try {
    const result = await paypal<{ verification_status: string }>("/v1/notifications/verify-webhook-signature", {
      method: "POST",
      body,
    });
    return result.verification_status === "SUCCESS";
  } catch {
    return false;
  }
}
