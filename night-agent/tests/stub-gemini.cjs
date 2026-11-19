/**
 * A stand-in for Google's Gemini API (and the web pages its sources point to), for the tests. Usage: node stub-gemini.cjs PORT
 *   GET  /v1beta/models                       models list
 *   POST /v1beta/models/<m>:generateContent    grounded searches, competitor searches, grouping (JSON) — realistic shapes
 *   GET  /r/<n>  → 302 to /page/<n>            the grounding redirect links;  GET /page/<n>  the source pages
 *   POST /control  { limitAfter, noGrounding } change behaviour;  GET /calls  what was asked
 * Each answer includes things that must be thrown away: a quote with no grounding support, a problem with no real
 * complaints, a repeat of an earlier idea, and a competitor with no proof.
 */
const http = require("http");
const PORT = Number(process.argv[2] || 8930), B = `http://localhost:${PORT}`;
let calls = [], limitAfter = Infinity, noGrounding = new Set();
const QUOTES = [
  "I wish there was an app that texted my HVAC customers automatically when the tech is 20 minutes out, we pay for ServiceTitan and it still can't do it right",
  "Is there a tool that turns my handwritten work orders into invoices? I'd happily pay $50 a month, retyping them every night is killing me",
  "I hate my scheduling software, it double books my techs every single week and support never answers",
  "Honestly this whole industry is a mess and nobody cares about small shops like mine at all", // has no grounding support → must be dropped
];
const page = (n) => `<!doctype html><html><body><div class="post"><p>${n === 1 ? QUOTES[0] : n === 2 ? QUOTES[1].replace("I'd", "I&#39;d") : "Totally different text about something else entirely."}</p></div></body></html>`;

function grounded(text, lines) {
  // lines: [lineText, [chunk indexes]]
  return { candidates: [{ content: { parts: [{ text }] }, groundingMetadata: { webSearchQueries: ["q"],
    groundingChunks: [1, 2, 3, 4].map((n) => ({ web: { uri: `${B}/r/${n}`, title: ["reddit.com", "reddit.com", "community.example.org", "g2.com"][n - 1] } })),
    groundingSupports: lines.map(([t, idx]) => ({ segment: { text: t }, groundingChunkIndices: idx, confidenceScores: idx.map(() => 0.9) })) } }], usageMetadata: { totalTokenCount: 900 } };
}
function answer(prompt, body) {
  if (body.generationConfig?.responseSchema) {
    const ids = [...prompt.matchAll(/\[(c\d+)\] (?!JOB AD)/g)].map((m) => m[1]), jobIds = [...prompt.matchAll(/\[(c\d+)\] JOB AD/g)].map((m) => m[1]);
    const past = /Problems already reported[\s\S]*?\n- ([^\n]+)/.exec(prompt)?.[1] || "";
    return { candidates: [{ content: { parts: [{ text: JSON.stringify({ problems: [
      { title: "Automatic 'tech is on the way' texts for HVAC customers", summary: "HVAC owners want customers texted automatically before the tech arrives.", who: "Owners of small HVAC companies", complaintIds: ids.slice(0, 1), people: 7, pays: 8, anger: 6, buildSpeed: 9, why: "Owner already pays for ServiceTitan and still lacks it." },
      { title: "Handwritten work orders into invoices", summary: "Trades businesses retype paper work orders into invoices every night.", who: "Small trades businesses", complaintIds: ids.slice(1, 2), people: 6, pays: 7, anger: 8, buildSpeed: 7, why: "Would pay $50/month; retyping every night." },
      { title: "Scheduling software double-booking technicians", summary: "Double bookings every week.", who: "Field service companies", complaintIds: ids.slice(2, 3), people: 5, pays: 6, anger: 9, buildSpeed: 4, why: "Weekly double bookings, no support.", repeatOf: past.includes("double") ? past : "" },
      ...(jobIds.length ? [{ title: "Automatic invoice follow-up calls and payment tracking for distributors", summary: "Distributors pay clerks to chase unpaid invoices by phone and log promises in spreadsheets.", who: "Food and drink distributors", complaintIds: jobIds, people: 6, pays: 9, anger: 5, buildSpeed: 8, why: "A company pays $18-$21 an hour for this by hand (job ad)." }] : []),
      { title: "A made-up problem with no complaints", summary: "Nothing backs this.", who: "Nobody", complaintIds: ["c999"], people: 10, pays: 10, anger: 10, buildSpeed: 10, why: "Invented." },
    ] }) }] } }] };
  }
  if (/Write each ad exactly like this/.test(prompt)) {
    const J = [
      ["Gulf Coast Food Distributors", "Accounts Receivable Clerk", "Call customers daily to follow up on unpaid invoices and record every payment promise in the spreadsheet", "$18-$21 an hour"],
      ["Ghost Co", "Clerk", "Do a variety of office things as needed by the team and other duties as assigned", "not listed"], // duties not backed → dropped
      ["Unbacked Name LLC", "Order Entry Specialist", "Type phone and email orders from restaurants into our order system and confirm delivery dates by phone", "$17 an hour"],
    ];
    const text = J.map(([c, r, t, p]) => `JOB\nCOMPANY: ${c}\nROLE: ${r}\nTASKS: ${t}\nPAY: ${p}\nWHERE: indeed.com\nEND`).join("\n");
    return grounded(text, [[`COMPANY: ${J[0][0]}`, [0]], [`ROLE: ${J[0][1]}`, [0]], [`TASKS: ${J[0][2]}`, [0]], [`PAY: ${J[0][3]}`, [0]], [`TASKS: ${J[2][2]}`, [1]], [`ROLE: ${J[2][1]}`, [1]]]);
  }
  if (/COMPETITOR/.test(prompt)) {
    const text = "COMPETITOR\nNAME: Jobber\nPRICE: $69/month\nDISLIKES: Text reminders can't be timed to the tech's arrival\nEND\nCOMPETITOR\nNAME: Imaginary Soft\nPRICE: $5/month\nDISLIKES: none\nEND";
    return grounded(text, [["NAME: Jobber", [3]], ["PRICE: $69/month", [3]], ["DISLIKES: Text reminders can't be timed to the tech's arrival", [3]]]);
  }
  const text = QUOTES.map((q, i) => `ITEM\nQUOTE: ${q}\nWHO: ${["HVAC owner in Texas", "plumbing company owner", "dispatcher", "anonymous"][i]}\nWHERE: reddit.com/r/HVAC\nPAYS: ${i === 0 ? "ServiceTitan" : i === 1 ? "would pay $50/month" : "unknown"}\nEND`).join("\n");
  return grounded(text, [[`QUOTE: ${QUOTES[0]}`, [0]], ["WHO: HVAC owner in Texas", [0]], ["PAYS: ServiceTitan", [0]], [`QUOTE: ${QUOTES[1]}`, [1]], ["WHO: plumbing company owner", [1]], ["PAYS: would pay $50/month", [1]], [`QUOTE: ${QUOTES[2]}`, [2]]]);
}

