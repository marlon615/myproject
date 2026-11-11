/**
 * Speech to text for the voice invoice.
 *
 * - Uses the browser's own speech recognition, on the phone itself when it can (Chrome's on-device speech:
 *   SpeechRecognition.available()/install() + processLocally; Safari uses Apple's recognition).
 * - Keeps listening until stop() — no holding — restarting quietly if the browser pauses after a silence.
 * - When listening isn't possible (no recognition, blocked, offline without on-device speech, or an iPhone
 *   home-screen app that doesn't allow it), callers fall back to dictate(): a text box for the keyboard's
 *   microphone, which iPhones run on the device, offline.
 */
import { choiceSheet } from "./ui.js";
import { h } from "./util.js";

const Recognition = () => globalThis.SpeechRecognition || globalThis.webkitSpeechRecognition || null;

export const canListen = () => Boolean(Recognition());

const FATAL = new Set(["not-allowed", "service-not-allowed", "audio-capture", "network", "language-not-supported", "bad-grammar"]);

function languages() {
  const list = [navigator.language, "en-US"].filter((l) => /^en\b/i.test(l || ""));
  return [...new Set(list.length ? list : ["en-US"])];
}

/** Chrome's on-device speech: is a language ready, or downloadable? → { lang, onDevice } */
async function onDevicePlan(Ctor) {
  const langs = languages();
  let downloadable = null;
  for (const lang of langs) {
    try {
      const status = await Ctor.available({ langs: [lang], processLocally: true });
      if (status === "available") return { lang, onDevice: true };
      if ((status === "downloadable" || status === "downloading") && !downloadable) downloadable = lang;
    } catch { /* this browser's shape of the API differs: let it decide */ }
  }
  if (downloadable && typeof Ctor.install === "function") {
    Ctor.install({ langs: [downloadable], processLocally: true }).catch(() => {}); // one-time download for next time
  }
  return { lang: langs[0], onDevice: false, downloading: Boolean(downloadable) };
}

export class Listener {
  /** onText(textSoFar) while listening; onFail(code, textSoFar) if listening can't continue. */
  constructor({ onText = () => {}, onFail = () => {} } = {}) {
    this.onText = onText;
    this.onFail = onFail;
    this.finals = [];   // each: [alternative1, alternative2, …]
    this.interim = "";
    this.active = false;
    this.rec = null;
    this.mode = null;   // "on-device" | "browser"
    this.done = null;
  }

  text() {
    return [...this.finals.map((a) => a[0]), this.interim].join(" ").replace(/\s+/g, " ").trim();
  }

  /** Transcripts to try: the best guess, then each alternative the recogniser offered for one phrase. */
  candidates() {
    const base = this.finals.map((a) => a[0]);
    const out = [base.join(" ")];
    this.finals.forEach((alts, k) => alts.slice(1, 3).forEach((alt) => { const c = [...base]; c[k] = alt; out.push(c.join(" ")); }));
    return out.slice(0, 12);
  }

  /**
   * Starts listening. Call from a tap. Safari needs recognition to start inside the tap itself, so the
   * on-device check only happens where the browser offers it (Chrome), which allows a moment after the tap.
   * → Promise<{ mode, downloading }>
   */
  start() {
    const Ctor = Recognition();
    if (!Ctor) return Promise.reject(Object.assign(new Error("unsupported"), { code: "unsupported" }));
    this.active = true;
    this.restarts = 0;
    if (typeof Ctor.available !== "function") {
      this.#go(Ctor, languages()[0], false);
      this.mode = "browser";
      return Promise.resolve({ mode: this.mode, downloading: false });
    }
    return onDevicePlan(Ctor).then(({ lang, onDevice, downloading }) => {
      if (!this.active) return { mode: null, downloading };
      if (!onDevice && !navigator.onLine) throw Object.assign(new Error("offline"), { code: "offline", downloading });
      this.#go(Ctor, lang, onDevice);
      this.mode = onDevice ? "on-device" : "browser";
      return { mode: this.mode, downloading };
    });
  }

