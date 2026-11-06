"use client";

import { useActionState } from "react";
import { ownerLogin } from "../actions";

export default function LoginForm() {
  const [error, action, pending] = useActionState(ownerLogin, null);
  return (
    <form action={action} className="owner-card owner-login">
      <h1>Owner sign-in</h1>
      <p className="muted">Private. Only the owner of Future Self can open this page.</p>
      <label htmlFor="pw">Owner password</label>
      <input id="pw" name="password" type="password" autoComplete="current-password" required autoFocus />
      {error && <p className="owner-error" role="alert">{error}</p>}
      <button className="btn btn-primary" disabled={pending}>{pending ? "Checking…" : "Sign in"}</button>
    </form>
  );
}
