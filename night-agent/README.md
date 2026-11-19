# Night Agent — stage 1: the Scout

Every night from **1:00 to 4:55 a.m. Jamaica time**, the Scout looks for real people complaining about software or
wishing it existed ("I wish there was an app…", "is there a tool that…", "I hate my software…"), mostly US businesses
that pay for software. It groups what it finds into problems, scores them, checks competitors, and leaves a
**morning report** with a link to every source.

- **Live:** https://night-agent.marlon615.workers.dev (first visit: choose your passcode)
- **Runs on:** your Cloudflare account, free plan only (Workers + Cron Triggers + KV). Google Gemini API, free tier only.
- Separate from every other app here: its own Worker (`night-agent`), its own KV store (`night-agent-scout`).

## What happens each night

A Cron Trigger fires every 5 minutes (`*/5 6-9 * * *` UTC = 1:00–4:55 a.m. in Jamaica, UTC−5 all year). Each run does
one small step and saves progress in KV, so it fits the free plan. **Gemini never searches** (Google refused free search
grounding for this key): the Scout fetches public sources itself, and Gemini only reads that text.

1. **Fetch** (no Gemini) — official public sources only, about 73 fetches a night, free tiers only:
   - **Hacker News** (official Algolia HN Search API): 12 phrase searches from the last 90 days ("I wish there was…",
     "is there a tool…", "manual data entry"…) plus 8 broad searches from the last 3 days ("invoice manual work",
     "appointment reminders"…), 40 results each, rotating every night.
   - **Apple App Store** (public iTunes Search API + public customer-reviews RSS feed): the 30 most-rated US business
     apps across invoicing, scheduling, CRM, delivery, inventory, field service, POS and payroll (chosen once a week:
     8 searches), then each app's newest reviews every night (30 feeds), keeping **only 1- and 2-star reviews from the
     last 30 days**. Apple has no page for a single review, so a review's proof link opens the app's public reviews
     page (tagged with the review's id), and the lead names the reviewer, the stars, the app and the date.
   - **Stack Exchange** (public API, no key: 300 requests a day): the newest 100 questions on Software Recommendations
     and on Web Applications, plus 4 searches a night (last 30 days) for small business and operations questions about
     manual, repetitive or broken workflows ("manually every day spreadsheet", "copy data between"…). 6 requests a night.
   - **Remotive** jobs API: 2 searches a night (they ask for at most ~4 a day). **Himalayas** jobs API: 6 searches.
     **We Work Remotely** RSS: 5 feeds. **Remote OK** jobs API (their terms: link back and name Remote OK; we do) and
     **Working Nomads** jobs API: 1 each. Job boards: US/anywhere jobs whose title looks like repetitive work only
     (developers, writers and other unrelated jobs are left out and not saved).
   - Apple, Stack Exchange, Remote OK and Working Nomads are asked only if their robots.txt allows it (checked each night).
   - **Reddit**: robots.txt checked every night; today it disallows automated access, so it's skipped and the report
     says so. (Jobicy and The Muse were tried and removed: both refused requests from Cloudflare.)
   **At least 150 texts a night:** if the fetches bring fewer than 150 new texts, up to 8 more Hacker News searches run;
   if it's still under 150, the report says how many were found. At most 400 a night (read 40 at a time: at most 10 Gemini reading calls). Texts
   already read on an earlier night aren't read again (the last ~12,000 are remembered). Each step takes at most 3
   sources and stops at ~80 texts, so it stays under the free plan's 10 ms of CPU (worst case measured: ~7 ms).
2. **Read** — Gemini (no search) reads the texts in batches of ~30 and picks complaints, wishes for software, and job
   ads for repetitive work, each with a quote. **A quote is kept only if it appears word for word in the fetched text**;
   the page it came from is the proof. "What they pay" is kept only if those words are in the text too (job ads: the pay
   the job board lists). "Who" is the public username the source shows (e.g. "Hacker News user …"), or the company.
3. **Group, check and score** — every idea must be:
   - **software** (not hardware, not a service like outsourcing), **specific** (not too broad), for **one specific type
     of buyer** (e.g. "owners of HVAC companies with 1–10 technicians", never "small businesses");
   - with **the exact product to build**, a **suggested monthly price** (labelled as a suggestion; its reason may only
     mention dollar amounts written in the evidence, otherwise it says "our estimate"), and
   - **at least 3 leads**: public posts or job ads from 3 different pages showing that exact problem, each with its link.
   Anything else is left out (the report and email say what and why). Scored 1–10 (people, already paying, anger, build
   speed); total = 30/30/20/20, **plus 0.3 for each extra app or source where the same complaint shows up** (at most
   +1.5; e.g. the same complaint in reviews of 3 different apps = +0.6). Each idea shows where it was seen. Ideas sent on any earlier report are never new again (see below).
4. **Competitors** — for the top 5, Hacker News posts about tools for that problem are fetched, and Gemini names the
   tools they mention, again only with a word-for-word quote. A price is shown only if it's written in that post.
5. **Report** — usually done by about 3:30 a.m.; at 4:55 a.m. at the latest. Each idea shows its buyer, the product, the
   suggested price and all its leads; plus up to 10 leads overall (never contacted). Ideas and leads are saved for good.

**Never the same idea twice.** Every idea in every finished report (real nights and test runs) is remembered for good in
the same SQLite database (ideas reported before this memory existed were loaded in first). An idea is "the same" as one
already sent when Gemini says so, when the titles share most of their key words, or when its proof links to a page already
used as proof for it. Such an idea is never listed as a new or top idea again: if it has new proof (a page not shown for it
before), it appears in a short **Update on past ideas** section at the bottom of the report and the email; otherwise it's
left out. If the memory can't be read, that night's ideas aren't grouped at all (so nothing old is sent as new).

**Job ads, saved for good.** Every job ad the Scout fetches (company, role, link, source, listed pay, date found) is
written to a permanent SQLite database (a Cloudflare Durable Object, free plan, binding `JOBS`) in the same step it's
fetched, before the night's working storage drops any text. Ads already read on an earlier night, or over the night's
reading limit, are saved too. An ad is saved once (its link is the key) and keeps its first-found date; later runs add a
sighting. It's marked **qualified** when Gemini finds a word-for-word quote in it showing paid repetitive work and the Scout
keeps it as proof; once qualified it stays qualified. There is no delete anywhere in the code. If the database can't be
reached, the ads wait in the night's state (and, at the end of a run, in KV `jobs-retry`) and are saved on the next try.
All ads are on the dashboard's **Job ads** page (`/jobs`, newest first, "qualified only" filter); each night's report and
the 6 a.m. email list every ad that night found, qualified or not, with the all-time totals.

**Limits.** At most one Gemini call per step, at most 12 a night (10 reading batches, 1 grouping, 1 competitors). If Gemini refuses (limit, no free quota, retired model,
missing key), the Scout tries the next model where that makes sense, otherwise stops for the night and says why.
About 30 KV writes a night (free: 1,000 a day). Each step's own work measured 1–2 ms of CPU in tests (free: 10 ms).

**Models.** `GEMINI_MODELS` in `wrangler.toml` (default: gemini-flash-lite-latest, gemini-flash-latest, then the 2.5
models). Each night it asks Google which ones the key can use. It never sets up or uses billing.

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