  #go(Ctor, lang, onDevice) {
    const rec = new Ctor();
    this.rec = rec;
    rec.lang = lang;
    rec.continuous = true;
    rec.interimResults = true;
    rec.maxAlternatives = 3;
    if (onDevice && "processLocally" in rec) rec.processLocally = true;
    rec.onresult = (e) => {
      let interim = "";
      for (let k = e.resultIndex; k < e.results.length; k++) {
        const r = e.results[k];
        if (r.isFinal) {
          const alts = Array.from({ length: r.length }, (_, a) => r[a].transcript.trim()).filter(Boolean);
          if (alts.length) this.finals.push(alts);
        } else interim += r[0].transcript;
      }
      this.interim = interim;
      this.onText(this.text());
    };
    rec.onerror = (e) => {
      if (!FATAL.has(e.error)) return; // "no-speech" and "aborted" just mean a pause
      const wasActive = this.active;
      this.active = false;
      this.failed = e.error;
      if (wasActive) this.onFail(e.error === "network" ? "offline" : e.error, this.text());
    };
    rec.onend = () => {
      if (this.active && this.restarts < 40) {
        this.restarts++;
        try { rec.start(); return; } catch { /* fall through to finishing */ }
      }
      if (this.interim) { this.finals.push([this.interim.trim()]); this.interim = ""; }
      this.active = false;
      this.done?.();
    };
    rec.start();
  }

  /**
   * Stops listening and resolves with { text, candidates, segments } once the last words are in.
   * segments: the phone's guesses phrase by phrase ([[guess1, guess2…], …]); words still being heard are kept too.
   */
  stop() {
    this.active = false;
    return new Promise((resolve) => {
      let settled = false;
      const finish = () => {
        if (settled) return;
        settled = true;
        if (this.interim.trim()) { this.finals.push([this.interim.trim()]); this.interim = ""; }
        resolve({ text: this.text(), candidates: this.candidates(), segments: this.finals.map((alts) => [...alts]) });
      };
      this.done = finish;
      try { this.rec?.stop(); } catch { finish(); }
      if (!this.rec) finish();
      setTimeout(finish, 2500); // never hang if the browser doesn't report the end
    });
  }

  abort() {
    this.active = false;
    try { this.rec?.abort(); } catch { /* already stopped */ }
  }
}

const REASONS = {
  unsupported: "This browser can't listen directly here.",
  offline: "Listening needs the internet on this phone right now.",
  "not-allowed": "The microphone is blocked for this app.",
  "service-not-allowed": "This phone doesn't allow listening inside the home-screen app.",
  "audio-capture": "No microphone was found.",
  "language-not-supported": "Listening isn't available in this language here.",
  error: "Listening stopped unexpectedly.",
};

/**
 * The fallback: a text box for the keyboard's microphone (iPhone dictation works offline, on the device).
 * Resolves with the text, or null if cancelled.
 */
export async function dictate({ reason = "unsupported", text = "" } = {}) {
  const isApple = /iPhone|iPad|iPod|Macintosh/.test(navigator.userAgent);
  const box = h("textarea", {
    class: "dictate-box", rows: "6", autocapitalize: "sentences", spellcheck: "false",
    placeholder: "Sarah Supermarket, 14 Wellington Street, Brownstone, two dozen beetroot juice, fifty pounds okra at two fifty",
    "aria-label": "Say or type the invoice",
  });
  box.value = text;
  const blocked = reason === "not-allowed";
  const message = h("div", { class: "dictate-help" },
    h("p", {}, REASONS[reason] || REASONS.error),
    h("p", {}, isApple
      ? "Tap the microphone on your keyboard, say the whole invoice, then tap Done. Your iPhone does this on the phone itself, even offline."
      : "Tap the microphone on your keyboard and say the whole invoice (or type it), then tap Done."),
    blocked ? h("p", { class: "dictate-note" }, "To listen directly next time, allow the microphone for this app in your phone's settings.") : null,
    box);
  const done = choiceSheet({
    title: "Say the invoice",
    message,
    choices: [{ label: "Cancel", value: null }, { label: "Done", value: "done", primary: true }],
  });
  requestAnimationFrame(() => { box.focus(); box.setSelectionRange(box.value.length, box.value.length); });
  const choice = await done;
  return choice === "done" ? box.value.trim() : null;
}
