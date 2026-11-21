/**
 * The forecasting engine (runs on the server, in each business's own Durable Object).
 *
 * Input: monthly sales per product — { months: ["2024-01", …], products: { "Mango Juice": [120, 135, …], … },
 *        kind: "money" | "units" }   (every product's array lines up with `months`; missing months are 0)
 *
 *   runBacktest(data)  → hides the last 3 months, predicts them, compares with what really happened
 *   runForecast(data)  → the next 3 months, per product and in total, with a plain-English summary
 *
 * For each product, several standard methods are tried and the one that predicts that product's own recent months
 * best is used (flat recent average, straight-line trend, Holt smoothing with a damped trend, and — with 2+ years of
 * data — a seasonal pattern with trend, or last year's same months adjusted for growth). Forecasts never go below 0.
 * The total is the sum of the products, so the parts always add up.
 */
export const HORIZON = 3;
export const MIN_FORECAST_MONTHS = 6;
export const MIN_BACKTEST_MONTHS = 9;
export const MAX_PRODUCTS = 30;

const sum = (a) => a.reduce((s, v) => s + v, 0);
const mean = (a) => (a.length ? sum(a) / a.length : 0);
const clamp0 = (a) => a.map((v) => (Number.isFinite(v) && v > 0 ? v : 0));
const round2 = (v) => Math.round(v * 100) / 100;

/** Accuracy = 100% − total absolute error ÷ total actual (never below 0). null when nothing was actually sold. */
export function accuracy(predicted, actual) {
  const a = sum(actual);
  if (!(a > 0)) return null;
  const err = sum(actual.map((v, i) => Math.abs(v - (predicted[i] || 0))));
  return Math.max(0, Math.round((1 - err / a) * 1000) / 10);
}

