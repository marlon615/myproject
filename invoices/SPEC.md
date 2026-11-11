# Marlon Williams Invoices: build spec

An installable, fully offline phone web app (a PWA) for writing delivery invoices. There is no server code: it's static files on Cloudflare. All data stays on the phone, in IndexedDB.

## What the owner asked for (verbatim requirements)

1. Mobile-first PWA that works **fully offline** and **installs on a phone home screen**.
2. Header shows **"Marlon Williams"**.
3. Each invoice has a **store name**, a **store address**, and a **date** that fills in today's date automatically and can be changed.
4. Product list, in this order: Beetroot Juice, Cucumber Juice, Pumpkin Punch, Green Juice, Mini Bammy, Large Bammy, Juicify Drink Grape, Juicify Drink Fruit Punch, Hot Pepper, Shredded Callaloo, Lemons, Limes, Grapefruit, Okra. **New products can be added at any time.**
5. Each product has a **tick box per invoice**:
   - A ticked product shows its **quantity**, a **unit price the owner types**, and an **automatic line total**.
   - An unticked product **fades out but stays in the list**, and is **not printed**.
6. A **grand total** at the bottom, then a **finger-signature box** for the customer.
7. At the bottom, a **QR code generated fully offline** that encodes the **complete invoice details**. A customer scans it with their phone camera and sees the invoice. **The owner's phone needs no internet.**
8. **Every invoice is saved on the phone.**
9. **Prints to a Bluetooth thermal receipt printer** on narrow paper, with **sharing a PDF as the backup**.
10. A **private owner dashboard** with **invoice history and totals**.

The owner most likely uses an **iPhone**. Facts that shape the design:
- iOS Safari has no Web Bluetooth. On iPhone, Print explains this and offers Share PDF instead.
- Direct printing works in Chrome on Android, and on iPhone in the free **Bluefy** browser.
- Customers can use any phone camera (iPhone or Android).

## Hard constraints

- **Offline.** No CDNs, web fonts or network calls of any kind. Everything ships in `public/` and the service worker precaches it. Use system fonts only.
- **No frameworks and no build step.** Plain HTML, CSS and native ES modules (`<script type="module">`). The only vendored library is `public/js/vendor/qrcode.js` (qrcode-generator 1.4.4, MIT). Import it with `import qrcode from "./vendor/qrcode.js"`.
- **Browsers:** iOS Safari 16+ (including when installed to the home screen) and Chrome on Android 110+ come first. Desktop Chrome and Firefox must also work.
- **CSP** (`public/_headers`) is `script-src 'self'`. That means no inline scripts, no inline event handlers and no `eval`. Inline `style=""` attributes are allowed.
- **Security:** never put user or QR data into `innerHTML`. Build the DOM with `h()` from `util.js`, or set `textContent`.
- **Text:** every user-facing string is plain English and friendly, with no jargon.
- **Phone first.** It must look right at 360 to 430 px wide with no sideways scrolling, and fill wider screens with a centered column of at most 560 px. Touch targets are at least 44 px (`--tap: 48px`). Inputs use 16 px or larger text so iOS doesn't zoom. Respect `env(safe-area-inset-*)`.
- **Money** is shown as `$1,250.00` (Jamaican dollars, written with a plain `$`). Do all money maths through `util.js`, which works in whole cents.

## Files and who owns them

Everything is under `/home/user/myproject/invoices/`.

