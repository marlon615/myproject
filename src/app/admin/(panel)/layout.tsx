import type { Metadata } from "next";
import { Brand } from "@/components/Brand";
import { NavLinks } from "@/components/NavLinks";
import { requireAdmin } from "@/lib/session";
import { adminLogout } from "@/app/actions/admin";

export const dynamic = "force-dynamic";
export const metadata: Metadata = { title: "Owner dashboard", robots: { index: false, follow: false } };

export default async function AdminLayout({ children }: { children: React.ReactNode }) {
  await requireAdmin();
  return (
    <>
      <header className="site-header">
        <div className="container" style={{ maxWidth: 1200 }}>
          <div className="row" style={{ gap: 8 }}>
            <Brand href="/admin" />
            <span className="badge badge-accent">Owner</span>
          </div>
          <form action={adminLogout}><button className="btn btn-ghost btn-sm">Log out</button></form>
        </div>
      </header>
      <div className="subnav">
        <div className="container" style={{ maxWidth: 1200 }}>
          <nav className="nav">
            <NavLinks links={[{ href: "/admin", label: "Overview", exact: true }, { href: "/admin/churches", label: "Churches" }, { href: "/admin/failed", label: "Failed texts" }]} />
          </nav>
        </div>
      </div>
      <main className="container" style={{ maxWidth: 1200 }}>{children}</main>
    </>
  );
}
