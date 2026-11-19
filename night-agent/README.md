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

1. **Fetch** (no Gemini) — official public sources only:
   - **Hacker News**, through the official Algolia HN Search API: 10 searches a night (30 results each) for comments and
     posts from the last 90 days, rotating through 30 phrases ("I wish there was…", "is there a tool…", "manual data
     entry", "we still use spreadsheets", "copy and paste between", "chasing invoices"…).
   - **Remotive** public jobs API: 2 searches a night (they ask for at most ~4 requests a day), US/anywhere jobs only.
   - **Jobicy** public jobs API: 2 tag searches a night (data entry, customer support, bookkeeping, billing…), US jobs only
     (they ask for at most about 1 request an hour). Pay comes from the job board's own salary field.
   - **Himalayas** public jobs API: 2 searches a night (data entry, administrative assistant, dispatcher…), only titles
     that look like repetitive work, US/anywhere only.
   - **We Work Remotely** public RSS feeds: 4 a night (customer support, sales & marketing, management & finance, all
     other), only titles that look like repetitive work (data entry, customer support, scheduling, billing, dispatch,
     order entry, assistants…), US/anywhere only.
   - **Reddit**: its robots.txt is checked every night. Today it disallows all automated access (and Reddit's API terms
     require a registered app), so Reddit is skipped and the report says so. If you want Reddit, register a free official
     Reddit app and I can add it the approved way.
   At most 300 texts a night. Texts already read on an earlier night aren't read again.
2. **Read** — Gemini (no search) reads the texts in batches of ~30 and picks complaints, wishes for software, and job
   ads for repetitive work, each with a quote. **A quote is kept only if it appears word for word in the fetched text**;
   the page it came from is the proof. "What they pay" is kept only if those words are in the text too (job ads: the pay
   the job board lists). "Who" is what the source itself says (e.g. "Hacker News comment", or the company and job title).
3. **Group and score** — problems scored 1–10 (people, already paying, anger, build speed); total = 30/30/20/20.
   Job ads count as proof the company already pays for the work. Ideas from earlier reports are left out.
4. **Competitors** — for the top 5, Hacker News posts about tools for that problem are fetched, and Gemini names the
   tools they mention, again only with a word-for-word quote. A price is shown only if it's written in that post.
5. **Report** — usually done by about 3:00 a.m.; at 4:55 a.m. at the latest. Up to 10 leads (public posts and job ads,
   never contacted). Ideas and leads are saved for good.

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
