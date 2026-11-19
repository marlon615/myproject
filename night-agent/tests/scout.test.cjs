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
const SOURCE_VARS = { HN_BASE: SB, REMOTIVE_BASE: SB, WWR_BASE: SB, REDDIT_BASE: SB, JOBICY_BASE: SB, HIMALAYAS_BASE: SB };

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
  const P = await import("../src/pipeline.js");
  // Every address the agent asks for, and the CPU spent inside fetch (Cloudflare does that natively; it doesn't count).
  const fetched = []; const realFetch = globalThis.fetch; let inFetch = 0;
  globalThis.fetch = async (u, o) => { fetched.push(String(u?.url || u)); const c0 = process.cpuUsage(); const res = await realFetch(u, o); const buf = await res.arrayBuffer(); const c = process.cpuUsage(c0); inFetch += (c.user + c.system) / 1000; return new Response(buf, { status: res.status, headers: res.headers }); };
  let kv = memoryKV();
  const env = { SCOUT: kv, GEMINI_API_KEY: "test-key", ALLOW_TEST: "1", GEMINI_BASE: SB, NTFY_BASE: `${SB}/ntfy`, ...SOURCE_VARS };
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

  await night("2026-11-10", { e: { ...env, SCOUT: memoryKV() } }); // warm-up night (first run compiles the code), not checked
  await ctl({ reset: true }); fetched.length = 0;
  // ── A1. A normal night ──────────────────────────────────────────────────────────────────────────────
  let n = await night("2026-11-20");
  const r = n.report, calls1 = await callsSoFar();
  check(r && r.status === "done" && n.steps.length <= 10, "a night runs in small steps and leaves a finished morning report", `${n.steps.length} steps`);
  check(n.steps.every((s) => s.gemini <= 1) && calls1.filter((c) => c.model).length === 3, "at most 1 Gemini call per step, 3 in the whole night (read, group, competitors)", calls1.filter((c) => c.model).map((c) => c.kind).join(", "));
  check(calls1.filter((c) => c.model).every((c) => !c.search), "Gemini is never asked to search (no grounding): it only reads the fetched text");
  check(calls1.some((c) => c.path === "/api/v1/search_by_date") && calls1.some((c) => c.path === "/api/remote-jobs") && calls1.some((c) => /\.rss$/.test(c.path || "")), "public sources are fetched directly: Hacker News API, Remotive jobs API, We Work Remotely RSS");
  check(calls1.filter((c) => c.path === "/api/remote-jobs").length === 2, "Remotive is asked only twice a night (they ask for at most ~4 a day)");
  const hnCalls = calls1.filter((c) => c.path === "/api/v1/search_by_date" && (new URLSearchParams(c.query).get("query") || "").includes('"'));
  check(hnCalls.length === 10 && hnCalls.every((c) => new URLSearchParams(c.query).get("hitsPerPage") === "30" && /created_at_i>\d+/.test(new URLSearchParams(c.query).get("numericFilters"))), "Hacker News: 10 searches a night, 30 results each, from the last 90 days", `${hnCalls.length} searches`);
  const jc = calls1.filter((c) => c.path === "/api/v2/remote-jobs"), hc = calls1.filter((c) => /^\/jobs\/api/.test(c.path || "")), wc = calls1.filter((c) => /\.rss$/.test(c.path || ""));
  check(jc.length === 1 && jc.every((c) => new URLSearchParams(c.query).get("geo") === "usa") && hc.length === 2 && wc.length === 4, "more job feeds: Jobicy (1 US search a night; they ask for ≤1 an hour), Himalayas (2 searches) and 4 We Work Remotely feeds", `${jc.length}/${hc.length}/${wc.length}`);
  check(calls1.some((c) => c.path === "/robots.txt") && !calls1.some((c) => c.path === "/search.json") && r.sourcesNote.some((s) => /Reddit's site rules/.test(s)), "Reddit: its rules (robots.txt) are checked first; they don't allow it, so Reddit isn't fetched and the report says so", r.sourcesNote[0]);
  check(fetched.every((u) => new URL(u).hostname === "localhost"), "every request went to the stand-ins only (nothing else was contacted)", `${fetched.length} requests`);
  check(r.texts === 10, "it read 10 public texts: 8 posts and job ads, plus 2 posts about tools (non-US and non-repetitive job ads left out)", String(r.texts));
  check(!JSON.stringify(r).includes("Machine Learning") && !JSON.stringify(r).includes("Berlin"), "job ads that aren't repetitive work, or aren't open to the US, are left out");
  check(!JSON.stringify(r).includes("AI receptionist") && !JSON.stringify(r).includes("$999"), "a quote or a price that isn't word for word in the fetched text is left out (nothing made up)");
  const cs = Object.fromEntries(r.complaints.map((c) => [c.id, c]));
  check(r.complaints.length === 7 && r.complaints.every((c) => c.sources.length === 1 && /^https:\/\/(news\.ycombinator\.com\/item\?id=\d+|remotive\.com\/|weworkremotely\.com\/|jobicy\.com\/|himalayas\.app\/)/.test(c.sources[0].url)), "every piece of evidence links to its public page (Hacker News item, job ad)", r.complaints.map((c) => c.sources[0].url.slice(0, 45)).join(" | "));
  check(cs.c1.who === "Hacker News comment" && cs.c1.pays === "“We pay $300 a month for ServiceTitan”" && cs.c3.pays === "unknown", "'who' is what the source says it is; 'pays' only when those words are in the text");
  const byWho = (re) => r.complaints.find((c) => re.test(c.who)) || {};
  check(byWho(/Gulf Coast/).kind === "job" && byWho(/Gulf Coast/).who === "Gulf Coast Food Distributors is hiring an Accounts Receivable Clerk" && byWho(/Gulf Coast/).pays === "$18-$21/hour (job ad)" && byWho(/Acme/).who === "Acme Logistics is hiring an Order Entry Specialist" && byWho(/Acme/).pays === "pays a salary for this work (job ad)", "job ads: company, role and pay from the job board itself; the ad is the proof");
  const jj = r.complaints.find((c) => /Lone Star/.test(c.who)), hj = r.complaints.find((c) => /Fresh Fields/.test(c.who));
  check(jj && jj.who === "Lone Star HVAC Services is hiring a Customer Service Scheduler" && jj.pays === "$38,000-44,000 a year (job ad)" && jj.sources[0].url.startsWith("https://jobicy.com/") && hj && hj.pays === "$40,000-46,000 a year (job ad)" && hj.sources[0].url.startsWith("https://himalayas.app/"), "Jobicy and Himalayas job ads come in with company, role, listed pay and the ad's link", jj?.pays);
  check(r.problems.length === 4 && !JSON.stringify(r.problems).includes("made-up") && r.problems.map((p) => p.total).join() === "7.5,7.1,6.9,5.9", "grouped into problems, scored and ranked; a 'problem' with no real complaints is dropped", r.problems.map((p) => p.total).join(", "));
  check(/invoice follow-up/.test(r.problems[1].title) && r.problems[1].complaints.every((c) => c.kind === "job"), "a job-ad idea makes the top 3 when it ranks");
  const comp = r.problems[0].competitors;
  check(comp.length === 1 && comp[0].name === "Jobber" && comp[0].price === "$69/month" && comp[0].sources[0].url === "https://news.ycombinator.com/item?id=2001" && /can't be timed/.test(comp[0].dislikes), "competitors come from posts that mention them, with the quote and link; a price only when it's written there; an invented tool is dropped", JSON.stringify(comp.map((c) => [c.name, c.price])));
  check(r.leads.length === 7 && r.leads.every((l) => l.sources[0].url.startsWith("https://")) && r.leads.filter((l) => l.kind === "job").length === 4, "leads: up to 10 public posts and job ads with links (here 7 — never padded)");
  check(kv.writes <= 40, "few KV writes a night (free plan: 1,000 a day)", `${kv.writes} writes`);
  const cpu = n.steps.map((s) => s.cpuMs).sort((a, b) => b - a);
  console.log(`      CPU per step, own work (Node, this machine): max ${cpu[0].toFixed(1)} ms, median ${cpu[Math.floor(cpu.length / 2)].toFixed(1)} ms`);
  check(cpu.every((x) => x < 10), "each step's own work stays under 10 ms of CPU here (Cloudflare free plan: 10 ms per run)", cpu.map((x) => x.toFixed(1)).join(", "));
  const alert = (await callsSoFar()).find((c) => c.ntfy);
  check(alert && /1\. Automatic 'tech is on the way' texts/.test(alert.body), "with phone alerts on, a notification with the top ideas is sent when the report is ready");
  const ideas1 = await kv.get("ideas:2026-11", "json"), leads1 = await kv.get("leads:2026-11", "json");
  check(ideas1.length === 4 && leads1.length === 7 && ideas1[0].complaints[0].sources[0].url === "https://news.ycombinator.com/item?id=1001", "ideas and leads are saved for good with their proof");

  // Email and build prompt
  const E = await import("../src/email.js"), PR = await import("../src/prompt.js");
  const mail = E.buildEmail(r, r.id, null, "https://night-agent.example");
  check(/^Night Agent: 3 ideas for Friday, November 20, 2026$/.test(mail.subject) && /OVERNIGHT\n10 public texts read \(Hacker News, job boards\) · 7 pieces of evidence with proof \(4 job ads\) · 4 new ideas · 3 Gemini calls/.test(mail.text), "the email says what the agent did overnight", mail.text.split("\n")[3]);
  check(/1\. Automatic 'tech is on the way' texts for HVAC customers — 7\.5\/10/.test(mail.text) && mail.text.includes("https://news.ycombinator.com/item?id=1001") && /Build it: https:\/\/night-agent\.example\/idea\/2026-11-20-p1/.test(mail.text) && /LEADS \(7, public posts and job ads — not contacted\)/.test(mail.text) && /Reddit's site rules/.test(mail.text) && /Reddit&#39;s site rules/.test(mail.html), "…the top 3 ideas with proof links, the leads, and why Reddit was skipped");
  const prompt = PR.buildPrompt(ideas1[0]);
  const money = [...prompt.matchAll(/\$\d[\d,.]*(?:\/\w+)?/g)].map((m) => m[0]);
  check(prompt.includes(ideas1[0].complaints[0].quote) && prompt.includes("https://news.ycombinator.com/item?id=1001") && /Jobber: \$69\/month \(source: https:\/\/news\.ycombinator\.com\/item\?id=2001\)/.test(prompt) && money.every((m) => JSON.stringify(ideas1[0]).includes(m)), "'Yes, build this' prompt: real quotes, links, scores and competitors; no numbers of its own");

  // ── A2. The next night: the same texts aren't read again, nothing repeated ──────────────────────
  await ctl({ reset: true });
  n = await night("2026-11-21");
  check(n.report.texts === 0 && (await callsSoFar()).filter((c) => c.model).length === 0 && n.report.problems.length === 0, "the next night, texts already read aren't read again (no Gemini calls wasted) and nothing is repeated");

  // ── A3. Limits and models ──────────────────────────────────────────────────────────────────────────
  const fresh = () => { kv = memoryKV(); return { ...env, SCOUT: kv }; };
  await ctl({ reset: true, limitAfter: 1 });
  n = await night("2026-11-22", { e: fresh() });
  check(n.report.status === "stopped" && /free daily limit was reached/.test(n.report.stopped.message) && (await callsSoFar()).filter((c) => c.model).length === 2 && n.report.complaints.length === 7 && !n.report.grouped, "at Gemini's limit (429) the night stops (no more calls) and the report keeps what was found, marked not grouped");
  await ctl({ reset: true, limitAfter: null, retired: ["gemini-flash-lite-latest"] });
  n = await night("2026-11-23", { e: fresh() });
  check(n.report.status === "done" && n.report.model === "gemini-flash-latest", "a model Google retired for new users is skipped; the next one is used", n.report.model);
  await ctl({ reset: true, retired: [], zeroQuota: ["gemini-flash-lite-latest", "gemini-flash-latest", "gemini-2.5-flash-lite", "gemini-2.5-flash"] });
  n = await night("2026-11-24", { e: fresh() });
  check(n.report.status === "stopped" && n.report.stopped.kind === "no-free-quota" && /no free quota/.test(n.report.stopped.message), "if every model refuses the very first request, the night stops and says there seems to be no free quota");
  await ctl({ reset: true, zeroQuota: [] });
  n = await night("2026-11-25", { e: { ...fresh(), GEMINI_API_KEY: "" } });
  check(n.report.status === "stopped" && /no working Gemini API key/.test(n.report.stopped.message), "with no Gemini key, the night stops and says to add GEMINI_API_KEY");
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
  const w = spawn(WRANGLER, ["dev", "--port", String(PORT), "--persist-to", stateDir, "--test-scheduled", "--show-interactive-dev-session=false", "--log-level", "warn", ...Object.entries(vars).flatMap(([k, v]) => ["--var", `${k}:${v}`])],
    { cwd: ROOT, env: { ...process.env, WRANGLER_SEND_METRICS: "false", CLOUDFLARE_API_TOKEN: "placeholder-not-used-locally" }, stdio: ["ignore", "pipe", "pipe"] });
  w.stdout.on("data", (d) => log.push(String(d))); w.stderr.on("data", (d) => log.push(String(d)));
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
    check(e1.ok && sent.length === 1 && sent[0].email.to.join() === "marlonapp.sales@gmail.com" && sent[0].email.from === "Night Agent <onboarding@resend.dev>" && /^Night Agent: 3 ideas for Tuesday, December 1, 2026$/.test(sent[0].email.subject), "at 6:00 a.m. the report is emailed from onboarding@resend.dev to marlonapp.sales@gmail.com, once", sent[0]?.email.subject);
    await pg.goto(BASE);
    const dash = (await pg.innerText("main")).replace(/\s+/g, " ");
    check(/1 night · 4 ideas saved · 7 leads saved/.test(dash) && /Email: Sent/.test(dash) && await pg.locator("main form[action$='/build'] button").count() === 3, "the dashboard shows last night, totals, the email, and the top 3 with 'Yes, build this'", dash.slice(0, 160));
    await pg.locator("main form[action$='/build'] button").first().click();
    await pg.waitForSelector("#prompt");
    check(/^Build a new app for this problem/.test(await pg.inputValue("#prompt")) && (await pg.inputValue("#prompt")).includes("https://news.ycombinator.com/item?id=1001"), "'Yes, build this' opens the ready-to-paste Claude Code prompt");
    await pg.goto(`${BASE}/ideas`);
    check(await pg.locator("main section.card").count() === 4 && /chosen to build/.test(await pg.innerText("main")), "the Ideas page lists every saved idea");
    await pg.goto(`${BASE}/leads`);
    check(await pg.locator("main blockquote").count() === 7 && await pg.locator("main .tag.warn", { hasText: "Job ad" }).count() === 4, "the Leads page lists every lead, job ads labeled");
    const json401 = await fetch(`${BASE}/report/2026-12-01.json`);
    check(json401.status === 401, "without signing in, nothing can be read");
    check(errs.length === 0 && !log.join("").match(/night step failed|live test failed|Uncaught/), "no page or Worker errors", errs.join(" | ").slice(0, 200));
  } finally {
    await browser.close(); w.kill("SIGTERM"); stub2.kill(); await sleep(1000); fs.rmSync(stateDir, { recursive: true, force: true });
  }
  if (failures) { console.log(`\n${failures} check(s) failed`); process.exit(1); }
  console.log("\nAll Night Agent checks passed");
})().catch((e) => { console.error(e); process.exit(1); });
