/**
 * Stand-ins for the tests, on one port: Gemini (no grounding), the Hacker News Algolia API, the Remotive jobs API, Stack Exchange, Remote OK, Working Nomads,
 * We Work Remotely RSS, reddit.com/robots.txt, Resend and ntfy. Usage: node stub-gemini.cjs PORT
 * Gemini's answers include things the Scout must throw away: a quote that isn't in the text, a price that isn't in
 * the text, a problem with no real complaints, and a tool nobody mentioned.
 *   POST /control { limitAfter, retired, zeroQuota, reset }    GET /calls (what was asked)
 */
const http = require("http");
const PORT = Number(process.argv[2] || 8931);
let calls = [], extra = false, limitAfter = Infinity, retired = new Set(), zeroQuota = new Set();
const MODELS = ["gemini-flash-lite-latest", "gemini-flash-latest", "gemini-2.5-flash-lite", "gemini-2.5-flash", "gemini-3.8-flash"];

const HN = [
  { objectID: "1001", _tags: ["comment"], author: "threetruckhvac", story_title: "Ask HN: What software do you hate?", comment_text: "<p>I run a 3-truck HVAC company. I wish there was an app that texted my customers automatically when the tech is 20 minutes out. We pay $300 a month for ServiceTitan and it still can&#x27;t do it.</p>" },
  { objectID: "1002", _tags: ["comment"], story_title: "Ask HN: Tools for small trades businesses?", comment_text: "Is there a tool that turns handwritten work orders into invoices? I&#x27;d happily pay $50 a month, retyping them every night is killing me." },
  { objectID: "1003", _tags: ["comment"], story_title: "Field service software", comment_text: "I hate my scheduling software, it double books my techs every single week and support never answers." },
  { objectID: "1007", _tags: ["comment"], author: "hvac_dana", story_title: "Ask HN: Field service pain", comment_text: "Our HVAC customers want an ETA text before the tech shows up and we still call each one by hand from the office." },
  { objectID: "1008", _tags: ["comment"], author: "coolair_mike", story_title: "Ask HN: Trades software", comment_text: "Customers hate a four hour arrival window, I want them texted automatically when my technician is close." },
  { objectID: "1004", _tags: ["comment"], story_title: "Off topic", comment_text: "Nice weather today, nothing about software here at all, just chatting with friends." },
];
// "extra" mode: a new post about an old idea (HVAC texts), and a post about a brand-new problem.
const HN_EXTRA = [
  { objectID: "1005", _tags: ["comment"], story_title: "Ask HN: Small business pain points", comment_text: "My customers keep calling to ask when my tech is on his way, an automatic text would save me an hour a day." },
  { objectID: "1006", _tags: ["comment"], story_title: "Ask HN: Food truck software?", comment_text: "Does anyone know an app to track propane refills for my three food trucks? We run out mid-shift every month." },
  { objectID: "1009", _tags: ["comment"], story_title: "Ask HN: Food truck software?", comment_text: "Same here, we track propane refills on a whiteboard and it never works when the truck is on the road." },
  { objectID: "1010", _tags: ["comment"], story_title: "Running a food truck", comment_text: "Biggest headache is propane refills, nobody knows when a tank was filled last so we run out at lunch." },
];
const HN_TOOLS = [
  { objectID: "2001", _tags: ["comment"], story_title: "Reminder texts", comment_text: "We tried Jobber for this, it costs $69/month and the reminders can&#x27;t be timed to the tech&#x27;s arrival." },
  { objectID: "2002", _tags: ["story"], title: "Show HN: notes on field service apps", story_text: "Housecall Pro is ok but clunky for small teams, honestly." },
];
const REMOTIVE = { "job-count": 2, jobs: [
  { id: 1, url: "https://remotive.com/remote-jobs/finance/accounts-receivable-clerk-1", title: "Accounts Receivable Clerk", company_name: "Gulf Coast Food Distributors", candidate_required_location: "USA", salary: "$18-$21/hour",
    description: "<p>Call customers daily to follow up on unpaid invoices and record every payment promise in the spreadsheet.</p><p>Other duties as assigned.</p>" },
  { id: 3, url: "https://remotive.com/remote-jobs/software-development/senior-backend-developer-3", title: "Senior Backend Developer", company_name: "Code Shop", candidate_required_location: "USA", salary: "$150k",
    description: "<p>Design and build APIs in Go for our payments platform with the backend team.</p>" },
  { id: 2, url: "https://remotive.com/remote-jobs/finance/clerk-de-2", title: "Data Entry Clerk", company_name: "Berlin GmbH", candidate_required_location: "Germany", salary: "", description: "<p>Enter data into SAP every day for our Berlin office team.</p>" },
] };
const STACK = { items: [{ question_id: 501, title: "Simple app for tracking client follow-ups?", body: "<p>I run a two person bookkeeping office and track every client follow-up in a paper notebook. Is there a simple app for this?</p>", link: "https://softwarerecs.stackexchange.com/questions/501/simple-app-for-tracking-client-follow-ups", owner: { display_name: "ledger_lou" } }], has_more: false, quota_remaining: 299 };
const REMOTEOK = [{ legal: "API terms: link back to Remote OK and mention it as the source." },
  { id: 7000, url: "https://remoteok.com/remote-jobs/7000-customer-service-scheduler-lone-star-hvac", position: "Customer Service Scheduler", company: "Lone Star HVAC Services", location: "Austin, TX", salary_min: 38000, salary_max: 44000,
    description: "<p>Answer inbound calls from customers and book their service appointments in our calendar.</p>" },
  { id: 7001, url: "https://remoteok.com/remote-jobs/7001-billing-specialist-medbill", position: "Billing Specialist", company: "MedBill Co", location: "USA", salary_min: 42000, salary_max: 48000, description: "<p>Enter insurance claims into our billing system and call payers about denied claims every day.</p>" },
  { id: 7002, url: "https://remoteok.com/remote-jobs/7002-senior-golang-engineer", position: "Senior Golang Engineer", company: "Infra Co", location: "Worldwide", description: "<p>Build high-throughput services in Go for our infrastructure platform team.</p>" }];
