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

async function dash() {
  const r = await call("/api/owner/customers");
  if (!r.ok) return;
  show("o-dash");
  const { customers, totals, contact } = r.data;
  const tile = (n, l) => `<div class="tile"><div class="tile-num">${n}</div><div class="tile-label">${l}</div></div>`;
  $("o-tiles").innerHTML = tile(totals.customers, "Customers") + tile(totals.paying, "Paying") + tile(money(totals.collectedCents), "Money collected")
    + tile(totals.uploads, "Uploads") + tile(totals.avgAccuracy === null ? "—" : `${totals.avgAccuracy}%`, "Average backtest accuracy");
  if (document.activeElement !== $("o-contact")) $("o-contact").value = contact;
  $("o-none").hidden = customers.length > 0;
  const host = $("o-customers");
  host.innerHTML = customers.map((c) => `
    <div class="cust" data-id="${c.id}">
      <div class="cust-head"><span class="cust-name">${esc(c.company)}</span>
        <span>${c.off ? '<span class="pill off">Account off</span>' : '<span class="pill on">Account on</span>'} ${c.forecasts ? '<span class="pill on">Forecasts on</span>' : '<span class="pill">Backtest only</span>'}</span></div>
      <div class="cust-facts"><span>${esc(c.email)}</span><span>Joined ${day(c.created)}</span><span>Last seen ${day(c.lastSeen)}</span>
        <span>${c.uploads} upload${c.uploads === 1 ? "" : "s"}</span><span>Last backtest: ${c.lastAccuracy === null ? "—" : `<b>${c.lastAccuracy}%</b> accurate`}</span><span>Paid: <b>${money(c.paidCents)}</b></span></div>
      <div class="switches">
        <label class="switch"><input type="checkbox" class="sw-account" ${c.off ? "" : "checked"}> Account on</label>
        <label class="switch"><input type="checkbox" class="sw-forecasts" ${c.forecasts ? "checked" : ""}> 3-month forecasts on</label>
      </div>
      <div class="pay-row"><input class="pay-amount" type="number" inputmode="decimal" min="0" step="0.01" placeholder="Amount $" aria-label="Amount received"><input class="pay-note note" maxlength="200" placeholder="Note (optional)" aria-label="Note"><button class="secondary small pay-add" type="button">Record payment</button></div>
      ${c.payments.length ? `<div class="payments">${c.payments.map((p) => `${money(p.cents)} on ${day(p.created)}${p.note ? ` — ${esc(p.note)}` : ""} <button class="link pay-del" data-pid="${p.id}" type="button">remove</button>`).join(" · ")}</div>` : ""}
      <div class="pay-row"><button class="secondary small toggle-uploads" type="button">${open.has(c.id) ? "Hide uploads" : "Show uploads"}</button><button class="link danger del-cust" type="button">Delete customer</button></div>
      <div class="up-host"></div>
    </div>`).join("");
  for (const id of open) if (customers.some((c) => c.id === id)) loadUploads(id);
}

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
  if (t.classList.contains("pay-add")) {
    const amount = card.querySelector(".pay-amount").value;
    const r = await call("/api/owner/payment", { method: "POST", body: { id, amount, note: card.querySelector(".pay-note").value } });
    if (!r.ok) return alert(r.data.error || "That didn't work.");
    return dash();
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
