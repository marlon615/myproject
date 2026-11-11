"use client";

import { useState } from "react";
import type { Win } from "@/lib/store";
import { TrashIcon } from "./Icons";

function when(iso: string) {
  const d = new Date(iso);
  const days = Math.floor((Date.now() - d.getTime()) / 86400000);
  if (days < 1 && new Date().getDate() === d.getDate()) return "Today";
  if (days < 2) return "Yesterday";
  return d.toLocaleDateString(undefined, { month: "short", day: "numeric", year: d.getFullYear() === new Date().getFullYear() ? undefined : "numeric" });
}

export default function Wins({ wins, onAdd, onDelete }: { wins: Win[]; onAdd: (text: string) => void; onDelete: (id: string) => void }) {
  const [draft, setDraft] = useState("");
  const week = wins.filter((w) => Date.now() - new Date(w.at).getTime() < 7 * 86400000).length;

  return (
    <div className="screen wins">
      <div className="wins-head">
        <div>
          <div className="wins-total">{wins.length}</div>
          <div className="muted">wins logged · {week} this week</div>
        </div>
      </div>

      <form
        className="type-row"
        onSubmit={(e) => {
          e.preventDefault();
          const t = draft.trim();
          if (!t) return;
          setDraft("");
          onAdd(t);
        }}
      >
        <input value={draft} onChange={(e) => setDraft(e.target.value)} placeholder="Log a win…" maxLength={120} />
        <button className="btn btn-gold" disabled={!draft.trim()}>Add</button>
      </form>

      {wins.length === 0 ? (
        <div className="empty">
          <p>No wins yet.</p>
          <p className="muted">Tell future you about something you did, finish a check-in move, or add one here. Every win gets saved.</p>
        </div>
      ) : (
        <ul className="win-list">
          {wins.map((w) => (
            <li key={w.id} className="win-item">
              <span className="win-star" aria-hidden>★</span>
              <div className="win-body">
                <div className="win-text">{w.text}</div>
                <div className="win-meta">{when(w.at)}{w.source === "checkin" ? " · check-in" : w.source === "chat" ? " · from a talk" : ""}</div>
              </div>
              <button type="button" className="icon-btn subtle" aria-label={`Delete win: ${w.text}`} onClick={() => { if (confirm("Delete this win?")) onDelete(w.id); }}>
                <TrashIcon />
              </button>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
