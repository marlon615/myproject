"use server";
import { redirect } from "next/navigation";
import { revalidatePath } from "next/cache";
import { requireContractor } from "@/lib/session";
import { appUrl } from "@/lib/config";
import { planState } from "@/lib/billing";
import { paypalConfigured, createSubscription, cancelSubscription, getSubscription, syncSubscription } from "@/lib/paypal";

export async function startCheckout() {
  const c = await requireContractor();
  if (!paypalConfigured()) redirect("/dashboard/billing?error=not_configured");
  const plan = planState(c);
  if (plan.kind === "active" && !plan.cancelsAt) redirect("/dashboard/billing");

  let approveUrl: string;
  try {
    approveUrl = await createSubscription(c, await appUrl());
  } catch (err) {
    console.error("[billing] PayPal checkout failed", err);
    redirect("/dashboard/billing?error=checkout_failed");
  }
  redirect(approveUrl);
}

export async function cancelPlan() {
  const c = await requireContractor();
  if (!paypalConfigured() || !c.paypalSubscriptionId) redirect("/dashboard/billing");
  try {
    await cancelSubscription(c.paypalSubscriptionId);
    await syncSubscription(await getSubscription(c.paypalSubscriptionId), c.id);
  } catch (err) {
    console.error("[billing] PayPal cancel failed", err);
    redirect("/dashboard/billing?error=cancel_failed");
  }
  revalidatePath("/dashboard", "layout");
  redirect("/dashboard/billing?canceled_sub=1");
}
