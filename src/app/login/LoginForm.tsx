"use client";
import { useActionState } from "react";
import { login, type FormState } from "@/app/actions/auth";
import { SubmitButton } from "@/components/SubmitButton";

export function LoginForm() {
  const [state, action] = useActionState<FormState, FormData>(login, {});
  return (
    <form action={action}>
      {state.error && <div className="alert alert-error" style={{ marginBottom: 16 }}>{state.error}</div>}
      <div className="field">
        <label htmlFor="email">Email</label>
        <input id="email" name="email" type="email" autoComplete="email" required defaultValue={state.values?.email ?? ""} />
      </div>
      <div className="field">
        <label htmlFor="password">Password</label>
        <input id="password" name="password" type="password" autoComplete="current-password" required />
      </div>
      <SubmitButton className="btn btn-primary btn-block" pendingText="Logging in…">Log in</SubmitButton>
    </form>
  );
}
