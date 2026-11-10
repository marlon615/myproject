/**
 * Printing to Bluetooth thermal receipt printers (58 mm / 80 mm) with Web Bluetooth and ESC/POS commands.
 * Every receipt opens with the brand ("Marlon" wordmark + "Delivery Invoices"), printed as an image.
 * Works in Chrome on Android (and in the Bluefy browser on iPhone). iPhone Safari has no Web Bluetooth, so
 * printInvoice() explains that and offers Share PDF instead.
 */
import { settings } from "./db.js";
import { makeQr, qrRaster } from "./qr.js";
import { BRAND_TAGLINE, drawWordmark, itemCountText, receiptModel, wordmarkHeight } from "./receipt.js";
import { shareInvoicePdf } from "./share.js";
import { choiceSheet, toast } from "./ui.js";
import { asciiFold, h, loadImage } from "./util.js";

/** GATT services used by common 58/80 mm BLE receipt printers (Web Bluetooth only lets us open listed ones). */
const SERVICES = [
  "000018f0-0000-1000-8000-00805f9b34fb", // most generic thermal printers (characteristic 2af1)
  "e7810a71-73ae-499d-8c15-faa9aef0c3f2", // many "MTP"/"PT-210"/Goojprt style printers
  "49535343-fe7d-4ae5-8fa9-9fafd205e455", // Microchip/ISSC transparent UART
  "0000ff00-0000-1000-8000-00805f9b34fb",
  "0000ffe0-0000-1000-8000-00805f9b34fb", // HM-10 style serial modules
  "0000fee7-0000-1000-8000-00805f9b34fb",
  "0000ae30-0000-1000-8000-00805f9b34fb",
  "0000ae00-0000-1000-8000-00805f9b34fb",
  "0000af30-0000-1000-8000-00805f9b34fb",
  "0000ff80-0000-1000-8000-00805f9b34fb",
  "0000fff0-0000-1000-8000-00805f9b34fb",
  "6e400001-b5a3-f393-e0a9-e50e24dcca9e", // Nordic UART
];
/** Characteristics known to accept print data (preferred when a service has several writable ones). */
const PREFERRED_CHARS = [
  "00002af1-0000-1000-8000-00805f9b34fb",
  "bef8d6c9-9c21-4c9e-b632-bd58c1009f9f",
  "49535343-8841-43f4-a8d4-ecbe34729bb3",
  "0000ff02-0000-1000-8000-00805f9b34fb",
  "0000ffe1-0000-1000-8000-00805f9b34fb",
  "0000ae01-0000-1000-8000-00805f9b34fb",
  "0000fff2-0000-1000-8000-00805f9b34fb",
  "6e400002-b5a3-f393-e0a9-e50e24dcca9e",
];

const ESC = 0x1b, GS = 0x1d, LF = 0x0a;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// Remember the saved printer in memory too, so a tap can reach the Bluetooth chooser without waiting on storage.
let saved = null;
settings.get("printer", null).then((p) => { saved = p; }, () => {});

export function bluetoothSupported() {
  return typeof navigator !== "undefined" && Boolean(navigator.bluetooth?.requestDevice);
}

export async function savedPrinterName() {
  saved = await settings.get("printer", null);
  return saved?.name || null;
}

export async function forgetPrinter() {
  saved = null;
  await settings.remove("printer");
}

/**
 * Prints the invoice. Call it straight from a tap handler: the Bluetooth chooser needs that tap.
 * → { ok, reason?: "unsupported" | "cancelled" | "error", message? }
 */
export async function printInvoice(inv) {
  if (!bluetoothSupported()) return explainUnsupported(inv);
  let device;
  try {
    device = await pickDevice();
  } catch (e) {
    return chooserProblem(e, inv);
  }
  return printOn(device, inv, true);
}

