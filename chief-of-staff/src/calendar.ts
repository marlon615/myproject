import { getSecret } from "./settings";
import type { Env } from "./types";
import { timeLabel, zonedParts, zonedToUtc } from "./when";

/**
 * Reads Google Calendar through its private iCal address (Calendar settings → "Secret address in iCal format").
 * Handles one-off events, all-day events, and the common repeating ones (daily / weekly / monthly).
 */

interface Ev { title: string; location: string; start: Date; end: Date; allDay: boolean }

function unfold(ics: string) {
  return ics.replace(/\r?\n[ \t]/g, "");
}

function unescape(v: string) {
  return v.replace(/\\n/gi, " ").replace(/\\([,;\\])/g, "$1").trim();
}

/** Parses DTSTART-style values: 20261110T150000Z, 20261110T090000 (with TZID), or 20261110 (all day). */
function parseIcsDate(value: string, params: string, tz: string): { d: Date; allDay: boolean } | null {
  const tzid = params.match(/TZID=([^;:]+)/i)?.[1] ?? tz;
  const m = value.match(/^(\d{4})(\d{2})(\d{2})(?:T(\d{2})(\d{2})(\d{2})?(Z)?)?$/);
  if (!m) return null;
  const [, y, mo, d, h, mi, , z] = m;
  if (!h) return { d: zonedToUtc(+y, +mo, +d, 0, 0, tz), allDay: true };
  if (z) return { d: new Date(Date.UTC(+y, +mo - 1, +d, +h, +mi)), allDay: false };
  let zone = tzid;
  try { new Intl.DateTimeFormat("en-US", { timeZone: zone }); } catch { zone = tz; }
  return { d: zonedToUtc(+y, +mo, +d, +h, +mi, zone), allDay: false };
}

const DAYMAP: Record<string, number> = { SU: 0, MO: 1, TU: 2, WE: 3, TH: 4, FR: 5, SA: 6 };

/** All event occurrences that overlap [from, to). */
export function eventsBetween(ics: string, from: Date, to: Date, tz: string): Ev[] {
  const out: Ev[] = [];
  const blocks = unfold(ics).split("BEGIN:VEVENT").slice(1).map((b) => b.split("END:VEVENT")[0]);
  for (const b of blocks) {
    const props: { name: string; params: string; value: string }[] = [];
    for (const line of b.split(/\r?\n/)) {
      const m = line.match(/^([A-Z-]+)((?:;[^:]*)?):(.*)$/);
      if (m) props.push({ name: m[1], params: m[2], value: m[3] });
    }
    const get = (n: string) => props.find((p) => p.name === n);
    if (/CANCELLED/i.test(get("STATUS")?.value ?? "")) continue;
    const ds = get("DTSTART");
    if (!ds) continue;
    const start = parseIcsDate(ds.value, ds.params, tz);
    if (!start) continue;
    const de = get("DTEND");
    const end = de ? parseIcsDate(de.value, de.params, tz)?.d : null;
    const dur = (end ?? new Date(start.d.getTime() + (start.allDay ? 86_400_000 : 3_600_000))).getTime() - start.d.getTime();
    const title = unescape(get("SUMMARY")?.value ?? "Busy");
    const location = unescape(get("LOCATION")?.value ?? "");
    const ex = new Set(props.filter((p) => p.name === "EXDATE").flatMap((p) => p.value.split(",").map((v) => parseIcsDate(v, p.params, tz)?.d.getTime())).filter(Boolean) as number[]);
    const push = (s: Date) => {
      if (ex.has(s.getTime())) return;
      const e = new Date(s.getTime() + dur);
      if (s < to && e > from) out.push({ title, location, start: s, end: e, allDay: start.allDay });
    };
    const rrule = get("RRULE")?.value;
    if (!rrule || get("RECURRENCE-ID")) { push(start.d); continue; }

    const r = Object.fromEntries(rrule.split(";").map((kv) => kv.split("=") as [string, string]));
    const freq = r.FREQ, interval = Number(r.INTERVAL || 1);
    const until = r.UNTIL ? parseIcsDate(r.UNTIL, "", tz)?.d ?? null : null;
    const count = r.COUNT ? Number(r.COUNT) : Infinity;
    const sp = zonedParts(start.d, ds.params.includes("TZID") ? ds.params.match(/TZID=([^;:]+)/i)![1] : tz);
    const zone = ds.params.match(/TZID=([^;:]+)/i)?.[1] ?? tz;
    const byday = r.BYDAY ? r.BYDAY.split(",").map((x: string) => DAYMAP[x.slice(-2)]).filter((x: number | undefined) => x !== undefined) : null;
    let n = 0;
    // Walk day by day from the first occurrence to the end of the window (bounded).
    const limit = Math.min(to.getTime(), until ? until.getTime() + 1 : Infinity);
    for (let i = 0; i < 3700; i++) {
      const day = new Date(Date.UTC(sp.y, sp.m - 1, sp.d + i));
      const occ = start.allDay ? zonedToUtc(day.getUTCFullYear(), day.getUTCMonth() + 1, day.getUTCDate(), 0, 0, tz)
        : zonedToUtc(day.getUTCFullYear(), day.getUTCMonth() + 1, day.getUTCDate(), sp.h, sp.mi, zone);
      if (occ.getTime() >= limit) break;
      let hit = false;
      if (freq === "DAILY") hit = i % interval === 0;
      else if (freq === "WEEKLY") {
        const week = Math.floor((i + ((sp.wd + 6) % 7)) / 7);
        hit = week % interval === 0 && (byday ? byday.includes(day.getUTCDay()) : day.getUTCDay() === sp.wd);
      } else if (freq === "MONTHLY") hit = day.getUTCDate() === sp.d && !r.BYDAY;
      else if (freq === "YEARLY") hit = day.getUTCDate() === sp.d && day.getUTCMonth() + 1 === sp.m;
      if (!hit) continue;
      if (++n > count) break;
      if (occ.getTime() + dur > from.getTime()) push(occ);
    }
  }
  return out.sort((a, b) => a.start.getTime() - b.start.getTime());
}

