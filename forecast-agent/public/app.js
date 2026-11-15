/**
 * Forecasting Agent — the customer's page.
 * The spreadsheet is read here, in the browser (CSV by parse.js, Excel by the bundled SheetJS); only monthly totals
 * per product are sent. The server runs the backtest and (when switched on) the forecast, in this company's own store.
 */
import { parseCSV, detectColumns, dateOrderOf, toMonthly } from "/parse.js";
import { lineChart, short } from "/chart.js";

const $ = (id) => document.getElementById(id);
const TOKEN_KEY = "forecast.token";
const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
const monthLabel = (ym) => `${MONTHS[+ym.slice(5, 7) - 1]} ${ym.slice(0, 4)}`;
const METHOD_WORDS = { flat: "Recent average", trend: "Straight-line trend", holt: "Smoothed trend", seasonal: "Seasons + trend", lastyear: "Last year's pattern + growth" };
const SEND_PRODUCTS = 200; // more than this are added together as "Other products" before sending
let token = load(TOKEN_KEY), me = null, contact = "", mode = "signup";
let sheet = null;      // { name, header, rows }
let current = null;    // the upload being shown

function load(k) { try { return localStorage.getItem(k); } catch { return null; } }
function save(k, v) { try { v ? localStorage.setItem(k, v) : localStorage.removeItem(k); } catch { /* private mode */ } }
const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);
const fmt = (v, kind) => (kind === "units" ? `${Math.round(v).toLocaleString("en-US")}` : v.toLocaleString("en-US", { style: "currency", currency: "USD", maximumFractionDigits: Math.abs(v) >= 1000 ? 0 : 2 }));
const sum = (a) => a.reduce((x, y) => x + y, 0);
const showErr = (id, msg) => { const e = $(id); e.textContent = msg || ""; e.hidden = !msg; };

async function call(path, { method = "GET", body } = {}) {
  const res = await fetch(path, {
    method, headers: { ...(body ? { "content-type": "application/json" } : {}), ...(token ? { Authorization: `Bearer ${token}` } : {}) },
    body: body ? JSON.stringify(body) : undefined,
  });
  const data = res.status === 204 ? {} : await res.json().catch(() => ({}));
  if (res.status === 401 && !path.startsWith("/api/login") && !path.startsWith("/api/signup")) { token = null; save(TOKEN_KEY, null); show("auth"); }
  if (res.status === 403 && data.off) showOff(data.contact);
  return { ok: res.ok, status: res.status, data };
}

function show(view) {
  for (const id of ["loading", "auth", "off", "home", "result"]) $(id).hidden = id !== view;
  $("who").hidden = !(me && (view === "home" || view === "result"));
  window.scrollTo(0, 0);
}
function showOff(c) {
  $("off-contact").textContent = c ? `To switch it back on, contact: ${c}` : "Contact the people you signed up with to switch it back on.";
  show("off");
}

// ── Sign up / sign in ──────────────────────────────────────────────────────────────────────────────────────────
function setMode(m) {
  mode = m;
  $("tab-signup").setAttribute("aria-selected", String(m === "signup"));
  $("tab-login").setAttribute("aria-selected", String(m === "login"));
  $("company-row").hidden = m !== "signup";
  $("pw-hint").hidden = m !== "signup";
  $("password").autocomplete = m === "signup" ? "new-password" : "current-password";
  $("auth-submit").textContent = m === "signup" ? "Create free account" : "Sign in";
  showErr("auth-error");
}
$("tab-signup").onclick = () => setMode("signup");
$("tab-login").onclick = () => setMode("login");
$("auth-form").onsubmit = async (e) => {
  e.preventDefault();
  showErr("auth-error");
  const body = { email: $("email").value, password: $("password").value };
  if (mode === "signup") body.company = $("company").value;
  $("auth-submit").disabled = true;
  const r = await call(mode === "signup" ? "/api/signup" : "/api/login", { method: "POST", body });
  $("auth-submit").disabled = false;
  if (!r.ok) { if (!r.data.off) showErr("auth-error", r.data.error || "That didn't work. Try again."); return; }
  token = r.data.token; save(TOKEN_KEY, token); me = r.data.me;
  $("password").value = "";
  await start();
};
$("signout").onclick = async () => { await call("/api/logout", { method: "POST" }); token = null; me = null; save(TOKEN_KEY, null); location.hash = "#/"; setMode("login"); show("auth"); };

