/** Receipt rendering, PDF validity, ESC/POS bytes over a mock Bluetooth printer, share and the iPhone fallback. */
const { chromium } = require("playwright");
const { start } = require("./serve.cjs");
const jsQR = require("jsqr");
const fs = require("fs"), path = require("path"), { execFileSync } = require("child_process");

const PORT = 8794, OUT = path.join(__dirname, "output");
let failures = 0;
const check = (ok, name, extra = "") => { console.log(`${ok ? "PASS" : "FAIL"}  ${name}${extra ? "  — " + extra : ""}`); if (!ok) failures++; };

/** Minimal ESC/POS parser: text lines and raster images. */
function parseEscPos(bytes) {
  const lines = [], images = []; let cur = "", i = 0;
  while (i < bytes.length) {
    const b = bytes[i];
    if (b === 0x1b) { const c = bytes[i + 1]; i += c === 0x40 ? 2 : (c === 0x64 || c === 0x61 || c === 0x45 || c === 0x74) ? 3 : 2; continue; }
    if (b === 0x1d) {
      const c = bytes[i + 1];
      if (c === 0x21) { i += 3; continue; }
      if (c === 0x56) { i += 4; continue; }
      if (c === 0x76) { const x = bytes[i + 4] | (bytes[i + 5] << 8), y = bytes[i + 6] | (bytes[i + 7] << 8); images.push({ bytesPerRow: x, rows: y, data: bytes.slice(i + 8, i + 8 + x * y) }); i += 8 + x * y; continue; }
      i += 2; continue;
    }
    if (b === 0x0a) { lines.push(cur); cur = ""; i++; continue; }
    cur += String.fromCharCode(b); i++;
  }
  return { lines, images };
}
/** Joins consecutive raster bands of equal width into images. */
function joinBands(images) {
  const out = [];
  for (const im of images) {
    const last = out[out.length - 1];
    if (last && last.bytesPerRow === im.bytesPerRow && last.open) { last.rows += im.rows; last.data = Buffer.concat([last.data, Buffer.from(im.data)]); if (im.rows < 64) last.open = false; }
    else out.push({ bytesPerRow: im.bytesPerRow, rows: im.rows, data: Buffer.from(im.data), open: im.rows === 64 });
  }
  return out;
}
function decodeRaster(img) {
  const w = img.bytesPerRow * 8, h = img.rows, rgba = new Uint8ClampedArray(w * h * 4);
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) { const on = img.data[y * img.bytesPerRow + (x >> 3)] & (0x80 >> (x & 7)); const v = on ? 0 : 255, k = (y * w + x) * 4; rgba[k] = rgba[k + 1] = rgba[k + 2] = v; rgba[k + 3] = 255; }
  return jsQR(rgba, w, h);
}

const BLE_MOCK = `
  window.__ble = { chunks: [], connects: 0, disconnects: 0, requested: 0, failBig: false, cancel: false };
  const mkChar = () => ({ uuid: "00002af1-0000-1000-8000-00805f9b34fb", properties: { write: true, writeWithoutResponse: true },
    async writeValueWithResponse(v) { const a = new Uint8Array(v.buffer ? v.buffer.slice(v.byteOffset, v.byteOffset + v.byteLength) : v); if (window.__ble.failBig && a.length > 20) throw new DOMException("too big", "NetworkError"); window.__ble.chunks.push(Array.from(a)); },
    async writeValueWithoutResponse(v) { return this.writeValueWithResponse(v); } });
  const device = { id: "dev-1", name: "PT-210", gatt: { connected: false,
    async connect() { window.__ble.connects++; this.connected = true; return { async getPrimaryServices() { return [{ uuid: "000018f0-0000-1000-8000-00805f9b34fb", async getCharacteristics() { return [mkChar()]; } }]; } }; },
    disconnect() { window.__ble.disconnects++; this.connected = false; } } };
  Object.defineProperty(navigator, "bluetooth", { value: {
    async requestDevice(opts) { window.__ble.requested++; window.__ble.opts = opts; if (window.__ble.cancel) throw new DOMException("User cancelled the requestDevice() chooser.", "NotFoundError"); return device; },
    async getDevices() { return window.__ble.requested ? [device] : []; } } });
`;
const SHARE_MOCK = `
  window.__shared = [];
  navigator.canShare = (d) => !!(d && d.files && d.files.length);
  navigator.share = async (d) => { const f = d.files[0]; const b = new Uint8Array(await f.arrayBuffer()); window.__shared.push({ name: f.name, type: f.type, size: b.length, head: String.fromCharCode(...b.slice(0, 8)) }); };
`;