const WN = [{ url: "https://www.workingnomads.com/jobs/dispatcher-metro-freight", title: "Dispatcher", company_name: "Metro Freight", location: "USA", description: "<p>Assign loads to drivers by phone and update the load board spreadsheet all day long.</p>" },
  { url: "https://www.workingnomads.com/jobs/order-clerk-eu", title: "Order Entry Clerk", company_name: "EU Foods", location: "Germany", description: "<p>Enter orders for our German stores into SAP every single day of the week.</p>" }];
let big = false;
const LOREM = "We run a small company and every week someone spends hours copying numbers between the website, the spreadsheet and the accounting tool, then checking it twice because mistakes cost us money and customers notice. ";
const bigHits = (q) => { let h = 7; for (const ch of q) h = (h * 31 + ch.charCodeAt(0)) % 9973; return Array.from({ length: 50 }, (_, i) => ({ objectID: String(500000 + h * 50 + i), _tags: ["comment"], author: `user${h}_${i}`, story_title: `Thread ${h}`, comment_text: `<p>Post ${h}-${i}. ${LOREM.repeat(4)}</p>` })); };
let gatedRobots = "User-agent: *\nAllow: /\n";
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
    else if (/when my tech is on his way/.test(d.text)) items.push({ docId: d.id, quote: "My customers keep calling to ask when my tech is on his way, an automatic text would save me an hour a day." });
    else if (/ETA text before the tech/.test(d.text)) items.push({ docId: d.id, quote: "Our HVAC customers want an ETA text before the tech shows up and we still call each one by hand from the office." });
    else if (/four hour arrival window/.test(d.text)) items.push({ docId: d.id, quote: "Customers hate a four hour arrival window, I want them texted automatically when my technician is close." });
    else if (/whiteboard/.test(d.text)) items.push({ docId: d.id, quote: "Same here, we track propane refills on a whiteboard and it never works when the truck is on the road." });
    else if (/Biggest headache is propane/.test(d.text)) items.push({ docId: d.id, quote: "Biggest headache is propane refills, nobody knows when a tank was filled last so we run out at lunch." });
    else if (/propane refills/.test(d.text)) items.push({ docId: d.id, quote: "Does anyone know an app to track propane refills for my three food trucks? We run out mid-shift every month." });
    else if (/Nice weather/.test(d.text)) items.push({ docId: d.id, quote: "I would pay anything for an AI receptionist that answers every call for my salon." }); // invented → must be dropped
  }
  return { items };
}
function group(prompt) {
  const jobIds = [...prompt.matchAll(/\[(c\d+)\] JOB AD/g)].map((m) => m[1]);
  const past = /Problems already reported[\s\S]*?\n- ([^\n]+)/.exec(prompt)?.[1] || "";
  const idOf = (re) => [...prompt.matchAll(/\[(c\d+)\][^\n]*/g)].find((m) => re.test(m[0]))?.[1];
  const idsOf = (re) => [...prompt.matchAll(/\[(c\d+)\][^\n]*/g)].filter((m) => re.test(m[0])).map((m) => m[1]);
  const hvac = [idOf(/wish there was an app that texted/), idOf(/ETA text/), idOf(/arrival window/)].filter(Boolean);
  const onWay = idOf(/on his way/), propane = idsOf(/propane/);
  const sw = { category: "software", tooBroad: false };
  return { problems: [
    { ...sw, category: "hardware", title: "Rugged handheld scanner for HVAC techs", summary: "A tough device for the field.", who: "HVAC technicians", buyer: "HVAC technicians", product: "A rugged handheld scanner device.", price: 300, priceWhy: "Estimate.", complaintIds: hvac, people: 5, pays: 5, anger: 5, buildSpeed: 2, why: "Hardware." },
    { ...sw, tooBroad: true, title: "Admin work is tedious", summary: "Lots of admin work.", who: "Small businesses", buyer: "small businesses", product: "An all-in-one admin tool for everything.", price: 99, priceWhy: "Estimate.", complaintIds: [...hvac, ...jobIds], people: 9, pays: 9, anger: 9, buildSpeed: 9, why: "Everyone has admin work." },
    ...(propane.length ? [{ ...sw, title: "Propane refill tracking for food trucks", summary: "Food truck owners run out of propane mid-shift.", who: "Food truck owners", buyer: "Owners of food truck fleets with 2–10 trucks", product: "A phone app that logs each propane refill per truck and warns before a tank runs low.", price: 19, priceWhy: "Small fleets run out monthly; a low price fits.", complaintIds: propane, people: 5, pays: 6, anger: 7, buildSpeed: 9, why: "Runs out every month." }] : []),
    { ...sw, title: onWay ? "Text customers automatically when the HVAC tech is close" : "Automatic 'tech is on the way' texts for HVAC customers", summary: "HVAC owners want customers texted automatically before the tech arrives.", who: "Owners of small HVAC companies",
      buyer: "Owners of HVAC companies with 1–10 technicians", product: "A web app that texts each customer automatically when their technician is 20 minutes away, using the tech's phone location.", price: 49, priceWhy: "One owner already pays $300 a month for ServiceTitan and still lacks this.",
      complaintIds: onWay ? [hvac[0], onWay] : hvac, people: 7, pays: 8, anger: 6, buildSpeed: 9, why: "Owner already pays $300 a month for ServiceTitan and still lacks it." },
    ...(jobIds.length ? [{ ...sw, title: "Automatic invoice follow-up and order entry for distributors", summary: "Distributors pay staff to chase unpaid invoices and type orders by hand.", who: "Food and drink distributors",
      buyer: "Food and drink distributors with an in-house order desk", product: "Software that reads emailed orders into the order system and sends automatic reminders for unpaid invoices.", price: 199, priceWhy: "Competitors charge $250 a month for this.",
      complaintIds: jobIds, people: 6, pays: 9, anger: 5, buildSpeed: 8, why: "Companies pay salaries for this work (job ads)." }] : []),
    { ...sw, title: "Handwritten work orders into invoices", summary: "Trades businesses retype paper work orders into invoices every night.", who: "Small trades businesses", buyer: "Owners of plumbing companies", product: "An app that turns a photo of a handwritten work order into an invoice.", price: 29, priceWhy: "Would pay $50 a month.", complaintIds: [idOf(/handwritten/)].filter(Boolean), people: 6, pays: 7, anger: 8, buildSpeed: 7, why: "Would pay $50/month; retyping every night." },
    { ...sw, title: "Scheduling software double-booking technicians", summary: "Double bookings every week.", who: "Field service companies", buyer: "Field service companies with 5+ technicians", product: "A scheduler that blocks double bookings of technicians.", price: 39, priceWhy: "Estimate.", complaintIds: [idOf(/double books/)].filter(Boolean), people: 5, pays: 6, anger: 9, buildSpeed: 4, why: "Weekly double bookings, no support.", repeatOf: past.includes("double") ? past : "" },
    { ...sw, title: "A made-up problem with no complaints", summary: "Nothing backs this.", who: "Nobody", buyer: "Nobody", product: "Nothing at all here.", price: 10, priceWhy: "", complaintIds: ["c999"], people: 10, pays: 10, anger: 10, buildSpeed: 10, why: "Invented." },
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
    if (u.pathname === "/control") { const b = JSON.parse(data || "{}"); if ("limitAfter" in b) limitAfter = b.limitAfter ?? Infinity; if (b.retired) retired = new Set(b.retired); if (b.zeroQuota) zeroQuota = new Set(b.zeroQuota); if (b.reset) calls = []; if ("extra" in b) extra = b.extra; if ("big" in b) big = b.big; if ("gatedRobots" in b) gatedRobots = b.gatedRobots; return send(200, { ok: true }); }
    if (u.pathname === "/calls") return send(200, calls);
    calls.push({ path: u.pathname, query: u.search });
    if (u.pathname === "/robots.txt") return send(200, /^127\.0\.0\.1/.test(rq.headers.host || "") ? gatedRobots : "User-agent: *\nDisallow: /\n", "text/plain"); // 127.0.0.1 = Stack Exchange, Remote OK, Working Nomads; localhost = reddit.com (disallows all today)
    if (u.pathname === "/search.json") return send(200, { data: { children: [] } });
    if (u.pathname === "/api/v1/search_by_date") { const q = u.searchParams.get("query") || ""; return send(200, { hits: / software$/.test(q) && !q.includes('"') ? HN_TOOLS : big ? bigHits(q) : extra ? [...HN, ...HN_EXTRA] : HN }); }
    if (u.pathname === "/api/remote-jobs") return send(200, REMOTIVE);
    if (u.pathname === "/2.3/questions") return send(200, STACK);
    if (u.pathname === "/api") return send(200, REMOTEOK);
    if (u.pathname === "/api/exposed_jobs/") return send(200, WN);
    if (u.pathname === "/remote-jobs.rss") return send(200, RSS, "application/rss+xml");
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