// ── Reading the spreadsheet ────────────────────────────────────────────────────────────────────────────────────
let xlsxReady = null;
const loadXLSX = () => (xlsxReady ||= new Promise((ok, fail) => {
  const s = document.createElement("script");
  s.src = "/vendor/xlsx.full.min.js";
  s.onload = () => ok(window.XLSX);
  s.onerror = () => fail(new Error("The Excel reader didn't load. Check your connection, or save the file as CSV."));
  document.head.appendChild(s);
}));

async function readFile(file) {
  if (file.size > 40 * 1024 * 1024) throw new Error("That file is over 40 MB. Save just the date, product and sales columns and try again.");
  if (/\.(xlsx|xls)$/i.test(file.name)) {
    const XLSX = await loadXLSX();
    const wb = XLSX.read(await file.arrayBuffer(), { type: "array", cellDates: true });
    // The sheet with the most rows is the sales sheet.
    const best = wb.SheetNames.map((n) => XLSX.utils.sheet_to_json(wb.Sheets[n], { header: 1, raw: true, defval: "" })).sort((a, b) => b.length - a.length)[0] || [];
    return best.filter((r) => r.some((v) => String(v).trim() !== ""));
  }
  return parseCSV(await file.text());
}

function useRows(name, rows) {
  showErr("file-error");
  if (rows.length < 2) { showErr("file-error", "That file has no rows of sales in it."); return; }
  let header = rows[0].map((h, i) => String(h ?? "").trim() || `Column ${i + 1}`);
  let body = rows.slice(1);
  // No header row? (the first row already looks like a sale)
  if (detectColumns(rows[0].map(() => ""), [rows[0]]).date >= 0 && rows[0].some((v) => v instanceof Date || /^\d{1,4}[-/.]\d{1,2}[-/.]\d{1,4}/.test(String(v)))) {
    header = rows[0].map((_, i) => `Column ${i + 1}`); body = rows;
  }
  const width = Math.max(...rows.slice(0, 50).map((r) => r.length));
  while (header.length < width) header.push(`Column ${header.length + 1}`);
  sheet = { name, header, rows: body };
  const det = detectColumns(header, body);
  const opts = (sel, allowNone) => {
    sel.innerHTML = (allowNone ? `<option value="-1">No product column (total sales only)</option>` : "") + header.map((h, i) => `<option value="${i}">${esc(h)}</option>`).join("");
  };
  opts($("col-date")); opts($("col-product"), true); opts($("col-value"));
  $("col-date").value = String(det.date); $("col-product").value = String(det.product); $("col-value").value = String(det.value);
  $("kind").value = det.kind;
  $("upload-name").value = name.replace(/\.[^.]+$/, "").slice(0, 120);
  $("map-file").textContent = `${name} — ${body.length.toLocaleString("en-US")} rows. We've guessed the columns; change them if they're wrong.`;
  $("map").hidden = false;
  checkOrder();
  preview();
  $("map").scrollIntoView({ behavior: "smooth", block: "start" });
}

function checkOrder() {
  const o = dateOrderOf(sheet.rows, +$("col-date").value);
  $("order-row").hidden = o !== null;
  $("order").dataset.auto = o === null ? "" : o;
  if (o !== null) $("order").value = "";
}

function monthly() {
  const order = $("order").dataset.auto || $("order").value;
  if (!order) return { error: "Your dates could be day/month or month/day. Choose how they're written." };
  const m = toMonthly(sheet.rows, { date: +$("col-date").value, product: +$("col-product").value, value: +$("col-value").value, order: order === "ymd" ? "dmy" : order });
  if (!m.months.length) return { error: "No dates and amounts could be read with these columns. Check the choices above." };
  return m;
}

