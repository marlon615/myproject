import { footer } from "./draft";
import type { Settings } from "./settings";
import { PRODUCT_NAME, type Draft, type Prospect } from "./types";

export const esc = (v: unknown) =>
  String(v ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!);

const CSS = `
:root{color-scheme:light dark;--bg:#f6f5f2;--card:#fff;--text:#1d1b18;--muted:#6f6a62;--border:#e6e2da;--accent:#2f5bd3;--on-accent:#fff;--yes:#178a4c;--no:#c2410c;--cp:#2f5bd3;--cf:#8a4fbf;--warn-bg:#fff4e0;--warn:#8a5a00}
@media (prefers-color-scheme:dark){:root{--bg:#121212;--card:#1d1d1f;--text:#f2f0ec;--muted:#a19c93;--border:#2e2d2b;--accent:#7aa2ff;--on-accent:#0b1430;--yes:#3ecf7e;--no:#ff8a5c;--cp:#7aa2ff;--cf:#c49af0;--warn-bg:#2d2412;--warn:#f0c46a}}
*{box-sizing:border-box}html,body{margin:0}body{background:var(--bg);color:var(--text);font:16px/1.45 -apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,sans-serif;-webkit-font-smoothing:antialiased;padding-bottom:calc(76px + env(safe-area-inset-bottom))}
a{color:var(--accent)}h1{font-size:1.45rem;margin:4px 0 12px}h2{font-size:1.05rem;margin:0 0 10px}
.wrap{max-width:680px;margin:0 auto;padding:calc(12px + env(safe-area-inset-top)) 16px 24px}
.top{display:flex;justify-content:space-between;align-items:center;margin-bottom:6px}.brand{font-weight:800}.muted{color:var(--muted)}.small{font-size:.85rem}
.card{background:var(--card);border:1px solid var(--border);border-radius:16px;padding:16px;margin-bottom:14px}
.badge{display:inline-block;font-size:.75rem;font-weight:700;padding:3px 9px;border-radius:999px;color:#fff}.b-clientpulse{background:var(--cp)}.b-churchfollow{background:var(--cf)}
.meta{display:flex;gap:8px;align-items:center;flex-wrap:wrap;margin-bottom:10px}
label{display:block;font-weight:600;font-size:.88rem;margin:10px 0 4px}
input,textarea,select{width:100%;font:inherit;font-size:16px;color:var(--text);background:var(--bg);border:1px solid var(--border);border-radius:12px;padding:11px 12px}
textarea{resize:vertical;min-height:120px;line-height:1.45}
.foot{white-space:pre-wrap;font-size:.8rem;color:var(--muted);margin-top:6px}
.btn{display:inline-flex;align-items:center;justify-content:center;gap:6px;min-height:48px;padding:10px 18px;border-radius:14px;border:1px solid var(--border);background:var(--card);color:var(--text);font:inherit;font-weight:700;cursor:pointer;text-decoration:none}
.btn-primary{background:var(--accent);border-color:var(--accent);color:var(--on-accent)}
.btn-yes{background:var(--yes);border-color:var(--yes);color:#fff;flex:2}.btn-no{color:var(--no);border-color:var(--no);background:transparent;flex:1}
.btn:disabled{opacity:.55}.row{display:flex;gap:10px;margin-top:14px}.block{width:100%}
.flash{padding:12px 14px;border-radius:12px;background:var(--warn-bg);color:var(--warn);margin-bottom:14px;font-weight:600}
.tiles{display:grid;grid-template-columns:repeat(auto-fit,minmax(140px,1fr));gap:10px;margin-bottom:14px}
.tile{background:var(--card);border:1px solid var(--border);border-radius:14px;padding:14px}.tile b{display:block;font-size:1.8rem;font-variant-numeric:tabular-nums}.tile span{font-size:.8rem;color:var(--muted);font-weight:600}
.bars{display:grid;grid-template-columns:repeat(14,1fr);gap:4px;height:130px;align-items:end}.bar{display:flex;flex-direction:column-reverse;height:100%;gap:2px}.bar i{display:block;border-radius:3px 3px 0 0}.i-sent{background:var(--yes)}.i-no{background:var(--no)}
.x{display:grid;grid-template-columns:repeat(14,1fr);gap:4px;font-size:.68rem;color:var(--muted);text-align:center;margin-top:4px}
table{width:100%;border-collapse:collapse;font-size:.9rem}td,th{padding:8px 4px;border-bottom:1px solid var(--border);text-align:left;vertical-align:top}th{color:var(--muted);font-size:.8rem}
.tabs{position:fixed;bottom:0;left:0;right:0;display:grid;grid-template-columns:repeat(5,1fr);background:var(--card);border-top:1px solid var(--border);padding:6px 6px calc(6px + env(safe-area-inset-bottom))}
.tabs a{display:flex;flex-direction:column;align-items:center;font-size:.75rem;font-weight:700;color:var(--muted);text-decoration:none;padding:6px 0}.tabs a.on{color:var(--accent)}.tabs a b{font-size:1.2rem}
.empty{text-align:center;padding:30px 10px}.done{opacity:.5;pointer-events:none}
.pill{display:inline-block;padding:2px 8px;border-radius:999px;font-size:.75rem;font-weight:700;border:1px solid var(--border)}
form.inline{display:inline}.legend{display:flex;gap:12px;font-size:.8rem;color:var(--muted)}.legend i{display:inline-block;width:10px;height:10px;border-radius:3px;margin-right:4px}
`;

