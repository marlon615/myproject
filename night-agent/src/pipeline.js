/**
 * The Scout's night, in small steps (one per Cron Trigger run, every 5 minutes from 1:00 to 4:55 a.m. Jamaica time).
 * Each step does a little work and saves its progress in KV, so it fits Cloudflare's free plan (10 ms of CPU, 50
 * outside requests per run) and Gemini's free tier (1 Gemini call per step, so at most one every 5 minutes).
 *
 *   1. search    12 Google-grounded searches for real complaints and wishes (1 per step)
 *   2. resolve   every source link is turned into its real address, and quotes are checked on the page where possible
 *   3. group     the complaints are grouped into problems and scored (1 Gemini call)
 *   4. compete   the top 5 problems: existing products, prices, what users dislike (grounded, 1 per step)
 *   5. report    the morning report is saved; ideas from earlier reports are left out
 *
 * Only things Google's grounding tied to a web page are kept (with that page as proof). If Gemini says a limit is
 * reached, the Scout stops for the night and the report says so.
 */
import { ask, listModels, GeminiError, supportedSources } from "./gemini.js";
import { nightQueries, searchPrompt, competitorPrompt, clusterPrompt, clusterSchema, readBlocks } from "./plan.js";
import { jamaica, similar, getJSON, putJSON, domainOf } from "./util.js";

const MAX_CALLS_PER_STEP = 1, RESOLVE_PER_STEP = 10, VERIFY_PER_STEP = 2, STEP_MS = 3 * 60 * 1000, TOP = 5;
const DEFAULT_MODELS = "gemini-2.5-flash,gemini-2.5-flash-lite,gemini-flash-latest";
export const LAST_SLOT = { hour: 4, minute: 55 }; // the night's last run (Jamaica time): the report is finished then, whatever happens

const STOP_WORDS = { limit: "Gemini's free daily limit was reached", location: "Gemini refused requests from this server's location", key: "There's no working Gemini API key", model: "No usable Gemini model was available", "no-grounding": "Google Search grounding isn't available on the free tier for the available models", errors: "Gemini kept failing" };

function newNight(id, nightNo, past) {
  return { id, nightNo, startedAt: new Date().toISOString(), status: "running", model: null, triedModels: [], stopped: null, calls: 0, steps: 0, errorsInRow: 0,
    queries: nightQueries(nightNo, new Set(past.queries || [])).map((q) => ({ q, done: false })), complaints: [], sources: {}, problems: null, competitors: {}, compQueue: null, log: [] };
}
const note = (st, msg) => { st.log.push({ at: new Date().toISOString(), msg }); if (st.log.length > 60) st.log.shift(); };
function stop(st, kind, message) {
  if (st.stopped) return;
  st.stopped = { kind, message: `${STOP_WORDS[kind] || "Stopped"}${message ? ` (${message.slice(0, 160)})` : ""}.`, at: new Date().toISOString() };
  note(st, `Stopped for the night: ${st.stopped.message}`);
}

