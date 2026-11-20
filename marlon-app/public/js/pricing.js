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
