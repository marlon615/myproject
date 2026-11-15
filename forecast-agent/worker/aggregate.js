/**
 * Forecasts for many series (product × store/warehouse × region), worked out in small batches and added up into
 * views: total, by product, by location, by region. Every series is forecast on its own; the views are sums of the
 * series, so stores add up to regions and products add up to the total.
 *
 *   newAccumulator(mode, axis)          mode "backtest" | "forecast"; axis = the months of the data
 *   addSeries(acc, s)                   s = { product, location, region, values (aligned to axis) } → per-series result
 *   finish(acc, kind)                   → the result object the app shows (same shape as before, plus locations/regions)
 */
import { forecastSeries, accuracy, explain, fmt, pct, monthLabel, addMonths, HORIZON, MIN_BACKTEST_MONTHS, MIN_FORECAST_MONTHS } from "./forecast.js";

const HIST = 36;      // months of history kept in the views (charts show the last 24; the summary uses up to 36)
const VIEW_MAX = 200; // items listed per view; the rest are added together as "Other (N)"
const sum = (a) => a.reduce((s, v) => s + v, 0);
const round2 = (v) => Math.round(v * 100) / 100;
const addInto = (a, b) => { for (let i = 0; i < b.length; i++) a[i] = (a[i] || 0) + (b[i] || 0); return a; };

export function newAccumulator(mode, axis) {
  const n = axis.length, cut = mode === "backtest" ? n - HORIZON : n;
  return { mode, axis, cut, total: blank(), product: {}, location: {}, region: {}, series: 0, methods: {} };
}
const blank = () => ({ hist: [], pred: [], act: [], methods: {}, n: 0 });

/** One series → its own result (kept per series for drill-down and reorder), and added into the views. */
export function addSeries(acc, s) {
  const y = s.values;
  const train = y.slice(0, acc.cut);
  const r = forecastSeries(train, HORIZON);
  const out = { method: r.method, f: r.forecast };
  if (acc.mode === "backtest") { out.actual = y.slice(acc.cut, acc.cut + HORIZON); out.accuracy = accuracy(r.forecast, out.actual); }
  const hist = train.slice(-HIST);
  const groups = [acc.total];
  if (s.product !== undefined) groups.push(acc.product[s.product] ||= blank());
  if (s.location) groups.push(acc.location[s.location] ||= blank());
  if (s.region) groups.push(acc.region[s.region] ||= blank());
  for (const g of groups) {
    addInto(g.hist, hist);
    addInto(g.pred, r.forecast);
    if (out.actual) addInto(g.act, out.actual);
    g.methods[r.method] = (g.methods[r.method] || 0) + 1;
    g.n++;
  }
  acc.series++;
  return out;
}

const topMethod = (m) => Object.entries(m).sort((a, b) => b[1] - a[1])[0]?.[0] || "flat";

/** Biggest VIEW_MAX items by size, the rest folded into "Other (N …)". */
function view(groups, label, size) {
  let items = Object.entries(groups).map(([name, g]) => ({ name, g }));
  items.sort((a, b) => size(b.g) - size(a.g));
  if (items.length > VIEW_MAX) {
    const rest = items.slice(VIEW_MAX - 1), other = blank();
    for (const { g } of rest) { addInto(other.hist, g.hist); addInto(other.pred, g.pred); addInto(other.act, g.act); for (const [m, c] of Object.entries(g.methods)) other.methods[m] = (other.methods[m] || 0) + c; other.n += g.n; }
    items = [...items.slice(0, VIEW_MAX - 1), { name: `Other (${rest.length} ${label})`, g: other }];
  }
  return items;
}

