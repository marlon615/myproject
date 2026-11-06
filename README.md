# CallCairn

**Never miss an HVAC call again.**

CallCairn is an AI answering service for US heating & cooling contractors. Contractors forward their missed and after-hours calls to a CallCairn number. The assistant:

1. **Answers** and says up front that it's an automated assistant, not a person (and says so again whenever asked).
2. **Qualifies** the call as an emergency or routine work.
3. **Books** the job into an open arrival window and texts the caller a confirmation.
4. **Texts back** anyone who hangs up or gets cut off, and finishes booking by text.
5. **Alerts** the contractor's on-call phone for every booking, emergency, callback request and safety issue.

Gas, carbon monoxide or smoke? The caller is told to get out and call 911 / the gas company, and the contractor is texted immediately. No booking questions first.

**Stack:** Next.js 16 · Postgres + Drizzle · Twilio (voice + SMS) · Claude (understanding callers) · PayPal Subscriptions (USD) · Vercel.

---

## Pages

| Path | Who | What |
| --- | --- | --- |
| `/` | Public | Landing page: tagline, one-week free pilot, $99/month (USD), US phone number, PayPal |
| `/signup`, `/login` | Contractors | Sign up (starts the 7-day pilot) / log in |
| `/dashboard` | Contractor | This month's calls, text-backs, bookings, emergencies; upcoming jobs; latest callers |
| `/dashboard/bookings` | Contractor | Upcoming and past jobs, cancel |
| `/dashboard/activity` (+ `/[id]`) | Contractor | Every caller, with call transcript and all texts |
| `/dashboard/setup` | Contractor | Get a CallCairn number, call-forwarding steps, calendar link |
| `/dashboard/settings` | Contractor | Company, phones, hours, window length, capacity, emergency policy |
| `/dashboard/billing` | Contractor | Pilot status, subscribe with PayPal, cancel |
| `/admin` | **Owner only** | Revenue (MRR, collected), signups, 30-day calls/texts/bookings, charts |
| `/admin/signups` (+ `/[id]`) | **Owner only** | Every signup, search + status filter; per-contractor detail; set a number by hand |
| `/admin/calls` | **Owner only** | Every call with outcome and transcript |
| `/admin/texts` | **Owner only** | Every text in and out (including alerts and failures) |
| `/admin/bookings` | **Owner only** | Every booking |
| `/admin/payments` | **Owner only** | Every PayPal payment, refund, reversal and failed charge |

### Owner dashboard access

`/admin` is restricted to **foliopayments.ja@gmail.com** (`OWNER_EMAIL` in [`src/lib/config.ts`](src/lib/config.ts)). Signing in needs that email **and** `ADMIN_PASSWORD`. The email is stored in the signed session and re-checked on every request, so changing `OWNER_EMAIL` locks out old sessions. Contractor accounts can't reach `/admin`.

> The app doesn't send email, so it checks the owner email address and password together but can't prove you control the inbox. Keep `ADMIN_PASSWORD` long and private.

---

## How a call works

```
Customer calls contractor's line → no answer / busy / after hours
  → carrier forwards to the contractor's CallCairn number (Twilio)
  → /api/voice/incoming  greeting + "I'm an automated assistant, not a person"
  → /api/voice/turn      one request per thing the caller says (speech or keypad)
  → /api/voice/status    call ended: if not booked, text the caller back
Customer texts back → /api/sms/inbound → same conversation continues by text
```

The flow is fixed in code ([`src/lib/agent/index.ts`](src/lib/agent/index.ts)): issue → emergency or routine → name → address → morning/afternoon → pick a window → booked. Claude only **reads** what the caller said and returns structured facts ([`src/lib/agent/understand.ts`](src/lib/agent/understand.ts)). It never writes what the caller hears, so the disclosure and safety wording are always exactly as written. Without `ANTHROPIC_API_KEY` (or if the model is slow or errors), a keyword fallback is used.

**Automated-assistant disclosure is enforced in code, not left to the model:**
- Every call opens with "I'm an automated assistant, not a person".
- "Are you a real person / a robot?" at any point gets "I'm an automated assistant for <company>, not a person."
- Every text to a caller starts with `<Company> automated assistant:` (added in `sendText`).

**Emergencies:** during business hours, the soonest open window today. Outside hours, an ASAP window if the contractor allows after-hours dispatch (Settings), otherwise the team is alerted to call back. An optional note (e.g. an after-hours fee) is read to the caller.

**Calendar:** bookings are stored in CallCairn and published as a private iCalendar feed (`/api/calendar/<token>.ics`) that contractors subscribe to from Google Calendar, Outlook or Apple Calendar. Google refreshes subscribed calendars every few hours, which is why every booking is also texted to the contractor right away.

**Reminders:** `/api/cron/reminders` runs daily (22:00 UTC) and texts customers about appointments in the next 6–36 hours.

---

## Deploy to Vercel

