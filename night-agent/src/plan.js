/**
 * What the Scout searches each night, the prompts it uses, and how it reads the answers.
 * Searches rotate through US business types and places people complain (Reddit, forums, app store reviews, Google
 * reviews, Product Hunt, TikTok/YouTube comments that show up in search), so different nights cover different ground,
 * and a search used before isn't used again.
 */
export const VERTICALS = [
  "restaurants", "dental offices", "HVAC contractors", "plumbers", "electricians", "hair salons and barbershops", "property managers and landlords",
  "trucking and freight companies", "landscaping companies", "accountants and bookkeepers", "real estate agents", "Shopify and e-commerce sellers",
  "gyms and fitness studios", "cleaning companies", "auto repair shops", "small law firms", "medical clinics", "photographers", "event planners",
  "roofing contractors", "pest control companies", "churches and nonprofits", "tutoring centers", "veterinary clinics", "food trucks",
  "wholesale distributors", "construction general contractors", "insurance agents", "physical therapists", "daycare centers",
];
export const PHRASES = ["\"I wish there was an app\"", "\"is there a tool that\"", "\"I hate my software\"", "\"is there software that\"", "\"why is there no app\"",
  "\"looking for software\" frustrated", "\"switched from\" \"because\" software", "\"anyone know a tool\""];
export const PLACES = ["site:reddit.com", "forum", "app store reviews", "Google reviews software", "site:producthunt.com", "TikTok OR YouTube comments", "Capterra OR G2 reviews \"cons\""];

/** This night's searches (12): business types rotate by night, and searches already used are skipped. */
export function nightQueries(nightNo, used = new Set(), count = 12) {
  const out = [];
  for (let k = 0; out.length < count && k < 400; k++) {
    const v = VERTICALS[(nightNo * 4 + Math.floor(k / 3)) % VERTICALS.length];
    const p = PHRASES[(nightNo + k) % PHRASES.length], place = PLACES[(nightNo * 3 + k) % PLACES.length];
    const q = `${place} ${v} ${p}`;
    if (!used.has(q) && !out.includes(q)) out.push(q);
  }
  return out;
}

export const searchPrompt = (q) => `You are researching what US business owners and their staff genuinely want from software.
Use Google Search to find REAL public posts, comments or reviews (Reddit, forums, app store reviews, Google reviews, Product Hunt, YouTube or TikTok comments, G2/Capterra reviews) matching: ${q}

Rules:
- Only include things a real person actually wrote, that you found in the search results. Copy their words exactly as the QUOTE (one or two sentences). Never invent, merge or paraphrase quotes.
- Prefer people in the US, and businesses that would pay for a fix.
- Skip anything that isn't a complaint about software, or a wish for software that doesn't exist or doesn't work well.
- Give up to 6 items. If you found none, write NONE.

Write each item exactly like this, and nothing else:
ITEM
QUOTE: <their exact words>
WHO: <who wrote it, e.g. "owner of a 3-truck HVAC company in Texas">
WHERE: <site, e.g. reddit.com/r/HVAC>
PAYS: <what they pay for today, or what they said they'd pay, or "unknown">
END`;

export const competitorPrompt = (p) => `Use Google Search to find existing software that already tries to solve this problem for US businesses:
"${p.title}" — ${p.summary}

For up to 4 real products, write exactly:
COMPETITOR
NAME: <product name>
PRICE: <the price as published on their site or a review site, e.g. "$49/month per user", or "not published">
DISLIKES: <what real users complain about, from reviews you found>
END
Only include facts you found in the search results. Never guess prices.`;

export const clusterSchema = {
  type: "OBJECT",
  properties: {
    problems: {
      type: "ARRAY",
      items: {
        type: "OBJECT",
        properties: {
          title: { type: "STRING" }, summary: { type: "STRING" }, who: { type: "STRING" },
          complaintIds: { type: "ARRAY", items: { type: "STRING" } },
          people: { type: "INTEGER" }, pays: { type: "INTEGER" }, anger: { type: "INTEGER" }, buildSpeed: { type: "INTEGER" },
          why: { type: "STRING" }, repeatOf: { type: "STRING" },
        },
        required: ["title", "summary", "who", "complaintIds", "people", "pays", "anger", "buildSpeed", "why"],
      },
    },
  },
  required: ["problems"],
};
export const clusterPrompt = (complaints, past) => `Here are complaints and wishes about software that real people posted (each has an id).
Group them into distinct PROBLEMS that a solo developer could build software for. A problem needs at least one complaint.
Score each problem from 1 to 10:
- people: how many people seem to have it (more complaints, bigger groups of businesses = higher)
- pays: whether they already pay for a fix or clearly would (evidence of paid tools, budgets, prices = higher)
- anger: how frustrated or urgent they are
- buildSpeed: how fast one developer using an AI coding assistant (Claude Code) could build a good first version (10 = a weekend, 1 = years)
Base every score on the complaints given, and say why in one or two sentences ("why"). Do not use outside knowledge to invent demand.
Problems already reported on earlier nights (don't report these again; if a new problem is the same as one of them, set "repeatOf" to that title):
${past.length ? past.map((t) => `- ${t}`).join("\n") : "- (none yet)"}

Complaints:
${complaints.map((c) => `[${c.id}] (${c.who}; ${c.where}; pays: ${c.pays}) "${c.quote}"`).join("\n")}`;

/** Reads ITEM…END / COMPETITOR…END blocks. */
export function readBlocks(text, start, fields) {
  const out = [];
  const re = new RegExp(`(?:^|\\n)\\s*\\**${start}\\**\\s*\\n([\\s\\S]*?)\\n\\s*\\**END\\**`, "g");
  for (const m of String(text || "").matchAll(re)) {
    const item = {}, lines = {};
    for (const raw of m[1].split("\n")) {
      const mm = /^\s*[*-]?\s*\**([A-Z]+)\**\s*:\s*(.*)$/.exec(raw);
      if (mm && fields.includes(mm[1].toLowerCase())) { item[mm[1].toLowerCase()] = mm[2].trim().replace(/^"(.*)"$/, "$1"); lines[mm[1].toLowerCase()] = raw.trim(); }
    }
    out.push({ ...item, _lines: lines });
  }
  return out;
}
