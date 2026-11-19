/**
 * "Yes, build this": a ready-to-paste Claude Code prompt for one idea, built only from what the Scout saved (the real
 * quotes and links, the scores, the competitors). Nothing is added or guessed, and no Gemini call is used.
 */
const who = (w) => w || "a poster (details not confirmed)";

export function buildPrompt(idea) {
  const quotes = idea.complaints.map((c) => `- ${c.kind === "job" ? "[Job ad: the company pays someone to do this by hand] " : ""}"${c.quote}" — ${who(c.who)}${c.pays && c.pays !== "unknown" ? ` (pays: ${c.pays})` : ""}\n  Source: ${c.sources.map((s) => s.url).join(" , ")}`).join("\n");
  const comps = idea.competitors.length ? idea.competitors.map((c) => `- ${c.name}: ${c.price ? `${c.price} (source: ${c.priceSources.map((s) => s.url).join(" , ")})` : "price not found"}`
    + `${c.dislikes ? `\n  What users dislike: ${c.dislikes} (source: ${c.dislikeSources.map((s) => s.url).join(" , ")})` : ""}\n  About it: ${c.sources.map((s) => s.url).join(" , ")}`).join("\n")
    : "- None were found with proof. Before building, search for existing products yourself and tell me what you find.";
  const s = idea.scores;
  return `Build a new app for this problem, found by my Night Agent from real public posts.

THE PROBLEM
${idea.title}
${idea.summary}
Who has it: ${idea.who || "see the quotes below"}

EVIDENCE (real quotes from public posts and job ads, with their sources — this is all we know)
${quotes}

NIGHT AGENT SCORES (1–10, a judgement based only on the evidence above)
How many people have it: ${s.people} · Already pay for a fix: ${s.pays} · How angry they are: ${s.anger} · How fast to build: ${s.buildSpeed} · Total: ${idea.total}/10
Why: ${idea.why}

EXISTING PRODUCTS (from public pages)
${comps}

WHAT I WANT
1. Read the evidence. Open the source links to check them. Then propose the smallest first version (MVP) that solves exactly this problem better than the existing products, and show it to me as a short plan. Don't add features nobody asked for.
2. Before writing code, list what could go wrong (wrong assumptions, edge cases, platform limits) and how you'll prevent or check each one.
3. Build it as a fast, phone-friendly web app on my existing setup (Cloudflare Workers, free plan), unless there's a strong reason not to; tell me if so.
4. Write tests, run them, deploy it, and tell me in plain words what works, what was tested, and anything I need to set up.

RULES
- Don't invent facts about the market, prices or customers: the only evidence is above. If something isn't known, say so.
- Don't contact any of the people quoted, and don't log into any site.
- Use free tiers only; nothing that charges me money without asking first.
- Don't touch my other apps.
`;
}
