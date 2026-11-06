"use client";

import { useCallback, useEffect, useRef, useState } from "react";

// ───────────── Listening (speech → text) ─────────────

type Recognition = {
  lang: string;
  continuous: boolean;
  interimResults: boolean;
  start: () => void;
  stop: () => void;
  abort: () => void;
  onresult: ((e: { resultIndex: number; results: ArrayLike<ArrayLike<{ transcript: string }> & { isFinal: boolean }> }) => void) | null;
  onerror: ((e: { error: string }) => void) | null;
  onend: (() => void) | null;
};

function recognitionCtor(): (new () => Recognition) | null {
  if (typeof window === "undefined") return null;
  const w = window as unknown as { SpeechRecognition?: new () => Recognition; webkitSpeechRecognition?: new () => Recognition };
  return w.SpeechRecognition ?? w.webkitSpeechRecognition ?? null;
}

/**
 * Hold-to-talk. Call start() when the finger goes down and stop() when it lifts.
 * onDone gets the full transcript once the browser has finished listening.
 */
export function useListener(onDone: (text: string) => void) {
  const [supported, setSupported] = useState(false);
  const [listening, setListening] = useState(false);
  const [interim, setInterim] = useState("");
  const [error, setError] = useState<string | null>(null);
  const rec = useRef<Recognition | null>(null);
  const finalText = useRef("");
  const done = useRef(onDone);
  done.current = onDone;

  useEffect(() => setSupported(Boolean(recognitionCtor())), []);

  const start = useCallback(() => {
    const Ctor = recognitionCtor();
    if (!Ctor || rec.current) return;
    setError(null);
    finalText.current = "";
    setInterim("");
    const r = new Ctor();
    r.lang = navigator.language || "en-US";
    r.continuous = true;
    r.interimResults = true;
    r.onresult = (e) => {
      let live = "";
      for (let i = e.resultIndex; i < e.results.length; i++) {
        const res = e.results[i];
        if (res.isFinal) finalText.current += res[0].transcript + " ";
        else live += res[0].transcript;
      }
      setInterim((finalText.current + live).trim());
    };
    r.onerror = (e) => {
      if (e.error === "not-allowed" || e.error === "service-not-allowed") setError("Microphone is blocked. Allow it in your phone's settings, or type instead.");
      else if (e.error !== "no-speech" && e.error !== "aborted") setError("I didn't catch that. Try again, or type instead.");
    };
    r.onend = () => {
      rec.current = null;
      setListening(false);
      const text = finalText.current.trim();
      setInterim("");
      if (text) done.current(text);
    };
    try {
      r.start();
      rec.current = r;
      setListening(true);
    } catch {
      setError("Couldn't start the microphone. Try again, or type instead.");
    }
  }, []);

  const stop = useCallback(() => {
    const r = rec.current;
    if (!r) return;
    // Give the last word a moment to land before stopping.
    setTimeout(() => r.stop(), 250);
  }, []);

  useEffect(() => () => rec.current?.abort(), []);

  return { supported, listening, interim, error, start, stop };
}

// ───────────── Speaking (text → voice) ─────────────

export function useVoices() {
  const [voices, setVoices] = useState<SpeechSynthesisVoice[]>([]);
  useEffect(() => {
    if (typeof speechSynthesis === "undefined") return;
    const load = () => setVoices(speechSynthesis.getVoices());
    load();
    speechSynthesis.addEventListener?.("voiceschanged", load);
    return () => speechSynthesis.removeEventListener?.("voiceschanged", load);
  }, []);
  return voices;
}

/** Picks the chosen voice, or a good default in the phone's language. */
export function pickVoice(voices: SpeechSynthesisVoice[], uri: string) {
  if (uri) {
    const v = voices.find((x) => x.voiceURI === uri);
    if (v) return v;
  }
  const lang = (typeof navigator !== "undefined" && navigator.language) || "en-US";
  const same = voices.filter((v) => v.lang?.toLowerCase().startsWith(lang.slice(0, 2).toLowerCase()));
  const pool = same.length ? same : voices;
  const pref = ["Premium", "Enhanced", "Natural", "Neural", "Google", "Samantha", "Daniel", "Alex"];
  for (const p of pref) {
    const v = pool.find((x) => x.name.includes(p));
    if (v) return v;
  }
  return pool.find((v) => v.default) ?? pool[0] ?? null;
}

let unlocked = false;
/** iPhones only allow speech after a tap. Call this inside a tap handler once. */
export function unlockSpeech() {
  if (unlocked || typeof speechSynthesis === "undefined") return;
  unlocked = true;
  try {
    const u = new SpeechSynthesisUtterance(" ");
    u.volume = 0;
    speechSynthesis.speak(u);
  } catch {}
}

export function speak(text: string, voice: SpeechSynthesisVoice | null, rate: number, onEnd?: () => void) {
  if (typeof speechSynthesis === "undefined") {
    onEnd?.();
    return;
  }
  speechSynthesis.cancel();
  const u = new SpeechSynthesisUtterance(text);
  if (voice) {
    u.voice = voice;
    u.lang = voice.lang;
  }
  u.rate = rate;
  u.pitch = 1;
  u.onend = () => onEnd?.();
  u.onerror = () => onEnd?.();
  speechSynthesis.speak(u);
}

export function stopSpeaking() {
  if (typeof speechSynthesis !== "undefined") speechSynthesis.cancel();
}
