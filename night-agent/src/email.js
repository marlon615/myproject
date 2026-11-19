/**
 * The 6:00 a.m. (Jamaica) email: short and clear — what the agent did overnight, the top 3 ideas with proof, and up to
 * 10 leads. Sent through Resend's free plan (RESEND_API_KEY secret) to REPORT_EMAIL. Sent once per morning (remembered
 * in KV), and only to you: nobody else is ever contacted in stage 1.
 */
import { esc, getJSON, putJSON, jamaica, jamaicaTime, prettyNight } from "./util.js";

const who = (w) => w || "Poster (details not confirmed)";
const short = (s, n) => (s.length > n ? `${s.slice(0, n - 1).trimEnd()}…` : s);

export function buildEmail(r, night, st, site) {
  const day = prettyNight(night);
  if (!r) {
    const why = st?.stopped?.message || (st ? "The night's work didn't finish." : "The agent didn't run last night.");
    return { subject: `Night Agent: no report for ${day}`, text: `No morning report for ${day}.\n${why}\n\nDashboard: ${site}/`, html: `<p>No morning report for ${esc(day)}.</p><p>${esc(why)}</p><p><a href="${esc(site)}/">Open your dashboard</a></p>` };
  }
  const top = r.problems.slice(0, 3), leads = r.leads || [];
  const did = `${r.texts ?? r.searches ?? 0} public texts read (Hacker News, Stack Exchange, App Store reviews, job boards) · ${r.complaints.length} pieces of evidence with proof${r.jobAds ? ` (${r.jobAds} job ad${r.jobAds === 1 ? "" : "s"})` : ""} · ${r.problems.length} new idea${r.problems.length === 1 ? "" : "s"} · ${r.calls} Gemini calls${r.stopped ? ` · stopped early: ${r.stopped.message}` : r.cutShort ? " · ran out of time before finishing" : ""}`;
  const subject = top.length ? `Night Agent: ${top.length} idea${top.length === 1 ? "" : "s"} for ${day}${r.stopped ? " (stopped early)" : ""}` : `Night Agent: no new ideas for ${day}${r.stopped ? " (stopped early)" : ""}`;
  // Every job ad the night found, qualified or not (from the permanent database).
  const ads = r.allJobAds || [], qn = ads.filter((x) => x.qualified).length, tot = r.jobAdsTotals;
  const jobHead = r.allJobAdsError ? r.allJobAdsError : r.allJobAds ? `JOB ADS FOUND (${ads.length}, ${qn} qualified${tot ? ` · ${tot.total} saved in all, ${tot.qualified} qualified` : ""})` : "";
  const jobsText = jobHead ? [jobHead, ...ads.map((x, i) => `${i + 1}. ${x.qualified ? "[QUALIFIED]" : "[not qualified]"} ${x.company || "Company not given"} — ${x.role || "role not given"} · ${x.url} · found ${x.firstFound}`), ...(ads.length ? ["Qualified = a word-for-word quote in the ad was kept as proof of paid repetitive work."] : []), ""] : [];
  // Ideas already sent before that got new proof: a short section at the very bottom, never as new ideas.
  const ups = r.updates || [];
  const updText = ups.length ? ["UPDATE ON PAST IDEAS (already sent before; new proof tonight)", ...ups.flatMap((u) => [`- ${u.title} (first sent ${u.firstDate}): ${u.complaints.length} new proof${u.complaints.length === 1 ? "" : "s"}`,
    ...u.complaints.slice(0, 2).map((c) => `   ${c.kind === "job" ? "[Job ad] " : ""}"${short(c.quote, 140)}" (${c.sources[0]?.url})`)]), ""] : [];
  const proofText = (c) => `${c.kind === "job" ? "[Job ad] " : ""}"${short(c.quote, 160)}" — ${who(c.who)} (${c.sources[0]?.url})`;
  const left = (r.dropped || []).length ? `Left out ${r.dropped.length} idea${r.dropped.length === 1 ? "" : "s"} that weren't good enough: ${r.dropped.map((d) => `${short(d.title, 60)} (${d.why})`).join("; ")}` : "";
  const text = [`Night Agent — ${day}`, "", "OVERNIGHT", did, ...(r.sourcesNote || []), ...(left ? [left] : []), "",
    top.length ? "TOP IDEAS (each: one buyer, the product to build, a suggested price, and at least 3 leads with proof)" : "No new ideas tonight that are software for one clear buyer with at least 3 leads.",
    ...top.flatMap((p, i) => [`${i + 1}. ${p.title} — ${p.total}/10`, `   ${short(p.summary, 220)}`, `   Buyer: ${p.buyer}`, `   Build: ${p.product}`, `   Suggested price: $${p.price}/month (suggested, not a quote: ${p.priceWhy})`, ...(p.spread > 1 ? [`   Seen across ${p.spread} apps/sources: ${(p.origins || []).join(", ")}`] : []),
      `   Leads (${p.complaints.length}):`, ...p.complaints.slice(0, 5).map((c) => `   - ${proofText(c)}`), ...(p.complaints.length > 5 ? [`   + ${p.complaints.length - 5} more in the full report`] : []),
      ...(p.competitors[0] ? [`   Competitor: ${p.competitors[0].name}${p.competitors[0].price ? `, ${p.competitors[0].price}` : ""}`] : []), `   Build it: ${site}/idea/${encodeURIComponent(`${r.id}-${p.key}`)}`, ""]),
    leads.length ? `LEADS (${leads.length}, public posts and job ads — not contacted)` : "No leads tonight.",
    ...leads.map((l, i) => `${i + 1}. ${l.kind === "job" ? "[Job ad] " : ""}${who(l.who)}: "${short(l.quote, 120)}" ${l.sources[0]?.url}${l.idea ? ` [${l.idea}]` : ""}`), "",
    ...jobsText, ...updText, `Full report and dashboard: ${site}/night/${r.id}`].join("\n");
  const a = (s) => `<a href="${esc(s.url)}" style="color:#1f4e8c">${esc(s.domain || "source")}</a>`;
  const html = `<div style="font:15px/1.5 -apple-system,Segoe UI,Roboto,sans-serif;color:#1c1d1a;max-width:640px">
<h2 style="margin:0 0 4px">Night Agent — ${esc(day)}</h2>
<p style="margin:0 0 14px;color:#53584f"><b>Overnight:</b> ${esc(did)}${left ? `<br>${esc(left)}` : ""}</p>
${top.length ? `<h3 style="margin:16px 0 6px">Top ideas</h3>` + top.map((p, i) => `<div style="margin:0 0 14px;padding:12px;border:1px solid #e2ddd2;border-radius:10px">
<b>${i + 1}. ${esc(p.title)}</b> — <b style="color:#1f4e8c">${p.total}/10</b><br><span style="color:#53584f">${esc(short(p.summary, 220))}</span>
<div style="margin-top:8px"><b>Buyer:</b> ${esc(p.buyer)}<br><b>Build:</b> ${esc(p.product)}<br><b>Suggested price:</b> $${esc(p.price)}/month <span style="color:#53584f">(suggested, not a quote: ${esc(p.priceWhy)})</span>${p.spread > 1 ? `<br><b>Seen across ${p.spread} apps/sources:</b> ${esc((p.origins || []).join(", "))}` : ""}</div>
<div style="margin-top:8px"><b>Leads (${p.complaints.length}):</b></div>${p.complaints.slice(0, 5).map((c) => `<div style="margin-top:4px">${c.kind === "job" ? "<b>Job ad:</b> " : ""}${esc(who(c.who))}: “${esc(short(c.quote, 160))}” · ${c.sources.slice(0, 1).map(a).join("")}</div>`).join("")}${p.complaints.length > 5 ? `<div style="color:#53584f">+ ${p.complaints.length - 5} more in the full report</div>` : ""}
${p.competitors[0] ? `<div style="margin-top:6px;color:#53584f">Competitor: ${esc(p.competitors[0].name)}${p.competitors[0].price ? `, ${esc(p.competitors[0].price)}` : ""} · ${p.competitors[0].sources.slice(0, 1).map(a).join("")}</div>` : ""}
<div style="margin-top:8px"><a href="${esc(site)}/idea/${encodeURIComponent(`${r.id}-${p.key}`)}" style="color:#1f4e8c;font-weight:700">Yes, build this →</a></div></div>`).join("") : `<p>No new ideas tonight that are software for one clear buyer with at least 3 leads.</p>`}
<h3 style="margin:16px 0 6px">Leads${leads.length ? ` (${leads.length})` : ""}</h3>
${leads.length ? `<p style="margin:0 0 6px;color:#53584f;font-size:13px">Public posts and job ads showing this need. Not contacted.</p><ol style="padding-left:20px;margin:0">${leads.map((l) => `<li style="margin-bottom:6px">${l.kind === "job" ? "<b>Job ad</b> · " : ""}${esc(who(l.who))}: “${esc(short(l.quote, 120))}” · ${l.sources.slice(0, 1).map(a).join("")}${l.idea ? ` <span style="color:#53584f">(${esc(l.idea)})</span>` : ""}</li>`).join("")}</ol>` : `<p>No leads tonight.</p>`}
${jobHead ? `<h3 style="margin:16px 0 6px">${r.allJobAds ? `Job ads found (${ads.length}, ${qn} qualified)` : "Job ads"}</h3><p style="margin:0 0 6px;color:#53584f;font-size:13px">${r.allJobAds ? `Every job ad found this night, saved for good.${tot ? ` ${tot.total} saved in all, ${tot.qualified} qualified.` : ""} Qualified = a word-for-word quote in the ad was kept as proof of paid repetitive work.` : esc(jobHead)}</p>${ads.length ? `<ol style="padding-left:20px;margin:0">${ads.map((x) => `<li style="margin-bottom:4px">${x.qualified ? `<b style="color:#17633f">✓ Qualified</b>` : `<span style="color:#8a8f86">Not qualified</span>`} · <b>${esc(x.company || "Company not given")}</b> — ${esc(x.role || "role not given")} · <a href="${esc(x.url)}" style="color:#1f4e8c">${esc(x.source || "job ad")}</a> · found ${esc(x.firstFound)}</li>`).join("")}</ol>` : r.allJobAds ? "<p>No job ads this night.</p>" : ""}` : ""}
${ups.length ? `<h3 style="margin:16px 0 6px">Update on past ideas</h3><p style="margin:0 0 6px;color:#53584f;font-size:13px">Already sent on an earlier report; new proof tonight. Not new ideas.</p><ul style="padding-left:20px;margin:0">${ups.map((u) => `<li style="margin-bottom:6px"><b>${esc(u.title)}</b> <span style="color:#53584f">(first sent ${esc(u.firstDate)}, ${u.complaints.length} new proof${u.complaints.length === 1 ? "" : "s"})</span>${u.complaints.slice(0, 2).map((c) => `<div>“${esc(short(c.quote, 140))}” · ${c.sources.slice(0, 1).map(a).join("")}</div>`).join("")}</li>`).join("")}</ul>` : ""}
<p style="margin-top:18px"><a href="${esc(site)}/night/${esc(r.id)}" style="color:#1f4e8c;font-weight:700">Open the full report and your dashboard</a></p>
<p style="color:#8a8f86;font-size:12px">Every quote is copied word for word from the public page it links to. Nothing without proof is included.${(r.sourcesNote || []).map((n) => ` ${esc(n)}`).join("")}</p></div>`;
  return { subject, text, html };
}