1. Import this repo at [vercel.com/new](https://vercel.com/new).
2. **Database:** Storage → Create → Neon (Postgres). Use the pooled `DATABASE_URL`. Use a **new database**, not the old ChurchFollow one.
3. **Environment variables** (see [`.env.example`](.env.example)): `SESSION_SECRET`, `ADMIN_PASSWORD` (12+ chars), `CRON_SECRET`, `APP_URL`, `PUBLIC_PHONE_NUMBER`, `ANTHROPIC_API_KEY`, Twilio and PayPal keys.
4. **Deploy.** Migrations run automatically before `next build`.

### Twilio (voice + texting)

1. Create a Twilio account and upgrade it (trial accounts can't call or text unverified numbers).
2. **A2P 10DLC:** register your brand and a campaign (US carriers require it for business texting) and create a **Messaging Service**. Set `TWILIO_MESSAGING_SERVICE_SID`. New CallCairn numbers are added to it automatically. In the service's Integration settings, choose **"Defer to sender's webhook"** so incoming texts reach `/api/sms/inbound`.
3. Set `SMS_PROVIDER=twilio`, `TWILIO_ACCOUNT_SID`, `TWILIO_AUTH_TOKEN`.
4. Contractors click **Get my CallCairn number** on `/dashboard/setup`. That buys a local number (in their area code when available, about $1.15/month on Twilio) and sets its webhooks. To use a number you bought yourself, set its Voice URL to `/api/voice/incoming`, Call Status Changes to `/api/voice/status`, Messaging to `/api/sms/inbound` (all POST), then assign it at `/admin/signups/<id>`.
5. All Twilio webhooks are verified with `X-Twilio-Signature`. In production, requests are refused if `TWILIO_AUTH_TOKEN` is missing.

**Your landing-page number:** buy one more Twilio number for CallCairn itself and put it in `PUBLIC_PHONE_NUMBER`. To make it a live demo, sign up a demo contractor account and assign that number to it. Until you set it, the page shows a fictional (555) 010-0199.

### PayPal (US dollars)

```bash
PAYPAL_ENV=sandbox PAYPAL_CLIENT_ID=... PAYPAL_CLIENT_SECRET=... \
APP_URL=https://your-domain.com npm run paypal:setup
```

Creates the "CallCairn" product, a **$99/month USD** plan, and a webhook to `/api/paypal/webhook` (subscription events plus `PAYMENT.SALE.COMPLETED/REFUNDED/REVERSED`). Copy the printed `PAYPAL_PLAN_ID` and `PAYPAL_WEBHOOK_ID` into Vercel. Repeat with live keys and `PAYPAL_ENV=live` to take real money.

- The pilot is 7 days with nothing to enter. Subscribing mid-pilot schedules the first charge for the day the pilot ends.
- Every webhook is verified with PayPal and the subscription is re-fetched, so out-of-order events can't set the wrong state.
- Each payment, refund, reversal and failed charge is stored once (by PayPal id) and shown at `/admin/payments`.
- When the pilot or subscription ends unpaid, the CallCairn line says the line isn't active and gives the business number, and text replies stop.

To change the price, edit `PRICE_MONTHLY_USD` in `src/lib/config.ts` **and** create a new PayPal plan (`PRICE_MONTHLY_USD=199 npm run paypal:setup`).

---

## Local development

```bash
npm install
cp .env.example .env.local     # DATABASE_URL, SESSION_SECRET, ADMIN_PASSWORD, CRON_SECRET
npm run db:migrate
npm run dev
```

With `SMS_PROVIDER=console`, texts print in the terminal. In development, Twilio signatures aren't required when `TWILIO_AUTH_TOKEN` is unset, so you can simulate calls with curl. Sign up, then give your account a number (`/admin/signups/<id>`, e.g. `(312) 555-0100`):

```bash
# A call: greeting, then each thing the caller says (use the action URL from each response)
curl -X POST localhost:3000/api/voice/incoming -d "CallSid=CA1&From=%2B17735550111&To=%2B13125550100"
curl -X POST "localhost:3000/api/voice/turn?conv=<id>" -d "CallSid=CA1&To=%2B13125550100" \
  --data-urlencode "SpeechResult=My furnace is out and it's freezing"
# Hang up without booking → text-back
curl -X POST localhost:3000/api/voice/status -d "CallSid=CA1&To=%2B13125550100&CallStatus=completed&CallDuration=20"

# A text from a caller (console provider needs the cron secret)
curl -X POST localhost:3000/api/sms/inbound -H "Authorization: Bearer $CRON_SECRET" \
  -H "Content-Type: application/json" -d '{"from":"+17735550111","to":"+13125550100","body":"AC tune-up please"}'
```

After changing `src/db/schema.ts`, run `npm run db:generate` to create a migration in `drizzle/`.

---

## Data model

- **contractors**: each signup: company, owner, login, business/on-call phones, CallCairn number, time zone, hours, window length, capacity, emergency policy, calendar token, pilot/subscription state
- **conversations**: one lead across a call and the texts that follow: step, urgency, hazard, name, address, issue, offered windows, status (open / booked / handoff / closed)
- **calls**: every call, with transcript, duration and outcome
- **texts**: every text in and out (text-backs, assistant replies, confirmations, reminders, contractor alerts, STOP/START)
- **bookings**: jobs with arrival window, urgency, status
- **payments**: every PayPal payment, refund, reversal and failure
- **optouts**: numbers that texted STOP to a contractor's line

## Compliance notes

- **Automated assistant disclosure** on every call and text (see above).
- **Transcription notice** at the start of every call. Calls are not audio-recorded.
- **STOP/START** honored per contractor line. The first text-back says "Reply STOP to opt out". Texts only go to people who called or texted the contractor first, plus reminders for jobs they booked.
- **A2P 10DLC** registration is required before texting at scale in the US.
