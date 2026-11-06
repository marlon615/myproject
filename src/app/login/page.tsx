import Link from "next/link";
import { redirect } from "next/navigation";
import type { Metadata } from "next";
import { Brand } from "@/components/Brand";
import { currentContractor } from "@/lib/session";
import { LoginForm } from "./LoginForm";

export const metadata: Metadata = { title: "Log in" };

export default async function LoginPage() {
  if (await currentContractor()) redirect("/dashboard");
  return (
    <>
      <header className="site-header">
        <div className="container"><Brand /></div>
      </header>
      <main className="container narrow">
        <div className="center" style={{ margin: "16px 0 24px" }}>
          <h1>Welcome back</h1>
          <p className="muted">Log in to see your calls and bookings.</p>
        </div>
        <div className="card"><LoginForm /></div>
        <p className="center small muted" style={{ marginTop: 16 }}>
          New here? <Link href="/signup">Start a free pilot</Link>
        </p>
      </main>
    </>
  );
}
