/**
 * The owner's private dashboard: every customer company, their uploads and accuracy, money collected, and the
 * on/off switches (whole account, and the 3-month forecast). Recording a payment switches the forecast on.
 */
import { lineChart } from "/chart.js";

const $ = (id) => document.getElementById(id);
const KEY = "forecast.owner";
const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
const monthLabel = (ym) => `${MONTHS[+ym.slice(5, 7) - 1]} ${ym.slice(0, 4)}`;
const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);
const money = (cents) => (cents / 100).toLocaleString("en-US", { style: "currency", currency: "USD" });
const fmt = (v, kind) => (kind === "units" ? `${Math.round(v).toLocaleString("en-US")}` : v.toLocaleString("en-US", { style: "currency", currency: "USD", maximumFractionDigits: Math.abs(v) >= 1000 ? 0 : 2 }));
const day = (iso) => (iso ? new Date(iso).toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric" }) : "—");
const BILL_PILL = { paid: "on", overdue: "off", cancelled: "warn", ended: "", none: "" };
const longDay = (s) => (s ? new Date(`${s}T00:00:00Z`).toLocaleDateString("en-US", { timeZone: "UTC", month: "short", day: "numeric", year: "numeric" }) : "—");
function billingBlock(c) {
  const b = c.billing, ag = b.agreement, today = new Date().toISOString().slice(0, 10);
  const canStart = !ag || b.status === "ended" || (ag.cancelledAt && ag.termEnd <= today);
  return `<div class="billing-box">
    <div class="cust-head"><b>Billing</b><span class="pill ${BILL_PILL[b.status] || ""}">${esc(b.statusWords)}</span></div>
    ${ag ? `<div class="cust-facts"><span>Plan: <b>${esc(ag.plan)}</b> (${ag.billing === "annual" ? "paid yearly upfront" : "$2,500 a month"})</span><span>Start: <b>${longDay(ag.start)}</b></span>
      <span>${ag.cancelledAt ? `Cancelled ${longDay(ag.cancelledAt)} — ends <b>${longDay(ag.termEnd)}</b>` : `Renews: <b>${longDay(ag.renewal)}</b>`}</span>
      <span>Paid: <b>${money(b.paidCents)}</b></span><span>Owed: <b>${money(b.owedCents)}</b>${b.overdueCents ? ` (<b class="error">${money(b.overdueCents)} overdue</b>)` : ""}</span>
      ${b.remainingTermCents ? `<span>Still to invoice this year: ${money(b.remainingTermCents)}</span>` : ""}${b.nextPayment ? `<span>Next payment: ${money(b.nextPayment.amountCents)} due ${longDay(b.nextPayment.date)}</span>` : ""}</div>` : `<p class="hint">No agreement yet.</p>`}
    ${b.invoices.length ? `<div class="table-wrap"><table class="inv-table"><thead><tr><th>Invoice</th><th>Period</th><th>Amount</th><th>Due</th><th>Status</th><th></th></tr></thead><tbody>${b.invoices.map((i) => `<tr data-inv="${i.id}"><th scope="row">${esc(i.number)}</th><td>${longDay(i.periodStart)} – ${longDay(i.periodEnd)}</td><td>${money(i.amountCents)}</td><td>${longDay(i.due)}</td>
      <td><span class="pill ${i.status === "paid" ? "on" : i.due < today ? "off" : ""}">${i.status === "paid" ? `Paid ${longDay(i.paidAt)}` : i.due < today ? "Overdue" : "Open"}</span>${i.sentCount ? ` <span class="hint">emailed ${i.sentCount}×</span>` : ' <span class="hint">not emailed</span>'}${i.reminders ? ` <span class="hint">${i.reminders} reminder${i.reminders === 1 ? "" : "s"}</span>` : ""}</td>
      <td class="actions">${i.status === "paid" ? '<button class="link inv-unpaid" type="button">Undo paid</button>' : '<button class="secondary small inv-paid" type="button">Mark paid</button>'} <button class="link inv-send" type="button">Send invoice</button> <button class="link inv-pdf" data-n="${esc(i.number)}" type="button">PDF</button></td></tr>`).join("")}</tbody></table></div>` : ""}
    <div class="pay-row">${canStart ? `<label class="inline">Start<input type="date" class="ag-start" value="${today}"></label><select class="ag-billing" aria-label="Payment option"><option value="annual">$30,000 upfront for the year</option><option value="monthly">$2,500 a month by invoice</option></select><button class="primary small ag-go" type="button">Start Draxly Enterprise</button>`
      : !ag.cancelledAt ? '<button class="link danger ag-cancel" type="button">Cancel agreement</button>' : ""}</div>
    <p class="hint bill-msg"></p></div>`;
}
const FEATURE_NAMES = { forecasts: "3-month forecasts", multiLocation: "By store & region", inventory: "Stock & reorder", reports: "Weekly email reports", connectors: "Direct connections", api: "API & file drop", sso: "Single sign-on" };
let features = Object.keys(FEATURE_NAMES), minContract = 3000000;
const openFeat = new Set();
let token = (() => { try { return sessionStorage.getItem(KEY); } catch { return null; } })();
let claimed = true;
const open = new Set(); // customers whose uploads are showing

async function call(path, { method = "GET", body } = {}) {
  const res = await fetch(path, { method, headers: { ...(body ? { "content-type": "application/json" } : {}), ...(token ? { Authorization: `Bearer ${token}` } : {}) }, body: body ? JSON.stringify(body) : undefined });
  const data = res.status === 204 ? {} : await res.json().catch(() => ({}));
  if (res.status === 401 && !/\/(login|claim)$/.test(path)) { setToken(null); gate(); }
  return { ok: res.ok, status: res.status, data };
}
function setToken(t) { token = t; try { t ? sessionStorage.setItem(KEY, t) : sessionStorage.removeItem(KEY); } catch { /* ignore */ } }
const show = (v) => { for (const id of ["o-loading", "o-gate", "o-dash"]) $(id).hidden = id !== v; $("o-who").hidden = v !== "o-dash"; };

async function gate() {
  claimed = (await call("/api/owner/state")).data.claimed;
  $("o-gate-title").textContent = claimed ? "Owner sign in" : "Set your owner passcode";
  $("o-gate-hint").textContent = claimed ? "" : "First visit: choose a passcode (at least 8 characters). Only you should know it — it opens this dashboard.";
  $("o-pass2-row").hidden = claimed;
  $("o-pass").autocomplete = claimed ? "current-password" : "new-password";
  $("o-submit").textContent = claimed ? "Sign in" : "Set passcode";
  show("o-gate");
}
$("o-form").onsubmit = async (e) => {
  e.preventDefault();
  const err = $("o-error"); err.hidden = true;
  const passcode = $("o-pass").value;
  if (!claimed && passcode !== $("o-pass2").value) { err.textContent = "The two passcodes don't match."; err.hidden = false; return; }
  const r = await call(claimed ? "/api/owner/login" : "/api/owner/claim", { method: "POST", body: { passcode } });
  if (!r.ok) { err.textContent = r.data.error || "That didn't work."; err.hidden = false; if (r.status === 409) gate(); return; }
  $("o-pass").value = ""; $("o-pass2").value = "";
  setToken(r.data.token);
  dash();
};
$("o-signout").onclick = async () => { await call("/api/owner/logout", { method: "POST" }); setToken(null); gate(); };

// ── Keeping the dashboard current ───────────────────────────────────────────────────────────────────────────────
// It refreshes itself every 30 seconds while open, when you come back to it, when you pull down, and with Refresh.
// It only redraws when something changed, and keeps what you typed, an open reset link and open forecasts.
let lastData = null, loading = null;
const typing = () => { const a = document.activeElement; return Boolean(a && $("o-dash").contains(a) && /^(INPUT|SELECT|TEXTAREA)$/.test(a.tagName) && a.type !== "checkbox"); };
const stamp = () => { $("o-updated").textContent = `Updated ${new Date().toLocaleTimeString("en-US", { hour: "numeric", minute: "2-digit", second: "2-digit" })}`; };

function dash(opts = {}) {
  // One refresh at a time; a refresh asked for meanwhile runs right after.
  if (loading) return (loading = loading.then(() => draw(opts)));
  return (loading = draw(opts).finally(() => { loading = null; }));
}

async function draw({ auto = false } = {}) {
  const r = await call("/api/owner/customers");
  if (!r.ok) return;
  const sig = JSON.stringify(r.data);
  const showing = !$("o-dash").hidden;
  if (showing && sig === lastData) { stamp(); return; }  // nothing changed: nothing moves
  if (showing && auto && typing()) return;               // you're typing: try again on the next round
  lastData = sig;
  if (!showing) { show("o-dash"); loadAlerts(); loadPlatform(); }
  loadDemo();
  stamp();
  // What's open or typed in each customer card, to put back after the redraw.
  const keep = new Map([...document.querySelectorAll("#o-customers .cust")].map((card) => [card.dataset.id, {
    amount: card.querySelector(".pay-amount")?.value || "", note: card.querySelector(".pay-note")?.value || "",
    reset: card.querySelector(".reset-host")?.innerHTML || "",
    views: [...card.querySelectorAll(".view-host:not([hidden])")].map((v) => v.dataset.for),
  }]));
  const { customers, totals, contact } = r.data;
  const tile = (n, l) => `<div class="tile"><div class="tile-num">${n}</div><div class="tile-label">${l}</div></div>`;
  $("o-tiles").innerHTML = tile(totals.customers, "Customers") + tile(totals.paying, "Paying") + tile(money(totals.collectedCents), "Money collected")
    + tile(totals.uploads, "Uploads") + tile(totals.avgAccuracy === null ? "—" : `${totals.avgAccuracy}%`, "Average backtest accuracy")
    + tile(money(totals.arrCents), "Annual contract value") + tile(totals.contracts, "Active contracts") + tile(totals.users, "Users")
    + tile(money(totals.agreementArrCents), `Draxly Enterprise (${totals.agreements} agreement${totals.agreements === 1 ? "" : "s"})`) + tile(money(totals.overdueCents), "Overdue") + tile(money(totals.owedCents), "Owed (invoiced, unpaid)")
    + tile(totals.failing ? `${totals.failing} failing` : totals.connections, totals.failing ? `of ${totals.connections} connections` : "Connections");
  features = r.data.features || features; minContract = r.data.minContractCents || minContract;
  if (document.activeElement !== $("o-contact")) $("o-contact").value = contact;
  $("o-none").hidden = customers.length > 0;
  const host = $("o-customers");
  host.innerHTML = customers.map((c) => `
    <div class="cust" data-id="${c.id}">
      <div class="cust-head"><span class="cust-name">${esc(c.company)}</span>
        <span>${c.resetRequested ? '<span class="pill off">Asked for a password reset</span> ' : ""}${c.off ? '<span class="pill off">Account off</span>' : '<span class="pill on">Account on</span>'} ${c.forecasts ? '<span class="pill on">Forecasts on</span>' : '<span class="pill">Backtest only</span>'}</span></div>
      <div class="cust-facts"><span>${esc(c.email)}</span><span>Joined ${day(c.created)}</span><span>Last seen ${day(c.lastSeen)}</span>
        <span>${c.uploads} upload${c.uploads === 1 ? "" : "s"}</span><span>Last backtest: ${c.lastAccuracy === null ? "—" : `<b>${c.lastAccuracy}%</b> accurate`}</span><span>Paid: <b>${money(c.paidCents)}</b></span></div>
      <div class="switches">
        <label class="switch"><input type="checkbox" class="sw-account" ${c.off ? "" : "checked"}> Account on</label>
        <label class="switch"><input type="checkbox" class="sw-forecasts" ${c.forecasts ? "checked" : ""}> 3-month forecasts on</label>
      </div>
      ${billingBlock(c)}
      <div class="ent">
        <div class="cust-facts"><span>Plan: <b>${esc(c.plan)}</b></span><span>Contract: <b>${c.contractCents ? `${money(c.contractCents)}/year` : "none"}</b>${c.contractStart || c.contractEnd ? ` (${c.contractStart || "?"} to ${c.contractEnd || "?"})` : ""}${c.contractCents && !c.contractActive ? ' <span class="pill off">Not active</span>' : ""}</span>
          <span>${c.users.length} user${c.users.length === 1 ? "" : "s"}</span><span>Two-factor required: ${c.require2fa ? "yes" : "no"}</span><span>Single sign-on required: ${c.requireSso ? "yes" : "no"}</span><span>Time zone: ${esc(c.timezone)}</span></div>
        <details class="sub"><summary>Contract</summary>
          <div class="pay-row"><input class="ct-plan note" maxlength="60" value="${esc(c.plan)}" aria-label="Plan name"><input class="ct-value" type="number" min="0" step="1000" placeholder="$ per year" value="${c.contractCents ? c.contractCents / 100 : ""}" aria-label="Yearly contract value"></div>
          <div class="pay-row"><label class="inline">Start<input class="ct-start" type="date" value="${esc(c.contractStart || "")}"></label><label class="inline">End<input class="ct-end" type="date" value="${esc(c.contractEnd || "")}"></label></div>
          <div class="pay-row"><input class="ct-note note" maxlength="300" placeholder="Note (PO number, contact…)" value="${esc(c.contractNote || "")}"><label class="check inline-check"><input type="checkbox" class="ct-all"> Switch every feature on</label><button class="primary small ct-save" type="button">Save contract</button></div>
          <p class="hint">Contracts start at ${money(minContract)} a year.</p>
        </details>
        <details class="sub" ${openFeat.has(c.id) ? "open" : ""}><summary>Features</summary><div class="switches">${features.map((f) => `<label class="switch"><input type="checkbox" class="sw-feat" data-f="${f}" ${c.features[f] ? "checked" : ""}> ${FEATURE_NAMES[f] || f}</label>`).join("")}</div></details>
        <details class="sub"><summary>Users (${c.users.length})</summary><div class="table-wrap"><table><thead><tr><th>User</th><th>Role</th><th>Sign-in</th><th>Two-factor</th><th>Last sign-in</th><th></th></tr></thead><tbody>
          ${c.users.map((u) => `<tr><th scope="row">${esc(u.name || u.email)}${u.name ? `<br><span class="hint">${esc(u.email)}</span>` : ""}${u.off ? ' <span class="pill off">Off</span>' : ""}</th><td>${u.role}</td><td>${u.invited ? "Invited" : u.sso || "Password"}</td><td>${u.twoFactor ? "On" : "Off"}</td><td>${day(u.lastLogin)}</td><td><button class="link u-reset" data-user="${u.id}" type="button">Reset link</button></td></tr>`).join("")}</tbody></table></div></details>
        <details class="sub"><summary>Connections (${c.connections.length})${c.connections.some((x) => x.status === "error") ? ' <span class="pill off">Problem</span>' : ""}</summary>
          ${c.connections.length ? c.connections.map((x) => `<div class="conn-line"><b>${esc(x.name)}</b> <span class="hint">${esc(x.kindName || x.kind)}</span> <span class="pill ${x.status === "ok" ? "on" : x.status === "error" ? "off" : ""}">${x.status}</span> <span class="hint">last sync ${day(x.lastSync)}, last success ${day(x.lastOk)}${x.rows !== null && x.rows !== undefined ? `, ${x.rows} lines` : ""}</span>${x.lastError ? `<br><span class="error">${esc(x.lastError)}</span>` : ""}</div>`).join("") : '<p class="hint">None.</p>'}
        </details>
        <details class="sub act-box"><summary>Activity log</summary><div class="act-host"><p class="hint">Loading…</p></div></details>
      </div>
      <div class="pay-row"><input class="pay-amount" type="number" inputmode="decimal" min="0" step="0.01" placeholder="Amount $" aria-label="Amount received"><input class="pay-note note" maxlength="200" placeholder="Note (optional)" aria-label="Note"><button class="secondary small pay-add" type="button">Record payment</button></div>
      ${c.payments.length ? `<div class="payments">${c.payments.map((p) => `${money(p.cents)} on ${day(p.created)}${p.note ? ` — ${esc(p.note)}` : ""} <button class="link pay-del" data-pid="${p.id}" type="button">remove</button>`).join(" · ")}</div>` : ""}
      <div class="pay-row"><button class="secondary small reset-link" type="button">Password reset link</button>${c.resetLinkUntil ? `<span class="hint">A link is active until ${new Date(c.resetLinkUntil).toLocaleString("en-US", { dateStyle: "medium", timeStyle: "short" })}</span>` : ""}</div>
      <div class="reset-host"></div>
      <div class="pay-row"><button class="secondary small toggle-uploads" type="button">${open.has(c.id) ? "Hide uploads" : "Show uploads"}</button><button class="link danger del-cust" type="button">Delete customer</button></div>
      <div class="up-host"></div>
    </div>`).join("");
  for (const [id, k] of keep) {
    const card = host.querySelector(`.cust[data-id="${id}"]`);
    if (!card) continue;
    card.querySelector(".pay-amount").value = k.amount;
    card.querySelector(".pay-note").value = k.note;
    card.querySelector(".reset-host").innerHTML = k.reset;
  }
  await Promise.all([...open].filter((id) => customers.some((c) => c.id === id)).map(async (id) => {
    await loadUploads(id);
    for (const uid of keep.get(id)?.views || []) await viewUpload(id, uid);
  }));
}

setInterval(() => { if (document.visibilityState === "visible" && token && !$("o-dash").hidden) dash({ auto: true }); }, 30000);
document.addEventListener("visibilitychange", () => { if (document.visibilityState === "visible" && token && !$("o-dash").hidden) dash({ auto: true }); });
window.addEventListener("pageshow", (e) => { if (e.persisted && token) dash(); }); // back from another page (Safari's page cache)
$("o-refresh").onclick = () => dash();

// Pull down at the top of the page to refresh (without reloading the page).
(() => {
  const ptr = $("o-ptr");
  let startY = null, dist = 0;
  const reset = () => { startY = null; dist = 0; ptr.style.height = "0px"; ptr.classList.remove("ready"); };
  document.addEventListener("touchstart", (e) => {
    if ($("o-dash").hidden || window.scrollY > 0 || e.touches.length !== 1) return;
    startY = e.touches[0].clientY; dist = 0;
  }, { passive: true });
  document.addEventListener("touchmove", (e) => {
    if (startY === null) return;
    dist = e.touches[0].clientY - startY;
    if (dist <= 0 || window.scrollY > 0) { ptr.style.height = "0px"; return; }
    ptr.style.height = `${Math.min(dist * 0.5, 64)}px`;
    ptr.classList.toggle("ready", dist >= 70);
    ptr.textContent = dist >= 70 ? "Release to refresh" : "Pull to refresh";
  }, { passive: true });
  document.addEventListener("touchend", async () => {
    if (startY === null) return;
    const go = dist >= 70;
    if (!go) return reset();
    ptr.textContent = "Refreshing…"; ptr.style.height = "40px";
    await dash();
    reset();
  });
  document.addEventListener("touchcancel", reset);
})();

// ── Phone alerts (ntfy) ─────────────────────────────────────────────────────────────────────────────────────────
async function loadAlerts() {
  const r = await call("/api/owner/alerts");
  if (r.ok) showAlerts(r.data.topic);
}
function showAlerts(topic) {
  $("al-off").hidden = Boolean(topic); $("al-on").hidden = !topic;
  $("al-topic").textContent = topic || "";
  $("al-result").textContent = "";
}
$("al-make").onclick = async () => {
  const r = await call("/api/owner/alerts", { method: "POST", body: { make: true } });
  if (r.ok) showAlerts(r.data.topic);
};
$("al-new").onclick = async () => {
  if (!confirm("Make a new topic name? Alerts will go to the new name only — you'll need to subscribe to it again in the ntfy app.")) return;
  const r = await call("/api/owner/alerts", { method: "POST", body: { make: true } });
  if (r.ok) showAlerts(r.data.topic);
};
$("al-stop").onclick = async () => {
  if (!confirm("Switch phone alerts off?")) return;
  const r = await call("/api/owner/alerts", { method: "POST", body: { off: true } });
  if (r.ok) showAlerts(null);
};
$("al-copy").onclick = async () => {
  try { await navigator.clipboard.writeText($("al-topic").textContent); $("al-result").textContent = "Topic name copied"; }
  catch { const sel = getSelection(); sel.selectAllChildren($("al-topic")); $("al-result").textContent = "Selected — tap Copy"; }
};
$("al-test").onclick = async () => {
  $("al-test").disabled = true; $("al-result").textContent = "Sending…";
  const r = await call("/api/owner/alerts/test", { method: "POST" });
  $("al-test").disabled = false;
  $("al-result").textContent = r.data.ok ? "Sent — ntfy accepted it. Your phone should ping now." : `ntfy didn't accept it${r.data.status ? ` (answer ${r.data.status})` : ""}. Try again in a minute; if it keeps failing, tell me.`;
};

async function loadUploads(cid) {
  const box = document.querySelector(`.cust[data-id="${cid}"] .up-host`);
  if (!box) return;
  const r = await call(`/api/owner/customers/${cid}/uploads`);
  if (!r.ok) return;
  box.innerHTML = r.data.uploads.length ? `<ul class="cust-uploads">${r.data.uploads.map((u) => `<li data-uid="${u.id}"><b>${esc(u.name)}</b>
    <span>${u.months} months · ${u.products} products · ${day(u.created)}</span><span>${u.accuracy === null ? "no backtest" : `${u.accuracy}% accurate`}</span>
    <span>${u.hasForecast ? "forecast made" : "no forecast yet"}</span>
    <button class="link up-view" type="button">View</button><button class="link up-fc" type="button">${u.hasForecast ? "Re-run forecast" : "Run forecast"}</button><button class="link danger up-del" type="button">Delete</button></li><li class="view-host" data-for="${u.id}" hidden></li>`).join("")}</ul>` : `<p class="hint">No uploads yet.</p>`;
}

async function viewUpload(cid, uid) {
  const host = document.querySelector(`.cust[data-id="${cid}"] .view-host[data-for="${uid}"]`);
  if (!host.hidden) { host.hidden = true; host.innerHTML = ""; return; }
  const r = await call(`/api/owner/customers/${cid}/uploads/${uid}`);
  if (!r.ok) return;
  const u = r.data.upload, bt = u.backtest, fc = u.forecast;
  host.hidden = false;
  host.innerHTML = `<div class="view"><b>Backtest:</b> ${bt.ok ? `${bt.accuracy}% accurate (${bt.months.map(monthLabel).join(", ")} hidden)` : esc(bt.reason)}
    ${bt.ok ? `<ul class="summary">${bt.summary.map((s) => `<li>${esc(s)}</li>`).join("")}</ul>` : ""}
    ${fc?.ok ? `<b>Forecast</b> (${fc.months.map(monthLabel).join(", ")}):<ul class="summary">${fc.summary.map((s) => `<li>${esc(s)}</li>`).join("")}</ul><div class="o-chart"></div>
      <div class="table-wrap"><table><thead><tr><th>Product</th>${fc.months.map((m) => `<th>${monthLabel(m)}</th>`).join("")}<th>Next 3 months</th></tr></thead><tbody>
      ${fc.products.map((p) => `<tr><th scope="row">${esc(p.name)}</th>${p.forecast.map((v) => `<td>${fmt(v, fc.kind)}</td>`).join("")}<td><b>${fmt(p.next3, fc.kind)}</b></td></tr>`).join("")}</tbody></table></div>` : "<p class='hint'>No forecast made yet.</p>"}</div>`;
  if (fc?.ok) {
    const h = fc.total.history.slice(-24);
    lineChart(host.querySelector(".o-chart"), {
      labels: [...fc.historyMonths.slice(-24), ...fc.months].map(monthLabel), kind: fc.kind, format: (v) => fmt(v, fc.kind),
      series: [{ name: "Actual", color: 1, values: [...h, null, null, null] }, { name: "Forecast", color: 2, dashed: true, values: [...h.map((_, i) => (i === h.length - 1 ? h[i] : null)), ...fc.total.forecast] }],
    });
  }
}

$("o-customers").addEventListener("click", async (e) => {
  const card = e.target.closest(".cust");
  if (!card) return;
  const id = card.dataset.id, t = e.target;
  const name = card.querySelector(".cust-name").textContent;
  const invRow = t.closest("tr[data-inv]");
  if (invRow) {
    const iid = invRow.dataset.inv, msg = card.querySelector(".bill-msg");
    if (t.classList.contains("inv-paid")) { const note = prompt("Mark this invoice paid. Note (optional, e.g. 'ACH received 12 Dec'):", ""); if (note === null) return; await call(`/api/owner/invoices/${iid}/paid`, { method: "POST", body: { paid: true, note } }); return dash(); }
    if (t.classList.contains("inv-unpaid")) { if (!confirm("Mark this invoice as not paid?")) return; await call(`/api/owner/invoices/${iid}/paid`, { method: "POST", body: { paid: false } }); return dash(); }
    if (t.classList.contains("inv-send")) { msg.textContent = "Sending…"; const r = await call(`/api/owner/invoices/${iid}/send`, { method: "POST" }); msg.textContent = r.ok ? `Invoice emailed to ${r.data.sent} admin${r.data.sent === 1 ? "" : "s"}.` : r.data.error; return; }
    if (t.classList.contains("inv-pdf")) {
      const res = await fetch(`/api/owner/invoices/${iid}/pdf`, { headers: { Authorization: `Bearer ${token}` } });
      if (!res.ok) return alert("Couldn't get the PDF.");
      const a = document.createElement("a"); a.href = URL.createObjectURL(await res.blob()); a.download = `draxly-invoice-${t.dataset.n}.pdf`; a.click(); setTimeout(() => URL.revokeObjectURL(a.href), 5000);
      return;
    }
  }
  if (t.classList.contains("ag-go")) {
    const billing = card.querySelector(".ag-billing").value, start = card.querySelector(".ag-start").value;
    if (!confirm(`Start Draxly Enterprise for ${name} from ${start}: ${billing === "annual" ? "$30,000 invoiced now for the year" : "$2,500 invoiced each month"}, renewing every year unless cancelled? Every feature is switched on.`)) return;
    const r = await call("/api/owner/agreement", { method: "POST", body: { id, billing, start } });
    if (!r.ok) return alert(r.data.error);
    return dash();
  }
  if (t.classList.contains("ag-cancel")) {
    const b = JSON.parse(lastData).customers.find((x) => x.id === id).billing;
    const left = b.agreement.billing === "monthly" ? b.remainingTermCents : 0;
    if (!confirm(`Cancel ${name}'s agreement? It won't renew on ${b.agreement.termEnd}. They still owe the rest of the year${left ? ` — one invoice for ${money(left)} is issued now` : ""}. Access stays on until you switch it off.`)) return;
    const r = await call("/api/owner/agreement/cancel", { method: "POST", body: { id } });
    if (!r.ok) return alert(r.data.error);
    return dash();
  }
  if (t.classList.contains("ct-save")) {
    const body = { id, plan: card.querySelector(".ct-plan").value, contract: card.querySelector(".ct-value").value || 0, start: card.querySelector(".ct-start").value, end: card.querySelector(".ct-end").value, note: card.querySelector(".ct-note").value, allFeatures: card.querySelector(".ct-all").checked };
    let r = await call("/api/owner/contract", { method: "POST", body });
    if (r.data.belowMinimum && confirm(`${r.data.error} Save this lower amount anyway?`)) r = await call("/api/owner/contract", { method: "POST", body: { ...body, allowBelowMinimum: true } });
    if (!r.ok) return alert(r.data.error || "That didn't work.");
    return dash();
  }
  if (t.classList.contains("u-reset")) {
    if (!confirm("Make a password reset link for this user? It works once, for 24 hours.")) return;
    const r = await call("/api/owner/reset-link", { method: "POST", body: { id, user: t.dataset.user } });
    if (!r.ok) return alert(r.data.error || "That didn't work.");
    const host = card.querySelector(".reset-host");
    host.innerHTML = `<div class="reset-box"><b>Send this link to ${esc(r.data.user)}.</b> It works once, for 24 hours.<input class="reset-url" readonly value="${esc(`${location.origin}/#/reset/${r.data.token}`)}" aria-label="Reset link"><button class="secondary small reset-copy" type="button">Copy link</button> <span class="hint reset-copied"></span></div>`;
    return;
  }
  if (t.tagName === "SUMMARY" && t.parentElement.classList.contains("act-box") && !t.parentElement.open) {
    const host = card.querySelector(".act-host");
    const r = await call(`/api/owner/customers/${id}/audit`);
    host.innerHTML = r.ok && r.data.events.length ? `<div class="table-wrap"><table><thead><tr><th>When</th><th>Who</th><th>What</th><th>Details</th></tr></thead><tbody>${r.data.events.map((a) => `<tr><td class="nowrap">${new Date(a.t).toLocaleString("en-US", { dateStyle: "medium", timeStyle: "short" })}</td><td>${esc(a.user)}</td><th scope="row">${esc(a.action)}</th><td class="wrap">${esc(a.detail)}</td></tr>`).join("")}</tbody></table></div>` : '<p class="hint">Nothing yet.</p>';
    return;
  }
  if (t.classList.contains("pay-add")) {
    const amount = card.querySelector(".pay-amount").value;
    const r = await call("/api/owner/payment", { method: "POST", body: { id, amount, note: card.querySelector(".pay-note").value } });
    if (!r.ok) return alert(r.data.error || "That didn't work.");
    return dash();
  }
  if (t.classList.contains("reset-link")) {
    if (!confirm(`Make a password reset link for ${name}? It works once, for 24 hours. Any earlier link stops working.`)) return;
    const r = await call("/api/owner/reset-link", { method: "POST", body: { id } });
    if (!r.ok) return alert(r.data.error || "That didn't work.");
    const link = `${location.origin}/#/reset/${r.data.token}`;
    const host = card.querySelector(".reset-host");
    host.innerHTML = `<div class="reset-box"><b>Send this link to ${esc(name)}</b> (by text or email). It works once, until ${new Date(r.data.expires).toLocaleString("en-US", { dateStyle: "medium", timeStyle: "short" })}. Only send it to the person who owns the account.
      <input class="reset-url" readonly value="${esc(link)}" aria-label="Reset link"><button class="secondary small reset-copy" type="button">Copy link</button> <span class="hint reset-copied"></span></div>`;
    host.querySelector(".reset-url").select();
    return;
  }
  if (t.classList.contains("reset-copy")) {
    const input = card.querySelector(".reset-url");
    try { await navigator.clipboard.writeText(input.value); card.querySelector(".reset-copied").textContent = "Copied"; } catch { input.select(); card.querySelector(".reset-copied").textContent = "Selected — copy it"; }
    return;
  }
  if (t.classList.contains("pay-del")) {
    if (!confirm("Remove this payment from Money collected? (The forecast switch stays as it is.)")) return;
    await call("/api/owner/payment-delete", { method: "POST", body: { id, paymentId: t.dataset.pid } });
    return dash();
  }
  if (t.classList.contains("toggle-uploads")) {
    if (open.has(id)) { open.delete(id); card.querySelector(".up-host").innerHTML = ""; t.textContent = "Show uploads"; }
    else { open.add(id); t.textContent = "Hide uploads"; loadUploads(id); }
    return;
  }
  if (t.classList.contains("del-cust")) {
    if (!confirm(`Are you sure? Delete ${name} and all of their uploads, backtests, forecasts and payments? This can't be undone.`)) return;
    await call("/api/owner/delete-customer", { method: "POST", body: { id } });
    open.delete(id);
    return dash();
  }
  const li = t.closest("li[data-uid]");
  if (!li) return;
  const uid = li.dataset.uid;
  if (t.classList.contains("up-view")) return viewUpload(id, uid);
  if (t.classList.contains("up-fc")) { t.disabled = true; await call(`/api/owner/customers/${id}/uploads/${uid}/forecast`, { method: "POST" }); await loadUploads(id); return viewUpload(id, uid); }
  if (t.classList.contains("up-del")) {
    if (!confirm("Delete this upload for the customer?")) return;
    await call(`/api/owner/customers/${id}/uploads/${uid}`, { method: "DELETE" });
    return dash();
  }
});
$("o-customers").addEventListener("change", async (e) => {
  const card = e.target.closest(".cust");
  if (!card) return;
  const body = { id: card.dataset.id };
  if (e.target.classList.contains("sw-feat")) {
    openFeat.add(card.dataset.id);
    const r = await call("/api/owner/features", { method: "POST", body: { id: card.dataset.id, features: { [e.target.dataset.f]: e.target.checked } } });
    if (!r.ok) alert(r.data.error || "That didn't work.");
    return dash();
  }
  if (e.target.classList.contains("sw-account")) body.account = e.target.checked;
  else if (e.target.classList.contains("sw-forecasts")) body.forecasts = e.target.checked;
  else return;
  await call("/api/owner/switch", { method: "POST", body });
  dash();
});
$("o-contact-save").onclick = async () => {
  const r = await call("/api/owner/contact", { method: "POST", body: { contact: $("o-contact").value } });
  $("o-contact-saved").textContent = r.ok ? "Saved" : "Didn't save";
  setTimeout(() => ($("o-contact-saved").textContent = ""), 2500);
};

if (token) { const r = await call("/api/owner/customers"); if (r.ok) dash(); else gate(); } else gate();

// ── Platform settings (email, sign-in apps, QuickBooks app) ─────────────────────────────────────────────────────
const PL_PLAIN = ["emailFrom", "msClientId", "googleClientId", "qbClientId", "billingName", "paymentInstructions"], PL_SECRET = ["emailKey", "msSecret", "googleSecret", "qbSecret"];
async function loadPlatform() {
  const r = await call("/api/owner/platform");
  if (!r.ok) return;
  for (const k of PL_PLAIN) if (document.activeElement !== $(`pl-${k}`)) $(`pl-${k}`).value = r.data.platform[k] || "";
  $("pl-ownerEmail").value = r.data.platform.ownerEmail || ""; // Draxly's contact email (read-only)
  for (const k of PL_SECRET) { $(`pl-${k}`).value = ""; $(`pl-${k}-state`).textContent = r.data.platform[k] ? "saved" : "not set"; }
  $("pl-cb-sso").textContent = r.data.callbacks.sso; $("pl-cb-qb").textContent = r.data.callbacks.quickbooks;
}
$("pl-save").onclick = async () => {
  const body = {};
  for (const k of PL_PLAIN) body[k] = $(`pl-${k}`).value;
  for (const k of PL_SECRET) if ($(`pl-${k}`).value.trim()) body[k] = $(`pl-${k}`).value;
  const r = await call("/api/owner/platform", { method: "POST", body });
  $("pl-saved").textContent = r.ok ? "Saved" : "Didn't save";
  setTimeout(() => ($("pl-saved").textContent = ""), 2500);
  loadPlatform();
};
$("pl-test").onclick = async () => {
  $("pl-test-msg").textContent = "Sending…";
  const r = await call("/api/owner/email-test", { method: "POST", body: { to: $("pl-test-to").value } });
  $("pl-test-msg").textContent = r.data.ok ? "Sent — check that inbox." : r.data.reason || r.data.error || "Didn't send.";
};

// ── Demo visits and access requests ─────────────────────────────────────────────────────────────────────────────
async function loadDemo() {
  const r = await call("/api/owner/demo");
  if (!r.ok) return;
  const { visits, leads, counts } = r.data;
  $("dm-link").textContent = `${location.origin}/demo`; $("dm-link").href = "/demo";
  $("dm-counts").textContent = `${counts.visits7} visit${counts.visits7 === 1 ? "" : "s"} in the last 7 days · ${counts.visits30} in 30 days · ${counts.visitsAll} in all · ${counts.leadsNew} new request${counts.leadsNew === 1 ? "" : "s"} (${counts.leadsAll} in all)`;
  const when = (t) => new Date(t).toLocaleString("en-US", { dateStyle: "medium", timeStyle: "short" });
  $("dm-leads").innerHTML = leads.length ? `<thead><tr><th>When</th><th>Who</th><th>Company</th><th>Contact</th><th>Details</th><th>Status</th></tr></thead><tbody>${leads.map((l) => `<tr data-lead="${l.id}"><td class="nowrap">${when(l.t)}</td><th scope="row">${esc(l.name)}${l.title ? `<br><span class="hint">${esc(l.title)}</span>` : ""}</th><td>${esc(l.company)}${l.locations ? `<br><span class="hint">${esc(l.locations)} locations</span>` : ""}</td>
    <td><a href="mailto:${esc(l.email)}">${esc(l.email)}</a></td><td class="wrap">${esc(l.message)}${l.city || l.country ? `<br><span class="hint">${esc([l.city, l.country].filter(Boolean).join(", "))}</span>` : ""}</td>
    <td><select class="lead-status">${["new", "contacted", "closed"].map((x) => `<option value="${x}" ${x === l.status ? "selected" : ""}>${x[0].toUpperCase() + x.slice(1)}</option>`).join("")}</select></td></tr>`).join("")}</tbody>` : '<tbody><tr><td class="hint">No requests yet.</td></tr></tbody>';
  $("dm-visits").innerHTML = visits.length ? `<thead><tr><th>When</th><th>Where</th><th>Device</th><th>Came from</th><th>File</th><th>Requested access</th></tr></thead><tbody>${visits.slice(0, 100).map((v) => `<tr><td class="nowrap">${when(v.t)}</td><td>${esc([v.city, v.region, v.country].filter(Boolean).join(", ") || "—")}</td><td>${esc(v.device || "—")}</td><td class="wrap">${esc(v.referrer || "Direct")}${/utm|source=|ref=/.test(v.source) ? ` · ${esc(v.source.replace(/forecast:.*$/, "").trim())}` : ""}</td><td>${esc((/forecast: (.*)$/.exec(v.source) || [])[1] || "—")}</td><td>${v.lead ? "Yes" : ""}</td></tr>`).join("")}</tbody>` : '<tbody><tr><td class="hint">Nobody has opened the demo yet.</td></tr></tbody>';
}
$("dm-leads").addEventListener("change", async (e) => {
  if (!e.target.classList.contains("lead-status")) return;
  await call(`/api/owner/leads/${e.target.closest("tr").dataset.lead}`, { method: "POST", body: { status: e.target.value } });
  loadDemo();
});

