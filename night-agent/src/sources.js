/**
 * Public sources, fetched directly (no Gemini search). Each returns documents:
 *   { kind: "post" | "job", src, url, title, text, company?, role?, pay?, location? }
 * Every document keeps its own public link, which is the proof for anything quoted from it.
 *
 *   Hacker News — the official Algolia HN Search API (hn.algolia.com/api), comments and posts from the last 90 days
 *   Remotive    — its public jobs API (remotive.com/api/remote-jobs); they ask for at most ~4 requests a day: we use 2
 *                 (repetitive-work titles only)
 *   We Work Remotely — public RSS feeds by category
 *   Himalayas   — its public jobs API (himalayas.app/jobs/api)
 *   Stack Exchange — its public API (api.stackexchange.com): newest questions on Software Recommendations and Web
 *                 Applications (people asking for software); no key: 300 requests a day, we use 2 a night
 *   Remote OK   — its public jobs API (remoteok.com/api); its terms ask for a link back and naming Remote OK as the source
 *   Working Nomads — its public jobs API (workingnomads.com/api/exposed_jobs)
 *   (Stack Exchange, Remote OK and Working Nomads are asked only if their robots.txt allows it.)
 *   Reddit      — only if reddit.com/robots.txt allows automated access (today it doesn't, so it's skipped and the
 *                 report says so; Reddit's API terms also require a registered app)
 * Texts are cleaned (HTML removed) and trimmed, so each run stays small.
 */
const UA = "NightAgentScout/1.0 (+public research; contact via site owner)";
const TEXT_MAX = 700;
const base = (env, key, real) => (env.ALLOW_TEST === "1" && env[key] ? env[key] : real);

