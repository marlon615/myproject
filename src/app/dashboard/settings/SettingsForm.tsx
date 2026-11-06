"use client";
import { useActionState } from "react";
import { updateSettings, type FormState } from "@/app/actions/auth";
import { BusinessFields, FieldError } from "@/components/BusinessFields";
import { SubmitButton } from "@/components/SubmitButton";

export type SettingsDefaults = {
  businessName: string; ownerName: string; businessPhone: string; alertPhone: string; serviceArea: string; timezone: string;
  hoursStart: number; hoursEnd: number; workDays: string; slotMinutes: number; jobsPerSlot: number;
  emergencyDispatch: boolean; emergencyNote: string;
};

const DAYS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
const hourLabel = (h: number) => (h === 0 || h === 24 ? "12 AM" : h === 12 ? "12 PM" : h < 12 ? `${h} AM` : `${h - 12} PM`);

export function SettingsForm({ d }: { d: SettingsDefaults }) {
  const [state, action] = useActionState<FormState, FormData>(updateSettings, {});
  const days = new Set(d.workDays.split(","));
  return (
    <form action={action} noValidate>
      {state.ok && <div className="alert alert-success" style={{ marginBottom: 16 }}>{state.ok}</div>}
      {state.error && <div className="alert alert-error" style={{ marginBottom: 16 }}>{state.error}</div>}

      <h3>Company</h3>
      <BusinessFields state={state} defaults={d} />

      <h3 style={{ marginTop: 20 }}>Business hours &amp; booking</h3>
      <p className="muted small">Routine jobs are only offered inside these hours. Times are in your time zone.</p>
      <div className="field">
        <label>Working days</label>
        <div className="day-grid">
          {DAYS.map((name, i) => (
            <label key={i}><input type="checkbox" name="workDays" value={i} defaultChecked={days.has(String(i))} /> {name}</label>
          ))}
        </div>
        <FieldError state={state} name="workDays" />
      </div>
      <div className="grid grid-2" style={{ gap: 0, columnGap: 16 }}>
        <div className="field">
          <label htmlFor="hoursStart">Open</label>
          <select id="hoursStart" name="hoursStart" defaultValue={d.hoursStart}>
            {Array.from({ length: 24 }, (_, h) => <option key={h} value={h}>{hourLabel(h)}</option>)}
          </select>
        </div>
        <div className="field">
          <label htmlFor="hoursEnd">Close</label>
          <select id="hoursEnd" name="hoursEnd" defaultValue={d.hoursEnd}>
            {Array.from({ length: 24 }, (_, i) => i + 1).map((h) => <option key={h} value={h}>{hourLabel(h)}</option>)}
          </select>
          <FieldError state={state} name="hours" />
        </div>
        <div className="field">
          <label htmlFor="slotMinutes">Arrival window</label>
          <select id="slotMinutes" name="slotMinutes" defaultValue={d.slotMinutes}>
            {[60, 90, 120, 180, 240].map((m) => <option key={m} value={m}>{m / 60} hour{m === 60 ? "" : "s"}</option>)}
          </select>
          <FieldError state={state} name="slotMinutes" />
        </div>
        <div className="field">
          <label htmlFor="jobsPerSlot">Jobs per window <span className="hint">(e.g. number of techs)</span></label>
          <input id="jobsPerSlot" name="jobsPerSlot" type="number" min={1} max={20} defaultValue={d.jobsPerSlot} />
          <FieldError state={state} name="jobsPerSlot" />
        </div>
      </div>

      <h3 style={{ marginTop: 12 }}>Emergencies</h3>
      <div className="field">
        <label className="checkbox" style={{ color: "var(--ink)" }}>
          <input type="checkbox" name="emergencyDispatch" defaultChecked={d.emergencyDispatch} />
          <span>Offer an ASAP visit to emergency callers outside business hours. If off, emergencies are flagged and your on-call phone is texted to call them back.</span>
        </label>
      </div>
      <div className="field">
        <label htmlFor="emergencyNote">Note read to emergency callers <span className="hint">(optional)</span></label>
        <input id="emergencyNote" name="emergencyNote" type="text" defaultValue={state.values?.emergencyNote ?? d.emergencyNote} placeholder="There is a $149 after-hours dispatch fee." />
        <FieldError state={state} name="emergencyNote" />
      </div>
      <SubmitButton pendingText="Saving…">Save changes</SubmitButton>
    </form>
  );
}
