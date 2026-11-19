/**
 * The Scout's night, in small steps (one per Cron Trigger run, every 5 minutes from 1:00 to 4:55 a.m. Jamaica time),
 * saved in KV after each step so it fits Cloudflare's free plan. No Gemini search: public sources are fetched directly,
 * and Gemini only reads that text (no grounding).
 *
 *   1. fetch      Hacker News (Algolia API), Remotive, The Muse and Himalayas job APIs, We Work Remotely RSS; Reddit only
 *                 if its rules allow
 *   2. analyze    batches of ~30 texts → Gemini picks complaints, wishes and repetitive job duties, quoting them.
 *                 A quote is kept only if it appears word for word in the fetched text (that page is the proof).
 *   3. group      complaints → problems, scored 1–10 (people, paying, anger, build speed); repeats left out
 *   4. compete    for the top 5: posts that mention existing tools (Hacker News), then Gemini names the tools, again
 *                 only with a word-for-word quote; a price only if it's written in that text
 *   5. report     saved, with leads and ideas; emailed at 6 a.m.
 * At most one Gemini call per step (up to ~13 a night). A limit stops the night, and the report says so.
 */
import { ask, listModels, GeminiError } from "./gemini.js";
import { hackerNews, remotive, weWorkRemotely, theMuse, himalayas, reddit } from "./sources.js";
import { clusterPrompt, clusterSchema } from "./plan.js";
import { jamaica, similar, getJSON, putJSON, domainOf } from "./util.js";

const FETCH_PER_STEP = 3, BATCH = 30, STEP_MS = 3 * 60 * 1000, TOP = 5;
const DEFAULT_MODELS = "gemini-flash-lite-latest,gemini-flash-latest,gemini-2.5-flash-lite,gemini-2.5-flash";
export const LAST_SLOT = { hour: 4, minute: 55 };

export const HN_PHRASES = ["\"I wish there was\" software", "\"is there a tool\"", "\"is there software\"", "\"hate our software\"", "\"looking for software\" small business",
  "\"is there an app\" business", "\"we still use spreadsheets\"", "\"manual data entry\"", "\"we pay\" \"per month\" frustrated", "\"switched from\" software terrible",
  "\"anyone know a tool\"", "\"why is there no\" software", "\"spend hours every week\"", "\"copy and paste\" between systems", "\"our CRM\" hate",
  "\"would pay for\" tool", "\"is there a SaaS\"", "\"spreadsheet hell\"", "\"hired someone just to\"", "\"invoicing is a nightmare\"", "\"scheduling nightmare\"",
  "\"QuickBooks\" frustrating", "\"double entry\" manually", "\"our POS\" terrible", "\"inventory spreadsheet\"", "\"dispatch software\"", "\"small business owner\" software problem",
  "\"takes hours every week\"", "\"manual reconciliation\"", "\"no good software for\""];
export const HN_PER_NIGHT = 10, HN_HITS = 30, HN_DAYS = 90;
export const JOB_SEARCHES = ["data entry", "customer service", "scheduling", "accounts receivable", "bookkeeping", "dispatcher", "virtual assistant", "order processing"];
export const MUSE_CATEGORIES = ["Customer Service", "Administration and Office"];
export const HIMALAYAS_SEARCHES = ["data entry", "customer support", "administrative assistant", "bookkeeper", "scheduler", "billing specialist", "order entry", "dispatcher"];
export const WWR_FEEDS = ["remote-customer-support-jobs", "all-other-remote-jobs", "remote-sales-and-marketing-jobs", "remote-management-and-finance-jobs"];

const STOP_WORDS = { limit: "Gemini's free daily limit was reached", "no-free-quota": "Gemini refused the very first request on every model (\"quota exceeded\"): there seems to be no free quota for this key",
  location: "Gemini refused requests from this server's location", key: "There's no working Gemini API key", model: "No usable Gemini model was available", errors: "Gemini kept failing" };

/**
 * Tonight's fetches (21): Reddit (rules check), 10 Hacker News searches (30 results each, last 90 days), 2 Remotive
 * searches (they ask for ≤4 a day), 2 The Muse searches (only if its robots.txt allows), 2 Himalayas searches, 4 We Work Remotely feeds.
 */
