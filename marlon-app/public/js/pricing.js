/**
 * Marlon pricing: ONE table of automatic team discounts by number of reps, used by plain Marlon and by Marlon Pro
 * (the maker's console, the Worker and the tests all import this file, so they can never disagree).
 *
 *   tierFor(reps)            → { min, max, pct, label }   e.g. tierFor(7) → 5–9 reps, 10 %
 *   proPrice(reps, extraPct) → the Pro monthly price, step by step, in whole cents:
 *       reps × $25 → minus the automatic team discount → minus any special deal % (on what's left) → total
 * A special deal is applied after the team discount, so together they can never pass 100 %.
 */
export const TEAM_TIERS = Object.freeze([
  { min: 1, max: 4, pct: 0 },
  { min: 5, max: 9, pct: 10 },
  { min: 10, max: 24, pct: 15 },
  { min: 25, max: 49, pct: 20 },
  { min: 50, max: 99, pct: 25 },
  { min: 100, max: Infinity, pct: 30 },
].map(Object.freeze));

export const PRO_REP_CENTS = 2500; // $25 per rep per month
export const MAX_REPS = 10000;

const tierLabel = (t) => (t.max === Infinity ? `${t.min}+ reps` : `${t.min}–${t.max} reps`);
export const TIER_LABELS = TEAM_TIERS.map((t) => ({ label: tierLabel(t), pct: t.pct }));

/** A whole number of reps from 1 up, or null. */
export function cleanReps(n) {
  const x = Number(n);
  return Number.isInteger(x) && x >= 1 && x <= MAX_REPS ? x : null;
}

export function tierFor(reps) {
  const r = cleanReps(reps) || 1;
  const t = TEAM_TIERS.find((x) => r >= x.min && r <= x.max) || TEAM_TIERS[0];
  return { ...t, label: tierLabel(t) };
}

/** The Pro price for `reps` reps with an optional special deal (0–100 %), step by step in whole cents. */
export function proPrice(reps, extraPct = 0) {
  const r = cleanReps(reps) || 1;
  const tier = tierFor(r);
  const extra = Math.min(100, Math.max(0, Number(extraPct) || 0));
  const grossCents = r * PRO_REP_CENTS;
  const tierCents = Math.round(grossCents * tier.pct / 100);
  const afterTierCents = grossCents - tierCents;
  const extraCents = Math.round(afterTierCents * extra / 100);
  return { reps: r, grossCents, tierPct: tier.pct, tierLabel: tier.label, tierCents, afterTierCents, extraPct: extra, extraCents, netCents: afterTierCents - extraCents };
}

// ── Pro payment notices (the maker sends these to the customer from the console) ─────────────────────────────
const MONTHS = ["January", "February", "March", "April", "May", "June", "July", "August", "September", "October", "November", "December"];
const ordinal = (n) => `${n}${n % 100 >= 11 && n % 100 <= 13 ? "th" : ["th", "st", "nd", "rd"][n % 10] || "th"}`;
const usd = (cents) => (cents / 100).toLocaleString("en-US", { style: "currency", currency: "USD" });
/** "20 November 2026" */
export const longDate = (iso) => { const [y, m, d] = String(iso).split("-").map(Number); return `${d} ${MONTHS[m - 1]} ${y}`; };
/** "the 20th of every month" (29th–31st: "or the last day of shorter months") */
export function dueDayText(iso) {
  const d = Number(String(iso).slice(8, 10));
  return `the ${ordinal(d)} of every month${d >= 29 ? " (or the last day of shorter months)" : ""}`;
}
/**
 * A payment notice as text (WhatsApp, email, the console) and as lines (the PDF).
 * notice: { company, reps, startDate, price: proPrice(...) }
 */
export function noticeLines(n) {
  const p = n.price;
  const lines = [[`${p.reps} rep${p.reps === 1 ? "" : "s"} × $25.00 a month`, usd(p.grossCents)]];
  lines.push(p.tierPct ? [`Team discount ${p.tierPct}% (${p.tierLabel})`, `−${usd(p.tierCents)}`] : [`Team discount (${p.tierLabel})`, "none"]);
  if (p.extraPct) lines.push([`Special deal ${p.extraPct}%`, `−${usd(p.extraCents)}`]);
  return lines;
}
export function noticeText(n) {
  const p = n.price;
  return [
    `${n.company}: your monthly payment for Marlon Pro (owner dashboard plus ${p.reps} rep${p.reps === 1 ? "" : "s"}) is ${usd(p.netCents)}. Payment starts on ${longDate(n.startDate)} and is due on ${dueDayText(n.startDate)}.`,
    "",
    "Price breakdown:",
    ...noticeLines(n).map(([a, v]) => `• ${a}: ${v}`),
    `Monthly total: ${usd(p.netCents)}`,
    "",
    "Terms: " + (n.termsUrl || "/terms"),
  ].join("\n");
}

// ── A buyer's contact details (fill in WhatsApp and email automatically) ───────────────────────────────────
/** A phone number for WhatsApp: must start with + (or 00) and the country code, 7–15 digits in all. → { phone, error } */
export function cleanPhone(raw) {
  const t = String(raw ?? "").replace(/\s+/g, " ").trim();
  if (!t) return { phone: "" };
  if (!/^(\+|00)/.test(t)) return { error: "Start the phone number with + and the country code, e.g. +1 876 555 0123 (WhatsApp needs it)." };
  if (/[^\d\s+().-]/.test(t)) return { error: "The phone number can only have digits, spaces and + ( ) - ." };
  const digits = t.replace(/^00/, "").replace(/\D/g, "");
  if (digits.length < 7 || digits.length > 15) return { error: "That phone number doesn't look complete. Include the country code, e.g. +1 876 555 0123." };
  return { phone: t.slice(0, 40) };
}
/** The digits WhatsApp's link needs (country code included, no +), or "". */
export const waDigits = (phone) => String(phone || "").trim().replace(/^00/, "").replace(/\D/g, "");
/** A plain email address check (something@something.something). → { email, error } */
export function cleanEmail(raw) {
  const t = String(raw ?? "").trim();
  if (!t) return { email: "" };
  if (t.length > 120 || !/^[^\s@<>(),;:"]+@[^\s@<>(),;:"]+\.[A-Za-z]{2,}$/.test(t)) return { error: "That email address doesn't look right, e.g. name@example.com." };
  return { email: t };
}
