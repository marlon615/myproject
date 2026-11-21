"use client";

import { useEffect, useState } from "react";
import type { Settings, Theme } from "@/lib/store";
import { pickVoice, speak, unlockSpeech, useVoices } from "@/lib/speech";

const THEMES: { key: Theme; name: string; desc: string }[] = [
  { key: "dark", name: "Dark & cinematic", desc: "Black with glowing purple and gold" },
  { key: "bright", name: "Bright & motivating", desc: "White with warm colors" },
];

export default function SettingsScreen({
  settings, name, onChange, onEditSetup, onClearChat, onEraseAll,
}: {
  settings: Settings;
  name: string;
  onChange: (s: Settings) => void;
  onEditSetup: () => void;
  onClearChat: () => void;
  onEraseAll: () => void;
}) {
  const voices = useVoices();
  const current = pickVoice(voices, settings.voiceURI);
  const [standalone, setStandalone] = useState(true);
  const [ios, setIos] = useState(false);

  useEffect(() => {
    setStandalone(window.matchMedia("(display-mode: standalone)").matches || (navigator as unknown as { standalone?: boolean }).standalone === true);
    setIos(/iPhone|iPad|iPod/.test(navigator.userAgent));
  }, []);

  const lang = typeof navigator !== "undefined" ? navigator.language.slice(0, 2) : "en";
  const list = voices.filter((v) => v.lang?.toLowerCase().startsWith(lang)).sort((a, b) => a.name.localeCompare(b.name));

  return (
    <div className="screen settings">
      <h1 className="screen-title">Settings</h1>

      <section className="group">
        <h2>Look</h2>
        <div className="theme-grid" role="radiogroup" aria-label="App look">
          {THEMES.map((t) => (
            <button
              key={t.key}
              type="button"
              role="radio"
              aria-checked={settings.theme === t.key}
              className={`theme-card theme-${t.key}${settings.theme === t.key ? " on" : ""}`}
              onClick={() => onChange({ ...settings, theme: t.key })}
            >
              <span className="theme-swatch" aria-hidden><i /><i /><i /></span>
              <span className="theme-name">{t.name}</span>
              <span className="theme-desc">{t.desc}</span>
            </button>
          ))}
        </div>
      </section>

      <section className="group">
        <h2>Future you&apos;s voice</h2>
        <label className="toggle">
          <span>Speak replies out loud</span>
          <input type="checkbox" checked={settings.autoSpeak} onChange={(e) => onChange({ ...settings, autoSpeak: e.target.checked })} />
        </label>
        {list.length > 0 && (
          <label className="field">
            <span>Voice</span>
            <select value={current?.voiceURI ?? ""} onChange={(e) => onChange({ ...settings, voiceURI: e.target.value })}>
              {list.map((v) => <option key={v.voiceURI} value={v.voiceURI}>{v.name}</option>)}
            </select>
          </label>
        )}
        <label className="field">
          <span>Speed · {settings.rate.toFixed(2)}×</span>
          <input type="range" min={0.7} max={1.4} step={0.05} value={settings.rate} onChange={(e) => onChange({ ...settings, rate: Number(e.target.value) })} />
        </label>
        <button type="button" className="btn btn-ghost" onClick={() => { unlockSpeech(); speak(`${name}, this is how I sound. We've got this.`, current, settings.rate); }}>
          Test voice
        </button>
        <p className="fine">Voices come from your phone. On iPhone you can download nicer ones in Settings → Accessibility → Spoken Content → Voices.</p>
      </section>

      <section className="group">
        <h2>You</h2>
        <button type="button" className="btn btn-ghost btn-block" onClick={onEditSetup}>Edit name, goals, money target and habits</button>
        <button type="button" className="btn btn-ghost btn-block" onClick={() => { if (confirm("Clear the conversation? Your wins and check-ins stay.")) onClearChat(); }}>Clear conversation</button>
        <button type="button" className="btn btn-danger btn-block" onClick={() => { if (confirm("Erase everything on this phone? This can't be undone.")) onEraseAll(); }}>Erase all my data</button>
      </section>

      {!standalone && (
        <section className="group">
          <h2>Put it on your home screen</h2>
          {ios ? (
            <p className="muted">In Safari, tap the Share button, then <b>Add to Home Screen</b>. Future Self opens full screen like a real app.</p>
          ) : (
            <p className="muted">Open your browser menu (⋮) and tap <b>Install app</b> or <b>Add to Home screen</b>.</p>
          )}
        </section>
      )}

      <p className="fine center">Your goals, chats and wins are saved on this phone only.</p>
    </div>
  );
}