/** Sends this morning's email (once). force: send again (Settings → "Send this morning's email now"). */
export async function morningEmail(env, time = Date.now(), { force = false } = {}) {
  const kv = env.SCOUT, night = jamaica(time).date;
  const done = await getJSON(kv, `email:${night}`);
  if (done?.ok && !force) return done;
  const site = String(env.SITE_URL || "").replace(/\/+$/, "");
  const result = { at: new Date().toISOString(), to: env.REPORT_EMAIL || "" };
  if (!env.REPORT_EMAIL) Object.assign(result, { ok: false, error: "No REPORT_EMAIL is set." });
  else if (!env.RESEND_API_KEY) Object.assign(result, { ok: false, error: "No RESEND_API_KEY yet: add it as a secret on the night-agent Worker." });
  else {
    const mail = buildEmail(await getJSON(kv, `report:${night}`), night, await getJSON(kv, `night:${night}`), site);
    const base = env.ALLOW_TEST === "1" && env.RESEND_BASE ? env.RESEND_BASE : "https://api.resend.com";
    try {
      const res = await fetch(`${base}/emails`, { method: "POST", headers: { Authorization: `Bearer ${env.RESEND_API_KEY}`, "content-type": "application/json" },
        body: JSON.stringify({ from: env.EMAIL_FROM || "Night Agent <onboarding@resend.dev>", to: [env.REPORT_EMAIL], subject: mail.subject, text: mail.text, html: mail.html }), signal: AbortSignal.timeout(15000) });
      const body = await res.json().catch(() => ({}));
      Object.assign(result, res.ok ? { ok: true, id: body.id || "", subject: mail.subject } : { ok: false, error: `Resend said ${res.status}: ${String(body.message || body.name || "").slice(0, 200)}` });
    } catch (e) { Object.assign(result, { ok: false, error: `Couldn't reach Resend (${e?.name || "network"}).` }); }
  }
  await putJSON(kv, `email:${night}`, result, { expirationTtl: 90 * 86400 });
  return result;
}
/** Emails a saved report now (used for the live test report), once per report; recorded in KV. */
export async function reportEmailNow(env, reportId, { prefix = "[Test] " } = {}) {
  const kv = env.SCOUT, key = `email-report:${reportId}`;
  const done = await getJSON(kv, key);
  if (done?.ok) return done;
  const site = String(env.SITE_URL || "").replace(/\/+$/, "");
  const r = await getJSON(kv, `report:${reportId}`);
  const mail = buildEmail(r, reportId.slice(0, 10), null, site);
  const base = env.ALLOW_TEST === "1" && env.RESEND_BASE ? env.RESEND_BASE : "https://api.resend.com";
  const result = { at: new Date().toISOString(), to: env.REPORT_EMAIL || "" };
  try {
    const res = await fetch(`${base}/emails`, { method: "POST", headers: { Authorization: `Bearer ${env.RESEND_API_KEY}`, "content-type": "application/json" }, signal: AbortSignal.timeout(15000),
      body: JSON.stringify({ from: env.EMAIL_FROM || "Night Agent <onboarding@resend.dev>", to: [env.REPORT_EMAIL], subject: `${prefix}${mail.subject}`, text: `${prefix ? "TEST RUN (a short version of a night, run on demand)\n\n" : ""}${mail.text}`, html: mail.html }) });
    const body = await res.json().catch(() => ({}));
    Object.assign(result, res.ok ? { ok: true, id: body.id || "", subject: `${prefix}${mail.subject}` } : { ok: false, error: `Resend said ${res.status}: ${String(body.message || body.name || "").slice(0, 200)}` });
  } catch (e) { Object.assign(result, { ok: false, error: `Couldn't reach Resend (${e?.name || "network"}).` }); }
  await putJSON(kv, key, result, { expirationTtl: 30 * 86400 });
  return result;
}

