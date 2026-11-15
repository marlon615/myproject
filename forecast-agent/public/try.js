/**
 * The one-time demo page (/try#<link>). One file, one run, one full forecast; then the results stay viewable for
 * 72 hours and the link locks. The link's code stays after the "#", so it's never sent in a page request; it goes
 * to the API in a header.
 */
import { readFile, headerAndBody, buildSeries, detectColumns, detectExtra, dateOrderOf } from "/sheet.js";
import { lineChart } from "/chart.js";

const $ = (id) => document.getElementById(id);
const token = location.hash.slice(1);
const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
const monthLabel = (ym) => `${MONTHS[+ym.slice(5, 7) - 1]} ${ym.slice(0, 4)}`;
const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);
const fmt = (v, kind) => (kind === "units" ? `${Math.round(v).toLocaleString("en-US")}` : v.toLocaleString("en-US", { style: "currency", currency: "USD", maximumFractionDigits: Math.abs(v) >= 1000 ? 0 : 2 }));
const sum = (a) => a.reduce((x, y) => x + y, 0);
const showErr = (id, msg) => { const e = $(id); e.textContent = msg || ""; e.hidden = !msg; };
const VIEWS = ["t-loading", "t-invalid", "t-locked", "t-start", "t-result"];
const show = (v) => { for (const id of VIEWS) $(id).hidden = id !== v; window.scrollTo(0, 0); };
let info = null, sheet = null, built = null, poll = null;

async function call(path, opts = {}) {
  const res = await fetch(path, { method: opts.method || "GET", headers: { "X-Demo-Link": token, ...(opts.body ? { "content-type": "application/json" } : {}) }, body: opts.body ? JSON.stringify(opts.body) : undefined });
  return { ok: res.ok, status: res.status, data: await res.json().catch(() => ({})) };
}
const contactLine = (c) => (c ? `To continue with Draxly, contact us at <a href="mailto:${esc(c)}">${esc(c)}</a>.` : "To continue with Draxly, reply to the email your link came in.");

async function load() {
  if (!/^[0-9a-f]{64}$/.test(token)) return show("t-invalid");
  const r = await call("/api/try");
  if (r.status === 404 || !r.ok) return show("t-invalid");
  info = r.data;
  if (info.status === "locked") { $("t-locked-contact").innerHTML = contactLine(info.contact); return show("t-locked"); }
  if (info.status === "used") return showResult(info.result);
  $("t-company").textContent = ` for ${info.company}`;
  show("t-start");
}

