"use client";
import { useActionState } from "react";
import { updateChurch, type FormState } from "@/app/actions/auth";
import { ChurchFields } from "@/components/ChurchFields";
import { SubmitButton } from "@/components/SubmitButton";

type Defaults = Parameters<typeof ChurchFields>[0]["defaults"];

export function SettingsForm({ defaults }: { defaults: Defaults }) {
  const [state, action] = useActionState<FormState, FormData>(updateChurch, {});
  return (
    <form action={action} noValidate>
      {state.ok && <div className="alert alert-success" style={{ marginBottom: 16 }}>{state.ok}</div>}
      {state.error && <div className="alert alert-error" style={{ marginBottom: 16 }}>{state.error}</div>}
      <ChurchFields state={state} defaults={defaults} />
      <SubmitButton pendingText="Saving…">Save changes</SubmitButton>
    </form>
  );
}
