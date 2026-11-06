"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import type { ChatTurn, Profile } from "@/lib/types";
import { DEFAULT_SETTINGS, newId, store, streak as calcStreak, today, type CheckIn as CheckInT, type Settings, type Win } from "@/lib/store";
import { pickVoice, speak, stopSpeaking, useVoices } from "@/lib/speech";
import { askFutureSelf, countManualWin, register } from "./api";
import Setup from "./Setup";
import Talk, { type Phase } from "./Talk";
import CheckIn from "./CheckIn";
import Wins from "./Wins";
import SettingsScreen from "./SettingsScreen";
import Celebrate from "./Celebrate";
import { GearIcon, SunriseIcon, TalkIcon, TrophyIcon } from "./Icons";

type Tab = "talk" | "checkin" | "wins" | "settings";

const THEME_COLOR = { dark: "#07060b", bright: "#fff8f1" };

function applyTheme(theme: Settings["theme"]) {
  document.documentElement.dataset.theme = theme;
  document.querySelector('meta[name="theme-color"]')?.setAttribute("content", THEME_COLOR[theme]);
}

export default function App() {
  const [loaded, setLoaded] = useState(false);
  const [profile, setProfile] = useState<Profile | null>(null);
  const [editing, setEditing] = useState(false);
  const [tab, setTab] = useState<Tab>("talk");
  const [history, setHistory] = useState<ChatTurn[]>([]);
  const [wins, setWins] = useState<Win[]>([]);
  const [checkins, setCheckins] = useState<CheckInT[]>([]);
  const [settings, setSettings] = useState<Settings>(DEFAULT_SETTINGS);
  const [phase, setPhase] = useState<Phase>("idle");
  const [error, setError] = useState<string | null>(null);
  const [celebrating, setCelebrating] = useState<string | null>(null);
  const voices = useVoices();
  const settingsRef = useRef(settings);
  settingsRef.current = settings;
  const voicesRef = useRef(voices);
  voicesRef.current = voices;

  // Load everything from this phone.
  useEffect(() => {
    const p = store.profile();
    setProfile(p);
    setHistory(store.history());
    setWins(store.wins());
    setCheckins(store.checkins());
    const s = store.settings();
    setSettings(s);
    applyTheme(s.theme);
    if (!store.checkins().some((c) => c.date === today() && c.reply) && p) setTab("checkin");
    setLoaded(true);
    if (p) register();
    if ("serviceWorker" in navigator && process.env.NODE_ENV === "production") {
      navigator.serviceWorker.register("/sw.js").catch(() => {});
    }
  }, []);

  const say = useCallback((text: string, force = false) => {
    const s = settingsRef.current;
    if (!s.autoSpeak && !force) return;
    setPhase("speaking");
    speak(text, pickVoice(voicesRef.current, s.voiceURI), s.rate, () => setPhase((ph) => (ph === "speaking" ? "idle" : ph)));
  }, []);

  const addWin = useCallback((text: string, source: Win["source"]) => {
    const w: Win = { id: newId(), text, at: new Date().toISOString(), source };
    setWins((prev) => {
      const next = [w, ...prev];
      store.setWins(next);
      return next;
    });
    setCelebrating(text);
  }, []);

  const streak = calcStreak(checkins);
  const todays = checkins.find((c) => c.date === today()) ?? null;
  const recentWins = wins.slice(0, 5).map((w) => w.text);
  const localTime = () => new Date().toLocaleString(undefined, { weekday: "long", hour: "numeric", minute: "2-digit" });

  const send = useCallback(
    async (text: string) => {
      if (!profile || phase === "thinking") return;
      stopSpeaking();
      setError(null);
      const before = history;
      const withUser = [...before, { role: "user" as const, text }];
      setHistory(withUser);
      setPhase("thinking");
      try {
        const r = await askFutureSelf({ mode: "talk", profile, message: text, history: before.slice(-12), recentWins, streak, localTime: localTime() });
        const next = [...withUser, { role: "future" as const, text: r.reply }];
        setHistory(next);
        store.setHistory(next);
        setPhase("idle");
        if (r.win) addWin(r.win, "chat");
        say(r.reply);
      } catch (e) {
        setHistory(before);
        setPhase("idle");
        setError((e as Error).message);
      }
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [profile, phase, history, wins, checkins, say, addWin],
  );

  const submitCheckin = async (yesterday: string, move: string) => {
    if (!profile) return;
    stopSpeaking();
    setError(null);
    setPhase("thinking");
    try {
      const r = await askFutureSelf({ mode: "checkin", profile, message: "", history: history.slice(-6), recentWins, streak, checkin: { yesterday, move }, localTime: localTime() });
      const entry: CheckInT = { date: today(), yesterday, move, reply: r.reply };
      const next = [...checkins.filter((c) => c.date !== entry.date), entry];
      setCheckins(next);
      store.setCheckins(next);
      const h = [...history, { role: "user" as const, text: `Check-in\nYesterday: ${yesterday || "—"}\nToday's move: ${move || "—"}` }, { role: "future" as const, text: r.reply }];
      setHistory(h);
      store.setHistory(h);
      setPhase("idle");
      if (r.win) addWin(r.win, "checkin");
      say(r.reply);
    } catch (e) {
      setPhase("idle");
      setError((e as Error).message);
    }
  };

  const markMoveDone = () => {
    if (!todays) return;
    const next = checkins.map((c) => (c.date === todays.date ? { ...c, done: true } : c));
    setCheckins(next);
    store.setCheckins(next);
    addWin(todays.move, "checkin");
    countManualWin();
  };

  const updateSettings = (s: Settings) => {
    setSettings(s);
    store.setSettings(s);
    applyTheme(s.theme);
  };

  const saveProfile = (p: Profile) => {
    const first = !profile;
    setProfile(p);
    store.setProfile(p);
    setEditing(false);
    if (first) {
      register();
      setTab("talk");
    }
  };

  const goTab = (t: Tab) => {
    setError(null);
    setTab(t);
    window.scrollTo(0, 0);
  };

  if (!loaded) return <div className="boot" aria-hidden><div className="orb orb-small" /></div>;

  if (!profile || editing) {
    return (
      <div className="app">
        <main className="main">
          <Setup initial={profile} onSave={saveProfile} onCancel={profile ? () => setEditing(false) : undefined} />
        </main>
      </div>
    );
  }

  return (
    <div className="app">
      <header className="topbar">
        <div className="brand"><span className="brand-dot" aria-hidden />Future Self</div>
        {streak > 0 && <div className="topbar-streak" title="Check-in streak">🔥 {streak}</div>}
      </header>

      <main className="main">
        {tab === "talk" && (
          <Talk
            profile={profile}
            history={history}
            phase={phase}
            error={error}
            onSend={send}
            onStopSpeaking={() => { stopSpeaking(); setPhase("idle"); }}
            onReplay={(t) => say(t, true)}
          />
        )}
        {tab === "checkin" && (
          <CheckIn
            name={profile.name}
            todays={todays}
            streak={streak}
            busy={phase === "thinking"}
            error={error}
            onSubmit={submitCheckin}
            onDone={markMoveDone}
            onReplay={(t) => say(t, true)}
          />
        )}
        {tab === "wins" && (
          <Wins
            wins={wins}
            onAdd={(t) => { addWin(t, "manual"); countManualWin(); }}
            onDelete={(id) => { const next = wins.filter((w) => w.id !== id); setWins(next); store.setWins(next); }}
          />
        )}
        {tab === "settings" && (
          <SettingsScreen
            settings={settings}
            name={profile.name}
            onChange={updateSettings}
            onEditSetup={() => setEditing(true)}
            onClearChat={() => { setHistory([]); store.setHistory([]); }}
            onEraseAll={() => {
              stopSpeaking();
              store.clearAll();
              setProfile(null); setHistory([]); setWins([]); setCheckins([]);
              setSettings(DEFAULT_SETTINGS); applyTheme("dark"); setTab("talk");
            }}
          />
        )}
      </main>

      <nav className="tabbar" aria-label="Main">
        {([
          ["talk", "Talk", <TalkIcon key="i" />],
          ["checkin", "Check-in", <SunriseIcon key="i" />],
          ["wins", "Wins", <TrophyIcon key="i" />],
          ["settings", "Settings", <GearIcon key="i" />],
        ] as const).map(([key, label, icon]) => (
          <button key={key} type="button" className={`tab${tab === key ? " on" : ""}`} aria-current={tab === key ? "page" : undefined} onClick={() => goTab(key)}>
            {icon}
            <span>{label}</span>
            {key === "checkin" && !todays?.reply && <i className="tab-dot" aria-label="Not done today" />}
          </button>
        ))}
      </nav>

      {celebrating && <Celebrate text={celebrating} onDone={() => setCelebrating(null)} />}
    </div>
  );
}
