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

export function slugify(name: string): string {
  return (
    name
      .toLowerCase()
      .normalize("NFKD")
      .replace(/[̀-ͯ]/g, "")
      .replace(/&/g, " and ")
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-+|-+$/g, "")
      .slice(0, 40) || "church"
  );
}

export function randomSuffix(len = 4): string {
  const alphabet = "abcdefghjkmnpqrstuvwxyz23456789";
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

/** Offset (ms) between APP_TZ wall-clock time and UTC at a given instant. */
function tzOffset(at: Date): number {
  const p = Object.fromEntries(
    new Intl.DateTimeFormat("en-US", { timeZone: APP_TZ, hourCycle: "h23", year: "numeric", month: "numeric", day: "numeric", hour: "numeric", minute: "numeric", second: "numeric" })
      .formatToParts(at)
      .map((x) => [x.type, x.value]),
  );
  return Date.UTC(+p.year, +p.month - 1, +p.day, +p.hour, +p.minute, +p.second) - Math.floor(at.getTime() / 1000) * 1000;
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
