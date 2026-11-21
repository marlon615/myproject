"use client";

import { useEffect, useRef, useState } from "react";
import type { ChatTurn, Profile } from "@/lib/types";
import { unlockSpeech, useListener } from "@/lib/speech";
import HoldButton from "./HoldButton";
import { MicIcon, SendIcon, SpeakerIcon, StopIcon } from "./Icons";

export type Phase = "idle" | "listening" | "thinking" | "speaking";

export function greeting(p: Profile) {
  const h = new Date().getHours();
  const part = h < 12 ? "Morning" : h < 18 ? "Hey" : "Evening";
  return `${part}, ${p.name}. It's you, five years from now. We made it, and I remember exactly where you're standing right now. Hold the button and tell me what's on your mind.`;
}

export default function Talk({
  profile, history, phase, error, onSend, onStopSpeaking, onReplay,
}: {
  profile: Profile;
  history: ChatTurn[];
  phase: Phase;
  error: string | null;
  onSend: (text: string) => void;
  onStopSpeaking: () => void;
  onReplay: (text: string) => void;
}) {
  const [typing, setTyping] = useState(false);
  const [draft, setDraft] = useState("");
  const listener = useListener(onSend);
  const chatRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const el = chatRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [history.length, phase, listener.interim]);

  useEffect(() => {
    if (listener.supported === false) setTyping(true);
  }, [listener.supported]);

  const live: Phase = listener.listening ? "listening" : phase;
  const status =
    live === "listening" ? "Listening… let go when you're done"
    : live === "thinking" ? "Future you is thinking…"
    : live === "speaking" ? "Tap to stop"
    : listener.supported ? "Hold to talk"
    : "Type to talk";

  const shown = history.slice(-8);
  const last = [...history].reverse().find((t) => t.role === "future");

  return (
    <div className="screen talk">
      <div className="chat" aria-live="polite" ref={chatRef}>
        {shown.length === 0 && <div className="bubble future">{greeting(profile)}</div>}
        {shown.map((t, i) => (
          <div key={history.length - shown.length + i} className={`bubble ${t.role}`}>{t.text}</div>
        ))}
        {listener.interim && <div className="bubble user interim">{listener.interim}</div>}
        {live === "thinking" && (
          <div className="bubble future dots" aria-label="Future you is thinking"><i /><i /><i /></div>
        )}
      </div>

      {(error || listener.error) && <p className="error-line" role="alert">{error || listener.error}</p>}

      <div className="talk-controls">
        <HoldButton
          className={`orb orb-button phase-${live}`}
          label={status}
          disabled={!listener.supported || live === "thinking"}
          onTap={() => {
            unlockSpeech();
            if (phase === "speaking") {
              onStopSpeaking();
              return true;
            }
            return false;
          }}
          onStart={listener.start}
          onEnd={listener.stop}
        >
          <span className="orb-core">{live === "speaking" ? <StopIcon /> : <MicIcon size={40} />}</span>
          <span className="orb-ring" aria-hidden />
          <span className="orb-ring r2" aria-hidden />
        </HoldButton>
        <div className="talk-status">{status}</div>

        <div className="talk-tools">
          {listener.supported && (
            <button type="button" className="chip" onClick={() => setTyping((t) => !t)}>{typing ? "Hide keyboard" : "Type instead"}</button>
          )}
          {last && phase === "idle" && (
            <button type="button" className="chip" onClick={() => { unlockSpeech(); onReplay(last.text); }}>
              <SpeakerIcon /> Replay
            </button>
          )}
        </div>

        {typing && (
          <form
            className="type-row"
            onSubmit={(e) => {
              e.preventDefault();
              unlockSpeech();
              const t = draft.trim();
              if (!t || phase === "thinking") return;
              setDraft("");
              onSend(t);
            }}
          >
            <input value={draft} onChange={(e) => setDraft(e.target.value)} placeholder="Tell future you…" maxLength={2000} enterKeyHint="send" />
            <button className="icon-btn" aria-label="Send" disabled={!draft.trim() || phase === "thinking"}><SendIcon /></button>
          </form>
        )}
      </div>
    </div>
  );
}