async function printOn(device, inv, mayRetry) {
  toast("Printing…", { ms: 20000 });
  try {
    const paper = Number(await settings.get("paper", 58)) === 80 ? 80 : 58;
    const bytes = await buildReceiptBytes(inv, paper);
    const ch = await connectWritable(device);
    await send(ch, bytes);
    await sleep(300);
    saved = { id: device.id, name: device.name || "Printer" };
    await settings.set("printer", saved);
    toast(`Printed on ${saved.name} ✓`);
    return { ok: true, deviceName: saved.name };
  } catch (e) {
    console.error("print failed", e);
    disconnect(device);
    if (mayRetry && e?.retryable) {
      // The remembered printer didn't answer (off, asleep or out of range): let them pick it again.
      const choice = await choiceSheet({
        title: "Printer not answering",
        message: `Make sure ${device.name || "the printer"} is switched on and close by, then try again.`,
        choices: [{ label: "Cancel", value: null }, { label: "Choose printer", value: "pick", primary: true }],
      });
      if (choice !== "pick") return { ok: false, reason: "cancelled" };
      try {
        const d = await navigator.bluetooth.requestDevice({ acceptAllDevices: true, optionalServices: SERVICES });
        return printOn(d, inv, false);
      } catch (e2) {
        return chooserProblem(e2, inv);
      }
    }
    const message = e?.userMessage || "Printing didn't work. Check the printer is on and has paper, then try again.";
    toast(message, { ms: 5000 });
    return { ok: false, reason: "error", message };
  } finally {
    disconnect(device);
  }
}

async function pickDevice() {
  if (saved?.id && navigator.bluetooth.getDevices) {
    try {
      const known = (await navigator.bluetooth.getDevices()).find((d) => d.id === saved.id);
      if (known) return known;
    } catch { /* fall through to the chooser */ }
  }
  return navigator.bluetooth.requestDevice({ acceptAllDevices: true, optionalServices: SERVICES });
}

async function chooserProblem(e, inv, retried = false) {
  const msg = String(e?.message || "");
  if (e?.name === "NotFoundError" && /adapter|bluetooth.*(off|unavailable|not available)/i.test(msg)) {
    toast("Turn on Bluetooth, then try again.", { ms: 4000 });
    return { ok: false, reason: "error", message: "Bluetooth is off" };
  }
  if (e?.name === "NotFoundError" || e?.name === "AbortError") return { ok: false, reason: "cancelled" }; // chooser closed
  if (e?.name === "SecurityError" && /gesture|activation/i.test(msg) && !retried) {
    // The browser no longer counts the original tap (something took too long): ask for a fresh one.
    const choice = await choiceSheet({
      title: "Choose your printer",
      message: "Tap below, then pick your Bluetooth printer from the list.",
      choices: [{ label: "Cancel", value: null }, { label: "Choose printer", value: "pick", primary: true }],
    });
    if (choice !== "pick") return { ok: false, reason: "cancelled" };
    try {
      const d = await navigator.bluetooth.requestDevice({ acceptAllDevices: true, optionalServices: SERVICES });
      return printOn(d, inv, false);
    } catch (e2) {
      return chooserProblem(e2, inv, true);
    }
  }
  if (e?.name === "NotSupportedError" || e?.name === "SecurityError") return explainUnsupported(inv);
  console.error("bluetooth chooser", e);
  toast("Couldn't open the printer list. Please try again.", { ms: 4000 });
  return { ok: false, reason: "error", message: msg };
}

async function explainUnsupported(inv) {
  const isIOS = /iPhone|iPad|iPod/.test(navigator.userAgent) || (navigator.platform === "MacIntel" && navigator.maxTouchPoints > 1);
  const choice = await choiceSheet({
    title: "Print with your printer's app",
    message: h("div", {},
      h("p", {}, isIOS ? "iPhone browsers can't connect to Bluetooth printers directly." : "This browser can't connect to Bluetooth printers directly."),
      h("p", {}, "Share the receipt as a PDF and choose your printer's app. Most receipt printers come with one. Or open this app in the free Bluefy browser, which can print directly."),
    ),
    choices: [{ label: "Not now", value: null }, { label: "Share PDF instead", value: "share", primary: true }],
  });
  if (choice === "share") await shareInvoicePdf(inv);
  return { ok: false, reason: "unsupported" };
}

