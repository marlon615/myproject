# Marlon: delivery invoices on any phone (the sellable copy)

An offline delivery-invoice app that installs on a phone's home screen. This copy is the one to sell: it starts
completely blank, and each business sets itself up on its own phone.

- **Live:** https://marlon-app.marlon615.workers.dev
- **Maker's console (only for you):** https://marlon-app.marlon615.workers.dev/console
- **Customer QR links:** `…/v#…`. The whole invoice travels inside the link after `#`, which browsers never send to
  a server.

**Buyers get in only through a personal link** that the maker creates in the console (`/?k=<key>`). Each link
works on up to the number of devices the buyer paid for: the first phones to open it take the places, and any other
phone is blocked and told to contact the maker. Opening the plain address without a link is blocked too.

- After the first activation (which needs the internet once), the app works offline.
- When online, the app checks that its phone is still switched on.
- On iPhone, the link asks to "Add to Home Screen" first. Safari and a home-screen app keep separate storage, so one
  iPhone would otherwise use two places. The personal link travels with the home-screen app through the manifest's
  `start_url`.

A business's details, products, customers and invoices are kept only on its own phone (IndexedDB, per browser), so
nobody ever sees anyone else's data. The owner's own app
(`marlon-invoices.marlon615.workers.dev`, folder `../invoices`) is a separate app and is not touched by this copy.

## What a business gets

- **First open:** the "Marlon" splash, then a setup screen. The business types its company name, address and phone,
  and adds its products, each with a usual price and how it's sold (each, per dozen, per bag, per lb). The company
  name then shows at the top of the app.
- **Invoices:** store, address, date and a tickable product list. Ticking a product fills in its usual price, which can
  be changed on any invoice. Line totals and the grand total add themselves up. Then the customer signs with a finger.
- **Voice entry:** say the store, the address and the products ("two dozen mango juice, fifty pounds sweet potato at
  one twenty"). Products are matched by sound against the business's own list. A review screen shows what the phone
  heard, highlights anything unclear and fills in usual prices where none was said.
- **Signing:** "Thank you, <store>" is written while the customer signs. Then Done shows a checkmark with a gentle tap.
- **QR code** for the customer (a link, or plain text for phones with no internet). Also PDF, picture, and Bluetooth
  thermal printing (58 or 80 mm, ESC/POS). Receipts carry the business's name, address and phone at the top and end
  with "Thank you, <store>".
- **Owner dashboard,** locked with a PIN:
  - totals, unpaid invoices with due dates, and history;
  - the private payment page (Cash, 7 days, 14 days);
  - "Your business in numbers";
  - Settings: business details, products and prices, backup and restore, printer, anonymous counts on or off.
- **Offline:** works with no internet after the first open. Updates install by themselves.

## Send for signature (buyer in another town)

For online sellers (Instagram, WhatsApp, TikTok) whose buyer can't sign on the seller's phone.

- **Seller:** makes the invoice as usual (buyer name, items, quantity, unit price), then taps **Send for signature**.
  The server saves a frozen copy and makes a secret link (`/s/<64 hex characters>`, 256-bit random), and the phone's
  share sheet opens (WhatsApp, Instagram, email, text). Where there's no share sheet, the link is copied instead.
- **Buyer:** opens the link on their own phone, no app and no login. They see the whole invoice, read-only, and can
  only type their name, sign, and tap **Sign and confirm**. Then: a green checkmark, "Signed by … on [date, time]",
  and **Download PDF copy**. Opening the link again only shows the signed copy.
- **The lock is on the server:** the buyer's page is drawn from the frozen copy; signing accepts only a name, a
  signature and the copy's fingerprint (SHA-256), and refuses anything else or any other version. Nothing can change a
  sent copy; a signed one can't be sent again or cancelled.
- **Back to the seller:** the app checks every 20 seconds while it's open (and whenever it's opened). A signed copy
  replaces the invoice on the phone with exactly what was signed, with a message, and the invoice is locked for good
  (even against changes saved straight into the phone's storage). While a link is waiting, changing the invoice first
  cancels the link ("Cancel and edit"). The phone can only notify while the app is open or running in the background.
- **Statuses:** Sent, Opened, Signed (and Expired) on the invoice and in the dashboard history. Unsigned links expire
  after 7 days; the seller can send a new one, and the old link then says a newer one was sent.
- **Privacy:** only a hash of each link is stored; the invoice, the buyer's name and their signature are encrypted
  (AES-256-GCM) with the `ENCRYPTION_KEY` secret (`wrangler secret put ENCRYPTION_KEY`; without it, sending is switched
  off). A seller's phone can only see the links it sent itself. Limit: 200 links per phone per day.

## Team version

When creating a buyer in the console, choose **Solo** (one business, as above) or **Team** (a company with one boss
and several sales reps). A team gets two links:
- **Rep links** (`/?k=…`), one per rep. Each locks to the first phone that opens it, so passing it on does nothing.
  "Copy all rep links + boss link" puts them in one numbered message. "Replace link" kills a rep's link (and
  switches off the phone on it) and makes a new one. Teams made before personal rep links keep their shared rep
  link. Reps use Marlon like a solo business and type their own name at setup. Every invoice is saved on the phone
  first. Whenever there's internet, it's sent to the boss automatically (new and changed invoices within about
  10 seconds). With no signal it waits and goes as soon as there's a connection. The phone also asks once a minute
  whether the boss marked any of its invoices paid.