const pick = (list, nightNo, n) => Array.from({ length: n }, (_, k) => list[(nightNo * n + k) % list.length]);
function fetchPlan(nightNo) {
  return [{ type: "reddit", q: "\"is there an app\" OR \"I wish there was\" small business" },
    ...pick(HN_PHRASES, nightNo, HN_PER_NIGHT).map((q) => ({ type: "hn", q })),
    ...pick(JOB_SEARCHES, nightNo, 2).map((q) => ({ type: "remotive", q })),
    ...MUSE_CATEGORIES.map((q) => ({ type: "muse", q })),
    ...pick(HIMALAYAS_SEARCHES, nightNo, 2).map((q) => ({ type: "himalayas", q })),
    ...WWR_FEEDS.map((q) => ({ type: "wwr", q }))];
}
function newNight(id, nightNo) {
  return { id, nightNo, startedAt: new Date().toISOString(), status: "running", model: null, triedModels: [], stopped: null, calls: 0, okCalls: 0, steps: 0, errorsInRow: 0,
    fetchQueue: fetchPlan(nightNo), fetched: [], docs: {}, nextDoc: 1, analyzeQueue: null, complaints: [], sources: {}, problems: null, compFetched: false, compDocs: {}, compDone: false, competitors: {}, log: [], notes: [], jobsPending: [], qualPending: [] };
}
const note = (st, msg) => { st.log.push({ at: new Date().toISOString(), msg }); if (st.log.length > 80) st.log.shift(); };
function stop(st, kind, message) {
  if (st.stopped) return;
  st.stopped = { kind, message: `${STOP_WORDS[kind] || "Stopped"}${message ? ` (${message.slice(0, 160)})` : ""}.`, at: new Date().toISOString() };
  note(st, `Stopped for the night: ${st.stopped.message}`);
}