/** One step. Returns the night's state after it. `now` and `manual` are for "Run a step now" and tests. */
export async function runStep(env, { now = Date.now(), manual = false } = {}) {
  const t0 = Date.now(), kv = env.SCOUT;
  const jm = jamaica(now), id = manual ? `${jm.date}-test` : jm.date; // "Run one step now" builds a separate test report
  const past = await getJSON(kv, "seen", { problems: [], queries: [], nights: 0 });
  let st = await getJSON(kv, `night:${id}`);
  if (st?.status === "done" || st?.status === "stopped") return st;
  if (!st) st = newNight(id, past.nights || 0, past);
  st.steps++;
  const isLast = !manual && (jm.hour > LAST_SLOT.hour || (jm.hour === LAST_SLOT.hour && jm.minute >= LAST_SLOT.minute));
  let calls = 0;
  const timeLeft = () => Date.now() - t0 < STEP_MS;

  // Gemini call with the night's rules: a limit or a missing key stops the night; no grounding → try the next model.
  const gem = async (prompt, opts) => {
    for (;;) {
      try { calls++; st.calls++; const r = await ask(env, st.model, prompt, opts); st.errorsInRow = 0; return r; }
      catch (e) {
        if (!(e instanceof GeminiError)) throw e;
        if (e.kind === "no-grounding" && opts.search && await nextModel(env, st)) continue;
        if (["limit", "location", "key", "no-grounding", "model"].includes(e.kind)) { stop(st, e.kind, e.message); return null; }
        st.errorsInRow++; note(st, `Gemini error: ${e.message.slice(0, 160)}`);
        if (st.errorsInRow >= 4) stop(st, "errors", e.message);
        return null;
      }
    }
  };

  try {
    if (!st.stopped && !st.model) {
      if (!env.GEMINI_API_KEY) stop(st, "key", "add GEMINI_API_KEY as a secret on the night-agent Worker");
      else {
        try { if (!(await nextModel(env, st))) stop(st, "model", `none of ${env.GEMINI_MODELS || DEFAULT_MODELS} is available to this key`); }
        catch (e) { stop(st, e instanceof GeminiError ? e.kind : "errors", e.message); }
      }
    }
    // 1–2. Source links → real addresses, and quote checks (no Gemini calls).
    await resolveSources(st);
    // 1. Searches.
    while (!st.stopped && calls < MAX_CALLS_PER_STEP && timeLeft()) {
      const q = st.queries.find((x) => !x.done);
      if (!q) break;
      const r = await gem(searchPrompt(q.q), { search: true });
      if (!r) { if (!st.stopped) { q.done = true; q.error = true; } break; }
      q.done = true; q.found = addComplaints(st, r, q.q);
      note(st, `Searched “${q.q}”: ${q.found} complaint${q.found === 1 ? "" : "s"} with proof.`);
    }
    // 3. Group and score.
    if (!st.stopped && st.queries.every((x) => x.done) && !st.problems && calls < MAX_CALLS_PER_STEP && timeLeft()) {
      if (!st.complaints.length) { st.problems = []; note(st, "No complaints with proof were found tonight."); }
      else {
        const r = await gem(clusterPrompt(st.complaints.map(({ id, quote, who, where, pays }) => ({ id, quote, who, where, pays })), (past.problems || []).slice(-150).map((p) => p.title)), { schema: clusterSchema, temperature: 0.1 });
        if (r) { st.problems = cleanProblems(st, r.text, past); st.compQueue = st.problems.slice(0, TOP).map((p) => p.key); note(st, `Grouped into ${st.problems.length} new problem${st.problems.length === 1 ? "" : "s"}.`); }
      }
    }
    // 4. Competitors for the top problems.
    while (!st.stopped && st.compQueue?.length && calls < MAX_CALLS_PER_STEP && timeLeft()) {
      const key = st.compQueue[0], p = st.problems.find((x) => x.key === key);
      const r = await gem(competitorPrompt(p), { search: true });
      if (!r && !st.stopped) { st.compQueue.shift(); continue; }
      if (!r) break;
      st.compQueue.shift();
      st.competitors[key] = addCompetitors(st, r);
      note(st, `Checked competitors for “${p.title}”: ${st.competitors[key].length} with proof.`);
    }
    await resolveSources(st);
  } catch (e) { note(st, `Step error: ${String(e?.message || e).slice(0, 200)}`); }

  const searching = !st.stopped && (st.queries.some((x) => !x.done) || !st.problems || st.compQueue?.length);
  const pending = Object.values(st.sources).some((s) => s.url === undefined);
  if (isLast || (!searching && !pending) || (st.stopped && !pending)) await finish(env, st, past, isLast && (searching || pending));
  else await putJSON(kv, `night:${id}`, st, { expirationTtl: 60 * 86400 });
  return st;
}

async function nextModel(env, st) {
  if (!st.available) { st.available = (await listModels(env).catch((e) => { if (e instanceof GeminiError && ["key", "location", "limit"].includes(e.kind)) throw e; return []; })).filter((m) => /flash/.test(m)); }
  for (const m of String(env.GEMINI_MODELS || DEFAULT_MODELS).split(",").map((x) => x.trim()).filter(Boolean)) {
    if (st.triedModels.includes(m) || (st.available.length && !st.available.includes(m))) continue;
    st.triedModels.push(m); st.model = m; note(st, `Using ${m}.`); return true;
  }
  return false;
}

/** Keeps only items whose quote Google's grounding tied to a web page; those pages are the proof. */
function addComplaints(st, r, query) {
  let n = 0;
  for (const it of readBlocks(r.text, "ITEM", ["quote", "who", "where", "pays"])) {
    if (!it.quote || it.quote.length < 15) continue;
    const src = supportedSources(r, it._lines.quote || it.quote);
    if (!src.length) continue; // no proof → left out
    if (st.complaints.some((c) => similar(c.quote, it.quote) > 0.8)) continue;
    const uris = [];
    for (const s of src.slice(0, 3)) { if (!st.sources[s.uri]) st.sources[s.uri] = { title: s.title }; uris.push(s.uri); }
    // Who wrote it and what they pay are kept only if Google's grounding backs those lines too (no made-up details).
    const whoOk = it.who && supportedSources(r, it._lines.who || it.who).length > 0;
    const paysOk = it.pays && !/^unknown$/i.test(it.pays) && supportedSources(r, it._lines.pays || it.pays).length > 0;
    st.complaints.push({ id: `c${st.complaints.length + 1}`, quote: it.quote.slice(0, 500), who: whoOk ? it.who.slice(0, 160) : "", where: (it.where || "").slice(0, 120), pays: paysOk ? it.pays.slice(0, 200) : "unknown", sources: uris, query });
    n++;
  }
  return n;
}