function disconnect(device) {
  try { if (device?.gatt?.connected) device.gatt.disconnect(); } catch { /* already gone */ }
}

async function connectWritable(device) {
  if (!device?.gatt) throw Object.assign(new Error("no gatt"), { userMessage: "That device can't be printed to." });
  let server;
  try {
    server = await Promise.race([
      device.gatt.connect(),
      sleep(12000).then(() => { throw new Error("connect timeout"); }),
    ]);
  } catch (e) {
    throw Object.assign(new Error(`connect: ${e?.message || e}`), { retryable: true, userMessage: `Couldn't reach ${device.name || "the printer"}. Is it on and close by?` });
  }
  let services = [];
  try { services = await server.getPrimaryServices(); } catch { /* some browsers need them one by one */ }
  if (!services.length) {
    for (const uuid of SERVICES) { try { services.push(await server.getPrimaryService(uuid)); } catch { /* not on this printer */ } }
  }
  const writable = (c) => c.properties && (c.properties.write || c.properties.writeWithoutResponse);
  let fallback = null;
  for (const svc of services) {
    let chars = [];
    try { chars = await svc.getCharacteristics(); } catch { continue; }
    const preferred = chars.find((c) => PREFERRED_CHARS.includes(c.uuid) && writable(c));
    if (preferred) return preferred;
    fallback ||= chars.find(writable) || null;
  }
  if (fallback) return fallback;
  throw Object.assign(new Error("no writable characteristic"), { userMessage: "That doesn't look like a receipt printer. Choose your printer from the list." });
}

/** Sends bytes in chunks: ~180 bytes, dropping to 20 if the printer refuses bigger writes. */
async function send(ch, bytes) {
  const withResponse = ch.properties.write && typeof ch.writeValueWithResponse === "function";
  const withoutResponse = ch.properties.writeWithoutResponse && typeof ch.writeValueWithoutResponse === "function";
  let size = 180;
  for (let i = 0; i < bytes.length;) {
    const chunk = bytes.slice(i, i + size);
    try {
      if (withResponse) await ch.writeValueWithResponse(chunk);
      else if (withoutResponse) { await ch.writeValueWithoutResponse(chunk); await sleep(size > 20 ? 14 : 5); } // pace for the printer's buffer
      else await ch.writeValue(chunk);
      i += chunk.length;
    } catch (e) {
      if (size > 20) { size = 20; continue; }
      throw Object.assign(e instanceof Error ? e : new Error(String(e)), { userMessage: "The printer stopped answering. Check it's on and has paper." });
    }
  }
}

// ── Building the receipt ────────────────────────────────────────────────

async function buildReceiptBytes(inv, paper) {
  const model = receiptModel(inv);
  const dots = paper === 80 ? 576 : 384;
  const brandRaster = brandToRaster(Math.floor((dots * 0.74) / 8) * 8);
  const signatureRaster = model.signature ? await signatureToRaster(model.signature, Math.floor(dots * 0.7)) : null;
  let qr = null;
  try {
    const code = makeQr(model.qrUrl, { ecc: "M" });
    const modules = code.size + 8;
    const scale = Math.min(8, Math.floor((dots * 0.78) / modules));
    if (scale >= 3) qr = qrRaster(code, { scale, margin: 4 });
    else if (Math.floor(dots / modules) >= 2) qr = qrRaster(code, { scale: Math.floor(dots / modules), margin: 4 });
  } catch { qr = null; }
  return buildEscPos(model, { paper, brandRaster, signatureRaster, qrRaster: qr });
}