/** One step. `manual` = "Run one step now" / a live test (a separate test report, at most 2 analysis batches). */
export async function runStep(env, { now = Date.now(), manual = false } = {}) {
  const t0 = Date.now(), kv = env.SCOUT;
  const jm = jamaica(now), id = manual ? `${jm.date}-test` : jm.date;
  const past = await getJSON(kv, "seen", { problems: [], queries: [], docs: [], nights: 0 });
  let st = await getJSON(kv, `night:${id}`);
  if (st?.status === "done" || st?.status === "stopped") return st;
  if (!st) st = newNight(id, past.nights || 0);
  st.steps++;
  const isLast = !manual && (jm.hour > LAST_SLOT.hour || (jm.hour === LAST_SLOT.hour && jm.minute >= LAST_SLOT.minute));
  let calls = 0;
  const timeLeft = () => Date.now() - t0 < STEP_MS;
  const gem = async (prompt, opts) => {
    for (;;) {
      try { calls++; st.calls++; const r = await ask(env, st.model, prompt, opts); st.errorsInRow = 0; st.okCalls++; return r; }
      catch (e) {
        if (!(e instanceof GeminiError)) throw e;
        if (e.kind === "model" && await nextModel(env, st)) continue; // retired for new users → the next model
        if (e.kind === "limit" && !st.okCalls) { st.refused = [...(st.refused || []), st.model]; if (await nextModel(env, st)) continue; stop(st, "no-free-quota", `models tried: ${st.refused.join(", ")}`); return null; }
        if (["limit", "location", "key", "model", "no-grounding"].includes(e.kind)) { stop(st, e.kind === "no-grounding" ? "errors" : e.kind, e.message); return null; }
        st.errorsInRow++; note(st, `Gemini error: ${e.message.slice(0, 160)}`);
        if (st.errorsInRow >= 4) stop(st, "errors", e.message);
        return null;
      }
    }
  };

  try {
    // 1. Fetch public sources (no Gemini).
    if (st.fetchQueue.length) {
      const seenDocs = new Set(past.docs || []);
      for (const task of st.fetchQueue.splice(0, FETCH_PER_STEP)) await fetchTask(env, st, task, seenDocs, now, jm.date);
    }
    if (!st.fetchQueue.length && !st.analyzeQueue) {
      const ids = Object.keys(st.docs);
      st.analyzeQueue = []; for (let i = 0; i < ids.length; i += BATCH) st.analyzeQueue.push(ids.slice(i, i + BATCH));
      if (manual) st.analyzeQueue = st.analyzeQueue.slice(0, 2);
      note(st, `Fetched ${ids.length} new public texts (${ids.filter((d) => st.docs[d].kind === "job").length} job ads).`);
    }
    // Gemini model (only once there's something to read).
    const needGemini = !st.stopped && st.analyzeQueue && (st.analyzeQueue.length || !st.problems || !st.compDone);
    if (needGemini && !st.model && (st.analyzeQueue.length || st.complaints.length)) {
      if (!env.GEMINI_API_KEY) stop(st, "key", "add GEMINI_API_KEY as a secret on the night-agent Worker");
      else { try { if (!(await nextModel(env, st))) stop(st, "model", `none of ${env.GEMINI_MODELS || DEFAULT_MODELS} is available to this key`); } catch (e) { stop(st, e instanceof GeminiError ? e.kind : "errors", e.message); } }
    }
    // 2. Analyze a batch.
    if (!st.stopped && st.analyzeQueue?.length && calls < 1 && timeLeft()) {
      const batch = st.analyzeQueue[0], r = await gem(analyzePrompt(batch.map((d) => ({ id: d, ...st.docs[d] }))), { schema: analyzeSchema, temperature: 0.1 });
      if (r || !st.stopped) { st.analyzeQueue.shift(); if (r) { const n = addEvidence(st, r.text); note(st, `Read ${batch.length} texts: ${n} with exact quotes.`); } }
    }
    // 3. Group and score.
    if (!st.stopped && st.analyzeQueue && !st.analyzeQueue.length && !st.problems && calls < 1 && timeLeft()) {
      if (!st.complaints.length) { st.problems = []; st.compDone = true; note(st, "No complaints or job ads with exact quotes were found tonight."); }
      else {
        const r = await gem(clusterPrompt(st.complaints.map(({ id, quote, who, where, pays, kind }) => ({ id, quote, who, where, pays, kind })), (past.problems || []).slice(-150).map((p) => p.title)), { schema: clusterSchema, temperature: 0.1 });
        if (r) { st.problems = cleanProblems(st, r.text, past); note(st, `Grouped into ${st.problems.length} new problem${st.problems.length === 1 ? "" : "s"}.`); if (!st.problems.length) st.compDone = true; }
      }
    }
    // 4. Competitors: fetch posts mentioning tools (no Gemini), then one Gemini call to name them.
    if (!st.stopped && st.problems?.length && !st.compFetched && calls < 1 && timeLeft()) {
      for (const p of st.problems.slice(0, TOP)) {
        try { st.compDocs[p.key] = (await hackerNews(env, `${keyTerms(p.title)} software`, { hits: 8 })).map((d) => addDoc(st, d)).filter(Boolean); } catch { st.compDocs[p.key] = []; }
      }
      st.compFetched = true;
      note(st, `Fetched posts about tools for the top ${Math.min(TOP, st.problems.length)} problems.`);
    } else if (!st.stopped && st.compFetched && !st.compDone && calls < 1 && timeLeft()) {
      const groups = st.problems.slice(0, TOP).map((p) => ({ p, docs: (st.compDocs[p.key] || []).map((d) => ({ id: d, ...st.docs[d] })).filter((d) => d.text) })).filter((g) => g.docs.length);
      if (!groups.length) st.compDone = true;
      else { const r = await gem(competitorPrompt(groups), { schema: competitorSchema, temperature: 0.1 }); if (r || !st.stopped) { st.compDone = true; if (r) addCompetitors(st, r.text); } }
    }
  } catch (e) { note(st, `Step error: ${String(e?.message || e).slice(0, 200)}`); }

  const working = !st.stopped && (st.fetchQueue.length || !st.analyzeQueue || st.analyzeQueue.length || !st.problems || !st.compDone);
  // Job ads go to the permanent database now, before this step's saved state drops any text (slim, finish).
  await flushJobs(env, st, kv, Boolean(isLast || !working));
  if (isLast || !working) await finish(env, st, past, Boolean(isLast && working));
  else await putJSON(kv, `night:${id}`, slim(st), { expirationTtl: 60 * 86400 });
  return st;
}