function addCompetitors(st, r) {
  const out = [];
  for (const it of readBlocks(r.text, "COMPETITOR", ["name", "price", "dislikes"])) {
    if (!it.name) continue;
    const nameSrc = supportedSources(r, it._lines.name || it.name), priceSrc = it.price ? supportedSources(r, it._lines.price) : [], disSrc = it.dislikes ? supportedSources(r, it._lines.dislikes) : [];
    const all = [...nameSrc, ...priceSrc, ...disSrc];
    if (!all.length) continue; // nothing about it was tied to a page → left out
    const keep = (arr) => arr.slice(0, 2).map((s) => { if (!st.sources[s.uri]) st.sources[s.uri] = { title: s.title }; return s.uri; });
    out.push({ name: it.name.slice(0, 80), price: priceSrc.length && it.price && !/not published/i.test(it.price) ? it.price.slice(0, 120) : null, priceSources: keep(priceSrc),
      dislikes: disSrc.length ? it.dislikes.slice(0, 400) : null, dislikeSources: keep(disSrc), sources: keep(nameSrc.length ? nameSrc : all) });
    if (out.length >= 4) break;
  }
  return out;
}

const clamp = (v) => Math.max(1, Math.min(10, Math.round(Number(v) || 1)));
function cleanProblems(st, text, past) {
  let data; try { data = JSON.parse(text); } catch { return []; }
  const ids = new Set(st.complaints.map((c) => c.id)), pastTitles = (past.problems || []).map((p) => p.title), used = new Set();
  const out = [];
  for (const p of data.problems || []) {
    const cids = [...new Set((p.complaintIds || []).filter((x) => ids.has(x) && !used.has(x)))];
    if (!cids.length || !p.title) continue; // a problem needs real complaints behind it
    if (p.repeatOf && String(p.repeatOf).trim()) continue; // shown on an earlier night
    if (pastTitles.some((t) => similar(t, p.title) >= 0.5) || out.some((o) => similar(o.title, p.title) >= 0.6)) continue;
    cids.forEach((x) => used.add(x));
    const s = { people: clamp(p.people), pays: clamp(p.pays), anger: clamp(p.anger), buildSpeed: clamp(p.buildSpeed) };
    out.push({ key: `p${out.length + 1}`, title: String(p.title).slice(0, 140), summary: String(p.summary || "").slice(0, 600), who: String(p.who || "").slice(0, 200), complaintIds: cids, scores: s,
      total: Math.round((s.people * 0.3 + s.pays * 0.3 + s.anger * 0.2 + s.buildSpeed * 0.2) * 10) / 10, why: String(p.why || "").slice(0, 600) });
  }
  return out.sort((a, b) => b.total - a.total || b.complaintIds.length - a.complaintIds.length);
}

/** Source links from grounding are Google redirect links: find each one's real address, and check quotes on the page. */
async function resolveSources(st) {
  const todo = Object.entries(st.sources).filter(([, s]) => s.url === undefined).slice(0, RESOLVE_PER_STEP);
  await Promise.all(todo.map(async ([uri, s]) => {
    try {
      const res = await fetch(uri, { redirect: "manual", signal: AbortSignal.timeout(8000) });
      const loc = res.headers.get("location");
      s.url = res.status >= 300 && res.status < 400 && loc ? new URL(loc, uri).toString() : res.ok ? uri : null;
    } catch { s.url = null; }
    s.domain = domainOf(s.url || "") || s.title || domainOf(uri);
  }));
  const toCheck = [];
  for (const c of st.complaints) {
    const s = st.sources[c.sources[0]];
    if (s && s.url && s.verified === undefined && toCheck.length < VERIFY_PER_STEP) toCheck.push([c, s]);
  }
  await Promise.all(toCheck.map(async ([c, s]) => { s.verified = (await robotsAllow(st, s.url)) ? await quoteOnPage(s.url, c.quote) : null; }));
}

const UA_TOKEN = "nightagentscout";
/**
 * Site rules: a page is read only if the site's robots.txt allows it (for this agent or for all bots). No robots.txt
 * (404) means allowed; if robots.txt can't be read, the page isn't read. Rules are remembered per site for the night.
 */
