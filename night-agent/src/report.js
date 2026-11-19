/** The morning report as a phone-friendly page (no scripts; every link is a source). */
import { esc, jamaicaTime, prettyNight } from "./util.js";

const CSS = `:root{color-scheme:light dark;--bg:#f5f3ee;--card:#fff;--ink:#1c1d1a;--ink2:#53584f;--line:#e2ddd2;--brand:#1f4e8c;--ok:#17633f;--warn:#9a5b00;--bad:#b3261e}
@media (prefers-color-scheme:dark){:root{--bg:#121411;--card:#1b1e19;--ink:#ecebe6;--ink2:#a9ada3;--line:#30342d;--brand:#8db4ef;--ok:#6cc48f;--warn:#e5a54a;--bad:#f08a80}}
*{box-sizing:border-box}body{margin:0;background:var(--bg);color:var(--ink);font:16px/1.5 -apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,sans-serif}
main{max-width:760px;margin:0 auto;padding:16px 16px 48px}h1{font-size:1.55rem;margin:.2em 0 .1em}h2{font-size:1.2rem;margin:0 0 .3em}h3{font-size:1rem;margin:1em 0 .3em}
a{color:var(--brand)}.card{background:var(--card);border:1px solid var(--line);border-radius:14px;padding:16px;margin:12px 0}
.muted{color:var(--ink2);font-size:.92rem}.top{display:flex;justify-content:space-between;align-items:center;gap:8px;flex-wrap:wrap}
.score{font-size:1.6rem;font-weight:800;color:var(--brand)}.bars{display:grid;grid-template-columns:auto 1fr auto;gap:4px 8px;align-items:center;font-size:.88rem;margin:8px 0}
.bar{height:8px;border-radius:4px;background:var(--line);overflow:hidden}.bar i{display:block;height:100%;background:var(--brand)}
blockquote{margin:8px 0;padding:8px 12px;border-left:3px solid var(--line);background:color-mix(in srgb,var(--line) 25%,transparent);border-radius:0 8px 8px 0}
.src{font-size:.85rem}.tag{display:inline-block;font-size:.75rem;font-weight:700;border-radius:999px;padding:1px 8px;margin-left:4px}
.ok{background:color-mix(in srgb,var(--ok) 18%,transparent);color:var(--ok)}.warn{background:color-mix(in srgb,var(--warn) 18%,transparent);color:var(--warn)}.bad{background:color-mix(in srgb,var(--bad) 15%,transparent);color:var(--bad)}
.status{padding:12px 14px;border-radius:12px;font-weight:600}.status.done{background:color-mix(in srgb,var(--ok) 15%,transparent)}.status.stopped{background:color-mix(in srgb,var(--warn) 18%,transparent)}
button,.btn{font:inherit;font-weight:700;border:0;border-radius:10px;padding:10px 16px;background:var(--brand);color:#fff;cursor:pointer;text-decoration:none;display:inline-block}
.btn2{background:transparent;color:var(--ink);border:1px solid var(--line)}input{font:inherit;width:100%;padding:12px;border:1px solid var(--line);border-radius:10px;background:var(--card);color:var(--ink)}
details summary{cursor:pointer;font-weight:600}nav{display:flex;gap:10px;flex-wrap:wrap;margin:8px 0}`;