```
public/
  index.html            A  app shell: invoice screen markup + <section id="dashboard"> mount point
  v.html                C  customer invoice viewer (opened from the QR code link)
  404.html              C  friendly not-found page
  sw.js                 C  service worker (precache everything, offline, update flow)
  manifest.webmanifest  C
  _headers              (exists — CSP etc. Do not loosen without reporting)
  icons/*               C  icon-192.png, icon-512.png, icon-maskable-512.png, apple-touch-icon.png (180), favicon-32.png, icon.svg
  favicon.ico           C
  css/base.css          SHARED (exists) design tokens + base controls — do not edit; report needs
  css/app.css           A  invoice screen styles
  css/dashboard.css     B  dashboard styles
  css/view.css          C  viewer styles (+ print styles)
  css/splash.css        LEAD (exists) startup splash styles — precache it
  js/splash.js          LEAD (exists) startup splash timing (classic deferred script) — precache it
  splash/*.png          LEAD  dark iOS launch images (apple-touch-startup-image) — NOT precached (iOS fetches them at install)
  js/util.js            SHARED (exists) money/dates/ids/text/DOM helpers — do not edit; report needs
  js/db.js              SHARED (exists) IndexedDB storage — do not edit; report needs
  js/ui.js              SHARED (exists) toast(), choiceSheet(), confirmSheet(), alertSheet()
  js/app.js             A  invoice screen controller, routing, install prompt, update banner
  js/signature.js       A  finger signature pad
  js/dashboard.js       B  private owner dashboard (PIN, totals, history, settings)
  js/qr.js              C  QR wrapper (make, draw, raster)
  js/codec.js           C  invoice ⇄ QR payload (link and plain text)
  js/view.js            C  viewer logic
  js/receipt.js         D  receipt layout model + canvas renderer
  js/pdf.js             D  minimal PDF writer (canvas JPEG → single-page PDF)
  js/share.js           D  Share PDF / Share picture (Web Share API + download fallback)
  js/printer.js         D  Web Bluetooth + ESC/POS thermal printing
  js/vendor/qrcode.js   (exists) qrcode-generator, ES module default export
tests/
  serve.cjs             (exists) local static server that mimics Cloudflare: node tests/serve.cjs <port>
  <area>.test.cjs       each owner writes their own tests; tests/output/ is git-ignored scratch for screenshots
scripts/
  stamp-sw.cjs          C  writes a content hash into sw.js VERSION before deploy
tests/harness/          each builder may add test-only pages here (prefix files with their area: app-*, dash-*, qr-*, print-*)
```

**Only edit files you own.** If you need something changed in a file you don't own, put it in your report and don't edit that file. **Don't add new files to `public/`** that aren't in this list; the service worker precache list depends on it. If you truly need one, report it.

## Shared modules (already written; read them before you start)

- `js/util.js` contains:
  - `SELLER`, `DEFAULT_PRODUCTS` and `defaultProductId(i)` (gives `p01` to `p14`), plus `uid(prefix)`.
  - Money: `toCents`, `round2`, `parseAmount(v)` (returns a number or `null`), `lineTotal(qty, price)`, `sumTotals(items)`, `money(n)` (gives `$1,250.00`), `plainMoney`, `qtyText`, `priceInputText`.
  - Invoices and dates: `invoiceNo(n)` (gives `0007`), `withTotals(inv)`, `itemsMissingPrice(inv)`, `todayISO()`, `parseISODate`, `prettyDate(iso)` (gives `10 Nov 2026`), `monthLabel("2026-11")`, `weekStartISO(iso)`.
  - Text and DOM: `asciiFold(s)` (printer-safe ASCII), `tidy`, `storeKey`, `fileSafe`, `h(tag, props, ...children)`, `debounce(fn, ms)` (with `.flush()` and `.cancel()`), `loadImage(src)`.
- `js/db.js` contains:
  - `init()`: call once at startup. It seeds the products and asks for persistent storage.
  - `products`: `.all({includeHidden})`, `.get`, `.put`, `.add(name)`, `.rename`, `.hide`, `.unhide`, `.move(id, ±1)`, `.rememberPrices({productId: price})`.
  - `invoices`: `.all()` (newest first), `.get`, `.put(inv)`, `.remove`, `.peekNextNumber()`, `.knownStores()`. `put()` recomputes totals and claims the next number on first save.
  - `settings`: `.get(key, fallback)`, `.set`, `.remove`, `.all()`.
  - Also `exportBackup()`, `importBackup(data)`, `storageStatus()`, `requestPersistence()` and `eraseEverything()`.
- `js/ui.js` contains `toast(msg)`, `choiceSheet({title, message, choices, input})`, `confirmSheet({...})` and `alertSheet({...})`.

### Settings keys

| key | value | owner |
|---|---|---|
| `nextNumber` | next invoice number (int) | db.js |
| `currentId` | id of the invoice open on the main screen | A |
| `paper` | `58` or `80` (mm), default `58` | B sets it, D reads it |
| `printer` | `{ id, name }` of the last Bluetooth printer | D |
| `pin` | `{ salt, hash, iter }` (base64; PBKDF2-SHA-256) | B |
| `pinResetAt` | ISO time of the last "forgot PIN" reset | B |
| `qrMode` | `"link"` or `"text"` (last QR mode picked on the main screen) | A |

## Data model

The invoice is stored and also passed to every consumer, both saved and unsaved:

```js
{
  id: "inv_…",              // set on first save (db.js) — may be missing on a brand-new draft
  number: 7,                 // claimed on first save; drafts show invoices.peekNextNumber()
  seller: "Marlon Williams",
  store: "Rose Hall Grocery",
  address: "12 Main St\nMontego Bay",   // may contain newlines
  date: "2026-11-10",        // local calendar date
  items: [                   // ONLY ticked products, in product-list order
    { productId: "p01", name: "Beetroot Juice", qty: 12, price: 350, total: 4200 },
    { productId: "c_x1y2", name: "Coconut Water", qty: 6, price: null, total: 0 }   // price not typed yet
  ],
  total: 4200,               // sum of item totals
  signature: "data:image/png;base64,…" | null,   // black strokes on transparent, ~3:1 aspect
  signedAt: "2026-11-10T19:45:00.000Z" | null,
  createdAt, updatedAt       // ISO
}
```

Consumers must call `withTotals(inv)` before using totals, and must never trust `total` fields blindly. An item's `name` is a snapshot, so old invoices keep their names even if a product is later renamed or removed.

## Module contracts (exact exports)

### C: `js/qr.js`
```js
// Smallest QR version that fits; byte mode, UTF-8. ecc: "L"|"M"|"Q"|"H". Throws Error("QR_TOO_LONG") past version 40.
export function makeQr(text, { ecc = "M" } = {}) // → { version, size /*modules per side*/, isDark(row, col) }
// Draws on a canvas, resizing it to (size + 2*margin) * scale pixels. Quiet zone = margin modules.
export function drawQr(canvas, qr, { scale = 4, margin = 4, dark = "#000", light = "#fff" } = {})
// For screens: a new <canvas> that displays at ~px CSS pixels, crisp on retina (backing store × devicePixelRatio,
// integer module size). Sets canvas.style.width/height. Caller sets role/aria-label.
export function qrCanvas(text, { px = 240, margin = 4, ecc = "M" } = {}) // → HTMLCanvasElement
// 1-bit raster for ESC/POS: width rounded UP to a multiple of 8, 1 = black, MSB-first, row-major.
export function qrRaster(qr, { scale = 4, margin = 4 } = {}) // → { width, height, bytesPerRow, data: Uint8Array }
```

### C: `js/codec.js` (link payload v1, precise grammar)
```js
export const PAYLOAD_VERSION = "1";
export function invoiceToUrl(inv, origin = location.origin) // → `${origin}/v#` + payload
export function parseInvoiceHash(hash) // "#1~…" or "1~…" → view model | null
//   view model: { v: 1, seller, number, date /*YYYY-MM-DD*/, store, address, items: [{ name, qty, price /*null if missing*/, total }], total, computedTotal, signed }
export function invoiceToText(inv) // plain-text invoice for the "text-only" QR
```
The payload is built like this:
```
payload = "1" "~" seller "~" number "~" date8 "~" store "~" address "~" items "~" total "~" flags
date8   = YYYYMMDD
items   = "" | item *( "*" item )
item    = ( "@" index | text ) "," qty "," price
          ; "@index" (0-based index into DEFAULT_PRODUCTS) ONLY when name === DEFAULT_PRODUCTS[index] exactly
qty, price, total = shortest decimal form ("12", "1.5", "13950.5"); price "" when missing
flags   = "" | "s"      ; "s" = signed by customer
text    = encodeURIComponent(s), then "%20"→"+", then escape  ~ * ! ' ( )  as %7E %2A %21 %27 %28 %29
decode  = split on "~", "*", "," FIRST, then "+"→" " and decodeURIComponent (bad escapes → null result)
```
Example: `https://marlon-invoices.marlon615.workers.dev/v#1~Marlon+Williams~7~20261110~Rose+Hall+Grocery~12+Main+St%0AMontego+Bay~@0,12,350*@4,24,150*Coconut+Water,6,~7800~s`

Parsing must be strict and safe:
- Reject an unknown version.
- Cap lengths: text fields at 300 characters and at most 300 items.
- Validate numbers.
- Never throw on a malformed hash; return null.

`invoiceToText(inv)` produces this (unticked products are already absent from `items`):
```
INVOICE No. 0007
Marlon Williams
Date: 10 Nov 2026
Store: Rose Hall Grocery
Address: 12 Main St, Montego Bay
--------------------
Beetroot Juice
  12 x $350.00 = $4,200.00
Coconut Water
  6 x (no price) = $0.00
--------------------
TOTAL: $4,200.00
2 items · Signed by customer: Yes
```

Capacity: a worst-case invoice must still fit, and each mode has a test. The worst case is all 14 products plus 4 custom products with 25-character names, a 60-character store name and a 120-character address.
- The **link** QR at ECC "M" must come out at version 25 or lower.
- The **text** QR at ECC "L" must stay within version 40, ideally 30 or lower.

### C: viewer (`v.html`, `js/view.js`, `css/view.css`)
- It reads `location.hash` and also handles `hashchange`. The page renders a clean, formatted invoice:
  - "Marlon Williams" as the seller heading, and "Invoice No. 0007 · 10 Nov 2026".
  - The store and address.
  - Items, each with qty × price and its line total.
  - The grand total.
  - "Signed by the customer ✓" or "Not signed".