export function clean(html) {
  return String(html || "").slice(0, 6000).replace(/<(script|style)[\s\S]*?<\/\1>/gi, " ").replace(/<br\s*\/?>|<\/p>|<p>/gi, " ").replace(/<[^>]{0,500}>/g, " ")
    .replace(/&#x27;|&#39;|&rsquo;|&lsquo;/g, "'").replace(/&quot;|&ldquo;|&rdquo;|&#x22;/g, '"').replace(/&amp;/g, "&").replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&#x2F;/g, "/").replace(/&nbsp;|&#160;/g, " ")
    .replace(/&#(\d+);/g, (_, n) => String.fromCharCode(Number(n))).replace(/\s+/g, " ").trim();
}
const trim = (s, n = TEXT_MAX) => (s.length > n ? `${s.slice(0, n)}…` : s);
async function get(url, timeout = 12000) {
  const res = await fetch(url, { headers: { "user-agent": UA, accept: "application/json, application/rss+xml, text/xml, */*" }, signal: AbortSignal.timeout(timeout) });
  if (!res.ok) throw new Error(`${new URL(url).hostname} answered ${res.status}`);
  return res;
}

/** Hacker News (Algolia): newest comments/posts matching a phrase. */
export async function hackerNews(env, query, { since, tags = "(comment,story)", hits = 20 } = {}) {
  const u = new URL(`${base(env, "HN_BASE", "https://hn.algolia.com")}/api/v1/search_by_date`);
  u.searchParams.set("query", query); u.searchParams.set("tags", tags); u.searchParams.set("hitsPerPage", String(hits));
  if (since) u.searchParams.set("numericFilters", `created_at_i>${Math.floor(since / 1000)}`);
  const d = await (await get(u.toString())).json();
  return (d.hits || []).map((h) => {
    const isComment = (h._tags || []).includes("comment");
    const text = clean(String(isComment ? h.comment_text || "" : `${h.title || ""}. ${h.story_text || ""}`).slice(0, 2500));
    const kindLabel = isComment ? "Hacker News comment" : /^ask hn/i.test(h.title || "") ? "Ask HN post" : "Hacker News post", author = String(h.author || "").replace(/[^\w.-]/g, "").slice(0, 40);
    return { kind: "post", src: "Hacker News", label: author ? `Hacker News user ${author}` : kindLabel,
      url: `https://news.ycombinator.com/item?id=${encodeURIComponent(h.objectID)}`, title: clean(isComment ? h.story_title || "" : h.title || "").slice(0, 160), text: trim(text) };
  }).filter((x) => x.text.length > 40);
}

const REPETITIVE = /data entry|customer (service|support)|support (specialist|representative|agent)|scheduling|scheduler|appointment|billing|accounts (payable|receivable)|bookkeep|collections|dispatch|admin(istrative)? assistant|office assistant|virtual assistant|receptionist|order (entry|processing)|coordinator|clerk|call center|inbound|outbound|reporting analyst|invoice/i;
const US = /\b(usa|u\.s\.|united states|us only|us-based|north america|americas|anywhere|worldwide)\b/i;
/** Remotive public jobs API: one search. */
export async function remotive(env, search, { limit = 50 } = {}) {
  const u = new URL(`${base(env, "REMOTIVE_BASE", "https://remotive.com")}/api/remote-jobs`);
  u.searchParams.set("search", search); u.searchParams.set("limit", String(limit));
  const d = await (await get(u.toString())).json();
  return (d.jobs || []).filter((j) => (!j.candidate_required_location || US.test(j.candidate_required_location)) && REPETITIVE.test(String(j.title || ""))).map((j) => ({
    kind: "job", src: "Remotive", label: "Job ad", url: String(j.url || ""), title: String(j.title || "").slice(0, 120), company: String(j.company_name || "").slice(0, 100), role: String(j.title || "").slice(0, 100),
    pay: String(j.salary || "").slice(0, 80), location: String(j.candidate_required_location || "").slice(0, 80), text: trim(clean(j.description), 900) })).filter((x) => /^https:\/\//.test(x.url) && x.text.length > 40);
}

/** We Work Remotely RSS: jobs whose title looks like repetitive work. */
export async function weWorkRemotely(env, category) {
  const root = base(env, "WWR_BASE", "https://weworkremotely.com");
  const xml = (await (await get(category === "all" ? `${root}/remote-jobs.rss` : `${root}/categories/${category}.rss`)).text()).slice(0, 400000);
  const out = [];
  for (const m of xml.matchAll(/<item>([\s\S]*?)<\/item>/g)) {
    const tag = (t) => { const x = new RegExp(`<${t}>(?:<!\\[CDATA\\[)?([\\s\\S]*?)(?:\\]\\]>)?</${t}>`).exec(m[1]); return x ? x[1].trim() : ""; };
    const title = clean(tag("title")), link = tag("link") || tag("guid"), region = clean(tag("region"));
    const [company, ...rest] = title.split(": "), role = rest.join(": ") || title;
    if (!REPETITIVE.test(role) || !/^https:\/\//.test(link) || (region && !US.test(region))) continue;
    out.push({ kind: "job", src: "We Work Remotely", label: "Job ad", url: link, title: role.slice(0, 120), company: rest.length ? company.slice(0, 100) : "", role: role.slice(0, 100), pay: "", location: region.slice(0, 80), text: trim(clean(tag("description")), 900) });
    if (out.length >= 15) break;
  }
  return out.filter((x) => x.text.length > 40);
}

const salary = (min, max, cur) => (min || max ? `${cur === "USD" || !cur ? "$" : `${cur} `}${[min, max].filter(Boolean).map((n) => Number(n).toLocaleString("en-US")).join("-")} a year` : "");

const MUSE_US = /flexible \/ remote|united states|,\s*(A[LKZR]|C[AOT]|D[EC]|FL|GA|HI|I[ADLN]|K[SY]|LA|M[ADEINOST]|N[CDEHJMVY]|O[HKR]|PA|RI|S[CD]|T[NX]|UT|V[AT]|W[AIVY])\b/i;
/** Himalayas public jobs API: a search (or, if search isn't available, the newest jobs), repetitive-work titles only. */
export async function himalayas(env, q, { limit = 20 } = {}) {
  const root = base(env, "HIMALAYAS_BASE", "https://himalayas.app");
  let d;
  try { d = await (await get(`${root}/jobs/api/search?q=${encodeURIComponent(q)}&limit=${limit}`)).json(); }
  catch { d = await (await get(`${root}/jobs/api?limit=${limit}&offset=0`)).json(); }
  return (d.jobs || []).map((j) => {
    const loc = (Array.isArray(j.locationRestrictions) ? j.locationRestrictions.map((x) => (typeof x === "string" ? x : x?.name || "")).join(", ") : "") || "";
    return { kind: "job", src: "Himalayas", label: "Job ad", url: String(j.applicationLink || j.guid || ""), title: clean(j.title).slice(0, 120), company: clean(j.companyName).slice(0, 100), role: clean(j.title).slice(0, 100),
      pay: salary(j.minSalary, j.maxSalary, j.currency).slice(0, 80), location: loc.slice(0, 80), text: trim(clean(j.description || j.excerpt), 900) };
  }).filter((x) => /^https:\/\//.test(x.url) && REPETITIVE.test(x.role) && x.text.length > 40 && (!x.location || US.test(x.location)));
}

/** Stack Exchange public API: the newest questions (with their text) on one site, e.g. softwarerecs or webapps. */
export async function stackExchange(env, site, { pagesize = 100 } = {}) {
  const u = new URL(`${base(env, "STACK_BASE", "https://api.stackexchange.com")}/2.3/questions`);
  for (const [k, v] of Object.entries({ order: "desc", sort: "creation", site, pagesize: String(pagesize), filter: "withbody" })) u.searchParams.set(k, v);
  const d = await (await get(u.toString())).json();
  const siteName = site === "softwarerecs" ? "Software Recommendations" : site === "webapps" ? "Web Applications" : site;
  return (d.items || []).map((q) => {
    const author = clean(q.owner?.display_name).slice(0, 40);
    return { kind: "post", src: "Stack Exchange", label: author ? `${siteName} user ${author}` : `${siteName} question`, url: String(q.link || ""), title: clean(q.title).slice(0, 160), text: trim(clean(`${q.title || ""}. ${q.body || ""}`)) };
  }).filter((x) => /^https:\/\/[a-z.]*stackexchange\.com\/questions\/\d+/.test(x.url) && x.text.length > 40);
}

/** Remote OK public jobs API (the first item is their legal notice). Repetitive-work titles, US/anywhere only. */
export async function remoteOk(env) {
  const d = await (await get(`${base(env, "REMOTEOK_BASE", "https://remoteok.com")}/api`)).json();
  return (Array.isArray(d) ? d : []).filter((j) => j && j.position && j.url).map((j) => ({ kind: "job", src: "Remote OK", label: "Job ad", url: String(j.url), title: clean(j.position).slice(0, 120), company: clean(j.company).slice(0, 100),
    role: clean(j.position).slice(0, 100), pay: j.salary_min || j.salary_max ? salary(j.salary_min, j.salary_max, "USD").slice(0, 80) : "", location: clean(j.location).slice(0, 80), text: trim(clean(j.description), 900) }))
    .filter((x) => /^https:\/\//.test(x.url) && REPETITIVE.test(x.role) && x.text.length > 40 && (!x.location || US.test(x.location) || MUSE_US.test(x.location)));
}

/** Working Nomads public jobs API. Repetitive-work titles, US/anywhere only. */
export async function workingNomads(env) {
  const d = await (await get(`${base(env, "WN_BASE", "https://www.workingnomads.com")}/api/exposed_jobs/`)).json();
  return (Array.isArray(d) ? d : []).map((j) => ({ kind: "job", src: "Working Nomads", label: "Job ad", url: String(j.url || ""), title: clean(j.title).slice(0, 120), company: clean(j.company_name).slice(0, 100),
    role: clean(j.title).slice(0, 100), pay: "", location: clean(j.location).slice(0, 80), text: trim(clean(j.description), 900) }))
    .filter((x) => /^https:\/\//.test(x.url) && REPETITIVE.test(x.role) && x.text.length > 40 && (!x.location || US.test(x.location) || MUSE_US.test(x.location)));
}

/** Reddit public JSON — only when reddit.com/robots.txt allows it for this agent (checked every night). */
export async function reddit(env, query, robotsAllow) {
  const root = base(env, "REDDIT_BASE", "https://www.reddit.com");
  if (!(await robotsAllow(`${root}/search.json`))) return { skipped: "Reddit's site rules (robots.txt) don't allow automated access, so Reddit was skipped. Reddit's API terms also require a registered app." };
  const u = new URL(`${root}/search.json`); u.searchParams.set("q", query); u.searchParams.set("sort", "new"); u.searchParams.set("limit", "20"); u.searchParams.set("t", "month");
  const d = await (await get(u.toString())).json();
  return { docs: (d.data?.children || []).map((c) => c.data || {}).map((p) => ({ kind: "post", src: "Reddit", label: `Reddit post in r/${String(p.subreddit || "").slice(0, 40)}`,
    url: `https://www.reddit.com${String(p.permalink || "")}`, title: clean(p.title).slice(0, 160), text: trim(clean(`${p.title || ""}. ${p.selftext || ""}`)) })).filter((x) => /\/comments\//.test(x.url) && x.text.length > 40) };
}