/** Texts that have been read and aren't quoted anywhere are dropped from the saved state (keeps each step small). */
function slim(st) {
  if (!st.analyzeQueue) return st;
  const keep = new Set([...st.analyzeQueue.flat(), ...Object.values(st.compDocs).flat(), ...st.complaints.map((c) => c.docId)]);
  for (const id of Object.keys(st.docs)) if (!keep.has(id)) { st.fetched.push(st.docs[id].url); delete st.docs[id]; }
  return st;
}

/** The permanent job-ad database: a SQLite Durable Object on Cloudflare (jobdb.js), a local SQLite in the tests. */
export const jobsDb = (env) => (env.JOBS ? env.JOBS.get(env.JOBS.idFromName("all")) : null);

/** Saves this run's waiting job ads (and "qualified" marks) to the database. If the database can't be reached, they stay
 *  in the night's state and are retried next step; at the end of a run they're kept in KV ("jobs-retry", no expiry) and
 *  retried on the next run. Saving twice is harmless, so nothing is lost and nothing is doubled. */
async function flushJobs(env, st, kv, final) {
  const db = jobsDb(env);
  st.jobsPending ||= []; st.qualPending ||= [];
  if (!db) return;
  const retry = await getJSON(kv, "jobs-retry", { jobs: [], quals: [] });
  const jobs = [...(retry.jobs || []), ...st.jobsPending], quals = [...(retry.quals || []), ...st.qualPending];
  if (!jobs.length && !quals.length) return;
  try {
    if (jobs.length) { const r = await db.save(jobs); st.jobsAdded = (st.jobsAdded || 0) + r.added; }
    st.jobsPending = [];
    if (quals.length) await db.qualify(quals);
    st.qualPending = [];
    if (retry.jobs?.length || retry.quals?.length) await putJSON(kv, "jobs-retry", { jobs: [], quals: [] });
  } catch (e) {
    note(st, `Job ads couldn't be saved to the database yet (${String(e?.message || e).slice(0, 120)}): kept, and tried again ${final ? "on the next run" : "next step"}.`);
    if (final) await putJSON(kv, "jobs-retry", { jobs: [...(retry.jobs || []), ...st.jobsPending].slice(-20000), quals: [...(retry.quals || []), ...st.qualPending].slice(-20000) });
  }
}

async function fetchTask(env, st, task, seenDocs, now, date) {
  try {
    let docs = [];
    if (task.type === "hn") docs = await hackerNews(env, task.q, { since: now - HN_DAYS * 86400000, hits: HN_HITS });
    else if (task.type === "muse") {
      const u = `${env.ALLOW_TEST === "1" && env.MUSE_BASE ? env.MUSE_BASE : "https://www.themuse.com"}/api/public/jobs`;
      if (!(await robotsAllow(st, u))) { note(st, `The Muse “${task.q}” skipped: its site rules (robots.txt) don't allow it, or couldn't be read.`); return; }
      docs = await theMuse(env, task.q);
    }
    else if (task.type === "himalayas") docs = await himalayas(env, task.q);
    else if (task.type === "remotive") docs = await remotive(env, task.q);
    else if (task.type === "wwr") docs = await weWorkRemotely(env, task.q);
    else if (task.type === "reddit") { const r = await reddit(env, task.q, (u) => robotsAllow(st, u)); if (r.skipped) { st.notes.push(r.skipped); note(st, r.skipped); return; } docs = r.docs; }
    // Every job ad found is queued for the permanent database, even ones already read before or over tonight's limit.
    const at = new Date(now).toISOString();
    for (const d of docs) if (d.kind === "job" && !st.jobsPending.some((x) => x.url === d.url))
      st.jobsPending.push({ url: d.url, company: d.company || "", role: d.role || d.title || "", source: d.src, pay: d.pay || "", location: d.location || "", run: st.id, date, at });
    let n = 0;
    for (const d of docs) if (!seenDocs.has(urlKey(d.url)) && !Object.values(st.docs).some((x) => x.url === d.url) && addDoc(st, d)) n++;
    note(st, `${sourceName(task)} “${task.q}”: ${n} new text${n === 1 ? "" : "s"}.`);
  } catch (e) { note(st, `${sourceName(task)} “${task.q}” failed: ${String(e?.message || e).slice(0, 120)}`); }
}
const sourceName = (t) => ({ hn: "Hacker News", remotive: "Remotive jobs", muse: "The Muse jobs", himalayas: "Himalayas jobs", wwr: "We Work Remotely", reddit: "Reddit" })[t.type];
const urlKey = (u) => String(u).replace(/^https?:\/\/(www\.)?/, "").slice(0, 90);
function addDoc(st, d) {
  const existing = Object.keys(st.docs).find((k) => st.docs[k].url === d.url);
  if (existing) return existing;
  if (Object.keys(st.docs).length >= 300) return null; // at most 10 reading batches (Gemini calls) a night
  const id = `d${st.nextDoc++}`; st.docs[id] = d; return id;
}
const keyTerms = (title) => String(title).replace(/[^A-Za-z0-9 ]+/g, " ").split(/\s+/).filter((w) => w.length > 3 && !/^(with|that|their|from|this|have|automatic|automated|software|tool|tools|small|businesses|business)$/i.test(w)).slice(0, 3).join(" ");

