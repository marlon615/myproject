"use client";
import { useActionState } from "react";
import { adminLogin } from "@/app/actions/admin";
import { SubmitButton } from "@/components/SubmitButton";

export function AdminLoginForm() {
  const [state, action] = useActionState(adminLogin, {});
  return (
    <form action={action}>
      {state.error && <div className="alert alert-error" style={{ marginBottom: 16 }}>{state.error}</div>}
      <div className="field">
        <label htmlFor="email">Owner email</label>
        <input id="email" name="email" type="email" autoComplete="username" required autoFocus />
      </div>
      <div className="field">
        <label htmlFor="password">Owner password</label>
        <input id="password" name="password" type="password" autoComplete="current-password" required />
      </div>
      <SubmitButton className="btn btn-primary btn-block" pendingText="Checking…">Enter</SubmitButton>
    </form>
  );
}