// ── Choosing and checking the file (nothing is sent yet) ───────────────────────────────────────────────────────
$("t-file").onchange = async () => {
  const f = $("t-file").files[0];
  $("t-file").value = "";
  showErr("t-file-error");
  if (!f) return;
  try {
    const rows = await readFile(f);
    if (rows.length < 2) throw new Error("That file has no rows of sales in it.");
    const { header, body } = headerAndBody(rows);
    sheet = { name: f.name, header, rows: body };
    const det = detectColumns(header, body), extra = detectExtra(header, [det.date, det.product, det.value]);
    const opts = (sel, none) => { sel.innerHTML = (none ? `<option value="-1">${none}</option>` : "") + header.map((h, i) => `<option value="${i}">${esc(h)}</option>`).join(""); };
    opts($("t-date")); opts($("t-product"), "No product column (total sales only)"); opts($("t-value")); opts($("t-units"), "None"); opts($("t-location"), "None"); opts($("t-region"), "None");
    $("t-date").value = String(det.date); $("t-product").value = String(det.product); $("t-value").value = String(det.value);
    $("t-units").value = String(det.kind === "money" ? extra.units : -1); $("t-location").value = String(extra.location); $("t-region").value = String(extra.region);
    $("t-kind").value = det.kind;
    $("t-map-file").textContent = `${f.name} — ${body.length.toLocaleString("en-US")} rows. We've guessed the columns; check each one.`;
    $("t-map").hidden = false;
    checkOrder(); preview();
  } catch (e) { showErr("t-file-error", e.message || "That file couldn't be read."); }
};
function checkOrder() {
  const o = dateOrderOf(sheet.rows, +$("t-date").value);
  $("t-order-row").hidden = o !== null;
  $("t-order").dataset.auto = o === null ? "" : o;
}
function preview() {
  showErr("t-map-error");
  built = null;
  const order = $("t-order").dataset.auto || $("t-order").value;
  if (!order) { $("t-preview").textContent = ""; showErr("t-map-error", "Your dates could be day/month or month/day. Choose how they're written."); return gate(); }
  const m = buildSeries(sheet.rows, { date: +$("t-date").value, product: +$("t-product").value, value: +$("t-value").value, units: +$("t-units").value, location: +$("t-location").value, region: +$("t-region").value }, order, $("t-kind").value === "units");
  if (m.error) { $("t-preview").textContent = ""; showErr("t-map-error", m.error); return gate(); }
  const n = m.months.length;
  const problems = [];
  if (n < 9) problems.push(`Only ${n} months were found — at least 9 are needed (12–36 is best).`);
  if (m.series.length > 500) problems.push(`${m.series.length.toLocaleString("en-US")} product × location combinations were found — the demo takes up to 500. Remove some products or stores from the file.`);
  $("t-preview").innerHTML = `<ul class="found">
    <li><b>${m.allMonths || n} months</b>: ${monthLabel(m.allMonths ? m.firstAll : m.months[0])} to ${monthLabel(m.months[n - 1])}${m.allMonths ? ` (the latest ${n} will be used)` : ""}</li>
    <li><b>${m.products.toLocaleString("en-US")} product${m.products === 1 ? "" : "s"}</b>${m.locations ? `, <b>${m.locations} store${m.locations === 1 ? "" : "s"}/warehouses</b>` : ""}${m.regions ? `, <b>${m.regions} region${m.regions === 1 ? "" : "s"}</b>` : ""}</li>
    <li>${m.hasAmount ? "Sales amounts" : ""}${m.hasAmount && m.hasUnits ? " and " : ""}${m.hasUnits ? "quantities" : ""}</li>
    <li>${m.used.toLocaleString("en-US")} rows used${m.skipped ? `, <b>${m.skipped.toLocaleString("en-US")} rows skipped</b> (no readable date or amount — check the columns)` : ""}</li></ul>`;
  if (problems.length) showErr("t-map-error", problems.join(" "));
  else built = m;
  gate();
}
function gate() { $("t-run").disabled = !(built && $("t-confirm").checked); }
for (const id of ["t-product", "t-value", "t-units", "t-location", "t-region", "t-order", "t-kind"]) $(id).onchange = preview;
$("t-date").onchange = () => { checkOrder(); preview(); };
$("t-confirm").onchange = gate;

// ── The one run ────────────────────────────────────────────────────────────────────────────────────────────────
$("t-run").onclick = async () => {
  if (!built) return;
  if (!confirm(`Last check before your one run:\n\n• ${built.months.length} months (${monthLabel(built.months[0])} to ${monthLabel(built.months[built.months.length - 1])})\n• ${built.products} products${built.locations ? `, ${built.locations} stores/warehouses` : ""}\n\nThis uses your demo link. You can't run it again. Continue?`)) return;
  $("t-run").disabled = true; $("t-run").textContent = "Running your forecast…";
  const r = await call("/api/try/run", { method: "POST", body: { name: sheet.name.replace(/\.[^.]+$/, ""), months: built.months, series: built.series } });
  if (!r.ok) {
    $("t-run").textContent = "Run my forecast (uses my one run)";
    if (r.status === 409) { info.contact = r.data.contact; return load(); }
    showErr("t-map-error", r.data.error || "That didn't work. Please try again."); gate();
    return;
  }
  load();
};

