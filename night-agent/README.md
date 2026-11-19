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

**Limits.** One Gemini call per step (at most one every 5 minutes; about 18 a night). If Gemini says a limit is reached
(429), or a model has no free grounding, or the key doesn't work, the Scout stops for the night and the report says so
in plain words, showing whatever it had already found. About 50 KV writes a night (free: 1,000 a day). Each step's own
work measured a few milliseconds of CPU in tests (free: 10 ms per run).

**Models.** Each night it asks Google which models your key can use and takes the first of `GEMINI_MODELS` in
`wrangler.toml` (default: gemini-2.5-flash, then gemini-2.5-flash-lite, then gemini-flash-latest). If one has no free
Google Search grounding, it tries the next. It never sets up or uses billing.

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
4. Type: **Secret**. Name: `GEMINI_API_KEY`. Value: paste the key.
5. Tap **Deploy** (or **Save**). No code change or redeploy is needed.
6. Open https://night-agent.marlon615.workers.dev → **Settings**: "API key: saved". Tap **Run one step now** to try a
   step straight away (a separate test report; the real one runs at night).

## Pages

`/` latest report · `/history` every night · `/night/<date>` a past report · `/settings` (key status, run a step now,
phone alert) · `/report/<date>.json` raw data. All behind your passcode (PBKDF2, 5 wrong tries → 15-minute wait;
sessions 30 days). Forgot the passcode: raise `RESET_GENERATION` in `wrangler.toml` and redeploy (reports are kept).

**Phone alert (optional):** Settings → Phone alert → Turn on, then subscribe to the shown topic in the free **ntfy** app.

## Tests

`node tests/scout.test.cjs` — runs whole nights against a stand-in Gemini (tests/stub-gemini.cjs): proof-only results,
scoring, competitors, repeats, the free limit, a model without grounding, missing/wrong key, a night cut short, KV writes
and CPU per step; then the real Worker (wrangler dev) with the cron runs, passcode and report pages in a browser.
Test-only switches (`ALLOW_TEST=1`, `GEMINI_BASE`, `NTFY_BASE`, `/__test/tick`) are never set on the live Worker.