async function robotsAllow(st, url) {
  let u; try { u = new URL(url); } catch { return false; }
  st.robots ||= {};
  if (!(u.origin in st.robots)) {
    try {
      const res = await fetch(`${u.origin}/robots.txt`, { headers: { "user-agent": "NightAgentScout/1.0" }, signal: AbortSignal.timeout(6000) });
      st.robots[u.origin] = res.status === 404 || res.status === 410 ? [] : res.ok ? robotsRules((await res.text()).slice(0, 60000)) : null;
    } catch { st.robots[u.origin] = null; }
  }
  const rules = st.robots[u.origin];
  if (!rules) return false;
  const path = u.pathname + u.search;
  let best = null;
  for (const [allow, pre] of rules) if (pre && path.startsWith(pre) && (!best || pre.length > best[1].length || (pre.length === best[1].length && allow))) best = [allow, pre];
  return !best || best[0];
}
/** The rules that apply to this agent: its own group if the file has one, otherwise the "*" group. → [[allow, prefix]] */
export function robotsRules(text) {
  const groups = []; let cur = null, lastWasAgent = false;
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.replace(/#.*/, "").trim(), m = /^([A-Za-z-]+)\s*:\s*(.*)$/.exec(line);
    if (!m) continue;
    const k = m[1].toLowerCase(), v = m[2].trim();
    if (k === "user-agent") { if (!lastWasAgent) { cur = { agents: [], rules: [] }; groups.push(cur); } cur.agents.push(v.toLowerCase()); lastWasAgent = true; continue; }
    lastWasAgent = false;
    if (cur && (k === "allow" || k === "disallow")) cur.rules.push([k === "allow", v.replace(/\*.*$/, "").replace(/\$$/, "")]);
  }
  const mine = groups.find((g) => g.agents.some((a) => a !== "*" && UA_TOKEN.includes(a))) || groups.find((g) => g.agents.includes("*"));
  return (mine?.rules || []).filter(([allow, pre]) => allow || pre !== "").slice(0, 300);
}
const squash = (t) => t.toLowerCase().replace(/<[^>]{0,2000}>/g, " ").replace(/&#39;|&rsquo;|&#x27;/g, "'").replace(/&quot;|&ldquo;|&rdquo;/g, '"').replace(/&amp;/g, "&").replace(/[‘’]/g, "'").replace(/[“”]/g, '"').replace(/\s+/g, " ");
/** true: the quote's words are on the page; false: the page loaded but they aren't; null: the page couldn't be read. */
async function quoteOnPage(url, quote) {
  try {
    const res = await fetch(url, { headers: { "user-agent": "Mozilla/5.0 (compatible; NightAgentScout/1.0)", accept: "text/html" }, signal: AbortSignal.timeout(8000) });
    if (!res.ok || !/html|text/.test(res.headers.get("content-type") || "")) return null;
    const reader = res.body.getReader(); let got = "", bytes = 0; const td = new TextDecoder();
    while (bytes < 300000) { const { done, value } = await reader.read(); if (done) break; bytes += value.length; got += td.decode(value, { stream: true }); }
    reader.cancel().catch(() => {});
    const words = squash(quote).replace(/[^a-z0-9' ]/g, " ").split(" ").filter(Boolean);
    if (words.length < 5) return null;
    const page = squash(got).replace(/[^a-z0-9' ]/g, " ").replace(/\s+/g, " ");
    const probe = words.slice(0, Math.min(8, words.length)).join(" ");
    return page.includes(probe);
  } catch { return null; }
}

/** The morning report: saved once, plus the history index and the list of ideas already shown. */
async function finish(env, st, past, cutShort) {
  const kv = env.SCOUT;
  if (cutShort && !st.stopped) note(st, "The night ended before everything was finished; this report has what was done.");
  st.status = st.stopped ? "stopped" : "done";
  st.finishedAt = new Date().toISOString();
  const report = buildReport(st, cutShort);
  await putJSON(kv, `report:${st.id}`, report);
  const index = await getJSON(kv, "index", []);
  const entry = { id: st.id, status: st.status, stopped: st.stopped?.message || null, problems: report.problems.length, complaints: report.complaints.length, top: report.problems.slice(0, 3).map((p) => p.title) };
  await putJSON(kv, "index", [entry, ...index.filter((x) => x.id !== st.id)].slice(0, 180));
  // Ideas and leads are kept for good (monthly groups, never deleted).
  const month = st.id.slice(0, 7), now = new Date().toISOString();
  if (report.problems.length) {
    const bucket = await getJSON(kv, `ideas:${month}`, []);
    const ideas = report.problems.map((p) => ({ id: `${st.id}-${p.key}`, night: st.id, title: p.title, summary: p.summary, who: p.who, total: p.total, scores: p.scores, why: p.why,
      complaints: p.complaints.slice(0, 6).map((c) => ({ quote: c.quote, who: c.who, pays: c.pays, sources: c.sources.slice(0, 2) })),
      competitors: p.competitors.map((c) => ({ name: c.name, price: c.price, priceSources: c.priceSources, dislikes: c.dislikes, dislikeSources: c.dislikeSources, sources: c.sources })), saved: now }));
    await putJSON(kv, `ideas:${month}`, [...bucket.filter((x) => x.night !== st.id), ...ideas]);
  }
  if (report.leads.length) {
    const bucket = await getJSON(kv, `leads:${month}`, []);
    await putJSON(kv, `leads:${month}`, [...bucket.filter((x) => x.night !== st.id), ...report.leads.map((l) => ({ ...l, night: st.id }))]);
  }
  const totals = await getJSON(kv, "totals", { ideas: 0, leads: 0 });
  await putJSON(kv, "totals", { ideas: totals.ideas + report.problems.length, leads: totals.leads + report.leads.length });
  const months = await getJSON(kv, "months", []);
  if (!months.includes(month)) await putJSON(kv, "months", [...months, month].sort().reverse());
  await putJSON(kv, "seen", { nights: (past.nights || 0) + 1, problems: [...(past.problems || []), ...report.problems.map((p) => ({ title: p.title, night: st.id }))].slice(-1000), queries: [...(past.queries || []), ...st.queries.filter((q) => q.done).map((q) => q.q)].slice(-3000) });
  await putJSON(kv, `night:${st.id}`, st, { expirationTtl: 60 * 86400 });
  const alert = await getJSON(kv, "settings", {});
  if (alert.ntfyTopic) {
    const base = env.ALLOW_TEST === "1" && env.NTFY_BASE ? env.NTFY_BASE : "https://ntfy.sh";
    const msg = report.problems.length ? report.problems.slice(0, 3).map((p, i) => `${i + 1}. ${p.title} (${p.total}/10)`).join("\n") : st.stopped ? st.stopped.message : "No new problems with proof tonight.";
    await fetch(`${base}/${alert.ntfyTopic}`, { method: "POST", headers: { Title: "Night Agent: morning report ready", Tags: "sunrise" }, body: msg, signal: AbortSignal.timeout(8000) }).catch(() => {});
  }
}

export function buildReport(st, cutShort = false) {
  const src = (uri) => { const s = st.sources[uri] || {}; return { url: s.url || uri, domain: s.domain || s.title || domainOf(uri), verified: s.verified ?? null }; };
  const complaint = (c) => ({ id: c.id, quote: c.quote, who: c.who, where: c.where, pays: c.pays, sources: c.sources.map(src) });
  const problems = (st.problems || []).map((p) => ({ ...p, complaints: p.complaintIds.map((id) => st.complaints.find((c) => c.id === id)).filter(Boolean).map(complaint),
    competitors: (st.competitors[p.key] || []).map((c) => ({ ...c, sources: c.sources.map(src), priceSources: c.priceSources.map(src), dislikeSources: c.dislikeSources.map(src) })) }));
  return { id: st.id, status: st.status, stopped: st.stopped, cutShort, model: st.model, startedAt: st.startedAt, finishedAt: st.finishedAt, calls: st.calls, steps: st.steps,
    searches: st.queries.filter((q) => q.done && !q.error).length, searchesPlanned: st.queries.length, grouped: Boolean(st.problems),
    complaints: st.complaints.map(complaint), problems, leads: leadsOf(st, problems, complaint), log: st.log };
}

/**
 * Leads: public posts where someone asked for software (never contacted in stage 1). Only real posts with a link; up to
 * 10, best first: the idea's score, whether they said what they pay, and whether the quote was found on the page.
 */
function leadsOf(st, problems, complaint) {
  const ideaOf = new Map(); for (const p of problems) for (const id of p.complaintIds) ideaOf.set(id, p);
  return st.complaints.filter((c) => c.sources.length).map((c) => {
    const p = ideaOf.get(c.id), out = complaint(c);
    return { ...out, idea: p ? p.title : null, ideaId: p ? `${st.id}-${p.key}` : null, rank: (p ? p.total : 3) + (c.pays !== "unknown" ? 2 : 0) + (out.sources.some((s) => s.verified) ? 1 : 0) };
  }).sort((a, b) => b.rank - a.rank).slice(0, 10).map(({ rank, ...l }) => l);
}
