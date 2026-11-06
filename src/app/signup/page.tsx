import Link from "next/link";
import { redirect } from "next/navigation";
import type { Metadata } from "next";
import { Brand } from "@/components/Brand";
import { currentContractor } from "@/lib/session";
import { PRICE_MONTHLY_USD } from "@/lib/config";
import { SignupForm } from "./SignupForm";

export const metadata: Metadata = { title: "Start your free pilot" };

export default async function SignupPage() {
  if (await currentContractor()) redirect("/dashboard");
  return (
    <>
      <header className="site-header">
        <div className="container">
          <Brand />
          <nav className="nav"><Link href="/login">Log in</Link></nav>
        </div>
      </header>
      <main className="container narrow" style={{ maxWidth: 620 }}>
        <div className="center" style={{ margin: "8px 0 24px" }}>
          <h1>Start your free pilot</h1>
          <p className="muted">One week free, then ${PRICE_MONTHLY_USD}/month (USD) through PayPal. No payment details needed to start.</p>
        </div>
        <div className="card">
          <SignupForm />
        </div>
        <p className="center small muted" style={{ marginTop: 16 }}>
          Already have an account? <Link href="/login">Log in</Link>
        </p>
      </main>
    </>
  );
}
