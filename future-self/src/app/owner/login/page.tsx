import type { Metadata } from "next";
import { redirect } from "next/navigation";
import { isOwner } from "@/lib/auth";
import LoginForm from "./LoginForm";

export const dynamic = "force-dynamic";
export const metadata: Metadata = { title: "Sign in", robots: { index: false, follow: false } };

export default async function OwnerLoginPage() {
  if (await isOwner()) redirect("/owner");
  return (
    <main className="owner-wrap">
      <LoginForm />
    </main>
  );
}
