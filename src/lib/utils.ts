/** Normalize a US phone number to E.164 (+1XXXXXXXXXX). Returns null if invalid. */
export function normalizeUsPhone(input: string): string | null {
  const digits = input.replace(/\D/g, "");
  let ten: string | null = null;
  if (digits.length === 10) ten = digits;
  else if (digits.length === 11 && digits.startsWith("1")) ten = digits.slice(1);
  if (!ten) return null;
  // NANP: area code and exchange can't start with 0 or 1.
  if (!/^[2-9]\d{2}[2-9]\d{6}$/.test(ten)) return null;
  return `+1${ten}`;
}

export function formatPhone(e164: string): string {
  const m = e164.match(/^\+1(\d{3})(\d{3})(\d{4})$/);
  return m ? `(${m[1]}) ${m[2]}-${m[3]}` : e164;
}

export function randomToken(len = 32): string {
  const alphabet = "abcdefghjkmnpqrstuvwxyzABCDEFGHJKLMNPQRSTUVWXYZ23456789";
  let out = "";
  const bytes = crypto.getRandomValues(new Uint8Array(len));
  for (const b of bytes) out += alphabet[b % alphabet.length];
  return out;
}

export function addDays(date: Date, days: number): Date {
  return new Date(date.getTime() + days * 24 * 60 * 60 * 1000);
}

/**
 * The one time zone the whole app uses for dates, times, "this month" and chart buckets.
 * Vercel servers run on UTC, so without this every time would be shown 5–6 hours ahead.
 * Override with APP_TIMEZONE (OWNER_TIMEZONE is still accepted).
 */
export const APP_TZ = process.env.APP_TIMEZONE || process.env.OWNER_TIMEZONE || "America/Chicago";

/** Offset (ms) between wall-clock time in `tz` and UTC at a given instant. */
export function tzOffset(at: Date, tz: string = APP_TZ): number {
  const p = zonedParts(at, tz);
  return Date.UTC(p.year, p.month - 1, p.day, p.hour, p.minute, p.second) - Math.floor(at.getTime() / 1000) * 1000;
}

export type ZonedParts = { year: number; month: number; day: number; hour: number; minute: number; second: number; weekday: number };

const WEEKDAYS: Record<string, number> = { Sun: 0, Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6 };

/** Calendar parts of an instant as seen in time zone `tz`. */
export function zonedParts(at: Date, tz: string): ZonedParts {
  const p = Object.fromEntries(
    new Intl.DateTimeFormat("en-US", { timeZone: tz, hourCycle: "h23", weekday: "short", year: "numeric", month: "numeric", day: "numeric", hour: "numeric", minute: "numeric", second: "numeric" })
      .formatToParts(at)
      .map((x) => [x.type, x.value]),
  );
  return { year: +p.year, month: +p.month, day: +p.day, hour: +p.hour % 24, minute: +p.minute, second: +p.second, weekday: WEEKDAYS[p.weekday] ?? 0 };
}

/** The instant when the wall clock in `tz` reads the given local date and time. */
export function zonedTime(year: number, month: number, day: number, hour: number, minute: number, tz: string): Date {
  const guess = Date.UTC(year, month - 1, day, hour, minute);
  const first = guess - tzOffset(new Date(guess), tz);
  // Re-check once so times right after a DST switch land correctly.
  return new Date(guess - tzOffset(new Date(first), tz));
}

/** Midnight on the 1st of the current month, in APP_TZ. */
export function startOfMonth(d = new Date()): Date {
  const local = new Date(d.getTime() + tzOffset(d));
  const guess = Date.UTC(local.getUTCFullYear(), local.getUTCMonth(), 1);
  return new Date(guess - tzOffset(new Date(guess)));
}

export function monthName(d = new Date()): string {
  return d.toLocaleDateString("en-US", { month: "long", timeZone: APP_TZ });
}

export function formatDate(d: Date | string | null | undefined): string {
  if (!d) return "—";
  return new Date(d).toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric", timeZone: APP_TZ });
}

export function formatDateTime(d: Date | string | null | undefined): string {
  if (!d) return "—";
  return new Date(d).toLocaleString("en-US", {
    timeZone: APP_TZ,
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
  });
}

export function relativeDays(d: Date): string {
  const diff = Math.round((d.getTime() - Date.now()) / 86400000);
  if (diff === 0) return "today";
  if (diff === 1) return "tomorrow";
  if (diff === -1) return "yesterday";
  return diff > 0 ? `in ${diff} days` : `${-diff} days ago`;
}

export function firstName(full: string): string {
  return full.trim().split(/\s+/)[0] ?? full;
}

/** "Tue, Nov 11, 8–10 AM" style label for an arrival window, in the contractor's zone. */
export function windowLabel(start: Date | string, end: Date | string, tz: string): string {
  const s = new Date(start);
  const e = new Date(end);
  const day = s.toLocaleDateString("en-US", { weekday: "short", month: "short", day: "numeric", timeZone: tz });
  const t = (d: Date) => d.toLocaleTimeString("en-US", { hour: "numeric", minute: "2-digit", timeZone: tz }).replace(":00", "");
  const a = t(s);
  const b = t(e);
  const sameHalf = a.slice(-2) === b.slice(-2);
  return `${day}, ${sameHalf ? a.slice(0, -3) : a}–${b}`;
}

/** Spoken version: "Tuesday, November 11th, between 8 and 10 AM". */
export function spokenWindow(start: Date | string, end: Date | string, tz: string): string {
  const s = new Date(start);
  const e = new Date(end);
  const day = s.toLocaleDateString("en-US", { weekday: "long", month: "long", day: "numeric", timeZone: tz });
  const t = (d: Date) => d.toLocaleTimeString("en-US", { hour: "numeric", minute: "2-digit", timeZone: tz }).replace(":00", "");
  return `${day}, between ${t(s)} and ${t(e)}`;
}
