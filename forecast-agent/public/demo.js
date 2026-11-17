/**
 * The open demo (/demo): no sign-up, starts empty. The visitor's spreadsheet is read here; monthly totals per product
 * are sent in batches to be forecast and come straight back — nothing is stored on the server. Results live only in
 * this page; "Start over" or closing the tab removes them.
 */
import { readFile, headerAndBody, buildSeries, detectColumns, dateOrderOf } from "/sheet.js";
import { lineChart } from "/chart.js";

const $ = (id) => document.getElementById(id);
const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
const monthLabel = (ym) => `${MONTHS[+ym.slice(5, 7) - 1]} ${ym.slice(0, 4)}`;
const nextMonth = (ym) => { const [y, m] = ym.split("-").map(Number); return m === 12 ? `${y + 1}-01` : `${y}-${String(m + 1).padStart(2, "0")}`; };
const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);
const fmt = (v, kind) => (kind === "units" ? `${Math.round(v).toLocaleString("en-US")}` : v.toLocaleString("en-US", { style: "currency", currency: "USD", maximumFractionDigits: Math.abs(v) >= 1000 ? 0 : 2 }));
const sum = (a) => a.reduce((x, y) => x + y, 0);
const r2 = (v) => Math.round(v * 100) / 100;
const showErr = (id, msg) => { const e = $(id); e.textContent = msg || ""; e.hidden = !msg; };
const MAX_MONTHS = 60, PARALLEL = 4;
let sheet = null, built = null, result = null, visit = null;

// ── The fairness rule: the demo only predicts months that have already finished ────────────────────────────
// The server works it out from today's date (and refuses anything later); this page asks it, so both always agree.
const FULL = ["January", "February", "March", "April", "May", "June", "July", "August", "September", "October", "November", "December"];
const monthName = (ym) => `${FULL[+ym.slice(5, 7) - 1]} ${ym.slice(0, 4)}`;
const shiftMonth = (ym, n) => { const [y, m] = ym.split("-").map(Number); const t = y * 12 + m - 1 + n; return `${Math.floor(t / 12)}-${String((t % 12) + 1).padStart(2, "0")}`; };
const localRules = () => { // only if the server can't be reached; the server still checks every request
  const p = new Intl.DateTimeFormat("en-US", { timeZone: "Pacific/Honolulu", year: "numeric", month: "2-digit" }).formatToParts(new Date());
  const cur = `${p.find((x) => x.type === "year").value}-${p.find((x) => x.type === "month").value}`, latestMonth = shiftMonth(cur, -4);
  return { current: cur, latestMonth, forecastMonths: [1, 2, 3].map((k) => shiftMonth(latestMonth, k)) };
};
const tooRecent = (r) => `To keep the test fair, please remove your most recent months so your file ends in ${monthName(r.latestMonth)}. Draxly will predict the 3 months after that (${monthName(r.forecastMonths[0])} to ${monthName(r.forecastMonths[2])}), and you can compare them with your real sales.`;
let rules = null;
const rulesReady = fetch("/api/demo/rules").then((r) => (r.ok ? r.json() : localRules())).catch(localRules).then((r) => {
  rules = r;
  const put = (cls, ym) => document.querySelectorAll(cls).forEach((e) => { e.textContent = monthName(ym); });
  put(".r-latest", r.latestMonth); put(".r-f1", r.forecastMonths[0]); put(".r-f3", r.forecastMonths[2]); put(".r-first", shiftMonth(r.latestMonth, -20));
  return r;
});

