/**
 * Night Agent, stage 1: the Scout. Every night 1:00–4:55 a.m. Jamaica time (Cron Trigger every 5 minutes, 06:00–09:55
 * UTC), it searches for real people complaining about software or wishing for it, groups and scores the problems,
 * checks competitors, and leaves a morning report with a link to every source. See pipeline.js.
 *
 * Pages (behind a passcode chosen on the first visit; sessions are cookies, 30 days):
 *   /             the latest morning report        /night/<id>   a past report      /history   every night
 *   /settings     Gemini key status, "Run one step now", phone alert (ntfy)        /report/<id>.json   raw data
 * Storage: Cloudflare KV (binding SCOUT), about 50 writes a night (free plan: 1,000 a day).
 * Secret: GEMINI_API_KEY (Google AI Studio, free tier). Nothing here ever turns on billing.
 */
import { runStep } from "./pipeline.js";
import { reportPage, historyPage, settingsPage, authPage, page, dashboardPage, ideasPage, ideaPage, promptPage, leadsPage } from "./report.js";
import { morningEmail, emailStatusText, testEmail, reportEmailNow } from "./email.js";
import { buildPrompt } from "./prompt.js";
import { getJSON, putJSON, randomHex, sha256, hex, jamaica, jamaicaTime } from "./util.js";

const HEADERS = { "content-type": "text/html; charset=utf-8", "cache-control": "no-store", "x-content-type-options": "nosniff", "referrer-policy": "no-referrer", "x-frame-options": "DENY",
  "content-security-policy": "default-src 'none'; style-src 'unsafe-inline'; script-src 'self'; form-action 'self'; base-uri 'none'; frame-ancestors 'none'", "x-robots-tag": "noindex, nofollow" };
const html = (body, status = 200, extra = {}) => new Response(body, { status, headers: { ...HEADERS, ...extra } });
const redirect = (to, extra = {}) => new Response(null, { status: 303, headers: { location: to, "cache-control": "no-store", ...extra } });
const ROUNDS = 5000; // PBKDF2 rounds: the free plan allows ~10 ms of CPU per request

async function pbkdf2(pass, salt) {
  const k = await crypto.subtle.importKey("raw", new TextEncoder().encode(pass), "PBKDF2", false, ["deriveBits"]);
  return hex(await crypto.subtle.deriveBits({ name: "PBKDF2", hash: "SHA-256", salt: new TextEncoder().encode(salt), iterations: ROUNDS }, k, 256));
}
const sameText = (a, b) => { if (a.length !== b.length) return false; let x = 0; for (let i = 0; i < a.length; i++) x |= a.charCodeAt(i) ^ b.charCodeAt(i); return x === 0; };
const cookieOf = (req) => /(?:^|;\s*)na_s=([0-9a-f]{64})/.exec(req.headers.get("cookie") || "")?.[1] || null;
async function signedIn(env, req) { const t = cookieOf(req); return t ? Boolean(await env.SCOUT.get(`session:${await sha256(t)}`)) : false; }
async function newSession(env) {
  const t = randomHex(32);
  await env.SCOUT.put(`session:${await sha256(t)}`, "1", { expirationTtl: 30 * 86400 });
  return `na_s=${t}; Path=/; HttpOnly; Secure; SameSite=Strict; Max-Age=${30 * 86400}`;
}
const form = async (req) => { try { return Object.fromEntries(new URLSearchParams(await req.text())); } catch { return {}; } };

const COPY_JS = `document.querySelectorAll("[data-copy]").forEach((b) => b.addEventListener("click", async () => {
  const t = document.getElementById(b.dataset.copy), out = document.getElementById("copied");
  try { await navigator.clipboard.writeText(t.value); out.textContent = "Copied. Paste it into Claude Code."; }
  catch { t.focus(); t.select(); out.textContent = "Selected: copy it with your phone's Copy button."; }
}));`;

async function findIdea(kv, id) {
  const m = /^(\d{4}-\d{2})-\d{2}(?:-test)?-p\d+$/.exec(id || "");
  return m ? (await getJSON(kv, `ideas:${m[1]}`, [])).find((x) => x.id === id) || null : null;
}
const monthParam = (url, months) => { const m = url.searchParams.get("month"); return /^\d{4}-\d{2}$/.test(m || "") ? m : months[0] || null; };

