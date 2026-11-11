# Future Self

A phone app (installable web app) where you have a daily voice conversation with your future self, five years from now, already successful. Future you gives advice, calls you out when you slack, and celebrates your wins.

## What's in it

| Screen | What it does |
|---|---|
| **Set-up** | Name, goals, money target, daily habits. Saved on the phone. |
| **Talk** | One big glowing button. Hold it and speak; future you answers in text and out loud. "Type instead" works everywhere. |
| **Check-in** | Future you asks how yesterday went and what today's one move is. Tap "I did it" when it's done. Tracks your streak. |
| **Wins** | Every win is saved and celebrated with an animation. Wins you mention while talking are picked up automatically. |
| **Settings** | Switch between **Dark & cinematic** (default) and **Bright & motivating**, pick a voice and speed, edit set-up, erase data. |
| **Owner dashboard** (`/owner`) | Private. Total users, sign-ups, chats, check-ins and wins, today and for the last 14 days. Password-protected. Not linked from the app. |

## Privacy and security

- **Personal data stays on the phone.** Goals, conversations and wins are stored in the phone's browser storage. They go to the server only to write a reply, and the server doesn't save them.
- **The server stores only anonymous counts:** a random ID per phone plus "a chat / check-in / win happened at this time". That's what the owner dashboard reads.
- **Keys are server-only.** `ANTHROPIC_API_KEY`, `SESSION_SECRET`, `OWNER_PASSWORD` and `DATABASE_URL` never reach the phone.
- Owner sign-in uses a constant-time password check, allows 5 tries per 15 minutes, and sets a signed, http-only cookie limited to `/owner`. Changing `OWNER_PASSWORD` signs out every old session.
- The API only accepts requests from the app's own pages. Each phone gets 8 replies a minute and `DAILY_CHAT_LIMIT` (default 60) a day, which protects your AI bill.
- Strict security headers (CSP, no framing, microphone limited to this site). `/owner` and `/api` are excluded from search engines and never cached by the offline worker.

## Put it online (Vercel, about 10 minutes)

This app is in the `future-self/` folder of the repo, separate from ChurchFollow, so it gets its **own** Vercel project.

1. **Database (for the owner dashboard):** create a free Postgres at [neon.tech](https://neon.tech) and copy the **pooled** connection string. Tables are created automatically on first use.
2. **AI key:** at [console.anthropic.com](https://console.anthropic.com) → API Keys, create a key.
3. **Vercel:** vercel.com → Add New → Project → import this repo → set **Root Directory** to `future-self` → leave the framework as Next.js.
4. **Environment variables** (same screen, before deploying):

   | Name | Value |
   |---|---|
   | `ANTHROPIC_API_KEY` | your key from step 2 |
   | `SESSION_SECRET` | a random string, 32+ characters (`openssl rand -base64 32`) |
   | `OWNER_PASSWORD` | your private dashboard password, 12+ characters |
   | `DATABASE_URL` | the Neon string from step 1 |
   | `APP_TIMEZONE` *(optional)* | default `America/Chicago` |
   | `DAILY_CHAT_LIMIT` *(optional)* | default `60` |
   | `FUTURE_SELF_MODEL` *(optional)* | default `claude-opus-5-5` |

5. **Deploy.** Vercel gives you a link like `https://future-self-xxxx.vercel.app`.
6. **On your phone:** open the link in **Safari** (iPhone) or **Chrome** (Android) → Share → **Add to Home Screen**. It opens full screen with its own icon.
7. **Your dashboard:** `https://YOUR-LINK/owner` → sign in with `OWNER_PASSWORD`.

## Run it on your computer

```bash
cd future-self
npm install
cp .env.example .env.local   # fill in the values
npm run dev                  # http://localhost:3000
```

The microphone needs HTTPS (or localhost), so test voice on the deployed link.

## Voice notes

- Listening uses the phone browser's built-in speech recognition, and speaking uses the phone's built-in voices. Both are free and need no keys.
- iPhone: speech recognition works in Safari. If it isn't available in the home-screen app on an older iOS version, the app switches to typing automatically.
- For a nicer voice on iPhone, go to Settings → Accessibility → Spoken Content → Voices, download an "Enhanced" or "Premium" voice, then pick it in Future Self's settings.

## Changing the icon

Edit `public/icons/icon.svg`, then run `node scripts/make-icons.mjs` (needs Playwright) to regenerate the PNGs.

## Later (not built yet)

- A cloned voice from a short recording of you
- Shareable clips of chats
- App Store release and subscriptions