- If the decoded line totals don't add up to `total`, show the encoded total plus a gentle note.
- Two buttons (owner request):
  - **"Save PDF"** makes the branded receipt PDF (80 mm) on the customer's phone and shares or downloads it. It stores nothing on their phone.
  - **"Print"** calls `window.print()`, with print CSS for a clean page.
- If the hash is missing or invalid, show a friendly message: "This link doesn't contain an invoice. Ask for a new QR code."
- Don't link the manifest and don't register the service worker, so customers aren't prompted to install the owner's app. Import only `codec.js`, `util.js` and the CSS.

### C: PWA shell
- `manifest.webmanifest`:
  - name "Marlon Williams Invoices", short_name "Invoices", id "/", start_url "/", scope "/".
  - display "standalone", orientation "portrait".
  - background_color "#0f1411" (the dark startup splash colour, so Android's launch screen hands over seamlessly; the splash is always dark), theme_color "#17633f".
  - Icons 192, 512 and maskable 512, with purpose set correctly.
- `sw.js`:
  - Precache every file in `public/` that the app uses (the list above). On Cloudflare, `/index.html` redirects to `/` and `/v.html` to `/v`, so precache the **URLs `/` and `/v`**, not the `.html` names.
  - Navigation requests: serve the cached `/` for `/` and any unknown app path, serve the cached `/v` for `/v` (ignore the hash and search), and fall back to the network.
  - Other same-origin GETs: cache-first, then network, adding to the cache.
  - Versioned cache name `const VERSION = "…"`. Delete old caches on activate.
  - **Update flow** (revised):
    - A new version installs and takes over at once (`skipWaiting()` after precaching), so the next launch is always the newest.
    - If the open app is still on the splash, it reloads into the new version without showing the splash again (sessionStorage `skipSplashOnce`).
    - Mid-work, it shows "A new version is ready. Refresh", which saves first, then reloads.
  - Never cache non-GET requests or other origins.
- `scripts/stamp-sw.cjs`: hash all precached files and write the result into `VERSION` in sw.js. It must be idempotent. `npm run deploy` will call it first; the integrator wires that up.
- Icons:
  - Design: a deep green (#17633f) rounded square with a cream receipt shape, a zig-zag bottom edge and a few text lines. A small "MW" monogram is optional.
  - The maskable version keeps the glyph inside the 80% safe zone.
  - Render PNGs from SVG with Playwright Chromium. `apple-touch-icon.png` is 180×180 and opaque.

### D: `js/receipt.js`
```js
// Layout model shared by the canvas renderer and the ESC/POS builder (cols: 32 for 58mm, 48 for 80mm).
export function receiptModel(inv) // → { seller, number, dateText, store, address, items:[{name, qtyText, priceText, totalText, hasPrice}], totalText, itemCount, signed, signature, qrUrl }
// Renders the paper receipt as a canvas: paper 58|80 → base width 384|576 dots, × scale (2 for PDF/picture).
export async function renderReceiptCanvas(inv, { paper = 58, scale = 2, includeQr = true } = {}) // → HTMLCanvasElement
```
Receipt layout (the same content on paper, PDF and picture; only ticked items appear):
```
        MARLON WILLIAMS            (bold, large, centered)
        Delivery invoice           (centered)
No. 0007                10 Nov 2026
Store: Rose Hall Grocery           (wrapped)
12 Main St, Montego Bay            (address, wrapped, newlines kept)
--------------------------------
Beetroot Juice
  12 x $350.00            $4,200.00
Coconut Water
  6 x (no price)              $0.00
--------------------------------
TOTAL                     $4,200.00   (bold, bigger)
2 items
Customer signature:
[signature image, or "Not signed"]
[QR code of invoiceToUrl(inv)]       (centered; ≥ 3 dots per module at 203 dpi)
Scan to see this invoice on your phone
```

### D: `js/pdf.js`
```js
// JPEG from the canvas embedded with /DCTDecode in a valid single-page PDF 1.4 whose page is widthMm wide
// and as tall as the canvas aspect requires. Correct xref offsets. Info: Title, Author "Marlon Williams".
export async function canvasToPdfBlob(canvas, { widthMm = 58, title = "Invoice" } = {}) // → Blob (application/pdf)
```

### D: `js/share.js`
```js
// Builds the receipt (settings.paper) → PDF → navigator.share({ files:[File], title }) when canShare(files);
// otherwise downloads it. File name: Invoice-0007-Rose-Hall-Grocery.pdf. Handles AbortError quietly.
// Shows toasts for problems. Must be callable straight from a click handler.
export async function shareInvoicePdf(inv) // → "shared" | "downloaded" | "cancelled" | "failed"
export async function shareInvoiceImage(inv) // same, PNG picture (some printer apps prefer pictures)
```

### D: `js/printer.js`
```js
export function bluetoothSupported() // → boolean (navigator.bluetooth present and available)
// Prints the invoice. MUST be called directly from a click/tap handler (Web Bluetooth needs the gesture):
// call requestDevice/getDevices before any other slow await. Reuses the remembered printer when possible.
// Owns its UI: progress toast ("Printing…"), errors in plain words, and — when Bluetooth isn't available
// (iPhone Safari) — a sheet explaining that and offering "Share PDF instead" (calls shareInvoicePdf) and a
// line about printer apps / the free Bluefy browser.
export async function printInvoice(inv) // → { ok: boolean, reason?: "unsupported"|"cancelled"|"error", message? }
export function buildEscPos(model, { paper = 58, signatureRaster = null, qrRaster = null } = {}) // → Uint8Array (pure, testable)
export async function forgetPrinter()
export async function savedPrinterName() // → string | null
```
ESC/POS:
- Commands used:
  - `ESC @` to initialise, `ESC t 0` for code page PC437, `ESC a n` to align, `ESC E n` for bold.
  - `GS ! n` for size; the total uses double height only, so columns stay 32 or 48.
  - `ESC d n` to feed, and `GS V 66 0` to cut at the end (harmless without a cutter).
- All text goes through `asciiFold()` and is wrapped to the column count.
- Images (signature and QR) use `GS v 0 0 xL xH yL yH …` in bands of 64 rows or fewer. The width is at most 384 dots for 58 mm or 576 for 80 mm.
- The signature is converted from its PNG to 1-bit with a threshold, scaled to about 70% of the width.
BLE:
- Use `requestDevice({ acceptAllDevices: true, optionalServices: [...] })` with a broad list of known printer services:
  - `000018f0-…` (char `2af1`)
  - `e7810a71-73ae-499d-8c15-faa9aef0c3f2` (char `bef8d6c9-9c21-4c9e-b632-bd58c1009f9f`)
  - `49535343-fe7d-4ae5-8fa9-9fafd205e455` (char `49535343-8841-43f4-a8d4-ecbe34729bb3`)
  - `0000ff00-…` (char `ff02`), `0000ffe0-…` (char `ffe1`), `0000fee7-…`, `0000ae30-…` (char `ae01`), plus others you know.
- Pick the first characteristic that has `write` or `writeWithoutResponse`.
- Send chunks adaptively: try about 180 bytes; on error, drop to 20. Pace writes without response so the printer's buffer can keep up.
- Remember `{id, name}` in settings `printer`. Next time, try `navigator.bluetooth.getDevices()` first.
- Disconnect when done.

### A: `js/signature.js`
```js
export class SignaturePad {
  constructor(canvas, { onChange } = {}) // pointer events (finger, pen, mouse), smooth strokes, DPR-aware, touch-action:none
  clear(); isEmpty(); toDataURL() /* PNG, black on transparent, ~900×300 */; async fromDataURL(url); setDisabled(bool)
}
```

### Startup splash (owner request, LEAD owns the files)
On every launch of the main app (`index.html` only, never the viewer) a splash shows **only "Marlon"**, large and centered on its own (owner request: no line underneath). It stays for **five seconds**, then fades smoothly (0.8 s) into the main page.
- The splash is **always dark** (#0f1411), never white, whatever the phone's light/dark setting.
- **A tap anywhere skips it.** Any key press does too. It fades straight to the main page and never presses what's underneath, because the splash consumes the whole tap.
- The name is the inline SVG wordmark (see "Brand mark" below), a refined serif M. The splash shows nothing else; the brand bar and receipts still carry "Delivery Invoices".
- Files: `css/splash.css` and `js/splash.js` (a classic deferred script, independent of the app modules). Both must be in the service-worker precache.
- index.html wiring:
  - `<html lang="en" class="splash-active">`.
  - `<link rel="stylesheet" href="/css/splash.css">` after base.css.
  - `<script src="/js/splash.js" defer></script>` before the app module.
  - This as the **first child of `<body>`**:
    `<div id="splash" aria-hidden="true"><div class="splash-mark"><p class="splash-name"><!-- wordmark --></p></div></div>`
- app.js: after the first screen has rendered, run `window.__appReady = true; document.dispatchEvent(new Event("app:ready"));`. The splash never fades into a blank page; it waits for this signal, capped at 10 s in total.
- Tests: automated browsers (`navigator.webdriver`) skip the splash so other tests aren't slowed down. Load `/?splash` to force it in a splash test.

### Brand mark (owner request)
- **Wordmark:** "Marlon" set from Bodoni Moda 500 outlines (SIL OFL 1.1). It's a refined Didone M with sharp thin–thick strokes and no curl or ball, using the typeface's own spacing.
  - Generated by `scripts/make-wordmark.cjs`, which writes the inline SVG blocks in index.html (`<!-- wordmark:start/end -->`) and `public/js/wordmark.js` (viewBox and path data).
  - The green line "Delivery Invoices" sits beneath it.
- **Brand bar:** a permanent, slim, dark (#0f1411) bar fixed at the top of the main screen, **outside** `#invoice-screen`, so the salesperson's form is untouched.
  - The invoice gets a top padding of `--brand-bar-h` so the bar never covers it.
  - The status bar matches the bar (`theme-color` #0f1411, `black-translucent`).
  - The bar hides on `#/owner`, where the dashboard has its own header.
- **Receipts:** every receipt opens with the brand.
  - The canvas (PDF and picture) draws the wordmark with Path2D, then "Delivery Invoices" and "Seller: …".
  - Bluetooth prints it as a 1-bit image first, with a text fallback.
  - The customer page (`/v`) opens with the same brand.

### Voice entry (owner request)
- **Mic:** one full-width "Speak the invoice" button under the header. One tap starts listening; the next tap ("Stop listening") stops. There's no holding. Words appear live in a panel.
- **Speaking:** the whole invoice in one go: store, address, then products with amount, unit and price ("two dozen beetroot juice … fifty pounds okra at two fifty").
- **Engine (`js/voice.js`):**
  - The browser's SpeechRecognition, on-device when available: Chrome's `available()`/`install()` and `processLocally`, while Safari uses Apple's recognition.
  - Continuous, restarting itself after the browser pauses.
  - **Fallback:** a text box for the keyboard's microphone (iPhone dictation is on-device and works offline), used when recognition is missing, blocked, refused (some iPhone home-screen apps) or offline without on-device speech. Words heard so far carry over.
  - `_headers` allows `microphone=(self)`.
- **Understanding (`js/voice-parse.js`, pure and Node-tested):**
  - Numbers in words and digits, halves, dozens, bags and pounds, and spoken prices ("two fifty" means 250).
  - Splits the store and address by pauses, the house number or business words.
  - Matches products by sound, aliases included.
  - Okra and Hot Pepper default to pounds.
  - **Spoken prices** are the unit price for that line, on this invoice only: "24 beetroot juice 315 per unit", "16 green juice at 230", "250 each", "4200 per dozen", "300 a pound", or a bare number after the product that isn't the next product's amount.
  - "Per unit", "each", "per dozen", "per pound" and "at" never become a product line.
  - **No standing prices:** nothing is saved or pre-filled from earlier invoices, whether spoken or typed. Every invoice starts fresh.
  - **Spoken dates** set the invoice date and are removed before the store and address are read. They're read day first: "12th of the 11th 2026", "the twelfth of November", "November 12th", "12/11/2026".
  - **Nothing unclear is guessed:** such lines carry an `issue`.
- **Review (`js/voice-review.js`):** a full-screen "Check before the customer signs" screen.
  - Tap any line to fix the product, amount, unit or price.
  - Unclear lines are highlighted with one-tap product choices, and "Put on invoice" waits until they're fixed or removed.
  - Applying respects the signed-invoice guard and asks before replacing existing products.
- **Units:**
  - Lines carry `unit` (each | dozen | bag | lb). Each ticked row has a unit picker.
  - Units appear on receipts, PDFs, the customer page and the dashboard ("24 sold · 50 lb").
  - In the QR, the unit is a letter after the amount (`2d`, `50p`, `3b`); old links read as "each".

### A: `js/app.js` (main screen)
- Startup: `await db.init()`. Register `/sw.js` (scope `/`). Open `settings.currentId` if it still exists; otherwise start a new draft.
- Routing:
  - `#/` (or empty) is the invoice screen.
  - `#/owner` hides the invoice screen and calls `showDashboard()`. Leaving it calls `hideDashboard()`.
  - Call `initDashboard(document.getElementById("dashboard"), hooks)` once, where hooks are `{ openInvoice(id), duplicateInvoice(id), newInvoice(), onProductsChanged(), close() }`.
- Header: "Marlon Williams" in large display serif, with "Delivery invoice · No. 0007" under it. On the right is a discreet icon button (aria-label "Owner dashboard") that goes to `#/owner`.
- **Customer** section:
  - Store name: text input with a `<datalist>` of `invoices.knownStores()`. Choosing a known store fills an empty address and shows a toast.
  - Store address: textarea, 2 rows.
  - Date: `input[type=date]`, defaulting to `todayISO()` and changeable.
- **Products** section, one row per product (`products.all()`) in order:
  - A large checkbox plus the name. Tapping the name toggles the tick.
  - When ticked: a qty stepper (− [input] +, `inputmode="decimal"`, defaults to 1 when ticked), "× $ price" (`inputmode="decimal"`, pre-filled with `product.lastPrice` if known), and "= line total" right-aligned.
  - A ticked item with no price shows "Add price" and its line total shows "—".
  - When unticked: the row fades to about 45% opacity, the qty and price controls are hidden, and the row stays in place.
  - Products on this invoice that were later removed from the list still show, at the end.
  - An **"Add product"** row sits at the end: an input and an Add button. It calls `products.add()`, appends and ticks the new product, then focuses its price.
- **Grand total** row at the bottom of the products: "Total" with `money(total)` in big type, and "N items".
  - Nice to have: a slim sticky bottom bar showing the total, hidden while the real total row is visible (IntersectionObserver).
- **Customer signature** box: a canvas of about 170 px height across the full width, with a "Sign here" baseline hint and a Clear button. It shows "Signed ✓ 3:45 PM" once signed.
  - If anything on a signed invoice changes, confirm first: "Changing the invoice removes the customer's signature. They'll need to sign again." Then clear the signature.
  - Intercept on focus or click before the change happens.
- **QR code** box:
  - Show `qrCanvas(invoiceToUrl(inv), {px: 240})` with the caption "Customer: scan with your phone camera to see this invoice."
  - Toggle: "Their phone has no internet? Use the text-only QR". This switches to `qrCanvas(invoiceToText(inv), {px: 300, ecc: "L"})` with a matching caption, and the mode is remembered in `qrMode`.
  - The QR updates as the invoice changes (debounced 250 ms).
  - With no store and no items, show a placeholder.
- **Actions:**
  - Primary: **Print receipt** (`printInvoice(inv)`, called directly in the click handler).
  - Secondary: **Share PDF** (`shareInvoicePdf`), with a small "Share as picture" link (`shareInvoiceImage`).
  - **New invoice.**
  - Before printing or sharing, if `itemsMissingPrice(inv).length` is above zero, confirm "2 items have no price. Continue?"
- **Autosave:**
  - Debounced 500 ms, using `invoices.put`. Save only once the invoice has a store name or at least one ticked item.
  - Show a status line: "Saved on this phone · 3:41 PM", or "Not saved yet".
  - On save, call `products.rememberPrices({productId: price})` and keep `settings.currentId` up to date.
  - Flush pending saves on `visibilitychange` (hidden) and `pagehide`.
- **Install:**
  - On iOS Safari when not standalone (`navigator.standalone !== true` and not `display-mode: standalone`), show a dismissible card: "Install: tap Share, then 'Add to Home Screen'". Remember dismissal in localStorage.
  - On Android, capture `beforeinstallprompt` and show an "Install app" button.
- **Update banner:** when the SW has a waiting worker, show "A new version is ready. Refresh".

### B: `js/dashboard.js`
```js
export function initDashboard(root, hooks) // root = <section id="dashboard">; renders into it; hooks as in A
export async function showDashboard()      // PIN gate, then fresh data
export function hideDashboard()
```
- **PIN gate:**
  - First time: create a 4 to 6 digit PIN, entered twice. Show a big numeric keypad (not the system keyboard), styled like a phone lock screen.
  - Store it as PBKDF2-SHA-256 (WebCrypto, at least 150k iterations, 16-byte random salt) in `settings.pin`.
  - After 5 wrong tries, wait 30 seconds; the wait doubles after each further failure, and the countdown persists in memory.
  - Stay unlocked for 5 minutes since the last dashboard activity. Lock immediately when the page is hidden (`visibilitychange`).
  - **Forgot PIN:** show a sheet that says the invoices are kept and the PIN only keeps casual eyes out (it doesn't encrypt). Typing RESET sets a new PIN and records `pinResetAt`. The dashboard then shows a notice: "PIN was reset on …".
- **Totals** (by invoice `date`):
  - Cards for Today, This week (Monday to Sunday), This month and All time, each with $ total and invoice count.
  - Monthly totals for the last 12 months that have data, as simple CSS bars.
  - Top stores (total and count) and products sold (qty and revenue), each with a This month / All time toggle.
- **History:**
  - Search by store or invoice number, plus filter chips: All, This month, Not signed.
  - Rows show "No. 0007 · 10 Nov 2026", the store, `money(total)` and a signed badge.
  - Tapping a row opens a detail view: the full invoice (items, total, signature image, QR via qr.js plus codec.js) with these actions:
    - **Open and edit**: `hooks.openInvoice`.
    - **Print**: `printInvoice`, called directly in the click handler.
    - **Share PDF**.
    - **Duplicate as new invoice**: `hooks.duplicateInvoice`.
    - **Delete**: confirm first.
- **Settings** inside the dashboard:
  - Paper width: a 58 mm / 80 mm segmented control, saved to `settings.paper`.
  - Printer: the saved printer name, plus "Forget printer".
  - **Products:** rename, move up or down, remove (hide), restore removed products, and add new ones. Call `hooks.onProductsChanged()` after any change.
  - **Backup:** "Save backup file" turns `exportBackup()` into `invoices-backup-YYYY-MM-DD.json`, shared as a file or downloaded. "Restore from backup" uses a file input, calls `importBackup`, and shows a toast with the counts.
  - Storage status: whether storage is persisted, and the invoice count.
  - Change PIN, and "Erase everything" (type ERASE).
- Header: "Owner dashboard", with "Marlon Williams" in small type, plus Lock and "Back to invoice" buttons.

## Design direction

- **Calm, official and sunlight-legible.** The look is a warm paper background (`--bg`) with the invoice as a clean white sheet made of rounded cards.
- Fresh green (`--brand`) marks primary actions and ticks; pumpkin (`--accent`) is used sparingly, for the grand total.
- The display serif (`--font-display`) is used for "Marlon Williams" and big totals; everything else uses the system sans font. Use tabular numbers for all money.
- Ticked rows get a faint green tint and an emphasised name. Unticked rows sit faded, at about 45% opacity.
- Motion is subtle (150 ms) and respects reduced motion. Dark mode comes from the base.css tokens.
- Reuse the base.css classes: `.btn` `.btn-primary` `.btn-ghost` `.btn-danger` `.btn-block` `.btn-icon` `.card` `.section-title` `.field` `.toast` `dialog.sheet`.
- **Icons:** write small inline SVG in JS via `document.createElementNS`, or in static markup in index.html. Don't use icon fonts.

## Testing (each builder tests their own work before reporting)

- Start the local server on **your own port**: A 8791, B 8792, C 8793, D 8794, integrator 8790.
  - From a terminal: `node tests/serve.cjs <port> &`.
  - From a test: `require('./serve.cjs').start(port)`.
  - Always stop it at the end.
- Use Playwright. `require('playwright')` works from any directory; Chromium is preinstalled, so never run `playwright install`.
  - Run `chromium.launch()` with a 390×844 viewport, `isMobile: true`, `hasTouch: true` and `deviceScaleFactor: 1`.
  - Save screenshots to `tests/output/` and look at them.
- Mocks: stub `navigator.bluetooth` with `page.addInitScript`, recording the bytes it receives. Stub `navigator.share` and `navigator.canShare`, capturing the files as base64.
- **Builders work in parallel, so other builders' files may be missing or half-written while you test.**
  - **Never write stub or placeholder files into `public/`.** Instead, intercept the URL in Playwright with `page.route('**/js/qr.js', r => r.fulfill({ contentType: 'text/javascript', body: STUB }))`. Give the stub the contract's exports; it can wrap `/js/vendor/qrcode.js`.
  - Test-only harness pages live in `tests/harness/` and are served at `/__tests/<file>`. CSP still applies there, so put scripts in separate `.js` files.
  - `start(port, { stubMissing: true })` (or `--stub-missing`) answers missing `public/*.js` with `export {};` and missing `*.css` with empty text. That's useful for service-worker precache tests, but it won't satisfy named imports.
  - Before you finish, re-run your tests once against whatever real files exist by then, and say in your report which of your tests used stubs.
- **Don't** commit, push or deploy. The integrator and owner handle that.
- QR checks: `jsqr` is installed in `node_modules/` (`require('jsqr')`). Decode the QR from canvas pixels (`getImageData`) and compare the result with the expected payload.
- PDF checks: `pdfinfo`, `pdftoppm` and Python `pypdf` are installed.
- Tests are plain Node `.cjs` scripts: exit code 0 means pass, and they should print clear PASS/FAIL lines.

## Report format (each builder's final answer)

Report:
- Files written.
- The exact exported API, including any deviations from this spec and why.
- Requests for other modules, if any.
- The tests you ran and their results.
- Known limitations.