async function handle(req, env) {
  const url = new URL(req.url), path = url.pathname, kv = env.SCOUT;
  if (path === "/copy.js") return new Response(COPY_JS, { headers: { "content-type": "text/javascript; charset=utf-8", "cache-control": "no-cache", "x-content-type-options": "nosniff" } });
  const auth = await getJSON(kv, "auth", null);
  const claimed = auth && auth.gen === String(env.RESET_GENERATION || "1");
  if (req.method === "POST" && path === "/setup") {
    if (claimed) return redirect("/");
    const f = await form(req);
    if (String(f.passcode || "").length < 8) return html(authPage("setup", "Use at least 8 characters."), 400);
    const salt = randomHex(16);
    await putJSON(kv, "auth", { salt, hash: await pbkdf2(f.passcode, salt), gen: String(env.RESET_GENERATION || "1"), fails: [] });
    return redirect("/", { "set-cookie": await newSession(env) });
  }
  if (!claimed) return html(authPage("setup"));
  if (req.method === "POST" && path === "/login") {
    const now = Date.now(), fails = (auth.fails || []).filter((t) => now - t < 15 * 60000);
    if (fails.length >= 5) return html(authPage("login", "Too many wrong tries. Wait 15 minutes, then try again."), 429);
    const f = await form(req);
    if (!sameText(await pbkdf2(String(f.passcode || ""), auth.salt), auth.hash)) { await putJSON(kv, "auth", { ...auth, fails: [...fails, now] }); return html(authPage("login", "That passcode isn't right."), 401); }
    if (fails.length) await putJSON(kv, "auth", { ...auth, fails: [] });
    return redirect("/", { "set-cookie": await newSession(env) });
  }
  if (!(await signedIn(env, req))) return html(authPage("login"), path === "/" ? 200 : 401);

  if (req.method === "POST" && path === "/logout") { const t = cookieOf(req); if (t) await kv.delete(`session:${await sha256(t)}`); return redirect("/", { "set-cookie": "na_s=; Path=/; HttpOnly; Secure; SameSite=Strict; Max-Age=0" }); }
  if (req.method === "POST" && path === "/run") {
    const st = await runStep(env, { manual: true });
    const msg = st.status === "running" ? `Step done: ${st.log.at(-1)?.msg || "progress saved"} Run more steps to finish the test report.` : `Test report ${st.status === "done" ? "finished" : "stopped"}: ${st.stopped?.message || "see the report"}`;
    if (st.status !== "running") return html(reportPage(await getJSON(kv, `report:${st.id}`), { notice: `<div class="card status done">${msg.replace(/[<>&]/g, "")}</div>` }));
    return html(await settingsHtml(env, msg));
  }
  if (req.method === "POST" && path === "/email-now") {
    const r = await morningEmail(env, Date.now(), { force: true });
    return html(await settingsHtml(env, r.ok ? `Email sent to ${r.to}.` : `Email not sent: ${r.error}`));
  }
  const b = /^\/idea\/([^/]+)\/build$/.exec(path);
  if (req.method === "POST" && b) {
    const id = decodeURIComponent(b[1]), idea = await findIdea(kv, id);
    if (!idea) return html(page("Not found", "<h1>That idea wasn't found</h1><p><a href='/ideas'>All ideas</a></p>"), 404);
    const built = await getJSON(kv, "built", {});
    if (!built[id]) await putJSON(kv, "built", { ...built, [id]: new Date().toISOString() });
    return redirect(`/idea/${encodeURIComponent(id)}/prompt`);
  }
  if (req.method === "POST" && path === "/alerts") {
    const f = await form(req), s = await getJSON(kv, "settings", {});
    await putJSON(kv, "settings", { ...s, ntfyTopic: f.off ? null : s.ntfyTopic || `night-agent-${randomHex(12)}` });
    return redirect("/settings");
  }
  if (req.method !== "GET") return html(page("Not found", "<h1>Not found</h1>"), 404);
  if (path === "/") {
    const index = await getJSON(kv, "index", []), totals = await getJSON(kv, "totals", { ideas: 0, leads: 0 }), built = await getJSON(kv, "built", {});
    const r = index[0] ? await getJSON(kv, `report:${index[0].id}`) : null;
    return html(dashboardPage({ r, email: emailStatusText(await getJSON(kv, `email:${r && !r.id.endsWith("-test") ? r.id : jamaica().date}`)), totals: { nights: index.length, ideas: totals.ideas, leads: totals.leads, built: Object.keys(built).length } }));
  }
  if (path === "/ideas" || path === "/leads") {
    const months = await getJSON(kv, "months", []), month = monthParam(url, months);
    if (path === "/ideas") return html(ideasPage({ ideas: month ? await getJSON(kv, `ideas:${month}`, []) : [], months, month, built: await getJSON(kv, "built", {}) }));
    return html(leadsPage({ leads: month ? await getJSON(kv, `leads:${month}`, []) : [], months, month }));
  }
  const ip = /^\/idea\/([^/]+?)(\/prompt)?$/.exec(path);
  if (ip) {
    const id = decodeURIComponent(ip[1]), idea = await findIdea(kv, id);
    if (!idea) return html(page("Not found", "<h1>That idea wasn't found</h1><p><a href='/ideas'>All ideas</a></p>"), 404);
    const built = (await getJSON(kv, "built", {}))[id];
    return html(ip[2] ? promptPage(idea, buildPrompt(idea)) : ideaPage(idea, built));
  }
  if (path === "/history") return html(historyPage(await getJSON(kv, "index", [])));
  if (path === "/settings") return html(await settingsHtml(env, ""));
  const m = /^\/night\/(\d{4}-\d{2}-\d{2}(?:-test)?)$/.exec(path);
  if (m) { const r = await getJSON(kv, `report:${m[1]}`); return r ? html(reportPage(r)) : html(page("Not found", "<h1>No report for that night</h1><p><a href='/history'>Past nights</a></p>"), 404); }
  const j = /^\/report\/(\d{4}-\d{2}-\d{2}(?:-test)?)\.json$/.exec(path);
  if (j) { const r = await getJSON(kv, `report:${j[1]}`); return new Response(JSON.stringify(r, null, 2), { status: r ? 200 : 404, headers: { "content-type": "application/json", "cache-control": "no-store", "x-content-type-options": "nosniff" } }); }
  return html(page("Not found", "<h1>Not found</h1><p><a href='/'>Latest report</a></p>"), 404);
}