http.createServer((rq, rs) => {
  const u = new URL(rq.url, B); let data = "";
  rq.on("data", (d) => (data += d));
  rq.on("end", () => {
    const send = (code, obj, type = "application/json") => { rs.writeHead(code, { "content-type": type }); rs.end(typeof obj === "string" ? obj : JSON.stringify(obj)); };
    if (u.pathname === "/control") { const b = JSON.parse(data || "{}"); if ("limitAfter" in b) limitAfter = b.limitAfter ?? Infinity; if (b.noGrounding) noGrounding = new Set(b.noGrounding); if (b.reset) calls = []; return send(200, { ok: true }); }
    if (u.pathname === "/calls") return send(200, calls);
    if (u.pathname.startsWith("/r/")) { rs.writeHead(302, { location: `${B}/page/${u.pathname.slice(3)}` }); return rs.end(); }
    if (u.pathname === "/robots.txt") return send(200, "User-agent: *\nDisallow: /page/3\n", "text/plain");
    if (u.pathname.startsWith("/page/")) { calls.push({ page: Number(u.pathname.slice(6)) }); return send(200, page(Number(u.pathname.slice(6))), "text/html; charset=utf-8"); }
    if (u.pathname === "/emails" && rq.method === "POST") { calls.push({ email: JSON.parse(data || "{}"), auth: rq.headers.authorization }); return send(rq.headers.authorization === "Bearer re_test" ? 200 : 401, rq.headers.authorization === "Bearer re_test" ? { id: "email_1" } : { name: "validation_error", message: "API key is invalid" }); }
    if (u.pathname.startsWith("/ntfy/")) { calls.push({ ntfy: u.pathname, body: data, title: rq.headers.title }); return send(200, { id: "x" }); }
    if (rq.headers["x-goog-api-key"] !== "test-key") return send(400, { error: { code: 400, message: "API key not valid. Please pass a valid API key.", status: "INVALID_ARGUMENT" } });
    if (u.pathname === "/v1beta/models") return send(200, { models: ["gemini-2.5-flash", "gemini-2.5-flash-lite", "gemini-3-pro"].map((m) => ({ name: `models/${m}`, supportedGenerationMethods: ["generateContent", "countTokens"] })) });
    const m = /^\/v1beta\/models\/([^:]+):generateContent$/.exec(u.pathname);
    if (m) {
      const body = JSON.parse(data || "{}"), prompt = body.contents?.[0]?.parts?.[0]?.text || "";
      calls.push({ model: m[1], search: Boolean(body.tools), kind: body.generationConfig?.responseSchema ? "group" : /COMPETITOR/.test(prompt) ? "compete" : /Write each ad exactly like this/.test(prompt) ? "jobs" : "search", prompt: body.generationConfig?.responseSchema ? prompt.slice(0, 4000) : undefined });
      if (calls.filter((c) => c.model).length > limitAfter) return send(429, { error: { code: 429, message: "You exceeded your current quota, please check your plan and billing details.", status: "RESOURCE_EXHAUSTED" } });
      if (body.tools && noGrounding.has(m[1])) return send(400, { error: { code: 400, message: "Search Grounding is not supported for this model on the free tier.", status: "INVALID_ARGUMENT" } });
      return send(200, answer(prompt, body));
    }
    send(404, { error: { code: 404, message: "not found" } });
  });
}).listen(PORT, () => console.log("stub ready"));
