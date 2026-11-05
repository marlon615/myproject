import type { Metadata } from "next";
import { requireChurch } from "@/lib/session";
import { planState, planLabel } from "@/lib/billing";
import { stripeConfigured } from "@/lib/stripe";
import { PRICE_MONTHLY_USD, TRIAL_DAYS } from "@/lib/config";
import { formatDate } from "@/lib/utils";
import { startCheckout, openPortal } from "@/app/actions/billing";
import { SubmitButton } from "@/components/SubmitButton";

export const metadata: Metadata = { title: "Billing" };

export default async function BillingPage({ searchParams }: { searchParams: Promise<{ success?: string; error?: string }> }) {
  const church = await requireChurch();
  const { success, error } = await searchParams;
  const plan = planState(church);
  const configured = stripeConfigured();

  return (
    <div className="stack-lg" style={{ maxWidth: 640 }}>
      <div>
        <h1 style={{ marginBottom: 4 }}>Billing</h1>
        <p className="muted" style={{ margin: 0 }}>One simple plan. Cancel anytime.</p>
      </div>

      {success && <div className="alert alert-success">Thank you! Your subscription is being activated — it may take a few seconds to show here.</div>}
      {(error === "not_configured" || !configured) && (
        <div className="alert alert-info">Online payments aren&apos;t switched on yet. Please check back soon.</div>
      )}

      <div className="card">
        <div className="row between">
          <div>
            <div className="muted small">Current plan</div>
            <h2 style={{ margin: 0 }}>{planLabel(plan)}</h2>
          </div>
          <span className={`badge ${plan.kind === "active" ? "badge-sent" : plan.kind === "trial" ? "badge-scheduled" : "badge-failed"}`}>
            <span className="dot" /> {plan.kind === "active" ? "Texts on" : plan.kind === "expired" ? "Texts paused" : plan.kind === "past_due" ? "Action needed" : "Texts on"}
          </span>
        </div>
        <p className="muted small" style={{ marginTop: 12, marginBottom: 0 }}>
          {plan.kind === "trial" && <>Your free trial ends on <strong>{formatDate(plan.endsAt)}</strong>. Subscribe anytime — you won&apos;t be charged until it ends.</>}
          {plan.kind === "active" && (plan.renewsAt ? <>Renews on <strong>{formatDate(plan.renewsAt)}</strong>.</> : <>Your subscription is active.</>)}
          {plan.kind === "past_due" && <>Your last payment didn&apos;t go through. Update your card to keep follow-up texts going.</>}
          {plan.kind === "expired" && <>Your trial ended on {formatDate(plan.endedAt)}. Guests can still fill out your form, but texts are paused until you subscribe.</>}
        </p>
      </div>

      <div className="card card-pad-lg">
        <div className="row between" style={{ alignItems: "flex-end" }}>
          <div>
            <h3 style={{ marginBottom: 0 }}>ChurchFollow</h3>
            <div className="muted small">{TRIAL_DAYS}-day free trial, then</div>
          </div>
          <div className="price">${PRICE_MONTHLY_USD}<span className="muted" style={{ fontSize: "1rem", fontFamily: "var(--font-sans)" }}>/mo</span></div>
        </div>
        <ul className="check-list" style={{ marginTop: 16 }}>
          <li>Unlimited guests and follow-up texts</li>
          <li>QR code, guest page &amp; printable pew cards</li>
          <li>Thank-you, day-3 check-in &amp; day-7 invite</li>
          <li>Replies and returns on your dashboard</li>
        </ul>
        {configured && (plan.kind === "active" || plan.kind === "past_due") && church.stripeCustomerId ? (
          <form action={openPortal}>
            <SubmitButton className="btn btn-secondary btn-block" pendingText="Opening…">Manage payment &amp; invoices</SubmitButton>
          </form>
        ) : (
          <form action={startCheckout}>
            <SubmitButton className="btn btn-primary btn-block btn-lg" pendingText="Opening secure checkout…">
              Subscribe for ${PRICE_MONTHLY_USD}/month
            </SubmitButton>
          </form>
        )}
        <p className="tiny muted center" style={{ marginTop: 12, marginBottom: 0 }}>Secure payment by Stripe. Cancel anytime from this page.</p>
      </div>
    </div>
  );
}
