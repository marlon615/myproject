# ChurchFollow

Done-for-you first-time visitor follow-up for small churches.

Guests scan a QR code on a pew card, enter their first name and phone number, and get:

| When | Text |
| --- | --- |
| Right away (seconds) | Thank-you + welcome pack link (service times, what to expect, pastor's message) |
| Day 3 | Check-in from the pastor |
| Day 7 | Invitation back, with service times (skipped if the guest already returned) |

Pastors get a mobile-friendly dashboard with visitors, replies and returns this month, plus every guest's message status. You (the owner) get a private `/admin` dashboard across all churches.

**Stack:** Next.js 16 (App Router) · Postgres + Drizzle ORM · PayPal Subscriptions · pluggable SMS (Twilio included) · Vercel (hosting + cron).

---

## Pages

| Path | Who | What |
| --- | --- | --- |
| `/` | Public | Landing page with pricing |
| `/signup`, `/login` | Pastors | Create account (starts the 7-day trial) / log in |
| `/dashboard` | Pastor | Stats + guest list, "Mark returned" |
| `/dashboard/guests/[id]` | Pastor | Full text thread with a guest, including replies |
| `/dashboard/share` | Pastor | QR code, guest link, **pew card PDF** (4 per letter page), QR PNG |
| `/dashboard/settings` | Pastor | Edit church name, service times, what to expect, welcome message |
| `/dashboard/billing` | Pastor | Trial status, subscribe ($39/mo with PayPal), cancel |
| `/g/[slug]` | Guests | The QR landing page — no app, no login |
| `/g/[slug]/welcome` | Guests | Welcome pack (linked from the thank-you text) |
| `/admin` | **Owner only** | Revenue (MRR, paying, past due, trials ending in 3 days), visitors & texts per day (30 days), new churches per week (12 weeks), latest failed texts |
| `/admin/churches` | **Owner only** | All churches with search and a status filter (trial, paying, canceled, trial ended) |
| `/admin/churches/[id]` | **Owner only** | One church: visitors, texts sent, replies, failures, plan status, last activity |
| `/admin/failed` | **Owner only** | Failed texts grouped by reason, plus the 100 most recent |

---

## Deploy to Vercel

1. **Push this repo to GitHub** (already done if you're reading this there), then on [vercel.com/new](https://vercel.com/new) import it. Vercel detects Next.js automatically.
2. **Add a database.** In your Vercel project go to **Storage → Create → Neon (Postgres)** and connect it. That sets `DATABASE_URL` for you. (Any Postgres works — Supabase, Railway, etc. Use the *pooled* connection string.)
3. **Set environment variables** under **Settings → Environment Variables** (see [`.env.example`](.env.example)):
   - `SESSION_SECRET`: run `openssl rand -base64 32`
   - `ADMIN_PASSWORD`: your private owner password
   - `CRON_SECRET`: run `openssl rand -hex 24`
   - `APP_URL`: your production URL, e.g. `https://churchfollow.com` (this goes into QR codes, so set it **before** churches print cards)
   - `SMS_PROVIDER`: `console` until Twilio is ready, then `twilio`
4. **Deploy.** The build runs database migrations automatically (`scripts/migrate.mjs`) before `next build`.
5. Visit `/signup` to create a test church, and `/admin` to see the owner dashboard.

### Scheduled texts (cron)

`vercel.json` runs `/api/cron/send` **once a day at 15:00 UTC** (9–10am Central), which sends the day-3 and day-7 texts that are due. Vercel's free Hobby plan only allows daily cron jobs.

- **Thank-you texts don't wait for cron.** They're sent right after the guest submits (using Next.js `after()`), so they arrive within seconds.
- On **Vercel Pro**, you can change the schedule to hourly (`"0 * * * *"`) for more precise timing.
- Or, on any plan, use a free external scheduler (e.g. cron-job.org) to call
  `GET https://YOUR-DOMAIN/api/cron/send` with header `Authorization: Bearer <CRON_SECRET>` every 15 minutes.

---

## Texting: plugging in your provider

The texting layer lives in [`src/lib/sms/`](src/lib/sms):

```
src/lib/sms/
  types.ts    ← the SmsProvider interface every provider implements
  index.ts    ← registry: picks a provider from SMS_PROVIDER
  console.ts  ← dev provider: prints texts to the server log
  twilio.ts   ← Twilio provider  ⟵ PLUG YOUR KEYS IN HERE (via env vars)
```

### Twilio (included)

1. Buy a number in Twilio, and complete **A2P 10DLC registration** (required by US carriers for business texting; Twilio walks you through it). A toll-free number with toll-free verification also works.
2. Set `SMS_PROVIDER=twilio`, `TWILIO_ACCOUNT_SID`, `TWILIO_AUTH_TOKEN`, and either `TWILIO_FROM_NUMBER` or `TWILIO_MESSAGING_SERVICE_SID`.
3. In Twilio, set the number's **"A message comes in"** webhook to `https://YOUR-DOMAIN/api/sms/inbound` (HTTP POST). This is how guest replies show up on the dashboard and how STOP is honored. Requests are verified with Twilio's signature.

### Swapping providers (Telnyx, Plivo, Vonage, …)

1. Create `src/lib/sms/<name>.ts` exporting an object that implements `SmsProvider` (`send(to, body)`, and optionally `parseInbound(req)` for replies).
2. Add it to the `providers` map in `src/lib/sms/index.ts`.
3. Set `SMS_PROVIDER=<name>` plus its keys. Nothing else in the app changes.

Message wording lives in `buildMessage()` in [`src/lib/messaging.ts`](src/lib/messaging.ts). The cadence (3 and 7 days) is set in [`src/lib/config.ts`](src/lib/config.ts).

**Compliance built in:** guests tick a consent box, the first text includes "Reply STOP to opt out", STOP/UNSUBSCRIBE/etc. cancel all pending texts, START re-subscribes, and submitting twice within 12 hours doesn't trigger duplicate texts.

---

## Billing (PayPal Subscriptions)

Churches pay $39/month through PayPal.

1. **Get API keys.** Log in at [developer.paypal.com](https://developer.paypal.com) with your PayPal **Business** account → **Apps & Credentials** → create an app. Copy the **Client ID** and **Secret**. The **Sandbox** tab gives test keys (fake money); the **Live** tab gives real ones.
2. **Create the plan and webhook in one go** (from your computer, after the site is deployed):
   ```bash
   PAYPAL_ENV=sandbox PAYPAL_CLIENT_ID=... PAYPAL_CLIENT_SECRET=... \
   APP_URL=https://your-domain.com npm run paypal:setup
   ```
   It creates a "ChurchFollow" product, a **$39/month** plan, and a webhook pointing at `https://your-domain.com/api/paypal/webhook`, then prints `PAYPAL_PLAN_ID` and `PAYPAL_WEBHOOK_ID`.
3. **In Vercel**, set `PAYPAL_ENV`, `PAYPAL_CLIENT_ID`, `PAYPAL_CLIENT_SECRET`, `PAYPAL_PLAN_ID`, `PAYPAL_WEBHOOK_ID`, then redeploy.
4. **Test with sandbox:** subscribe from `/dashboard/billing` using a sandbox *personal* test account (developer.paypal.com → Testing Tools → Sandbox Accounts).
5. **Go live:** repeat steps 2–3 with your **Live** keys and `PAYPAL_ENV=live`. Sandbox and live plans/webhooks are separate.

How it works:
- Every church gets 7 days free at signup with nothing to enter. If they subscribe mid-trial, PayPal's first charge is scheduled for the day the trial ends.
- After approving in PayPal, the pastor returns to `/dashboard/billing/paypal-return`; the app confirms the subscription with PayPal directly (it doesn't trust the URL) and checks it belongs to that church.
- Webhooks keep it in sync: payments, failed payments ("past due" warning), suspension, cancellation. Each webhook is verified with PayPal's signature-verification API, and the subscription is re-fetched from PayPal so stale or out-of-order events can't set the wrong state.
- Pastors can cancel from the billing page (or from their PayPal account). They keep full access until the end of the month they paid for.
- When a trial or subscription ends unpaid, the guest page keeps collecting visitors but **texts pause** until they subscribe.
- Without PayPal keys, the billing page shows a friendly "payments aren't switched on yet" note.

---

## Local development

```bash
npm install
cp .env.example .env.local    # fill in DATABASE_URL, SESSION_SECRET, ADMIN_PASSWORD, CRON_SECRET
npm run db:migrate
npm run dev                   # http://localhost:3000
```

With `SMS_PROVIDER=console`, texts print in the terminal. Useful commands:

```bash
# Send anything that's due (day-3 / day-7 texts)
curl -H "Authorization: Bearer $CRON_SECRET" localhost:3000/api/cron/send

# Simulate a guest reply (console provider only)
curl -X POST localhost:3000/api/sms/inbound \
  -H "Authorization: Bearer $CRON_SECRET" -H "Content-Type: application/json" \
  -d '{"from":"+14175550182","body":"Thanks, we loved it!"}'
```

After changing `src/db/schema.ts`, run `npm run db:generate` to create a new migration in `drizzle/`.

---

## Data model

- **churches**: profile, login, `slug` (guest URL / QR), trial end, subscription status, PayPal subscription id, paid-through date
- **visitors**: first name, phone (E.164), opted-out flag, `returned_at`, `last_reply_at`
- **messages**: every outbound (`welcome` / `checkin` / `invite`) and inbound (`reply` / `optout` / `optin`) text, with status `scheduled → sending → sent | failed | skipped`

Sends are claimed atomically (`scheduled → sending`), so a text is never sent twice even if cron and the instant send overlap.
