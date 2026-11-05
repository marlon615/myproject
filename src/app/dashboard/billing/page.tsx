import type { Metadata } from "next";
import { requireChurch } from "@/lib/session";
import { planState, planLabel } from "@/lib/billing";
import { paypalConfigured, paypalAutopayUrl } from "@/lib/paypal";
import { PRICE_MONTHLY_USD, TRIAL_DAYS } from "@/lib/config";
import { formatDate } from "@/lib/utils";
import { startCheckout, cancelPlan } from "@/app/actions/billing";
import { SubmitButton } from "@/components/SubmitButton";

export const metadata: Metadata = { title: "Billing" };

type Search = { success?: string; pending?: string; canceled?: string; canceled_sub?: string; error?: string };

const ERRORS: Record<string, string> = {
  checkout_failed: "We couldn't start PayPal checkout. Please try again in a moment.",
  cancel_failed: "We couldn't cancel with PayPal just now. Please try again, or cancel from your PayPal account.",
};

export default async function BillingPage({ searchParams }: { searchParams: Promise<Search> }) {
  const church = await requireChurch();
  const q = await searchParams;
  const plan = planState(church);
  const configured = paypalConfigured();
  const subscribed = (plan.kind === "active" && !plan.cancelsAt) || plan.kind === "past_due";

  return (
    <div className="stack-lg" style={{ maxWidth: 640 }}>
      <div>
        <h1 style={{ marginBottom: 4 }}>Billing</h1>
        <p className="muted" style={{ margin: 0 }}>One simple plan, paid with PayPal. Cancel anytime.</p>
      </div>

      {q.success && <div className="alert alert-success">Thank you! Your subscription is active.</div>}
      {q.pending && <div className="alert alert-info">Thanks! PayPal is still confirming your subscription. This page will update within a minute or two.</div>}
      {q.canceled && <div className="alert alert-info">PayPal checkout was canceled. You haven&apos;t been charged.</div>}
      {q.canceled_sub && <div className="alert alert-info">Your subscription is canceled. You won&apos;t be charged again.</div>}
      {q.error && ERRORS[q.error] && <div className="alert alert-error">{ERRORS[q.error]}</div>}
      {!configured && <div className="alert alert-info">Online payments aren&apos;t switched on yet. Please check back soon.</div>}

      <div className="card">
        <div className="row between">
          <div>
            <div className="muted small">Current plan</div>
            <h2 style={{ margin: 0 }}>{planLabel(plan)}</h2>
          </div>
          <span className={`badge ${plan.kind === "active" ? "badge-sent" : plan.kind === "trial" ? "badge-scheduled" : "badge-failed"}`}>
            <span className="dot" /> {plan.kind === "expired" ? "Texts paused" : plan.kind === "past_due" ? "Action needed" : "Texts on"}
          </span>
        </div>
        <p className="muted small" style={{ marginTop: 12, marginBottom: 0 }}>
          {plan.kind === "trial" && <>Your free trial ends on <strong>{formatDate(plan.endsAt)}</strong>. Subscribe anytime — PayPal won&apos;t charge you until it ends.</>}
          {plan.kind === "active" && !plan.cancelsAt && (plan.renewsAt ? <>Next payment on <strong>{formatDate(plan.renewsAt)}</strong>.</> : <>Your subscription is active.</>)}
          {plan.kind === "active" && plan.cancelsAt && <>Everything stays on until <strong>{formatDate(plan.cancelsAt)}</strong>. Resubscribe anytime to keep going after that.</>}
          {plan.kind === "past_due" && <>PayPal couldn&apos;t collect your last payment. Update your payment method in PayPal to keep follow-up texts going.</>}
          {plan.kind === "expired" && <>Your {church.subscriptionStatus === "canceled" ? "subscription" : "trial"} ended on {formatDate(plan.endedAt)}. Guests can still fill out your form, but texts are paused until you subscribe.</>}
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

        {subscribed ? (
          <div className="stack">
            <a href={paypalAutopayUrl()} target="_blank" rel="noreferrer" className="btn btn-secondary btn-block">
              {plan.kind === "past_due" ? "Update payment method in PayPal" : "View payments in PayPal"}
            </a>
            {configured && church.paypalSubscriptionId && (
              <details>
                <summary className="small muted" style={{ cursor: "pointer", textAlign: "center" }}>Cancel subscription</summary>
                <form action={cancelPlan} className="center" style={{ marginTop: 12 }}>
                  <p className="small muted">You&apos;ll keep full access until the end of the period you&apos;ve paid for.</p>
                  <SubmitButton className="btn btn-ghost btn-sm" pendingText="Canceling…">Yes, cancel my subscription</SubmitButton>
                </form>
              </details>
            )}
          </div>
        ) : (
          <form action={startCheckout}>
            <SubmitButton className="btn btn-primary btn-block btn-lg" pendingText="Opening PayPal…">
              {plan.kind === "active" && plan.cancelsAt ? "Resubscribe" : "Subscribe"} with PayPal · ${PRICE_MONTHLY_USD}/month
            </SubmitButton>
          </form>
        )}
        <p className="tiny muted center" style={{ marginTop: 12, marginBottom: 0 }}>
          Secure payment through your PayPal account (balance, bank or linked card).
        </p>
      </div>
    </div>
  );
}
