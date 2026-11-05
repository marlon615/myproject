import type { Church } from "@/db";

export type PlanState =
  | { kind: "trial"; daysLeft: number; endsAt: Date }
  | { kind: "active"; renewsAt: Date | null }
  | { kind: "past_due" }
  | { kind: "expired"; endedAt: Date };

/** Single source of truth for whether a church is in trial, paying, or lapsed. */
export function planState(church: Pick<Church, "subscriptionStatus" | "trialEndsAt" | "currentPeriodEnd">, now = new Date()): PlanState {
  const status = church.subscriptionStatus;
  if (status === "active" || status === "trialing") {
    return { kind: "active", renewsAt: church.currentPeriodEnd };
  }
  if (status === "past_due") return { kind: "past_due" };
  const endsAt = new Date(church.trialEndsAt);
  if (endsAt > now) {
    return { kind: "trial", daysLeft: Math.max(1, Math.ceil((endsAt.getTime() - now.getTime()) / 86400000)), endsAt };
  }
  return { kind: "expired", endedAt: endsAt };
}

/** Texts only go out while a church is in trial, subscribed, or in Stripe's past-due retry window. */
export function canSendTexts(church: Parameters<typeof planState>[0]): boolean {
  return planState(church).kind !== "expired";
}

export function planLabel(state: PlanState): string {
  switch (state.kind) {
    case "trial":
      return `Trial · ${state.daysLeft} day${state.daysLeft === 1 ? "" : "s"} left`;
    case "active":
      return "Active";
    case "past_due":
      return "Payment past due";
    case "expired":
      return "Trial ended";
  }
}
