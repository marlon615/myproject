/**
 * Draxly — the Worker (front door). Serves the app's pages and routes every API call.
 *
 * Storage: Directory (one: companies, users, sign-in, API keys, contracts, owner) and Company (one per company: its
 * data, forecasts, stock, connections, activity log). A customer request's company always comes from its session
 * token (or API key), never from anything the browser names.
 *
 * Roles: viewer (read), manager (+ upload data, run forecasts, stock levels), admin (+ team, security settings,
 * connections, API keys, activity log). Features are switched on per company by the owner.
 *
 * Customer API (Bearer session)        — see the route list in api() below; machine API: /v1/* (Bearer API key).
 * Owner API (Bearer owner session)     — /api/owner/*.
 */
import { Directory, FEATURES, ROLES, MIN_CONTRACT_CENTS } from "./directory.js";
import { Company, MAX_SERIES, MAX_MONTHS } from "./company.js";
import { FILES, RULES } from "./assets.generated.js";
import { MIN_FORECAST_MONTHS, MIN_BACKTEST_MONTHS, forecastSeries, explain, addMonths } from "./forecast.js";
import { CONNECTORS, connectorList, QB, at } from "./connectors.js";
import { PROVIDERS, endpoints, authorizeUrl, finishSignIn } from "./oidc.js";
import { sendEmail, inviteEmail } from "./email.js";
import { pkce } from "./crypto.js";
export { Directory, Company };

const MAX_BODY = 4_000_000, MAX_FILE = 20 * 1024 * 1024, MAX_BATCH = 500;
const ID = /^[0-9a-f]{32}$/, CID = /^[0-9a-f]{24}$/;
const EMAIL = /^[^\s@]{1,64}@[^\s@]{1,190}\.[^\s@]{2,}$/;
const YM = /^\d{4}-(0[1-9]|1[0-2])$/;
const RANK = { viewer: 0, manager: 1, admin: 2 };
const FEATURE_WORDS = { forecasts: "The 3-month forecast", multiLocation: "Multi-location forecasting", inventory: "Stock and reorder suggestions", reports: "Weekly email reports", connectors: "Direct connections", api: "The API and file drop", sso: "Single sign-on" };

const json = (data, status = 200, extra = {}) => new Response(JSON.stringify(data), {
  status, headers: { "Content-Type": "application/json", "Cache-Control": "no-store", "X-Content-Type-Options": "nosniff", ...extra },
});
const bearer = (request) => (request.headers.get("Authorization") || "").replace(/^Bearer\s+/i, "").trim();
const ipOf = (request) => request.headers.get("CF-Connecting-IP") || "local";
async function readJson(request, max = MAX_BODY) {
  if (Number(request.headers.get("Content-Length") || 0) > max) return null;
  const text = await request.text();
  if (text.length > max) return null;
  try { const v = JSON.parse(text); return v && typeof v === "object" ? v : null; } catch { return null; }
}
const company = (env, id) => env.COMPANY.get(env.COMPANY.idFromName(id));
const IID = /^[0-9a-f]{32}$/, LID = /^[0-9a-f]{24}$/;
const todayUTC = () => new Date().toISOString().slice(0, 10);
const deviceOf = (ua = "") => `${/iPhone/.test(ua) ? "iPhone" : /iPad/.test(ua) ? "iPad" : /Android/.test(ua) ? "Android" : /Windows/.test(ua) ? "Windows" : /Macintosh/.test(ua) ? "Mac" : /Linux|CrOS/.test(ua) ? "Linux" : "Other"}${/Edg\//.test(ua) ? " · Edge" : /Chrome\//.test(ua) ? " · Chrome" : /Firefox\//.test(ua) ? " · Firefox" : /Safari\//.test(ua) ? " · Safari" : ""}`;
// ── The open demo: forecasts computed in memory and sent straight back; nothing is ever stored ─────────────────────
const DEMO_BATCH = 50, DEMO_MAX_MONTHS = 60;
const demoCalls = new Map(); // per visitor network, in this server's memory only: a brake on abuse of the open link
function demoAllowed(ip, cost = 1) {
  const now = Date.now(), win = 10 * 60_000, max = 1500; // e.g. 75,000 products in 10 minutes
  const e = demoCalls.get(ip) || { start: now, n: 0 };
  if (now - e.start > win) { e.start = now; e.n = 0; }
  e.n += cost; demoCalls.set(ip, e);
  if (demoCalls.size > 50_000) demoCalls.clear();
  return e.n <= max;
}
const consecutive = (months) => months.every((m, i) => i === 0 || m === addMonths(months[i - 1], 1));
const pdfResponse = (r) => new Response(r.bytes, { headers: { "Content-Type": "application/pdf", "Content-Disposition": `attachment; filename="draxly-invoice-${r.number}.pdf"`, "Cache-Control": "no-store", "X-Content-Type-Options": "nosniff" } });
const waitMsg = (r) => json({ error: "Too many wrong tries. Wait a few minutes, then try again." }, 429, { "Retry-After": String(r.retryAfter || 900) });

/** Checks monthly series sent by the browser (or the old one-blob shape). Returns { months, series } or { error }. */
function cleanSeries(b, multiLocation) {
  const months = Array.isArray(b?.months) ? b.months : null;
  if (!months || !months.length || !months.every((m) => typeof m === "string" && YM.test(m))) return { error: "No months could be read from the file." };
  if (months.length > MAX_MONTHS) return { error: `That's ${months.length} months; send the latest ${MAX_MONTHS} at most (refresh the page to get the latest version, which does this for you).` };
  for (let i = 1; i < months.length; i++) {
    const [y, m] = months[i - 1].split("-").map(Number);
    if (months[i] !== (m === 12 ? `${y + 1}-01` : `${y}-${String(m + 1).padStart(2, "0")}`)) return { error: "The months must follow each other with no gaps." };
  }
  let list = b.series;
  if (!list && b.products && typeof b.products === "object" && !Array.isArray(b.products)) {
    const measure = b.kind === "units" ? "units" : "amount";
    list = Object.entries(b.products).map(([product, vals]) => ({ product, [measure]: vals }));
  }
  if (!Array.isArray(list) || !list.length) return { error: "No products found." };
  if (list.length > MAX_BATCH && !b.products) return { error: `Send at most ${MAX_BATCH} series at a time.` };
  if (list.length > 2000) return { error: "Between 1 and 2000 products, please." };
  const ok = (v) => v === undefined || (Array.isArray(v) && v.length === months.length && v.every((x) => typeof x === "number" && Number.isFinite(x) && Math.abs(x) < 1e13));
  const series = [];
  for (const s of list) {
    if (!s || typeof s !== "object" || !ok(s.amount) || !ok(s.units) || (s.amount === undefined && s.units === undefined)) return { error: "Every product needs one number per month." };
    series.push({ product: String(s.product ?? "").trim().slice(0, 120) || "(no name)", location: multiLocation ? String(s.location ?? "").trim().slice(0, 120) : "", region: multiLocation ? String(s.region ?? "").trim().slice(0, 120) : "", amount: s.amount, units: s.units });
  }
  return { months, series, name: String(b.name ?? "").trim().slice(0, 120) || "Sales data" };
}

/** Posts one phone notification to ntfy (https://ntfy.sh unless NTFY_URL says otherwise, e.g. in tests). */
async function sendAlert(env, topic, { title, message, click, tags, priority = 4 }) {
  const res = await fetch(env.NTFY_URL || "https://ntfy.sh/", {
    method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ topic, title, message, click, tags, priority, actions: click ? [{ action: "view", label: "Open dashboard", url: click, clear: true }] : undefined }),
  });
  return { ok: res.ok, status: res.status };
}