async function nextModel(env, st) {
  if (!st.available) { st.available = (await listModels(env).catch((e) => { if (e instanceof GeminiError && ["key", "location", "limit"].includes(e.kind)) throw e; return []; })).filter((m) => /flash/.test(m)); }
  for (const m of String(env.GEMINI_MODELS || DEFAULT_MODELS).split(",").map((x) => x.trim()).filter(Boolean)) {
    if (st.triedModels.includes(m) || (st.available.length && !st.available.includes(m))) continue;
    st.triedModels.push(m); st.model = m; note(st, `Using ${m}.`); return true;
  }
  return false;
}

// ── Reading the texts ──────────────────────────────────────────────────────────────────────────────────
export const analyzeSchema = { type: "OBJECT", properties: { items: { type: "ARRAY", items: { type: "OBJECT", properties: {
  docId: { type: "STRING" }, quote: { type: "STRING" }, paysQuote: { type: "STRING" } }, required: ["docId", "quote"] } } }, required: ["items"] };
export const analyzePrompt = (docs) => `Below are public texts: posts and comments (POST) and job ads (JOB). Find:
- POST: a person complaining about software they use, or wishing for software that doesn't exist or doesn't work well — especially business owners and teams that pay for software.
- JOB: a company paying someone to do repetitive work by hand that software could do (data entry, chasing invoices, answering calls, scheduling, taking orders, making reports, copying data between systems).
For each one, return the text's id and a QUOTE: one or two sentences copied EXACTLY, character for character, from that text. Never change, shorten inside, merge or invent words.
If the text says what they pay or would pay, copy those exact words as paysQuote; otherwise leave it empty.
Skip texts that aren't one of these. Return at most one item per text.

${docs.map((d) => `[${d.id}] ${d.kind === "job" ? `JOB — ${d.company || "company"}: ${d.role}${d.pay ? ` (${d.pay})` : ""}` : "POST"}\n${d.text}`).join("\n\n")}`;

