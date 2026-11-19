/**
 * Stand-ins for the tests, on one port: Gemini (no grounding), the Hacker News Algolia API, the Remotive jobs API,
 * We Work Remotely RSS, reddit.com/robots.txt, Resend and ntfy. Usage: node stub-gemini.cjs PORT
 * Gemini's answers include things the Scout must throw away: a quote that isn't in the text, a price that isn't in
 * the text, a problem with no real complaints, and a tool nobody mentioned.
 *   POST /control { limitAfter, retired, zeroQuota, reset }    GET /calls (what was asked)
 */
const http = require("http");
const PORT = Number(process.argv[2] || 8931);
let calls = [], limitAfter = Infinity, retired = new Set(), zeroQuota = new Set();
const MODELS = ["gemini-flash-lite-latest", "gemini-flash-latest", "gemini-2.5-flash-lite", "gemini-2.5-flash", "gemini-3.8-flash"];

const HN = [
  { objectID: "1001", _tags: ["comment"], story_title: "Ask HN: What software do you hate?", comment_text: "<p>I run a 3-truck HVAC company. I wish there was an app that texted my customers automatically when the tech is 20 minutes out. We pay $300 a month for ServiceTitan and it still can&#x27;t do it.</p>" },
  { objectID: "1002", _tags: ["comment"], story_title: "Ask HN: Tools for small trades businesses?", comment_text: "Is there a tool that turns handwritten work orders into invoices? I&#x27;d happily pay $50 a month, retyping them every night is killing me." },
  { objectID: "1003", _tags: ["comment"], story_title: "Field service software", comment_text: "I hate my scheduling software, it double books my techs every single week and support never answers." },
  { objectID: "1004", _tags: ["comment"], story_title: "Off topic", comment_text: "Nice weather today, nothing about software here at all, just chatting with friends." },
];
const HN_TOOLS = [
  { objectID: "2001", _tags: ["comment"], story_title: "Reminder texts", comment_text: "We tried Jobber for this, it costs $69/month and the reminders can&#x27;t be timed to the tech&#x27;s arrival." },
  { objectID: "2002", _tags: ["story"], title: "Show HN: notes on field service apps", story_text: "Housecall Pro is ok but clunky for small teams, honestly." },
];
const REMOTIVE = { "job-count": 2, jobs: [
  { id: 1, url: "https://remotive.com/remote-jobs/finance/accounts-receivable-clerk-1", title: "Accounts Receivable Clerk", company_name: "Gulf Coast Food Distributors", candidate_required_location: "USA", salary: "$18-$21/hour",
    description: "<p>Call customers daily to follow up on unpaid invoices and record every payment promise in the spreadsheet.</p><p>Other duties as assigned.</p>" },
  { id: 2, url: "https://remotive.com/remote-jobs/finance/clerk-de-2", title: "Data Entry Clerk", company_name: "Berlin GmbH", candidate_required_location: "Germany", salary: "", description: "<p>Enter data into SAP every day for our Berlin office team.</p>" },
] };
const JOBICY = { apiVersion: "2", jobCount: 1, jobs: [{ id: 11, url: "https://jobicy.com/jobs/11-customer-service-scheduler", jobTitle: "Customer Service Scheduler", companyName: "Lone Star HVAC Services", jobGeo: "USA",
  annualSalaryMin: 38000, annualSalaryMax: 44000, salaryCurrency: "USD", jobDescription: "<p>Answer inbound calls from customers and book their service appointments in our calendar.</p>" }] };
const HIMALAYAS = { offset: 0, limit: 20, totalCount: 2, jobs: [
  { title: "Accounts Payable Clerk", companyName: "Fresh Fields Grocers", applicationLink: "https://himalayas.app/companies/fresh-fields/jobs/accounts-payable-clerk", minSalary: 40000, maxSalary: 46000, currency: "USD", locationRestrictions: ["United States"],
    description: "<p>Enter vendor invoices into QuickBooks and match them against purchase orders every day.</p>" },
  { title: "Staff Machine Learning Engineer", companyName: "AI Co", applicationLink: "https://himalayas.app/companies/ai-co/jobs/staff-ml", locationRestrictions: [], description: "<p>Train large models on our GPU cluster for the research team.</p>" },
] };
const RSS = `<?xml version="1.0"?><rss><channel>
<item><title>Acme Logistics: Order Entry Specialist</title><region>USA Only</region><link>https://weworkremotely.com/remote-jobs/acme-logistics-order-entry-specialist</link><description><![CDATA[<p>Type phone and email orders from restaurants into our order system and confirm delivery dates by phone.</p>]]></description></item>
<item><title>Bright Dental: Front Desk Receptionist</title><region>USA Only</region><link>https://weworkremotely.com/remote-jobs/bright-dental-front-desk-receptionist</link><description><![CDATA[<p>Greet patients warmly at our front desk and keep the waiting room tidy for every visitor.</p>]]></description></item>
<item><title>Cool Startup: Senior Rust Engineer</title><region>Anywhere in the World</region><link>https://weworkremotely.com/remote-jobs/cool-startup-senior-rust-engineer</link><description><![CDATA[<p>Build distributed systems in Rust for our platform team.</p>]]></description></item>
</channel></rss>`;

