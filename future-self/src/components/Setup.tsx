"use client";

import { useState } from "react";
import type { Profile } from "@/lib/types";

const EMPTY: Profile = { name: "", goals: "", moneyTarget: "", habits: "" };

export default function Setup({ initial, onSave, onCancel }: { initial: Profile | null; onSave: (p: Profile) => void; onCancel?: () => void }) {
  const [p, setP] = useState<Profile>(initial ?? EMPTY);
  const set = (k: keyof Profile) => (e: React.ChangeEvent<HTMLInputElement | HTMLTextAreaElement>) => setP({ ...p, [k]: e.target.value });
  const ok = p.name.trim() && p.goals.trim();

  return (
    <form
      className="screen setup"
      onSubmit={(e) => {
        e.preventDefault();
        if (ok) onSave({ name: p.name.trim(), goals: p.goals.trim(), moneyTarget: p.moneyTarget.trim(), habits: p.habits.trim() });
      }}
    >
      {!initial && (
        <div className="setup-hero">
          <div className="orb orb-small" aria-hidden />
          <h1>Meet the version of you who made it.</h1>
          <p className="muted">Five years from now, you already did it. Tell future you what you&apos;re going after, and talk every day.</p>
        </div>
      )}
      {initial && <h1 className="screen-title">Your set-up</h1>}

      <label className="field">
        <span>Your first name</span>
        <input value={p.name} onChange={set("name")} maxLength={60} autoComplete="given-name" placeholder="Jordan" required />
      </label>
      <label className="field">
        <span>Your goals</span>
        <textarea value={p.goals} onChange={set("goals")} maxLength={1200} rows={3} placeholder="Launch my own business, get in the best shape of my life, buy a house" required />
      </label>
      <label className="field">
        <span>Money target</span>
        <input value={p.moneyTarget} onChange={set("moneyTarget")} maxLength={200} placeholder="$10,000 a month by 2028" />
      </label>
      <label className="field">
        <span>Daily habits</span>
        <textarea value={p.habits} onChange={set("habits")} maxLength={800} rows={3} placeholder="Up at 6, workout, 1 hour on the business, read 10 pages, no phone after 10pm" />
      </label>

      <p className="fine">Saved on this phone only. Your words are only sent out to write future you&apos;s replies.</p>
      <div className="row">
        {onCancel && <button type="button" className="btn btn-ghost" onClick={onCancel}>Cancel</button>}
        <button className="btn btn-primary btn-grow" disabled={!ok}>{initial ? "Save" : "Meet future me"}</button>
      </div>
    </form>
  );
}
