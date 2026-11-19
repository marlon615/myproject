# Night Agent — stage 1: the Scout

Every night from **1:00 to 4:55 a.m. Jamaica time**, the Scout looks for real people complaining about software or
wishing it existed ("I wish there was an app…", "is there a tool that…", "I hate my software…"), mostly US businesses
that pay for software. It groups what it finds into problems, scores them, checks competitors, and leaves a
**morning report** with a link to every source.

- **Live:** https://night-agent.marlon615.workers.dev (first visit: choose your passcode)
- **Runs on:** your Cloudflare account, free plan only (Workers + Cron Triggers + KV). Google Gemini API, free tier only.
- Separate from every other app here: its own Worker (`night-agent`), its own KV store (`night-agent-scout`).

## What happens each night

A Cron Trigger fires every 5 minutes (`*/5 6-9 * * *` UTC = 1:00–4:55 a.m. in Jamaica, which is UTC−5 all year).
Each run does one small step and saves progress in KV, so it fits the free plan:

1. **Search** — 12 searches a night with Gemini + Google Search grounding: Reddit, forums, app store reviews,
   Google reviews, Product Hunt, TikTok/YouTube comments that show up in search, G2/Capterra. Business types rotate
   (restaurants, HVAC, dental offices, property managers, e-commerce sellers, … 30 in all), and a search used before is
   never used again.
   Plus **4 job-ad searches** (Indeed, LinkedIn Jobs, ZipRecruiter, SimplyHired, Glassdoor, company career pages, through
   Google Search): companies paying people to do repetitive work by hand — data entry, chasing invoices, answering calls,
   scheduling, taking orders, making reports. Each ad is treated as a proven, paid need: the duties are quoted from the
   ad, the ad is linked as proof, and the company name and pay are shown only when the source backs them. Job sites are
   never visited directly (they don't allow bots); the ads come from Google's search results. 16 searches a night in all.
2. **Proof** — only quotes that Google's grounding tied to a web page are kept, with that page as the proof. Anything
   the model wrote without a source is thrown away. Each source link is turned into its real address, and where the
   page can be read, the quote is checked on it ("quote found on page").
3. **Group and score** — complaints become problems, scored 1–10 on how many people have it, whether they already pay,
   how angry they are, and how fast it could be built with Claude Code. Total = 30% people + 30% paying + 20% anger +
   20% build speed. A "problem" with no real complaints behind it is dropped.
4. **Competitors** — for the top 5: existing products, their published prices, what users dislike, each with its source.
   A price that wasn't found is shown as "price not found", never guessed.
5. **Report** — saved when done (usually by about 2:30 a.m.), or at 4:55 a.m. with whatever was finished.
   Ideas from earlier reports are left out (the model is told them, and a word-overlap check catches near-repeats).

**Leads.** Up to 10 a night: public posts where someone asked for software like this, and job ads for work software
could do, each with its link and the idea
it belongs to. Fewer if fewer were found (never padded). Nobody is contacted in stage 1, and no names are collected.

**Rules it follows.** Public information only, never logs into any site. The only time it opens a site's page itself
(to check a quote) it first reads that site's robots.txt and skips the page if the site doesn't allow it (Reddit doesn't,
so Reddit quotes are linked but not checked). "Who wrote it" and "what they pay" are shown only when Google's grounding
backs them too; otherwise "details not confirmed".

**Limits.** One Gemini call per step (at most one every 5 minutes; about 22 a night). If Gemini says a limit is reached
(429), or a model has no free grounding, or the key doesn't work, the Scout stops for the night and the report says so
in plain words, showing whatever it had already found. About 50 KV writes a night (free: 1,000 a day). Each step's own
work measured a few milliseconds of CPU in tests (free: 10 ms per run).

**Models.** Each night it asks Google which models your key can use and takes the first of `GEMINI_MODELS` in
`wrangler.toml` (default: gemini-2.5-flash, then gemini-2.5-flash-lite, then gemini-flash-latest). If one has no free
Google Search grounding, it tries the next. It never sets up or uses billing.

## The 6:00 a.m. email

At 6:00 a.m. Jamaica time (Cron Trigger `0 11 * * *`), the morning report is emailed to `REPORT_EMAIL`
(marlonapp.sales@gmail.com): what the agent did overnight, the top 3 ideas with proof links, and the leads. Short,
plain text plus a simple HTML version, sent once per morning. If the night failed or didn't finish, the email says so.
It goes only to you. It's sent through **Resend**'s free plan (3,000 emails a month). Resend's starter sender
(`onboarding@resend.dev`) can only send to the email address the Resend account was created with, so create the
Resend account with **marlonapp.sales@gmail.com**.

## Get your free Resend key (on your phone)

1. Open **resend.com** and tap **Sign up**. Sign up with **marlonapp.sales@gmail.com** (Google sign-in or email), and
   confirm the email Resend sends you.
2. In Resend, open **API Keys** (menu), tap **Create API key**, name it "Night Agent", permission **Sending access**,
   then **Add**. Copy the key (it starts with `re_`). It's shown only once.
3. In Cloudflare (steps below), add it as a secret named `RESEND_API_KEY`. Then Settings → **Send this morning's email
   now** sends a test.

## Get your free Gemini API key (on your phone)

1. Open **aistudio.google.com** in Chrome or Safari.
2. Sign in with your Google account, and accept the terms if asked.
3. Tap the menu (☰, top left), then **Get API key** (it may be under **Dashboard → API keys**).
4. Tap **Create API key**. If it asks for a project, choose **Create API key in new project** (or the default project).
5. Tap **Copy** next to the new key (it starts with `AIza`). Don't set up billing: without a billing account, the key
   stays on the free tier.
6. Optional: in AI Studio, open **Usage / Rate limits** to see your exact free limits for Gemini 2.5 Flash.

## Store it as a Cloudflare secret (on your phone)

1. Open **dash.cloudflare.com** and sign in.
2. Tap **Workers & Pages**, then **night-agent**.
3. Tap **Settings**, then **Variables and Secrets**, then **Add**.
4. Type: **Secret**. Name: `GEMINI_API_KEY`. Value: paste the key. (Same steps for `RESEND_API_KEY`.)
5. Tap **Deploy** (or **Save**). No code change or redeploy is needed.
6. Open https://night-agent.marlon615.workers.dev → **Settings**: "API key: saved". Tap **Run one step now** to try a
   step straight away (a separate test report; the real one runs at night).

## Your private dashboard

- `/` **Dashboard**: last night at a glance, totals, this morning's email status, the top 3 ideas with **Yes, build this**.
- `/history` **Reports**: every night's report (`/night/<date>` for one; `/report/<date>.json` raw data).
- `/ideas` **Ideas**: every idea ever found, saved for good (month by month), best first, with **Yes, build this**.
  That button marks the idea as chosen and opens a ready-to-paste Claude Code build prompt (`/idea/<id>/prompt`) made
  only from the saved evidence: the real quotes and links, the scores and the competitors.
- `/leads` **Leads**: every lead ever found, saved for good, with its post link.
- `/settings`: Gemini and Resend key status, "Send this morning's email now", "Run one step now", phone alert.

Pages: All behind your passcode (PBKDF2, 5 wrong tries → 15-minute wait;
sessions 30 days). Forgot the passcode: raise `RESET_GENERATION` in `wrangler.toml` and redeploy (reports are kept).

**Phone alert (optional):** Settings → Phone alert → Turn on, then subscribe to the shown topic in the free **ntfy** app.

## Tests

`node tests/scout.test.cjs` — runs whole nights against a stand-in Gemini (tests/stub-gemini.cjs): proof-only results,
scoring, competitors, repeats, the free limit, a model without grounding, missing/wrong key, a night cut short, KV writes
and CPU per step; then the real Worker (wrangler dev) with the cron runs, passcode and report pages in a browser.
It also checks robots.txt, the who/pays proof rule, leads, saved ideas and leads, the email (content, once per morning,
only to you), the build prompt (no numbers of its own), and the dashboard pages. Test-only switches (`ALLOW_TEST=1`,
`GEMINI_BASE`, `NTFY_BASE`, `RESEND_BASE`, `/__test/tick`) are never set on the live Worker.
