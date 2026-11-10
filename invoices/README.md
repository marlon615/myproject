# Marlon Williams Invoices

An offline delivery-invoice app that installs on a phone's home screen. It's plain static files with no server code, and every invoice stays on the phone (IndexedDB).

- **Live:** https://marlon-invoices.marlon615.workers.dev
- **Customer QR links:** `https://marlon-invoices.marlon615.workers.dev/v#…`. The whole invoice travels inside the link after `#`, which browsers never send to a server.

## What it does

- Writes invoices with store name, address, date (today by default) and a tickable product list. Ticked products get a quantity, a typed unit price and an automatic line total. Unticked products fade out and don't print.
- Adds new products at any time.
- Shows the grand total, then a finger-signature box.
- Makes a QR code fully offline:
  - A **link QR** opens a formatted invoice on the customer's phone.
  - A **text QR** shows the invoice as plain text, for phones with no internet.
- Prints straight to Bluetooth thermal receipt printers (58 mm or 80 mm) over Web Bluetooth with ESC/POS. On iPhone Safari, which has no Web Bluetooth, it shares a narrow PDF to the printer's app instead.
- Has a private owner dashboard, locked with a PIN:
  - Totals for today, the week, the month and all time.
  - Totals by store and by product.
  - Invoice history.
  - Product management.
  - Backup and restore.

## Develop

```bash
node tests/serve.cjs 8790        # local server that mimics the live site (open http://localhost:8790)
npm test                         # every tests/*.test.cjs (Playwright + Node)
npm run deploy                   # stamps the service-worker version, packs public/ into the Worker, deploys
```

Hosting: a tiny Cloudflare Worker (`worker/index.js`) serves the files from `public/`, which `scripts/build-worker.cjs` packs in at deploy time. It applies `public/_headers`, maps `/` to index.html and `/v` to v.html, and uses ETags.

Design assets are regenerated with scripts:
- `scripts/make-wordmark.cjs`: the "Marlon" splash wordmark (Bodoni Moda, SIL OFL 1.1, with the custom flourished M).
- `scripts/make-startup-images.cjs`: dark iPhone launch images.
- `scripts/make-icons.cjs`: app icons.

See `SPEC.md` for the module contracts, the QR payload format and the testing approach.
