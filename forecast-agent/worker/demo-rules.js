/**
 * The free demo's fairness rule: it may only "predict" months that have already finished, so it can never be used to
 * get a real forecast of the future for free.
 *
 *   The 3 predicted months are the last 3 full months before the current month.
 *   So the uploaded file may end, at the latest, 4 months before the current month.
 *   Example: in November 2026 the file may end in July 2026 at the latest; Draxly predicts August, September and
 *   October 2026, which have all finished.
 *
 * "Today" is taken in Hawaii time, the last US state to finish a month, so a month only counts as finished once it has
 * finished everywhere in the US. Worked out on every request, never from fixed months.
 */
export const DEMO_TIME_ZONE = "Pacific/Honolulu";
const YMD = /^\d{4}-(0[1-9]|1[0-2])-(0[1-9]|[12]\d|3[01])$/;

export function shiftMonth(ym, n) {
  const [y, m] = ym.split("-").map(Number);
  const t = y * 12 + (m - 1) + n;
  return `${Math.floor(t / 12)}-${String((t % 12) + 1).padStart(2, "0")}`;
}

/** The current month ("YYYY-MM") in Hawaii time. */
export function currentMonth(now = new Date()) {
  const parts = new Intl.DateTimeFormat("en-US", { timeZone: DEMO_TIME_ZONE, year: "numeric", month: "2-digit" }).formatToParts(now);
  const get = (t) => parts.find((p) => p.type === t).value;
  return `${get("year")}-${get("month")}`;
}

/** The rule for a given current month: the latest month a file may end in, and the 3 months Draxly will predict. */
export function demoRules(current) {
  const latestMonth = shiftMonth(current, -4);
  return { current, latestMonth, forecastMonths: [1, 2, 3].map((k) => shiftMonth(latestMonth, k)) };
}

/** "Today" for the demo: the real date, or (only in tests, with ALLOW_TEST_CLOCK=1) the X-Test-Today header. */
export function demoCurrentMonth(env, request, now = new Date()) {
  if (env?.ALLOW_TEST_CLOCK === "1") {
    const t = request?.headers?.get("X-Test-Today") || "";
    if (YMD.test(t)) return t.slice(0, 7);
  }
  return currentMonth(now);
}

const NAMES = ["January", "February", "March", "April", "May", "June", "July", "August", "September", "October", "November", "December"];
export const monthName = (ym) => `${NAMES[+ym.slice(5, 7) - 1]} ${ym.slice(0, 4)}`;

/** The polite refusal shown when a file goes past the allowed month. */
export function tooRecentMessage(rules) {
  const [a, , c] = rules.forecastMonths;
  return `To keep the test fair, please remove your most recent months so your file ends in ${monthName(rules.latestMonth)}. ` +
    `Draxly will predict the 3 months after that (${monthName(a)} to ${monthName(c)}), and you can compare them with your real sales.`;
}
