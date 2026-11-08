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
<meta name="apple-mobile-web-app-title" content="Chief of Staff"><title>${esc(title)} · Chief of Staff</title><style>${CSS}</style></head><body>
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
<div class="card"><h2>Recent drafting runs</h2>${d.runs.length ? `<table>${d.runs.map((r) => `<tr><td class="small">${fmt(r.at)}</td><td class="small">${r.trigger === "cron" ? "Morning" : "Manual"}</td><td class="small">${esc(r.note ?? "")}</td></tr>`).join("")}</table>` : `<p class="muted">None yet. The first one runs tomorrow morning.</p>`}</div>`, { tab: "dashboard" });
}

export function settingsPage(s: Settings, keys: { anthropic: boolean; resend: boolean; gmail: boolean }, flash?: string) {
  const f = (name: keyof Settings, label: string, ph = "", type = "text") =>
    `<label>${label}</label><input name="${name}" type="${type}" value="${esc(s[name])}" placeholder="${esc(ph)}" maxlength="300">`;
  return page("Settings", `<h1>Settings</h1>
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
<form method="post" action="/settings/keys" class="card"><h2>Connections</h2>
<p class="small"><b>AI writing:</b> ${keys.anthropic ? "✅ connected" : "not connected. Drafts use built-in templates."}</p>
<label>Anthropic API key</label><input name="anthropic" type="password" autocomplete="off" placeholder="${keys.anthropic ? "Saved. Paste a new one to replace it." : "sk-ant-…"}">
<p class="small" style="margin-top:14px"><b>Resend (optional, not needed with Gmail):</b> ${keys.resend ? "✅ connected" : keys.gmail ? "not needed, Gmail sends for you." : "not connected."}</p>
<label>Resend API key</label><input name="resend" type="password" autocomplete="off" placeholder="${keys.resend ? "Saved. Paste a new one to replace it." : "re_…"}">
<p class="muted small">Keys are stored encrypted and never shown again.</p>
<div class="row"><button class="btn btn-primary" style="flex:1">Save keys</button></div>
${keys.anthropic || keys.resend ? `<div class="row">${keys.anthropic ? `<button class="btn" name="remove" value="anthropic" style="flex:1">Remove AI key</button>` : ""}${keys.resend ? `<button class="btn" name="remove" value="resend" style="flex:1">Remove email key</button>` : ""}</div>` : ""}
</form>
<form method="post" action="/settings/password" class="card"><h2>Change password</h2>
<label>Current password</label><input name="current" type="password" autocomplete="current-password" required>
<label>New password (12+ characters)</label><input name="next" type="password" autocomplete="new-password" minlength="12" required>
<button class="btn block" style="margin-top:12px">Change password</button></form>
<form method="post" action="/logout"><button class="btn block">Sign out</button></form>`, { tab: "settings", flash });
}

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
  <div class="vheard"><b>You said</b><span id="heard">—</span></div>
  <div class="vsaid"><b>Chief</b><span id="said">Say “Hey Chief” and then what you need.</span></div>
  <p class="vhints">Try: “Hey Chief, brief me.” “Hey Chief, check my inbox.” “Hey Chief, write an email to Grace Church.” “Hey Chief, remember to call Pastor Dave.” “Hey Chief, give me my dashboard.” When I ask “Should I send it?”, just say “yes” or “no”.</p>
  ${sendNote}
  <form id="typed" class="vtype"><input id="typedText" placeholder="Or type a command" autocomplete="off" enterkeyhint="send"><button class="btn">Go</button></form>
</div>
<script>
(function(){
  var SR = window.SpeechRecognition || window.webkitSpeechRecognition;
  var $ = function(id){return document.getElementById(id)};
  var S = {on:false, mode:"off", queue:[], cur:null, speaking:false, rec:null, lock:null, timer:null, listening:false};
  var WAKE = /\\b(?:hey|hi|hay|ok|okay|a|yo)[\\s,]+(?:chief|chiefs|cheif|cheef|cheap|chef|sheaf|chiev|keef)\\b[\\s,.!?]*/i;
  var YES = /^(yes|yeah|yep|yup|ya|sure|send( it)?|do it|go ahead|please( do)?|correct|affirmative|ok send|okay send|yes please)\\b/i;
  var NO = /^(no|nope|nah|don'?t|do not|skip|cancel|not now|no thanks|pass)\\b/i;
  var REPEAT = /\\b(repeat|again|say that again|read it again|what\\??)$/i;
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

  function speak(text, then){
    $("said").textContent = text;
    if(!("speechSynthesis" in window)){ if(then) then(); return; }
    S.speaking = true; pauseListening(); setMode("speaking");
    speechSynthesis.cancel();
    var done=false, token = (S.speakToken = (S.speakToken||0)+1);
    function finish(){ if(done || token!==S.speakToken) return; done=true; S.speaking=false; if(then) then(); listen(); }
    var parts = text.match(/[^.!?]+[.!?]*/g) || [text];
    parts.forEach(function(p, i){
      var u = new SpeechSynthesisUtterance(p.trim()); u.rate = 1.02;
      if(i===parts.length-1){ u.onend = u.onerror = finish; }
      speechSynthesis.speak(u);
    });
    // Some phones never report the end of speech; move on after the expected time anyway.
    setTimeout(finish, 2500 + text.split(/\s+/).length * 420);
  }
  function interrupt(){ S.speakToken=(S.speakToken||0)+1; speechSynthesis.cancel(); S.speaking=false; S.queue=[]; S.cur=null; setMode("wake"); listen(); }

  function clearTimer(){ if(S.timer){ clearTimeout(S.timer); S.timer=null; } }
  function waitFor(mode, ms, onTimeout){ setMode(mode); clearTimer(); S.timer = setTimeout(function(){ if(S.mode===mode){ onTimeout(); } }, ms); }

  function heard(t){
    if(!t || S.speaking) return;
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
      if(w && after.length > 2 && !YES.test(after) && !NO.test(after)){ S.queue=[]; S.cur=null; return command(after); }
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
      speak(r.say, function(){
        if(r.queue && r.queue.length){ S.queue = r.queue; next(); } else { setMode("wake"); }
      });
    }catch(e){ speak("I couldn't reach the server. Check your connection.", function(){ setMode("wake"); }); }
  }

  function next(){
    if(!S.queue.length){ S.cur=null; return speak("That's everything for now.", function(){ setMode("wake"); }); }
    S.cur = S.queue.shift();
    if(!S.cur.decideUrl){
      // Just information: read it, mark it heard, move on.
      var ack = S.cur.ackUrl;
      return speak(S.cur.say, function(){ if(ack){ var fd=new FormData(); post(ack, fd).catch(function(){}); } next(); });
    }
    speak(S.cur.say, function(){ waitFor("confirm", 30000, function(){ S.queue=[]; S.cur=null; speak("I'll keep it for later.", function(){ setMode("wake"); }); }); });
  }

  async function answer(t){
    if(YES.test(t)) return decide("yes");
    if(NO.test(t)) return decide("no");
    if(STOP.test(t)){ S.queue=[]; S.cur=null; return speak("Okay. I'll keep the rest for later.", function(){ setMode("wake"); }); }
    if(REPEAT.test(t)) return speak(S.cur.say, function(){ waitFor("confirm", 30000, function(){ setMode("wake"); }); });
    speak("Should I send it? Say yes or no.", function(){ waitFor("confirm", 30000, function(){ setMode("wake"); }); });
  }

  async function decide(d){
    setMode("working");
    var fd = new FormData(); fd.set("decision", d);
    try{
      var j = await post(S.cur.decideUrl, fd);
      if(!j.ok) return speak(j.error || "That didn't work.", next);
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
    speak("Chief is listening. Say hey chief, and tell me what you need.", function(){ setMode("wake"); });
  });
  $("typed").addEventListener("submit", function(e){
    e.preventDefault(); var t=$("typedText").value.trim(); if(!t) return; $("typedText").value="";
    if(!S.on){ S.on=true; lockScreen(); }
    $("heard").textContent = t;
    if(S.mode==="confirm"){ clearTimer(); answer(t); } else { command(t.replace(WAKE,"")); }
  });
})();
</script>`, { bare: true });
}
