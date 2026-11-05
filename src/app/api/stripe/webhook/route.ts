import type Stripe from "stripe";
import { stripe, syncSubscription } from "@/lib/stripe";

export async function POST(req: Request) {
  const secret = process.env.STRIPE_WEBHOOK_SECRET;
  if (!secret || !process.env.STRIPE_SECRET_KEY) return new Response("Stripe not configured", { status: 501 });

  const body = await req.text();
  let event: Stripe.Event;
  try {
    event = stripe().webhooks.constructEvent(body, req.headers.get("stripe-signature") ?? "", secret);
  } catch (err) {
    return new Response(`Invalid signature: ${(err as Error).message}`, { status: 400 });
  }

  switch (event.type) {
    case "checkout.session.completed": {
      const session = event.data.object as Stripe.Checkout.Session;
      if (session.subscription) {
        const subId = typeof session.subscription === "string" ? session.subscription : session.subscription.id;
        await syncSubscription(await stripe().subscriptions.retrieve(subId));
      }
      break;
    }
    case "customer.subscription.created":
    case "customer.subscription.updated":
    case "customer.subscription.deleted":
      await syncSubscription(event.data.object as Stripe.Subscription);
      break;
  }
  return Response.json({ received: true });
}
