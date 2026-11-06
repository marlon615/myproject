import type { Church } from "@/db";

export type PlanState =
  | { kind: "trial"; daysLeft: number; endsAt: Date }
  | { kind: "active"; renewsAt: Date | null; cancelsAt?: Date }
  | { kind: "past_due" }
  | { kind: "expired"; endedAt: Date };

type Billable = Pick<Church, "subscriptionStatus" | "trialEndsAt" | "currentPeriodEnd">;

/** Single source of truth for whether a church is in trial, paying, or lapsed. */
export function planState(church: Billable, now = new Date()): PlanState {
  const status = church.subscriptionStatus;
  const periodEnd = church.currentPeriodEnd ? new Date(church.currentPeriodEnd) : null;
  if (status === "active") return { kind: "active", renewsAt: periodEnd };
  if (status === "past_due") return { kind: "past_due" };
  // Canceled, but already paid through a future date: keep everything on until then.
  if (status === "canceled" && periodEnd && periodEnd > now) {
    return { kind: "active", renewsAt: null, cancelsAt: periodEnd };
  }
  const trialEnd = new Date(church.trialEndsAt);
  if (trialEnd > now) {
    return { kind: "trial", daysLeft: Math.max(1, Math.ceil((trialEnd.getTime() - now.getTime()) / 86400000)), endsAt: trialEnd };
  }
  const endedAt = status === "canceled" && periodEnd && periodEnd > trialEnd ? periodEnd : trialEnd;
  return { kind: "expired", endedAt };
}

/** Texts only go out while a church is in trial, subscribed, or in PayPal's payment-retry window. */
export function canSendTexts(church: Billable): boolean {
  return planState(church).kind !== "expired";
}

export function planLabel(state: PlanState): string {
  switch (state.kind) {
    case "trial":
      return `Trial · ${state.daysLeft} day${state.daysLeft === 1 ? "" : "s"} left`;
    case "active":
      return state.cancelsAt ? "Canceled · active until period ends" : "Active";
    case "past_due":
      return "Payment past due";
    case "expired":
      return "Inactive";
  }
}
