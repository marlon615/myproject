/**
 * The paper receipt: one layout model (used by the Bluetooth printer) and a canvas renderer (used for the
 * PDF and the picture). Only ticked products (inv.items) appear.
 */
import { invoiceToUrl } from "./codec.js";
import { makeQr } from "./qr.js";
import { SELLER, invoiceNo, loadImage, money, prettyDate, qtyText, tidy, withTotals } from "./util.js";

/** Everything the receipt shows, as ready-to-print text. */
export function receiptModel(inv) {
  const t = withTotals(inv);
  return {
    seller: t.seller || SELLER,
    number: invoiceNo(t.number),
    dateText: prettyDate(t.date),
    store: tidy(t.store),
    address: tidy(t.address),
    items: t.items.map((it) => ({
      name: it.name,
      qtyText: qtyText(it.qty) || "0",
      priceText: it.price === null ? "(no price)" : money(it.price),
      totalText: money(it.total),
      hasPrice: it.price !== null,
    })),
    totalText: money(t.total),
    itemCount: t.items.length,
    signed: Boolean(t.signature),
    signature: t.signature || null,
    qrUrl: invoiceToUrl(t),
  };
}

export const itemCountText = (n) => `${n} item${n === 1 ? "" : "s"}`;

const SERIF = 'ui-serif, "Iowan Old Style", Georgia, "Times New Roman", serif';
const SANS = '-apple-system, BlinkMacSystemFont, "Helvetica Neue", Helvetica, Arial, sans-serif';
const INK = "#000";
const SOFT = "#3a3a3a";

/**
 * Renders the receipt on a white canvas. paper 58 | 80 → 384 | 576 dots wide (203 dpi printers), × scale.
 * → HTMLCanvasElement
 */