function preview() {
  showErr("map-error");
  const m = monthly();
  if (m.error) { $("preview").textContent = ""; showErr("map-error", m.error); $("run").disabled = true; return; }
  const names = Object.keys(m.products);
  const n = m.months.length;
  let msg = `Found <b>${n} months</b> (${monthLabel(m.months[0])} to ${monthLabel(m.months[n - 1])}), <b>${names.length} product${names.length === 1 ? "" : "s"}</b>, ${m.used.toLocaleString("en-US")} rows used`;
  if (m.skipped) msg += `, <b>${m.skipped.toLocaleString("en-US")} rows skipped</b> (no readable date or amount)`;
  msg += ".";
  if (n < 9) msg += ` <span class="warn">The accuracy test needs at least 9 months${n >= 6 ? "; a forecast is still possible" : " and a forecast needs 6"}.</span>`;
  $("preview").innerHTML = msg;
  $("run").disabled = n < 6;
}
for (const id of ["col-product", "col-value", "order"]) $(id).onchange = preview;
$("col-date").onchange = () => { checkOrder(); preview(); };

$("file").onchange = async () => {
  const f = $("file").files[0];
  if (!f) return;
  try { useRows(f.name, await readFile(f)); } catch (err) { showErr("file-error", err.message || "That file couldn't be read."); }
  $("file").value = "";
};
$("sample").onclick = async () => {
  $("sample").disabled = true;
  try { useRows("Sample sales (drinks & snacks).csv", parseCSV(await (await fetch("/sample-sales.csv")).text())); }
  catch { showErr("file-error", "The sample didn't load. Try again."); }
  $("sample").disabled = false;
};

$("run").onclick = async () => {
  const m = monthly();
  if (m.error) return showErr("map-error", m.error);
  let products = m.products;
  const names = Object.keys(products);
  if (names.length > SEND_PRODUCTS) {
    const ranked = names.sort((a, b) => sum(products[b]) - sum(products[a]));
    const keep = Object.fromEntries(ranked.slice(0, SEND_PRODUCTS - 1).map((k) => [k, products[k]]));
    const rest = ranked.slice(SEND_PRODUCTS - 1);
    keep[`Other products (${rest.length})`] = m.months.map((_, i) => Math.round(sum(rest.map((k) => products[k][i])) * 100) / 100);
    products = keep;
  }
  $("run").disabled = true; $("run").textContent = "Testing…";
  const r = await call("/api/uploads", { method: "POST", body: { name: $("upload-name").value, kind: $("kind").value, months: m.months, products } });
  $("run").disabled = false; $("run").textContent = "Run the free accuracy test";
  if (!r.ok) return showErr("map-error", r.data.error || "That didn't work. Try again.");
  $("map").hidden = true; sheet = null;
  location.hash = `#/u/${r.data.upload.id}`;
};

// ── Uploads list ───────────────────────────────────────────────────────────────────────────────────────────────
async function renderHome() {
  show("home");
  const r = await call("/api/uploads");
  if (!r.ok) return;
  const list = r.data.uploads;
  $("no-uploads").hidden = list.length > 0;
  $("uploads").innerHTML = list.map((u) => `<li><a href="#/u/${u.id}"><span class="u-name">${esc(u.name)}</span>
    <span class="u-meta">${u.months} months · ${u.products} product${u.products === 1 ? "" : "s"} · ${new Date(u.created).toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric" })}</span>
    <span class="u-acc">${u.accuracy === null ? "—" : `${u.accuracy}% accurate`}${u.hasForecast ? " · forecast ready" : ""}</span></a></li>`).join("");
}

// ── One upload ─────────────────────────────────────────────────────────────────────────────────────────────────
async function renderUpload(id) {
  const r = await call(`/api/uploads/${id}`);
  if (!r.ok) { location.hash = "#/"; return; }
  current = r.data.upload;
  show("result");
  const u = current;
  $("r-name").textContent = u.name;
  $("r-meta").textContent = `${u.months} months of sales (${monthLabel(u.first)} to ${monthLabel(u.last)}) · ${u.products} product${u.products === 1 ? "" : "s"} · ${u.kind === "units" ? "quantities" : "dollar sales"}`;
  renderBacktest(u.backtest);
  showErr("fc-error");
  $("fc-locked").hidden = true;
  if (u.forecast) renderForecast(u.forecast, u.forecastAt);
  else { $("fc").hidden = true; $("fc-ask").hidden = false; if (!me.forecasts) showLocked(); }
}

