import { redirect } from "next/navigation";
import type { Metadata } from "next";
import { BrandMark } from "@/components/Brand";
import { isAdmin } from "@/lib/session";
import { AdminLoginForm } from "./AdminLoginForm";

export const metadata: Metadata = { title: "Owner login", robots: { index: false, follow: false } };

export default async function AdminLoginPage() {
  if (await isAdmin()) redirect("/admin");
  return (
    <main className="container narrow" style={{ paddingTop: 64, maxWidth: 400 }}>
      <div className="center" style={{ marginBottom: 20 }}>
        <BrandMark size={40} />
        <h1 style={{ marginTop: 12, fontSize: "1.6rem" }}>Owner dashboard</h1>
        <p className="muted small">Private area.</p>
      </div>
      <div className="card"><AdminLoginForm /></div>
    </main>
  );
}
