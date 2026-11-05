"use server";
import { redirect } from "next/navigation";
import { revalidatePath } from "next/cache";
import { requireChurch } from "@/lib/session";
import { appUrl } from "@/lib/config";
import { planState } from "@/lib/billing";
import { paypalConfigured, createSubscription, cancelSubscription, getSubscription, syncSubscription } from "@/lib/paypal";

export async function startCheckout() {
  const church = await requireChurch();
  if (!paypalConfigured()) redirect("/dashboard/billing?error=not_configured");
  const plan = planState(church);
  if (plan.kind === "active" && !plan.cancelsAt) redirect("/dashboard/billing");

  let approveUrl: string;
  try {
    approveUrl = await createSubscription(church, await appUrl());
  } catch (err) {
    console.error("[billing] PayPal checkout failed", err);
    redirect("/dashboard/billing?error=checkout_failed");
  }
  redirect(approveUrl);
}

export async function cancelPlan() {
  const church = await requireChurch();
  if (!paypalConfigured() || !church.paypalSubscriptionId) redirect("/dashboard/billing");
  try {
    await cancelSubscription(church.paypalSubscriptionId);
    await syncSubscription(await getSubscription(church.paypalSubscriptionId), church.id);
  } catch (err) {
    console.error("[billing] PayPal cancel failed", err);
    redirect("/dashboard/billing?error=cancel_failed");
  }
  revalidatePath("/dashboard", "layout");
  redirect("/dashboard/billing?canceled_sub=1");
}