export function page(title: string, body: string, opts: { tab?: string; flash?: string; bare?: boolean } = {}) {
  const tabs = [
    ["voice", "/", "🎙", "Voice"],
    ["approve", "/review", "✓", "Review"],
    ["prospects", "/prospects", "👥", "Prospects"],
    ["dashboard", "/dashboard", "▦", "Dashboard"],
    ["settings", "/settings", "⚙", "Settings"],
  ];
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1,viewport-fit=cover">
<meta name="robots" content="noindex,nofollow"><meta name="theme-color" content="#2f5bd3"><meta name="apple-mobile-web-app-capable" content="yes">
<meta name="apple-mobile-web-app-title" content="Chief"><link rel="manifest" href="/manifest.webmanifest"><link rel="apple-touch-icon" href="/icon-192.png"><title>${esc(title)} · Chief of Staff</title><style>${CSS}</style></head><body>
<div class="wrap">${opts.bare ? "" : `<div class="top"><div class="brand">Chief of Staff</div></div>`}
${opts.flash ? `<div class="flash" role="status">${esc(opts.flash)}</div>` : ""}${body}</div>
${opts.bare ? "" : `<nav class="tabs">${tabs.map(([k, h, i, l]) => `<a href="${h}" class="${opts.tab === k ? "on" : ""}"><b aria-hidden="true">${i}</b>${l}</a>`).join("")}</nav>`}
</body></html>`;
}

export function loginPage(error?: string) {
  return page("Sign in", `<div class="card" style="margin-top:12vh"><h1>Chief of Staff</h1><p class="muted">Private. Owner only.</p>
<form method="post" action="/login"><label for="pw">Password</label><input id="pw" name="password" type="password" autocomplete="current-password" required autofocus>
${error ? `<p style="color:var(--no);font-weight:600">${esc(error)}</p>` : ""}<button class="btn btn-primary block" style="margin-top:14px">Sign in</button></form></div>`, { bare: true });
}

type PendingRow = Draft & { name: string; email: string; organization: string };

type ReplyCard = { id: number; to_email: string; to_name: string; subject: string; body: string; summary: string; orig_subject: string; from_name: string; from_email: string };
type TodoItem = { id: number; text: string };

export function approvePage(rows: PendingRow[], s: Settings, mode: "gmail" | "resend" | "mailto", flash?: string, replies: ReplyCard[] = [], todos: TodoItem[] = []) {
  const how = mode === "gmail"
    ? "Tapping <b>Yes</b> sends it from your Gmail right away."
    : mode === "resend"
    ? "Tapping <b>Yes</b> sends the email right away."
    : "Tapping <b>Yes</b> opens it in your Mail app, ready to send. (Connect Gmail in Settings to send straight from here.)";
  const replyCards = replies.map((r) => `
<form class="card draft" method="post" action="/replies/${r.id}/decide">
  <div class="meta"><span class="badge" style="background:var(--yes)">Inbox reply</span></div>
  <div><b>${esc(r.from_name || r.from_email)}</b><div class="muted small">${esc(r.from_email)} · ${esc(r.orig_subject)}</div></div>
  <p class="small" style="margin:8px 0 0">${esc(r.summary)}</p>
  <label>Subject</label><input name="subject" value="${esc(r.subject)}" maxlength="300" required>
  <label>Reply</label><textarea name="body" rows="6" maxlength="5000" required>${esc(r.body)}</textarea>
  <div class="row"><button class="btn btn-no" name="decision" value="no">No</button><button class="btn btn-yes" name="decision" value="yes">Yes, send</button></div>
</form>`).join("");
  const list = `<div class="card"><h2>Your list</h2>
${todos.length ? todos.map((t) => `<form method="post" action="/todos" style="display:flex;gap:8px;align-items:center;margin-bottom:6px"><input type="hidden" name="done" value="${t.id}"><button class="btn" style="min-height:36px;padding:4px 10px" aria-label="Done: ${esc(t.text)}">✓</button><span>${esc(t.text)}</span></form>`).join("") : `<p class="muted small">Nothing yet. Say “Hey Chief, remember to…”.</p>`}
<form method="post" action="/todos" style="display:flex;gap:8px;margin-top:8px"><input name="text" placeholder="Add something to remember" maxlength="300"><button class="btn">Add</button></form></div>`;
  const cards = rows.map((d) => `
<form class="card draft" method="post" action="/drafts/${d.id}/decide" data-id="${d.id}">
  <div class="meta"><span class="badge b-${d.product}">${PRODUCT_NAME[d.product]}</span><span class="pill">${d.touch === 1 ? "First email" : `Follow-up ${d.touch - 1}`}</span><span class="pill">${d.source === "ai" ? "AI draft" : "Template"}</span></div>
  <div><b>${esc(d.name || d.email)}</b>${d.organization ? ` · ${esc(d.organization)}` : ""}<div class="muted small">${esc(d.email)}</div></div>
  <label>Subject</label><input name="subject" value="${esc(d.subject)}" maxlength="200" required>
  <label>Email</label><textarea name="body" rows="9" maxlength="5000" required>${esc(d.body)}</textarea>
  <div class="foot">${esc(footer(s))}</div>
  <div class="row"><button class="btn btn-no" name="decision" value="no">No</button><button class="btn btn-yes" name="decision" value="yes">Yes, send</button></div>
</form>`).join("");
  return page("Review", `<h1>Review</h1>
<p class="muted small">${how} Nothing is ever sent without your yes.</p>
<h2>Inbox replies</h2>
${replyCards || `<div class="card empty muted small">No reply drafts waiting.</div>`}
<form method="post" action="/inbox/sync" style="margin-bottom:18px"><button class="btn block">Check Gmail now</button></form>
<h2>Outreach</h2>
${rows.length ? cards : `<div class="card empty"><p><b>All caught up.</b></p><p class="muted">New drafts arrive every morning. Add prospects, or draft now.</p></div>`}
<form method="post" action="/draft-now" style="margin-bottom:18px"><button class="btn block">Draft today's emails now</button></form>
${list}
<script>
document.querySelectorAll("form.draft").forEach(function(f){
  f.addEventListener("submit",function(e){
    var b=e.submitter; if(!b) return; e.preventDefault();
    var fd=new FormData(f); fd.set("decision",b.value); f.querySelectorAll("button").forEach(function(x){x.disabled=true});
    b.textContent=b.value==="yes"?"Sending…":"Skipping…";
    fetch(f.action,{method:"POST",body:fd,headers:{"Accept":"application/json"},credentials:"same-origin"}).then(function(r){return r.json()}).then(function(j){
      if(!j.ok){alert(j.error||"Something went wrong");f.querySelectorAll("button").forEach(function(x){x.disabled=false});b.textContent=b.value==="yes"?"Yes, send":"No";return}
      f.classList.add("done"); b.textContent=j.label||"Done";
      if(j.href){window.location.href=j.href}
      setTimeout(function(){f.remove(); if(!document.querySelector("form.draft")) location.reload()},900);
    }).catch(function(){alert("No connection. Try again.");f.querySelectorAll("button").forEach(function(x){x.disabled=false})});
  });
});
</script>`, { tab: "approve", flash });
}

const STATUS_LABEL: Record<string, string> = { new: "New", contacted: "Contacted", replied: "Replied", not_interested: "Not interested", do_not_contact: "Do not contact" };

export function prospectsPage(rows: Prospect[], filter: { product: string; status: string }, flash?: string) {
  const opt = (v: string, l: string, cur: string) => `<option value="${v}"${v === cur ? " selected" : ""}>${l}</option>`;
  const productSelect = (name: string, cur = "churchfollow") => `<select name="${name}">${opt("churchfollow", "ChurchFollow", cur)}${opt("clientpulse", "ClientPulse", cur)}</select>`;
  const list = rows.map((p) => `<tr>
<td><span class="badge b-${p.product}">${PRODUCT_NAME[p.product]}</span><div><b>${esc(p.name || "—")}</b></div><div class="muted small">${esc(p.email)}${p.organization ? ` · ${esc(p.organization)}` : ""}</div>${p.notes ? `<div class="small">${esc(p.notes)}</div>` : ""}<div class="muted small">${p.touches} sent</div></td>
<td style="width:44%"><form method="post" action="/prospects/${p.id}/status"><select name="status" onchange="this.form.submit()">${Object.entries(STATUS_LABEL).map(([k, l]) => opt(k, l, p.status)).join("")}</select></form>
<form method="post" action="/prospects/${p.id}/delete" onsubmit="return confirm('Delete this prospect and their drafts?')"><button class="btn small" style="min-height:36px;margin-top:6px;padding:4px 10px">Delete</button></form></td></tr>`).join("");
  return page("Prospects", `<h1>Prospects</h1>
<details class="card"${rows.length ? "" : " open"}><summary><b>Add one</b></summary>
<form method="post" action="/prospects"><label>Product</label>${productSelect("product")}
<label>Name</label><input name="name" maxlength="120" placeholder="Pastor Dave Miller">
<label>Email</label><input name="email" type="email" required maxlength="200" placeholder="dave@gracechurch.org">
<label>Organization</label><input name="organization" maxlength="160" placeholder="Grace Community Church">
<label>Notes (helps the draft)</label><textarea name="notes" rows="3" maxlength="800" placeholder="~120 people on Sundays, just launched a second service"></textarea>
<button class="btn btn-primary block" style="margin-top:12px">Add prospect</button></form></details>
<details class="card"><summary><b>Paste a list</b></summary>
<form method="post" action="/prospects/bulk"><label>Product</label>${productSelect("product")}
<label>One per line: name, email, organization, notes</label><textarea name="lines" rows="6" placeholder="Dave Miller, dave@gracechurch.org, Grace Community Church, 120 on Sundays"></textarea>
<button class="btn btn-primary block" style="margin-top:12px">Add all</button></form></details>
<form class="card" method="get" action="/prospects" style="display:flex;gap:8px">
<select name="product" onchange="this.form.submit()">${opt("", "All products", filter.product)}${opt("churchfollow", "ChurchFollow", filter.product)}${opt("clientpulse", "ClientPulse", filter.product)}</select>
<select name="status" onchange="this.form.submit()">${opt("", "Any status", filter.status)}${Object.entries(STATUS_LABEL).map(([k, l]) => opt(k, l, filter.status)).join("")}</select></form>
${rows.length ? `<div class="card"><table>${list}</table></div>` : `<div class="card empty muted">No prospects yet.</div>`}
<p class="muted small">Mark someone <b>Replied</b> or <b>Not interested</b> and they get no more follow-ups.</p>`, { tab: "prospects", flash });
}

export interface DashData {
  pending: number;
  sentToday: number;
  noToday: number;
  sentTotal: number;
  approval30: number | null;
  prospects: Record<string, number>;
  byProduct: { product: string; sent: number; rejected: number; replied: number }[];
  days: { day: string; sent: number; rejected: number }[];
  runs: { at: string; trigger: string; created: number; note: string | null }[];
  tz: string;
  inbox?: { newCount: number; repliesPending: number; repliesSentToday: number } | null;
  todosOpen?: number;
  lastTick?: { at: string; note: string } | null;
}

export function dashboardPage(d: DashData) {
  const max = Math.max(1, ...d.days.map((x) => x.sent + x.rejected));
  const fmt = (iso: string) => new Date(iso).toLocaleString("en-US", { timeZone: d.tz, month: "short", day: "numeric", hour: "numeric", minute: "2-digit" });
  const total = Object.values(d.prospects).reduce((a, b) => a + b, 0);
  return page("Dashboard", `<h1>Owner dashboard</h1>
<div class="tiles">
<div class="tile"><span>Waiting for you</span><b>${d.pending}</b></div>
<div class="tile"><span>Sent today</span><b>${d.sentToday}</b></div>
<div class="tile"><span>Skipped today</span><b>${d.noToday}</b></div>
<div class="tile"><span>Sent all time</span><b>${d.sentTotal}</b></div>
<div class="tile"><span>Yes rate (30 days)</span><b>${d.approval30 === null ? "—" : d.approval30 + "%"}</b></div>
<div class="tile"><span>Prospects replied</span><b>${d.prospects.replied ?? 0}</b></div>
${d.inbox ? `<div class="tile"><span>New emails</span><b>${d.inbox.newCount}</b></div><div class="tile"><span>Replies to approve</span><b>${d.inbox.repliesPending}</b></div><div class="tile"><span>Replies sent today</span><b>${d.inbox.repliesSentToday}</b></div>` : ""}
<div class="tile"><span>On your list</span><b>${d.todosOpen ?? 0}</b></div>
</div>
<div class="card"><div style="display:flex;justify-content:space-between;align-items:center;flex-wrap:wrap;gap:8px"><h2>Last 14 days</h2><div class="legend"><span><i class="i-sent"></i>Sent</span><span><i class="i-no"></i>Skipped</span></div></div>
<div class="bars" role="img" aria-label="Emails sent and skipped per day">${d.days.map((x) => `<div class="bar" title="${x.day}: ${x.sent} sent, ${x.rejected} skipped"><i class="i-sent" style="height:${(x.sent / max) * 100}%"></i><i class="i-no" style="height:${(x.rejected / max) * 100}%"></i></div>`).join("")}</div>
<div class="x">${d.days.map((x) => `<span>${Number(x.day.slice(8))}</span>`).join("")}</div></div>
<div class="card"><h2>By product</h2><table><tr><th>Product</th><th>Sent</th><th>Skipped</th><th>Replied</th></tr>
${d.byProduct.map((r) => `<tr><td><span class="badge b-${r.product}">${PRODUCT_NAME[r.product as "clientpulse"]}</span></td><td>${r.sent}</td><td>${r.rejected}</td><td>${r.replied}</td></tr>`).join("")}</table></div>
<div class="card"><h2>Prospects · ${total}</h2><table>${Object.entries(STATUS_LABEL).map(([k, l]) => `<tr><td>${l}</td><td style="text-align:right">${d.prospects[k] ?? 0}</td></tr>`).join("")}</table></div>
<div class="card"><h2>Autopilot</h2><p class="small" style="margin:0">${d.lastTick ? `Last check ${esc(fmt(d.lastTick.at))}: ${esc(d.lastTick.note)}` : "No automatic check has run yet."}</p><p class="muted small" style="margin:6px 0 0">Chief checks Gmail every 5 minutes on Cloudflare, phone open or not.</p></div>
<div class="card"><h2>Recent drafting runs</h2>${d.runs.length ? `<table>${d.runs.map((r) => `<tr><td class="small">${fmt(r.at)}</td><td class="small">${r.trigger === "cron" ? "Morning" : "Manual"}</td><td class="small">${esc(r.note ?? "")}</td></tr>`).join("")}</table>` : `<p class="muted">None yet. The first one runs tomorrow morning.</p>`}</div>`, { tab: "dashboard" });
}

export function settingsPage(s: Settings, keys: { anthropic: boolean; resend: boolean; gmail: boolean; calendar: boolean; phones?: number }, flash?: string) {
  const f = (name: keyof Settings, label: string, ph = "", type = "text") =>
    `<label>${label}</label><input name="${name}" type="${type}" value="${esc(s[name])}" placeholder="${esc(ph)}" maxlength="300">`;
  const check = (ok: boolean, label: string, how: string) => `<li style="margin:6px 0">${ok ? "✅" : "⬜️"} <b>${label}</b>${ok ? "" : ` · <span class="small">${how}</span>`}</li>`;
  return page("Settings", `<h1>Settings</h1>
<div class="card"><h2>Chief on autopilot</h2><ul style="list-style:none;padding:0;margin:0">
${check(keys.gmail, "Gmail connected", "paste your app password below")}
${check(keys.anthropic, "Anthropic key added", "paste it under Connections, so replies are written in full sentences")}
${check((keys.phones ?? 0) > 0, "Notifications on", "open Chief from your Home Screen and tap Turn on notifications")}
</ul><p class="muted small" style="margin:8px 0 0">With all three, Chief checks Gmail every 5 minutes on its own, writes replies, and notifies you for one yes.</p></div>
<form method="post" action="/settings/gmail" class="card"><h2>Gmail ${keys.gmail ? "✅ connected" : ""}</h2>
<p class="small">Lets Chief read your Primary inbox aloud (without marking anything read) and send the replies and outreach you approve from your own Gmail.</p>
<label>Gmail address</label><input name="gmailAddress" type="email" value="${esc(s.gmailAddress)}" placeholder="you@gmail.com" autocomplete="email">
<label>Gmail app password</label><input name="gmailPassword" type="password" autocomplete="off" placeholder="${keys.gmail ? "Saved. Paste a new one to replace it." : "16 letters from Google"}">
<p class="muted small">Get one at <a href="https://myaccount.google.com/apppasswords" target="_blank" rel="noopener">myaccount.google.com/apppasswords</a>: type “Chief” as the name, tap Create, and copy the 16 letters. (Google shows that page only when 2-Step Verification is on.)</p>
<div class="row"><button class="btn btn-primary" style="flex:1">${keys.gmail ? "Save and test" : "Connect Gmail"}</button>${keys.gmail ? `<button class="btn" name="remove" value="gmail">Disconnect</button>` : ""}</div>
</form>
<form method="post" action="/settings">
<div class="card"><h2>You</h2>
${f("senderName", "Your name (signs the emails)", "Marlon Rivera")}
${f("senderEmail", "Sending address for Resend (skip if you use Gmail)", "marlon@yourdomain.com", "email")}
${f("replyTo", "Replies go to (optional)", "you@gmail.com", "email")}
<label>Mailing address (US law requires one in outreach emails)</label><input name="mailingAddress" value="${esc(s.mailingAddress)}" maxlength="300" placeholder="123 Main St, Dallas, TX 75201">
</div>
<div class="card"><h2>Products</h2>
<label>ClientPulse: what it does</label><textarea name="product_clientpulse" rows="3" maxlength="1200">${esc(s.product_clientpulse)}</textarea>
${f("link_clientpulse", "ClientPulse link (optional)", "https://")}
<label>ChurchFollow: what it does</label><textarea name="product_churchfollow" rows="4" maxlength="1200">${esc(s.product_churchfollow)}</textarea>
${f("link_churchfollow", "ChurchFollow link (optional)", "https://")}
<label>Tone</label><textarea name="tone" rows="2" maxlength="400">${esc(s.tone)}</textarea>
</div>
<div class="card"><h2>Daily drafting</h2>
<label>Drafts per day (both products together)</label><input name="dailyLimit" type="number" min="1" max="50" value="${s.dailyLimit}">
<label>Days before a follow-up</label><input name="followUpDays" type="number" min="1" max="30" value="${s.followUpDays}">
<label>Emails per person, including follow-ups</label><input name="maxTouches" type="number" min="1" max="5" value="${s.maxTouches}">
<p class="muted small">New drafts are made every morning around 7–8 a.m. Central.</p>
</div>
<button class="btn btn-primary block">Save settings</button>
</form>
<form method="post" action="/settings/calendar" class="card"><h2>Google Calendar ${keys.calendar ? "✅ connected" : ""}</h2>
<p class="small">Lets Chief read your schedule aloud. (Adding events works without this.)</p>
<label>Secret address in iCal format</label><input name="calendarUrl" type="password" autocomplete="off" placeholder="${keys.calendar ? "Saved. Paste a new one to replace it." : "https://calendar.google.com/calendar/ical/…/basic.ics"}">
<p class="muted small">On a computer or in your phone's browser: <a href="https://calendar.google.com/calendar/r/settings" target="_blank" rel="noopener">Google Calendar settings</a> → your calendar under “Settings for my calendars” → “Integrate calendar” → copy “Secret address in iCal format”.</p>
<div class="row"><button class="btn btn-primary" style="flex:1">${keys.calendar ? "Save and test" : "Connect calendar"}</button>${keys.calendar ? `<button class="btn" name="remove" value="calendar">Disconnect</button>` : ""}</div>
</form>
<form method="post" action="/settings/keys" class="card"><h2>Connections</h2>
<p class="small"><b>AI writing:</b> ${keys.anthropic ? "✅ connected" : "not connected. Drafts use built-in templates."}</p>
<label>Anthropic API key</label><input name="anthropic" type="password" autocomplete="off" placeholder="${keys.anthropic ? "Saved. Paste a new one to replace it." : "sk-ant-…"}">
<p class="small" style="margin-top:14px"><b>Resend (optional, not needed with Gmail):</b> ${keys.resend ? "✅ connected" : keys.gmail ? "not needed, Gmail sends for you." : "not connected."}</p>
<label>Resend API key</label><input name="resend" type="password" autocomplete="off" placeholder="${keys.resend ? "Saved. Paste a new one to replace it." : "re_…"}">
<p class="muted small">Keys are stored encrypted and never shown again.</p>
<div class="row"><button class="btn btn-primary" style="flex:1">Save keys</button></div>
${keys.anthropic || keys.resend ? `<div class="row">${keys.anthropic ? `<button class="btn" name="remove" value="anthropic" style="flex:1">Remove AI key</button>` : ""}${keys.resend ? `<button class="btn" name="remove" value="resend" style="flex:1">Remove email key</button>` : ""}</div>` : ""}
</form>
<div class="card"><h2>Chief's voice</h2>
<p class="small" style="margin:0 0 8px">Chief uses the best deep male voice on this phone. You can pick a different one; it's saved on this phone.</p>
<label for="voicePick">Voice</label><select id="voicePick"><option value="">Best male voice (automatic)</option></select>
<div class="row"><button id="voiceTest" class="btn" type="button" style="flex:1">Hear it</button></div>
<p id="voiceNote" class="muted small" style="margin:8px 0 0"></p>
</div>
<script>
${VOICE_PICK_JS}
(function(){
  var sel = document.getElementById("voicePick"), note = document.getElementById("voiceNote");
  function fill(){
    var saved = ""; try { saved = localStorage.getItem("chiefVoice") || ""; } catch (e) {}
    var males = chiefMaleVoices();
    sel.length = 1;
    var seen = {};
    males.forEach(function(v){
      var label = v.name, code = (v.voiceURI.match(/x-([a-z]{3})-(local|network)/i) || []);
      if (code[1]) label += " · voice " + code[1].toUpperCase() + (code[2] === "network" ? " (online)" : "");
      if (seen[label]) label += " " + (++seen[label]); else seen[label] = 1;
      var o = document.createElement("option"); o.value = v.voiceURI; o.textContent = label + (/premium|enhanced|neural|natural|-network/i.test(v.name + v.voiceURI) ? "  ★" : "");
      if (v.voiceURI === saved) o.selected = true; sel.appendChild(o);
    });
    var cur = chiefPickVoice();
    note.innerHTML = males.length ? "Now using: <b>" + (cur.voice ? cur.voice.name : "default") + "</b>. Voices with ★ sound the most natural."
      : "No male voice is installed on this phone yet. ${VOICE_TIP.replace(/"/g, '\"')}";
  }
  if ("speechSynthesis" in window) { fill(); try { speechSynthesis.addEventListener("voiceschanged", fill); } catch (e) { speechSynthesis.onvoiceschanged = fill; } }
  else note.textContent = "This browser can't speak.";
  sel.addEventListener("change", function(){ try { if (sel.value) localStorage.setItem("chiefVoice", sel.value); else localStorage.removeItem("chiefVoice"); } catch (e) {} fill(); });
  document.getElementById("voiceTest").addEventListener("click", function(){
    var cur = chiefPickVoice(); speechSynthesis.cancel();
    var u = new SpeechSynthesisUtterance("Good morning. You have three new emails, and two replies ready for your yes.");
    if (cur.voice) { u.voice = cur.voice; u.lang = cur.voice.lang; } u.pitch = cur.male ? CHIEF_PITCH : 0.75; u.rate = CHIEF_RATE;
    speechSynthesis.speak(u);
  });
})();
</script>
<form method="post" action="/settings/password" class="card"><h2>Change password</h2>
<label>Current password</label><input name="current" type="password" autocomplete="current-password" required>
<label>New password (12+ characters)</label><input name="next" type="password" autocomplete="new-password" minlength="12" required>
<button class="btn block" style="margin-top:12px">Change password</button></form>
<form method="post" action="/logout"><button class="btn block">Sign out</button></form>`, { tab: "settings", flash });
}


/**
 * Picks the best deep, natural male voice the phone has. Shared by the voice screen and Settings.
 * Voices differ per phone, so a choice made in Settings is saved on that phone.
 */
const VOICE_PICK_JS = String.raw`
var CHIEF_MALE = /\b(aaron|arthur|daniel|evan|fred|gordon|nathan|oliver|tom|alex|reed|rishi|ralph|albert|bruce|junior|lee|rocko|eddy|grandpa|guy|andrew|brian|christopher|eric|davis|david|mark|ryan|thomas|william|liam|james|george|roger|steffan|jason|tony|brandon|kai|luke|male|man)\b/i;
var CHIEF_FEMALE = /\b(samantha|karen|moira|tessa|victoria|allison|ava|susan|zoe|zoey|nicky|joelle|serena|kate|fiona|martha|catherine|veena|kathy|princess|vicki|agnes|flo|grandma|sandy|shelley|zira|aria|jenny|michelle|emma|sonia|libby|natasha|clara|female|woman|susan|siri female)\b/i;
// Android's built-in Google voices use codes instead of names.
var CHIEF_ANDROID_MALE = /x-(iol|iom|tpd|gbd|rjs|aub|aud|gbg|ene|end)-/i, CHIEF_ANDROID_FEMALE = /x-(sfg|iob|iog|tpc|tpf|gba|gbc|aua|auc|enc)-/i;
function chiefVoiceScore(v, lang){
  var n = (v.name || "") + " " + (v.voiceURI || ""), s = 0;
  if (CHIEF_MALE.test(n) || CHIEF_ANDROID_MALE.test(n)) s += 100;
  if (CHIEF_FEMALE.test(n) || CHIEF_ANDROID_FEMALE.test(n)) s -= 200;
  if (/premium/i.test(n)) s += 45; else if (/enhanced|neural|natural|online/i.test(n)) s += 35;
  if (/compact|eloquence/i.test(n)) s -= 15;
  if (/\b(fred|junior|ralph|albert|bruce|grandpa|rocko|eddy|zarvox|trinoids|whisper|bad news|good news|bells|boing|bubbles|cellos|organ|superstar|wobble|jester)\b/i.test(n)) s -= 55; // robotic novelty voices
  if (/-network\b/i.test(n)) s += 8; // Android's higher-quality online voices
  var l = (v.lang || "").toLowerCase().replace("_", "-");
  if (l === lang) s += 12; else if (l.slice(0, 2) === lang.slice(0, 2)) s += 6; else s -= 60;
  if (l === "en-us") s += 4;
  return s;
}
function chiefPickVoice(){
  if (!("speechSynthesis" in window)) return { voice: null, male: false };
  var list = (speechSynthesis.getVoices ? speechSynthesis.getVoices() : []) || [];
  var lang = (navigator.language || "en-US").toLowerCase();
  var saved = null; try { saved = localStorage.getItem("chiefVoice"); } catch (e) {}
  if (saved) for (var i = 0; i < list.length; i++) if (list[i].voiceURI === saved) return { voice: list[i], male: chiefVoiceScore(list[i], lang) >= 60, chosen: true };
  var best = null, bestScore = -1e9;
  for (var j = 0; j < list.length; j++) { var sc = chiefVoiceScore(list[j], lang); if (sc > bestScore) { best = list[j]; bestScore = sc; } }
  return { voice: best, male: bestScore >= 60 };
}
function chiefMaleVoices(){
  var list = ("speechSynthesis" in window && speechSynthesis.getVoices ? speechSynthesis.getVoices() : []) || [];
  var lang = (navigator.language || "en-US").toLowerCase();
  return list.map(function(v){ return { v: v, s: chiefVoiceScore(v, lang) }; })
    .filter(function(x){ return x.s >= 30; })
    .sort(function(a, b){ return b.s - a.s; })
    .map(function(x){ return x.v; });
}
// Slightly deeper and calmer than the voice's default, without sounding processed.
var CHIEF_PITCH = 0.9, CHIEF_RATE = 0.97;
`;

const VOICE_TIP = `On iPhone: Settings › Accessibility › Spoken Content › Voices › English › tap a male voice such as <b>Evan (Enhanced)</b>, <b>Nathan (Enhanced)</b> or <b>Aaron</b> to download it. On Android: Settings › Text-to-speech › Speech Services by Google › Install voice data › English (US) › pick a male voice.`;

const VOICE_CSS = `
.voice{min-height:calc(100dvh - 40px);display:flex;flex-direction:column;align-items:center;text-align:center;gap:14px;padding-top:10px}
.vtop{width:100%;display:flex;justify-content:space-between;align-items:center}.vtop a{font-weight:700;text-decoration:none}
.vorb{width:190px;height:190px;border-radius:50%;margin-top:4vh;border:0;color:#fff;font:inherit;font-weight:800;font-size:1.05rem;
 background:radial-gradient(circle at 35% 30%,#9db7ff,#2f5bd3 60%,#1b2f7a);box-shadow:0 0 0 0 rgba(47,91,211,.5);transition:transform .2s}
.vorb.wake{animation:breathe 3.2s ease-in-out infinite}
.vorb.command,.vorb.confirm{background:radial-gradient(circle at 35% 30%,#a8f0c6,#178a4c 60%,#0c4d2a);animation:pulse 1.2s infinite}
.vorb.working{animation:spin 1s linear infinite;opacity:.85}
.vorb.speaking{background:radial-gradient(circle at 35% 30%,#ffd3a8,#c2410c 60%,#6b2306);animation:talk .8s ease-in-out infinite}
@keyframes breathe{50%{transform:scale(1.04)}}@keyframes pulse{0%{box-shadow:0 0 0 0 rgba(23,138,76,.55)}100%{box-shadow:0 0 0 34px rgba(23,138,76,0)}}
@keyframes talk{50%{transform:scale(1.06)}}@keyframes spin{50%{filter:brightness(1.25)}}
.vstatus{font-weight:800;font-size:1.15rem}.vheard,.vsaid{max-width:560px;width:100%;text-align:left;background:var(--card);border:1px solid var(--border);border-radius:14px;padding:12px 14px;min-height:48px}
.vheard b,.vsaid b{display:block;font-size:.75rem;color:var(--muted);text-transform:uppercase;letter-spacing:.08em;margin-bottom:2px}
.vhints{font-size:.85rem;color:var(--muted);max-width:520px}.vtype{display:flex;gap:8px;width:100%;max-width:560px}.vtype input{flex:1}
.vwarn{color:var(--no);font-weight:600;max-width:520px}
.vdraft{width:100%;max-width:560px;text-align:left;background:var(--card);border:2px solid var(--accent);border-radius:16px;padding:14px 16px}
.vdraft-head{font-weight:800;font-size:1.05rem}.vdraft-meta{font-size:.85rem;color:var(--muted);margin-top:2px}
.vdraft-ctx{font-size:.88rem;background:var(--bg);border-radius:10px;padding:8px 10px;margin-top:8px}
.vdraft-body{white-space:pre-wrap;margin-top:10px;line-height:1.5;max-height:45vh;overflow:auto}
@media (prefers-reduced-motion:reduce){.vorb{animation:none!important}}
`;

export function voicePage(sending: "gmail" | "resend" | "mailto") {
  const sendNote = sending !== "mailto" ? "" : `<p class="vhints">Until Gmail is connected in Settings, “yes” opens your Mail app and you tap Send there, and I can't read your inbox.</p>`;
  return page("Voice", `<style>${VOICE_CSS}</style>
<div class="voice">
  <div class="vtop"><span class="brand">Chief of Staff</span><a href="/review">Manage ›</a></div>
  <button id="orb" class="vorb" type="button">Tap to start</button>
  <div id="status" class="vstatus">Tap once to start listening</div>
  <div id="warn" class="vwarn" hidden></div>
  <div id="voiceTip" class="card small" style="width:100%;max-width:560px;text-align:left" hidden><b>Install a male voice for Chief</b><p style="margin:6px 0 0">Your phone doesn't have a male voice installed yet, so Chief is using a deeper setting on the default voice. ${VOICE_TIP} Then reopen Chief.</p></div>
  <div id="notif" class="card" style="width:100%;max-width:560px;text-align:left" hidden>
    <b>Get a notification when a reply is ready</b>
    <p id="notifText" class="small" style="margin:6px 0 10px">Chief works in the cloud even when your phone is closed, and asks for your yes with a notification.</p>
    <button id="notifBtn" class="btn btn-primary block" type="button">Turn on notifications</button>
  </div>
  <div id="draft" class="vdraft" hidden>
    <div id="draftHead" class="vdraft-head"></div>
    <div id="draftMeta" class="vdraft-meta"></div>
    <div id="draftContext" class="vdraft-ctx" hidden></div>
    <div id="draftBody" class="vdraft-body"></div>
    <div class="row"><button id="draftNo" class="btn btn-no" type="button">No</button><button id="draftYes" class="btn btn-yes" type="button">Yes, send</button></div>
  </div>
  <div class="vheard"><b>You said</b><span id="heard">—</span></div>
  <div class="vsaid"><b>Chief</b><span id="said">Say “Hey Chief” and then what you need.</span></div>
  <p class="vhints">Try: “Hey Chief, brief me.” “…check my inbox.” “…email Dave saying I'll call tomorrow.” “…call Dave.” “…text Dave saying running late.” “…what's on my calendar today?” “…remind me to call Dave at 3.” “…directions to Grace Church.” When I ask “Should I send it?”, just say “yes” or “no”.</p>
  ${sendNote}
  <form id="typed" class="vtype"><input id="typedText" placeholder="Or type a command" autocomplete="off" enterkeyhint="send"><button class="btn">Go</button></form>
</div>
<script>
${VOICE_PICK_JS}
(function(){
  var SR = window.SpeechRecognition || window.webkitSpeechRecognition;
  var $ = function(id){return document.getElementById(id)};
  var S = {on:false, mode:"off", queue:[], cur:null, speaking:false, rec:null, lock:null, timer:null, listening:false};
  var WAKE = /\\b(?:hey|hi|hay|ok|okay|a|yo)[\\s,]+(?:chief|chiefs|cheif|cheef|cheap|chef|sheaf|chiev|keef)\\b[\\s,.!?]*/i;
  var YES = /^(yes|yeah|yep|yup|ya|sure|send( it)?|do it|go ahead|please( do)?|correct|affirmative|ok send|okay send|yes please)\\b/i;
  var NO = /^(no|nope|nah|don'?t|do not|skip|cancel|not now|no thanks|pass)\\b/i;
  var REPEAT = /\\b(repeat|again|say that again|read it again|what\\??)$/i;
  // Questions about the waiting draft: answer by reading it, never as a yes or no.
  var QUESTION = /\\?|^(where|what|what'?s|who|whom|which|how|why|when|is it|is there|did you|can you|could you|would you|will you|read|show|tell me|let me (see|hear)|say (it|that)|repeat|again|i (didn'?t|did not|can'?t|cannot) (hear|see|catch)|hold on|wait)\\b/i;
  var ABOUT_DRAFT = /\\b(reply|draft|email|message|text|it|that|subject|body|what (does|did) it say|read)\\b/i;
  var STOP = /^(stop|that'?s all|quit|enough|later|never ?mind)\\b/i;
  var LABEL = {off:"Tap once to start listening", wake:"Listening for “Hey Chief”", command:"I'm listening…", working:"Working on it…", speaking:"Speaking…", confirm:"Say yes to send, or no to skip"};

  function setMode(m){ S.mode=m; $("status").textContent=LABEL[m]||""; var o=$("orb"); o.className="vorb "+m; o.textContent = m==="off" ? "Tap to start" : (m==="speaking" ? "Tap to interrupt" : ""); }
  function warn(t){ var w=$("warn"); w.hidden=!t; w.textContent=t||""; }

  async function lockScreen(){ try{ if(navigator.wakeLock && S.on){ S.lock = await navigator.wakeLock.request("screen"); } }catch(e){} }
  document.addEventListener("visibilitychange", function(){ if(document.visibilityState==="visible" && S.on){ lockScreen(); listen(); } });

  function listen(){
    if(!SR || !S.on || S.speaking || S.listening) return;
    var r = new SR(); S.rec=r; r.lang = navigator.language || "en-US"; r.continuous = true; r.interimResults = true;
    r.onresult = function(e){
      var interim="";
      for(var i=e.resultIndex;i<e.results.length;i++){
        var t = e.results[i][0].transcript;
        if(e.results[i].isFinal){ heard(t.trim()); } else { interim += t; }
      }
      if(interim && !S.speaking) $("heard").textContent = interim;
    };
    r.onerror = function(e){ if(e.error==="not-allowed"||e.error==="service-not-allowed"){ S.on=false; setMode("off"); warn("The microphone is blocked. Allow it for this site in your phone's settings, then tap the button."); } };
    r.onend = function(){ S.listening=false; S.rec=null; if(S.on && !S.speaking) setTimeout(listen, 250); };
    try{ r.start(); S.listening=true; }catch(e){ S.listening=false; }
  }
  function pauseListening(){ if(S.rec){ try{ S.rec.abort(); }catch(e){} } }

  // ── Chief's voice: the best male voice on this phone ──
  var V = { voice: null, male: false };
  function loadVoice(){
    V = chiefPickVoice();
    $("voiceTip").hidden = !("speechSynthesis" in window) || V.male || !((speechSynthesis.getVoices ? speechSynthesis.getVoices() : []) || []).length;
  }
  if ("speechSynthesis" in window) { loadVoice(); try { speechSynthesis.addEventListener("voiceschanged", loadVoice); } catch (e) { try { speechSynthesis.onvoiceschanged = loadVoice; } catch (e2) {} } }

  function chunks(text){
    // Short pieces read reliably on every phone (long ones get cut off on some).
    var out=[];
    (text.match(/[^.!?]+[.!?]*\\s*/g) || [text]).forEach(function(sent){
      sent = sent.trim(); if(!sent) return;
      while(sent.length > 180){ var cut = sent.lastIndexOf(",", 180); if(cut < 60) cut = sent.lastIndexOf(" ", 180); if(cut < 1) cut = 180; out.push(sent.slice(0, cut+1)); sent = sent.slice(cut+1).trim(); }
      if(sent) out.push(sent);
    });
    return out;
  }
  function speak(text, then){
    if(!text){ if(then) then(); return; }
    $("said").textContent = text;
    S.lastSaid = text.toLowerCase();
    if(!("speechSynthesis" in window)){ if(then) then(); return; }
    S.speaking = true; pauseListening(); setMode("speaking");
    var done=false, token = (S.speakToken = (S.speakToken||0)+1), started = Date.now();
    var parts = chunks(text), lastEnded = false;
    function finish(){
      if(done || token!==S.speakToken) return; done=true;
      // Short pause so the microphone doesn't catch the tail of Chief's own voice.
      setTimeout(function(){ if(token!==S.speakToken) return; S.speaking=false; S.quietUntil = Date.now() + 700; if(then) then(); listen(); }, 350);
    }
    function start(){
      parts.forEach(function(p, i){
        var u = new SpeechSynthesisUtterance(p);
        if (!V.voice) loadVoice();
        if (V.voice) { u.voice = V.voice; u.lang = V.voice.lang; }
        u.pitch = V.male ? CHIEF_PITCH : 0.75; // no male voice installed: lower the default one
        u.rate = CHIEF_RATE;
        if(i===parts.length-1){ u.onend = function(){ lastEnded = true; finish(); }; u.onerror = function(){ lastEnded = true; finish(); }; }
        speechSynthesis.speak(u);
      });
      // Backup for phones that never report the end: wait until the voice has actually gone quiet.
      var words = text.split(/\\s+/).length, cap = 8000 + words * 900;
      (function poll(){
        if(done || token!==S.speakToken) return;
        var quiet = !speechSynthesis.speaking && !speechSynthesis.pending;
        if((quiet && Date.now() - started > 1500) || Date.now() - started > cap) return finish();
        setTimeout(poll, 400);
      })();
    }
    if(speechSynthesis.speaking || speechSynthesis.pending){ speechSynthesis.cancel(); setTimeout(start, 150); } else { start(); }
  }
  function interrupt(){ S.speakToken=(S.speakToken||0)+1; speechSynthesis.cancel(); S.speaking=false; S.queue=[]; S.cur=null; hideDraft(); setMode("wake"); listen(); }

  // ── The draft on screen, and reading it in full ──
  function showDraft(item){
    var d = item.show; if(!d){ hideDraft(); return; }
    $("draftHead").textContent = d.heading || "Draft";
    $("draftMeta").textContent = [d.to ? "To: " + d.to : "", d.subject ? "Subject: " + d.subject : ""].filter(Boolean).join("  ·  ");
    $("draftContext").hidden = !d.context; $("draftContext").textContent = d.context ? "They wrote: " + d.context : "";
    $("draftBody").textContent = d.body || "";
    $("draftYes").textContent = item.yesLabel || "Yes, send";
    $("draft").hidden = false;
    try{ $("draft").scrollIntoView({behavior:"smooth", block:"center"}); }catch(e){}
  }
  function hideDraft(){ $("draft").hidden = true; }
  function spokenBody(body){
    return (body||"").split(/\\n+/).map(function(l){ return l.trim(); }).filter(Boolean).map(function(l){ return /[.!?,:;]$/.test(l) ? l : l + "."; }).join(" ");
  }
  /** Reads the whole item: intro, then the full draft, and only then the question. */
  function present(item, then){
    showDraft(item);
    var d = item.show, full = item.say || "";
    if(d){ full = [full, d.subject ? "Subject: " + d.subject + "." : "", d.body ? spokenBody(d.body) : ""].filter(Boolean).join(" "); }
    speak(full, function(){ if(item.ask) speak(item.ask, then); else if(then) then(); });
  }
  function askAgain(){ present(S.cur, function(){ waitFor("confirm", 45000, timeoutConfirm); }); }
  function timeoutConfirm(){ S.queue=[]; S.cur=null; hideDraft(); speak("I'll keep it for later.", function(){ setMode("wake"); }); }
  $("draftYes").addEventListener("click", function(){ if(S.cur){ clearTimer(); S.speakToken++; speechSynthesis.cancel(); S.speaking=false; decide("yes"); } });
  $("draftNo").addEventListener("click", function(){ if(S.cur){ clearTimer(); S.speakToken++; speechSynthesis.cancel(); S.speaking=false; decide("no"); } });

  function clearTimer(){ if(S.timer){ clearTimeout(S.timer); S.timer=null; } }
  function waitFor(mode, ms, onTimeout){ setMode(mode); clearTimer(); S.timer = setTimeout(function(){ if(S.mode===mode){ onTimeout(); } }, ms); }

  function isEcho(t){
    // Chief hearing itself: what was heard is part of what Chief just said.
    var h = t.toLowerCase().replace(/[^a-z0-9 ]/g, " ").replace(/\\s+/g, " ").trim();
    var said = (S.lastSaid||"").replace(/[^a-z0-9 ]/g, " ").replace(/\\s+/g, " ");
    return h.split(" ").length >= 3 && said.indexOf(h) >= 0;
  }
  function heard(t){
    if(!t || S.speaking || Date.now() < (S.quietUntil||0)) return;
    if(isEcho(t)) return;
    $("heard").textContent = t;
    if(S.mode==="wake"){
      var m = t.match(WAKE); if(!m) return;
      var rest = t.slice(m.index + m[0].length).trim();
      if(rest.length > 2) return command(rest);
      return speak("Yes?", function(){ waitFor("command", 9000, function(){ setMode("wake"); }); });
    }
    if(S.mode==="command"){ clearTimer(); return command(t.replace(WAKE,"").trim()); }
    if(S.mode==="confirm"){
      clearTimer();
      var w = t.match(WAKE), after = w ? t.slice(w.index + w[0].length).trim() : "";
      // "Hey Chief, <something else>" while an email waits: drop the email (it stays saved) and do the new command.
      if(w && after.length > 2 && !YES.test(after) && !NO.test(after) && !ABOUT_DRAFT.test(after)){ S.queue=[]; S.cur=null; hideDraft(); return command(after); }
      return answer((after || t).trim());
    }
  }

  async function post(url, body){
    var res = await fetch(url, {method:"POST", body: body, headers:{"Accept":"application/json"}, credentials:"same-origin"});
    if(res.status===401){ location.href="/login"; throw new Error("signed out"); }
    return res.json();
  }

  async function command(text){
    if(!text) return;
    setMode("working");
    var fd = new FormData(); fd.set("text", text);
    try{
      var r = await post("/api/command", fd);
      speak(r.say || "", function(){
        if(r.queue && r.queue.length){ S.queue = r.queue; next(); } else { setMode("wake"); }
      });
    }catch(e){ speak("I couldn't reach the server. Check your connection.", function(){ setMode("wake"); }); }
  }

  function openIt(url){
    if(window.__chiefOpen) return window.__chiefOpen(url); // used by automated tests
    // Phone links (tel:, sms:) open the phone's own screen; web links open beside the app so Chief stays open.
    if(/^(tel|sms|mailto):/i.test(url)){ location.href = url; } else { var w = window.open(url, "_blank"); if(!w) location.href = url; }
  }
  function next(){
    hideDraft();
    if(!S.queue.length){ S.cur=null; return speak("That's everything for now.", function(){ setMode("wake"); }); }
    S.cur = S.queue.shift();
    if(S.cur.openUrl && !S.cur.confirm){ var u = S.cur.openUrl; return speak(S.cur.say, function(){ openIt(u); next(); }); }
    if(!S.cur.decideUrl && !S.cur.openUrl){
      // Just information: read it, mark it heard, move on.
      var ack = S.cur.ackUrl;
      return speak(S.cur.say, function(){ if(ack){ var fd=new FormData(); post(ack, fd).catch(function(){}); } next(); });
    }
    present(S.cur, function(){ waitFor("confirm", 45000, timeoutConfirm); });
  }

  async function answer(t){
    var a = t.trim();
    // A question is never a yes: read the draft (on screen and aloud), then ask again.
    if(QUESTION.test(a) || REPEAT.test(a)) return speak("Here it is.", askAgain);
    if(STOP.test(a)){ S.queue=[]; S.cur=null; hideDraft(); return speak("Okay. I'll keep the rest for later.", function(){ setMode("wake"); }); }
    var yes = YES.test(a) && !/\\b(or no|not|don'?t|no)\\b/i.test(a.replace(/^(yes|yeah|yep|yup)\\b/i, ""));
    if(yes) return decide("yes");
    if(NO.test(a)) return decide("no");
    speak("I didn't catch a yes or no. " + (S.cur.ask || "Should I send it?"), function(){ waitFor("confirm", 45000, timeoutConfirm); });
  }

  async function decide(d){
    if(!S.cur) return;
    hideDraft();
    if(S.cur.openUrl){
      if(d==="no") return speak("Okay, I won't.", next);
      var u = S.cur.openUrl;
      return speak(/^tel:/.test(u) ? "Calling. Tap the call button." : /^sms:/.test(u) ? "Opening Messages. Tap send." : "Opening it. Tap save.", function(){ openIt(u); setTimeout(next, 1200); });
    }
    setMode("working");
    var fd = new FormData(); fd.set("decision", d);
    try{
      var j = await post(S.cur.decideUrl, fd);
      if(!j.ok) return speak(j.error || "That didn't work.", next);
      if(j.say) return speak(j.say, next);
      if(d==="no") return speak("Skipped.", next);
      if(j.href){ var href=j.href; return speak("Opening Mail. Tap send there.", function(){ location.href = href; setTimeout(next, 1500); }); }
      speak("Sent.", next);
    }catch(e){ speak("I couldn't reach the server.", function(){ setMode("wake"); }); }
  }

  $("orb").addEventListener("click", function(){
    if(S.mode==="speaking") return interrupt();
    if(S.on) return;
    if(!SR){ warn("This browser can't listen. Use Safari on iPhone or Chrome on Android, or type a command below."); }
    S.on = true; warn(""); lockScreen();
    fetch("/api/state",{credentials:"same-origin"}).then(function(r){return r.json()}).then(function(st){
      if(!st.setupDone) return command("set up");
      speak("Chief is listening. Say hey chief, and tell me what you need.", function(){ setMode("wake"); });
    }).catch(function(){ speak("Chief is listening.", function(){ setMode("wake"); }); });
    // Speak reminders when they come due, while the app is open.
    setInterval(function(){
      if(!S.on || S.mode!=="wake" || S.speaking) return;
      fetch("/api/due",{credentials:"same-origin"}).then(function(r){return r.json()}).then(function(j){ if(j.say && S.mode==="wake") speak(j.say, function(){ setMode("wake"); }); }).catch(function(){});
    }, 60000);
  });
  // ── Notifications (Web Push) ──
  var isIOS = /iPhone|iPad|iPod/.test(navigator.userAgent);
  var standalone = window.matchMedia("(display-mode: standalone)").matches || navigator.standalone === true;
  if ("serviceWorker" in navigator) navigator.serviceWorker.register("/sw.js").catch(function(){});
  function b64ToBytes(s){ s = s.replace(/-/g,"+").replace(/_/g,"/"); while(s.length%4) s+="="; var b=atob(s), u=new Uint8Array(b.length); for(var i=0;i<b.length;i++) u[i]=b.charCodeAt(i); return u; }
  function showNotifCard(){
    var card=$("notif"), btn=$("notifBtn"), txt=$("notifText");
    var pushOK = "serviceWorker" in navigator && "PushManager" in window && "Notification" in window;
    if(isIOS && !standalone){ card.hidden=false; btn.hidden=true; txt.innerHTML="On iPhone, notifications need Chief on your Home Screen: tap <b>Share</b>, then <b>Add to Home Screen</b>, then open Chief from there."; return; }
    if(!pushOK){ card.hidden=true; return; }
    if(Notification.permission==="granted"){ subscribe(true); card.hidden=true; return; }
    if(Notification.permission==="denied"){ card.hidden=false; btn.hidden=true; txt.textContent="Notifications are blocked for Chief. Turn them on in your phone's settings for this app."; return; }
    card.hidden=false;
  }
  async function subscribe(quiet){
    try{
      var reg = await navigator.serviceWorker.ready;
      var sub = await reg.pushManager.getSubscription();
      if(!sub){
        var k = await (await fetch("/api/push-key",{credentials:"same-origin"})).json();
        sub = await reg.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: b64ToBytes(k.key) });
      } else if(quiet){ /* already on: refresh it on the server */ }
      await fetch("/api/push-subscribe",{method:"POST",credentials:"same-origin",headers:{"Content-Type":"application/json"},body:JSON.stringify(sub)});
      $("notif").hidden = true;
    }catch(e){ if(!quiet){ $("notifText").textContent="Couldn't turn on notifications here. "+(e&&e.message?e.message:""); } }
  }
  $("notifBtn").addEventListener("click", function(){
    Notification.requestPermission().then(function(p){ if(p==="granted") subscribe(false); else showNotifCard(); });
  });
  showNotifCard();

  $("typed").addEventListener("submit", function(e){
    e.preventDefault(); var t=$("typedText").value.trim(); if(!t) return; $("typedText").value="";
    if(!S.on){ S.on=true; lockScreen(); }
    $("heard").textContent = t;
    if(S.mode==="confirm"){ clearTimer(); answer(t); } else { command(t.replace(WAKE,"")); }
  });
})();
</script>`, { bare: true });
}
