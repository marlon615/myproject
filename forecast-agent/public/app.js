/**
 * Forecasting Agent — the customer app.
 * Spreadsheets are read here in the browser (CSV by parse.js, Excel by the bundled SheetJS); only monthly totals per
 * product × store × region are sent. Everything else (forecasts, stock, connections, team, activity) is on the server,
 * in this company's own encrypted store. What a person can see and change follows their role.
 */
import { parseCSV, detectColumns, detectExtra, dateOrderOf, toYearMonth, parseNumber } from "/parse.js";
import { lineChart } from "/chart.js";

const $ = (id) => document.getElementById(id);
const TOKEN_KEY = "forecast.token";
const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
const monthLabel = (ym) => `${MONTHS[+ym.slice(5, 7) - 1]} ${ym.slice(0, 4)}`;
const METHOD_WORDS = { flat: "Recent average", trend: "Straight-line trend", holt: "Smoothed trend", seasonal: "Seasons + trend", lastyear: "Last year's pattern + growth" };
const DIM_WORDS = { products: ["Product", "products"], locations: ["Store / warehouse", "locations"], regions: ["Region", "regions"] };
const RANK = { viewer: 0, manager: 1, admin: 2 };
const MAX_MONTHS = 120, BATCH = 40; // big files go in parts of 40 series, so each request stays small
const VIEWS = ["loading", "auth", "off", "home", "result", "forgot", "reset", "code", "account", "twofa", "invite", "stock", "connections", "team", "activity"];
let token = load(TOKEN_KEY), me = null, contact = "", mode = "signup", ssoProviders = { microsoft: false, google: false };
let sheet = null, current = null, ticket = null, resetToken = null, inviteToken = null, pollTimer = null;

function load(k) { try { return localStorage.getItem(k); } catch { return null; } }
function save(k, v) { try { v ? localStorage.setItem(k, v) : localStorage.removeItem(k); } catch { /* private mode */ } }
const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);
const fmt = (v, kind) => (kind === "units" ? `${Math.round(v).toLocaleString("en-US")}` : v.toLocaleString("en-US", { style: "currency", currency: "USD", maximumFractionDigits: Math.abs(v) >= 1000 ? 0 : 2 }));
const sum = (a) => a.reduce((x, y) => x + y, 0);
const showErr = (id, msg) => { const e = $(id); e.textContent = msg || ""; e.hidden = !msg; };
const can = (role) => me && RANK[me.role] >= RANK[role];
const when = (iso) => (iso ? new Date(iso).toLocaleString("en-US", { dateStyle: "medium", timeStyle: "short" }) : "—");
function download(name, text, type = "text/csv") {
  const a = document.createElement("a");
  a.href = URL.createObjectURL(new Blob([text], { type }));
  a.download = name; a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 5000);
}
const csvRow = (cells) => cells.map((c) => (typeof c === "number" ? c : `"${String(c ?? "").replace(/"/g, '""')}"`)).join(",");

async function call(path, { method = "GET", body } = {}) {
  const res = await fetch(path, {
    method, headers: { ...(body ? { "content-type": "application/json" } : {}), ...(token ? { Authorization: `Bearer ${token}` } : {}) },
    body: body ? JSON.stringify(body) : undefined,
  });
  const data = res.status === 204 ? {} : await res.json().catch(() => ({}));
  // Signed out (session ended): only for signed-in requests, never for the sign-in / reset forms' own "wrong" answers.
  const PUBLIC = ["/api/login", "/api/login/2fa", "/api/signup", "/api/recover", "/api/reset", "/api/reset-request", "/api/logout", "/api/invite", "/api/sso/redeem"];
  if (res.status === 401 && !PUBLIC.includes(path.split("?")[0])) { token = null; me = null; save(TOKEN_KEY, null); setMode("login"); show("auth"); }
  if (res.status === 403 && data.off) showOff(data.contact);
  if (res.status === 403 && data.enroll2fa && me) { me.mustEnroll2fa = true; location.hash = "#/account"; }
  return { ok: res.ok, status: res.status, data };
}

function show(view) {
  for (const id of VIEWS) $(id).hidden = id !== view;
  const signedIn = Boolean(me) && !["auth", "forgot", "reset", "code", "twofa", "invite", "off", "loading"].includes(view);
  $("who").hidden = !signedIn;
  $("nav").hidden = !signedIn || me?.mustEnroll2fa;
  if (signedIn) {
    for (const a of document.querySelectorAll("#nav a")) {
      a.hidden = (a.dataset.feature && !me.features[a.dataset.feature]) || (a.dataset.role && !can(a.dataset.role));
      a.classList.toggle("active", a.dataset.nav === view || (view === "result" && a.dataset.nav === "home"));
    }
    for (const el of document.querySelectorAll("[data-min-role]")) el.hidden = !can(el.dataset.minRole);
    for (const el of document.querySelectorAll("[data-feature]:not(a)")) if (!me.features[el.dataset.feature]) el.hidden = true;
  }
  if (pollTimer && view !== "result" && view !== "stock" && view !== "connections") { clearTimeout(pollTimer); pollTimer = null; }
  window.scrollTo(0, 0);
}
function showOff(c) {
  $("off-contact").textContent = c ? `To switch it back on, contact: ${c}` : "Contact the people you signed up with to switch it back on.";
  show("off");
}

// ── Sign up / sign in / two-factor / single sign-on ────────────────────────────────────────────────────────────
function setMode(m) {
  mode = m;
  $("tab-signup").setAttribute("aria-selected", String(m === "signup"));
  $("tab-login").setAttribute("aria-selected", String(m === "login"));
  $("company-row").hidden = m !== "signup";
  $("pw-hint").hidden = m !== "signup";
  $("forgot-row").hidden = m !== "login";
  $("sso-row").hidden = m !== "login" || !(ssoProviders.microsoft || ssoProviders.google);
  $("password").autocomplete = m === "signup" ? "new-password" : "current-password";
  $("auth-submit").textContent = m === "signup" ? "Create free account" : "Sign in";
  showErr("auth-error");
}
$("tab-signup").onclick = () => setMode("signup");
$("tab-login").onclick = () => setMode("login");
/** Every sign-in path ends here: a session, a two-factor step, or a code to save first. */
function afterSignIn(data, codeTitle) {
  if (data.twoFactor) {
    ticket = data.ticket;
    const go = () => { $("t-code").value = ""; showErr("t-error"); show("twofa"); $("t-code").focus(); };
    if (data.recoveryCode) return showCode(data.recoveryCode, codeTitle || "Password changed — save your new recovery code", go);
    return go();
  }
  token = data.token; save(TOKEN_KEY, token); me = data.me;
  if (data.recoveryCode) return showCode(data.recoveryCode, codeTitle || "Save your recovery code", () => start());
  return start();
}
$("auth-form").onsubmit = async (e) => {
  e.preventDefault();
  showErr("auth-error");
  const body = { email: $("email").value, password: $("password").value };
  if (mode === "signup") body.company = $("company").value;
  $("auth-submit").disabled = true;
  const r = await call(mode === "signup" ? "/api/signup" : "/api/login", { method: "POST", body });
  $("auth-submit").disabled = false;
  if (!r.ok) { if (!r.data.off) showErr("auth-error", r.data.error || "That didn't work. Try again."); if (r.data.sso) { setMode("login"); $("sso-row").hidden = false; } return; }
  $("password").value = "";
  afterSignIn(r.data, "Save your recovery code");
};
$("twofa-form").onsubmit = async (e) => {
  e.preventDefault();
  showErr("t-error");
  $("t-submit").disabled = true;
  const r = await call("/api/login/2fa", { method: "POST", body: { ticket, code: $("t-code").value } });
  $("t-submit").disabled = false;
  if (!r.ok) { if (r.status === 410) { setMode("login"); show("auth"); showErr("auth-error", r.data.error); return; } return showErr("t-error", r.data.error || "That didn't work."); }
  ticket = null;
  if (r.data.usedBackup) alert(`You used a backup code. ${r.data.backupLeft} left — make new ones in Settings if you're running low.`);
  afterSignIn(r.data);
};
$("signout").onclick = async () => { await call("/api/logout", { method: "POST" }); token = null; me = null; save(TOKEN_KEY, null); location.hash = "#/"; setMode("login"); show("auth"); };