const norm = (s) => String(s || "").toLowerCase().replace(/[‘’ʼ]/g, "'").replace(/[“”]/g, '"').replace(/[–—]/g, "-").replace(/…/g, "").replace(/\s+/g, " ").trim();
/** True only if `quote` appears word for word in `text` (ignoring case, spacing and curly quotes). */
export const inText = (quote, text, min = 20) => { const q = norm(quote).replace(/^["']+|["']+$/g, "").trim(); return q.length >= min && norm(text).includes(q); };

function addEvidence(st, raw) {
  let data; try { data = JSON.parse(raw); } catch { return 0; }
  let n = 0;
  for (const it of (data.items || []).slice(0, 60)) {
    const docId = typeof it.docId === "string" && st.docs[it.docId] ? it.docId : null, d = docId && st.docs[docId];
    if (!d || !it.quote || !inText(it.quote, d.text)) continue; // not word for word in the fetched text → left out
    if (st.complaints.some((c) => c.docId === docId || similar(c.quote, it.quote) > 0.8)) continue;
    const quote = String(it.quote).trim().replace(/^["']+|["']+$/g, "").slice(0, 500);
    const paysQuote = it.paysQuote && inText(it.paysQuote, d.text, 4) ? String(it.paysQuote).trim().slice(0, 160) : "";
    const job = d.kind === "job";
    const pays = job ? (d.pay ? `${d.pay} (job ad)` : "pays a salary for this work (job ad)") : paysQuote ? `“${paysQuote}”` : "unknown";
    const who = job ? `${d.company || "A company (name not given)"} is hiring ${/^[aeiou]/i.test(d.role) ? "an" : "a"} ${d.role}` : d.label;
    st.sources[d.url] = { url: d.url, domain: domainOf(d.url), verified: true, src: d.src };
    st.complaints.push({ id: `c${st.complaints.length + 1}`, docId, kind: job ? "job" : "post", quote, who, where: d.src + (d.title && !job ? `: ${d.title}` : ""), pays, sources: [d.url] });
    if (job) (st.qualPending ||= []).push({ url: d.url, quote, date: st.id.slice(0, 10) }); // this ad qualified
    n++;
  }
  return n;
}

// ── Competitors (tools people mention) ────────────────────────────────────────────────────────────────
export const competitorSchema = { type: "OBJECT", properties: { tools: { type: "ARRAY", items: { type: "OBJECT", properties: {
  problem: { type: "STRING" }, name: { type: "STRING" }, docId: { type: "STRING" }, quote: { type: "STRING" }, priceQuote: { type: "STRING" } }, required: ["problem", "name", "docId", "quote"] } } }, required: ["tools"] };
export const competitorPrompt = (groups) => `For each problem below there are public posts. List existing software products that the posts mention as a way to deal with that problem.
For each product: the problem key, the product name exactly as written, the post id, and a QUOTE copied EXACTLY from that post (one sentence) that mentions it — ideally what people like or dislike about it. If that post states a price for it, copy those exact words as priceQuote. Only products named in the posts; never add any from your own knowledge. At most 3 per problem.

${groups.map((g) => `PROBLEM ${g.p.key}: ${g.p.title}\n${g.docs.map((d) => `[${d.id}] ${d.text}`).join("\n")}`).join("\n\n")}`;

function addCompetitors(st, raw) {
  let data; try { data = JSON.parse(raw); } catch { return; }
  for (const t of (data.tools || []).slice(0, 30)) {
    const p = st.problems.find((x) => x.key === t.problem), d = st.docs[t.docId];
    if (!p || !d || !(st.compDocs[p.key] || []).includes(t.docId) || !t.name || !inText(t.quote, d.text) || !norm(d.text).includes(norm(t.name))) continue;
    const list = (st.competitors[p.key] ||= []);
    if (list.length >= 3 || list.some((c) => norm(c.name) === norm(t.name))) continue;
    st.sources[d.url] = { url: d.url, domain: domainOf(d.url), verified: true, src: d.src };
    const priceOk = t.priceQuote && /\d/.test(t.priceQuote) && inText(t.priceQuote, d.text, 3);
    list.push({ name: String(t.name).slice(0, 80), price: priceOk ? String(t.priceQuote).slice(0, 120) : null, priceSources: priceOk ? [d.url] : [], dislikes: String(t.quote).slice(0, 400), dislikeSources: [d.url], sources: [d.url] });
  }
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

// ── Site rules (checked before Reddit) ────────────────────────────────────────────────────────────────
const UA_TOKEN = "nightagentscout";
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

// ── The morning report ─────────────────────────────────────────────────────────────────────────────────
async function finish(env, st, past, cutShort) {
  const kv = env.SCOUT;
  if (cutShort && !st.stopped) note(st, "The night ended before everything was finished; this report has what was done.");
  st.status = st.stopped ? "stopped" : "done";
  st.finishedAt = new Date().toISOString();
  const report = buildReport(st, cutShort);
  // Every job ad this run found (qualified or not), straight from the permanent database, plus the all-time totals.
  const db = jobsDb(env);
  if (db) {
    try { report.allJobAds = await db.forRun(st.id); report.jobAdsTotals = await db.stats(); }
    catch (e) { report.allJobAdsError = `The job-ad database couldn't be read for this report (${String(e?.message || e).slice(0, 120)}). The ads are still saved: see Job ads on the dashboard.`; }
  }
  await putJSON(kv, `report:${st.id}`, report);
  const index = await getJSON(kv, "index", []);
  const entry = { id: st.id, status: st.status, stopped: st.stopped?.message || null, problems: report.problems.length, complaints: report.complaints.length, top: report.problems.slice(0, 3).map((p) => p.title) };
  await putJSON(kv, "index", [entry, ...index.filter((x) => x.id !== st.id)].slice(0, 180));
  // A test run ("Run one step now", the live test) only leaves its report: it doesn't mark texts as read or add to the
  // saved ideas and leads, so the real night isn't affected.
  const isTest = st.id.endsWith("-test");
  if (isTest) { await putJSON(kv, `night:${st.id}`, { ...st, docs: {}, compDocs: {} }, { expirationTtl: 60 * 86400 }); return; }
  // Ideas and leads are kept for good (monthly groups, never deleted).
  const month = st.id.slice(0, 7), now = new Date().toISOString();
  if (report.problems.length) {
    const bucket = await getJSON(kv, `ideas:${month}`, []);
    const ideas = report.problems.map((p) => ({ id: `${st.id}-${p.key}`, night: st.id, title: p.title, summary: p.summary, who: p.who, total: p.total, scores: p.scores, why: p.why,
      complaints: p.complaints.slice(0, 6).map((c) => ({ kind: c.kind, quote: c.quote, who: c.who, pays: c.pays, sources: c.sources.slice(0, 2) })),
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
  const docsSeen = [...st.fetched, ...Object.values(st.docs).map((d) => d.url)].map(urlKey);
  await putJSON(kv, "seen", { nights: (past.nights || 0) + 1, problems: [...(past.problems || []), ...report.problems.map((p) => ({ title: p.title, night: st.id }))].slice(-1000),
    queries: (past.queries || []).slice(-500), docs: [...(past.docs || []), ...docsSeen].slice(-4000) });
  await putJSON(kv, `night:${st.id}`, { ...st, docs: {}, compDocs: {} }, { expirationTtl: 60 * 86400 });
  const alert = await getJSON(kv, "settings", {});
  if (alert.ntfyTopic) {
    const base = env.ALLOW_TEST === "1" && env.NTFY_BASE ? env.NTFY_BASE : "https://ntfy.sh";
    const msg = report.problems.length ? report.problems.slice(0, 3).map((p, i) => `${i + 1}. ${p.title} (${p.total}/10)`).join("\n") : st.stopped ? st.stopped.message : "No new problems with proof tonight.";
    await fetch(`${base}/${alert.ntfyTopic}`, { method: "POST", headers: { Title: "Night Agent: morning report ready", Tags: "sunrise" }, body: msg, signal: AbortSignal.timeout(8000) }).catch(() => {});
  }
}

export function buildReport(st, cutShort = false) {
  const src = (url) => { const s = st.sources[url] || {}; return { url, domain: s.src || s.domain || domainOf(url), verified: s.verified ?? null }; };
  const complaint = (c) => ({ id: c.id, kind: c.kind || "post", quote: c.quote, who: c.who, where: c.where, pays: c.pays, sources: c.sources.map(src) });
  const problems = (st.problems || []).map((p) => ({ ...p, complaints: p.complaintIds.map((id) => st.complaints.find((c) => c.id === id)).filter(Boolean).map(complaint),
    competitors: (st.competitors[p.key] || []).map((c) => ({ ...c, sources: c.sources.map(src), priceSources: c.priceSources.map(src), dislikeSources: c.dislikeSources.map(src) })) }));
  const fetchedTotal = st.fetched.length + Object.keys(st.docs).length;
  return { id: st.id, status: st.status, stopped: st.stopped, cutShort, model: st.model, startedAt: st.startedAt, finishedAt: st.finishedAt, calls: st.calls, steps: st.steps,
    texts: fetchedTotal, sourcesNote: st.notes, grouped: Boolean(st.problems), jobAds: st.complaints.filter((c) => c.kind === "job").length,
    complaints: st.complaints.map(complaint), problems, leads: leadsOf(st, problems, complaint), log: st.log };
}

/** Up to 10 leads: public posts and job ads showing the need (never contacted), best first. */
function leadsOf(st, problems, complaint) {
  const ideaOf = new Map(); for (const p of problems) for (const id of p.complaintIds) ideaOf.set(id, p);
  return st.complaints.map((c) => {
    const p = ideaOf.get(c.id), out = complaint(c);
    return { ...out, idea: p ? p.title : null, ideaId: p ? `${st.id}-${p.key}` : null, rank: (p ? p.total : 3) + (c.pays !== "unknown" ? 2 : 0) };
  }).sort((a, b) => b.rank - a.rank).slice(0, 10).map(({ rank, ...l }) => l);
}