async function settingsHtml(env, msg) {
  const jm = jamaica(), live = await getJSON(env.SCOUT, `night:${jm.date}`) || await getJSON(env.SCOUT, `night:${jm.date}-test`);
  const s = await getJSON(env.SCOUT, "settings", {});
  return settingsPage({ hasKey: Boolean(env.GEMINI_API_KEY), models: env.GEMINI_MODELS || "gemini-2.5-flash, gemini-2.5-flash-lite, gemini-flash-latest",
    live: live ? `${live.log.at(-1)?.msg || ""} (${jamaicaTime(live.log.at(-1)?.at || live.startedAt)})` : "", alerts: s.ntfyTopic || null, msg,
    email: { to: env.REPORT_EMAIL || "", hasKey: Boolean(env.RESEND_API_KEY), status: emailStatusText(await getJSON(env.SCOUT, `email:${(await getJSON(env.SCOUT, "index", [])).find((x) => !x.id.endsWith("-test"))?.id || jm.date}`)) } });
}

const EMAIL_CRON = "0 11 * * *"; // 6:00 a.m. Jamaica time
const TEST_EMAIL_CRON = "*/2 * * * *"; // only while a one-off test email is being sent (added and removed in wrangler.toml)
/** A live test night (only while TEST_EMAIL_CRON is in wrangler.toml): one short test step per tick; when the test
 *  report is finished, it's emailed once. Uses the test report (…-test), never tonight's real one. */
async function liveTest(env, time) {
  const st = await runStep(env, { now: time, manual: true });
  if (st.status !== "running") return reportEmailNow(env, st.id);
  return null;
}

/** One Cron Trigger run: a step of tonight's work, only between 1:00 and 4:59 a.m. Jamaica time. */
async function nightTick(env, time) {
  const jm = jamaica(time);
  if (jm.hour < 1 || jm.hour > 4) return null;
  return runStep(env, { now: time }).catch((e) => { console.error("night step failed", e?.stack || e); return null; });
}

export default {
  async fetch(req, env) {
    // Tests only (ALLOW_TEST=1, never on the live Worker): run a Cron Trigger tick for a chosen time.
    if (env.ALLOW_TEST === "1" && new URL(req.url).pathname === "/__test/tick") {
      const q = new URL(req.url).searchParams, time = Number(q.get("time"));
      const out = q.get("kind") === "email" ? await morningEmail(env, time) : { status: (await nightTick(env, time))?.status || "skipped" };
      return new Response(JSON.stringify(out), { headers: { "content-type": "application/json" } });
    }
    try { return await handle(req, env); } catch (e) { console.error(e?.stack || e); return html(page("Error", "<h1>Something went wrong</h1><p>Please try again.</p>"), 500); }
  },
  async scheduled(event, env, ctx) {
    if (event.cron === EMAIL_CRON) ctx.waitUntil(morningEmail(env, event.scheduledTime).catch((e) => console.error("email failed", e?.stack || e)));
    else if (event.cron === TEST_EMAIL_CRON) ctx.waitUntil(liveTest(env, event.scheduledTime).catch((e) => console.error("live test failed", e?.stack || e)));
    else ctx.waitUntil(nightTick(env, event.scheduledTime));
  },
};