// ── Results ────────────────────────────────────────────────────────────────────────────────────────────────────
function showResult(u) {
  show("t-result");
  $("t-r-title").textContent = `Your Draxly forecast${info?.company ? ` — ${info.company}` : ""}`;
  const until = info?.viewUntil ? new Date(info.viewUntil).toLocaleString("en-US", { dateStyle: "medium", timeStyle: "short" }) : "";
  $("t-r-contact").innerHTML = `Your one run is used. These results stay here until <b>${esc(until)}</b>; then this link locks for good and your sales data is deleted. ${contactLine(info?.contact)}`;
  const ready = u && u.backtest?.ok && u.forecast?.ok;
  $("t-r-status").hidden = Boolean(ready);
  $("t-r-status").textContent = u?.status === "error" ? `Something went wrong while forecasting. ${info?.contact ? `Please contact us at ${info.contact} and` : "Please reply to your email and"} we'll reset your link.` : "Working on your forecast… this page updates by itself.";
  if (!ready && u?.status !== "error") { clearTimeout(poll); poll = setTimeout(load, 2000); }
  if (!u) return;
  const bt = u.backtest;
  $("t-bt-card").hidden = !bt?.ok;
  if (bt?.ok) {
    const k = bt.kind;
    $("t-acc").textContent = bt.accuracy === null ? "—" : `${bt.accuracy}%`;
    $("t-bt-months").textContent = `Hidden months: ${bt.months.map(monthLabel).join(", ")}`;
    $("t-bt-summary").innerHTML = bt.summary.map((s) => `<li>${esc(s)}</li>`).join("");
    const h = bt.history.total;
    lineChart($("t-bt-chart"), { labels: [...bt.history.months, ...bt.months].map(monthLabel), kind: k, format: (v) => fmt(v, k), caption: "Actual sales and the predictions for the hidden months",
      series: [{ name: "Actual", color: 1, values: [...h, ...bt.total.actual] }, { name: "Predicted (hidden months)", color: 2, dashed: true, values: [...h.map((_, i) => (i === h.length - 1 ? h[i] : null)), ...bt.total.predicted] }] });
  }
  const fc = u.forecast;
  $("t-fc-card").hidden = !fc?.ok;
  if (fc?.ok) {
    const k = fc.kind;
    $("t-fc-summary").innerHTML = fc.summary.map((s) => `<li>${esc(s)}</li>`).join("");
    const hist = fc.total.history.slice(-24), hm = fc.historyMonths.slice(-24);
    lineChart($("t-fc-chart"), { labels: [...hm, ...fc.months].map(monthLabel), kind: k, format: (v) => fmt(v, k), caption: "Total sales: actual and next 3 months",
      series: [{ name: "Actual", color: 1, values: [...hist, null, null, null] }, { name: "Forecast", color: 2, dashed: true, values: [...hist.map((_, i) => (i === hist.length - 1 ? hist[i] : null)), ...fc.total.forecast] }] });
    const table = (list, title) => `<thead><tr><th>${title}</th><th>Last 3 months</th>${fc.months.map((m) => `<th>${monthLabel(m)}</th>`).join("")}<th>Next 3 months</th></tr></thead><tbody>` +
      list.map((p) => `<tr><th scope="row">${esc(p.name)}</th><td>${fmt(p.last3, k)}</td>${p.forecast.map((v) => `<td>${fmt(v, k)}</td>`).join("")}<td><b>${fmt(p.next3, k)}</b></td></tr>`).join("") +
      `<tr class="total"><th scope="row">Total</th><td>${fmt(sum(fc.total.history.slice(-3)), k)}</td>${fc.total.forecast.map((v) => `<td>${fmt(v, k)}</td>`).join("")}<td><b>${fmt(sum(fc.total.forecast), k)}</b></td></tr></tbody>`;
    $("t-fc-table").innerHTML = table(fc.products, "Product");
    $("t-loc-wrap").hidden = !(fc.locations?.length > 1);
    if (fc.locations?.length > 1) $("t-loc-table").innerHTML = table(fc.locations, "Store / warehouse");
    $("t-csv").onclick = () => {
      const q = (s) => `"${String(s).replace(/"/g, '""')}"`;
      const lines = [["Product", ...fc.months.map(monthLabel), "Next 3 months", "Last 3 months"].map(q).join(",")];
      for (const p of fc.products) lines.push([q(p.name), ...p.forecast, p.next3, p.last3].join(","));
      const a = document.createElement("a");
      a.href = URL.createObjectURL(new Blob([lines.join("\n") + "\n"], { type: "text/csv" }));
      a.download = `draxly-forecast-${(info?.company || "demo").replace(/[^\w-]+/g, "-").slice(0, 40)}.csv`; a.click();
      setTimeout(() => URL.revokeObjectURL(a.href), 5000);
    };
  }
}
load();