/** The brand ("Marlon" wordmark + "Delivery Invoices") as a 1-bit raster `width` dots wide. */
function brandToRaster(width) {
  try {
    const markW = Math.round(width * 0.94), markH = Math.round(wordmarkHeight(markW));
    const tagPx = Math.max(14, Math.round(width * 0.078));
    const height = markH + Math.round(tagPx * 0.55) + tagPx + 4;
    const c = document.createElement("canvas");
    c.width = width;
    c.height = height;
    const ctx = c.getContext("2d");
    ctx.fillStyle = "#fff";
    ctx.fillRect(0, 0, width, height);
    ctx.fillStyle = "#000";
    drawWordmark(ctx, Math.round((width - markW) / 2), 0, markW);
    ctx.font = `600 ${tagPx}px -apple-system, BlinkMacSystemFont, "Helvetica Neue", Helvetica, Arial, sans-serif`;
    ctx.textAlign = "center";
    ctx.textBaseline = "alphabetic";
    ctx.fillText(BRAND_TAGLINE, width / 2, height - 4);
    // Generous threshold so the Bodoni hairlines survive at 203 dpi.
    const px = ctx.getImageData(0, 0, width, height).data;
    const bytesPerRow = width / 8;
    const data = new Uint8Array(bytesPerRow * height);
    for (let y = 0; y < height; y++) {
      for (let x = 0; x < width; x++) {
        const i = (y * width + x) * 4;
        if (px[i] * 0.299 + px[i + 1] * 0.587 + px[i + 2] * 0.114 < 200) data[y * bytesPerRow + (x >> 3)] |= 0x80 >> (x & 7);
      }
    }
    return { width, height, bytesPerRow, data };
  } catch {
    return null; // the text header is printed instead
  }
}

/** Signature PNG → 1-bit raster (black where the ink is), trimmed top and bottom. */
async function signatureToRaster(dataUrl, targetWidth) {
  try {
    const img = await loadImage(dataUrl);
    const width = Math.max(8, Math.floor(targetWidth / 8) * 8);
    const height = Math.max(1, Math.round(width * (img.naturalHeight / img.naturalWidth)));
    const c = document.createElement("canvas");
    c.width = width;
    c.height = height;
    const ctx = c.getContext("2d");
    ctx.fillStyle = "#fff";
    ctx.fillRect(0, 0, width, height);
    ctx.drawImage(img, 0, 0, width, height);
    const px = ctx.getImageData(0, 0, width, height).data;
    const bytesPerRow = width / 8;
    const data = new Uint8Array(bytesPerRow * height);
    let top = height, bottom = -1;
    for (let y = 0; y < height; y++) {
      for (let x = 0; x < width; x++) {
        const i = (y * width + x) * 4;
        if (px[i] * 0.299 + px[i + 1] * 0.587 + px[i + 2] * 0.114 < 150) {
          data[y * bytesPerRow + (x >> 3)] |= 0x80 >> (x & 7);
          if (y < top) top = y;
          bottom = y;
        }
      }
    }
    if (bottom < 0) return null;
    top = Math.max(0, top - 4);
    bottom = Math.min(height - 1, bottom + 4);
    return { width, height: bottom - top + 1, bytesPerRow, data: data.slice(top * bytesPerRow, (bottom + 1) * bytesPerRow) };
  } catch {
    return null;
  }
}

/**
 * The ESC/POS byte stream for a receipt model (pure: no DOM, so it can be tested anywhere).
 * Text is folded to ASCII and wrapped to 32 (58 mm) or 48 (80 mm) columns.
 */