export async function renderReceiptCanvas(inv, { paper = 58, scale = 2, includeQr = true } = {}) {
  const m = receiptModel(inv);
  const W = (paper === 80 ? 576 : 384) * scale;
  const pad = Math.round(W * 0.06);
  const inner = W - pad * 2;
  const s = scale;
  const font = {
    title: { css: `700 ${31 * s}px ${SERIF}`, px: 31 * s },
    sub: { css: `500 ${16 * s}px ${SANS}`, px: 16 * s },
    body: { css: `400 ${19 * s}px ${SANS}`, px: 19 * s },
    bold: { css: `700 ${19 * s}px ${SANS}`, px: 19 * s },
    small: { css: `400 ${15.5 * s}px ${SANS}`, px: 15.5 * s },
    total: { css: `800 ${25 * s}px ${SANS}`, px: 25 * s },
  };

  const measure = document.createElement("canvas").getContext("2d");
  const width = (str, f) => { measure.font = f.css; return measure.measureText(str).width; };
  const ops = [];
  let y = pad;

  const wrap = (str, f, maxW) => {
    const out = [];
    for (const para of String(str).split("\n")) {
      let line = "";
      for (const word of para.split(/\s+/).filter(Boolean)) {
        const test = line ? `${line} ${word}` : word;
        if (width(test, f) <= maxW) { line = test; continue; }
        if (line) out.push(line);
        // A single word wider than the line is broken by characters.
        let w = word;
        while (width(w, f) > maxW && w.length > 1) {
          let cut = w.length - 1;
          while (cut > 1 && width(w.slice(0, cut), f) > maxW) cut--;
          out.push(w.slice(0, cut));
          w = w.slice(cut);
        }
        line = w;
      }
      out.push(line);
    }
    return out;
  };
  const lineH = (f) => Math.round(f.px * 1.36);
  const text = (str, f, { align = "left", color = INK } = {}) => {
    for (const line of wrap(str, f, inner)) {
      const x = align === "center" ? W / 2 : align === "right" ? W - pad : pad;
      ops.push({ kind: "text", str: line, f, x, y: y + f.px, align, color });
      y += lineH(f);
    }
  };
  /** Left text and right-aligned amount on one line; the left side wraps if they don't fit together. */
  const lr = (left, right, f, { color = INK, indent = 0 } = {}) => {
    const rw = width(right, f), gapW = 14 * s, room = inner - indent;
    const lines = wrap(left, f, room);
    const last = lines.length - 1;
    lines.forEach((line, i) => {
      ops.push({ kind: "text", str: line, f, x: pad + indent, y: y + f.px, align: "left", color });
      if (i === last && width(line, f) + gapW + rw <= room) ops.push({ kind: "text", str: right, f, x: W - pad, y: y + f.px, align: "right", color });
      y += lineH(f);
      if (i === last && width(line, f) + gapW + rw > room) {
        ops.push({ kind: "text", str: right, f, x: W - pad, y: y + f.px, align: "right", color });
        y += lineH(f);
      }
    });
  };
  const gap = (px) => { y += Math.round(px * s); };
  const rule = (dashed = true) => { gap(7); ops.push({ kind: "rule", y: Math.round(y) + 0.5 * s, dashed }); gap(9); };

  // Header
  text(m.seller.toUpperCase(), font.title, { align: "center" });
  gap(1);
  text("Delivery invoice", font.sub, { align: "center", color: SOFT });
  gap(12);
  lr(`No. ${m.number}`, m.dateText, font.bold);
  gap(4);
  if (m.store) text(`Store: ${m.store}`, font.body);
  if (m.address) text(m.address, font.body, { color: SOFT });
  rule();

  // Items
  if (!m.items.length) text("No items", font.body, { color: SOFT });
  for (const it of m.items) {
    text(it.name, font.bold);
    lr(`${it.qtyText} x ${it.priceText}`, it.totalText, font.body, { indent: 14 * s });
    gap(3);
  }
  rule(false);
  lr("TOTAL", m.totalText, font.total);
  text(itemCountText(m.itemCount), font.small, { color: SOFT });

  // Signature
  gap(16);
  text("Customer signature:", font.small, { color: SOFT });
  if (m.signature) {
    try {
      const img = await loadImage(m.signature);
      const w = Math.round(inner * 0.72), h = Math.round(w * (img.naturalHeight / img.naturalWidth || 1 / 3));
      gap(4);
      ops.push({ kind: "image", img, x: Math.round((W - w) / 2), y: Math.round(y), w, h });
      y += h;
    } catch {
      text("Signed", font.body);
    }
  } else {
    gap(6);
    text("Not signed", font.body, { align: "center", color: SOFT });
  }
  ops.push({ kind: "line", x1: pad + inner * 0.1, x2: W - pad - inner * 0.1, y: Math.round(y) + 0.5 * s });
  gap(6);

  // QR code
  if (includeQr) {
    gap(16);
    const qr = makeQr(m.qrUrl, { ecc: "M" });
    const mod = Math.max(2, Math.floor((inner * 0.64) / (qr.size + 8)));
    const size = (qr.size + 8) * mod;
    ops.push({ kind: "qr", qr, mod, x: Math.round((W - size) / 2), y: Math.round(y), size });
    y += size;
    gap(4);
    text("Scan to see this invoice on your phone", font.small, { align: "center", color: SOFT });
  }
  y += pad;

  // Draw
  const canvas = document.createElement("canvas");
  canvas.width = W;
  canvas.height = Math.ceil(y);
  const ctx = canvas.getContext("2d");
  ctx.fillStyle = "#fff";
  ctx.fillRect(0, 0, canvas.width, canvas.height);
  ctx.textBaseline = "alphabetic";
  for (const op of ops) {
    if (op.kind === "text") {
      ctx.font = op.f.css;
      ctx.fillStyle = op.color;
      ctx.textAlign = op.align;
      ctx.fillText(op.str, op.x, op.y);
    } else if (op.kind === "rule") {
      ctx.strokeStyle = INK;
      ctx.lineWidth = s;
      ctx.setLineDash(op.dashed ? [5 * s, 4 * s] : []);
      ctx.beginPath();
      ctx.moveTo(pad, op.y);
      ctx.lineTo(W - pad, op.y);
      ctx.stroke();
      ctx.setLineDash([]);
    } else if (op.kind === "line") {
      ctx.strokeStyle = "#9a9a9a";
      ctx.lineWidth = s;
      ctx.beginPath();
      ctx.moveTo(op.x1, op.y);
      ctx.lineTo(op.x2, op.y);
      ctx.stroke();
    } else if (op.kind === "image") {
      ctx.drawImage(op.img, op.x, op.y, op.w, op.h);
    } else if (op.kind === "qr") {
      ctx.fillStyle = "#fff";
      ctx.fillRect(op.x, op.y, op.size, op.size);
      ctx.fillStyle = INK;
      for (let r = 0; r < op.qr.size; r++) {
        for (let c = 0; c < op.qr.size; c++) {
          if (op.qr.isDark(r, c)) ctx.fillRect(op.x + (c + 4) * op.mod, op.y + (r + 4) * op.mod, op.mod, op.mod);
        }
      }
    }
  }
  return canvas;
}
