"use client";

import { useState } from "react";
import type { CheckIn as CheckInT } from "@/lib/store";
import { unlockSpeech, useListener } from "@/lib/speech";
import HoldButton from "./HoldButton";
import { CheckIcon, MicIcon, SpeakerIcon } from "./Icons";

function MicField({ label, hint, value, onChange, rows }: { label: string; hint: string; value: string; onChange: (v: string) => void; rows: number }) {
  const l = useListener((t) => onChange(value ? `${value} ${t}` : t));
  return (
    <div className="field">
      <span>{label}</span>
      <div className="mic-field">
        <textarea value={l.interim ? `${value} ${l.interim}`.trim() : value} onChange={(e) => onChange(e.target.value)} rows={rows} maxLength={1500} placeholder={hint} />
        {l.supported && (
          <HoldButton
            className={`mini-mic${l.listening ? " on" : ""}`}
            label={l.listening ? "Listening, let go when done" : `Hold to answer by voice: ${label}`}
            onTap={() => { unlockSpeech(); return false; }}
            onStart={l.start}
            onEnd={l.stop}
          >
            <MicIcon size={20} />
          </HoldButton>
        )}
      </div>
      {l.error && <small className="error-line">{l.error}</small>}
    </div>
  );
}

export default function CheckIn({
  name, todays, streak, busy, error, onSubmit, onDone, onReplay,
}: {
  name: string;
  todays: CheckInT | null;
  streak: number;
  busy: boolean;
  error: string | null;
  onSubmit: (yesterday: string, move: string) => void;
  onDone: () => void;
  onReplay: (text: string) => void;
}) {
  const [yesterday, setYesterday] = useState("");
  const [move, setMove] = useState("");

  return (
    <div className="screen checkin">
      <div className="streak">
        <div className="streak-num">{streak}</div>
        <div className="streak-label">day{streak === 1 ? "" : "s"} in a row</div>
      </div>

      {todays?.reply ? (
        <>
          <div className="bubble future big">{todays.reply}</div>
          <button type="button" className="chip" onClick={() => { unlockSpeech(); onReplay(todays.reply); }}><SpeakerIcon /> Hear it again</button>
          <div className={`move-card${todays.done ? " done" : ""}`}>
            <div className="move-kicker">Today&apos;s one move</div>
            <div className="move-text">{todays.move || "—"}</div>
            {todays.done ? (
              <div className="move-done"><CheckIcon /> Done. That&apos;s a win.</div>
            ) : (
              <button type="button" className="btn btn-gold" onClick={onDone} disabled={!todays.move}>I did it</button>
            )}
          </div>
          <p className="muted center">Come back tomorrow, {name}. Future you will ask how it went.</p>
        </>
      ) : (
        <form
          onSubmit={(e) => {
            e.preventDefault();
            unlockSpeech();
            if (!busy && (yesterday.trim() || move.trim())) onSubmit(yesterday.trim(), move.trim());
          }}
        >
          <div className="bubble future">Morning, {name}. Two questions, then go get it.</div>
          <MicField label="How did yesterday go?" hint="Be honest. Wins, misses, all of it." value={yesterday} onChange={setYesterday} rows={3} />
          <MicField label="What's today's one move?" hint="The one thing that, done today, moves us forward." value={move} onChange={setMove} rows={2} />
          {error && <p className="error-line" role="alert">{error}</p>}
          <button className="btn btn-primary btn-block" disabled={busy || !(yesterday.trim() || move.trim())}>
            {busy ? "Future you is thinking…" : "Check in"}
          </button>
        </form>
      )}
    </div>
  );
}
