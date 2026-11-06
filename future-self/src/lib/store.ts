"use client";

import type { ChatTurn, Profile } from "@/lib/types";

/** Everything personal lives in this phone's storage. Nothing here is sent anywhere except to write a reply. */

export type Theme = "dark" | "bright";
export type Win = { id: string; text: string; at: string; source: "chat" | "checkin" | "manual" };
export type CheckIn = { date: string; yesterday: string; move: string; reply: string; done?: boolean };
export type Settings = { theme: Theme; autoSpeak: boolean; voiceURI: string; rate: number };

const K = {
  profile: "fs_profile",
  history: "fs_history",
  wins: "fs_wins",
  checkins: "fs_checkins",
  settings: "fs_settings",
  theme: "fs_theme",
} as const;

function read<T>(key: string, fallback: T): T {
  try {
    const raw = localStorage.getItem(key);
    return raw ? (JSON.parse(raw) as T) : fallback;
  } catch {
    return fallback;
  }
}
function write(key: string, value: unknown) {
  try {
    localStorage.setItem(key, JSON.stringify(value));
  } catch {
    /* storage full or blocked: keep going in memory */
  }
}

export const DEFAULT_SETTINGS: Settings = { theme: "dark", autoSpeak: true, voiceURI: "", rate: 1 };

export const store = {
  profile: () => read<Profile | null>(K.profile, null),
  setProfile: (p: Profile) => write(K.profile, p),
  history: () => read<ChatTurn[]>(K.history, []),
  setHistory: (h: ChatTurn[]) => write(K.history, h.slice(-40)),
  wins: () => read<Win[]>(K.wins, []),
  setWins: (w: Win[]) => write(K.wins, w.slice(0, 1000)),
  checkins: () => read<CheckIn[]>(K.checkins, []),
  setCheckins: (c: CheckIn[]) => write(K.checkins, c.slice(-400)),
  settings: () => ({ ...DEFAULT_SETTINGS, ...read<Partial<Settings>>(K.settings, {}) }),
  setSettings: (s: Settings) => {
    write(K.settings, s);
    try {
      localStorage.setItem(K.theme, s.theme);
    } catch {}
  },
  clearAll: () => {
    try {
      Object.values(K).forEach((k) => localStorage.removeItem(k));
    } catch {}
  },
};

/** Today's date on this phone, as YYYY-MM-DD. */
export function today(d = new Date()) {
  const p = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}

/** Consecutive days with a finished check-in, counting back from today (or yesterday if today isn't done yet). */
export function streak(checkins: CheckIn[]) {
  const days = new Set(checkins.filter((c) => c.reply).map((c) => c.date));
  const d = new Date();
  if (!days.has(today(d))) d.setDate(d.getDate() - 1);
  let n = 0;
  while (days.has(today(d))) {
    n++;
    d.setDate(d.getDate() - 1);
  }
  return n;
}

export const newId = () => (crypto.randomUUID ? crypto.randomUUID() : String(Date.now() + Math.random()));
