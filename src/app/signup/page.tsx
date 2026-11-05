import Link from "next/link";
import { redirect } from "next/navigation";
import type { Metadata } from "next";
import { Brand } from "@/components/Brand";
import { currentChurch } from "@/lib/session";
import { PRICE_MONTHLY_USD, TRIAL_DAYS } from "@/lib/config";
import { SignupForm } from "./SignupForm";

export const metadata: Metadata = { title: "Start your free trial" };

export default async function SignupPage() {
  if (await currentChurch()) redirect("/dashboard");
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
          <h1>Set up your church</h1>
          <p className="muted">Takes about 5 minutes. {TRIAL_DAYS} days free, then ${PRICE_MONTHLY_USD}/month. No card needed to start.</p>
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
