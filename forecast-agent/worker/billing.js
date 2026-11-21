/**
 * Draxly billing rules (pure functions, dates as "YYYY-MM-DD" in UTC):
 *   Plan: Draxly Enterprise, $30,000 per company per year, one-year agreement that renews automatically each year
 *   unless cancelled. Pay the full year upfront (one invoice at the start of each year) or $2,500 a month (an invoice
 *   on the same day each month). Invoices are due 15 days after they're issued. Leaving early: the rest of the year
 *   is still owed (cancelling issues one invoice for the remaining months, and the agreement doesn't renew).
 *   Overdue reminders: 1, 7 and 14 days after the due date, then every 14 days.
 */
export const PLAN = { name: "Draxly Enterprise", annualCents: 3_000_000, monthlyCents: 250_000, netDays: 15, termMonths: 12 };

const ymd = (d) => d.toISOString().slice(0, 10);
const parse = (s) => new Date(`${s}T00:00:00Z`);
export const addDays = (s, n) => { const d = parse(s); d.setUTCDate(d.getUTCDate() + n); return ymd(d); };
export const daysBetween = (a, b) => Math.round((parse(b) - parse(a)) / 86_400_000);
/** Same day of the month n months later; the 29th–31st become the month's last day when the month is shorter. */
export function addMonthsDate(s, n) {
  const d = parse(s), day = d.getUTCDate();
  const t = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + n, 1));
  const last = new Date(Date.UTC(t.getUTCFullYear(), t.getUTCMonth() + 1, 0)).getUTCDate();
  t.setUTCDate(Math.min(day, last));
  return ymd(t);
}
export const termEnd = (termStart) => addMonthsDate(termStart, PLAN.termMonths);

/** The invoices one agreement year produces. */
export function schedule(billing, termStart) {
  if (billing === "annual") return [{ periodStart: termStart, periodEnd: addDays(termEnd(termStart), -1), amountCents: PLAN.annualCents, description: `${PLAN.name} — annual subscription` }];
  return Array.from({ length: 12 }, (_, k) => {
    const s = addMonthsDate(termStart, k), e = addDays(addMonthsDate(termStart, k + 1), -1);
    return { periodStart: s, periodEnd: e, amountCents: PLAN.monthlyCents, description: `${PLAN.name} — monthly subscription (month ${k + 1} of 12)` };
  });
}

/** Which overdue reminder (1, 2, 3, …) is due today for an open invoice, or 0 if none. */
export function reminderDue(inv, today) {
  if (inv.status !== "open") return 0;
  const late = daysBetween(inv.due, today);
  if (late < 1) return 0;
  const sent = inv.reminders || 0;
  const threshold = sent < 3 ? [1, 7, 14][sent] : 14 + (sent - 2) * 14;
  return late >= threshold ? sent + 1 : 0;
}

/** Paid up / overdue / cancelled / ended / no agreement. */
export function status(agreement, invoices, today) {
  if (!agreement) return "none";
  const overdue = invoices.some((i) => i.status === "open" && i.due < today);
  if (agreement.cancelled_at) return agreement.term_end <= today && !invoices.some((i) => i.status === "open") ? "ended" : "cancelled"; // overdue money is shown alongside
  return overdue ? "overdue" : "paid";
}
export const STATUS_WORDS = { paid: "Paid up", overdue: "Overdue", cancelled: "Cancelled", ended: "Ended", none: "No agreement" };