// ── Codes shown once (recovery code, backup codes) ─────────────────────────────────────────────────────────────
let afterCode = null;
function showCode(code, title, then, text) {
  $("code-title").textContent = title;
  $("code-text").innerHTML = text || "If you ever forget your password, this code lets you set a new one. <b>It's shown only now.</b> Keep it somewhere safe, like a password manager or a printed copy.";
  $("code-value").textContent = code;
  $("code-ok").checked = false; $("code-continue").disabled = true; $("code-copied").textContent = "";
  afterCode = then;
  show("code");
}
$("code-ok").onchange = () => { $("code-continue").disabled = !$("code-ok").checked; };
$("code-continue").onclick = () => { const f = afterCode; afterCode = null; $("code-value").textContent = ""; $("code").hidden = true; if (location.hash !== "#/" && !/^#\/account/.test(location.hash)) history.replaceState(null, "", "#/"); f?.(); };
$("code-copy").onclick = async () => { try { await navigator.clipboard.writeText($("code-value").textContent); $("code-copied").textContent = "Copied"; } catch { $("code-copied").textContent = "Select the code and copy it"; } };
$("code-save").onclick = () => download("forecasting-agent-codes.txt", `Forecasting Agent — ${$("code-title").textContent}\n\nAccount: ${me?.email || ""}\n${$("code-value").textContent}\n\nRecovery code: use it at ${location.origin}/#/forgot if you forget your password.\nBackup codes: use one instead of the 6-digit code if you don't have your phone. Each works once.\n`, "text/plain");

// ── Forgot password, reset link, invite ────────────────────────────────────────────────────────────────────────
$("forgot-form").onsubmit = async (e) => {
  e.preventDefault();
  showErr("f-error");
  $("f-submit").disabled = true;
  const r = await call("/api/recover", { method: "POST", body: { email: $("f-email").value, code: $("f-code").value, password: $("f-password").value } });
  $("f-submit").disabled = false;
  if (!r.ok) { if (!r.data.off) showErr("f-error", r.data.error || "That didn't work. Try again."); return; }
  $("f-code").value = ""; $("f-password").value = "";
  afterSignIn(r.data, "Password changed — save your new recovery code");
};
$("f-ask").onclick = async () => {
  showErr("f-error"); $("f-asked").hidden = true;
  const r = await call("/api/reset-request", { method: "POST", body: { email: $("f-email").value } });
  if (!r.ok) return showErr("f-error", r.data.error || "That didn't work. Try again.");
  $("f-asked").textContent = `Thanks — if there's an account for that email, we'll send you a reset link.${r.data.contact ? ` You can also contact: ${r.data.contact}` : ""}`;
  $("f-asked").hidden = false;
};
$("reset-form").onsubmit = async (e) => {
  e.preventDefault();
  showErr("r-error");
  if ($("r-password").value !== $("r-password2").value) return showErr("r-error", "The two passwords don't match.");
  $("r-submit").disabled = true;
  const r = await call("/api/reset", { method: "POST", body: { token: resetToken, password: $("r-password").value } });
  $("r-submit").disabled = false;
  if (!r.ok) { if (!r.data.off) showErr("r-error", r.data.error || "That didn't work. Try again."); return; }
  resetToken = null; $("r-password").value = ""; $("r-password2").value = "";
  afterSignIn(r.data, "Password changed — save your new recovery code");
};
async function showInvite() {
  const r = await call(`/api/invite?token=${inviteToken}`);
  if (!r.ok) { setMode("login"); show("auth"); showErr("auth-error", r.data.error); return; }
  const i = r.data;
  $("i-company").textContent = i.company;
  $("i-hint").textContent = `You're joining as ${i.role === "admin" ? "an admin" : `a ${i.role}`} with ${i.email}.${i.requireSso ? " Your company signs in with Microsoft or Google." : ""}`;
  $("i-name").value = i.name || "";
  $("invite-form").hidden = i.requireSso;
  const q = `?invite=${inviteToken}&email=${encodeURIComponent(i.email)}`;
  $("i-sso-ms").href = `/api/sso/microsoft/start${q}`; $("i-sso-google").href = `/api/sso/google/start${q}`;
  $("i-sso-ms").hidden = !i.sso.microsoft; $("i-sso-google").hidden = !i.sso.google;
  $("i-sso").hidden = !(i.sso.microsoft || i.sso.google);
  show("invite");
}
$("invite-form").onsubmit = async (e) => {
  e.preventDefault();
  showErr("i-error");
  const r = await call("/api/invite", { method: "POST", body: { token: inviteToken, name: $("i-name").value, password: $("i-password").value } });
  if (!r.ok) return showErr("i-error", r.data.error || "That didn't work.");
  inviteToken = null; $("i-password").value = "";
  afterSignIn(r.data, "Welcome — save your recovery code");
};

// ── Reading the spreadsheet ────────────────────────────────────────────────────────────────────────────────────
let xlsxReady = null;
const loadXLSX = () => (xlsxReady ||= new Promise((ok, fail) => {
  const s = document.createElement("script");
  s.src = "/vendor/xlsx.full.min.js";
  s.onload = () => ok(window.XLSX);
  s.onerror = () => fail(new Error("The Excel reader didn't load. Check your connection, or save the file as CSV."));
  document.head.appendChild(s);
}));
/** Text files are usually UTF-8; older Excel/Windows exports aren't — read those as Windows-1252 instead of showing "�". */
function decodeText(buf) {
  try { return new TextDecoder("utf-8", { fatal: true }).decode(buf); }
  catch { return new TextDecoder("windows-1252").decode(buf); }
}
async function readFile(file) {
  if (file.size > 40 * 1024 * 1024) throw new Error("That file is over 40 MB. Save just the columns you need and try again, or connect the system directly.");
  if (/\.(xlsx|xls)$/i.test(file.name)) {
    const XLSX = await loadXLSX();
    const wb = XLSX.read(await file.arrayBuffer(), { type: "array", cellDates: true });
    const best = wb.SheetNames.map((n) => XLSX.utils.sheet_to_json(wb.Sheets[n], { header: 1, raw: true, defval: "" })).sort((a, b) => b.length - a.length)[0] || [];
    return best.filter((r) => r.some((v) => String(v).trim() !== ""));
  }
  return parseCSV(decodeText(await file.arrayBuffer()));
}
function headerAndBody(rows) {
  let header = rows[0].map((h, i) => String(h ?? "").trim() || `Column ${i + 1}`);
  let body = rows.slice(1);
  if (rows[0].some((v) => v instanceof Date || /^\d{1,4}[-/.]\d{1,2}[-/.]\d{1,4}/.test(String(v)))) { header = rows[0].map((_, i) => `Column ${i + 1}`); body = rows; }
  const width = Math.max(...rows.slice(0, 50).map((r) => r.length));
  while (header.length < width) header.push(`Column ${header.length + 1}`);
  return { header, body };
}

function useRows(name, rows) {
  showErr("file-error");
  if (rows.length < 2) { showErr("file-error", "That file has no rows of sales in it."); return; }
  const { header, body } = headerAndBody(rows);
  sheet = { name, header, rows: body };
  const det = detectColumns(header, body);
  const extra = detectExtra(header, [det.date, det.product, det.value]);
  const opts = (sel, none) => { sel.innerHTML = (none ? `<option value="-1">${none}</option>` : "") + header.map((h, i) => `<option value="${i}">${esc(h)}</option>`).join(""); };
  opts($("col-date")); opts($("col-product"), "No product column (total sales only)"); opts($("col-value"));
  opts($("col-units"), "None"); opts($("col-location"), "None"); opts($("col-region"), "None");
  $("col-date").value = String(det.date); $("col-product").value = String(det.product); $("col-value").value = String(det.value);
  $("col-units").value = String(det.kind === "money" ? extra.units : -1);
  $("col-location").value = String(me.features.multiLocation ? extra.location : -1); $("col-region").value = String(me.features.multiLocation ? extra.region : -1);
  $("col-location").disabled = $("col-region").disabled = !me.features.multiLocation;
  $("kind").value = det.kind;
  $("upload-name").value = name.replace(/\.[^.]+$/, "").slice(0, 120);
  $("map-file").textContent = `${name} — ${body.length.toLocaleString("en-US")} rows. We've guessed the columns; change them if they're wrong.${me.features.multiLocation ? "" : " (Forecasts by store and region aren't switched on for your company.)"}`;
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
/** Rows → monthly series per product × store × region, with a sales amount and/or quantity per month. */
function monthly() {
  const order = $("order").dataset.auto || $("order").value;
  if (!order) return { error: "Your dates could be day/month or month/day. Choose how they're written." };
  const c = { date: +$("col-date").value, product: +$("col-product").value, value: +$("col-value").value, units: +$("col-units").value, location: +$("col-location").value, region: +$("col-region").value };
  const valueIsUnits = $("kind").value === "units";
  const groups = new Map(), seen = new Set();
  let used = 0, skipped = 0;
  for (const r of sheet.rows) {
    const ym = toYearMonth(r[c.date], order === "ymd" ? "dmy" : order);
    const v = parseNumber(r[c.value]);
    const u = c.units >= 0 ? parseNumber(r[c.units]) : null;
    if (!ym || (v === null && u === null)) { skipped++; continue; }
    const p = c.product >= 0 ? String(r[c.product] ?? "").trim() || "(no name)" : "All sales";
    const l = c.location >= 0 ? String(r[c.location] ?? "").trim() : "", g = c.region >= 0 ? String(r[c.region] ?? "").trim() : "";
    const k = `${p}\u0001${l}\u0001${g}`;
    let e = groups.get(k);
    if (!e) groups.set(k, (e = { product: p, location: l, region: g, amount: new Map(), units: new Map() }));
    if (v !== null) (valueIsUnits ? e.units : e.amount).set(ym, ((valueIsUnits ? e.units : e.amount).get(ym) || 0) + v);
    if (u !== null && !valueIsUnits) e.units.set(ym, (e.units.get(ym) || 0) + u);
    seen.add(ym); used++;
  }
  if (!seen.size) return { error: "No dates and amounts could be read with these columns. Check the choices above." };
  const sorted = [...seen].sort();
  let months = [];
  for (let cur = sorted[0]; cur <= sorted[sorted.length - 1]; ) { months.push(cur); const [y, mo] = cur.split("-").map(Number); cur = mo === 12 ? `${y + 1}-01` : `${y}-${String(mo + 1).padStart(2, "0")}`; }
  const allMonths = months.length, firstAll = months[0];
  if (months.length > MAX_MONTHS) months = months.slice(-MAX_MONTHS); // the latest 10 years are plenty
  const hasAmount = [...groups.values()].some((e) => e.amount.size), hasUnits = [...groups.values()].some((e) => e.units.size);
  const r2 = (x) => Math.round(x * 100) / 100;
  const series = [...groups.values()].map((e) => ({
    product: e.product, location: e.location, region: e.region,
    ...(hasAmount ? { amount: months.map((m) => r2(e.amount.get(m) || 0)) } : {}),
    ...(hasUnits ? { units: months.map((m) => r2(e.units.get(m) || 0)) } : {}),
  })).filter((s) => sum(s.amount || []) !== 0 || sum(s.units || []) !== 0);
  return { months, series, used, skipped, allMonths: allMonths > MAX_MONTHS ? allMonths : 0, firstAll, hasAmount, hasUnits,
    products: new Set(series.map((s) => s.product)).size, locations: new Set(series.map((s) => s.location).filter(Boolean)).size, regions: new Set(series.map((s) => s.region).filter(Boolean)).size };
}
function preview() {
  showErr("map-error");
  const m = monthly();
  if (m.error) { $("preview").textContent = ""; showErr("map-error", m.error); $("run").disabled = true; return; }
  const n = m.months.length;
  const range = m.allMonths ? `${m.allMonths} months</b> (${monthLabel(m.firstAll)} to ${monthLabel(m.months[n - 1])})` : `${n} months</b> (${monthLabel(m.months[0])} to ${monthLabel(m.months[n - 1])})`;
  let msg = `Found <b>${range}, <b>${m.products} product${m.products === 1 ? "" : "s"}</b>`;
  if (m.locations) msg += `, <b>${m.locations} store${m.locations === 1 ? "" : "s"}/warehouses</b>`;
  if (m.regions) msg += `, <b>${m.regions} region${m.regions === 1 ? "" : "s"}</b>`;
  msg += `, ${m.used.toLocaleString("en-US")} rows used`;
  if (m.skipped) msg += `, <b>${m.skipped.toLocaleString("en-US")} rows skipped</b> (no readable date or amount)`;
  msg += ".";
  if (m.allMonths) msg += ` We'll use your latest <b>${MAX_MONTHS} months</b> (${monthLabel(m.months[0])} to ${monthLabel(m.months[n - 1])}) — that's plenty; older years make little difference to the result.`;
  if (m.hasAmount && m.hasUnits) msg += " Sales and quantities are both forecast (quantities drive reorder suggestions).";
  if (n < 9) msg += ` <span class="warn">The accuracy test needs at least 9 months${n >= 6 ? "; a forecast is still possible" : " and a forecast needs 6"}.</span>`;
  $("preview").innerHTML = msg;
  $("run").disabled = n < 6;
}
for (const id of ["col-product", "col-value", "col-units", "col-location", "col-region", "order", "kind"]) $(id).onchange = preview;
$("col-date").onchange = () => { checkOrder(); preview(); };
$("file").onchange = async () => {
  const f = $("file").files[0];
  if (!f) return;
  try { useRows(f.name, await readFile(f)); } catch (err) { showErr("file-error", err.message || "That file couldn't be read."); }
  $("file").value = "";
};
$("sample").onclick = async () => {
  $("sample").disabled = true;
  try {
    useRows("Sample sales (drinks & snacks).csv", parseCSV(await (await fetch("/sample-sales.csv")).text()));
    if (!$("run").disabled) await runTest(); // the sample's columns are known: straight to the result, one tap
  } catch { showErr("file-error", "The sample didn't load. Try again."); }
  $("sample").disabled = false;
};
$("run").onclick = () => runTest();
async function runTest() {
  const m = monthly();
  if (m.error) return showErr("map-error", m.error);
  const name = $("upload-name").value;
  $("run").disabled = true; $("run").textContent = "Sending…";
  let r;
  if (m.series.length <= BATCH) {
    r = await call("/api/uploads", { method: "POST", body: { name, months: m.months, series: m.series } });
  } else {
    // Big files go in parts, then the server works through them in the background.
    r = await call("/api/uploads", { method: "POST", body: { name, months: m.months, series: m.series.slice(0, BATCH), final: false } });
    for (let i = BATCH; r.ok && i < m.series.length; i += BATCH) {
      $("run").textContent = `Sending… ${Math.round((100 * i) / m.series.length)}%`;
      const part = await call(`/api/uploads/${r.data.upload.id}/series`, { method: "POST", body: { name, months: m.months, series: m.series.slice(i, i + BATCH) } });
      if (!part.ok) r = part;
    }
    if (r.ok) r = await call(`/api/uploads/${r.data.upload.id}/finish`, { method: "POST" });
  }
  $("run").disabled = false; $("run").textContent = "Run the free accuracy test";
  if (!r.ok) return showErr("map-error", r.data.error || "That didn't work. Try again.");
  $("map").hidden = true; sheet = null;
  location.hash = `#/u/${r.data.upload.id}`;
}

// ── Uploads list ───────────────────────────────────────────────────────────────────────────────────────────────
const SOURCE_WORDS = { file: "Uploaded file", api: "API", filedrop: "File drop", connection: "Connected system" };
async function renderHome() {
  show("home");
  $("upload-card").hidden = !can("manager");
  const r = await call("/api/uploads");
  if (!r.ok) return;
  const list = r.data.uploads;
  $("no-uploads").hidden = list.length > 0;
  $("uploads").innerHTML = list.map((u) => `<li><a href="#/u/${u.id}"><span class="u-name">${esc(u.name)}</span>
    <span class="u-meta">${SOURCE_WORDS[u.source] || "Data"} · ${u.months} months · ${u.products} product${u.products === 1 ? "" : "s"}${u.locations ? ` · ${u.locations} locations` : ""} · ${new Date(u.updated || u.created).toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric" })}</span>
    <span class="u-acc">${u.status === "processing" ? `Working… ${u.progress ?? 0}%` : u.status === "waiting" ? "Waiting for first sync" : u.status === "error" ? "Problem — open for details" : u.accuracy === null ? "—" : `${u.accuracy}% accurate`}${u.hasForecast ? " · forecast ready" : ""}</span></a></li>`).join("");
}

// ── One upload ─────────────────────────────────────────────────────────────────────────────────────────────────
async function renderUpload(id) {
  const r = await call(`/api/uploads/${id}`);
  if (!r.ok) { location.hash = "#/"; return; }
  current = r.data.upload;
  show("result");
  const u = current;
  $("r-name").textContent = u.name;
  const places = [u.locations ? `${u.locations} location${u.locations === 1 ? "" : "s"}` : "", u.regions ? `${u.regions} region${u.regions === 1 ? "" : "s"}` : ""].filter(Boolean).join(" · ");
  $("r-meta").textContent = u.months ? `${u.months} months of sales (${monthLabel(u.first)} to ${monthLabel(u.last)}) · ${u.products} product${u.products === 1 ? "" : "s"}${places ? ` · ${places}` : ""} · ${u.kind === "units" ? "quantities" : "dollar sales"}${u.measures.length > 1 ? " and quantities" : ""}` : "No data yet.";
  $("r-delete").hidden = !can("manager");
  const busy = u.status === "processing" || u.status === "waiting";
  $("r-status").hidden = !busy && u.status !== "error";
  $("r-status").textContent = u.status === "error" ? `Problem: ${u.error || "something went wrong."}` : u.status === "waiting" ? "Waiting for the first sync from the connected system." : `Working through ${u.series.toLocaleString("en-US")} product × location combinations… ${u.progress ?? 0}%`;
  if (busy) { clearTimeout(pollTimer); pollTimer = setTimeout(() => { if (location.hash === `#/u/${id}`) renderUpload(id); }, 2000); }
  renderBacktest(u.backtest);
  showErr("fc-error");
  $("fc-locked").hidden = true;
  if (u.forecast) renderForecast(u.forecast, u.forecastAt);
  else {
    $("fc").hidden = true;
    $("fc-ask").hidden = !me.features.forecasts || !can("manager");
    if (!me.features.forecasts) showLocked();
    else if (!can("manager")) showErr("fc-error", "No forecast yet — ask a manager or admin to make one.");
  }
}

function dims(v) { return ["products", "locations", "regions"].filter((d) => (v[d] || []).length > (d === "products" ? 0 : 1)); }
function renderBacktest(bt) {
  $("bt-none").hidden = bt.ok; $("bt").hidden = !bt.ok;
  if (!bt.ok) { $("bt-none").textContent = bt.reason; return; }
  const k = bt.kind;
  $("bt-acc").textContent = bt.accuracy === null ? "—" : `${bt.accuracy}%`;
  $("bt-months").textContent = `Hidden months: ${bt.months.map(monthLabel).join(", ")}`;
  $("bt-summary").innerHTML = bt.summary.map((s) => `<li>${esc(s)}</li>`).join("");
  const hm = bt.history.months, h = bt.history.total;
  lineChart($("bt-chart"), {
    labels: [...hm, ...bt.months].map(monthLabel), kind: k, format: (v) => fmt(v, k), caption: "Actual sales and the backtest's predictions for the hidden 3 months",
    series: [
      { name: "Actual", color: 1, values: [...h, ...bt.total.actual] },
      { name: "Predicted (hidden months)", color: 2, dashed: true, values: [...h.map((_, i) => (i === h.length - 1 ? h[i] : null)), ...bt.total.predicted] },
    ],
  });
  const ds = dims(bt);
  $("bt-by-row").hidden = ds.length < 2;
  $("bt-by").innerHTML = ds.map((d) => `<option value="${d}">${DIM_WORDS[d][0]}</option>`).join("");
  const table = () => {
    const d = $("bt-by").value || "products";
    const head = `<thead><tr><th>${DIM_WORDS[d][0]}</th>${bt.months.map((m) => `<th colspan="2">${monthLabel(m)}</th>`).join("")}<th>Accuracy</th></tr>
      <tr class="sub"><th></th>${bt.months.map(() => "<th>Predicted</th><th>Actual</th>").join("")}<th></th></tr></thead>`;
    const row = (name, p, a, acc, cls = "") => `<tr class="${cls}"><th scope="row">${esc(name)}</th>${p.map((v, i) => `<td>${fmt(v, k)}</td><td>${fmt(a[i], k)}</td>`).join("")}<td>${acc === null || acc === undefined ? "—" : `${acc}%`}</td></tr>`;
    $("bt-table").innerHTML = head + "<tbody>" + (bt[d] || []).map((p) => row(p.name, p.predicted, p.actual, p.accuracy)).join("") + row("Total", bt.total.predicted, bt.total.actual, bt.accuracy, "total") + "</tbody>";
  };
  $("bt-by").onchange = table;
  table();
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
  if (r.data.processing) { $("fc-ask").hidden = true; return renderUpload(current.id); }
  current.forecast = r.data.forecast;
  renderForecast(r.data.forecast, new Date().toISOString());
};

let fcState = null;
function renderForecast(primary, at) {
  $("fc-ask").hidden = true; $("fc-locked").hidden = true;
  if (!primary.ok) { showErr("fc-error", primary.reason); $("fc").hidden = true; return; }
  $("fc").hidden = false;
  const measures = [{ key: "primary", label: primary.kind === "units" ? "Quantity" : "Sales ($)", fc: primary }];
  if (current.alt?.forecast?.ok) measures.push({ key: "alt", label: current.alt.measure === "units" ? "Quantity" : "Sales ($)", fc: current.alt.forecast });
  $("fc-measure-row").hidden = measures.length < 2;
  $("fc-measure").innerHTML = measures.map((m) => `<option value="${m.key}">${m.label}</option>`).join("");
  fcState = { measures, at };
  $("fc-measure").onchange = () => drawForecastAll();
  drawForecastAll();
}
function fcNow() { return fcState.measures.find((m) => m.key === ($("fc-measure").value || "primary"))?.fc || fcState.measures[0].fc; }
function drawForecastAll() {
  const fc = fcNow(), k = fc.kind;
  $("fc-summary").innerHTML = fc.summary.map((s) => `<li>${esc(s)}</li>`).join("");
  const ds = dims(fc);
  $("fc-by-row").hidden = ds.length < 2;
  const keep = $("fc-by").value;
  $("fc-by").innerHTML = ds.map((d) => `<option value="${d}">${DIM_WORDS[d][0]}</option>`).join("");
  if (ds.includes(keep)) $("fc-by").value = keep;
  const fillPick = () => {
    const d = $("fc-by").value || "products";
    $("fc-pick").innerHTML = `<option value="">All ${DIM_WORDS[d][1]} (total)</option>` + (fc[d] || []).map((p, i) => `<option value="${i}">${esc(p.name)}</option>`).join("");
    $("fc-table-title").textContent = `By ${DIM_WORDS[d][0].toLowerCase()}`;
    drawTable(d);
    drawForecast();
  };
  $("fc-by").onchange = fillPick;
  $("fc-pick").onchange = () => drawForecast();
  fillPick();
  $("fc-when").textContent = fcState.at ? `Made ${when(fcState.at)}${current.forecastStale ? " — the data has changed since; make a new one" : ""}` : "";
  function drawTable(d) {
    const unit = k === "units" ? " (units)" : "";
    const row = (name, last3, f, next3, method, cls = "") => {
      const ch = last3 > 0 ? Math.round(((next3 - last3) / last3) * 100) : null;
      return `<tr class="${cls}"><th scope="row">${esc(name)}</th><td>${fmt(last3, k)}</td>${f.map((v) => `<td>${fmt(v, k)}</td>`).join("")}<td><b>${fmt(next3, k)}</b></td>
        <td class="${ch > 0 ? "up" : ch < 0 ? "down" : ""}">${ch === null ? "—" : `${ch > 0 ? "▲" : ch < 0 ? "▼" : ""} ${Math.abs(ch)}%`}</td><td class="method">${method}</td></tr>`;
    };
    $("fc-table").innerHTML = `<thead><tr><th>${DIM_WORDS[d][0]}${unit}</th><th>Last 3 months</th>${fc.months.map((m) => `<th>${monthLabel(m)}</th>`).join("")}<th>Next 3 months</th><th>Change</th><th>How</th></tr></thead><tbody>` +
      (fc[d] || []).map((p) => row(p.name, p.last3, p.forecast, p.next3, METHOD_WORDS[p.method] || p.method)).join("") +
      row("Total", sum(fc.total.history.slice(-3)), fc.total.forecast, sum(fc.total.forecast), "", "total") + "</tbody>";
  }
}
async function drawForecast() {
  const fc = fcNow(), k = fc.kind, d = $("fc-by").value || "products", pick = $("fc-pick").value;
  const p = pick === "" ? null : fc[d][+pick];
  const hist = (p ? p.history : fc.total.history).slice(-24), f = p ? p.forecast : fc.total.forecast;
  const hm = fc.historyMonths.slice(-24);
  lineChart($("fc-chart"), {
    labels: [...hm, ...fc.months].map(monthLabel), kind: k, format: (v) => fmt(v, k), caption: `${p ? p.name : "Total sales"}: actual and next 3 months`,
    series: [
      { name: `Actual${p ? ` — ${p.name}` : ""}`, color: 1, values: [...hist, null, null, null] },
      { name: "Forecast", color: 2, dashed: true, values: [...hist.map((_, i) => (i === hist.length - 1 ? hist[i] : null)), ...f] },
    ],
  });
  // One product (or store/region) picked, with locations: its forecast at each location.
  $("fc-drill").hidden = true;
  if (p && !/^Other \(/.test(p.name) && (current.locations > 0 || current.regions > 0)) {
    const key = d === "products" ? "product" : d === "locations" ? "location" : "region";
    const measure = $("fc-measure").value === "alt" ? current.alt.measure : current.primary;
    const r = await call(`/api/uploads/${current.id}/drill?${key}=${encodeURIComponent(p.name)}&measure=${measure}`);
    if (!r.ok || !r.data.rows.length || $("fc-pick").value !== pick) return;
    const other = key === "product" ? ["location", "region"] : ["product", key === "location" ? "region" : "location"];
    $("fc-drill-title").textContent = `${p.name}: by ${key === "product" ? "store / warehouse" : "product"}`;
    $("fc-drill-table").innerHTML = `<thead><tr><th>${key === "product" ? "Store / warehouse" : "Product"}</th><th>${key === "product" ? "Region" : key === "location" ? "Region" : "Store"}</th><th>Last 3 months</th>${fc.months.map((m) => `<th>${monthLabel(m)}</th>`).join("")}<th>Next 3 months</th></tr></thead><tbody>` +
      r.data.rows.sort((a, b) => (b.next3 || 0) - (a.next3 || 0)).map((x) => `<tr><th scope="row">${esc(x[other[0]] || "—")}</th><td>${esc(x[other[1]] || "—")}</td><td>${fmt(x.last3, k)}</td>${(x.forecast || [0, 0, 0]).map((v) => `<td>${fmt(v, k)}</td>`).join("")}<td><b>${fmt(x.next3 || 0, k)}</b></td></tr>`).join("") + "</tbody>";
    $("fc-drill").hidden = false;
  }
}
$("fc-csv").onclick = () => {
  const fc = fcNow(), d = $("fc-by").value || "products";
  if (!fc?.ok) return;
  const lines = [csvRow([DIM_WORDS[d][0] === "Product" ? "Product" : DIM_WORDS[d][0], ...fc.months.map(monthLabel), "Next 3 months", "Last 3 months"])];
  for (const p of fc[d] || []) lines.push(csvRow([p.name, ...p.forecast, p.next3, p.last3]));
  lines.push(csvRow(["Total", ...fc.total.forecast, Math.round(sum(fc.total.forecast) * 100) / 100, Math.round(sum(fc.total.history.slice(-3)) * 100) / 100]));
  download(`forecast-${current.name.replace(/[^\w-]+/g, "-").slice(0, 40)}.csv`, lines.join("\n") + "\n");
};
$("r-delete").onclick = async () => {
  if (!confirm(`Delete "${current.name}"? Its accuracy test and forecast go too.`)) return;
  await call(`/api/uploads/${current.id}`, { method: "DELETE" });
  location.hash = "#/";
};

// ── Stock & reorder ────────────────────────────────────────────────────────────────────────────────────────────
let reorderData = null;
async function renderStock() {
  show("stock");
  const [ro, st, up] = await Promise.all([call("/api/reorder"), call("/api/stock"), call("/api/uploads")]);
  if (ro.status === 402) { $("ro-none").hidden = false; $("ro-none").textContent = ro.data.error; return; }
  reorderData = ro.data;
  const v = ro.data;
  $("ro-none").hidden = v.ok; $("ro-none").textContent = v.ok ? "" : v.reason;
  $("ro-when").textContent = v.pending ? "Updating…" : v.updatedAt ? `Updated ${when(v.updatedAt)}` : "";
  const tile = (n, l) => `<div class="tile"><div class="tile-num">${n}</div><div class="tile-label">${l}</div></div>`;
  $("ro-tiles").innerHTML = v.ok ? tile(v.counts.out, "Out of stock") + tile(v.counts.low, "To reorder") + tile(v.counts.ok, "OK") + tile(v.orderValue ? fmt(v.orderValue, "money") : "—", "Suggested order value") : "";
  drawReorder();
  if (st.ok) {
    $("stock-count").textContent = `${st.data.total.toLocaleString("en-US")} stock item${st.data.total === 1 ? "" : "s"} on file.`;
    const s = st.data.settings;
    $("st-service").value = String(s.serviceLevel); $("st-review").value = s.reviewDays; $("st-lead").value = s.leadDays;
    const ups = up.ok ? up.data.uploads : [];
    $("st-main").innerHTML = `<option value="">Automatic (newest connected or uploaded data)</option>` + ups.map((u) => `<option value="${u.id}">${esc(u.name)}${u.measures.includes("units") ? "" : " (no quantities)"}</option>`).join("");
    $("st-main").value = s.mainUpload || "";
  }
  if (v.pending) { clearTimeout(pollTimer); pollTimer = setTimeout(() => { if (location.hash === "#/stock") renderStock(); }, 2500); }
}
const STATUS_WORDS = { out: "Out of stock", low: "Reorder", ok: "OK", nodata: "No sales data" };
function drawReorder() {
  const v = reorderData;
  if (!v?.ok) { $("ro-table").innerHTML = ""; return; }
  const items = $("ro-filter").value === "all" ? v.items : v.items.filter((x) => x.status === "out" || x.status === "low");
  $("ro-table").innerHTML = `<thead><tr><th>Item</th><th>Store / warehouse</th><th>Status</th><th>On hand</th><th>On order</th><th>Per day</th><th>Days left</th><th>Reorder point</th><th>Suggested order</th><th>Order value</th></tr></thead><tbody>` +
    (items.length ? items.slice(0, 1000).map((x) => `<tr><th scope="row">${esc(x.product)}</th><td>${esc(x.location || "—")}</td><td><span class="pill ${x.status === "ok" ? "on" : x.status === "nodata" ? "" : "off"}">${STATUS_WORDS[x.status]}</span></td>
      <td>${x.onHand}</td><td>${x.onOrder || 0}</td><td>${x.dailyDemand ?? "—"}</td><td>${x.daysOfCover ?? "—"}</td><td>${x.reorderPoint ?? "—"}</td><td><b>${x.suggestedQty ?? 0}</b></td><td>${x.orderValue ? fmt(x.orderValue, "money") : "—"}</td></tr>`).join("")
      : `<tr><td colspan="10" class="hint">Nothing needs ordering right now.</td></tr>`) + "</tbody>";
}
$("ro-filter").onchange = drawReorder;
$("ro-csv").onclick = () => {
  if (!reorderData?.ok) return;
  const lines = [csvRow(["Item", "Store/warehouse", "Status", "On hand", "On order", "Daily demand", "Days of cover", "Safety stock", "Reorder point", "Order up to", "Suggested order", "Order value"])];
  for (const x of reorderData.items) lines.push(csvRow([x.product, x.location, STATUS_WORDS[x.status], x.onHand, x.onOrder || 0, x.dailyDemand ?? "", x.daysOfCover ?? "", x.safetyStock ?? "", x.reorderPoint ?? "", x.orderUpTo ?? "", x.suggestedQty ?? 0, x.orderValue ?? ""]));
  download("reorder-suggestions.csv", lines.join("\n") + "\n");
};
$("stock-file").onchange = async () => {
  const f = $("stock-file").files[0];
  $("stock-file").value = "";
  showErr("stock-error"); $("stock-ok").hidden = true;
  if (!f) return;
  try {
    const rows = await readFile(f);
    const { header, body } = headerAndBody(rows);
    const h = header.map((x) => x.toLowerCase());
    const col = (re) => h.findIndex((x) => re.test(x));
    const c = { product: col(/product|item|sku|description|name/), location: col(/store|location|warehouse|branch|site|outlet/), onHand: col(/on ?hand|stock|available|qty|quantity|inventory/),
      onOrder: col(/on ?order|incoming|open po/), leadDays: col(/lead/), casePack: col(/case|pack/), minOrder: col(/min/), unitCost: col(/cost|price/) };
    if (c.product < 0 || c.onHand < 0) throw new Error("The file needs a product column and an on-hand column.");
    const items = body.map((r) => {
      const it = { product: String(r[c.product] ?? "").trim(), location: c.location >= 0 ? String(r[c.location] ?? "").trim() : "" };
      for (const k of ["onHand", "onOrder", "leadDays", "casePack", "minOrder", "unitCost"]) if (c[k] >= 0) { const n = parseNumber(r[c[k]]); if (n !== null) it[k] = n; }
      return it;
    }).filter((it) => it.product);
    const r = await call("/api/stock", { method: "POST", body: { items, replace: $("stock-replace").checked } });
    if (!r.ok) throw new Error(r.data.error || "That didn't work.");
    $("stock-ok").textContent = `${r.data.items.toLocaleString("en-US")} items saved. Reorder suggestions are updating.`; $("stock-ok").hidden = false;
    renderStock();
  } catch (e) { showErr("stock-error", e.message); }
};
$("st-save").onclick = async () => {
  const r = await call("/api/stock/settings", { method: "POST", body: { serviceLevel: +$("st-service").value, reviewDays: +$("st-review").value, leadDays: +$("st-lead").value, mainUpload: $("st-main").value || null } });
  $("st-saved").textContent = r.ok ? "Saved — updating suggestions" : "Didn't save";
  setTimeout(() => ($("st-saved").textContent = ""), 2500);
  if (r.ok) renderStock();
};

// ── Connections and API keys ───────────────────────────────────────────────────────────────────────────────────
let connData = null;
const STATUS_PILL = { ok: ["on", "Working"], error: ["off", "Problem"], syncing: ["", "Syncing…"], new: ["", "Not synced yet"], "needs-auth": ["off", "Needs sign-in"] };
async function renderConnections() {
  show("connections");
  const q = new URLSearchParams(location.hash.split("?")[1] || "");
  $("qb-msg").hidden = !q.get("qb");
  $("qb-msg").textContent = { connected: "QuickBooks is connected. The first sync has started.", cancelled: "QuickBooks access wasn't approved.", failed: "QuickBooks didn't finish connecting. Try again.", expired: "That took too long. Try again." }[q.get("qb")] || "";
  const r = await call("/api/connections");
  if (!r.ok) { $("conn-list").innerHTML = `<p class="notice">${esc(r.data.error || "")}</p>`; return; }
  connData = r.data;
  $("conn-list").innerHTML = r.data.connections.length ? r.data.connections.map((c) => `<div class="cust" data-id="${c.id}">
      <div class="cust-head"><span class="cust-name">${esc(c.name)}</span><span class="pill ${STATUS_PILL[c.status]?.[0] || ""}">${STATUS_PILL[c.status]?.[1] || c.status}</span></div>
      <div class="cust-facts"><span>${esc(c.kindName)}</span><span>Last sync: ${when(c.lastSync)}</span><span>Last success: ${when(c.lastOk)}</span>${c.rows !== null && c.rows !== undefined ? `<span>${c.rows.toLocaleString("en-US")} sales lines</span>` : ""}<span>Next: ${c.nextRun ? when(new Date(c.nextRun).toISOString()) : "—"}</span></div>
      ${c.lastError ? `<p class="error">${esc(c.lastError)}</p>` : ""}
      <div class="pay-row">${c.status === "needs-auth" ? `<button class="primary small c-auth" type="button">Connect to QuickBooks</button>` : `<button class="secondary small c-test" type="button">Test connection</button><button class="secondary small c-sync" type="button">Sync now</button>`}
        ${c.upload ? `<a class="link" href="#/u/${c.upload}">See its forecast</a>` : ""}<button class="link danger c-del" type="button">Remove</button></div><p class="hint c-msg"></p></div>`).join("")
    : `<p class="hint">No systems connected yet.</p>`;
  if (!$("conn-kind").options.length) {
    $("conn-kind").innerHTML = r.data.kinds.map((k) => `<option value="${k.kind}">${esc(k.name)}</option>`).join("");
    drawConnFields();
  }
  drawKeys();
  if (r.data.connections.some((c) => c.status === "syncing")) { clearTimeout(pollTimer); pollTimer = setTimeout(() => { if (location.hash.startsWith("#/connections")) renderConnections(); }, 3000); }
}
function drawConnFields() {
  const k = connData.kinds.find((x) => x.kind === $("conn-kind").value);
  $("conn-help").textContent = k.help;
  $("conn-name").value = k.name;
  $("conn-fields").innerHTML = k.fields.map((f) => f.type === "checkbox"
    ? `<label class="check"><input type="checkbox" data-k="${f.k}"> ${esc(f.label)}</label>`
    : `<label>${esc(f.label)}<input data-k="${f.k}" ${f.secret ? 'type="password" autocomplete="off"' : 'autocomplete="off"'} spellcheck="false"></label>`).join("");
  $("conn-save").textContent = k.auth === "oauth" ? "Save and connect to QuickBooks" : "Save, test and sync";
  if (k.kind === "quickbooks" && !connData.quickbooksReady) $("conn-help").textContent += " (Not available yet: the platform owner hasn't set up the QuickBooks app.)";
}
$("conn-kind").onchange = drawConnFields;
$("conn-form").onsubmit = async (e) => {
  e.preventDefault();
  showErr("conn-error"); $("conn-ok").hidden = true;
  const creds = {};
  for (const el of $("conn-fields").querySelectorAll("[data-k]")) creds[el.dataset.k] = el.type === "checkbox" ? el.checked : el.value;
  $("conn-save").disabled = true;
  const r = await call("/api/connections", { method: "POST", body: { kind: $("conn-kind").value, name: $("conn-name").value, creds, historyMonths: +$("conn-history").value } });
  $("conn-save").disabled = false;
  if (!r.ok) return showErr("conn-error", r.data.error || "That didn't work.");
  for (const el of $("conn-fields").querySelectorAll("input:not([type=checkbox])")) el.value = "";
  if (r.data.connection.status === "needs-auth") return authorizeConn(r.data.connection.id);
  $("conn-ok").textContent = r.data.test?.ok ? `${r.data.test.message} The first sync has started.` : `Saved, but the test failed: ${r.data.test?.message || ""}`;
  $("conn-ok").hidden = false;
  renderConnections();
};
async function authorizeConn(id) {
  const r = await call(`/api/connections/${id}/authorize`);
  if (!r.ok) return showErr("conn-error", r.data.error);
  location.href = r.data.url;
}
$("conn-list").addEventListener("click", async (e) => {
  const card = e.target.closest(".cust"); if (!card) return;
  const id = card.dataset.id, msg = card.querySelector(".c-msg");
  if (e.target.classList.contains("c-test")) { msg.textContent = "Testing…"; const r = await call(`/api/connections/${id}/test`, { method: "POST" }); msg.textContent = r.data.message || r.data.error || ""; }
  if (e.target.classList.contains("c-sync")) { await call(`/api/connections/${id}/sync`, { method: "POST" }); renderConnections(); }
  if (e.target.classList.contains("c-auth")) authorizeConn(id);
  if (e.target.classList.contains("c-del") && confirm("Remove this connection? Its data stays until you delete it; nightly syncs stop.")) { await call(`/api/connections/${id}`, { method: "DELETE" }); renderConnections(); }
});
async function drawKeys() {
  const r = await call("/api/keys");
  if (!r.ok) return;
  $("keys-list").innerHTML = r.data.keys.length ? `<div class="table-wrap"><table><thead><tr><th>Name</th><th>Key</th><th>Permissions</th><th>Created</th><th>Last used</th><th></th></tr></thead><tbody>` +
    r.data.keys.map((k) => `<tr><th scope="row">${esc(k.name)}</th><td><code>${esc(k.prefix)}…</code></td><td>${k.scopes.join(", ")}</td><td>${when(k.created)}</td><td>${when(k.last_used)}</td><td>${k.revoked ? "Revoked" : `<button class="link danger k-del" data-p="${k.prefix}" type="button">Revoke</button>`}</td></tr>`).join("") + "</tbody></table></div>"
    : `<p class="hint">No API keys yet.</p>`;
}
$("keys-list").addEventListener("click", async (e) => {
  if (!e.target.classList.contains("k-del") || !confirm("Revoke this key? Anything using it stops working straight away.")) return;
  await call(`/api/keys/${e.target.dataset.p}`, { method: "DELETE" }); drawKeys();
});
$("key-form").onsubmit = async (e) => {
  e.preventDefault();
  showErr("key-error");
  const r = await call("/api/keys", { method: "POST", body: { name: $("key-name").value } });
  if (!r.ok) return showErr("key-error", r.data.error);
  $("key-name").value = "";
  $("key-new").hidden = false;
  $("key-new").innerHTML = `<b>Copy this key now — it's shown only once.</b><input readonly value="${esc(r.data.key)}" class="reset-url" aria-label="API key"><button class="secondary small" type="button" id="key-copy">Copy</button>`;
  $("key-copy").onclick = async () => { try { await navigator.clipboard.writeText(r.data.key); $("key-copy").textContent = "Copied"; } catch { $("key-new").querySelector("input").select(); } };
  drawKeys();
};

// ── Team ───────────────────────────────────────────────────────────────────────────────────────────────────────
async function renderTeam() {
  show("team");
  const r = await call("/api/team");
  if (!r.ok) return showErr("team-error", r.data.error);
  $("team-table").innerHTML = `<thead><tr><th>Person</th><th>Role</th><th>Sign-in</th><th>Two-factor</th><th>Last sign-in</th><th></th></tr></thead><tbody>` + r.data.users.map((u) => `<tr data-id="${u.id}">
    <th scope="row">${esc(u.name || u.email)}${u.name ? `<br><span class="hint">${esc(u.email)}</span>` : ""}${u.off ? ' <span class="pill off">Off</span>' : ""}</th>
    <td><select class="t-role" ${u.id === me.user.id ? "disabled" : ""}>${["admin", "manager", "viewer"].map((x) => `<option value="${x}" ${x === u.role ? "selected" : ""}>${x[0].toUpperCase() + x.slice(1)}</option>`).join("")}</select></td>
    <td>${u.invited ? "Invited" : u.sso ? (u.sso === "microsoft" ? "Microsoft" : "Google") : "Password"}</td><td>${u.twoFactor ? "On" : u.sso ? "Via Microsoft/Google" : "Off"}</td><td>${when(u.lastLogin)}</td>
    <td class="actions">${u.id === me.user.id ? '<span class="hint">You</span>' : `${u.invited ? '<button class="link t-reinvite" type="button">New invite link</button>' : '<button class="link t-reset" type="button">Reset link</button>'}
      <button class="link t-off" type="button">${u.off ? "Switch on" : "Switch off"}</button> <button class="link danger t-del" type="button">Remove</button>`}</td></tr>`).join("") + "</tbody>";
}
function showLink(text, link) {
  $("team-link").hidden = false;
  $("team-link").innerHTML = `${text}<input readonly class="reset-url" value="${esc(link)}" aria-label="Link"><button class="secondary small" type="button" id="tl-copy">Copy link</button>`;
  $("tl-copy").onclick = async () => { try { await navigator.clipboard.writeText(link); $("tl-copy").textContent = "Copied"; } catch { $("team-link").querySelector("input").select(); } };
}
$("team-table").addEventListener("change", async (e) => {
  if (!e.target.classList.contains("t-role")) return;
  const id = e.target.closest("tr").dataset.id;
  const r = await call(`/api/team/${id}`, { method: "PATCH", body: { role: e.target.value } });
  if (!r.ok) showErr("team-error", r.data.error);
  renderTeam();
});
$("team-table").addEventListener("click", async (e) => {
  const tr = e.target.closest("tr"); if (!tr?.dataset.id) return;
  const id = tr.dataset.id; showErr("team-error");
  if (e.target.classList.contains("t-reset")) { const r = await call(`/api/team/${id}/reset`, { method: "POST" }); if (r.ok) showLink("<b>Send this password reset link to them.</b> It works once, for 24 hours.", r.data.link); }
  if (e.target.classList.contains("t-reinvite")) { const r = await call(`/api/team/${id}/reinvite`, { method: "POST" }); if (r.ok) showLink("<b>New invite link</b> (7 days):", r.data.link); }
  if (e.target.classList.contains("t-off")) { const r = await call(`/api/team/${id}`, { method: "PATCH", body: { off: e.target.textContent === "Switch off" } }); if (!r.ok) showErr("team-error", r.data.error); renderTeam(); }
  if (e.target.classList.contains("t-del") && confirm("Remove this person from your company?")) { const r = await call(`/api/team/${id}`, { method: "DELETE" }); if (!r.ok) showErr("team-error", r.data.error); renderTeam(); }
});
$("invite-new").onsubmit = async (e) => {
  e.preventDefault();
  showErr("team-error");
  const r = await call("/api/team", { method: "POST", body: { email: $("inv-email").value, name: $("inv-name").value, role: $("inv-role").value } });
  if (!r.ok) return showErr("team-error", r.data.error);
  $("inv-email").value = ""; $("inv-name").value = "";
  showLink(r.data.emailed ? "<b>Invite emailed.</b> You can also send this link (7 days):" : "<b>Send this invite link to them</b> (7 days):", r.data.link);
  renderTeam();
};

// ── Activity log ───────────────────────────────────────────────────────────────────────────────────────────────
let actRows = [];
async function renderActivity(more = false) {
  show("activity");
  const before = more && actRows.length ? actRows[actRows.length - 1].id : "";
  const r = await call(`/api/audit?limit=100${before ? `&before=${before}` : ""}`);
  if (!r.ok) return;
  actRows = more ? [...actRows, ...r.data.events] : r.data.events;
  $("act-table").innerHTML = `<thead><tr><th>When</th><th>Who</th><th>What</th><th>Details</th><th>From</th></tr></thead><tbody>` +
    actRows.map((a) => `<tr><td class="nowrap">${when(a.t)}</td><td>${esc(a.user)}</td><th scope="row">${esc(a.action)}</th><td class="wrap">${esc(a.detail)}</td><td>${esc(a.ip)}</td></tr>`).join("") + "</tbody>";
  $("act-more").hidden = r.data.events.length < 100;
}
$("act-more").onclick = () => renderActivity(true);
$("act-csv").onclick = () => download("activity-log.csv", [csvRow(["Time (UTC)", "Who", "What", "Details", "IP"]), ...actRows.map((a) => csvRow([a.t, a.user, a.action, a.detail, a.ip]))].join("\n") + "\n");

// ── Settings ───────────────────────────────────────────────────────────────────────────────────────────────────
async function renderAccount() {
  show("account");
  $("enroll-note").hidden = !me.mustEnroll2fa;
  $("tf-status").textContent = me.user.twoFactor ? "On. You'll be asked for a code from your authenticator app when you sign in." : me.user.sso ? "You sign in with Microsoft or Google, which handles this." : "Off. Turn it on to protect your account with a code from your phone.";
  $("tf-start").hidden = me.user.twoFactor || Boolean(me.user.sso);
  $("tf-off").hidden = !me.user.twoFactor || me.require2fa;
  $("tf-setup").hidden = true;
  $("pref-reports").checked = me.user.prefs.reports !== false; $("pref-low").checked = me.user.prefs.lowStock !== false;
  $("prefs-card").hidden = me.mustEnroll2fa;
  if (can("admin") && !me.mustEnroll2fa) {
    const s = await call("/api/settings");
    if (s.ok) {
      const x = s.data.settings;
      $("cs-2fa").checked = x.require2fa; $("cs-sso").checked = x.requireSso; $("cs-domains").value = x.ssoDomains;
      $("cs-sso-row").hidden = !x.features.sso;
      if (!$("cs-tz").options.length) {
        const zones = Intl.supportedValuesOf ? Intl.supportedValuesOf("timeZone") : ["UTC", "America/New_York", "America/Chicago", "America/Denver", "America/Los_Angeles", "Europe/London", "Europe/Paris", "Asia/Singapore", "Australia/Sydney"];
        $("cs-tz").innerHTML = ["UTC", ...zones.filter((z) => z !== "UTC")].map((z) => `<option>${z}</option>`).join("");
      }
      $("cs-tz").value = x.timezone;
    }
    if (me.features.reports) {
      if (!$("rp-hour").options.length) $("rp-hour").innerHTML = Array.from({ length: 24 }, (_, h) => `<option value="${h}">${String(h).padStart(2, "0")}:00</option>`).join("");
      const rp = await call("/api/reports");
      if (rp.ok) { $("rp-on").checked = rp.data.enabled; $("rp-day").value = String(rp.data.weekday); $("rp-hour").value = String(rp.data.hour); $("rp-msg").textContent = rp.data.nextRun ? `Next: ${when(new Date(rp.data.nextRun).toISOString())} (your company's time zone)` : ""; }
    }
  } else { $("company-card").hidden = true; $("report-card").hidden = true; }
}
let qrReady = null;
const loadQR = () => (qrReady ||= new Promise((ok) => { const s = document.createElement("script"); s.src = "/vendor/qrcode.js"; s.onload = () => ok(window.qrcode); s.onerror = () => ok(null); document.head.appendChild(s); }));
$("tf-start").onclick = async () => {
  const r = await call("/api/2fa/setup", { method: "POST" });
  if (!r.ok) return;
  $("tf-setup").hidden = false; $("tf-start").hidden = true;
  $("tf-secret").textContent = r.data.secret.match(/.{1,4}/g).join(" ");
  $("tf-uri").href = r.data.uri;
  const qrcode = await loadQR();
  if (qrcode) { const q = qrcode(0, "M"); q.addData(r.data.uri); q.make(); $("tf-qr").innerHTML = q.createSvgTag({ cellSize: 4, margin: 2, scalable: true, alt: "QR code for your authenticator app" }); }
  $("tf-code").focus();
};
$("tf-form").onsubmit = async (e) => {
  e.preventDefault();
  showErr("tf-error");
  const r = await call("/api/2fa/enable", { method: "POST", body: { code: $("tf-code").value } });
  if (!r.ok) return showErr("tf-error", r.data.error);
  $("tf-code").value = "";
  const fresh = await call("/api/me"); if (fresh.ok) me = fresh.data.me;
  showCode(r.data.backupCodes.join("\n"), "Two-factor is on — save your backup codes", () => { location.hash = "#/account"; route(); },
    "If you lose your phone, each of these codes lets you sign in once instead of the 6-digit code. <b>They're shown only now.</b> Keep them with your recovery code.");
};
$("tf-off").onsubmit = async (e) => {
  e.preventDefault();
  const r = await call("/api/2fa/disable", { method: "POST", body: { password: $("tf-off-pw").value } });
  $("tf-off-pw").value = "";
  if (!r.ok) return alert(r.data.error);
  const fresh = await call("/api/me"); if (fresh.ok) me = fresh.data.me;
  renderAccount();
};
$("pw-form").onsubmit = async (e) => {
  e.preventDefault();
  showErr("pw-error");
  const r = await call("/api/password", { method: "POST", body: { current: $("pw-current").value, password: $("pw-new").value } });
  if (!r.ok) return showErr("pw-error", r.data.error || "That didn't work. Try again.");
  $("pw-current").value = ""; $("pw-new").value = "";
  showCode(r.data.recoveryCode, "Password changed — save your new recovery code", () => { location.hash = "#/"; route(); });
};
$("rc-form").onsubmit = async (e) => {
  e.preventDefault();
  showErr("rc-error");
  const r = await call("/api/recovery-code", { method: "POST", body: { password: $("rc-password").value } });
  if (!r.ok) return showErr("rc-error", r.data.error || "That didn't work. Try again.");
  $("rc-password").value = "";
  showCode(r.data.recoveryCode, "Your new recovery code", () => { location.hash = "#/"; route(); });
};
for (const [id, k] of [["pref-reports", "reports"], ["pref-low", "lowStock"]]) $(id).onchange = async () => { const r = await call("/api/prefs", { method: "POST", body: { [k]: $(id).checked } }); if (r.ok) me.user.prefs = r.data.prefs; };
$("cs-save").onclick = async () => {
  const r = await call("/api/settings", { method: "POST", body: { require2fa: $("cs-2fa").checked, requireSso: $("cs-sso").checked, ssoDomains: $("cs-domains").value, timezone: $("cs-tz").value } });
  $("cs-msg").textContent = r.ok ? "Saved." : r.data.error;
  if (r.ok) { const fresh = await call("/api/me"); if (fresh.ok) me = fresh.data.me; renderAccount(); }
};
$("cs-signout").onclick = async () => { if (!confirm("Sign out everyone else in your company on every device?")) return; await call("/api/signout-everyone", { method: "POST" }); $("cs-msg").textContent = "Everyone else has been signed out."; };
$("rp-save").onclick = async () => {
  const r = await call("/api/reports", { method: "POST", body: { enabled: $("rp-on").checked, weekday: +$("rp-day").value, hour: +$("rp-hour").value } });
  $("rp-msg").textContent = r.ok ? (r.data.nextRun ? `Saved. Next: ${when(new Date(r.data.nextRun).toISOString())}` : "Saved. Weekly report is off.") : r.data.error;
};
$("rp-send").onclick = async () => { const r = await call("/api/reports/send", { method: "POST" }); $("rp-msg").textContent = r.ok ? "Sending now — check your inbox in a minute (and the Activity log)." : r.data.error; };

// ── Routing ────────────────────────────────────────────────────────────────────────────────────────────────────
/** Pages that work signed out (reset link, forgot password, invite, single sign-on return). True if one was shown. */
async function routeSignedOut() {
  const h = location.hash;
  let m;
  if ((m = /^#\/reset\/([0-9a-f]{64})$/.exec(h))) { resetToken = m[1]; history.replaceState(null, "", "#/reset"); }
  if (location.hash === "#/reset") {
    if (!resetToken) { setMode("login"); show("auth"); showErr("auth-error", "That reset link isn't complete. Open it again from the message you got."); return true; }
    show("reset"); return true;
  }
  if (location.hash === "#/forgot") { $("f-email").value ||= $("email").value; show("forgot"); return true; }
  if ((m = /^#\/invite\/([0-9a-f]{64})$/.exec(h))) { inviteToken = m[1]; history.replaceState(null, "", "#/invite"); }
  if (location.hash === "#/invite" && inviteToken) { await showInvite(); return true; }
  if ((m = /^#\/sso\/([0-9a-f]{48})$/.exec(h))) {
    history.replaceState(null, "", "#/");
    const r = await call("/api/sso/redeem", { method: "POST", body: { code: m[1] } });
    if (!r.ok) { setMode("login"); show("auth"); showErr("auth-error", r.data.error); return true; }
    afterSignIn(r.data); return true;
  }
  if (/^#\/login\?sso=/.test(h)) {
    const why = new URLSearchParams(h.split("?")[1]).get("sso");
    history.replaceState(null, "", "#/");
    setMode("login"); show("auth");
    showErr("auth-error", { unknown: "That Microsoft/Google account isn't part of any company here. Ask your admin to invite you.", unavailable: "Single sign-on isn't set up yet.", notEnabled: "Single sign-on isn't switched on for your company.", off: "This account is switched off.", userOff: "Your user has been switched off by your company's admin.", cancelled: "Sign-in was cancelled.", expired: "That sign-in took too long. Try again.", failed: "Sign-in didn't work. Try again." }[why] || "Sign-in didn't work.");
    return true;
  }
  return false;
}
async function route() {
  if (/^#\/(reset|forgot|invite|sso|login)/.test(location.hash) && await routeSignedOut()) return;
  if (!$("code").hidden) return; // a code is on screen: it stays until "Continue"
  if (!me) { if (location.hash === "#/" || location.hash === "") show("auth"); return; }
  if (me.mustEnroll2fa) { if (location.hash !== "#/account") history.replaceState(null, "", "#/account"); return renderAccount(); }
  const h = location.hash.split("?")[0];
  if (h === "#/account") return renderAccount();
  if (h === "#/stock" && me.features.inventory) return renderStock();
  if (h === "#/connections" && me.features.connectors && can("admin")) return renderConnections();
  if (h === "#/team" && can("admin")) return renderTeam();
  if (h === "#/activity" && can("admin")) return renderActivity();
  const m = /^#\/u\/([0-9a-f]{32})$/.exec(h);
  if (m) return renderUpload(m[1]);
  return renderHome();
}
window.addEventListener("hashchange", route);

async function start() {
  if (/^#\/(reset|forgot|invite|sso|login)/.test(location.hash) && await routeSignedOut()) return;
  if (!token) { show("auth"); return; }
  const r = await call("/api/me");
  if (!r.ok) { if (r.status !== 403) show("auth"); return; }
  me = r.data.me; contact = r.data.contact || "";
  $("who-name").textContent = `${me.company}${me.user.name ? ` · ${me.user.name}` : ""}`;
  route();
}
call("/api/sso/providers").then((r) => { if (r.ok) { ssoProviders = r.data; $("sso-ms").hidden = !r.data.microsoft; $("sso-google").hidden = !r.data.google; setMode(mode); } });
setMode(token ? "login" : "signup");
start();
