/** Spoken dates and times in the owner's time zone ("tomorrow at 3", "Tuesday at noon", "in 30 minutes"). */

const DAYS = ["sunday", "monday", "tuesday", "wednesday", "thursday", "friday", "saturday"];

/** The wall-clock parts of an instant in a time zone. */
export function zonedParts(d: Date, tz: string) {
  const f = new Intl.DateTimeFormat("en-US", { timeZone: tz, year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", second: "2-digit", hourCycle: "h23", weekday: "short" });
  const p = Object.fromEntries(f.formatToParts(d).map((x) => [x.type, x.value]));
  return { y: +p.year, m: +p.month, d: +p.day, h: +p.hour, mi: +p.minute, s: +p.second, wd: ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"].indexOf(p.weekday) };
}

/** The instant when the clock in `tz` shows the given wall time. */
export function zonedToUtc(y: number, m: number, d: number, h: number, mi: number, tz: string): Date {
  let guess = Date.UTC(y, m - 1, d, h, mi);
  for (let i = 0; i < 3; i++) {
    const p = zonedParts(new Date(guess), tz);
    const shown = Date.UTC(p.y, p.m - 1, p.d, p.h, p.mi);
    const want = Date.UTC(y, m - 1, d, h, mi);
    if (shown === want) break;
    guess += want - shown;
  }
  return new Date(guess);
}

export interface When { at: Date; hasTime: boolean; rest: string; label: string }

/** Finds a date/time phrase in the text. Returns null when there isn't one. */
export function parseWhen(text: string, tz: string, now = new Date()): When | null {
  let t = ` ${text.toLowerCase()} `;
  let o = ` ${text} `; // same text with its original capitals, cut in step with t
  const cut = (piece: string) => {
    const i = t.indexOf(piece);
    if (i < 0) return;
    t = t.slice(0, i) + " " + t.slice(i + piece.length);
    o = o.slice(0, i) + " " + o.slice(i + piece.length);
  };
  const today = zonedParts(now, tz);
  let y = today.y, m = today.m, d = today.d, dayFound = false;
  let h = 9, mi = 0, timeFound = false;

  const rel = t.match(/\s+in (an?|\d+|one|two|three|half an?) (minutes?|hours?|days?)\b/);
  if (rel) {
    const n = /half/.test(rel[1]) ? 0.5 : /^(a|an|one)$/.test(rel[1]) ? 1 : rel[1] === "two" ? 2 : rel[1] === "three" ? 3 : Number(rel[1]);
    const ms = /min/.test(rel[2]) ? n * 60_000 : /hour/.test(rel[2]) ? n * 3_600_000 : n * 86_400_000;
    const at = new Date(now.getTime() + ms);
    cut(rel[0]);
    return { at, hasTime: !/day/.test(rel[2]), rest: clean(o), label: describe(at, !/day/.test(rel[2]), tz, now) };
  }

  const setDay = (offset: number) => {
    const base = new Date(Date.UTC(today.y, today.m - 1, today.d + offset));
    y = base.getUTCFullYear(); m = base.getUTCMonth() + 1; d = base.getUTCDate(); dayFound = true;
  };
  let mt: RegExpMatchArray | null;
  if ((mt = t.match(/\s+(?:on |for )?(today|tonight|this (?:morning|afternoon|evening))\b/))) {
    setDay(0); cut(mt[0]);
    if (/tonight|evening/.test(mt[1])) { h = 19; } else if (/afternoon/.test(mt[1])) { h = 14; }
  } else if ((mt = t.match(/\s+(?:on |for )?(tomorrow|tmrw)(?: (morning|afternoon|evening|night))?\b/))) {
    setDay(1); cut(mt[0]);
    if (mt[2]) h = mt[2] === "morning" ? 9 : mt[2] === "afternoon" ? 14 : 19;
  } else if ((mt = t.match(/\s+(?:on |for |this |next )?(sunday|monday|tuesday|wednesday|thursday|friday|saturday)\b/))) {
    const target = DAYS.indexOf(mt[1]);
    let diff = (target - today.wd + 7) % 7;
    if (diff === 0) diff = 7;
    if (/next/.test(mt[0]) && diff < 7) diff += 0;
    setDay(diff); cut(mt[0]);
  }

  if ((mt = t.match(/\s+(?:at )?(noon|midday|midnight)\b/))) {
    h = mt[1] === "midnight" ? 0 : 12; mi = 0; timeFound = true; cut(mt[0]);
  } else if ((mt = t.match(/\s+at (\d{1,2})(?:[:.](\d{2}))?\s*(a\.?m\.?|p\.?m\.?|o'?clock)?(?=\s)/)) || (mt = t.match(/\s+(\d{1,2})(?:[:.](\d{2}))?\s*(a\.?m\.?|p\.?m\.?)(?=\s)/))) {
    h = Number(mt[1]); mi = Number(mt[2] ?? 0);
    const ap = (mt[3] ?? "").replace(/\./g, "");
    if (ap.startsWith("p") && h < 12) h += 12;
    if (ap.startsWith("a") && h === 12) h = 0;
    if (!ap.startsWith("a") && !ap.startsWith("p") && h >= 1 && h <= 7) h += 12; // "at 3" means 3 PM
    timeFound = h < 24 && mi < 60;
    cut(mt[0]);
  }
  if (!dayFound && !timeFound) return null;

  let at = zonedToUtc(y, m, d, h, mi, tz);
  if (!dayFound && at.getTime() < now.getTime()) at = zonedToUtc(y, m, d + 1, h, mi, tz); // "at 9" when 9 has passed = tomorrow
  return { at, hasTime: timeFound, rest: clean(o), label: describe(at, timeFound, tz, now) };
}

function clean(s: string) {
  return s.replace(/\s+/g, " ").trim().replace(/\s+(at|on|for|by)$/i, "").trim();
}

/** "today at 3 PM", "tomorrow at noon", "Tuesday at 9:30 AM". */
export function describe(at: Date, withTime: boolean, tz: string, now = new Date()) {
  const a = zonedParts(at, tz), n = zonedParts(now, tz);
  const dayDiff = Math.round((Date.UTC(a.y, a.m - 1, a.d) - Date.UTC(n.y, n.m - 1, n.d)) / 86_400_000);
  const day = dayDiff === 0 ? "today" : dayDiff === 1 ? "tomorrow" : dayDiff > 1 && dayDiff < 7 ? DAYS[a.wd][0].toUpperCase() + DAYS[a.wd].slice(1)
    : new Intl.DateTimeFormat("en-US", { timeZone: tz, month: "long", day: "numeric" }).format(at);
  if (!withTime) return day;
  return `${day} at ${timeLabel(a.h, a.mi)}`;
}

export function timeLabel(h: number, mi: number) {
  if (h === 12 && mi === 0) return "noon";
  const ap = h < 12 ? "AM" : "PM";
  const hh = h % 12 || 12;
  return mi ? `${hh}:${String(mi).padStart(2, "0")} ${ap}` : `${hh} ${ap}`;
}