export function page(title, body) {
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="robots" content="noindex,nofollow"><title>${esc(title)}</title><style>${CSS}</style></head><body><main>${body}</main></body></html>`;
}
export const nav = `<nav><a href="/">Dashboard</a><a href="/history">Reports</a><a href="/ideas">Ideas</a><a href="/leads">Leads</a><a href="/settings">Settings</a></nav>`;
const who = (w) => w || "Poster (details not confirmed)";
const buildBtn = (id) => `<form method="post" action="/idea/${esc(encodeURIComponent(id))}/build" style="margin-top:10px"><button>Yes, build this</button></form>`;
const link = (s) => `<a href="${esc(s.url)}" rel="noopener noreferrer nofollow" target="_blank">${esc(s.domain || "source")}</a>${s.verified === true ? `<span class="tag ok" title="The quote's words were found on this page">quote found on page</span>` : ""}`;
const bars = (s) => `<div class="bars">${[["How many people have it", s.people], ["Already pay for a fix", s.pays], ["How angry they are", s.anger], ["How fast to build", s.buildSpeed]].map(([k, v]) => `<span>${k}</span><span class="bar"><i style="width:${v * 10}%"></i></span><b>${v}</b>`).join("")}</div>`;

export function reportPage(r, { notice = "" } = {}) {
  if (!r) return page("Night Agent", `<h1>Night Agent</h1>${nav}${notice}<div class="card"><h2>No report yet</h2><p>The Scout runs every night from 1:00 to 5:00 a.m. Jamaica time. The first morning report appears here after its first night.</p><p class="muted">To try it now, use <b>Run one step now</b> in <a href="/settings">Settings</a> (after adding your Gemini key).</p></div>`);
  const status = r.stopped ? `<div class="status stopped">⚠️ Stopped early: ${esc(r.stopped.message)} <span class="muted">(${esc(jamaicaTime(r.stopped.at))} Jamaica time)</span></div>`
    : r.cutShort ? `<div class="status stopped">The night ended before every step finished. This report has what was done.</div>` : `<div class="status done">✅ Finished ${esc(jamaicaTime(r.finishedAt))} Jamaica time.</div>`;
  const problems = r.problems.map((p, i) => `<section class="card"><div class="top"><h2>${i + 1}. ${esc(p.title)}</h2><span class="score">${p.total}<span class="muted">/10</span></span></div>
    <p>${esc(p.summary)}</p><p class="muted"><b>Who:</b> ${esc(p.who)} · <b>${p.complaints.length}</b> complaint${p.complaints.length === 1 ? "" : "s"} with proof</p>${bars(p.scores)}<p class="muted"><b>Why these scores:</b> ${esc(p.why)}</p>
    <h3>What people said</h3>${p.complaints.map((c) => `<blockquote>“${esc(c.quote)}”<div class="muted">— ${esc(who(c.who))}${c.pays && c.pays !== "unknown" ? ` · pays: ${esc(c.pays)}` : ""}</div><div class="src">${c.kind === "job" ? `<span class="tag warn">Job ad</span> ` : "Proof: "}${c.sources.map(link).join(" · ")}</div></blockquote>`).join("")}
    <h3>Competitors</h3>${p.competitors.length ? p.competitors.map((c) => `<div><b>${esc(c.name)}</b> — ${c.price ? `${esc(c.price)} <span class="src">(${c.priceSources.map(link).join(", ")})</span>` : `<span class="muted">price not found</span>`}
      ${c.dislikes ? `<div class="muted">Users dislike: ${esc(c.dislikes)} <span class="src">(${c.dislikeSources.map(link).join(", ")})</span></div>` : ""}<div class="src">Source: ${c.sources.map(link).join(", ")}</div></div>`).join("<hr>")
      : `<p class="muted">${r.problems.indexOf(p) < 5 ? "No competitor facts with proof were found." : "Only the top 5 problems are checked for competitors."}</p>`}${buildBtn(`${r.id}-${p.key}`)}</section>`).join("");
  const loose = !r.grouped && r.complaints.length ? `<section class="card"><h2>Complaints found (not grouped)</h2><p class="muted">The Scout stopped before it could group these into problems.</p>${r.complaints.map((c) => `<blockquote>“${esc(c.quote)}”<div class="muted">— ${esc(who(c.who))}</div><div class="src">${c.kind === "job" ? `<span class="tag warn">Job ad</span> ` : "Proof: "}${c.sources.map(link).join(" · ")}</div></blockquote>`).join("")}</section>` : "";
  return page(`Night Agent · ${r.id}`, `<h1>Morning report</h1><p class="muted">${esc(prettyNight(r.id.slice(0, 10)))}${r.id.endsWith("-test") ? " · test run" : ""}</p>${nav}${notice}${status}
    <div class="card"><b>${r.problems.length}</b> new problem${r.problems.length === 1 ? "" : "s"} · <b>${r.complaints.length}</b> pieces of evidence with proof${r.jobAds ? ` (${r.jobAds} job ad${r.jobAds === 1 ? "" : "s"})` : ""} · <b>${r.searches}</b> of ${r.searchesPlanned} searches · ${r.calls} Gemini calls${r.model ? ` (${esc(r.model)})` : ""}
    <p class="muted">Every quote and fact below links to the page Google Search found it on. Anything without proof was left out, and so were ideas from earlier reports.</p></div>
    ${problems || (r.grouped ? `<div class="card"><p>No new problems with proof tonight.</p></div>` : "")}${loose}
    ${leadsCard(r.leads || [], "Leads from this night")}
    <details class="card"><summary>Night log</summary><ul class="muted">${r.log.map((l) => `<li>${esc(jamaicaTime(l.at))}: ${esc(l.msg)}</li>`).join("")}</ul></details>`);
}

export function historyPage(index) {
  return page("Night Agent · past nights", `<h1>Past nights</h1>${nav}${index.length ? index.map((x) => `<div class="card"><div class="top"><a href="/night/${esc(x.id)}"><b>${esc(prettyNight(x.id.slice(0, 10)))}</b>${x.id.endsWith("-test") ? " (test run)" : ""}</a><span class="tag ${x.status === "done" ? "ok" : "warn"}">${x.status === "done" ? "finished" : "stopped early"}</span></div>
    <div class="muted">${x.problems} new problems · ${x.complaints} complaints${x.stopped ? ` · ${esc(x.stopped)}` : ""}</div>${x.top.length ? `<ol>${x.top.map((t) => `<li>${esc(t)}</li>`).join("")}</ol>` : ""}</div>`).join("") : `<div class="card">No nights yet.</div>`}`);
}

export function settingsPage({ hasKey, models, live, alerts, msg, email }) {
  return page("Night Agent · settings", `<h1>Settings</h1>${nav}${msg ? `<div class="card status done">${esc(msg)}</div>` : ""}
    <div class="card"><h2>Gemini</h2><p>API key: ${hasKey ? `<span class="tag ok">saved</span>` : `<span class="tag bad">missing</span> Add <code>GEMINI_API_KEY</code> as a secret on the <b>night-agent</b> Worker in Cloudflare.`}</p>
    <p class="muted">Models it will try, in order: ${esc(models)}. Only Google's free tier is used: no billing is ever set up by this app.</p></div>
    <div class="card"><h2>Morning email (6:00 a.m. Jamaica time)</h2><p>To: <b>${esc(email.to || "not set")}</b> · Resend key: ${email.hasKey ? `<span class="tag ok">saved</span>` : `<span class="tag bad">missing</span> Add <code>RESEND_API_KEY</code> as a secret on the <b>night-agent</b> Worker.`}</p><p class="muted">This morning: ${esc(email.status)}</p>
    <form method="post" action="/email-now"><button class="btn btn2">Send this morning's email now</button></form></div>
    <div class="card"><h2>Tonight</h2><p class="muted">Runs every 5 minutes from 1:00 to 4:55 a.m. Jamaica time.${live ? ` Last progress: ${esc(live)}` : ""}</p>
    <form method="post" action="/run"><button>Run one step now</button></form><p class="muted">Does one small step of a test night (one Gemini call) and shows the result. It can take a minute or two.</p></div>
    <div class="card"><h2>Phone alert</h2>${alerts ? `<p>On. Install the free <b>ntfy</b> app and subscribe to this topic: <code>${esc(alerts)}</code></p><form method="post" action="/alerts"><input type="hidden" name="off" value="1"><button class="btn btn2">Turn off</button></form>`
      : `<p class="muted">Get a notification when the morning report is ready (free ntfy app, no account).</p><form method="post" action="/alerts"><button>Turn on</button></form>`}</div>
    <form method="post" action="/logout"><button class="btn btn2">Sign out</button></form>`);
}

export function authPage(mode, err = "") {
  const title = mode === "setup" ? "Choose a passcode" : "Sign in";
  return page(`Night Agent · ${title}`, `<h1>Night Agent</h1><div class="card"><h2>${title}</h2>${mode === "setup" ? `<p class="muted">First visit: choose the passcode that protects your reports (at least 8 characters).</p>` : ""}
    ${err ? `<p class="status stopped">${esc(err)}</p>` : ""}<form method="post" action="/${mode === "setup" ? "setup" : "login"}"><input type="password" name="passcode" autocomplete="${mode === "setup" ? "new-password" : "current-password"}" minlength="8" required placeholder="Passcode"><p><button>${mode === "setup" ? "Save passcode" : "Sign in"}</button></p></form></div>`);
}

function leadsCard(leads, title) {
  return `<section class="card"><h2>${esc(title)}${leads.length ? ` (${leads.length})` : ""}</h2><p class="muted">Public posts where someone asked for software like this, and public job ads for work software could do. Never contacted.</p>${leads.length ? leads.map((l) => `<blockquote>“${esc(l.quote)}”<div class="muted">— ${esc(who(l.who))}${l.pays && l.pays !== "unknown" ? ` · pays: ${esc(l.pays)}` : ""}${l.idea ? ` · idea: ${l.ideaId ? `<a href="/idea/${esc(encodeURIComponent(l.ideaId))}">${esc(l.idea)}</a>` : esc(l.idea)}` : ""}${l.night ? ` · ${esc(l.night)}` : ""}</div><div class="src">${l.kind === "job" ? `<span class="tag warn">Job ad</span> ` : "Post: "}${l.sources.map(link).join(" · ")}</div></blockquote>`).join("") : "<p>No leads yet.</p>"}</section>`;
}

/** Home: the latest night at a glance, this morning's email, and the top ideas with "Yes, build this". */
export function dashboardPage({ r, email, totals }) {
  const head = `<h1>Night Agent</h1><p class="muted">Your private dashboard. The Scout runs 1:00–4:55 a.m. and emails you at 6:00 a.m. Jamaica time.</p>${nav}`;
  const stats = `<div class="card"><b>${totals.nights}</b> night${totals.nights === 1 ? "" : "s"} · <b>${totals.ideas}</b> ideas saved · <b>${totals.leads}</b> leads saved · ${totals.built} chosen to build</div>`;
  if (!r) return page("Night Agent", `${head}${stats}<div class="card"><h2>No report yet</h2><p>The first morning report appears here after the first night (with your Gemini key added).</p><p class="muted">Email: ${esc(email)}</p></div>`);
  return page("Night Agent", `${head}${stats}<div class="card"><div class="top"><h2>Last night: ${esc(prettyNight(r.id.slice(0, 10)))}${r.id.endsWith("-test") ? " (test)" : ""}</h2><a href="/night/${esc(r.id)}">Full report</a></div>
    ${r.stopped ? `<p class="status stopped">⚠️ Stopped early: ${esc(r.stopped.message)}</p>` : `<p class="status done">✅ ${r.cutShort ? "Ran out of time before finishing" : "Finished"}</p>`}
    <p>${r.searches} of ${r.searchesPlanned} searches · ${r.complaints.length} complaints with proof · ${r.problems.length} new ideas · ${(r.leads || []).length} leads · ${r.calls} Gemini calls</p><p class="muted">Email: ${esc(email)}</p></div>
    ${r.problems.slice(0, 3).map((p, i) => `<section class="card"><div class="top"><h2>${i + 1}. ${esc(p.title)}</h2><span class="score">${p.total}<span class="muted">/10</span></span></div><p>${esc(p.summary)}</p>
      ${p.complaints.slice(0, 1).map((c) => `<blockquote>“${esc(c.quote)}”<div class="src">${c.kind === "job" ? `<span class="tag warn">Job ad</span> ` : "Proof: "}${c.sources.map(link).join(" · ")}</div></blockquote>`).join("")}<a href="/idea/${esc(encodeURIComponent(`${r.id}-${p.key}`))}">See the idea</a>${buildBtn(`${r.id}-${p.key}`)}</section>`).join("")}`);
}

export function monthNav(base, months, current) {
  return months.length > 1 ? `<nav>${months.map((m) => m === current ? `<b>${esc(m)}</b>` : `<a href="${base}?month=${esc(m)}">${esc(m)}</a>`).join("")}</nav>` : "";
}

/** Every idea ever found (saved for good), month by month, best first. */
export function ideasPage({ ideas, months, month, built }) {
  const list = [...ideas].sort((a, b) => b.total - a.total);
  return page("Night Agent · ideas", `<h1>All ideas</h1>${nav}<p class="muted">Every idea the Scout has found, saved for good. ${esc(month || "")}</p>${monthNav("/ideas", months, month)}
    ${list.length ? list.map((x) => `<section class="card"><div class="top"><h2><a href="/idea/${esc(encodeURIComponent(x.id))}">${esc(x.title)}</a></h2><span class="score">${x.total}<span class="muted">/10</span></span></div>
      <p>${esc(x.summary)}</p><p class="muted">${esc(prettyNight(x.night.slice(0, 10)))} · ${x.complaints.length} proof${x.complaints.length === 1 ? "" : "s"} · ${x.competitors.length} competitor${x.competitors.length === 1 ? "" : "s"}${built[x.id] ? ` · <span class="tag ok">chosen to build</span>` : ""}</p>${buildBtn(x.id)}</section>`).join("") : `<div class="card">No ideas saved yet.</div>`}`);
}

export function ideaPage(x, built) {
  return page(`Night Agent · ${x.title}`, `<h1>${esc(x.title)}</h1>${nav}<section class="card"><div class="top"><span class="muted">Found ${esc(prettyNight(x.night.slice(0, 10)))} · <a href="/night/${esc(x.night)}">that night's report</a></span><span class="score">${x.total}<span class="muted">/10</span></span></div>
    <p>${esc(x.summary)}</p><p class="muted"><b>Who:</b> ${esc(x.who)}</p>${bars(x.scores)}<p class="muted"><b>Why these scores:</b> ${esc(x.why)}</p>
    <h3>What people said</h3>${x.complaints.map((c) => `<blockquote>“${esc(c.quote)}”<div class="muted">— ${esc(who(c.who))}${c.pays && c.pays !== "unknown" ? ` · pays: ${esc(c.pays)}` : ""}</div><div class="src">${c.kind === "job" ? `<span class="tag warn">Job ad</span> ` : "Proof: "}${c.sources.map(link).join(" · ")}</div></blockquote>`).join("")}
    <h3>Competitors</h3>${x.competitors.length ? x.competitors.map((c) => `<div><b>${esc(c.name)}</b> — ${c.price ? `${esc(c.price)} <span class="src">(${c.priceSources.map(link).join(", ")})</span>` : `<span class="muted">price not found</span>`}${c.dislikes ? `<div class="muted">Users dislike: ${esc(c.dislikes)} <span class="src">(${c.dislikeSources.map(link).join(", ")})</span></div>` : ""}</div>`).join("<hr>") : `<p class="muted">None found with proof.</p>`}
    ${built ? `<p><span class="tag ok">Chosen to build ${esc(built.slice(0, 10))}</span> <a href="/idea/${esc(encodeURIComponent(x.id))}/prompt">See the build prompt</a></p>` : buildBtn(x.id)}</section>`);
}

export function promptPage(x, text) {
  return page(`Night Agent · build prompt`, `<h1>Build prompt</h1>${nav}<section class="card"><h2>${esc(x.title)}</h2><p class="muted">Paste this into Claude Code. It's built only from the saved evidence: real quotes, their links, the scores and the competitors.</p>
    <textarea id="prompt" readonly rows="18" style="width:100%;font:13px/1.45 ui-monospace,Menlo,monospace;padding:10px;border:1px solid var(--line);border-radius:10px;background:var(--card);color:var(--ink)">${esc(text)}</textarea>
    <p><button type="button" data-copy="prompt">Copy prompt</button> <span class="muted" id="copied"></span></p></section><script src="/copy.js"></script>`);
}

export function leadsPage({ leads, months, month }) {
  return page("Night Agent · leads", `<h1>All leads</h1>${nav}<p class="muted">Every lead the Scout has found, saved for good. Public posts only; nobody is contacted in stage 1.</p>${monthNav("/leads", months, month)}${leadsCard([...leads].reverse(), month ? `Leads, ${month}` : "Leads")}`);
}