export function finish(acc, kind) {
  const { axis, cut } = acc, n = axis.length;
  const histMonths = axis.slice(Math.max(0, cut - HIST), cut);
  const r2 = (a) => a.map(round2);
  if (acc.mode === "backtest") {
    if (n < MIN_BACKTEST_MONTHS) return { ok: false, reason: `The backtest needs at least ${MIN_BACKTEST_MONTHS} months of sales; this data has ${n}.` };
    const hidden = axis.slice(cut, cut + HORIZON);
    const mk = (items) => items.map(({ name, g }) => ({ name, predicted: r2(g.pred), actual: r2(g.act), method: topMethod(g.methods), accuracy: accuracy(g.pred, g.act), series: g.n }));
    const byActual = (g) => sum(g.act);
    const products = mk(view(acc.product, "products", byActual)).filter((p) => sum(p.actual) > 0 || sum(p.predicted) > 0);
    const locations = mk(view(acc.location, "locations", byActual)), regions = mk(view(acc.region, "regions", byActual));
    const t = acc.total, accTotal = accuracy(t.pred, t.act);
    const ranked = products.filter((p) => p.accuracy !== null && sum(p.actual) > 0).sort((a, b) => b.accuracy - a.accuracy);
    const summary = [
      accTotal === null ? "Nothing was sold in the hidden months, so there's nothing to score." :
        `Hiding your last 3 months (${monthLabel(hidden[0])} to ${monthLabel(hidden[2])}) and predicting them from the months before, the forecast was ${accTotal}% accurate for your total sales.`,
      `It predicted ${fmt(sum(t.pred), kind)} against ${fmt(sum(t.act), kind)} that really happened (${pct(sum(t.pred), sum(t.act))}).`,
    ];
    if (ranked.length >= 2) summary.push(`Most accurate product: ${ranked[0].name} (${ranked[0].accuracy}%). Hardest to predict: ${ranked[ranked.length - 1].name} (${ranked[ranked.length - 1].accuracy}%).`);
    const lr = locations.filter((p) => p.accuracy !== null).sort((a, b) => b.accuracy - a.accuracy);
    if (lr.length >= 2) summary.push(`By location, ${lr[0].name} was the most predictable (${lr[0].accuracy}%) and ${lr[lr.length - 1].name} the least (${lr[lr.length - 1].accuracy}%).`);
    if (cut < 12) summary.push(`Only ${cut} months were left to learn from, so expect rougher numbers; 12–24 months of history works best.`);
    return { ok: true, months: hidden, trainedOn: cut, kind, series: acc.series, products, locations, regions, total: { predicted: r2(t.pred), actual: r2(t.act) }, accuracy: accTotal, summary,
      history: { months: histMonths.slice(-12), total: r2(t.hist.slice(-12)) } };
  }
  if (n < MIN_FORECAST_MONTHS) return { ok: false, reason: `Forecasting needs at least ${MIN_FORECAST_MONTHS} months of sales; this data has ${n}.` };
  const months = Array.from({ length: HORIZON }, (_, k) => addMonths(axis[n - 1], k + 1));
  const mk = (items) => items.map(({ name, g }) => ({ name, history: r2(g.hist), forecast: r2(g.pred), method: topMethod(g.methods), next3: round2(sum(g.pred)), last3: round2(sum(g.hist.slice(-3))), series: g.n }));
  const bySize = (g) => sum(g.pred) + sum(g.hist.slice(-3));
  const products = mk(view(acc.product, "products", bySize)).filter((p) => p.next3 > 0 || p.last3 > 0);
  const locations = mk(view(acc.location, "locations", bySize)), regions = mk(view(acc.region, "regions", bySize));
  const total = { history: r2(acc.total.hist), forecast: r2(acc.total.pred) };
  const summary = explain({ months: histMonths, kind }, products, total, months);
  if (regions.length >= 2) {
    const mv = regions.map((r) => ({ name: r.name, d: r.last3 > 0 ? Math.round(((r.next3 - r.last3) / r.last3) * 100) : null })).filter((r) => r.d !== null).sort((a, b) => b.d - a.d);
    if (mv.length >= 2) summary.splice(1, 0, `By region, ${mv[0].name} is expected to change the most upward (${mv[0].d > 0 ? "+" : ""}${mv[0].d}%) and ${mv[mv.length - 1].name} the least (${mv[mv.length - 1].d > 0 ? "+" : ""}${mv[mv.length - 1].d}%) compared with the last 3 months.`);
  }
  return { ok: true, months, historyMonths: histMonths, kind, series: acc.series, products, locations, regions, total, summary };
}

/** Adds one batch's partial views into another (batches are worked out separately, then combined). */
export function mergePartial(acc, part) {
  const merge = (a, b) => { addInto(a.hist, b.hist); addInto(a.pred, b.pred); addInto(a.act, b.act); for (const [m, c] of Object.entries(b.methods)) a.methods[m] = (a.methods[m] || 0) + c; a.n += b.n; return a; };
  merge(acc.total, part.total);
  for (const dim of ["product", "location", "region"]) for (const [name, g] of Object.entries(part[dim] || {})) merge(acc[dim][name] ||= blank(), g);
  acc.series += part.series || 0;
  return acc;
}
/** What a batch needs to keep (the month list itself is the same for every batch). */
export const partialOf = (acc) => ({ total: acc.total, product: acc.product, location: acc.location, region: acc.region, series: acc.series });
