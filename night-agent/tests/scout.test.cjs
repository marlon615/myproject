/**
 * Night Agent (Scout) tests, against stand-ins (tests/stub-gemini.cjs) for Gemini, Hacker News, Remotive, We Work
 * Remotely, reddit.com/robots.txt, Resend and ntfy:
 *   A. Whole nights through the real pipeline, step by step as the Cron Trigger runs them: public sources fetched
 *      directly; Reddit skipped because its rules say so; Gemini only reads the fetched text (no grounding); every quote
 *      must be word for word in the fetched text; job ads; scoring; competitors from posts; repeats; limits; a retired
 *      model; no free quota; missing key; a night cut short; KV writes and CPU per step; the email and build prompt.
 *   B. The real Worker (wrangler dev): cron runs, the 6 a.m. email, the passcode, dashboard, ideas, leads, settings.
 */
const { spawn } = require("child_process");
const fs = require("fs"), os = require("os"), path = require("path");
const { chromium } = require("playwright");

const STUB = 8931, PORT = 8932, SB = `http://localhost:${STUB}`, BASE = `http://localhost:${PORT}`;
const ROOT = path.join(__dirname, ".."), OUT = path.join(__dirname, "output"), WRANGLER = path.join(ROOT, "..", "chief-of-staff", "node_modules", ".bin", "wrangler");
let failures = 0;
const check = (ok, name, extra = "") => { console.log(`${ok ? "PASS" : "FAIL"}  ${name}${extra ? "  — " + extra : ""}`); if (!ok) failures++; };
const sleep = (ms) => new Promise((ok) => setTimeout(ok, ms));
const ctl = (b) => fetch(`${SB}/control`, { method: "POST", body: JSON.stringify(b) });
const callsSoFar = async () => (await (await fetch(`${SB}/calls`)).json());
const SOURCE_VARS = { HN_BASE: SB, REMOTIVE_BASE: SB, WWR_BASE: SB, REDDIT_BASE: SB, STACK_BASE: `http://127.0.0.1:${STUB}`, REMOTEOK_BASE: `http://127.0.0.1:${STUB}`, WN_BASE: `http://127.0.0.1:${STUB}`, HIMALAYAS_BASE: SB };

/** The job-ad database for part A: the real SQL (src/jobstore.js) on Node's SQLite, called like the Durable Object
 *  (arguments copied, as RPC does). failing(true) makes every call throw, like an unreachable database. */
function memoryJobs(JobAdsStore, IdeasStore) {
  const { DatabaseSync } = require("node:sqlite");
  const db = new DatabaseSync(":memory:");
  const sql = { exec(q, ...b) { const rows = db.prepare(q).all(...b); return { toArray: () => rows, one: () => rows[0] }; } };
  const tx = (fn) => { db.exec("BEGIN"); try { const r = fn(); db.exec("COMMIT"); return r; } catch (e) { db.exec("ROLLBACK"); throw e; } };
  const store = new JobAdsStore(sql, tx), ideas = new IdeasStore(sql, tx);
  let fail = false; const call = (o, name) => async (...a) => { if (fail) throw new Error("database unreachable (test)"); return structuredClone(o[name](...structuredClone(a)) ?? null); };
  const stub = { save: call(store, "save"), qualify: call(store, "qualify"), stats: call(store, "stats"), list: call(store, "list"), forRun: call(store, "forRun"),
    ideasRecord: call(ideas, "record"), ideasUpdate: call(ideas, "update"), ideasList: call(ideas, "list"), ideasCount: call(ideas, "count"), ideasFlag: call(ideas, "getFlag"), ideasSetFlag: call(ideas, "setFlag") };
  return { db, store, ideas, failing(v) { fail = v; }, idFromName: () => "all", get: () => stub };
}

function memoryKV() {
  const m = new Map(); let writes = 0;
  return { m, get writes() { return writes; }, resetWrites() { writes = 0; },
    async get(k, type) { const v = m.get(k); return v === undefined ? null : type === "json" ? JSON.parse(v) : v; },
    async put(k, v) { writes++; m.set(k, String(v)); }, async delete(k) { writes++; m.delete(k); } };
}

