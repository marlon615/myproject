"use client";
import { useActionState } from "react";
import { submitGuest, type GuestFormState } from "@/app/actions/guest";
import { SubmitButton } from "@/components/SubmitButton";

export function GuestForm({ slug, churchName }: { slug: string; churchName: string }) {
  const [state, action] = useActionState<GuestFormState, FormData>(submitGuest.bind(null, slug), {});
  return (
    <form action={action}>
      {state.error && <div className="alert alert-error" style={{ marginBottom: 16 }} role="alert">{state.error}</div>}
      <div className="field">
        <label htmlFor="firstName">First name</label>
        <input id="firstName" name="firstName" type="text" autoComplete="given-name" autoCapitalize="words" required maxLength={40} defaultValue={state.firstName} placeholder="Your first name" />
      </div>
      <div className="field">
        <label htmlFor="phone">Mobile number</label>
        <input id="phone" name="phone" type="tel" inputMode="tel" autoComplete="tel-national" required defaultValue={state.phone} placeholder="(555) 555-0123" />
      </div>
      <div className="hp" aria-hidden>
        <label htmlFor="website">Website</label>
        <input id="website" name="website" type="text" tabIndex={-1} autoComplete="off" />
      </div>
      <div className="field">
        <label className="checkbox">
          <input type="checkbox" name="consent" defaultChecked required />
          <span>Yes, {churchName} may text me a welcome and a couple of follow-ups. Msg &amp; data rates may apply. Reply STOP anytime to opt out.</span>
        </label>
      </div>
      <SubmitButton className="btn btn-primary btn-block btn-lg" pendingText="Sending…">Say hello 👋</SubmitButton>
    </form>
  );
}
