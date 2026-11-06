import { NextResponse } from "next/server";
import { currentContractor } from "@/lib/session";
import { findSubscription, syncSubscription, paypalConfigured } from "@/lib/paypal";

/**
 * PayPal sends the contractor back here after approving the subscription
 * (…/paypal-return?subscription_id=I-XXXX). We look the subscription up with PayPal
 * ourselves rather than trusting the URL, and only accept it if it belongs to this contractor.
 */
export async function GET(req: Request) {
  const url = new URL(req.url);
  const back = (q: string) => NextResponse.redirect(new URL(`/dashboard/billing?${q}`, url));
  const c = await currentContractor();
  if (!c) return NextResponse.redirect(new URL("/login", url));
  const id = url.searchParams.get("subscription_id");
  if (!id || !paypalConfigured()) return back("error=checkout_failed");
  try {
    const sub = await findSubscription(id);
    const ok = sub ? await syncSubscription(sub, c.id) : false;
    return back(ok ? "success=1" : "pending=1");
  } catch (err) {
    console.error("[billing] PayPal return failed", err);
    return back("pending=1");
  }
}
