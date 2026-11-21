# Marlon Pay

The store's signed cash-payout book: the store-side partner to Marlon. A separate app (its own Cloudflare Worker,
`marlon-pay`) that works on phone, tablet and laptop in the browser and can be added to the home screen.

- **Suppliers:** saved once (name, phone, notes); staff add, edit or archive them.
- **Paying:** tap a supplier → date (today), invoice number, amount → turn the device to the supplier → they sign →
  Done. The record **locks**: the device storage only ever creates records, the server keeps its own fingerprint
  (SHA-256) and refuses any changed copy (logged as a problem), and there is no edit or delete anywhere. The owner can
  add dated **correction notes**. No receipt is handed out: the signed record is the store's proof of payment.
- **From Marlon:** a rep's Marlon invoice page (`/v#…` in marlon-app) has "Paying cash? Record it in Marlon Pay",
  which opens `#/marlon?s=&n=&t=&d=&p=` here with the supplier (added if new), invoice number and total filled in.
  The details travel after "#" (never to a server). No scanning, no AI, no running costs.
- **Offline:** everything saves in IndexedDB first; `js/sync.js` sends new records when there's signal (every 15 s,
  on reconnect, after each save). Records stay on the device until the server confirms them, and after.
- **Owner:** dashboard with today / this week / this month / any dates, totals by supplier and by staff member,
  search (supplier, invoice number, date), each record with its signature, CSV and multi-page PDF exports; staff
  links (add, switch off, give to new staff). Every link locks to the first device that opens it (iPhone: add to Home
  Screen first, like Marlon).
- **Privacy:** every request is checked against the store's own link + device. Signatures are encrypted at rest
  (AES-256-GCM, `ENCRYPTION_KEY` secret; without it sync refuses and records stay on the devices).
- **Maker's console** (in marlon-app): the "Marlon Pay stores" section creates stores, shows counts and problems
  (never names or amounts), a paid/unpaid switch (a label only: unpaid doesn't block) and a switch-off. It reaches
  this Worker through the `PayAdmin` entrypoint (service binding `PAY` in marlon-app; not on the internet).

## Develop and deploy

```bash
npm run build            # stamps the service worker version and packs public/ into the Worker
npm test                 # end to end with both Workers under wrangler dev (Marlon Pay + Marlon)
npm run deploy           # deploy marlon-pay FIRST, then marlon-app (its console binds to PayAdmin)
```
Before the first deploy: `wrangler secret put ENCRYPTION_KEY` (32 random bytes, base64).
