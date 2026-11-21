/** QR codes, made fully offline with the vendored qrcode-generator (MIT). */
import qrcode from "./vendor/qrcode.js";

qrcode.stringToBytes = qrcode.stringToBytesFuncs["UTF-8"];

/**
 * Encodes text (UTF-8, byte mode) at the smallest version that fits.
 * ecc: "L" | "M" | "Q" | "H". Throws Error("QR_TOO_LONG") if it doesn't fit even version 40.
 * → { version, size (modules per side), isDark(row, col) }
 */
export function makeQr(text, { ecc = "M" } = {}) {
  const s = String(text ?? "");
  for (let version = 1; version <= 40; version++) {
    const q = qrcode(version, ecc);
    q.addData(s, "Byte");
    try {
      q.make();
    } catch (e) {
      if (/overflow/i.test(String(e?.message ?? e))) continue; // too long for this version: try the next
      throw e;
    }
    const size = q.getModuleCount();
    return { version, size, isDark: (r, c) => q.isDark(r, c) };
  }
  throw new Error("QR_TOO_LONG");
}

/** Draws a QR onto a canvas, resizing it to (size + 2·margin)·scale pixels. Runs of dark modules are filled together. */
export function drawQr(canvas, qr, { scale = 4, margin = 4, dark = "#000", light = "#fff" } = {}) {
  const n = (qr.size + margin * 2) * scale;
  canvas.width = n;
  canvas.height = n;
  const ctx = canvas.getContext("2d");
  ctx.fillStyle = light;
  ctx.fillRect(0, 0, n, n);
  ctx.fillStyle = dark;
  for (let r = 0; r < qr.size; r++) {
    let c = 0;
    while (c < qr.size) {
      if (!qr.isDark(r, c)) { c++; continue; }
      const start = c;
      while (c < qr.size && qr.isDark(r, c)) c++;
      ctx.fillRect((start + margin) * scale, (r + margin) * scale, (c - start) * scale, scale);
    }
  }
  return canvas;
}

/**
 * A new <canvas> showing the QR at about `px` CSS pixels: whole-pixel modules on the device's screen,
 * so it stays crisp on high-density displays. The caller adds role/aria-label.
 */
export function qrCanvas(text, { px = 240, margin = 4, ecc = "M" } = {}) {
  const qr = makeQr(text, { ecc });
  const dpr = Math.max(1, Math.min(3, globalThis.devicePixelRatio || 1));
  const modules = qr.size + margin * 2;
  const scale = Math.max(1, Math.floor((px * dpr) / modules));
  const canvas = drawQr(document.createElement("canvas"), qr, { scale, margin });
  const css = `${canvas.width / dpr}px`;
  canvas.style.width = css;
  canvas.style.height = css;
  canvas.dataset.version = String(qr.version);
  return canvas;
}

/**
 * 1-bit image of the QR for ESC/POS raster printing: width rounded up to a multiple of 8,
 * 1 = black, MSB-first, row-major. → { width, height, bytesPerRow, data }
 */
export function qrRaster(qr, { scale = 4, margin = 4 } = {}) {
  const size = (qr.size + margin * 2) * scale;
  const width = Math.ceil(size / 8) * 8;
  const bytesPerRow = width / 8;
  const data = new Uint8Array(bytesPerRow * size);
  for (let y = 0; y < size; y++) {
    const r = Math.floor(y / scale) - margin;
    if (r < 0 || r >= qr.size) continue;
    for (let x = 0; x < size; x++) {
      const c = Math.floor(x / scale) - margin;
      if (c >= 0 && c < qr.size && qr.isDark(r, c)) data[y * bytesPerRow + (x >> 3)] |= 0x80 >> (x & 7);
    }
  }
  return { width, height: size, bytesPerRow, data };
}