function renderBacktest(bt) {
  $("bt-none").hidden = bt.ok; $("bt").hidden = !bt.ok;
  if (!bt.ok) { $("bt-none").textContent = bt.reason; return; }
  const k = bt.kind;
  $("bt-acc").textContent = bt.accuracy === null ? "—" : `${bt.accuracy}%`;
  $("bt-months").textContent = `Hidden months: ${bt.months.map(monthLabel).join(", ")}`;
  $("bt-summary").innerHTML = bt.summary.map((s) => `<li>${esc(s)}</li>`).join("");
  const hm = bt.history.months, h = bt.history.total;
  const labels = [...hm, ...bt.months].map(monthLabel);
  lineChart($("bt-chart"), {
    labels, kind: k, format: (v) => fmt(v, k), caption: "Actual sales and the backtest's predictions for the hidden 3 months",
    series: [
      { name: "Actual", color: 1, values: [...h, ...bt.total.actual] },
      { name: "Predicted (hidden months)", color: 2, dashed: true, values: [...h.map((_, i) => (i === h.length - 1 ? h[i] : null)), ...bt.total.predicted] },
    ],
  });
  const head = `<thead><tr><th>Product</th>${bt.months.map((m) => `<th colspan="2">${monthLabel(m)}</th>`).join("")}<th>Accuracy</th></tr>
    <tr class="sub"><th></th>${bt.months.map(() => "<th>Predicted</th><th>Actual</th>").join("")}<th></th></tr></thead>`;
  const row = (name, p, a, acc, cls = "") => `<tr class="${cls}"><th scope="row">${esc(name)}</th>${p.map((v, i) => `<td>${fmt(v, k)}</td><td>${fmt(a[i], k)}</td>`).join("")}<td>${acc === null ? "—" : `${acc}%`}</td></tr>`;
  $("bt-table").innerHTML = head + "<tbody>" + bt.products.map((p) => row(p.name, p.predicted, p.actual, p.accuracy)).join("") +
    row("Total", bt.total.predicted, bt.total.actual, bt.accuracy, "total") + "</tbody>";
}

function showLocked(c = contact) {
  $("fc-ask").hidden = true;
  $("fc-locked").hidden = false;
  $("fc-contact").textContent = c ? `To switch it on, contact: ${c}` : "Contact us to switch it on.";
}

$("fc-run").onclick = async () => {
  showErr("fc-error");
  $("fc-run").disabled = true; $("fc-run").textContent = "Forecasting…";
  const r = await call(`/api/uploads/${current.id}/forecast`, { method: "POST" });
  $("fc-run").disabled = false; $("fc-run").textContent = "Make my 3-month forecast";
  if (r.status === 402) return showLocked(r.data.contact);
  if (!r.ok) return showErr("fc-error", r.data.error || "That didn't work. Try again.");
  current.forecast = r.data.forecast;
  renderForecast(r.data.forecast, new Date().toISOString());
};