(async () => {
  fs.mkdirSync(OUT, { recursive: true });
  const stub = spawn(process.execPath, [path.join(__dirname, "stub-gemini.cjs"), String(STUB)], { stdio: ["ignore", "pipe", "inherit"] });
  await new Promise((ok) => stub.stdout.once("data", ok));
  const P = await import("../src/pipeline.js"), { JobAdsStore } = await import("../src/jobstore.js"), { IdeasStore } = await import("../src/ideastore.js");
  const newDb = () => memoryJobs(JobAdsStore, IdeasStore);
  const JOBS = newDb();
  // Every address the agent asks for, and the CPU spent inside fetch (Cloudflare does that natively; it doesn't count).
  const fetched = []; const realFetch = globalThis.fetch; let inFetch = 0;
  globalThis.fetch = async (u, o) => { fetched.push(String(u?.url || u)); const c0 = process.cpuUsage(); const res = await realFetch(u, o); const buf = await res.arrayBuffer(); const c = process.cpuUsage(c0); inFetch += (c.user + c.system) / 1000; return new Response(buf, { status: res.status, headers: res.headers }); };
  let kv = memoryKV();
  const env = { SCOUT: kv, JOBS, GEMINI_API_KEY: "test-key", ALLOW_TEST: "1", GEMINI_BASE: SB, NTFY_BASE: `${SB}/ntfy`, ...SOURCE_VARS };
  await kv.put("settings", JSON.stringify({ ntfyTopic: "night-agent-test" })); kv.resetWrites();

  async function night(day, { from = 0, e = env } = {}) {
    const steps = []; let st;
    for (let k = from; k < 48; k++) {
      const now = Date.parse(`${day}T06:00:00Z`) + k * 300000, before = (await callsSoFar()).filter((c) => c.model).length;
      inFetch = 0; const c0 = process.cpuUsage(); st = await P.runStep(e, { now }); const c = process.cpuUsage(c0);
      steps.push({ cpuMs: (c.user + c.system) / 1000 - inFetch, gemini: (await callsSoFar()).filter((x) => x.model).length - before });
      if (st.status !== "running") break;
    }
    return { st, steps, report: await e.SCOUT.get(`report:${st.id}`, "json") };
  }

  await night("2026-11-10", { e: { ...env, SCOUT: memoryKV(), JOBS: newDb() } }); // warm-up night (first run compiles the code), not checked
  await ctl({ reset: true }); fetched.length = 0;
  // ── A1. A normal night ──────────────────────────────────────────────────────────────────────────────
  let n = await night("2026-11-20");
  const r = n.report, calls1 = await callsSoFar();
  check(r && r.status === "done" && n.steps.length <= 24, "a night runs in small steps and leaves a finished morning report", `${n.steps.length} steps`);
  check(n.steps.every((s) => s.gemini <= 1) && calls1.filter((c) => c.model).length === 3, "at most 1 Gemini call per step, 3 in the whole night (read, group, competitors)", calls1.filter((c) => c.model).map((c) => c.kind).join(", "));
  check(calls1.filter((c) => c.model).every((c) => !c.search), "Gemini is never asked to search (no grounding): it only reads the fetched text");
  check(calls1.some((c) => c.path === "/api/v1/search_by_date") && calls1.some((c) => c.path === "/api/remote-jobs") && calls1.some((c) => /\.rss$/.test(c.path || "")), "public sources are fetched directly: Hacker News API, Remotive jobs API, We Work Remotely RSS");
  check(calls1.filter((c) => c.path === "/api/remote-jobs").length === 2, "Remotive is asked only twice a night (they ask for at most ~4 a day)");
  const hnCalls = calls1.filter((c) => c.path === "/api/v1/search_by_date" && (new URLSearchParams(c.query).get("query") || "").includes('"'));
  const hnBroad = calls1.filter((c) => c.path === "/api/v1/search_by_date" && !(new URLSearchParams(c.query).get("query") || "").includes('"') && !/ software$/.test(new URLSearchParams(c.query).get("query") || ""));
  check(hnCalls.length === 12 && hnCalls.every((c) => new URLSearchParams(c.query).get("hitsPerPage") === "40" && /created_at_i>\d+/.test(new URLSearchParams(c.query).get("numericFilters"))), "Hacker News: 12 phrase searches a night (was 10), 40 results each (was 30), from the last 90 days", `${hnCalls.length} searches`);
  check(hnBroad.length === 16 && hnBroad.every((c) => new URLSearchParams(c.query).get("hitsPerPage") === "40"), "…plus 8 broad searches of the last 3 days, and (with fewer than 150 new texts here) 8 extra searches", `${hnBroad.length}`);
  check(n.report.log.some((l) => /aim: at least 150\): adding 8 more Hacker News searches/.test(l.msg)) && r.sourcesNote.some((x) => /^Only 14 new public texts were found tonight \(aim: at least 150\)/.test(x)), "if a night finds fewer than 150 new texts, it adds more searches, and the report says honestly how many it found");
  const jc = calls1.filter((c) => c.path === "/api/public/jobs" || c.path === "/api/v2/remote-jobs"), hc = calls1.filter((c) => /^\/jobs\/api/.test(c.path || "")), wc = calls1.filter((c) => /\.rss$/.test(c.path || ""));
  check(jc.length === 0 && hc.length === 6 && wc.length === 5 && calls1.some((c) => c.path === "/remote-jobs.rss"), "job feeds: Himalayas 6 searches (was 2), We Work Remotely 5 feeds (was 4); Jobicy and The Muse (both failed from Cloudflare) are not asked", `${jc.length}/${hc.length}/${wc.length}`);
  const sc = calls1.filter((c) => c.path === "/2.3/questions");
  check(sc.length === 2 && sc.map((c) => new URLSearchParams(c.query).get("site")).join() === "softwarerecs,webapps" && sc.every((c) => new URLSearchParams(c.query).get("filter") === "withbody") && calls1.filter((c) => c.path === "/api").length === 1 && calls1.filter((c) => c.path === "/api/exposed_jobs/").length === 1, "new free sources: Stack Exchange (Software Recommendations and Web Applications questions), Remote OK and Working Nomads, once each");
  check(calls1.filter((c) => c.path === "/robots.txt").length === 2, "the new sources' site rules (robots.txt) are checked before they're asked, once a night");
  check(calls1.some((c) => c.path === "/robots.txt") && !calls1.some((c) => c.path === "/search.json") && r.sourcesNote.some((s) => /Reddit's site rules/.test(s)), "Reddit: its rules (robots.txt) are checked first; they don't allow it, so Reddit isn't fetched and the report says so", r.sourcesNote[0]);
  check(fetched.every((u) => ["localhost", "127.0.0.1"].includes(new URL(u).hostname)), "every request went to the stand-ins only (nothing else was contacted)", `${fetched.length} requests`);
  check(r.texts === 16, "it read 16 public texts: posts, questions and job ads, plus 2 posts about tools (non-US and non-repetitive job ads left out)", String(r.texts));
  const docsText = JSON.stringify(r) + JSON.stringify(JOBS.store.list({ limit: 500 }).rows);
  check(!/Senior Backend Developer|Senior Golang Engineer|Code Shop|Infra Co/.test(docsText), "unrelated jobs (developers on Remotive and Remote OK) aren't read or saved: repetitive-work roles only");
  check(!JSON.stringify(r).includes("Machine Learning") && !JSON.stringify(r).includes("Berlin"), "job ads that aren't repetitive work, or aren't open to the US, are left out");
  check(!JSON.stringify(r).includes("AI receptionist") && !JSON.stringify(r).includes("$999"), "a quote or a price that isn't word for word in the fetched text is left out (nothing made up)");
  const cs = Object.fromEntries(r.complaints.map((c) => [c.id, c]));
  check(r.complaints.length === 9 && r.complaints.every((c) => c.sources.length === 1 && /^https:\/\/(news\.ycombinator\.com\/item\?id=\d+|remotive\.com\/|weworkremotely\.com\/|remoteok\.com\/|himalayas\.app\/)/.test(c.sources[0].url)), "every piece of evidence links to its public page (Hacker News item, job ad)", r.complaints.map((c) => c.sources[0].url.slice(0, 45)).join(" | "));
  check(cs.c1.who === "Hacker News user threetruckhvac" && cs.c3.who === "Hacker News comment" && cs.c1.pays === "“We pay $300 a month for ServiceTitan”" && cs.c3.pays === "unknown", "'who' is the public username (or what the source says it is); 'pays' only when those words are in the text");
  const byWho = (re) => r.complaints.find((c) => re.test(c.who)) || {};
  check(byWho(/Gulf Coast/).kind === "job" && byWho(/Gulf Coast/).who === "Gulf Coast Food Distributors is hiring an Accounts Receivable Clerk" && byWho(/Gulf Coast/).pays === "$18-$21/hour (job ad)" && byWho(/Acme/).who === "Acme Logistics is hiring an Order Entry Specialist" && byWho(/Acme/).pays === "pays a salary for this work (job ad)", "job ads: company, role and pay from the job board itself; the ad is the proof");
  const jj = r.complaints.find((c) => /Lone Star/.test(c.who)), hj = r.complaints.find((c) => /Fresh Fields/.test(c.who));
  check(jj && jj.who === "Lone Star HVAC Services is hiring a Customer Service Scheduler" && jj.pays === "$38,000-44,000 a year (job ad)" && jj.sources[0].url.startsWith("https://remoteok.com/remote-jobs/") && hj && hj.pays === "$40,000-46,000 a year (job ad)" && hj.sources[0].url.startsWith("https://himalayas.app/"), "Remote OK and Himalayas job ads come in with company, role, the ad's link, and the pay the board lists", jj?.pays);
  check(r.problems.length === 2 && !JSON.stringify(r.problems).includes("made-up") && r.problems.map((p) => p.total).join() === "7.5,7.1", "grouped into problems, scored and ranked; a 'problem' with no real complaints is dropped", r.problems.map((p) => p.total).join(", "));
  // ── Every idea: one buyer, the exact product, a suggested price, at least 3 leads with proof links ──────
  check(r.problems.every((p) => p.buyer && p.product && Number.isInteger(p.price) && new Set(p.complaints.flatMap((c) => c.sources.map((x) => x.url))).size >= 3 && p.complaints.every((c) => /^https:\/\//.test(c.sources[0].url))), "every idea names one buyer, the product to build, a suggested monthly price, and at least 3 leads (each from a different public page)", r.problems.map((p) => `${p.price}/${p.complaints.length}`).join(" "));
  check(r.problems[0].buyer === "Owners of HVAC companies with 1–10 technicians" && /texts each customer automatically/.test(r.problems[0].product) && r.problems[0].price === 49 && r.problems[0].complaints.map((c) => c.who).join() === "Hacker News user threetruckhvac,Hacker News user hvac_dana,Hacker News user coolair_mike", "…for example: HVAC owners with 1–10 techs, an auto-text app, $49/month, and 3 named leads");
  const dropped = Object.fromEntries((r.dropped || []).map((d) => [d.title, d.why]));
  check(dropped["Rugged handheld scanner for HVAC techs"] === "hardware" && dropped["Admin work is tedious"] === "too broad" && dropped["Handwritten work orders into invoices"] === "only 1 lead (needs 3)" && dropped["Scheduling software double-booking technicians"] === "only 1 lead (needs 3)" && !r.problems.some((p) => /handheld|tedious|Handwritten|double-booking/.test(p.title)), "ideas that are hardware, too broad, or have fewer than 3 leads are dropped, and listed as 'left out' with the reason", JSON.stringify(dropped));
  const P2 = await import("../src/pipeline.js");
  check(r.problems[0].priceWhy === "One owner already pays $300 a month for ServiceTitan and still lacks this." && r.problems[1].priceWhy === "Our estimate: no price was found in tonight's sources.", "the price reason may only quote dollar amounts that are in the evidence ($300 is; an invented '$250 a month' is replaced by 'our estimate')");
  check(/invoice follow-up/.test(r.problems[1].title) && r.problems[1].complaints.every((c) => c.kind === "job"), "a job-ad idea makes the top 3 when it ranks");
  const comp = r.problems[0].competitors;
  check(comp.length === 1 && comp[0].name === "Jobber" && comp[0].price === "$69/month" && comp[0].sources[0].url === "https://news.ycombinator.com/item?id=2001" && /can't be timed/.test(comp[0].dislikes), "competitors come from posts that mention them, with the quote and link; a price only when it's written there; an invented tool is dropped", JSON.stringify(comp.map((c) => [c.name, c.price])));
  check(r.leads.length === 9 && r.leads.every((l) => l.sources[0].url.startsWith("https://")) && r.leads.filter((l) => l.kind === "job").length === 4, "leads: up to 10 public posts and job ads with links (here 9 — never padded)");
  check(kv.writes <= 40, "few KV writes a night (free plan: 1,000 a day)", `${kv.writes} writes`);
  const cpu = n.steps.map((s) => s.cpuMs).sort((a, b) => b - a);
  console.log(`      CPU per step, own work (Node, this machine): max ${cpu[0].toFixed(1)} ms, median ${cpu[Math.floor(cpu.length / 2)].toFixed(1)} ms`);
  check(cpu.every((x) => x < 10), "each step's own work stays under 10 ms of CPU here (Cloudflare free plan: 10 ms per run)", cpu.map((x) => x.toFixed(1)).join(", "));
  const alert = (await callsSoFar()).find((c) => c.ntfy);
  check(alert && /1\. Automatic 'tech is on the way' texts/.test(alert.body), "with phone alerts on, a notification with the top ideas is sent when the report is ready");
  const ideas1 = await kv.get("ideas:2026-11", "json"), leads1 = await kv.get("leads:2026-11", "json");
  check(ideas1.length === 2 && leads1.length === 9 && ideas1[0].complaints[0].sources[0].url === "https://news.ycombinator.com/item?id=1001" && ideas1[0].buyer && ideas1[0].price === 49 && ideas1[0].complaints.length === 3, "ideas (with buyer, product, price and all their leads) and leads are saved for good with their proof");

  // ── Job ads: every one saved for good, before the night's storage is cleared ────────────────────────
  const EXPECTED_JOBS = { "https://remotive.com/remote-jobs/finance/accounts-receivable-clerk-1": ["Gulf Coast Food Distributors", "Accounts Receivable Clerk", true],
    "https://remoteok.com/remote-jobs/7000-customer-service-scheduler-lone-star-hvac": ["Lone Star HVAC Services", "Customer Service Scheduler", true],
    "https://himalayas.app/companies/fresh-fields/jobs/accounts-payable-clerk": ["Fresh Fields Grocers", "Accounts Payable Clerk", true],
    "https://weworkremotely.com/remote-jobs/acme-logistics-order-entry-specialist": ["Acme Logistics", "Order Entry Specialist", true],
    "https://weworkremotely.com/remote-jobs/bright-dental-front-desk-receptionist": ["Bright Dental", "Front Desk Receptionist", false],
    "https://remoteok.com/remote-jobs/7001-billing-specialist-medbill": ["MedBill Co", "Billing Specialist", false],
    "https://www.workingnomads.com/jobs/dispatcher-metro-freight": ["Metro Freight", "Dispatcher", false] };
  const NJ = Object.keys(EXPECTED_JOBS).length;
  const allJobs = () => JOBS.store.list({ limit: 500 }).rows;
  const matchesExpected = (rows, date) => rows.length === NJ && rows.every((x) => EXPECTED_JOBS[x.url] && EXPECTED_JOBS[x.url][0] === x.company && EXPECTED_JOBS[x.url][1] === x.role && EXPECTED_JOBS[x.url][2] === x.qualified && x.firstFound === date);
  const saved1 = allJobs(), state1 = await kv.get("night:2026-11-20", "json");
  check(matchesExpected(saved1, "2026-11-20"), "every job ad found is saved in the database with company, role, link and date found (7 of 7 from 5 job boards, none missing)", saved1.map((x) => `${x.company}/${x.firstFound}`).join(", "));
  check(Object.keys(state1.docs).length === 0 && (state1.jobsPending || []).length === 0 && saved1.length === NJ, "the night's working storage was cleared, and every job ad was already in the database");
  check(saved1.filter((x) => x.qualified).length === 4 && saved1.find((x) => x.company === "Bright Dental")?.qualified === false && saved1.filter((x) => x.qualified).every((x) => x.quote && r.complaints.some((c) => c.quote === x.quote)), "ads kept as proof are marked qualified (with their quote); an ad that didn't qualify is still saved, marked not qualified");
  check(r.allJobAds?.length === NJ && r.allJobAds.filter((x) => x.qualified).length === 4 && r.jobAdsTotals?.total === NJ, "the morning report lists every job ad the night found, qualified or not", `${r.allJobAds?.length} ads`);

  // Email and build prompt
  const E = await import("../src/email.js"), PR = await import("../src/prompt.js"), REP = await import("../src/report.js");
  const mail = E.buildEmail(r, r.id, null, "https://night-agent.example");
  check(/^Night Agent: 2 ideas for Friday, November 20, 2026$/.test(mail.subject) && /OVERNIGHT\n16 public texts read \(Hacker News, job boards\) · 9 pieces of evidence with proof \(4 job ads\) · 2 new ideas · 3 Gemini calls/.test(mail.text), "the email says what the agent did overnight", mail.text.split("\n")[3]);
  check(/1\. Automatic 'tech is on the way' texts for HVAC customers — 7\.5\/10/.test(mail.text) && mail.text.includes("https://news.ycombinator.com/item?id=1001") && /Build it: https:\/\/night-agent\.example\/idea\/2026-11-20-p1/.test(mail.text) && /LEADS \(9, public posts and job ads — not contacted\)/.test(mail.text) && /Reddit's site rules/.test(mail.text) && /Reddit&#39;s site rules/.test(mail.html), "…the top 3 ideas with proof links, the leads, and why Reddit was skipped");
  check(/   Buyer: Owners of HVAC companies with 1–10 technicians\n   Build: A web app that texts each customer[^\n]*\n   Suggested price: \$49\/month \(suggested, not a quote: One owner already pays \$300 a month for ServiceTitan and still lacks this\.\)\n   Leads \(3\):\n   - "I wish there was[^\n]*— Hacker News user threetruckhvac \(https:\/\/news\.ycombinator\.com\/item\?id=1001\)/.test(mail.text) && /<b>Buyer:<\/b> Owners of HVAC companies/.test(mail.html) && /Leads \(3\):/.test(mail.html), "the email gives each idea's buyer, product, suggested price and its leads with proof links");
  check(/Left out 4 ideas that weren't good enough: Rugged handheld scanner for HVAC techs \(hardware\); Admin work is tedious \(too broad\)/.test(mail.text), "the email says which ideas were left out and why");
  check(/JOB ADS FOUND \(7, 4 qualified · 7 saved in all, 4 qualified\)/.test(mail.text) && (mail.text.match(/\[QUALIFIED\]/g) || []).length === 4 && /\[not qualified\] Bright Dental — Front Desk Receptionist · https:\/\/weworkremotely\.com\/remote-jobs\/bright-dental-front-desk-receptionist · found 2026-11-20/.test(mail.text) && (mail.html.match(/✓ Qualified/g) || []).length === 4 && /Not qualified<\/span> · <b>Bright Dental/.test(mail.html), "the morning email lists every job ad (company, role, link, date found) and marks which qualified");
  const prompt = PR.buildPrompt(ideas1[0]);
  const money = [...prompt.matchAll(/\$\d[\d,.]*(?:\/\w+)?/g)].map((m) => m[0]);
  check(prompt.includes(ideas1[0].complaints[0].quote) && prompt.includes("https://news.ycombinator.com/item?id=1001") && /Jobber: \$69\/month \(source: https:\/\/news\.ycombinator\.com\/item\?id=2001\)/.test(prompt) && /Who would buy it: Owners of HVAC companies/.test(prompt) && /Suggested price: \$49\/month \(a suggestion, not market data/.test(prompt) && money.every((m) => JSON.stringify(ideas1[0]).includes(m) || m === `$${ideas1[0].price}/month`), "'Yes, build this' prompt: real quotes, links, scores and competitors; no numbers of its own");

  // ── A2. The next night: the same texts aren't read again, nothing repeated ──────────────────────
  await ctl({ reset: true });
  n = await night("2026-11-21");
  check(n.report.texts === 0 && (await callsSoFar()).filter((c) => c.model).length === 0 && n.report.problems.length === 0, "the next night, texts already read aren't read again (no Gemini calls wasted) and nothing is repeated");
  const saved2 = allJobs();
  check(matchesExpected(saved2, "2026-11-20") && saved2.every((x) => x.timesSeen === 2 && x.lastSeen === "2026-11-21"), "between runs nothing is lost or doubled: the same 7 ads, first-found date kept, seen again on night 2, still qualified", saved2.map((x) => `${x.timesSeen}×/${x.lastSeen}`).join(", "));
  check(n.report.allJobAds?.length === NJ && n.report.allJobAds.every((x) => x.firstFound === "2026-11-20" && x.firstRun === "2026-11-20"), "night 2's report still lists the 7 ads it found (already read, so not analysed again), with their first-found date");

  // ── A3. Limits and models ──────────────────────────────────────────────────────────────────────────
  const fresh = () => { kv = memoryKV(); return { ...env, SCOUT: kv, JOBS: newDb() }; };
  await ctl({ reset: true, limitAfter: 1 });
  n = await night("2026-11-22", { e: fresh() });
  check(n.report.status === "stopped" && /free daily limit was reached/.test(n.report.stopped.message) && (await callsSoFar()).filter((c) => c.model).length === 2 && n.report.complaints.length === 9 && !n.report.grouped, "at Gemini's limit (429) the night stops (no more calls) and the report keeps what was found, marked not grouped");
  await ctl({ reset: true, limitAfter: null, retired: ["gemini-flash-lite-latest"] });
  n = await night("2026-11-23", { e: fresh() });
  check(n.report.status === "done" && n.report.model === "gemini-flash-latest", "a model Google retired for new users is skipped; the next one is used", n.report.model);
  await ctl({ reset: true, retired: [], zeroQuota: ["gemini-flash-lite-latest", "gemini-flash-latest", "gemini-2.5-flash-lite", "gemini-2.5-flash"] });
  n = await night("2026-11-24", { e: fresh() });
  check(n.report.status === "stopped" && n.report.stopped.kind === "no-free-quota" && /no free quota/.test(n.report.stopped.message), "if every model refuses the very first request, the night stops and says there seems to be no free quota");
  await ctl({ reset: true, zeroQuota: [] });
  n = await night("2026-11-25", { e: { ...fresh(), GEMINI_API_KEY: "" } });
  check(n.report.status === "stopped" && /no working Gemini API key/.test(n.report.stopped.message), "with no Gemini key, the night stops and says to add GEMINI_API_KEY");
  // The database unreachable for a whole run: the ads are kept (KV "jobs-retry") and saved on the next run.
  const J2 = newDb(); J2.failing(true); kv = memoryKV();
  n = await night("2026-11-27", { e: { ...env, SCOUT: kv, JOBS: J2 } });
  const retry = await kv.get("jobs-retry", "json");
  check(J2.store.stats().total === 0 && retry?.jobs?.length === NJ && retry.quals.length === 4 && /couldn't be read/.test(n.report.allJobAdsError || "") && n.report.log.some((l) => /couldn't be saved to the database yet/.test(l.msg)), "if the database can't be reached, no job ad is dropped: all 7 are kept for the next run, and the report says so", `${retry?.jobs?.length} kept`);
  check(n.report.problems.length === 0 && !n.report.grouped && n.report.complaints.length === 9 && n.report.log.some((l) => /memory of past ideas couldn't be read/.test(l.msg)), "if the memory of past ideas can't be read, no ideas are sent that night (so nothing old is sent as new), and the evidence is still in the report");
  J2.failing(false);
  n = await night("2026-11-28", { e: { ...env, SCOUT: kv, JOBS: J2 } });
  const saved3 = J2.store.list({ limit: 500 }).rows;
  check(matchesExpected(saved3, "2026-11-27") && (await kv.get("jobs-retry", "json")).jobs.length === 0, "…and the next run saves them all, with the date they were really found and their qualified marks", saved3.map((x) => x.firstFound).join(", "));
  // Unreachable for part of a night only: saved in a later step of the same night.
  const J3 = newDb(); J3.failing(true); kv = memoryKV();
  const e3 = { ...env, SCOUT: kv, JOBS: J3 }; let st3;
  for (let k = 0; k < 14; k++) st3 = await P.runStep(e3, { now: Date.parse("2026-11-29T06:00:00Z") + k * 300000 });
  const pendingMid = (await kv.get("night:2026-11-29", "json")).jobsPending.length;
  J3.failing(false); n = await night("2026-11-29", { from: 14, e: e3 });
  check(pendingMid === NJ && matchesExpected(J3.store.list({ limit: 500 }).rows, "2026-11-29"), "if the database is down for a few steps, the ads wait in the night's state and are saved when it's back", `${pendingMid} waiting, then ${J3.store.stats().total} saved`);
  const srcText = fs.readdirSync(path.join(ROOT, "src")).map((f) => fs.readFileSync(path.join(ROOT, "src", f), "utf8")).join("\n");
  check(!/DELETE\s+FROM|DROP\s+TABLE|TRUNCATE|storage\.delete|deleteAll/i.test(srcText), "there is no code that deletes job ads (no DELETE, DROP or storage delete anywhere)");
  // ── A5. Never repeat an idea that was already sent ─────────────────────────────────────────────────
  const D = newDb(); kv = memoryKV();
  let t; for (let k = 0; k < 48; k++) { t = await P.runStep({ ...env, SCOUT: kv, JOBS: D }, { now: Date.parse("2026-12-03T15:00:00Z") + k * 1000, manual: true }); if (t.status !== "running") break; }
  const testRep = await kv.get("report:2026-12-03-test", "json");
  check(testRep.problems.length === 2 && D.ideas.count() === 2, "a test run's ideas are remembered as sent, like a real night's", `${D.ideas.count()} remembered`);
  kv = memoryKV(); n = await night("2026-12-04", { e: { ...env, SCOUT: kv, JOBS: D } });
  check(n.report.problems.length === 0 && n.report.updates.length === 0 && D.ideas.count() === 2, "the next night, the same ideas are not sent again (not as new ideas, and no 'update' without new proof)", n.report.problems.map((p) => p.title).join(" | "));
  await ctl({ reset: true, extra: true });
  kv = memoryKV(); n = await night("2026-12-05", { e: { ...env, SCOUT: kv, JOBS: D } });
  const up = n.report.updates || [];
  check(n.report.problems.length === 1 && n.report.problems[0].title === "Propane refill tracking for food trucks", "top ideas are brand new: only the never-sent idea is a new idea", n.report.problems.map((p) => p.title).join(" | "));
  check(up.length === 1 && up[0].title === "Automatic 'tech is on the way' texts for HVAC customers" && up[0].firstDate === "2026-12-03" && up[0].complaints.length === 1 && up[0].complaints[0].sources[0].url === "https://news.ycombinator.com/item?id=1005", "an old idea with new proof (even reworded as 'Text customers automatically when the HVAC tech is close') becomes an 'update on a past idea', with only the new proof", JSON.stringify(up.map((u) => [u.title, u.firstDate, u.complaints.length])));
  check(D.ideas.count() === 3 && D.ideas.list().find((i) => i.title.startsWith("Automatic 'tech")).updates === 1, "the memory now has 3 ideas, and the old one is marked as updated");
  const m5 = E.buildEmail(n.report, n.report.id, null, "https://night-agent.example");
  const iTop = m5.text.indexOf("TOP IDEAS"), iUpd = m5.text.indexOf("UPDATE ON PAST IDEAS"), iLeads = m5.text.indexOf("LEADS"), iJobs = m5.text.indexOf("JOB ADS FOUND");
  check(iUpd > iLeads && iUpd > iJobs && iUpd > iTop && !m5.text.slice(iTop, iLeads).includes("tech is on the way") && /- Automatic 'tech is on the way' texts for HVAC customers \(first sent 2026-12-03\): 1 new proof/.test(m5.text) && /Update on past ideas<\/h3>/.test(m5.html), "the email keeps the old idea out of the top ideas and puts it in a short 'Update on past ideas' section at the bottom");
  check(/Update on past ideas<\/h2>[\s\S]*first sent 2026-12-03/.test(REP.reportPage(n.report)), "the report page has the same 'Update on past ideas' section");
  kv = memoryKV(); n = await night("2026-12-06", { e: { ...env, SCOUT: kv, JOBS: D } });
  check(n.report.problems.length === 0 && n.report.updates.length === 0, "a night later, neither the new idea nor the update is sent again");
  await ctl({ reset: true, extra: false });
  // Reports sent before this memory existed are loaded into it first (here: the idea that kept repeating).
  const D2 = newDb(); kv = memoryKV();
  await kv.put("seen", JSON.stringify({ nights: 1, problems: [{ title: "Manual Administrative and Data Entry Outsourcing", night: "2026-11-19" }], queries: [], docs: [] }));
  await kv.put("index", JSON.stringify([{ id: "2026-11-18-test" }]));
  await kv.put("report:2026-11-18-test", JSON.stringify({ id: "2026-11-18-test", problems: [{ title: "Automatic 'tech is on the way' texts for HVAC customers", complaints: [{ sources: [{ url: "https://news.ycombinator.com/item?id=1001" }] }] }] }));
  n = await night("2026-12-07", { e: { ...env, SCOUT: kv, JOBS: D2 } });
  check(!n.report.problems.some((p) => /tech is on the way/.test(p.title)) && n.report.problems.length === 1 && D2.ideas.list().some((i) => i.title === "Manual Administrative and Data Entry Outsourcing" && i.firstDate === "2026-11-19"), "ideas from reports sent before (including test runs) are loaded into the memory, so they're never sent again", n.report.problems.map((p) => p.title).join(" | "));

  // A site's rules say no → it's skipped and the night log says why.
  await ctl({ reset: true, gatedRobots: "User-agent: *\nDisallow: /api\n" });
  n = await night("2026-11-30", { e: fresh() });
  check(!(await callsSoFar()).some((c) => c.path === "/api" || c.path === "/api/exposed_jobs/") && (await callsSoFar()).some((c) => c.path === "/2.3/questions") && n.report.log.some((l) => /Remote OK jobs .* skipped: its site rules/.test(l.msg)) && n.report.log.some((l) => /Working Nomads jobs .* skipped: its site rules/.test(l.msg)), "if a site's rules (robots.txt) disallow it, it isn't asked, and the log says so");
  await ctl({ gatedRobots: "User-agent: *\nAllow: /\n" });
  // ── A big night: hundreds of new posts of real size ─────────────────────────────────────────────────
  await ctl({ reset: true, big: true });
  n = await night("2026-12-08", { e: fresh() });
  const bigCpu = n.steps.map((x) => x.cpuMs).sort((a, b) => b - a);
  console.log(`      Big night: ${n.report.texts} texts read, ${n.steps.length} steps, CPU per step max ${bigCpu[0].toFixed(1)} ms; by step: ${n.steps.map((x) => x.cpuMs.toFixed(1)).join(" ")}`);
  check(n.report.texts >= 150 && !n.report.log.some((l) => /adding 8 more/.test(l.msg)) && !n.report.sourcesNote.some((x) => /Only \d+ new public texts/.test(x)), "with plenty of new posts, a night reads at least 150 texts (no extra searches needed)", `${n.report.texts} texts`);
  check(bigCpu.every((x) => x < 10), "even on a big night, every step's own work stays under 10 ms of CPU (free plan limit)", bigCpu.slice(0, 5).map((x) => x.toFixed(1)).join(", "));
  check(n.steps.every((x) => x.gemini <= 1) && (await callsSoFar()).filter((c) => c.model).length <= 12 && n.report.status === "done", "…and stays within Gemini's free limits: at most 1 call a step, at most 12 a night", `${(await callsSoFar()).filter((c) => c.model).length} calls`);
  check((await kv.get("seen", "json")).docs.every((k) => /^h:\d+$|^[0-9a-f]{8}$/.test(k)), "texts already read are remembered with short keys (room for the last 12,000)");
  await ctl({ reset: true, big: false });
  kv = memoryKV(); await kv.put("seen", JSON.stringify({ nights: 3, problems: [], queries: [], docs: ["news.ycombinator.com/item?id=1001", "remotive.com/remote-jobs/finance/accounts-receivable-clerk-1"] }));
  n = await night("2026-12-09", { e: { ...env, SCOUT: kv, JOBS: newDb() } });
  check(!JSON.stringify(n.report.complaints).includes("item?id=1001") && !JSON.stringify(n.report.complaints).includes("accounts-receivable-clerk-1") && n.report.complaints.length === 7, "texts remembered in the older format are still recognised as read (not read again)");
  n = await night("2026-11-26", { from: 47, e: fresh() });
  if (!(n.report.cutShort === true && n.steps.length === 1)) console.log("DEBUG cut", n.steps.length, n.report.cutShort, n.report.status, n.st.log.map((l) => l.msg).slice(-3).join(" / "));
  check(n.report.cutShort === true && n.steps.length === 1, "at 4:55 a.m. the report is finished with whatever was done (marked as cut short)");
  check(P.robotsRules("User-agent: *\nDisallow: /\n").length === 1 && P.robotsRules("User-agent: nightagentscout\nAllow: /\n\nUser-agent: *\nDisallow: /").every(([a]) => a), "site rules are read correctly (blocked for all bots; allowed when the site names this agent)");
  stub.kill();
  globalThis.fetch = realFetch;

  // ── B. The real Worker ───────────────────────────────────────────────────────────────────────────────
  const stub2 = spawn(process.execPath, [path.join(__dirname, "stub-gemini.cjs"), String(STUB)], { stdio: ["ignore", "pipe", "inherit"] });
  await new Promise((ok) => stub2.stdout.once("data", ok));
  const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), "night-agent-"));
  const log = [];
  const vars = { ALLOW_TEST: "1", GEMINI_BASE: SB, GEMINI_API_KEY: "test-key", NTFY_BASE: `${SB}/ntfy`, RESEND_API_KEY: "re_test", RESEND_BASE: SB, ...SOURCE_VARS };
  const startWorker = () => spawn(WRANGLER, ["dev", "--port", String(PORT), "--persist-to", stateDir, "--test-scheduled", "--show-interactive-dev-session=false", "--log-level", "warn", ...Object.entries(vars).flatMap(([k, v]) => ["--var", `${k}:${v}`])],
    { cwd: ROOT, env: { ...process.env, WRANGLER_SEND_METRICS: "false", CLOUDFLARE_API_TOKEN: "placeholder-not-used-locally" }, stdio: ["ignore", "pipe", "pipe"] });
  const listen = (p) => { p.stdout.on("data", (d) => log.push(String(d))); p.stderr.on("data", (d) => log.push(String(d))); return p; };
  let w = listen(startWorker());
  const browser = await chromium.launch();
  try {
    for (let i = 0; i < 120; i++) { try { await fetch(BASE); break; } catch { await sleep(500); } }
    const ctx = await browser.newContext({ viewport: { width: 390, height: 844 }, deviceScaleFactor: 2, isMobile: true, hasTouch: true });
    const pg = await ctx.newPage(); const errs = []; pg.on("pageerror", (e) => errs.push(e.message));
    const res = await pg.goto(BASE);
    check(/Choose a passcode/.test(await pg.textContent("main")) && res.headers()["content-security-policy"]?.includes("default-src 'none'"), "first visit asks for a passcode; pages are locked down");
    await pg.fill("input[name=passcode]", "night-pass-123"); await pg.click("button");
    await pg.waitForSelector("text=No report yet");
    await pg.goto(`${BASE}/settings`); await pg.click("form[action='/alerts'] button");
    const day = await fetch(`${BASE}/__test/tick?time=${Date.parse("2026-11-30T15:00:00Z")}`);
    check((await day.json()).status === "skipped", "a cron run outside 1–5 a.m. Jamaica time does nothing");
    check((await fetch(`${BASE}/__scheduled?cron=*/5+6-9+*+*+*`)).status === 200, "the real Cron Trigger entry point runs without errors");
    const idle = async () => { let last = -1; for (let i = 0; i < 60; i++) { const k = (await callsSoFar()).length; if (k === last) return; last = k; await sleep(700); } };
    for (let k = 0; k < 48 && !(await callsSoFar()).some((c) => c.ntfy); k++) { await fetch(`${BASE}/__test/tick?time=${Date.parse("2026-12-01T06:00:00Z") + k * 300000}`); await idle(); }
    check((await callsSoFar()).some((c) => c.ntfy), "the Cron Trigger runs drive the whole night on the real Worker, ending with the phone alert");
    await pg.goto(`${BASE}/night/2026-12-01`);
    const text = (await pg.innerText("main")).replace(/\s+/g, " ");
    check(/Automatic 'tech is on the way' texts for HVAC customers 7\.5\/10/.test(text) && /Hacker News/.test(text) && /Jobber — \$69\/month/.test(text) && /Reddit's site rules/.test(text) && /Job ad/.test(text), "the report shows ranked problems, quotes with their source, job ads, competitors, and why Reddit was skipped", text.slice(0, 140));
    check(await pg.locator("main a[href^='https://news.ycombinator.com/item?id=']").count() >= 3, "every proof is a real link to the public page");
    await pg.screenshot({ path: path.join(OUT, "report-phone.png"), fullPage: true });
    const before = (await callsSoFar()).filter((c) => c.email).length;
    const e1 = await (await fetch(`${BASE}/__test/tick?kind=email&time=${Date.parse("2026-12-01T11:00:00Z")}`)).json();
    await fetch(`${BASE}/__test/tick?kind=email&time=${Date.parse("2026-12-01T11:00:00Z")}`);
    const sent = (await callsSoFar()).filter((c) => c.email).slice(before);
    check(e1.ok && sent.length === 1 && sent[0].email.to.join() === "marlonapp.sales@gmail.com" && sent[0].email.from === "Night Agent <onboarding@resend.dev>" && /^Night Agent: 2 ideas for Tuesday, December 1, 2026$/.test(sent[0].email.subject), "at 6:00 a.m. the report is emailed from onboarding@resend.dev to marlonapp.sales@gmail.com, once", sent[0]?.email.subject);
    await pg.goto(BASE);
    const dash = (await pg.innerText("main")).replace(/\s+/g, " ");
    check(/1 night · 2 ideas saved · 9 leads saved/.test(dash) && /Email: Sent/.test(dash) && /Buyer: Owners of HVAC companies/.test(dash) && /Suggested price: \$49\/month/.test(dash) && await pg.locator("main form[action$='/build'] button").count() === 2, "the dashboard shows last night, totals, the email, and the top 3 with 'Yes, build this'", dash.slice(0, 160));
    await pg.locator("main form[action$='/build'] button").first().click();
    await pg.waitForSelector("#prompt");
    check(/^Build a new app for this problem/.test(await pg.inputValue("#prompt")) && (await pg.inputValue("#prompt")).includes("https://news.ycombinator.com/item?id=1001"), "'Yes, build this' opens the ready-to-paste Claude Code prompt");
    await pg.goto(`${BASE}/ideas`);
    check(await pg.locator("main section.card").count() === 2 && /chosen to build/.test(await pg.innerText("main")), "the Ideas page lists every saved idea");
    await pg.goto(`${BASE}/leads`);
    check(await pg.locator("main blockquote").count() === 9 && await pg.locator("main .tag.warn", { hasText: "Job ad" }).count() === 4, "the Leads page lists every lead, job ads labeled");
    // Job ads on the real Worker (a real SQLite Durable Object).
    check(/7 job ads saved · 4 qualified/.test(dash), "the dashboard shows how many job ads are saved and how many qualified");
    check(/Buyer: Owners of HVAC companies with 1–10 technicians/.test(text) && /Suggested price: \$49\/month/.test(text) && /Leads \(3\): people and companies with this exact problem/.test(text) && /Left out tonight \(4\)/.test(text), "the report shows each idea's buyer, product, suggested price and leads, and what was left out");
    check(/All job ads found \(7, 4 qualified\)/.test(text) && /Bright Dental — Front Desk Receptionist/.test(text), "the night's report lists every job ad it found, qualified or not");
    check(/JOB ADS FOUND \(7, 4 qualified/.test(sent[0].email.text) && /\[not qualified\] Bright Dental/.test(sent[0].email.text), "the 6 a.m. email lists every job ad with its qualified mark");
    const jobsView = async () => { await pg.goto(`${BASE}/jobs`); return { text: (await pg.innerText("main")).replace(/\s+/g, " "), q: await pg.locator("main .tag.ok", { hasText: "Qualified" }).count(), nq: await pg.locator("main .tag", { hasText: "Not qualified" }).count(),
      links: await pg.locator("main li a[href^='https://']").evaluateAll((as) => as.map((a) => a.href).sort()) }; };
    const j1 = await jobsView();
    check(/7 job ads saved · 4 qualified · 3 not qualified/.test(j1.text) && j1.q === 4 && j1.nq === 3 && j1.links.length === 7 && /Gulf Coast Food Distributors — Accounts Receivable Clerk/.test(j1.text) && /found 2026-12-01/.test(j1.text), "the Job ads page lists every saved ad: company, role, link, date found, qualified or not", j1.text.slice(0, 120));
    await pg.screenshot({ path: path.join(OUT, "job-ads-phone.png"), fullPage: true });
    await pg.goto(`${BASE}/jobs?qualified=1`);
    check(await pg.locator("main li").count() === 4, "…and can show only the qualified ones");
    // A second night: the same ads again → still 5, nothing doubled.
    for (let k = 0; k < 48; k++) { const st = await (await fetch(`${BASE}/__test/tick?time=${Date.parse("2026-12-02T06:00:00Z") + k * 300000}`)).json(); await idle(); if (st.status && st.status !== "running") break; }
    const j2 = await jobsView();
    check(/7 job ads saved · 4 qualified/.test(j2.text) && JSON.stringify(j2.links) === JSON.stringify(j1.links) && /seen on 2 runs/.test(j2.text), "after a second night on the real Worker: the same 7 ads, none lost or doubled", j2.text.slice(0, 80));
    // Restart the Worker (same saved data): nothing is lost.
    w.kill("SIGTERM"); await new Promise((ok) => w.once("exit", ok)); await sleep(500);
    w = listen(startWorker());
    for (let i = 0; i < 120; i++) { try { await fetch(BASE); break; } catch { await sleep(500); } }
    const j3 = await jobsView();
    check(/7 job ads saved · 4 qualified/.test(j3.text) && JSON.stringify(j3.links) === JSON.stringify(j1.links), "after restarting the Worker, every job ad is still there", j3.text.slice(0, 80));
    const json401 = await fetch(`${BASE}/report/2026-12-01.json`);
    check(json401.status === 401, "without signing in, nothing can be read");
    check(errs.length === 0 && !log.join("").match(/night step failed|live test failed|Uncaught/), "no page or Worker errors", errs.join(" | ").slice(0, 200));
  } finally {
    await browser.close(); w.kill("SIGTERM"); stub2.kill(); await sleep(1000); fs.rmSync(stateDir, { recursive: true, force: true });
  }
  if (failures) { console.log(`\n${failures} check(s) failed`); process.exit(1); }
  console.log("\nAll Night Agent checks passed");
})().catch((e) => { console.error(e); process.exit(1); });
