import Link from "next/link";
import { Brand } from "@/components/Brand";
import { NavLinks } from "@/components/NavLinks";
import { requireContractor, touchLastSeen } from "@/lib/session";
import { planState } from "@/lib/billing";
import { logout } from "@/app/actions/auth";
import { PRICE_MONTHLY_USD } from "@/lib/config";

export const dynamic = "force-dynamic";

export default async function DashboardLayout({ children }: { children: React.ReactNode }) {
  const c = await requireContractor();
  await touchLastSeen(c);
  const plan = planState(c);

  return (
    <>
      <header className="site-header">
        <div className="container">
          <Brand href="/dashboard" />
          <form action={logout}>
            <button className="btn btn-ghost btn-sm" type="submit">Log out</button>
          </form>
        </div>
      </header>
      <div className="subnav">
        <div className="container">
          <nav className="nav">
            <NavLinks
              links={[
                { href: "/dashboard", label: "Overview", exact: true },
                { href: "/dashboard/bookings", label: "Bookings" },
                { href: "/dashboard/activity", label: "Calls & texts" },
                { href: "/dashboard/setup", label: "Setup" },
                { href: "/dashboard/settings", label: "Settings" },
                { href: "/dashboard/billing", label: "Billing" },
              ]}
            />
          </nav>
        </div>
      </div>
      {(plan.kind !== "active" || !c.aiNumber) && (
        <div className="container stack" style={{ paddingTop: 16 }}>
          {!c.aiNumber && plan.kind !== "expired" && (
            <div className="alert alert-neutral row between">
              <span><strong>One step left:</strong> get your CallCairn number and turn on call forwarding.</span>
              <Link href="/dashboard/setup" className="btn btn-sm btn-primary">Finish setup</Link>
            </div>
          )}
          {plan.kind === "trial" && (
            <div className="alert alert-info row between">
              <span>Free pilot · <strong>{plan.daysLeft} day{plan.daysLeft === 1 ? "" : "s"} left</strong></span>
              <Link href="/dashboard/billing" className="btn btn-sm btn-secondary">Subscribe</Link>
            </div>
          )}
          {plan.kind === "expired" && (
            <div className="alert alert-error row between">
              <span><strong>Your {c.subscriptionStatus === "canceled" ? "subscription" : "pilot"} has ended.</strong> The assistant isn&apos;t answering calls or texts.</span>
              <Link href="/dashboard/billing" className="btn btn-sm btn-primary">Subscribe for ${PRICE_MONTHLY_USD}/mo</Link>
            </div>
          )}
          {plan.kind === "past_due" && (
            <div className="alert alert-error row between">
              <span><strong>Payment issue.</strong> Please update your payment method in PayPal to keep the assistant answering.</span>
              <Link href="/dashboard/billing" className="btn btn-sm btn-primary">Fix billing</Link>
            </div>
          )}
        </div>
      )}
      <main className="container">{children}</main>
    </>
  );
}