function renderForecast(fc, at) {
  $("fc-ask").hidden = true; $("fc-locked").hidden = true;
  if (!fc.ok) { showErr("fc-error", fc.reason); $("fc").hidden = true; return; }
  $("fc").hidden = false;
  const k = fc.kind;
  $("fc-summary").innerHTML = fc.summary.map((s) => `<li>${esc(s)}</li>`).join("");
  $("fc-pick").innerHTML = `<option value="">All products (total)</option>` + fc.products.map((p, i) => `<option value="${i}">${esc(p.name)}</option>`).join("");
  $("fc-pick").onchange = () => drawForecast(fc);
  drawForecast(fc);
  const unit = k === "units" ? " (units)" : "";
  const row = (name, last3, f, next3, method, cls = "") => {
    const ch = last3 > 0 ? Math.round(((next3 - last3) / last3) * 100) : null;
    return `<tr class="${cls}"><th scope="row">${esc(name)}</th><td>${fmt(last3, k)}</td>${f.map((v) => `<td>${fmt(v, k)}</td>`).join("")}<td><b>${fmt(next3, k)}</b></td>
      <td class="${ch > 0 ? "up" : ch < 0 ? "down" : ""}">${ch === null ? "—" : `${ch > 0 ? "▲" : ch < 0 ? "▼" : ""} ${Math.abs(ch)}%`}</td><td class="method">${method}</td></tr>`;
  };
  const totalNext = sum(fc.total.forecast), totalLast = sum(fc.total.history.slice(-3));
  $("fc-table").innerHTML = `<thead><tr><th>Product${unit}</th><th>Last 3 months</th>${fc.months.map((m) => `<th>${monthLabel(m)}</th>`).join("")}<th>Next 3 months</th><th>Change</th><th>How</th></tr></thead><tbody>` +
    fc.products.map((p) => row(p.name, p.last3, p.forecast, p.next3, METHOD_WORDS[p.method] || p.method)).join("") +
    row("Total", totalLast, fc.total.forecast, totalNext, "", "total") + "</tbody>";
  $("fc-when").textContent = at ? `Made ${new Date(at).toLocaleString("en-US", { dateStyle: "medium", timeStyle: "short" })}` : "";
}

function drawForecast(fc) {
  const k = fc.kind, pick = $("fc-pick").value;
  const p = pick === "" ? null : fc.products[+pick];
  const hist = (p ? p.history : fc.total.history).slice(-24), f = p ? p.forecast : fc.total.forecast;
  const hm = fc.historyMonths.slice(-24);
  lineChart($("fc-chart"), {
    labels: [...hm, ...fc.months].map(monthLabel), kind: k, format: (v) => fmt(v, k), caption: `${p ? p.name : "Total sales"}: actual and next 3 months`,
    series: [
      { name: `Actual${p ? ` — ${p.name}` : ""}`, color: 1, values: [...hist, null, null, null] },
      { name: "Forecast", color: 2, dashed: true, values: [...hist.map((_, i) => (i === hist.length - 1 ? hist[i] : null)), ...f] },
    ],
  });
}

$("fc-csv").onclick = () => {
  const fc = current?.forecast;
  if (!fc?.ok) return;
  const q = (s) => `"${String(s).replace(/"/g, '""')}"`;
  const lines = [["Product", ...fc.months.map(monthLabel), "Next 3 months", "Last 3 months"].map(q).join(",")];
  for (const p of fc.products) lines.push([q(p.name), ...p.forecast, p.next3, p.last3].join(","));
  lines.push([q("Total"), ...fc.total.forecast, Math.round(sum(fc.total.forecast) * 100) / 100, Math.round(sum(fc.total.history.slice(-3)) * 100) / 100].join(","));
  const a = document.createElement("a");
  a.href = URL.createObjectURL(new Blob([lines.join("\n") + "\n"], { type: "text/csv" }));
  a.download = `forecast-${current.name.replace(/[^\w-]+/g, "-").slice(0, 40)}.csv`;
  a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 5000);
};

$("r-delete").onclick = async () => {
  if (!confirm(`Delete "${current.name}"? Its accuracy test and forecast go too.`)) return;
  await call(`/api/uploads/${current.id}`, { method: "DELETE" });
  location.hash = "#/";
};

// ── Start ──────────────────────────────────────────────────────────────────────────────────────────────────────
function route() {
  if (!me) return;
  const m = /^#\/u\/([0-9a-f]{32})$/.exec(location.hash);
  if (m) renderUpload(m[1]); else renderHome();
}
window.addEventListener("hashchange", route);

async function start() {
  if (!token) { show("auth"); return; }
  const r = await call("/api/me");
  if (!r.ok) { if (r.status !== 403) show("auth"); return; }
  me = r.data.me; contact = r.data.contact || "";
  $("who-name").textContent = me.company;
  route();
}
setMode(token ? "login" : "signup");
start();