export function addMonths(ym, n) {
  const [y, m] = ym.split("-").map(Number);
  const d = new Date(Date.UTC(y, m - 1 + n, 1));
  return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, "0")}`;
}
const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
const MONTHS_LONG = ["January", "February", "March", "April", "May", "June", "July", "August", "September", "October", "November", "December"];
export const monthLabel = (ym) => `${MONTHS[Number(ym.slice(5, 7)) - 1]} ${ym.slice(0, 4)}`;

// ── Methods ──────────────────────────────────────────────────────────────

function flat(y, h) { const v = mean(y.slice(-3)); return Array(h).fill(v); }

function linear(y, h) {
  const s = y.slice(-24), n = s.length;
  if (n < 3) return flat(y, h);
  const xm = (n - 1) / 2, ym = mean(s);
  let num = 0, den = 0;
  s.forEach((v, i) => { num += (i - xm) * (v - ym); den += (i - xm) ** 2; });
  const slope = den ? num / den : 0;
  return Array.from({ length: h }, (_, k) => ym + slope * (n - 1 + k + 1 - xm));
}

function holtFit(y, a, b, phi) {
  let level = y[0], trend = y.length > 1 ? y[1] - y[0] : 0, sse = 0;
  for (let t = 1; t < y.length; t++) {
    const f = level + phi * trend;
    sse += (y[t] - f) ** 2;
    const prev = level;
    level = a * y[t] + (1 - a) * (level + phi * trend);
    trend = b * (level - prev) + (1 - b) * phi * trend;
  }
  return { level, trend, sse };
}
function holt(y, h) {
  if (y.length < 4) return flat(y, h);
  const phi = 0.9;
  let best = null;
  for (const a of [0.2, 0.35, 0.5, 0.65, 0.8]) for (const b of [0.05, 0.15, 0.3]) {
    const r = holtFit(y, a, b, phi);
    if (!best || r.sse < best.sse) best = r;
  }
  const out = [];
  let damp = 0;
  for (let k = 1; k <= h; k++) { damp += phi ** k; out.push(best.level + damp * best.trend); }
  return out;
}

/** Seasonal pattern × trend (needs 24+ months): monthly indices from the last 2–3 years, a trend on the deseasonalised data. */
function seasonal(y, h) {
  const n = y.length;
  if (n < 24) return null;
  const s = y.slice(-36), m = s.length, start = n - m;
  const yearMean = (i) => mean(s.slice(Math.max(0, i - 6), Math.min(m, i + 6)));
  const ratios = Array.from({ length: 12 }, () => []);
  for (let i = 0; i < m; i++) { const base = yearMean(i); if (base > 0) ratios[(start + i) % 12].push(s[i] / base); }
  let idx = ratios.map((r) => (r.length ? mean(r) : 1));
  const norm = mean(idx) || 1;
  idx = idx.map((v) => v / norm);
  const des = s.map((v, i) => v / (idx[(start + i) % 12] || 1));
  const tr = linear(des, h);
  return tr.map((v, k) => v * idx[(n + k) % 12]);
}

/** Last year's same months, scaled by how the last 3 months compare with the same 3 months a year before (12+ months). */
function lastYearGrowth(y, h) {
  const n = y.length;
  if (n < 15) return null;
  const recent = sum(y.slice(-3)), yearBefore = sum(y.slice(n - 15, n - 12));
  const g = yearBefore > 0 ? Math.min(3, Math.max(0.33, recent / yearBefore)) : 1;
  return Array.from({ length: h }, (_, k) => y[n - 12 + k] * g);
}

const METHODS = {
  flat: { fn: flat, words: "recent average" },
  trend: { fn: linear, words: "straight-line trend" },
  holt: { fn: holt, words: "smoothed trend" },
  seasonal: { fn: seasonal, words: "seasonal pattern with trend" },
  lastyear: { fn: lastYearGrowth, words: "last year's pattern adjusted for growth" },
};

/** Picks the method that best predicts this series' own recent months (one or two hold-out windows), then refits on all of it. */
export function forecastSeries(y, h = HORIZON) {
  const n = y.length;
  if (sum(y) === 0) return { forecast: Array(h).fill(0), method: "flat" };
  if (n < MIN_FORECAST_MONTHS) return { forecast: clamp0(flat(y, h)), method: "flat" };
  const origins = n >= 18 ? [n - h, n - 2 * h] : n >= 6 + h ? [n - h] : [];
  let best = { method: "flat", err: Infinity };
  for (const [name, m] of Object.entries(METHODS)) {
    let err = 0, ok = true;
    for (const o of origins) {
      const p = m.fn(y.slice(0, o), h);
      if (!p) { ok = false; break; }
      const act = y.slice(o, o + h), a = sum(act);
      err += a > 0 ? sum(act.map((v, i) => Math.abs(v - Math.max(0, p[i])))) / a : sum(p.map(Math.abs));
    }
    if (!ok || !origins.length) continue;
    // Prefer simpler methods on near-ties (they're steadier).
    const penalty = { flat: 0, trend: 0.01, holt: 0.015, lastyear: 0.01, seasonal: 0.02 }[name];
    if (err + penalty < best.err) best = { method: name, err: err + penalty };
  }
  const f = METHODS[best.method].fn(y, h) || flat(y, h);
  return { forecast: clamp0(f).map(round2), method: best.method };
}

// ── Preparing the data ───────────────────────────────────────────────────

/** Keeps the biggest MAX_PRODUCTS products and folds the rest into "Other"; trims to whole months with data. */
export function prepare(data) {
  const months = data.months.slice();
  let entries = Object.entries(data.products || {}).map(([name, v]) => [name, months.map((_, i) => Number(v[i]) || 0)]);
  entries.sort((a, b) => sum(b[1]) - sum(a[1]));
  if (entries.length > MAX_PRODUCTS) {
    const keep = entries.slice(0, MAX_PRODUCTS - 1), rest = entries.slice(MAX_PRODUCTS - 1);
    const other = months.map((_, i) => sum(rest.map((e) => e[1][i])));
    entries = [...keep, [`Other (${rest.length} products)`, other]];
  }
  return { months, kind: data.kind === "units" ? "units" : "money", products: entries.filter(([, v]) => sum(v) > 0) };
}

function predictAll(products, h) {
  return products.map(([name, y]) => {
    const r = forecastSeries(y, h);
    return { name, history: y, forecast: r.forecast, method: r.method };
  });
}
const totalOf = (list, key) => list.reduce((acc, p) => acc.map((v, i) => v + (p[key][i] || 0)), Array((list[0]?.[key] || []).length).fill(0)).map(round2);

// ── Backtest ─────────────────────────────────────────────────────────────

export function runBacktest(raw) {
  const data = prepare(raw);
  const n = data.months.length;
  if (n < MIN_BACKTEST_MONTHS) return { ok: false, reason: `The backtest needs at least ${MIN_BACKTEST_MONTHS} months of sales; this file has ${n}.` };
  const cut = n - HORIZON;
  const hiddenMonths = data.months.slice(cut);
  const products = data.products.map(([name, y]) => {
    const r = forecastSeries(y.slice(0, cut), HORIZON);
    const actual = y.slice(cut);
    return { name, predicted: r.forecast, actual, method: r.method, accuracy: accuracy(r.forecast, actual) };
  });
  const predicted = totalOf(products, "predicted"), actual = totalOf(products, "actual");
  const acc = accuracy(predicted, actual);
  const ranked = products.filter((p) => p.accuracy !== null && sum(p.actual) > 0).sort((a, b) => b.accuracy - a.accuracy);
  const summary = [
    acc === null ? "Nothing was sold in the hidden months, so there's nothing to score." :
      `Hiding your last 3 months (${monthLabel(hiddenMonths[0])} to ${monthLabel(hiddenMonths[2])}) and predicting them from the months before, the forecast was ${acc}% accurate for your total sales.`,
    `It predicted ${fmt(sum(predicted), data.kind)} against ${fmt(sum(actual), data.kind)} that really happened (${pct(sum(predicted), sum(actual))}).`,
  ];
  if (ranked.length >= 2) summary.push(`Most accurate product: ${ranked[0].name} (${ranked[0].accuracy}%). Hardest to predict: ${ranked[ranked.length - 1].name} (${ranked[ranked.length - 1].accuracy}%).`);
  if (n - HORIZON < 12) summary.push(`Only ${n - HORIZON} months were left to learn from, so expect rougher numbers; 12–24 months of history works best.`);
  return { ok: true, months: hiddenMonths, trainedOn: cut, kind: data.kind, products, total: { predicted, actual }, accuracy: acc, summary,
    history: { months: data.months.slice(0, cut).slice(-12), total: totalOf(data.products.map(([, y]) => ({ y: y.slice(0, cut).slice(-12) })), "y") } };
}

export function pct(a, b) { if (!(b > 0)) return "—"; const d = Math.round(((a - b) / b) * 100); return d === 0 ? "spot on" : `${Math.abs(d)}% ${d > 0 ? "too high" : "too low"}`; }

// ── Forecast ─────────────────────────────────────────────────────────────

export function runForecast(raw) {
  const data = prepare(raw);
  const n = data.months.length;
  if (n < MIN_FORECAST_MONTHS) return { ok: false, reason: `Forecasting needs at least ${MIN_FORECAST_MONTHS} months of sales; this file has ${n}.` };
  const last = data.months[n - 1];
  const months = Array.from({ length: HORIZON }, (_, k) => addMonths(last, k + 1));
  const products = predictAll(data.products, HORIZON).map((p) => ({ ...p, next3: round2(sum(p.forecast)), last3: round2(sum(p.history.slice(-3))) }));
  const total = { history: totalOf(products, "history"), forecast: totalOf(products, "forecast") };
  return { ok: true, months, historyMonths: data.months, kind: data.kind, products, total, summary: explain(data, products, total, months) };
}

export function fmt(v, kind) {
  if (kind === "units") return `${Math.round(v).toLocaleString("en-US")} units`;
  return v.toLocaleString("en-US", { style: "currency", currency: "USD", maximumFractionDigits: v >= 1000 ? 0 : 2 });
}

/** The plain-English "what's driving the numbers", worked out from the data (no guessing, no made-up reasons). */
export function explain(data, products, total, months) {
  const k = data.kind, n = data.months.length, out = [];
  const next = sum(total.forecast), last3 = sum(total.history.slice(-3));
  const ch = last3 > 0 ? Math.round(((next - last3) / last3) * 100) : null;
  out.push(`Expected sales for ${monthLabel(months[0])} to ${monthLabel(months[2])}: about ${fmt(next, k)}${ch === null ? "" : `, ${ch === 0 ? "about the same as" : `${Math.abs(ch)}% ${ch > 0 ? "more than" : "less than"}`} the last 3 months (${fmt(last3, k)})`}.`);
  if (n >= 15) {
    const ly = sum(total.history.slice(n - 12, n - 9));
    if (ly > 0) { const d = Math.round(((next - ly) / ly) * 100); out.push(`Compared with the same months last year (${fmt(ly, k)}), that's ${d === 0 ? "about level" : `${Math.abs(d)}% ${d > 0 ? "higher" : "lower"}`}.`); }
  }
  // Trend over the last 12 months.
  const last12 = total.history.slice(-12);
  if (last12.length >= 6) {
    const avg = mean(last12), line = linear(last12, 2);
    const perMonth = avg > 0 ? Math.round(((line[1] - line[0]) / avg) * 1000) / 10 : 0; // the trend line's monthly step
    out.push(Math.abs(perMonth) < 1
      ? `Over the last ${last12.length} months your sales have been fairly steady overall.`
      : `Over the last ${last12.length} months your sales have been ${perMonth > 0 ? "growing" : "falling"} by about ${Math.abs(perMonth)}% a month on average.`);
  }
  // Seasonality, with 2+ years.
  if (n >= 24) {
    const idx = Array.from({ length: 12 }, () => []);
    const t = total.history, start = 0;
    for (let i = 6; i < n - 6; i++) { const base = mean(t.slice(i - 6, i + 6)); if (base > 0) idx[(Number(data.months[start + i].slice(5, 7)) - 1)].push(t[i] / base); }
    const im = idx.map((r) => (r.length ? mean(r) : 1));
    let pick = null;
    for (const m of months) { const mi = Number(m.slice(5, 7)) - 1, dev = im[mi] - 1; if (Math.abs(dev) >= 0.1 && (!pick || Math.abs(dev) > Math.abs(pick.dev))) pick = { mi, dev }; }
    if (pick) out.push(`${MONTHS_LONG[pick.mi]} is usually ${pick.dev > 0 ? "a strong" : "a quiet"} month for you (about ${Math.round(Math.abs(pick.dev) * 100)}% ${pick.dev > 0 ? "above" : "below"} a typical month), which ${pick.dev > 0 ? "lifts" : "pulls down"} the forecast.`);
  }
  // Which products drive the change.
  const moves = products.map((p) => ({ name: p.name, d: p.next3 - p.last3 })).filter((m) => Math.abs(m.d) > 0).sort((a, b) => b.d - a.d);
  const up = moves.filter((m) => m.d > 0), down = moves.filter((m) => m.d < 0).reverse();
  const bits = [];
  if (up[0]) bits.push(`${up[0].name} adds the most (${fmt(up[0].d, k).replace(/^/, "+")})`);
  if (down[0]) bits.push(`${down[0].name} falls the most (${fmt(Math.abs(down[0].d), k).replace(/^/, "−")})`);
  if (bits.length && products.length > 1) out.push(`Compared with the last 3 months, ${bits.join(", while ")}.`);
  // Concentration.
  const grand = sum(products.map((p) => p.next3));
  const top = [...products].sort((a, b) => b.next3 - a.next3)[0];
  if (top && grand > 0 && products.length > 1) out.push(`Your biggest product, ${top.name}, is about ${Math.round((top.next3 / grand) * 100)}% of the forecast.`);
  // How it was worked out.
  const counts = {};
  products.forEach((p) => { counts[p.method] = (counts[p.method] || 0) + 1; });
  const how = Object.entries(counts).sort((a, b) => b[1] - a[1]).map(([m, c]) => `${METHODS[m].words} for ${c} product${c === 1 ? "" : "s"}`);
  out.push(`How it was worked out: each product uses the method that best predicted its own recent months — ${how.join(", ")}.`);
  if (n < 12) out.push(`You have ${n} months of sales history; forecasts get steadier with 12–24 months.`);
  return out;
}
