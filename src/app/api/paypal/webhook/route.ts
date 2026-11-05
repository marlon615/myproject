import { verifyWebhook, findSubscription, syncSubscription, markPaymentFailed } from "@/lib/paypal";

type WebhookEvent = { event_type?: string; resource?: { id?: string; billing_agreement_id?: string } };

/**
 * PayPal webhook: https://YOUR-DOMAIN/api/paypal/webhook
 * Every event is verified with PayPal, then the subscription is re-fetched from PayPal so we
 * always store its current state (events can arrive late or out of order).
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
  if (!subId) return Response.json({ ignored: type });

  try {
    if (type === "BILLING.SUBSCRIPTION.PAYMENT.FAILED") await markPaymentFailed(subId);
    else {
      const sub = await findSubscription(subId);
      if (sub) await syncSubscription(sub);
    }
  } catch (err) {
    console.error("[paypal] webhook handling failed", type, err);
    return new Response("Temporary error", { status: 500 }); // PayPal retries.
  }
  return Response.json({ received: true });
}
