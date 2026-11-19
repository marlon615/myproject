/**
 * Night Agent (Scout) tests, against a stand-in Gemini (tests/stub-gemini.cjs):
 *   A. Whole nights through the real pipeline, step by step as the Cron Trigger would run them (every 10 minutes,
 *      1:00–4:50 a.m. Jamaica time): proof-only results, scoring, competitors, repeats left out, stopping at the free
 *      limit, falling back when a model has no free grounding, a missing key, a night cut short; KV writes, Gemini calls
 *      per step, and CPU per step.
 *   B. The real Worker (wrangler dev): cron runs, the passcode, the report pages, past nights, settings and alerts.
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
  const fetched = []; const realFetch = globalThis.fetch;
  globalThis.fetch = (u, o) => { fetched.push(String(u?.url || u)); return realFetch(u, o); }; // every address the agent asks for
  const kv = memoryKV();
  const env = { SCOUT: kv, GEMINI_API_KEY: "test-key", ALLOW_TEST: "1", GEMINI_BASE: SB, NTFY_BASE: `${SB}/ntfy` };
  await kv.put("settings", JSON.stringify({ ntfyTopic: "night-agent-test" })); kv.resetWrites();

  /** Runs one night like the Cron Trigger does: 06:00Z, 06:05Z … 09:55Z (1:00–4:55 a.m. Jamaica). */
  async function night(day, { from = 0 } = {}) {
    const steps = []; let st;
    for (let k = from; k < 48; k++) {
      const now = Date.parse(`${day}T06:00:00Z`) + k * 300000, before = (await callsSoFar()).filter((c) => c.model).length;
      const c0 = process.cpuUsage(); st = await P.runStep(env, { now }); const c = process.cpuUsage(c0);
      steps.push({ cpuMs: (c.user + c.system) / 1000, gemini: (await callsSoFar()).filter((x) => x.model).length - before });
      if (st.status !== "running") break;
    }
    return { st, steps, report: await kv.get(`report:${st.id}`, "json") };
  }

  // ── A1. A normal night ──────────────────────────────────────────────────────────────────────────────
  let n = await night("2026-11-20");
  const r = n.report;
  check(r && r.status === "done" && r.id === "2026-11-20", "a night runs in small steps from 1:00 a.m. Jamaica time and leaves a finished morning report", `${n.steps.length} steps`);
  check(n.steps.every((s) => s.gemini <= 1), "never more than 1 Gemini call per step (well inside the free tier's per-minute limit)", n.steps.map((s) => s.gemini).join(","));
  check(r.searches === 16 && r.searchesPlanned === 16 && n.st.queries.filter((q) => q.kind === "job").length === 4, "16 Google-grounded searches a night: 12 for complaints and wishes, 4 for public job ads");
  check(!JSON.stringify(r).includes("Honestly this whole industry"), "a quote Google's grounding didn't tie to a page is left out (no proof, no entry)");
  check(r.complaints.length === 5 && r.complaints.every((c) => c.sources.length && c.sources.every((s) => s.url.startsWith(`${SB}/page/`))), "every complaint keeps its proof: the real address of the page it came from (not the redirect)");
  const v = Object.fromEntries(r.complaints.map((c) => [c.id, c.sources[0].verified]));
  check(v.c1 === true && v.c2 === true && v.c3 === null, "quotes are checked on the page when the site allows it: found → marked 'quote found on page'", JSON.stringify(v));
  check(!(await callsSoFar()).some((c) => c.page === 3), "site rules are followed: a page the site's robots.txt disallows is never read (only linked)");
  const cs = Object.fromEntries(r.complaints.map((c) => [c.id, c]));
  check(cs.c1.who === "HVAC owner in Texas" && cs.c2.pays === "would pay $50/month" && cs.c3.who === "" && cs.c3.pays === "unknown", "who wrote it and what they pay are kept only when Google's grounding backs them; otherwise 'not confirmed'", JSON.stringify([cs.c3.who, cs.c3.pays]));
  check(r.leads.length === 5 && r.leads.length <= 10 && r.leads.every((l) => l.sources[0].url.startsWith(`${SB}/page/`)) && r.leads[0].idea === r.problems[0].title, "leads: up to 10 real public posts and job ads, each with its link and the idea it belongs to (here 5 — never padded)", r.leads.map((l) => l.id).join(","));
  check(r.problems.length === 4 && !JSON.stringify(r.problems).includes("made-up"), "complaints are grouped into problems; a 'problem' with no real complaints behind it is dropped", r.problems.map((p) => p.title).join(" | "));
  check(r.problems[0].total === 7.5 && r.problems[1].total === 7.1 && r.problems[2].total === 6.9 && r.problems[3].total === 5.9 && r.problems[0].scores.buildSpeed === 9, "each problem is scored 1–10 on people, paying, anger and build speed, and ranked", r.problems.map((p) => p.total).join(", "));
  const comp = r.problems[0].competitors;
  check(comp.length === 1 && comp[0].name === "Jobber" && comp[0].price === "$69/month" && comp[0].priceSources[0].url === `${SB}/page/4` && /can't be timed/.test(comp[0].dislikes), "top problems get competitors with prices and what users dislike, each with its source; a competitor with no proof is dropped", JSON.stringify(comp.map((c) => [c.name, c.price])));
  check(r.problems.slice(0, 5).every((p) => p.competitors !== undefined) && (await callsSoFar()).filter((c) => c.kind === "compete").length === 4, "competitors are checked for the top problems (here all 4)");
  const writesNight1 = kv.writes;
  check(writesNight1 <= 60, "about 50 KV writes a night or fewer (free plan: 1,000 a day)", `${writesNight1} writes`);
  const cpu = n.steps.map((s) => s.cpuMs).sort((a, b) => b - a);
  console.log(`      CPU per step (Node, this machine): max ${cpu[0].toFixed(1)} ms, median ${cpu[Math.floor(cpu.length / 2)].toFixed(1)} ms`);
  check(cpu.slice(1).every((x) => x < 10), "each step's own work stays under 10 ms of CPU here (Cloudflare free plan: 10 ms per run; the first step includes loading the code)", `${cpu.map((x) => x.toFixed(1)).join(", ")} ms`);
  const alert = (await callsSoFar()).find((c) => c.ntfy);
  check(alert && alert.ntfy === "/ntfy/night-agent-test" && /1\. Automatic 'tech is on the way' texts/.test(alert.body), "with phone alerts on, a notification with the top ideas is sent when the report is ready");

  // Job ads
  const jobs = r.complaints.filter((c) => c.kind === "job"), j1 = jobs.find((c) => /Gulf Coast/.test(c.who));
  check(jobs.length === 2 && j1 && j1.who === "Gulf Coast Food Distributors is hiring an Accounts Receivable Clerk" && j1.pays === "$18-$21 an hour (job ad)" && /follow up on unpaid invoices/.test(j1.quote) && j1.sources[0].url.startsWith(`${SB}/page/`), "public job ads are found: company, role, the repetitive duties quoted from the ad, the pay, and the ad linked as proof", j1?.who);
  check(!JSON.stringify(r).includes("Ghost Co") && !JSON.stringify(r).includes("variety of office things"), "a job ad whose duties Google's grounding didn't tie to a page is left out");
  check(jobs.some((c) => c.who === "A company (name not confirmed) is hiring an Order Entry Specialist" && c.pays === "pays a salary for this work (job ad)"), "a company name or pay that isn't backed by the source isn't shown ('name not confirmed'; 'pays a salary for this work')");
  const groupCall = (await callsSoFar()).find((c) => c.kind === "group");
  check(/JOB AD/.test(groupCall.prompt) && /proof of a paid need/.test(groupCall.prompt), "job ads are scored like the other evidence, as proof the company already pays for the work");
  const jp = r.problems.find((p) => /invoice follow-up/.test(p.title));
  check(jp && r.problems.indexOf(jp) === 1 && jp.scores.pays === 9 && jp.complaints.every((c) => c.kind === "job"), "a job-ad idea makes the top 3 when it ranks (here #2, with a high 'already pay' score)", jp && `${jp.total}/10`);
  check(r.leads.filter((l) => l.kind === "job").length === 2, "job ads appear in the leads list (companies not contacted)");
  check(fetched.length > 0 && fetched.every((u) => new URL(u).hostname === "localhost") && !fetched.some((u) => /indeed|linkedin|ziprecruiter|glassdoor|simplyhired/.test(u)), "job sites are never visited directly: job ads come from Google Search results (every request went to Gemini or a source page)", `${fetched.length} requests`);

  const ideas1 = await kv.get("ideas:2026-11", "json"), leads1 = await kv.get("leads:2026-11", "json");
  check(ideas1.length === 4 && ideas1[0].id === "2026-11-20-p1" && ideas1[0].complaints[0].sources[0].url.startsWith(`${SB}/page/`) && leads1.length === 5 && ideas1.some((x) => /invoice follow-up/.test(x.title) && x.complaints[0].kind === "job"), "ideas and leads (job ads included) are saved for good (with their proof), month by month");

  // Email and build prompt (built from the saved report only)
  const E = await import("../src/email.js"), PR = await import("../src/prompt.js");
  const mail = E.buildEmail(r, r.id, null, "https://night-agent.example");
  check(/^Night Agent: 3 ideas for Friday, November 20, 2026$/.test(mail.subject) && /OVERNIGHT\n16 of 16 searches · 5 pieces of evidence with proof \(2 job ads\) · 4 new ideas · \d+ Gemini calls/.test(mail.text), "the email says what the agent did overnight", mail.subject);
  check(/1\. Automatic 'tech is on the way' texts for HVAC customers — 7\.5\/10/.test(mail.text) && /Proof: "I wish there was an app that texted/.test(mail.text) && mail.text.includes(`${SB}/page/1`) && /Build it: https:\/\/night-agent\.example\/idea\/2026-11-20-p1/.test(mail.text), "…the top 3 ideas with their proof links and a 'build this' link");
  check(/LEADS \(5, public posts and job ads — not contacted\)/.test(mail.text) && /2\. Automatic invoice follow-up calls/.test(mail.text) && /\[Job ad\] "Call customers daily/.test(mail.text) && /\[Job ad\] Gulf Coast Food Distributors is hiring/.test(mail.text) && (mail.text.match(/^\d+\. .*http:\/\/localhost:8931\/page\/\d/gm) || []).length >= 3 && /Yes, build this/.test(mail.html), "…and the leads, each with its link; job ads are labeled in the top ideas and the leads (short and clear, text and HTML)");
  const jobPrompt = PR.buildPrompt(ideas1.find((x) => /invoice follow-up/.test(x.title)));
  check(/\[Job ad: the company pays someone to do this by hand\] "Call customers daily/.test(jobPrompt) && jobPrompt.includes("$18-$21 an hour (job ad)"), "the build prompt for a job-ad idea shows the ad's duties, pay and link");
  const prompt = PR.buildPrompt(ideas1[0]);
  const money = [...prompt.matchAll(/\$\d[\d,.]*(?:\/\w+)?/g)].map((m) => m[0]);
  check(prompt.includes(ideas1[0].complaints[0].quote) && prompt.includes(`${SB}/page/1`) && /Jobber: \$69\/month \(source: http:\/\/localhost:8931\/page\/4\)/.test(prompt) && /Don't contact any of the people quoted/.test(prompt), "'Yes, build this' makes a ready-to-paste Claude Code prompt with the real quotes, links, scores and competitors");
  check(money.every((m) => JSON.stringify(ideas1[0]).includes(m)), "the prompt adds no numbers of its own: every price in it comes from the saved proof", money.join(", "));

  // ── A2. The next night: nothing repeated ────────────────────────────────────────────────────────────
  await ctl({ reset: true });
  n = await night("2026-11-21");
  const q1 = (await kv.get("night:2026-11-20", "json")).queries.map((q) => q.q), q2 = n.st.queries.map((q) => q.q);
  check(n.report.status === "done" && n.report.problems.length === 0 && n.report.grouped, "the next night, ideas already reported are left out (same problems found again → 0 new)", `${n.report.problems.length} new`);
  check(!q2.some((q) => q1.includes(q)), "and it searches different things than the night before");
  check((await kv.get("ideas:2026-11", "json")).length === 4 && (await kv.get("leads:2026-11", "json")).length === 10, "earlier ideas stay saved (never deleted); new leads are added");

  // ── A3. Hitting the free limit: stop for the night and say so ─────────────────────────────────────
  await ctl({ reset: true, limitAfter: 3 });
  n = await night("2026-11-22");
  const after = (await callsSoFar()).filter((c) => c.model).length;
  check(n.report.status === "stopped" && /free daily limit was reached/.test(n.report.stopped.message) && after === 4, "at Gemini's free limit (429), the Scout stops for the night: no more calls, and the report says so", `${after} calls; ${n.report.stopped?.message.slice(0, 60)}`);
  check(n.report.complaints.length > 0 && !n.report.grouped, "the report still shows what was found before the limit, marked as not grouped");
  await ctl({ limitAfter: null, reset: true });

  // ── A4. A model without free grounding: the next one is used ──────────────────────────────────────
  await ctl({ noGrounding: ["gemini-2.5-flash"] });
  n = await night("2026-11-23");
  check(n.report.status === "done" && n.report.model === "gemini-2.5-flash-lite", "if a model has no free Google Search grounding, the next model on the list is used", n.report.model);
  await ctl({ noGrounding: [] });

  // ── A5. No key / wrong key ─────────────────────────────────────────────────────────────────────────
  const noKey = await P.runStep({ ...env, GEMINI_API_KEY: "" }, { now: Date.parse("2026-11-24T06:00:00Z") });
  check(noKey.status === "stopped" && /no working Gemini API key/.test(noKey.stopped.message), "with no Gemini key, the night stops at once and the report says to add GEMINI_API_KEY", noKey.stopped?.message);
  const badKey = await P.runStep({ ...env, GEMINI_API_KEY: "wrong" }, { now: Date.parse("2026-11-25T06:00:00Z") });
  check(badKey.status === "stopped" && badKey.stopped.kind === "key", "with a wrong key, it stops and says the key isn't working");

  // ── A6. The night ends at 4:50 with work left: the report has what was done ───────────────────────
  n = await night("2026-11-26", { from: 47 });
  check(n.report.cutShort === true && n.report.status === "done" && n.steps.length === 1, "at 4:55 a.m. the report is finished with whatever was done (marked as cut short)");
  stub.kill();

  // ── B. The real Worker ───────────────────────────────────────────────────────────────────────────────
  const stub2 = spawn(process.execPath, [path.join(__dirname, "stub-gemini.cjs"), String(STUB)], { stdio: ["ignore", "pipe", "inherit"] });
  await new Promise((ok) => stub2.stdout.once("data", ok));
  const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), "night-agent-"));
  const log = [];
  const w = spawn(WRANGLER, ["dev", "--port", String(PORT), "--persist-to", stateDir, "--test-scheduled", "--show-interactive-dev-session=false", "--log-level", "warn",
    "--var", "ALLOW_TEST:1", "--var", `GEMINI_BASE:${SB}`, "--var", "GEMINI_API_KEY:test-key", "--var", `NTFY_BASE:${SB}/ntfy`, "--var", "RESEND_API_KEY:re_test", "--var", `RESEND_BASE:${SB}`], { cwd: ROOT, env: { ...process.env, WRANGLER_SEND_METRICS: "false", CLOUDFLARE_API_TOKEN: "placeholder-not-used-locally" }, stdio: ["ignore", "pipe", "pipe"] });
  w.stdout.on("data", (d) => log.push(String(d))); w.stderr.on("data", (d) => log.push(String(d)));
  const browser = await chromium.launch();
  try {
    for (let i = 0; i < 120; i++) { try { await fetch(BASE); break; } catch { await sleep(500); } }
    const ctx = await browser.newContext({ viewport: { width: 390, height: 844 }, deviceScaleFactor: 2, isMobile: true, hasTouch: true });
    const pg = await ctx.newPage(); const errs = []; pg.on("pageerror", (e) => errs.push(e.message));
    const res = await pg.goto(BASE);
    check(/Choose a passcode/.test(await pg.textContent("main")) && res.headers()["content-security-policy"]?.includes("default-src 'none'") && res.headers()["x-robots-tag"]?.includes("noindex"), "first visit asks you to choose a passcode; pages are locked down (no scripts, not indexed)");
    await pg.fill("input[name=passcode]", "night-pass-123"); await pg.click("button");
    await pg.waitForSelector("text=No report yet");
    await pg.goto(`${BASE}/settings`);
    check(/API key: saved/.test(await pg.innerText("main")), "settings show the Gemini key is saved (never the key itself)");
    await pg.click("form[action='/alerts'] button");
    check(/subscribe to this topic: night-agent-[0-9a-f]{24}/.test(await pg.innerText("main")), "phone alerts: one tap makes a private ntfy topic to subscribe to");
    // Cron runs at night only.
    const day = await fetch(`${BASE}/__test/tick?time=${Date.parse("2026-11-30T15:00:00Z")}`);
    await sleep(800);
    check(day.status === 200 && (await day.json()).status === "skipped" && (await callsSoFar()).filter((c) => c.model).length === 0, "a cron run outside 1–5 a.m. Jamaica time does nothing");
    check((await fetch(`${BASE}/__scheduled?cron=*/5+6-9+*+*+*`)).status === 200, "the real Cron Trigger entry point runs without errors");
    // Each run waits for the one before (in real life they're 5 minutes apart).
    const idle = async () => { let last = -1; for (let i = 0; i < 60; i++) { const n = (await callsSoFar()).length; if (n === last) return; last = n; await sleep(700); } };
    for (let k = 0; k < 48 && !(await callsSoFar()).some((c) => c.ntfy); k++) { await fetch(`${BASE}/__test/tick?time=${Date.parse("2026-12-01T06:00:00Z") + k * 300000}`); await idle(); }
    check((await callsSoFar()).some((c) => c.ntfy), "the Cron Trigger runs drive the whole night on the real Worker, ending with the phone alert");
    await pg.goto(`${BASE}/night/2026-12-01`);
    const text = (await pg.innerText("main")).replace(/\s+/g, " ");
    check(/Automatic 'tech is on the way' texts for HVAC customers 7\.5\/10/.test(text) && /Proof: localhost/.test(text) && /Jobber — \$69\/month/.test(text) && /quote found on page/.test(text), "the morning report shows ranked problems with scores, quotes with proof links, and competitors with prices", text.slice(0, 160));
    check(await pg.locator("main a[href^='http://localhost:8931/page/']").count() >= 3, "every proof is a real link to the source page");
    await pg.screenshot({ path: path.join(OUT, "report-phone.png"), fullPage: true });
    // 6:00 a.m. email, once.
    const before = (await callsSoFar()).filter((c) => c.email).length;
    const e1 = await (await fetch(`${BASE}/__test/tick?kind=email&time=${Date.parse("2026-12-01T11:00:00Z")}`)).json();
    await fetch(`${BASE}/__test/tick?kind=email&time=${Date.parse("2026-12-01T11:00:00Z")}`);
    const sent = (await callsSoFar()).filter((c) => c.email).slice(before);
    check(e1.ok && sent.length === 1 && sent[0].email.to[0] === "marlonapp.sales@gmail.com" && /^Night Agent: 3 ideas for Tuesday, December 1, 2026$/.test(sent[0].email.subject) && sent[0].email.from === "Night Agent <onboarding@resend.dev>", "at 6:00 a.m. the report is emailed to marlonapp.sales@gmail.com — once, even if the trigger fires twice", sent[0]?.email.subject);
    check(sent[0].email.to.length === 1 && (await callsSoFar()).filter((c) => c.email).every((c) => c.email.to.join() === "marlonapp.sales@gmail.com"), "the email goes only to you (nobody else is ever contacted)");
    // Dashboard, ideas, build prompt, leads.
    await pg.goto(BASE);
    const dash = (await pg.innerText("main")).replace(/\s+/g, " ");
    check(/1 night · 4 ideas saved · 5 leads saved · 0 chosen to build/.test(dash) && /Automatic invoice follow-up calls/.test(dash) && /Email: Sent .* to marlonapp\.sales@gmail\.com/.test(dash) && await pg.locator("main form[action$='/build'] button").count() === 3, "the dashboard shows last night, totals, this morning's email, and the top 3 ideas with 'Yes, build this'", dash.slice(0, 200));
    await pg.screenshot({ path: path.join(OUT, "dashboard-phone.png"), fullPage: true });
    await pg.locator("main form[action$='/build'] button").first().click();
    await pg.waitForSelector("#prompt");
    const ptext = await pg.inputValue("#prompt");
    check(/^Build a new app for this problem/.test(ptext) && ptext.includes("http://localhost:8931/page/1") && ptext.includes("I wish there was an app that texted"), "'Yes, build this' opens a ready-to-paste Claude Code prompt for that idea");
    await ctx.grantPermissions(["clipboard-read", "clipboard-write"], { origin: BASE });
    await pg.click("[data-copy]");
    await pg.waitForFunction(() => /Copied|Selected/.test(document.getElementById("copied").textContent));
    check(/Copied|Selected/.test(await pg.textContent("#copied")), "…with a Copy button");
    await pg.screenshot({ path: path.join(OUT, "build-prompt-phone.png"), fullPage: true });
    await pg.goto(`${BASE}/ideas`);
    const ideasText = (await pg.innerText("main")).replace(/\s+/g, " ");
    check(/All ideas/.test(ideasText) && /chosen to build/.test(ideasText) && await pg.locator("main section.card").count() === 4, "the Ideas page lists every saved idea (job-ad ideas included), marking the ones chosen to build");
    await pg.goto(`${BASE}/leads`);
    check(await pg.locator("main blockquote").count() === 5 && await pg.locator("main .tag.warn", { hasText: "Job ad" }).count() === 2 && /Never contacted|nobody is contacted/.test(await pg.innerText("main")), "the Leads page lists every saved lead with its post link");
    const json401 = await fetch(`${BASE}/report/2026-12-01.json`);
    check(json401.status === 401 && !(await json401.text()).includes("HVAC"), "without signing in, the report and its data can't be read");
    await pg.goto(`${BASE}/history`);
    check(/finished/.test(await pg.innerText("main")), "past nights are listed");
    await pg.goto(`${BASE}/settings`);
    await pg.click("form[action='/run'] button");
    await pg.waitForSelector("text=Step done", { timeout: 120000 }).catch(() => {});
    check(/Step done|Test report/.test(await pg.innerText("main")), "'Run one step now' runs a test step on demand and says what it did");
    await pg.goto(`${BASE}/settings`); await pg.click("form[action='/logout'] button");
    const other = await (await browser.newContext()).newPage();
    for (let i = 0; i < 5; i++) { await other.goto(BASE); await other.fill("input[name=passcode]", "wrong-pass-000"); await other.click("button"); }
    await other.goto(BASE); await other.fill("input[name=passcode]", "night-pass-123"); await other.click("button");
    check(/Too many wrong tries/.test(await other.innerText("main")), "after 5 wrong passcodes, sign-in waits 15 minutes");
    check(errs.length === 0 && !log.join("").match(/night step failed|Uncaught/), "no page or Worker errors", (errs.join(" | ") + log.join("").match(/night step failed[^\n]*/)?.[0]).slice(0, 300));
  } finally {
    await browser.close(); w.kill("SIGTERM"); stub2.kill(); await sleep(1000); fs.rmSync(stateDir, { recursive: true, force: true });
  }
  if (failures) { console.log(`\n${failures} check(s) failed`); process.exit(1); }
  console.log("\nAll Night Agent checks passed");
})().catch((e) => { console.error(e); process.exit(1); });