function analyze(prompt) {
  const docs = [...prompt.matchAll(/\[(d\d+)\] [^\n]*\n([^\n]*)/g)].map((m) => ({ id: m[1], text: m[2] }));
  const items = [];
  for (const d of docs) {
    if (/wish there was an app/.test(d.text)) items.push({ docId: d.id, quote: "I wish there was an app that texted my customers automatically when the tech is 20 minutes out.", paysQuote: "We pay $300 a month for ServiceTitan" });
    else if (/handwritten/.test(d.text)) items.push({ docId: d.id, quote: "Is there a tool that turns handwritten work orders into invoices?", paysQuote: "I'd happily pay $50 a month" });
    else if (/double books/.test(d.text)) items.push({ docId: d.id, quote: "I hate my scheduling software, it double books my techs every single week and support never answers.", paysQuote: "they pay $999 a month" });
    else if (/unpaid invoices/.test(d.text)) items.push({ docId: d.id, quote: "Call customers daily to follow up on unpaid invoices and record every payment promise in the spreadsheet." });
    else if (/Type phone and email orders/.test(d.text)) items.push({ docId: d.id, quote: "Type phone and email orders from restaurants into our order system and confirm delivery dates by phone." });
    else if (/Answer inbound calls/.test(d.text)) items.push({ docId: d.id, quote: "Answer inbound calls from customers and book their service appointments in our calendar." });
    else if (/Enter vendor invoices/.test(d.text)) items.push({ docId: d.id, quote: "Enter vendor invoices into QuickBooks and match them against purchase orders every day." });
    else if (/Nice weather/.test(d.text)) items.push({ docId: d.id, quote: "I would pay anything for an AI receptionist that answers every call for my salon." }); // invented → must be dropped
  }
  return { items };
}
function group(prompt) {
  const ids = [...prompt.matchAll(/\[(c\d+)\] (?!JOB AD)/g)].map((m) => m[1]), jobIds = [...prompt.matchAll(/\[(c\d+)\] JOB AD/g)].map((m) => m[1]);
  const past = /Problems already reported[\s\S]*?\n- ([^\n]+)/.exec(prompt)?.[1] || "";
  return { problems: [
    { title: "Automatic 'tech is on the way' texts for HVAC customers", summary: "HVAC owners want customers texted automatically before the tech arrives.", who: "Owners of small HVAC companies", complaintIds: ids.slice(0, 1), people: 7, pays: 8, anger: 6, buildSpeed: 9, why: "Owner already pays $300 a month for ServiceTitan and still lacks it." },
    ...(jobIds.length ? [{ title: "Automatic invoice follow-up and order entry for distributors", summary: "Distributors pay staff to chase unpaid invoices and type orders by hand.", who: "Food and drink distributors", complaintIds: jobIds, people: 6, pays: 9, anger: 5, buildSpeed: 8, why: "Companies pay salaries for this work (job ads)." }] : []),
    { title: "Handwritten work orders into invoices", summary: "Trades businesses retype paper work orders into invoices every night.", who: "Small trades businesses", complaintIds: ids.slice(1, 2), people: 6, pays: 7, anger: 8, buildSpeed: 7, why: "Would pay $50/month; retyping every night." },
    { title: "Scheduling software double-booking technicians", summary: "Double bookings every week.", who: "Field service companies", complaintIds: ids.slice(2, 3), people: 5, pays: 6, anger: 9, buildSpeed: 4, why: "Weekly double bookings, no support.", repeatOf: past.includes("double") ? past : "" },
    { title: "A made-up problem with no complaints", summary: "Nothing backs this.", who: "Nobody", complaintIds: ["c999"], people: 10, pays: 10, anger: 10, buildSpeed: 10, why: "Invented." },
  ] };
}
function compete(prompt) {
  const tools = [];
  for (const m of prompt.matchAll(/PROBLEM (p\d+):[^\n]*\n((?:\[d\d+\][^\n]*\n?)+)/g)) {
    for (const line of m[2].split("\n")) {
      const id = /\[(d\d+)\]/.exec(line)?.[1];
      if (/Jobber/.test(line)) tools.push({ problem: m[1], name: "Jobber", docId: id, quote: "We tried Jobber for this, it costs $69/month and the reminders can't be timed to the tech's arrival.", priceQuote: "$69/month" });
    }
    tools.push({ problem: m[1], name: "MadeUpSoft", docId: "d1", quote: "MadeUpSoft is the best tool for this, everyone uses it." }); // not in the posts → must be dropped
  }
  return { tools };
}

