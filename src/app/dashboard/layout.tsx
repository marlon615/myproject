import Link from "next/link";
import { Brand } from "@/components/Brand";
import { NavLinks } from "@/components/NavLinks";
import { requireChurch } from "@/lib/session";
import { planState } from "@/lib/billing";
import { logout } from "@/app/actions/auth";

export const dynamic = "force-dynamic";

export default async function DashboardLayout({ children }: { children: React.ReactNode }) {
  const church = await requireChurch();
  const plan = planState(church);

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
                { href: "/dashboard", label: "Guests", exact: true },
                { href: "/dashboard/share", label: "QR & pew cards" },
                { href: "/dashboard/settings", label: "Church info" },
                { href: "/dashboard/billing", label: "Billing" },
              ]}
            />
          </nav>
        </div>
      </div>
      {plan.kind !== "active" && (
        <div className="container" style={{ paddingTop: 16 }}>
          {plan.kind === "trial" && (
            <div className="alert alert-info row between">
              <span>Free trial · <strong>{plan.daysLeft} day{plan.daysLeft === 1 ? "" : "s"} left</strong></span>
              <Link href="/dashboard/billing" className="btn btn-sm btn-secondary">Subscribe</Link>
            </div>
          )}
          {plan.kind === "expired" && (
            <div className="alert alert-error row between">
              <span><strong>Your trial has ended.</strong> Guests can still sign up, but follow-up texts are paused.</span>
              <Link href="/dashboard/billing" className="btn btn-sm btn-primary">Subscribe for $39/mo</Link>
            </div>
          )}
          {plan.kind === "past_due" && (
            <div className="alert alert-error row between">
              <span><strong>Payment issue.</strong> Please update your card to keep texts going.</span>
              <Link href="/dashboard/billing" className="btn btn-sm btn-primary">Fix billing</Link>
            </div>
          )}
        </div>
      )}
      <main className="container">{children}</main>
    </>
  );
}