- **Boss link** (`/boss?b=…`): the boss's private dashboard, on up to 2 boss phones (on iPhone the browser and the
  Home Screen icon count separately). The first visit sets the boss's own passcode (5 wrong tries per 15 minutes).
  It shows:
  - every invoice from every rep, with the rep, customer, products, total, and paid or not paid;
  - **Reps**: "Add rep" names one of the rep places the company paid for and shows its link to copy or share. It
    can never go beyond the paid number. "Switch off" a rep (e.g. they left): their phone stops working, their
    invoices stay under their name, and the same link is freed. "Give to new rep" hands it on with a new name, and
    the old phone can never come back on it;
  - **Mark paid**, one of the boss's only two changes: he ticks a rep's unpaid invoice as paid. It shows as paid
    on the rep's phone too, and a rep's phone can never undo it. The boss can't write or edit invoices;
  - totals for today, this week (Monday to Sunday) and this month, per rep and for the whole company;
  - when offline, the last data it loaded.

In the console a team shows its boss phones and each rep phone by name. Switch off one rep (that phone is blocked
and can't send) or the whole company (the boss and every rep are blocked). Team invoices are kept on the server,
in the same Durable Object; solo businesses still send nothing.

## The maker's console

**Buyers:**
- **New buyer link** asks for the buyer's name, the number of devices (1, 2, 3 or another number) and the amount
  paid. It can't be created until all three are filled in.
- The console then shows the link to send, with a Copy button.
- Every buyer is listed with their name, devices in use, amount paid, date and each phone (type, since when, last
  seen).
- You can switch off one phone, which frees its place, or a whole buyer, and switch them back on.
- **Money collected** adds up every buyer's amount.
- "What blocked phones are told" sets the contact shown on blocked phones.

**Limits:**
- A switched-off phone is blocked the next time it opens with internet. A phone that stays offline keeps working
  until then.
- A new phone, or a browser whose data was cleared, counts as a new device. Switch off the old one to free its place.
- The server never activates more phones than a link allows. Someone technical who copies the app's files could get
  around the lock on their own phone.

**Anonymous counts:**

`/console` is for the maker only. The first visit sets its passcode: **open it and set the passcode before sending
the link to anyone.** After that only that passcode opens it. Five wrong tries in 15 minutes and it waits.

The console shows:
- businesses set up;
- businesses using it today, this week and this month;
- invoices made;
- voice entries;
- receipts printed or shared;
- two 30-day charts.

These are counts only. Each phone sends a random id plus "what happened, which day" (`open`, `setup`, `invoice`,
`voice`, `print`, `pdf`, `picture`). It never sends names, customers, products, prices or amounts. Nothing is sent
before setup is finished, and a business can turn counting off in Settings. A business using two phones counts as
two.

**Forgot the passcode, or someone opened /console first?** Raise `CONSOLE_GENERATION` in `wrangler.toml` and deploy.
The passcode can then be set again, and every count is kept.

## Develop

```bash
node tests/serve.cjs 8790        # local server that mimics the live site, with a stand-in for /api (open http://localhost:8790)
npm test                         # every tests/*.test.cjs (Playwright + Node; worker.test.cjs runs the real Worker locally)
npm run deploy                   # stamps the service-worker version, packs public/ into the Worker, deploys
```

Hosting is a Cloudflare Worker (`worker/index.js`):
- It serves the files from `public/`, which `scripts/build-worker.cjs` packs in at deploy time.
- It applies `public/_headers`, maps `/` to index.html, `/v` to v.html and `/console` to console.html, and uses ETags.
- One Durable Object (SQLite), `Stats`, keeps the console's counts and passcode.

The tests use a made-up business (`tests/fixture.cjs`), because the app itself ships with no products.