export function buildEscPos(model, { paper = 58, brandRaster = null, signatureRaster = null, qrRaster = null } = {}) {
  const cols = paper === 80 ? 48 : 32;
  const maxDots = paper === 80 ? 576 : 384;
  const out = [];
  const bytes = (...b) => { for (const x of b) out.push(x & 0xff); };
  const write = (s) => { for (const ch of asciiFold(s)) out.push(ch.charCodeAt(0) & 0x7f); };
  const line = (s = "") => { write(s); bytes(LF); };
  const align = (n) => bytes(ESC, 0x61, n);           // 0 left, 1 centre, 2 right
  const bold = (on) => bytes(ESC, 0x45, on ? 1 : 0);
  const size = (n) => bytes(GS, 0x21, n);             // 0x00 normal, 0x01 double height, 0x11 double both
  const wrap = (s, width = cols) => {
    const lines = [];
    for (const para of asciiFold(s).split("\n")) {
      let cur = "";
      for (let word of para.split(/\s+/).filter(Boolean)) {
        while (word.length > width) { if (cur) { lines.push(cur); cur = ""; } lines.push(word.slice(0, width)); word = word.slice(width); }
        if (!word) continue;
        if (!cur) cur = word;
        else if (cur.length + 1 + word.length <= width) cur += " " + word;
        else { lines.push(cur); cur = word; }
      }
      lines.push(cur);
    }
    return lines;
  };
  /** Left text with a right-aligned amount on its last line (the amount moves down if it can't fit). */
  const lr = (left, right) => {
    const r = asciiFold(right);
    const lines = wrap(left);
    const last = lines.pop();
    for (const l of lines) line(l);
    if (last.length + 1 + r.length <= cols) line(last + " ".repeat(cols - last.length - r.length) + r);
    else { line(last); line(" ".repeat(Math.max(0, cols - r.length)) + r); }
  };
  const rule = (ch = "-") => line(ch.repeat(cols));
  const raster = (img) => {
    if (!img || img.width > maxDots || img.bytesPerRow * 8 !== img.width) return;
    for (let y0 = 0; y0 < img.height; y0 += 64) {
      const rows = Math.min(64, img.height - y0);
      bytes(GS, 0x76, 0x30, 0x00, img.bytesPerRow & 0xff, img.bytesPerRow >> 8, rows & 0xff, rows >> 8);
      const band = img.data.subarray(y0 * img.bytesPerRow, (y0 + rows) * img.bytesPerRow);
      for (const b of band) out.push(b);
    }
  };

  bytes(ESC, 0x40);           // initialise
  bytes(ESC, 0x74, 0x00);     // code page PC437
  // Brand: the "Marlon" wordmark and "Delivery Invoices" (as an image, or as text if no image was made).
  align(1);
  if (brandRaster) {
    raster(brandRaster);
  } else {
    bold(true);
    size(0x11);
    line("Marlon");
    size(0x00);
    bold(false);
    line("Delivery Invoices");
  }
  align(0);
  rule("=");
  lr(`No. ${model.number}`, model.dateText);
  for (const l of wrap(`Seller: ${model.seller}`)) line(l);
  if (model.store) for (const l of wrap(`Store: ${model.store}`)) line(l);
  if (model.address) for (const l of wrap(model.address)) line(l);
  rule();
  if (!model.items.length) line("No items");
  for (const it of model.items) {
    bold(true);
    for (const l of wrap(it.name)) line(l);
    bold(false);
    lr(`  ${it.qtyText} x ${it.priceText}`, it.totalText);
  }
  rule("=");
  bold(true);
  size(0x01);
  lr("TOTAL", model.totalText);
  size(0x00);
  bold(false);
  line(itemCountText(model.itemCount));
  line();
  line("Customer signature:");
  if (signatureRaster) { align(1); raster(signatureRaster); align(0); }
  else line("Not signed");
  rule();
  if (qrRaster) {
    line();
    align(1);
    raster(qrRaster);
    for (const l of wrap("Scan to see this invoice on your phone")) line(l);
    align(0);
  }
  bytes(ESC, 0x64, 4);        // feed 4 lines
  bytes(GS, 0x56, 0x42, 0x00); // cut (ignored by printers without a cutter)
  return Uint8Array.from(out);
}