http.createServer((rq, rs) => {
  const u = new URL(rq.url, `http://localhost:${PORT}`); let data = "";
  rq.on("data", (d) => (data += d));
  rq.on("end", () => {
    const send = (code, obj, type = "application/json") => { rs.writeHead(code, { "content-type": type }); rs.end(typeof obj === "string" ? obj : JSON.stringify(obj)); };
    if (u.pathname === "/control") { const b = JSON.parse(data || "{}"); if ("limitAfter" in b) limitAfter = b.limitAfter ?? Infinity; if (b.retired) retired = new Set(b.retired); if (b.zeroQuota) zeroQuota = new Set(b.zeroQuota); if (b.reset) calls = []; return send(200, { ok: true }); }
    if (u.pathname === "/calls") return send(200, calls);
    calls.push({ path: u.pathname, query: u.search });
    if (u.pathname === "/robots.txt") return send(200, "User-agent: *\nDisallow: /\n", "text/plain"); // reddit.com today
    if (u.pathname === "/search.json") return send(200, { data: { children: [] } });
    if (u.pathname === "/api/v1/search_by_date") { const q = u.searchParams.get("query") || ""; return send(200, { hits: / software$/.test(q) && !q.includes('"') ? HN_TOOLS : HN }); }
    if (u.pathname === "/api/remote-jobs") return send(200, REMOTIVE);
    if (u.pathname === "/api/v2/remote-jobs") return send(200, JOBICY);
    if (u.pathname === "/jobs/api/search" || u.pathname === "/jobs/api") return send(200, HIMALAYAS);
    if (/^\/categories\/.+\.rss$/.test(u.pathname)) return send(200, RSS, "application/rss+xml");
    if (u.pathname.startsWith("/ntfy/")) { calls.push({ ntfy: u.pathname, body: data, title: rq.headers.title }); return send(200, { id: "x" }); }
    if (u.pathname === "/emails" && rq.method === "POST") { calls.push({ email: JSON.parse(data || "{}"), auth: rq.headers.authorization }); return send(rq.headers.authorization === "Bearer re_test" ? 200 : 401, rq.headers.authorization === "Bearer re_test" ? { id: "email_1" } : { name: "validation_error", message: "API key is invalid" }); }
    if (rq.headers["x-goog-api-key"] !== "test-key") return send(400, { error: { code: 400, message: "API key not valid. Please pass a valid API key.", status: "INVALID_ARGUMENT" } });
    if (u.pathname === "/v1beta/models") return send(200, { models: MODELS.map((m) => ({ name: `models/${m}`, supportedGenerationMethods: ["generateContent", "countTokens"] })) });
    const m = /^\/v1beta\/models\/([^:]+):generateContent$/.exec(u.pathname);
    if (m) {
      const body = JSON.parse(data || "{}"), prompt = body.contents?.[0]?.parts?.[0]?.text || "", schema = JSON.stringify(body.generationConfig?.responseSchema || {});
      const kind = /"problems"/.test(schema) ? "group" : /"tools"/.test(schema) ? "compete" : /"items"/.test(schema) ? "analyze" : "other";
      calls.push({ model: m[1], search: Boolean(body.tools), kind, prompt: kind === "group" ? prompt.slice(0, 4000) : undefined });
      if (retired.has(m[1])) return send(404, { error: { code: 404, message: `This model models/${m[1]} is no longer available to new users.`, status: "NOT_FOUND" } });
      if (zeroQuota.has(m[1]) || calls.filter((c) => c.model).length > limitAfter) return send(429, { error: { code: 429, message: "You exceeded your current quota, please check your plan and billing details.", status: "RESOURCE_EXHAUSTED" } });
      const out = kind === "analyze" ? analyze(prompt) : kind === "group" ? group(prompt) : kind === "compete" ? compete(prompt) : { text: "ok" };
      return send(200, { candidates: [{ content: { parts: [{ text: JSON.stringify(out) }] } }], usageMetadata: { totalTokenCount: 500 } });
    }
    send(404, { error: { code: 404, message: "not found" } });
  });
}).listen(PORT, () => console.log("stub ready"));