(async () => {
  fs.mkdirSync(OUT, { recursive: true });
  const srv = await start(PORT);
  const browser = await chromium.launch();
  try {
    // bypassCSP only so the test can inject jsQR into the page (the app itself never needs it).
    const ctx = await browser.newContext({ viewport: { width: 390, height: 844 }, deviceScaleFactor: 1, bypassCSP: true });
    await ctx.addInitScript(BLE_MOCK); await ctx.addInitScript(SHARE_MOCK);
    const page = await ctx.newPage();
    const errors = []; page.on("pageerror", (e) => errors.push(e.message)); page.on("console", (m) => { if (m.type() === "error") errors.push(m.text()); });
    await page.goto(`${srv.url}/__tests/print-harness.html`);
    await page.waitForFunction(() => window.ready === true);
    await page.addScriptTag({ path: require.resolve("jsqr/dist/jsQR.js") });

    // Receipt canvas renders at both widths and its QR scans.
    for (const paper of [58, 80]) {
      const r = await page.evaluate(([p]) => T.receiptPng(18, p), [paper]);
      const file = path.join(OUT, `print-receipt-${paper}mm.png`);
      fs.writeFileSync(file, Buffer.from(r.png.split(",")[1], "base64"));
      check(r.w === (paper === 80 ? 1152 : 768) && r.h > r.w, `receipt canvas ${paper}mm size`, `${r.w}x${r.h}`);
      const qr = await page.evaluate(async ([png]) => {
        const img = new Image(); img.src = png; await img.decode();
        const c = document.createElement("canvas"); c.width = img.width; c.height = img.height;
        const x = c.getContext("2d"); x.drawImage(img, 0, 0);
        const d = x.getImageData(0, 0, c.width, c.height);
        const res = window.jsQR(d.data, d.width, d.height);
        return res && { data: res.data };
      }, [r.png]);
      const url18 = await page.evaluate(() => T.url(18));
      check(qr && qr.data === url18, `receipt QR (${paper}mm) decodes to the invoice link`, qr ? qr.data.slice(0, 60) + "…" : "no QR found");
    }

    // PDF validity at both widths.
    for (const [n, paper] of [[3, 58], [18, 58], [3, 80]]) {
      const b64 = await page.evaluate(([n, p]) => T.pdfB64(n, p), [n, paper]);
      const file = path.join(OUT, `print-invoice-${n}items-${paper}mm.pdf`);
      fs.writeFileSync(file, Buffer.from(b64, "base64"));
      const info = execFileSync("pdfinfo", [file], { encoding: "utf8" });
      const pages = /Pages:\s+(\d+)/.exec(info)?.[1];
      const w = Number(/Page size:\s+([\d.]+) x/.exec(info)?.[1]);
      const want = paper * 72 / 25.4;
      check(pages === "1" && Math.abs(w - want) < 0.6, `PDF ${n} items ${paper}mm: 1 page, ${want.toFixed(1)}pt wide`, `pages=${pages} width=${w}`);
      const py = execFileSync("python3", ["-c", "import sys,pypdf;r=pypdf.PdfReader(sys.argv[1],strict=True);p=r.pages[0];x=p['/Resources']['/XObject'];im=x[list(x.keys())[0]].get_object();print(len(r.pages),im['/Filter'],im['/Width'],r.metadata.get('/Author'))", file], { encoding: "utf8" }).trim();
      check(/^1 \/DCTDecode \d+ Marlon Williams$/.test(py), `PDF ${n}/${paper}mm parses strictly with pypdf`, py);
      execFileSync("pdftoppm", ["-png", "-r", "150", "-singlefile", file, file.replace(/\.pdf$/, "")]);
    }

    // ESC/POS layout (pure builder).
    for (const paper of [58, 80]) {
      const bytes = await page.evaluate(([p]) => T.escpos(5, p), [paper]);
      const { lines } = parseEscPos(bytes);
      const cols = paper === 80 ? 48 : 32;
      check(bytes[0] === 0x1b && bytes[1] === 0x40, `ESC/POS ${paper}mm starts with ESC @`);
      check(lines.every((l) => l.length <= cols), `ESC/POS ${paper}mm: every line fits ${cols} columns`, String(Math.max(...lines.map((l) => l.length))));
      const text = lines.join("\n");
      check(/MARLON/.test(text) && /No\. 0007/.test(text) && /10 Nov 2026/.test(text) && /Rose Hall Grocery/.test(text) && /Montego Bay/.test(text), `ESC/POS ${paper}mm header fields present`);
      check(/Coconut Water Cafe/.test(text) && !/Café/.test(text), `ESC/POS ${paper}mm folds accents to ASCII`);
      check(/TOTAL\s+\$[\d,]+\.\d\d/.test(text) && /5 items/.test(text) && /Not signed/.test(text), `ESC/POS ${paper}mm total, count, unsigned line`);
      check(!/Large Bammy/.test(text), `ESC/POS ${paper}mm leaves unticked products out`);
    }

    // Print over a mock Bluetooth printer.
    let r = await page.evaluate(() => T.print(4));
    let ble = await page.evaluate(() => window.__ble);
    const all = ble.chunks.flat();
    const parsed = parseEscPos(all);
    const imgs = joinBands(parsed.images);
    check(r.ok === true && ble.requested === 1 && ble.connects === 1 && ble.disconnects >= 1, "prints via Bluetooth, connects once, disconnects after", JSON.stringify(r));
    check(ble.chunks.every((c) => c.length <= 180), "every Bluetooth write is ≤ 180 bytes", `max ${Math.max(...ble.chunks.map((c) => c.length))}`);
    check(parsed.images.every((im) => im.rows <= 64 && im.bytesPerRow * 8 <= 384), "raster bands ≤ 64 rows and ≤ 384 dots wide (58mm)");
    check(ble.opts && ble.opts.acceptAllDevices === true && ble.opts.optionalServices.includes("000018f0-0000-1000-8000-00805f9b34fb"), "chooser lists all devices with printer services");
    const qrImg = imgs.find((im) => decodeRaster(im));
    const qrData = qrImg && decodeRaster(qrImg).data;
    const url4 = await page.evaluate(() => T.url(4));
    check(qrData === url4, "printed QR (from the byte stream) decodes to the invoice link", qrData ? qrData.slice(0, 50) + "…" : "none");
    check(imgs.length === 2, "signature and QR printed as images", `${imgs.length} images`);
    check(await page.evaluate(() => T.savedPrinterName()) === "PT-210", "printer remembered for next time");
    // Second print reuses the remembered printer without the chooser.
    await page.evaluate(() => { window.__ble.chunks = []; });
    r = await page.evaluate(() => T.print(2));
    ble = await page.evaluate(() => window.__ble);
    check(r.ok && ble.requested === 1, "second print reuses the remembered printer (no chooser)");
    // Printer refusing big writes → falls back to 20-byte chunks.
    await page.evaluate(() => { window.__ble.chunks = []; window.__ble.failBig = true; });
    r = await page.evaluate(() => T.print(2));
    ble = await page.evaluate(() => window.__ble);
    check(r.ok && ble.chunks.length > 0 && ble.chunks.every((c) => c.length <= 20), "falls back to 20-byte writes when the printer refuses bigger ones");
    // Chooser cancelled → quiet.
    await page.evaluate(async () => { await T.forgetPrinter(); window.__ble.cancel = true; window.__ble.failBig = false; });
    r = await page.evaluate(() => T.print(2));
    const sheet = await page.locator("dialog.sheet[open]").count();
    check(r.ok === false && r.reason === "cancelled" && sheet === 0, "cancelling the printer list is quiet", JSON.stringify(r));

    // Share PDF / picture via the share sheet.
    let s = await page.evaluate(() => T.share("pdf"));
    let shared = await page.evaluate(() => window.__shared);
    check(s === "shared" && shared[0]?.name === "Invoice-0007-Rose-Hall-Grocery-Wholesale.pdf" && shared[0].type === "application/pdf" && shared[0].head.startsWith("%PDF-1.4"), "Share PDF hands a named PDF to the share sheet", JSON.stringify(shared[0]));
    await page.evaluate(() => T.setPaper(80));
    s = await page.evaluate(() => T.share("png"));
    shared = await page.evaluate(() => window.__shared);
    check(s === "shared" && shared[1]?.type === "image/png" && shared[1].name.endsWith(".png"), "Share as picture hands a PNG to the share sheet");
    check(errors.length === 0, "no console errors (Bluetooth page)", errors.join(" | "));
    await ctx.close();

    // iPhone-like browser: no Web Bluetooth → explanation sheet with Share PDF instead.
    const ctx2 = await browser.newContext({ viewport: { width: 390, height: 844 }, userAgent: "Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Mobile/15E148 Safari/604.1" });
    await ctx2.addInitScript(SHARE_MOCK);
    await ctx2.addInitScript("Object.defineProperty(navigator, 'bluetooth', { value: undefined });");
    const p2 = await ctx2.newPage();
    await p2.goto(`${srv.url}/__tests/print-harness.html`);
    await p2.waitForFunction(() => window.ready === true);
    const pending = p2.evaluate(() => T.print(3));
    await p2.waitForSelector("dialog.sheet[open]");
    const sheetText = await p2.locator("dialog.sheet[open]").innerText();
    check(/iPhone browsers can't connect to Bluetooth printers/.test(sheetText) && /Bluefy/.test(sheetText), "iPhone: explains the Bluetooth limit and the Bluefy option");
    check(!/\bnull\b/.test(sheetText), "iPhone sheet has no stray 'null' text");
    await p2.screenshot({ path: path.join(OUT, "print-iphone-sheet.png") });
    await p2.getByRole("button", { name: "Share PDF instead" }).click();
    const res = await pending;
    const sh = await p2.evaluate(() => window.__shared);
    check(res.reason === "unsupported" && sh.length === 1 && sh[0].type === "application/pdf", "iPhone: 'Share PDF instead' shares the PDF");
    await ctx2.close();
  } finally {
    await browser.close();
    await srv.close();
  }
  console.log(failures ? `\n${failures} check(s) failed` : "\nAll print checks passed");
  process.exit(failures ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
