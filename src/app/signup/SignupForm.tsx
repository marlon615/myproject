"use client";
import { useActionState } from "react";
import { signup, type FormState } from "@/app/actions/auth";
import { ChurchFields, FieldError } from "@/components/ChurchFields";
import { SubmitButton } from "@/components/SubmitButton";

export function SignupForm() {
  const [state, action] = useActionState<FormState, FormData>(signup, {});
  return (
    <form action={action} noValidate>
      {state.error && <div className="alert alert-error" style={{ marginBottom: 16 }}>{state.error}</div>}
      <h3 style={{ marginTop: 4 }}>Your church</h3>
      <ChurchFields state={state} />
      <h3 style={{ marginTop: 24 }}>Your login</h3>
      <div className="field">
        <label htmlFor="email">Email</label>
        <input id="email" name="email" type="email" autoComplete="email" required defaultValue={state.values?.email ?? ""} />
        <FieldError state={state} name="email" />
      </div>
      <div className="field">
        <label htmlFor="password">Password <span className="hint">(8+ characters)</span></label>
        <input id="password" name="password" type="password" autoComplete="new-password" required minLength={8} />
        <FieldError state={state} name="password" />
      </div>
      <SubmitButton className="btn btn-primary btn-block btn-lg" pendingText="Creating your account…">
        Create my church &amp; start free trial
      </SubmitButton>
    </form>
  );
}