// ── Customer API ────────────────────────────────────────────────────────────────────────────────────────────────
async function api(request, env, path, ctx) {
  const dir = env.DIRECTORY.get(env.DIRECTORY.idFromName("main"));
  const method = request.method, token = bearer(request), ip = ipOf(request), origin = new URL(request.url).origin;
  if (path.startsWith("/api/owner/")) return ownerApi(request, env, path, dir, token, ctx);
  const audit = (account, user, action, detail = "") => account && ctx.waitUntil(company(env, account).log({ user, action, detail, ip }).catch(() => {}));
  const offReply = async () => json({ error: "This account is switched off.", off: true, contact: await dir.contact() }, 403);
  const pwError = (p) => (p.length < 8 || p.length > 200 ? "The new password needs at least 8 characters." : null);
  /** Shared ending for every sign-in step: a session, a two-factor step, or a clear refusal. */
  const signInReply = async (r, email, how) => {
    if (r.error === "wait") return waitMsg(r);
    if (r.error === "off") return offReply();
    if (r.error === "userOff") return json({ error: "Your user has been switched off by your company's admin." }, 403);
    if (r.error === "sso") { audit(r.account, email, "password sign-in refused", "company requires single sign-on"); return json({ error: "Your company signs in with Microsoft or Google. Use the button below.", sso: true }, 403); }
    if (r.twoFactor) return json({ twoFactor: true, ticket: r.ticket, ...(r.recoveryCode ? { recoveryCode: r.recoveryCode } : {}) });
    audit(r.account, email, how);
    return json({ token: r.token, me: r.me, ...(r.recoveryCode ? { recoveryCode: r.recoveryCode } : {}) });
  };

  // Signed-out routes.
  if (path === "/api/signup" && method === "POST") {
    const b = await readJson(request);
    const name = String(b?.company ?? "").trim().slice(0, 100), email = String(b?.email ?? "").trim().toLowerCase(), password = String(b?.password ?? "");
    if (!name) return json({ error: "Type your company's name." }, 400);
    if (!EMAIL.test(email)) return json({ error: "That email doesn't look right." }, 400);
    if (pwError(password)) return json({ error: "The password needs at least 8 characters." }, 400);
    const r = await dir.signup(name, email, password, ip);
    if (r.error === "exists") return json({ error: "There's already an account with that email. Sign in instead." }, 409);
    if (r.error === "busy") return json({ error: "Too many new accounts from here. Try again in an hour." }, 429);
    audit(r.me.id, email, "company created", name);
    return json(r);
  }
  if (path === "/api/login" && method === "POST") {
    const b = await readJson(request);
    const email = String(b?.email ?? "").trim().toLowerCase();
    const r = await dir.login(email, String(b?.password ?? "").slice(0, 200));
    if (r.error === "wrong") { audit(r.account, email, "sign-in failed", "wrong password"); return json({ error: "That email and password don't match." }, 401); }
    return signInReply(r, email, "signed in");
  }
  if (path === "/api/login/2fa" && method === "POST") {
    const b = await readJson(request);
    const r = await dir.login2fa(String(b?.ticket ?? ""), String(b?.code ?? "").slice(0, 40));
    if (r.error === "expired") return json({ error: "That sign-in took too long. Start again." }, 410);
    if (r.error === "wrong") { audit(r.account, "", "two-factor code wrong"); return json({ error: "That code isn't right. Check the time on your phone, or use a backup code." }, 401); }
    if (r.error === "wait") return waitMsg(r);
    if (r.token) audit(r.account, r.me.email, r.usedBackup ? "signed in (backup code used)" : "signed in (two-factor)");
    return r.token ? json({ token: r.token, me: r.me, usedBackup: r.usedBackup, backupLeft: r.backupLeft }) : signInReply(r, "", "signed in");
  }
  if (path === "/api/logout" && method === "POST") { if (token) await dir.logout(token); return new Response(null, { status: 204 }); }
  if (path === "/api/recover" && method === "POST") {
    const b = await readJson(request);
    const password = String(b?.password ?? ""), email = String(b?.email ?? "").trim().toLowerCase();
    if (pwError(password)) return json({ error: pwError(password) }, 400);
    const r = await dir.recover(email, String(b?.code ?? "").slice(0, 60), password);
    if (r.error === "wrong") { audit(r.account, email, "password reset failed", "wrong recovery code"); return json({ error: "That email and recovery code don't match." }, 401); }
    return signInReply(r, email, "password reset with recovery code");
  }
  if (path === "/api/reset-request" && method === "POST") {
    const b = await readJson(request);
    const email = String(b?.email ?? "").trim().toLowerCase();
    if (!EMAIL.test(email)) return json({ error: "Type the email you signed up with." }, 400);
    const r = await dir.requestReset(email);
    if (r.account) audit(r.account, email, "asked for a password reset link");
    if (r.alert) ctx.waitUntil(sendAlert(env, r.alert.topic, { title: "Password reset requested", message: `${r.alert.company} (${r.alert.email}) asked for a password reset link.\nOpen your owner dashboard: ${origin}/owner`, click: `${origin}/owner`, tags: ["key"], priority: 4 }).catch(() => {}));
    return json({ ok: true, contact: await dir.contact() });
  }
  if (path === "/api/reset" && method === "POST") {
    const b = await readJson(request);
    const password = String(b?.password ?? ""), t = String(b?.token ?? "");
    if (pwError(password)) return json({ error: pwError(password) }, 400);
    if (!/^[0-9a-f]{64}$/.test(t)) return json({ error: "This reset link isn't valid. Ask for a new one." }, 400);
    const r = await dir.resetWithToken(t, password);
    if (r.error === "invalid") return json({ error: "This reset link has expired or was already used. Ask for a new one." }, 410);
    return signInReply(r, "", "password reset with a link");
  }
  if (path === "/api/invite" && method === "GET") {
    const info = await dir.inviteInfo(new URL(request.url).searchParams.get("token") || "");
    return info ? json(info) : json({ error: "This invite has expired or was already used. Ask your admin for a new one." }, 410);
  }
  if (path === "/api/invite" && method === "POST") {
    const b = await readJson(request);
    const password = String(b?.password ?? "");
    if (pwError(password)) return json({ error: pwError(password) }, 400);
    const r = await dir.acceptInvite(String(b?.token ?? ""), String(b?.name ?? "").trim().slice(0, 100), password);
    if (r.error === "invalid") return json({ error: "This invite has expired or was already used. Ask your admin for a new one." }, 410);
    return signInReply(r, r.email, "joined the team");
  }
  // Single sign-on.
  const ssoStart = /^\/api\/sso\/(microsoft|google)\/start$/.exec(path);
  if (ssoStart && method === "GET") {
    const provider = ssoStart[1], q = new URL(request.url).searchParams;
    const clientId = await dir.secret(PROVIDERS[provider].clientIdKey), secret = await dir.secret(PROVIDERS[provider].secretKey);
    if (!clientId || !secret) return Response.redirect(`${origin}/#/login?sso=unavailable`, 302);
    const { verifier, challenge } = await pkce();
    const { state, nonce } = await dir.ssoBegin(provider, verifier, q.get("invite") || null);
    return Response.redirect(authorizeUrl(endpoints(env, provider), { clientId, redirectUri: `${origin}/api/sso/callback`, state, nonce, challenge, loginHint: q.get("email") || "" }), 302);
  }
  if (path === "/api/sso/callback" && method === "GET") {
    const q = new URL(request.url).searchParams;
    const back = (why) => Response.redirect(`${origin}/#/login?sso=${encodeURIComponent(why)}`, 302);
    const s = await dir.ssoTake(q.get("state") || "");
    if (!s || !PROVIDERS[s.provider]) return back("expired");
    if (q.get("error") || !q.get("code")) return back("cancelled");
    let id;
    try {
      id = await finishSignIn(endpoints(env, s.provider), { clientId: await dir.secret(PROVIDERS[s.provider].clientIdKey), clientSecret: await dir.secret(PROVIDERS[s.provider].secretKey), code: q.get("code"), redirectUri: `${origin}/api/sso/callback`, verifier: s.verifier, nonce: s.nonce });
    } catch { return back("failed"); }
    const r = await dir.ssoSignIn(s.provider, id.email, id.subject, s.invite);
    if (r.error) { audit(r.account, id.email, "single sign-on refused", r.error); return back(r.error); }
    audit(r.account, id.email, r.joined ? `joined through ${PROVIDERS[s.provider].name} sign-in (viewer)` : `signed in with ${PROVIDERS[s.provider].name}`);
    return Response.redirect(`${origin}/#/sso/${r.code}`, 302);
  }
  if (path === "/api/sso/redeem" && method === "POST") {
    const b = await readJson(request);
    const t = await dir.ssoRedeem(String(b?.code ?? ""));
    if (!t) return json({ error: "That sign-in has expired. Try again." }, 410);
    return json({ token: t, me: await dir.who(t) });
  }
  if (path === "/api/sso/providers" && method === "GET") return json(await dir.ssoProviders());
  // QuickBooks sends the browser back here after the customer approves access.
  if (path === "/api/oauth/quickbooks" && method === "GET") {
    const q = new URL(request.url).searchParams;
    const back = (why) => Response.redirect(`${origin}/#/connections?qb=${encodeURIComponent(why)}`, 302);
    const s = await dir.ssoTake(q.get("state") || "");
    if (!s || s.provider !== "quickbooks" || !q.get("code") || !q.get("realmId")) return back(q.get("error") ? "cancelled" : "expired");
    const [account, connId] = String(s.invite).split(":");
    const id = await dir.secret("qbClientId"), secret = await dir.secret("qbSecret");
    const res = await fetch(at(env, QB.token), { method: "POST", headers: { Authorization: `Basic ${btoa(`${id}:${secret}`)}`, "Content-Type": "application/x-www-form-urlencoded", Accept: "application/json" },
      body: new URLSearchParams({ grant_type: "authorization_code", code: q.get("code"), redirect_uri: `${origin}/api/oauth/quickbooks` }) });
    if (!res.ok) return back("failed");
    const t = await res.json();
    const box = company(env, account);
    await box.setOrigin(origin);
    const r = await box.connectionAuthorized(connId, { realmId: q.get("realmId"), refreshToken: t.refresh_token, accessToken: t.access_token, accessExpires: Date.now() + Number(t.expires_in || 3600) * 1000 });
    return back(r.error ? "failed" : "connected");
  }

  // The open demo (no sign-up): forecasts batches of products in memory and sends them back. Nothing is stored.
  if (path === "/api/demo/start" && method === "POST") {
    const b = (await readJson(request, 5000)) || {};
    const cf = request.cf || {}, ref = String(b.referrer || "").slice(0, 200);
    const r = await dir.logDemoVisit({ city: cf.city, region: cf.region, country: cf.country, device: deviceOf(request.headers.get("User-Agent") || ""), referrer: /^https?:\/\//.test(ref) && !ref.startsWith(origin) ? ref : "", source: String(b.source || "").slice(0, 120) });
    if (Number(b.products) > 0) ctx.waitUntil(dir.noteDemoRun(r.visit, Math.round(Number(b.products)), Math.round(Number(b.months) || 0)).catch(() => {}));
    return json({ visit: r.visit, batch: DEMO_BATCH });
  }
  if (path === "/api/demo/forecast" && method === "POST") {
    const b = await readJson(request, 400_000);
    const months = Array.isArray(b?.months) ? b.months : null, list = Array.isArray(b?.series) ? b.series : null;
    if (!months || months.length < MIN_FORECAST_MONTHS || months.length > DEMO_MAX_MONTHS || !months.every((m) => typeof m === "string" && YM.test(m)) || !consecutive(months)) return json({ error: `Send between ${MIN_FORECAST_MONTHS} and ${DEMO_MAX_MONTHS} consecutive months.` }, 400);
    if (!list || !list.length || list.length > DEMO_BATCH) return json({ error: `Send 1 to ${DEMO_BATCH} products at a time.` }, 400);
    if (!list.every((x) => Array.isArray(x?.values) && x.values.length === months.length && x.values.every((v) => typeof v === "number" && Number.isFinite(v) && Math.abs(v) < 1e13))) return json({ error: "Every product needs one number per month." }, 400);
    if (!demoAllowed(ip)) return json({ error: "That's a lot of forecasting from one place — please wait a few minutes and try again." }, 429, { "Retry-After": "300" });
    const results = list.map((x) => { const r = forecastSeries(x.values.map(Number)); return { product: String(x.product ?? "").slice(0, 120), forecast: r.forecast, method: r.method }; });
    return json({ months: Array.from({ length: 3 }, (_, k) => addMonths(months[months.length - 1], k + 1)), results });
  }
  if (path === "/api/demo/summary" && method === "POST") {
    const b = await readJson(request, 400_000);
    const months = Array.isArray(b?.months) ? b.months : null, products = Array.isArray(b?.products) ? b.products : null;
    if (!months || months.length < MIN_FORECAST_MONTHS || months.length > DEMO_MAX_MONTHS || !months.every((m) => YM.test(m)) || !products || products.length > 210 || !Array.isArray(b?.total?.history) || !Array.isArray(b?.total?.forecast)) return json({ error: "Bad summary request." }, 400);
    if (!demoAllowed(ip, 5)) return json({ error: "Please wait a few minutes and try again." }, 429);
    const num = (a, n) => (Array.isArray(a) && a.length === n && a.every((v) => typeof v === "number" && Number.isFinite(v)) ? a : null);
    const total = { history: num(b.total.history, months.length), forecast: num(b.total.forecast, 3) };
    const items = products.map((p) => ({ name: String(p?.name ?? "").slice(0, 120), next3: Number(p?.next3) || 0, last3: Number(p?.last3) || 0, method: ["flat", "trend", "holt", "seasonal", "lastyear"].includes(p?.method) ? p.method : "flat" }));
    if (!total.history || !total.forecast) return json({ error: "Bad summary request." }, 400);
    const fmonths = Array.from({ length: 3 }, (_, k) => addMonths(months[months.length - 1], k + 1));
    return json({ summary: explain({ months, kind: b.kind === "units" ? "units" : "money" }, items, total, fmonths) });
  }
  if (path === "/api/demo/request" && method === "POST") {
    const b = (await readJson(request, 20000)) || {};
    if (String(b.website || "")) return json({ ok: true }); // the hidden field only robots fill in
    const name = String(b.name ?? "").trim(), email = String(b.email ?? "").trim().toLowerCase(), comp = String(b.company ?? "").trim();
    if (!name || !comp) return json({ error: "Please add your name and company." }, 400);
    if (!EMAIL.test(email)) return json({ error: "That email doesn't look right." }, 400);
    const cf = request.cf || {};
    const r = await dir.requestAccess({ ...b, name, email, company: comp, city: cf.city, country: cf.country }, ip);
    if (r.error === "busy") return json({ error: "Thanks — we've already received several requests from here. We'll be in touch." }, 429);
    if (r.alert) ctx.waitUntil(sendAlert(env, r.alert.topic, { title: "Draxly access request", message: `${r.alert.lead.name} (${r.alert.lead.company}) — ${r.alert.lead.email}\nOpen your owner dashboard: ${origin}/owner`, click: `${origin}/owner`, tags: ["wave"], priority: 4 })
      .then((x) => (x.ok ? dir.markLeadAlerted(r.id) : null)).catch(() => {}));
    return json({ ok: true });
  }

  // Everything below needs a signed-in, switched-on company; the company comes only from the token.
  const me = await dir.who(token);
  if (!me) return json({ error: "Please sign in." }, 401);
  if (me.off) return offReply();
  const box = company(env, me.id);
  const who = me.user.email;
  const need = (role) => (RANK[me.role] >= RANK[role] ? null : json({ error: role === "admin" ? "Only your company's admins can do that." : "Your role can view but not change this. Ask an admin or manager." }, 403));
  const feature = async (f) => (me.features[f] ? null : json({ error: `${FEATURE_WORDS[f]} isn't switched on for your company.`, locked: true, feature: f, contact: await dir.contact() }, 402));
  if (me.mustEnroll2fa && !["/api/me", "/api/2fa/setup", "/api/2fa/enable", "/api/logout"].includes(path)) return json({ error: "Your company requires two-factor sign-in. Set it up to continue.", enroll2fa: true }, 403);

  if (path === "/api/billing" && method === "GET") {
    if (need("admin")) return need("admin");
    return json({ billing: await dir.billing(me.id), instructions: (await dir.platform()).paymentInstructions || "", seller: (await dir.platform()).billingName });
  }
  const bp = /^\/api\/billing\/invoices\/([0-9a-f]{32})\/pdf$/.exec(path);
  if (bp && method === "GET") {
    if (need("admin")) return need("admin");
    const r = await dir.invoicePdfFor(bp[1], me.id);
    if (!r) return json({ error: "Not found." }, 404);
    audit(me.id, who, "downloaded an invoice", r.number);
    return pdfResponse(r);
  }
  if (path === "/api/me" && method === "GET") { ctx.waitUntil(box.setOrigin(origin)); ctx.waitUntil(dir.setOrigin(origin)); return json({ me, contact: await dir.contact(), minForecast: MIN_FORECAST_MONTHS, minBacktest: MIN_BACKTEST_MONTHS, sso: await dir.ssoProviders() }); }

  // Own account: password, recovery code, two-factor, email preferences.
  if (path === "/api/password" && method === "POST") {
    const b = await readJson(request);
    const password = String(b?.password ?? "");
    if (pwError(password)) return json({ error: pwError(password) }, 400);
    const r = await dir.changePassword(me.user.id, token, String(b?.current ?? "").slice(0, 200), password);
    if (r.error === "wait") return waitMsg(r);
    if (r.error === "wrong") return json({ error: "Your current password isn't right." }, 400); // 401 means "not signed in"
    audit(me.id, who, "changed password");
    return json({ ok: true, recoveryCode: r.recoveryCode });
  }
  if (path === "/api/recovery-code" && method === "POST") {
    const b = await readJson(request);
    const r = await dir.newRecovery(me.user.id, String(b?.password ?? "").slice(0, 200));
    if (r.error === "wait") return waitMsg(r);
    if (r.error === "wrong") return json({ error: "Your password isn't right." }, 400);
    audit(me.id, who, "made a new recovery code");
    return json(r);
  }
  if (path === "/api/2fa/setup" && method === "POST") return json(await dir.totpSetup(me.user.id));
  if (path === "/api/2fa/enable" && method === "POST") {
    const b = await readJson(request);
    const r = await dir.totpEnable(me.user.id, String(b?.code ?? ""));
    if (r.error) return json({ error: r.error === "setup" ? "Start the setup again." : "That code isn't right. Check the time on your phone and try the newest code." }, 400);
    audit(me.id, who, "turned on two-factor sign-in");
    return json(r);
  }
  if (path === "/api/2fa/disable" && method === "POST") {
    const b = await readJson(request);
    const r = await dir.totpDisable(me.user.id, String(b?.password ?? "").slice(0, 200));
    if (r.error === "required") return json({ error: "Your company requires two-factor sign-in." }, 403);
    if (r.error) return json({ error: "Your password isn't right." }, 400);
    audit(me.id, who, "turned off two-factor sign-in");
    return json(r);
  }
  if (path === "/api/prefs" && method === "POST") { const b = (await readJson(request)) || {}; return json({ prefs: await dir.setPrefs(me.user.id, b) }); }

  // Uploads and forecasts.
  if (path === "/api/uploads" && method === "GET") return json({ uploads: await box.list() });
  if (path === "/api/uploads" && method === "POST") {
    if (need("manager")) return need("manager");
    const b = await readJson(request);
    if (!b) return json({ error: "That file is too big or couldn't be read." }, 413);
    const c = cleanSeries(b, me.features.multiLocation);
    if (c.error) return json({ error: c.error }, 400);
    const r = await box.addUpload(me.id, { name: c.name, months: c.months, series: c.series, source: "file", final: b.final !== false });
    if (r.error === "full") return json({ error: "You have 50 uploads. Delete an old one first." }, 409);
    if (r.error) return json({ error: r.error === "tooMany" ? `More than ${MAX_SERIES.toLocaleString("en-US")} product × location combinations — split the file.` : "That upload couldn't be saved." }, 400);
    if (b.final !== false) audit(me.id, who, "uploaded sales", `${c.name}: ${r.upload.months} months, ${r.upload.series} series`);
    return json({ upload: r.upload });
  }
  const um = /^\/api\/uploads\/([0-9a-f]{32})(\/forecast|\/series|\/finish|\/drill)?$/.exec(path);
  if (um) {
    const [, uid, sub] = um;
    if (sub === "/series" && method === "POST") {
      if (need("manager")) return need("manager");
      const b = await readJson(request);
      const c = cleanSeries(b, me.features.multiLocation);
      if (c.error) return json({ error: c.error }, 400);
      const r = await box.appendSeries(uid, c.months, c.series);
      if (r.error) return json({ error: r.error === "tooMany" ? `More than ${MAX_SERIES.toLocaleString("en-US")} product × location combinations — split the file.` : r.error === "months" ? `More than ${MAX_MONTHS} months in total.` : "That upload isn't open for more data." }, 400);
      return json(r);
    }
    if (sub === "/finish" && method === "POST") {
      if (need("manager")) return need("manager");
      const r = await box.finishUpload(uid);
      if (r.error) return json({ error: "Not found." }, 404);
      audit(me.id, who, "uploaded sales", `${r.upload.name}: ${r.upload.months} months, ${r.upload.series} series`);
      return json(r);
    }
    if (sub === "/forecast" && method === "POST") {
      if (await feature("forecasts")) return json({ error: "The 3-month forecast isn't switched on for your account yet.", locked: true, contact: await dir.contact() }, 402);
      if (need("manager") && !(await box.get(uid))?.hasForecast) return need("manager");
      const r = await box.requestForecast(uid);
      if (!r) return json({ error: "Not found." }, 404);
      audit(me.id, who, "made a forecast", uid);
      return json(r);
    }
    if (sub === "/drill" && method === "GET") {
      const q = new URL(request.url).searchParams, f = {};
      for (const k of ["product", "location", "region"]) if (q.has(k)) f[k] = q.get(k);
      const mode = q.get("mode") === "backtest" ? "backtest" : "forecast";
      if (mode === "forecast" && !me.features.forecasts) return feature("forecasts");
      const r = await box.drill(uid, { ...f, mode, measure: q.get("measure") || undefined });
      return r ? json(r) : json({ error: "Not found." }, 404);
    }
    if (!sub && method === "GET") { const u = await box.get(uid, { forecastAllowed: me.features.forecasts }); return u ? json({ upload: u }) : json({ error: "Not found." }, 404); }
    if (!sub && method === "DELETE") {
      if (need("manager")) return need("manager");
      const u = await box.get(uid);
      await box.remove(uid);
      if (u) audit(me.id, who, "deleted an upload", u.name);
      return new Response(null, { status: 204 });
    }
  }

  // Stock levels and reorder suggestions.
  if (path.startsWith("/api/stock") || path === "/api/reorder") {
    if (await feature("inventory")) return feature("inventory");
    if (path === "/api/reorder" && method === "GET") return json(await box.reorder());
    if (path === "/api/stock" && method === "GET") return json({ ...(await box.inventory()), settings: await box.inventorySettings() });
    if (need("manager")) return need("manager");
    if (path === "/api/stock" && method === "POST") {
      const b = await readJson(request);
      if (!Array.isArray(b?.items) || b.items.length > 20000) return json({ error: "Send a list of up to 20,000 items." }, 400);
      return json(await box.upsertInventory(me.id, b.items, { replace: Boolean(b.replace), source: "file", by: who }));
    }
    if (path === "/api/stock/settings" && method === "POST") { const b = (await readJson(request)) || {}; audit(me.id, who, "changed reorder settings"); return json(await box.setInventorySettings(b)); }
  }

  // Weekly reports.
  if (path.startsWith("/api/reports")) {
    if (await feature("reports")) return feature("reports");
    if (path === "/api/reports" && method === "GET") return json(await box.reportSettings());
    if (need("admin")) return need("admin");
    if (path === "/api/reports" && method === "POST") { const b = (await readJson(request)) || {}; audit(me.id, who, "changed the weekly report schedule"); return json(await box.setReportSettings(me.id, b)); }
    if (path === "/api/reports/send" && method === "POST") { audit(me.id, who, "sent the weekly report now"); return json(await box.sendReportNow(me.id, who)); }
  }

  // Connections (admins).
  if (path.startsWith("/api/connections")) {
    if (await feature("connectors")) return feature("connectors");
    if (path === "/api/connections" && method === "GET") return json({ connections: await box.connections(), kinds: connectorList(), quickbooksReady: Boolean((await dir.platform()).qbClientId && (await dir.platform()).qbSecret) });
    if (need("admin")) return need("admin");
    if (path === "/api/connections" && method === "POST") {
      const b = (await readJson(request)) || {};
      if (b.id && !CID.test(b.id)) return json({ error: "Not found." }, 404);
      const r = await box.saveConnection(me.id, { id: b.id, kind: b.kind, name: String(b.name ?? "").slice(0, 80), creds: b.creds || {}, historyMonths: b.historyMonths });
      if (r.error) return json({ error: r.message || (r.error === "kind" ? "Unknown system." : "Not found.") }, 400);
      audit(me.id, who, b.id ? "changed a connection" : "added a connection", `${r.connection.name} (${r.connection.kindName})`);
      if (r.connection.status !== "needs-auth") {
        const t = await box.testConnection(r.connection.id);
        if (t.ok) await box.syncNow(r.connection.id, who);
        return json({ ...r, test: t });
      }
      return json(r);
    }
    const cm = /^\/api\/connections\/([0-9a-f]{24})(\/test|\/sync|\/authorize)?$/.exec(path);
    if (cm) {
      const [, cid, sub] = cm;
      if (sub === "/test" && method === "POST") { const t = await box.testConnection(cid); audit(me.id, who, "tested a connection", `${t.ok ? "ok" : "failed"}: ${t.message}`); return json(t); }
      if (sub === "/sync" && method === "POST") { const r = await box.syncNow(cid, who); return r.error ? json({ error: "Not found." }, 404) : json(r); }
      if (sub === "/authorize" && method === "GET") {
        const id = await dir.secret("qbClientId");
        if (!id) return json({ error: "The QuickBooks app isn't set up yet. The platform owner adds it on the owner dashboard." }, 409);
        const { state } = await dir.ssoBegin("quickbooks", "-", `${me.id}:${cid}`);
        const u = new URL(QB.authorize);
        for (const [k, v] of Object.entries({ client_id: id, response_type: "code", scope: QB.scope, redirect_uri: `${origin}/api/oauth/quickbooks`, state })) u.searchParams.set(k, v);
        return json({ url: u.toString() });
      }
      if (!sub && method === "DELETE") { const r = await box.removeConnection(cid); if (!r.error) audit(me.id, who, "removed a connection", r.name); return new Response(null, { status: 204 }); }
    }
  }

  // Team, security settings, API keys, activity log (admins).
  if (path === "/api/team" && method === "GET") { if (need("admin")) return need("admin"); return json({ users: await dir.users(me.id), roles: ROLES }); }
  if (path === "/api/team" && method === "POST") {
    if (need("admin")) return need("admin");
    const b = (await readJson(request)) || {};
    const email = String(b.email ?? "").trim().toLowerCase(), role = String(b.role ?? "viewer");
    if (!EMAIL.test(email)) return json({ error: "That email doesn't look right." }, 400);
    const r = await dir.invite(me.id, email, String(b.name ?? "").trim().slice(0, 100), role);
    if (r.error === "exists") return json({ error: "That email already has an account (here or at another company)." }, 409);
    if (r.error) return json({ error: "Pick a role: admin, manager or viewer." }, 400);
    const link = `${origin}/#/invite/${r.token}`;
    const mail = await sendEmail(env, dir, { to: [email], ...inviteEmail({ company: me.company, inviter: me.user.name || who, link, role }) });
    audit(me.id, who, "invited a user", `${email} as ${role}${mail.ok ? " (emailed)" : ""}`);
    return json({ user: r.user, link, emailed: mail.ok, emailNote: mail.ok ? "" : mail.reason });
  }
  const tm = /^\/api\/team\/([0-9a-f]{32})(\/reinvite|\/reset)?$/.exec(path);
  if (tm) {
    if (need("admin")) return need("admin");
    const [, uid, sub] = tm;
    if (sub === "/reinvite" && method === "POST") { const r = await dir.reinvite(me.id, uid); if (r.error) return json({ error: "Not found." }, 404); audit(me.id, who, "sent a new invite link", r.email); return json({ link: `${origin}/#/invite/${r.token}` }); }
    if (sub === "/reset" && method === "POST") { const r = await dir.resetLink(uid, { account: me.id }); if (r.error) return json({ error: "Not found." }, 404); audit(me.id, who, "made a password reset link", r.user); return json({ link: `${origin}/#/reset/${r.token}`, expires: r.expires }); }
    if (!sub && method === "PATCH") {
      const b = (await readJson(request)) || {};
      if (uid === me.user.id && (b.off === true || (b.role && b.role !== "admin"))) return json({ error: "You can't switch off or demote yourself. Ask another admin." }, 400);
      const r = await dir.setUser(me.id, uid, { role: b.role, off: b.off, name: b.name });
      if (r.error === "lastAdmin") return json({ error: "Every company needs at least one admin." }, 400);
      if (r.error) return json({ error: r.error === "role" ? "Pick a role: admin, manager or viewer." : "Not found." }, 400);
      audit(me.id, who, "changed a user", `${r.user.email}: ${[b.role && `role ${b.role}`, typeof b.off === "boolean" && (b.off ? "switched off" : "switched on")].filter(Boolean).join(", ")}`);
      return json(r);
    }
    if (!sub && method === "DELETE") {
      if (uid === me.user.id) return json({ error: "You can't remove yourself." }, 400);
      const r = await dir.removeUser(me.id, uid);
      if (r.error === "lastAdmin") return json({ error: "Every company needs at least one admin." }, 400);
      if (r.error) return json({ error: "Not found." }, 404);
      audit(me.id, who, "removed a user", r.email);
      return new Response(null, { status: 204 });
    }
  }
  if (path === "/api/settings" && method === "GET") return json({ settings: await dir.companySettings(me.id) });
  if (path === "/api/settings" && method === "POST") {
    if (need("admin")) return need("admin");
    const b = (await readJson(request)) || {};
    if (b.requireSso === true && (await feature("sso"))) return feature("sso");
    if (b.require2fa === true && !me.require2fa && !me.user.twoFactor && !me.user.sso) return json({ error: "Turn on two-factor sign-in for yourself first (above), so you can't be locked out." }, 400);
    const r = await dir.setCompanySettings(me.id, b);
    if (r.error === "sso") return json({ error: "Single sign-on isn't available yet (it must be switched on for your company and set up by the platform owner)." }, 400);
    if (r.error === "timezone") return json({ error: "Unknown time zone." }, 400);
    audit(me.id, who, "changed security settings", Object.keys(b).join(", "));
    return json(r);
  }
  if (path === "/api/signout-everyone" && method === "POST") { if (need("admin")) return need("admin"); await dir.signOutEveryone(me.id, token); audit(me.id, who, "signed everyone else out"); return json({ ok: true }); }
  if (path === "/api/audit" && method === "GET") {
    if (need("admin")) return need("admin");
    const q = new URL(request.url).searchParams;
    return json({ events: await box.audit({ limit: Number(q.get("limit")) || 100, before: Number(q.get("before")) || null }) });
  }
  if (path === "/api/jobs" && method === "GET") return json({ jobs: await box.jobs() });
  if (path === "/api/keys" && method === "GET") { if (need("admin")) return need("admin"); return json({ keys: await dir.apiKeys(me.id) }); }
  if (path === "/api/keys" && method === "POST") {
    if (need("admin")) return need("admin");
    if (await feature("api")) return feature("api");
    const b = (await readJson(request)) || {};
    const scopes = ["sales:write", "inventory:write", "forecasts:read"].filter((s) => (b.scopes || ["sales:write", "inventory:write", "forecasts:read"]).includes(s));
    if (!scopes.length) return json({ error: "Pick at least one permission." }, 400);
    const r = await dir.createApiKey(me.id, String(b.name ?? "").trim().slice(0, 60) || "API key", scopes, who);
    audit(me.id, who, "created an API key", `${r.name} (${r.prefix}…) ${scopes.join(", ")}`);
    return json(r);
  }
  const km = /^\/api\/keys\/(fa_live_[0-9a-f]{8})$/.exec(path);
  if (km && method === "DELETE") { if (need("admin")) return need("admin"); await dir.revokeApiKey(me.id, km[1]); audit(me.id, who, "revoked an API key", km[1]); return new Response(null, { status: 204 }); }
  return json({ error: "Not found." }, 404);
}

// ── Machine API (/v1) — API keys, for any system ───────────────────────────────────────────────────────────────
async function v1(request, env, path, ctx) {
  const dir = env.DIRECTORY.get(env.DIRECTORY.idFromName("main"));
  const k = await dir.apiKey(bearer(request));
  if (!k) return json({ error: "Missing or invalid API key." }, 401, { "WWW-Authenticate": "Bearer" });
  if (k.limited) return json({ error: "Rate limit: 120 calls a minute per key." }, 429, { "Retry-After": "60" });
  if (k.off) return json({ error: "This account is switched off." }, 403);
  if (!k.features.api) return json({ error: "The API isn't switched on for this company." }, 402);
  const box = company(env, k.account), method = request.method;
  const scope = (s) => (k.scopes.includes(s) ? null : json({ error: `This key doesn't have the ${s} permission.` }, 403));
  const log = (action, detail) => ctx.waitUntil(box.log({ user: `API key ${k.prefix}… (${k.name})`, action, detail, ip: ipOf(request) }).catch(() => {}));
  ctx.waitUntil(box.setOrigin(new URL(request.url).origin));

  if (path === "/v1/sales" && method === "POST") {
    if (scope("sales:write")) return scope("sales:write");
    const b = await readJson(request);
    const rows = Array.isArray(b?.rows) ? b.rows : null;
    if (!rows || !rows.length || rows.length > 5000) return json({ error: "Send { rows: [...] } with 1 to 5,000 rows: { date, product, location?, region?, amount?, quantity? }." }, 400);
    const mode = b.mode === "add" ? "add" : "replace_months";
    const clean = rows.map((x) => ({ date: x?.date, product: x?.product ?? x?.sku, location: k.features.multiLocation ? x?.location ?? x?.store ?? "" : "", region: k.features.multiLocation ? x?.region ?? "" : "", amount: x?.amount ?? x?.sales, units: x?.quantity ?? x?.units }));
    const r = await box.apiSales(k.account, clean, mode);
    if (r.error) return json({ error: "No usable rows (each needs a date like 2026-11-15 and a product).", rejected: r.bad }, 400);
    log("sales received through the API", `${r.accepted} rows, ${r.months.length} months (${mode})`);
    return json(r, 202);
  }
  if (path === "/v1/files" && method === "POST") {
    if (scope("sales:write")) return scope("sales:write");
    if (Number(request.headers.get("Content-Length") || 0) > MAX_FILE) return json({ error: "Files up to 20 MB; send bigger exports in parts." }, 413);
    const buf = await request.arrayBuffer();
    if (buf.byteLength > MAX_FILE) return json({ error: "Files up to 20 MB; send bigger exports in parts." }, 413);
    let text; try { text = new TextDecoder("utf-8", { fatal: true }).decode(buf); } catch { text = new TextDecoder("windows-1252").decode(buf); }
    const q = new URL(request.url).searchParams, mapping = {};
    for (const f of ["date", "product", "location", "region", "amount", "units", "dateOrder"]) if (q.get(f)) mapping[f] = q.get(f);
    if (mapping.dateOrder && !["dmy", "mdy", "ymd"].includes(mapping.dateOrder)) return json({ error: "dateOrder must be dmy, mdy or ymd." }, 400);
    if (!k.features.multiLocation) { delete mapping.location; delete mapping.region; mapping.location = "\u0000none"; mapping.region = "\u0000none"; }
    const r = await box.apiFile(k.account, text, { mode: q.get("mode") === "add" ? "add" : "replace_months", mapping });
    log("file received through the API", `${Math.round(buf.byteLength / 1024)} KB`);
    return json(r, 202);
  }
  if (path === "/v1/inventory" && method === "POST") {
    if (scope("inventory:write")) return scope("inventory:write");
    if (!k.features.inventory) return json({ error: "Stock and reorder suggestions aren't switched on for this company." }, 402);
    const b = await readJson(request);
    const items = Array.isArray(b?.items) ? b.items : null;
    if (!items || !items.length || items.length > 20000) return json({ error: "Send { items: [...] } with 1 to 20,000 items: { product, location?, on_hand, on_order?, lead_time_days?, case_pack?, min_order?, unit_cost? }." }, 400);
    const clean = items.map((x) => ({ product: x?.product ?? x?.sku, location: x?.location ?? x?.store ?? "", onHand: x?.on_hand ?? x?.onHand, onOrder: x?.on_order ?? x?.onOrder, leadDays: x?.lead_time_days ?? x?.leadDays, casePack: x?.case_pack ?? x?.casePack, minOrder: x?.min_order ?? x?.minOrder, unitCost: x?.unit_cost ?? x?.unitCost }));
    const r = await box.upsertInventory(k.account, clean, { replace: Boolean(b.replace), source: "api", by: `API key ${k.prefix}…` });
    return json(r, 202);
  }
  if (path === "/v1/forecasts" && method === "GET") {
    if (scope("forecasts:read")) return scope("forecasts:read");
    if (!k.features.forecasts) return json({ error: "The 3-month forecast isn't switched on for this company." }, 402);
    const q = new URL(request.url).searchParams, view = ["total", "product", "location", "region"].includes(q.get("view")) ? q.get("view") : "total";
    const r = await box.apiForecasts(q.get("upload") || "main", view);
    return r ? json(r) : json({ error: "No data yet." }, 404);
  }
  if (path === "/v1/reorder" && method === "GET") {
    if (scope("forecasts:read")) return scope("forecasts:read");
    if (!k.features.inventory) return json({ error: "Stock and reorder suggestions aren't switched on for this company." }, 402);
    return json(await box.reorder());
  }
  if (path === "/v1/jobs" && method === "GET") return json({ jobs: await box.jobs() });
  return json({ error: "Not found. See /docs for the API." }, 404);
}

// ── Owner API ───────────────────────────────────────────────────────────────────────────────────────────────────
async function ownerApi(request, env, path, dir, token, ctx) {
  const method = request.method, origin = new URL(request.url).origin;
  if (path === "/api/owner/state" && method === "GET") return json(await dir.ownerState());
  if ((path === "/api/owner/claim" || path === "/api/owner/login") && method === "POST") {
    const b = await readJson(request);
    const passcode = String(b?.passcode ?? "");
    if (passcode.length < 8 || passcode.length > 200) return json({ error: "The passcode needs at least 8 characters." }, 400);
    const r = path.endsWith("claim") ? await dir.ownerClaim(passcode) : await dir.ownerLogin(passcode);
    if (r.error === "taken") return json({ error: "The passcode is already set. Sign in with it." }, 409);
    if (r.error === "unclaimed") return json({ error: "No passcode yet — set one first." }, 409);
    if (r.error === "wait") return waitMsg(r);
    if (r.error === "wrong") return json({ error: `Wrong passcode. ${r.left} ${r.left === 1 ? "try" : "tries"} left before a 15-minute wait.` }, 401);
    return json(r);
  }
  if (!(await dir.ownerCheck(token))) return json({ error: "Please sign in." }, 401);
  const logFor = (account, action, detail = "") => ctx.waitUntil(company(env, account).log({ user: "platform owner", action, detail, ip: ipOf(request) }).catch(() => {}));
  if (path === "/api/owner/logout" && method === "POST") { await dir.ownerLogout(token); return new Response(null, { status: 204 }); }
  if (path === "/api/owner/customers" && method === "GET") {
    ctx.waitUntil(dir.setOrigin(origin));
    return json({ ...(await dir.customers()), features: FEATURES });
  }
  if (path === "/api/owner/log" && method === "GET") return json({ events: await dir.ownerLog() });
  if (path === "/api/owner/alerts" && method === "GET") return json({ topic: await dir.alertTopic() });
  if (path === "/api/owner/alerts" && method === "POST") {
    const b = (await readJson(request)) || {};
    if (b.off) return json({ topic: await dir.alertsOff() });
    if (b.make) return json({ topic: await dir.makeTopic() });
    return json({ error: "Nothing to do." }, 400);
  }
  if (path === "/api/owner/alerts/test" && method === "POST") {
    const topic = await dir.alertTopic();
    if (!topic) return json({ error: "Phone alerts are off. Make a topic first." }, 409);
    try { return json(await sendAlert(env, topic, { title: "Test alert", message: `Phone alerts are working. Example: Sunny Farm (maria@example.com) asked for a password reset link.\nOpen your owner dashboard: ${origin}/owner`, click: `${origin}/owner`, tags: ["white_check_mark"], priority: 4 })); }
    catch { return json({ ok: false, status: 0 }); }
  }
  if (path === "/api/owner/platform" && method === "GET") return json({ platform: await dir.platform(), callbacks: { sso: `${origin}/api/sso/callback`, quickbooks: `${origin}/api/oauth/quickbooks` } });
  if (path === "/api/owner/platform" && method === "POST") { const b = (await readJson(request)) || {}; return json({ platform: await dir.setPlatform(b) }); }
  if (path === "/api/owner/email-test" && method === "POST") {
    const b = (await readJson(request)) || {};
    if (!EMAIL.test(String(b.to || ""))) return json({ error: "Type an email address to send the test to." }, 400);
    const r = await sendEmail(env, dir, { to: [b.to], subject: "Draxly: test email", html: "<p>Email from Draxly is working.</p>", text: "Email from Draxly is working." });
    return json(r);
  }

  const testToday = (t) => (env.ALLOW_TEST_CLOCK === "1" && /^\d{4}-\d{2}-\d{2}$/.test(t || "") ? t : todayUTC());
  if (path === "/api/owner/demo" && method === "GET") return json(await dir.demoStats());
  const lm = /^\/api\/owner\/leads\/([0-9a-f]{24})$/.exec(path);
  if (lm && method === "POST") { const b = (await readJson(request)) || {}; const r = await dir.setLead(lm[1], b.status); return r.error ? json({ error: "Status must be new, contacted or closed." }, 400) : json(r); }
  if (path === "/api/owner/billing/run" && method === "POST") { const b = (await readJson(request)) || {}; return json(await dir.billingRun(testToday(b.today))); }
  const im = /^\/api\/owner\/invoices\/([0-9a-f]{32})\/(paid|send|pdf)$/.exec(path);
  if (im) {
    const [, iid, act] = im;
    if (act === "pdf" && method === "GET") { const r = await dir.invoicePdfFor(iid); return r ? pdfResponse(r) : json({ error: "Not found." }, 404); }
    if (act === "paid" && method === "POST") {
      const b = (await readJson(request)) || {};
      const r = await dir.markInvoice(iid, b.paid !== false, String(b.note ?? ""));
      if (r.error) return json({ error: "Not found." }, 404);
      logFor(r.account, b.paid !== false ? "invoice marked paid" : "invoice marked unpaid", r.number);
      return json(r);
    }
    if (act === "send" && method === "POST") { const r = await dir.sendInvoice(iid); return r.ok ? json(r) : json({ error: r.reason || "Didn't send." }, 400); }
  }
  const u = /^\/api\/owner\/customers\/([0-9a-f]{32})\/(uploads|audit|connections)(?:\/([0-9a-f]{32})(\/forecast)?)?$/.exec(path);
  if (u) {
    const [, cid, what, uid, fc] = u;
    if (!(await dir.exists(cid))) return json({ error: "Not found." }, 404);
    const box = company(env, cid);
    if (what === "audit" && method === "GET") return json({ events: await box.audit({ limit: 200 }) });
    if (what === "connections" && method === "GET") return json({ connections: await box.connections(), jobs: await box.jobs() });
    if (what === "uploads") {
      if (!uid && method === "GET") return json({ uploads: await box.list() });
      if (uid && fc && method === "POST") { const f = await box.requestForecast(uid); logFor(cid, "made a forecast", uid); return f ? json(f) : json({ error: "Not found." }, 404); }
      if (uid && !fc && method === "GET") { const x = await box.get(uid); return x ? json({ upload: x }) : json({ error: "Not found." }, 404); }
      if (uid && !fc && method === "DELETE") { await box.remove(uid); logFor(cid, "deleted an upload", uid); return new Response(null, { status: 204 }); }
    }
  }

  if (method !== "POST") return json({ error: "Not found." }, 404);
  const b = (await readJson(request)) || {};
  const id = String(b.id ?? "");
  if (path === "/api/owner/contact") return json({ contact: await dir.setContact(String(b.contact ?? "").trim().slice(0, 300)) });
  if (!ID.test(id)) return json({ error: "Which customer?" }, 400);
  if (path === "/api/owner/switch") {
    const r = await dir.setSwitch(id, { account: b.account, forecasts: b.forecasts });
    if (r.error) return json({ error: "Not found." }, 404);
    if (typeof b.account === "boolean") logFor(id, b.account ? "company switched on" : "company switched off");
    return json(r);
  }
  if (path === "/api/owner/agreement") {
    const billing = b.billing === "annual" ? "annual" : b.billing === "monthly" ? "monthly" : null;
    if (!billing) return json({ error: "Choose: pay the full year upfront, or $2,500 a month." }, 400);
    const start = /^\d{4}-\d{2}-\d{2}$/.test(b.start || "") ? b.start : todayUTC();
    const r = await dir.startAgreement(id, { start, billing }, testToday(b.today));
    if (r.error === "exists") return json({ error: "This company already has an active agreement. Cancel it first to change it." }, 409);
    if (r.error) return json({ error: "Not found." }, 404);
    logFor(id, "Draxly Enterprise agreement started", `${billing === "annual" ? "paid yearly upfront" : "$2,500 a month"}, from ${start}`);
    ctx.waitUntil(company(env, id).ensureAlarm(id).catch(() => {}));
    return json(r);
  }
  if (path === "/api/owner/agreement/cancel") {
    const r = await dir.cancelAgreement(id, testToday(b.today));
    if (r.error) return json({ error: "There's no active agreement to cancel." }, 400);
    logFor(id, "Draxly Enterprise agreement cancelled", "won't renew; the rest of the year is still owed");
    return json(r);
  }
  if (path === "/api/owner/features") {
    const r = await dir.setFeatures(id, b.features || {});
    if (r.error) return json({ error: "Not found." }, 404);
    logFor(id, "features changed", Object.entries(b.features || {}).map(([k, v]) => `${k} ${v ? "on" : "off"}`).join(", "));
    ctx.waitUntil(company(env, id).ensureAlarm(id).catch(() => {}));
    return json(r);
  }
  if (path === "/api/owner/contract") {
    const cents = b.contract === undefined ? undefined : Math.round(Number(b.contract) * 100);
    if (cents !== undefined && (!Number.isFinite(cents) || cents < 0 || cents > 1e12)) return json({ error: "Type the yearly contract value in dollars." }, 400);
    if (cents !== undefined && cents > 0 && cents < MIN_CONTRACT_CENTS && !b.allowBelowMinimum) return json({ error: `Contracts start at $${(MIN_CONTRACT_CENTS / 100).toLocaleString("en-US")} a year.`, belowMinimum: true }, 400);
    const date = (v) => (v === undefined ? undefined : v === "" || v === null ? "" : /^\d{4}-\d{2}-\d{2}$/.test(v) ? v : null);
    if (date(b.start) === null || date(b.end) === null) return json({ error: "Dates look like 2026-12-01." }, 400);
    const r = await dir.setContract(id, { plan: b.plan, contractCents: cents, start: date(b.start), end: date(b.end), note: b.note });
    if (r.error) return json({ error: "Not found." }, 404);
    if (b.allFeatures) await dir.setFeatures(id, Object.fromEntries(FEATURES.map((f) => [f, true])));
    return json(r);
  }
  if (path === "/api/owner/payment") {
    const amount = Number(b.amount);
    if (!Number.isFinite(amount) || amount <= 0 || amount > 10_000_000) return json({ error: "Type the amount received (more than 0)." }, 400);
    const r = await dir.addPayment(id, Math.round(amount * 100), String(b.note ?? "").trim().slice(0, 200));
    return r.error ? json({ error: "Not found." }, 404) : json(r);
  }
  if (path === "/api/owner/payment-delete") return json(await dir.deletePayment(id, String(b.paymentId ?? "")));
  if (path === "/api/owner/reset-link") {
    const r = await dir.resetLink(String(b.user || id));
    if (r.error) return json({ error: "Not found." }, 404);
    logFor(r.account, "platform owner made a password reset link", r.user);
    return json({ token: r.token, expires: r.expires, user: r.user });
  }
  if (path === "/api/owner/delete-customer") {
    const r = await dir.deleteCustomer(id);
    if (r.error) return json({ error: "Not found." }, 404);
    await company(env, id).wipe();
    return json({ ok: true });
  }
  return json({ error: "Not found." }, 404);
}

// ── Files ──────────────────────────────────────────────────────────────────────────────────────────────────────
const bodies = new Map();
const bodyOf = (path, f) => {
  if (f.text !== undefined) return f.text;
  if (!bodies.has(path)) bodies.set(path, Uint8Array.from(atob(f.b64), (c) => c.charCodeAt(0)));
  return bodies.get(path);
};
const matches = (pattern, path) => (pattern.endsWith("*") ? path.startsWith(pattern.slice(0, -1)) : pattern === path);
function respond(request, path, f, status = 200) {
  const headers = new Headers({ "Content-Type": f.type, "Cache-Control": "no-cache", ETag: f.etag, "Strict-Transport-Security": "max-age=31536000; includeSubDomains" });
  for (const r of RULES) if (matches(r.pattern, path)) for (const [k, v] of Object.entries(r.headers)) headers.set(k, v);
  if (status === 200 && request.headers.get("If-None-Match") === f.etag) return new Response(null, { status: 304, headers });
  return new Response(request.method === "HEAD" ? null : bodyOf(path, f), { status, headers });
}

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    if (url.pathname.startsWith("/api/") || url.pathname.startsWith("/v1/")) {
      try {
        const res = url.pathname.startsWith("/v1/") ? await v1(request, env, url.pathname, ctx) : await api(request, env, url.pathname, ctx);
        if (res.status !== 302) res.headers.set("Strict-Transport-Security", "max-age=31536000; includeSubDomains");
        return res;
      } catch (err) { console.error(err?.stack || err); return json({ error: "Something went wrong. Please try again." }, 500); }
    }
    if (request.method !== "GET" && request.method !== "HEAD") return new Response("Method not allowed", { status: 405, headers: { Allow: "GET, HEAD" } });
    let path;
    try { path = decodeURIComponent(url.pathname); } catch { path = url.pathname; }
    if (/\/index\.html$/.test(path)) return Response.redirect(new URL(path.replace(/index\.html$/, "") + url.search, url), 307);
    if (/\.html$/.test(path) && path !== "/404.html") return Response.redirect(new URL(path.replace(/\.html$/, "") + url.search, url), 307);
    const key = path.endsWith("/") ? path + "index.html" : FILES[path] ? path : FILES[path + ".html"] ? path + ".html" : null;
    if (key && FILES[key]) return respond(request, path, FILES[key]);
    return respond(request, path, FILES["/404.html"], 404);
  },
  /** Hourly safety net: makes sure every company's own schedule (nightly syncs, weekly reports) is armed. */
  async scheduled(event, env, ctx) {
    const dir = env.DIRECTORY.get(env.DIRECTORY.idFromName("main"));
    const hour = new Date(event.scheduledTime || Date.now()).getUTCHours();
    ctx.waitUntil(dir.billingRun().catch(() => {})); // daily invoices, renewals and reminders (safe to run every hour)
    const ids = await dir.companyIds("", 2000);
    const mine = ids.filter((_, i) => i % 24 === hour).slice(0, 45);
    await Promise.all(mine.map((id) => company(env, id).ensureAlarm(id).catch(() => {})));
  },
};