const cache = new Map<string, { at: number; text: string }>();

async function fetchIcs(url: string): Promise<string> {
  const hit = cache.get(url);
  if (hit && Date.now() - hit.at < 10 * 60_000) return hit.text;
  const res = await fetch(url, { headers: { Accept: "text/calendar" } });
  if (!res.ok) throw new Error(res.status === 404 ? "Google says that calendar address doesn't exist anymore. Copy the secret address again." : `Google Calendar answered ${res.status}.`);
  const text = await res.text();
  if (!text.includes("BEGIN:VCALENDAR")) throw new Error("That address didn't return a calendar.");
  cache.set(url, { at: Date.now(), text });
  return text;
}

/** What's on the calendar for a day (0 = today), as words to read aloud. */
export async function agendaSpeech(env: Env, dayOffset: number): Promise<string> {
  const url = await getSecret(env, "calendar");
  if (!url) return "Your calendar isn't connected yet. In Settings, paste your Google Calendar's secret address, and I can read it to you.";
  const tz = env.APP_TIMEZONE || "America/Chicago";
  const now = new Date();
  const t = zonedParts(now, tz);
  const from = zonedToUtc(t.y, t.m, t.d + dayOffset, 0, 0, tz);
  const to = zonedToUtc(t.y, t.m, t.d + dayOffset + 1, 0, 0, tz);
  const evs = eventsBetween(await fetchIcs(url), from, to, tz);
  const label = dayOffset === 0 ? "today" : dayOffset === 1 ? "tomorrow" : "that day";
  if (!evs.length) return `Nothing on your calendar ${label}.`;
  const items = evs.map((e) => {
    if (e.allDay) return `All day, ${e.title}`;
    const p = zonedParts(e.start, tz);
    return `At ${timeLabel(p.h, p.mi)}, ${e.title}${e.location ? `, at ${e.location.split(",")[0]}` : ""}`;
  });
  return `You have ${evs.length === 1 ? "one thing" : `${evs.length} things`} ${label}: ${items.join(". ")}.`;
}

/** Checks a pasted address before saving it. */
export async function testIcs(url: string, allowAnyHost = false): Promise<string | null> {
  if (!allowAnyHost && !/^https:\/\/(calendar\.google\.com|www\.google\.com)\/calendar\/ical\//.test(url)) {
    return "That isn't a Google Calendar secret address. It starts with https://calendar.google.com/calendar/ical/";
  }
  try {
    cache.delete(url);
    await fetchIcs(url);
    return null;
  } catch (e) {
    return (e as Error).message;
  }
}

/** A Google Calendar "new event" link with the details filled in; you tap Save. */
export function addEventUrl(title: string, start: Date, minutes = 60, allDay = false) {
  const f = (d: Date) => d.toISOString().replace(/[-:]/g, "").replace(/\.\d{3}/, "");
  const end = new Date(start.getTime() + minutes * 60_000);
  const dates = allDay ? `${f(start).slice(0, 8)}/${f(new Date(start.getTime() + 86_400_000)).slice(0, 8)}` : `${f(start)}/${f(end)}`;
  return `https://calendar.google.com/calendar/render?action=TEMPLATE&text=${encodeURIComponent(title)}&dates=${dates}`;
}