/** A one-off test email (same sender and recipient as the morning report), recorded in KV as "email-test". */
export async function testEmail(env) {
  const kv = env.SCOUT;
  if (await kv.get("email-test")) return null; // only once
  const site = String(env.SITE_URL || "").replace(/\/+$/, "");
  const base = env.ALLOW_TEST === "1" && env.RESEND_BASE ? env.RESEND_BASE : "https://api.resend.com";
  const result = { at: new Date().toISOString(), to: env.REPORT_EMAIL || "" };
  try {
    const res = await fetch(`${base}/emails`, { method: "POST", headers: { Authorization: `Bearer ${env.RESEND_API_KEY}`, "content-type": "application/json" }, signal: AbortSignal.timeout(15000),
      body: JSON.stringify({ from: env.EMAIL_FROM || "Night Agent <onboarding@resend.dev>", to: [env.REPORT_EMAIL], subject: "Night Agent: test email",
        text: `This is a test from your Night Agent.\n\nThe email is set up: every morning at 6:00 a.m. Jamaica time, the morning report (what ran overnight, the top 3 ideas with proof, and the leads) will be sent here.\n\nDashboard: ${site}/`,
        html: `<div style="font:15px/1.5 -apple-system,Segoe UI,Roboto,sans-serif;color:#1c1d1a"><h2 style="margin:0 0 8px">Night Agent: test email</h2><p>The email is set up. Every morning at <b>6:00 a.m. Jamaica time</b>, your morning report will be sent here: what ran overnight, the top 3 ideas with proof, and the leads.</p><p><a href="${esc(site)}/" style="color:#1f4e8c;font-weight:700">Open your dashboard</a></p></div>` }) });
    const body = await res.json().catch(() => ({}));
    Object.assign(result, res.ok ? { ok: true, id: body.id || "" } : { ok: false, error: `Resend said ${res.status}: ${String(body.message || body.name || "").slice(0, 200)}` });
  } catch (e) { Object.assign(result, { ok: false, error: `Couldn't reach Resend (${e?.name || "network"}).` }); }
  await putJSON(kv, "email-test", result, { expirationTtl: 30 * 86400 });
  return result;
}
export const emailStatusText = (e) => (!e ? "Not sent yet." : e.ok ? `Sent ${jamaicaTime(e.at)} to ${e.to}: “${e.subject}”` : `Not sent (${jamaicaTime(e.at)}): ${e.error}`);