async function post(path, body) {
  const res = await fetch(path, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
  return { ok: res.ok, status: res.status, data: await res.json().catch(() => ({})) };
}

// ── File → products by month (in the browser) ──────────────────────────────────────────────────────────────────
$("d-file").onchange = async () => {
  const f = $("d-file").files[0];
  $("d-file").value = "";
  showErr("d-file-error");
  if (!f) return;
  try {
    await rulesReady;
    const rows = await readFile(f);
    if (rows.length < 2) throw new Error("That file has no rows of sales in it.");
    const { header, body } = headerAndBody(rows);
    sheet = { name: f.name, header, rows: body };
    const det = detectColumns(header, body);
    const opts = (sel, none) => { sel.innerHTML = (none ? `<option value="-1">${none}</option>` : "") + header.map((h, i) => `<option value="${i}">${esc(h)}</option>`).join(""); };
    opts($("d-date")); opts($("d-product"), "No product column (total sales only)"); opts($("d-value"));
    $("d-date").value = String(det.date); $("d-product").value = String(det.product); $("d-value").value = String(det.value); $("d-kind").value = det.kind;
    $("d-map-file").textContent = `${f.name} — ${body.length.toLocaleString("en-US")} rows. We've guessed the columns; check them.`;
    $("d-map").hidden = false;
    const o = dateOrderOf(body, det.date);
    $("d-order-row").hidden = o !== null; $("d-order").dataset.auto = o === null ? "" : o;
    preview();
  } catch (e) { showErr("d-file-error", e.message || "That file couldn't be read."); }
};
function preview() {
  showErr("d-map-error");
  built = null;
  const order = $("d-order").dataset.auto || $("d-order").value;
  if (!order) { $("d-preview").textContent = ""; showErr("d-map-error", "Your dates could be day/month or month/day. Choose how they're written."); return gate(); }
  const kind = $("d-kind").value;
  const m = buildSeries(sheet.rows, { date: +$("d-date").value, product: +$("d-product").value, value: +$("d-value").value, units: -1, location: -1, region: -1 }, order, kind === "units", MAX_MONTHS);
  if (m.error) { $("d-preview").textContent = ""; showErr("d-map-error", m.error); return gate(); }
  const n = m.months.length, last = m.months[n - 1];
  const f1 = nextMonth(last), f3 = nextMonth(nextMonth(f1));
  $("d-preview").innerHTML = `<ul class="found">
    <li><b>${m.allMonths || n} months</b>: ${monthLabel(m.allMonths ? m.firstAll : m.months[0])} to ${monthLabel(last)}${m.allMonths ? ` (the latest ${n} will be used)` : ""}</li>
    <li><b>${m.products.toLocaleString("en-US")} product${m.products === 1 ? "" : "s"}</b>, ${m.used.toLocaleString("en-US")} rows used${m.skipped ? `, <b>${m.skipped.toLocaleString("en-US")} skipped</b> (no readable date or amount — check the columns)` : ""}</li>
    ${rules && last > rules.latestMonth ? "" : `<li>Draxly will forecast <b>${monthLabel(f1)} to ${monthLabel(f3)}</b> — these should be the 3 months you kept back.</li>`}</ul>
    ${n !== 21 ? `<p class="warn">You've uploaded ${n} months; the demo is designed for 21 (24 months minus the 3 you keep back). ${n < 6 ? "At least 6 are needed." : "It will still work."}</p>` : ""}`;
  if (rules && last > rules.latestMonth) showErr("d-map-error", tooRecent(rules)); // would predict months that aren't over yet
  else if (n < 6) showErr("d-map-error", "At least 6 months are needed.");
  else built = { ...m, kind, forecastMonths: [f1, nextMonth(f1), f3] };
  gate();
}
function gate() { $("d-run").disabled = !built; }
for (const id of ["d-product", "d-value", "d-order", "d-kind"]) $(id).onchange = preview;
$("d-date").onchange = () => { const o = dateOrderOf(sheet.rows, +$("d-date").value); $("d-order-row").hidden = o !== null; $("d-order").dataset.auto = o === null ? "" : o; preview(); };

// ── Forecast in batches (nothing stored) ───────────────────────────────────────────────────────────────────────
$("d-run").onclick = async () => {
  if (!built) return;
  const b = built, t0 = performance.now();
  $("d-run").disabled = true; showErr("d-map-error");
  $("d-progress").hidden = false; $("d-bar").style.width = "0%";
  const q = new URLSearchParams(location.search);
  const start = await post("/api/demo/start", { referrer: document.referrer, source: ["utm_source", "utm_campaign", "ref"].map((k) => q.get(k) && `${k.replace("utm_", "")}=${q.get(k)}`).filter(Boolean).join(" "), products: b.series.length, months: b.months.length });
  visit = start.data.visit || null;
  const size = start.data.batch || 50, measure = b.kind === "units" ? "units" : "amount";
  const batches = [];
  for (let i = 0; i < b.series.length; i += size) batches.push(b.series.slice(i, i + size));
  const out = new Array(batches.length);
  let next = 0, done = 0, failed = null;
  const worker = async () => {
    while (next < batches.length && !failed) {
      const k = next++;
      const r = await post("/api/demo/forecast", { months: b.months, series: batches[k].map((s) => ({ product: s.product, values: s[measure] })) });
      if (!r.ok) { failed = r.data.error || "The forecast didn't finish. Please try again."; return; }
      out[k] = r.data.results;
      done++;
      $("d-bar").style.width = `${Math.round((100 * done) / batches.length)}%`;
      $("d-progress-text").textContent = `Forecasting… ${Math.min(done * size, b.series.length).toLocaleString("en-US")} of ${b.series.length.toLocaleString("en-US")} products`;
    }
  };
  await Promise.all(Array.from({ length: Math.min(PARALLEL, batches.length) }, worker));
  if (failed) { $("d-progress").hidden = true; $("d-run").disabled = false; return showErr("d-map-error", failed); }
  // Products → total, then the plain-English summary for the biggest products.
  const products = b.series.map((s, i) => {
    const r = out[Math.floor(i / size)][i % size];
    const hist = s[measure];
    return { name: s.product, history: hist, forecast: r.forecast, method: r.method, next3: r2(sum(r.forecast)), last3: r2(sum(hist.slice(-3))) };
  });
  const total = { history: b.months.map((_, j) => r2(sum(products.map((p) => p.history[j])))), forecast: [0, 1, 2].map((j) => r2(sum(products.map((p) => p.forecast[j])))) };
  const ranked = [...products].sort((x, y) => y.next3 - x.next3);
  const top = ranked.slice(0, 199);
  if (ranked.length > 199) { const rest = ranked.slice(199); top.push({ name: `Other (${rest.length.toLocaleString("en-US")} products)`, next3: r2(sum(rest.map((p) => p.next3))), last3: r2(sum(rest.map((p) => p.last3))), method: "flat" }); }
  const sm = await post("/api/demo/summary", { months: b.months, kind: b.kind, total, products: top.map(({ name, next3, last3, method }) => ({ name, next3, last3, method })) });
  result = { months: b.months, forecastMonths: b.forecastMonths, kind: b.kind, products: ranked, total, summary: sm.ok ? sm.data.summary : [], seconds: (performance.now() - t0) / 1000 };
  $("d-progress").hidden = true;
  showResult();
};

// ── Results ────────────────────────────────────────────────────────────────────────────────────────────────────
function showResult() {
  const r = result, k = r.kind;
  $("d-start").hidden = true; $("d-result").hidden = false; window.scrollTo(0, 0);
  $("d-r-title").textContent = `Draxly's prediction: ${monthLabel(r.forecastMonths[0])} to ${monthLabel(r.forecastMonths[2])}`;
  $("d-r-lead").innerHTML = `${r.products.length.toLocaleString("en-US")} product${r.products.length === 1 ? "" : "s"} forecast from ${r.months.length} months, ${r.seconds < 1 ? "in under a second" : `in ${r.seconds.toFixed(1)} seconds`}. Expected total: <b>${fmt(sum(r.total.forecast), k)}</b>. Compare it with the real numbers you kept back.`;
  $("d-summary").innerHTML = r.summary.map((s) => `<li>${esc(s)}</li>`).join("");
  $("d-pick").innerHTML = `<option value="">All products (total)</option>` + r.products.slice(0, 200).map((p, i) => `<option value="${i}">${esc(p.name)}</option>`).join("");
  $("d-pick").onchange = draw;
  draw(); table();
}
function draw() {
  const r = result, k = r.kind, i = $("d-pick").value, p = i === "" ? null : r.products[+i];
  const hist = (p ? p.history : r.total.history).slice(-24), f = p ? p.forecast : r.total.forecast;
  lineChart($("d-chart"), { labels: [...r.months.slice(-24), ...r.forecastMonths].map(monthLabel), kind: k, format: (v) => fmt(v, k), caption: `${p ? p.name : "Total sales"}: your history and Draxly's prediction for the 3 months after it`,
    series: [{ name: `Your history${p ? ` — ${p.name}` : ""}`, color: 1, values: [...hist, null, null, null] }, { name: "Draxly forecast", color: 2, dashed: true, values: [...hist.map((_, j) => (j === hist.length - 1 ? hist[j] : null)), ...f] }] });
}
function table() {
  const r = result, k = r.kind, q = $("d-search").value.trim().toLowerCase();
  const list = (q ? r.products.filter((p) => p.name.toLowerCase().includes(q)) : r.products);
  const shown = list.slice(0, 100);
  $("d-table-note").textContent = list.length > shown.length ? `Showing ${shown.length} of ${list.length.toLocaleString("en-US")} products${q ? " matching" : " (biggest first)"} — the CSV has all of them.` : `${list.length.toLocaleString("en-US")} product${list.length === 1 ? "" : "s"}.`;
  $("d-table").innerHTML = `<thead><tr><th>Product</th><th>Last 3 months</th>${r.forecastMonths.map((m) => `<th>${monthLabel(m)}</th>`).join("")}<th>Next 3 months</th></tr></thead><tbody>` +
    shown.map((p) => `<tr><th scope="row">${esc(p.name)}</th><td>${fmt(p.last3, k)}</td>${p.forecast.map((v) => `<td>${fmt(v, k)}</td>`).join("")}<td><b>${fmt(p.next3, k)}</b></td></tr>`).join("") +
    `<tr class="total"><th scope="row">Total (all ${r.products.length.toLocaleString("en-US")})</th><td>${fmt(sum(r.total.history.slice(-3)), k)}</td>${r.total.forecast.map((v) => `<td>${fmt(v, k)}</td>`).join("")}<td><b>${fmt(sum(r.total.forecast), k)}</b></td></tr></tbody>`;
}
$("d-search").oninput = () => table();
$("d-csv").onclick = () => {
  const r = result, q = (s) => `"${String(s).replace(/"/g, '""')}"`;
  const head = ["Product", ...r.forecastMonths.map((m) => `Forecast ${monthLabel(m)}`), "Forecast total", ...r.forecastMonths.map((m) => `Your actual ${monthLabel(m)}`), "Your actual total"];
  const lines = [head.map(q).join(",")];
  for (const p of r.products) lines.push([q(p.name), ...p.forecast, p.next3, "", "", "", ""].join(","));
  lines.push([q("Total"), ...r.total.forecast, r2(sum(r.total.forecast)), "", "", "", ""].join(","));
  const a = document.createElement("a");
  a.href = URL.createObjectURL(new Blob([lines.join("\n") + "\n"], { type: "text/csv" }));
  a.download = `draxly-forecast-${r.forecastMonths[0]}-to-${r.forecastMonths[2]}.csv`; a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 5000);
};
$("d-restart").onclick = () => {
  if (!confirm("Start over? Your forecast on this page is cleared (download the CSV first if you want it).")) return;
  sheet = built = result = null;
  $("d-result").hidden = true; $("d-start").hidden = false; $("d-map").hidden = true; $("d-run").disabled = true;
  $("d-chart").innerHTML = ""; $("d-table").innerHTML = "";
  window.scrollTo(0, 0);
};
$("d-form").onsubmit = async (e) => {
  e.preventDefault();
  showErr("d-form-error");
  const r = await post("/api/demo/request", { name: $("d-name").value, email: $("d-email").value, company: $("d-company").value, message: $("d-message").value, website: $("d-website").value, visit });
  if (!r.ok) return showErr("d-form-error", r.data.error || "That didn't send. Please try again.");
  $("d-form").hidden = true;
  $("d-form-ok").textContent = "Thanks — we've got your details and will be in touch."; $("d-form-ok").hidden = false;
};
