import { verifyWebhook, findSubscription, syncSubscription, markPaymentFailed, recordPayment } from "@/lib/paypal";

type WebhookEvent = { id?: string; event_type?: string; create_time?: string; resource?: { id?: string; billing_agreement_id?: string } };

/**
 * PayPal webhook: https://YOUR-DOMAIN/api/paypal/webhook
 * Every event is verified with PayPal, then the subscription is re-fetched from PayPal so we
 * always store its current state (events can arrive late or out of order). Payments, refunds and
 * failed payments are also logged to the payments table for the owner dashboard.
 */
export async function POST(req: Request) {
  if (!process.env.PAYPAL_CLIENT_ID || !process.env.PAYPAL_WEBHOOK_ID) {
    return new Response("PayPal not configured", { status: 501 });
  }
  const raw = await req.text();
  if (!(await verifyWebhook(req.headers, raw))) return new Response("Invalid signature", { status: 400 });

  let event: WebhookEvent;
  try {
    event = JSON.parse(raw);
  } catch {
    return new Response("Bad JSON", { status: 400 });
  }
  const type = event.event_type ?? "";
  const subId = type.startsWith("BILLING.SUBSCRIPTION.")
    ? event.resource?.id
    : type.startsWith("PAYMENT.SALE.")
      ? event.resource?.billing_agreement_id
      : undefined;

  try {
    // Sync the subscription first, so a first payment can be matched to its contractor.
    if (subId && type === "BILLING.SUBSCRIPTION.PAYMENT.FAILED") await markPaymentFailed(subId);
    else if (subId) {
      const sub = await findSubscription(subId);
      if (sub) await syncSubscription(sub);
    }
    await recordPayment(event as Parameters<typeof recordPayment>[0]);
  } catch (err) {
    console.error("[paypal] webhook handling failed", type, err);
    return new Response("Temporary error", { status: 500 }); // PayPal retries.
  }
  return Response.json({ received: true });
}
