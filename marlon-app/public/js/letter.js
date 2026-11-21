/**
 * The emailed / printed invoice: one US Letter page (8.5 × 11 in), laid out like a proper invoice — the business at
 * the top, the customer, a table of products (amount, price, line total), the total, the signature, the QR code and
 * "Thank you, <store>". However many products, it always fits on ONE page: if it would run over, everything is
 * drawn smaller to fit (the receipt-shaped copy for thermal printers is a separate thing: receipt.js).
 *
 *   renderLetterCanvas(inv) → canvas (2550 × 3300 px: 300 dpi)
 */
import { receiptModel, itemCountText } from "./receipt.js";
import { makeQr } from "./qr.js";
import { loadImage } from "./util.js";

export const LETTER_PT = { w: 612, h: 792 }; // 8.5 × 11 in, in PDF points
const DPI = 300;
const W = Math.round(8.5 * DPI), H = Math.round(11 * DPI);
const SANS = '-apple-system, BlinkMacSystemFont, "Helvetica Neue", Helvetica, Arial, sans-serif';
const INK = "#111", SOFT = "#555", LINE = "#bbb";

export async function renderLetterCanvas(inv) {
  const m = receiptModel(inv);
  const sig = m.signature ? await loadImage(m.signature).catch(() => null) : null;
  // Lay out at full size; if it doesn't fit, try again smaller (never below 45%).
  let k = 1, plan;
  for (let i = 0; i < 12; i++) {
    plan = layout(m, sig, k);
    if (plan.height <= H) break;
    k = Math.max(0.45, k * Math.min(0.95, (H / plan.height) * 0.99));
  }
  const canvas = document.createElement("canvas");
  canvas.width = W;
  canvas.height = H;
  const ctx = canvas.getContext("2d");
  ctx.fillStyle = "#fff";
  ctx.fillRect(0, 0, W, H);
  const fit = Math.min(1, H / plan.height); // last resort: squeeze whatever is left
  if (fit < 1) { ctx.translate(W * (1 - fit) / 2, 0); ctx.scale(fit, fit); }
  for (const op of plan.ops) draw(ctx, op);
  return canvas;
}

function layout(m, sig, k) {
  const px = (pt) => Math.round(pt * k * DPI / 72); // a size in points, at this scale
  const margin = Math.round(0.6 * DPI);
  const inner = W - margin * 2;
  const f = (weight, pt) => ({ css: `${weight} ${px(pt)}px ${SANS}`, px: px(pt) });
  const font = { company: f(800, 22), small: f(400, 10), label: f(700, 9), body: f(400, 11), bold: f(700, 11), head: f(700, 10), total: f(800, 15), big: f(800, 26), thanks: f(700, 13) };
  const meas = document.createElement("canvas").getContext("2d");
  const width = (s, fo) => { meas.font = fo.css; return meas.measureText(s).width; };
  const clip = (s, fo, max) => { if (width(s, fo) <= max) return s; while (s.length > 1 && width(s + "…", fo) > max) s = s.slice(0, -1); return s + "…"; };
  const ops = [];
  const text = (s, fo, x, y, align = "left", color = INK) => ops.push({ kind: "text", s, fo, x, y, align, color });
  let y = margin;

  // Header: the business (left) and INVOICE / number / date (right).
  const leftW = inner * 0.6;
  let ly = y + font.company.px;
  text(clip(m.seller || "Invoice", font.company, leftW), font.company, margin, ly);
  for (const line of [m.sellerAddress, m.sellerPhone ? `Tel: ${m.sellerPhone}` : ""].join("\n").split("\n").filter(Boolean)) {
    ly += Math.round(font.small.px * 1.45);
    text(clip(line, font.small, leftW), font.small, margin, ly, "left", SOFT);
  }
  let ry = y + font.big.px;
  text("INVOICE", font.big, W - margin, ry, "right");
  ry += Math.round(font.body.px * 1.7);
  text(`No. ${m.number}`, font.bold, W - margin, ry, "right");
  ry += Math.round(font.body.px * 1.45);
  text(m.dateText, font.body, W - margin, ry, "right", SOFT);
  y = Math.max(ly, ry) + px(18);
  ops.push({ kind: "rule", x1: margin, x2: W - margin, y, w: px(1.4), color: INK });
  y += px(16);

  // Bill to.
  if (m.store || m.address) {
    text("BILL TO", font.label, margin, y + font.label.px, "left", SOFT);
    y += font.label.px + px(6);
    if (m.store) { y += font.bold.px; text(clip(m.store, font.bold, inner), font.bold, margin, y); }
    for (const line of String(m.address || "").split("\n").filter(Boolean)) { y += Math.round(font.body.px * 1.4); text(clip(line, font.body, inner), font.body, margin, y, "left", SOFT); }
    y += px(18);
  }

  // The products table.
  const col = { qty: margin + inner * 0.58, price: margin + inner * 0.78, total: W - margin };
  const rowH = Math.round(font.body.px * 1.9);
  ops.push({ kind: "box", x: margin, y, w: inner, h: rowH, color: "#f1f1f1" });
  const base = (top) => top + Math.round(rowH / 2 + font.body.px * 0.36);
  text("PRODUCT", font.head, margin + px(8), base(y), "left", SOFT);
  text("AMOUNT", font.head, col.qty, base(y), "right", SOFT);
  text("PRICE", font.head, col.price, base(y), "right", SOFT);
  text("TOTAL", font.head, col.total - px(8), base(y), "right", SOFT);
  y += rowH;
  if (!m.items.length) { text("No items", font.body, margin + px(8), base(y), "left", SOFT); y += rowH; }
  for (const it of m.items) {
    text(clip(it.name, font.body, col.qty - margin - width("0000 dozen", font.body) - px(16)), font.body, margin + px(8), base(y));
    text(it.qtyText, font.body, col.qty, base(y), "right");
    text(it.priceText, font.body, col.price, base(y), "right", it.hasPrice ? INK : SOFT);
    text(it.totalText, font.body, col.total - px(8), base(y), "right");
    y += rowH;
    ops.push({ kind: "rule", x1: margin, x2: W - margin, y, w: px(0.6), color: LINE });
  }
  y += px(12);
  if (m.credit) {
    text("Subtotal", font.body, col.price - px(50), y + font.body.px, "right", SOFT);
    text(m.credit.subtotalText, font.body, col.total - px(8), y + font.body.px, "right");
    y += Math.round(font.body.px * 1.6);
    text(m.credit.label, font.body, col.price - px(50), y + font.body.px, "right", SOFT);
    text(m.credit.amountText, font.body, col.total - px(8), y + font.body.px, "right");
    y += Math.round(font.body.px * 1.6) + px(6);
  }
  text(itemCountText(m.itemCount), font.small, margin, y + font.total.px * 0.8, "left", SOFT);
  text("TOTAL", font.total, col.price - px(50), y + font.total.px, "right");
  text(m.totalText, font.total, col.total - px(8), y + font.total.px, "right");
  y += font.total.px + px(26);

  // Signature (left) and QR (right).
  const qr = makeQr(m.qrUrl, { ecc: "M" });
  const qrSize = px(96);
  const sigW = inner * 0.5, sigH = sig ? Math.round(sigW * (sig.naturalHeight / sig.naturalWidth || 1 / 3)) : px(30);
  const blockTop = y;
  text("Customer signature", font.label, margin, y + font.label.px, "left", SOFT);
  y += font.label.px + px(6);
  if (sig) ops.push({ kind: "image", img: sig, x: margin, y, w: sigW, h: sigH });
  else text(m.signed ? "✓ Signed by the customer" : "Not signed", font.body, margin, y + font.body.px + px(8), "left", m.signed ? INK : SOFT);
  y += sigH;
  ops.push({ kind: "rule", x1: margin, x2: margin + sigW, y: y + px(4), w: px(0.8), color: "#888" });
  if (m.signedBy) { y += px(6) + font.small.px; text(m.signedBy, font.small, margin, y + px(4), "left", SOFT); }
  ops.push({ kind: "qr", qr, x: W - margin - qrSize, y: blockTop, size: qrSize });
  text("Scan to see this invoice", font.small, W - margin - qrSize / 2, blockTop + qrSize + font.small.px + px(4), "center", SOFT);
  y = Math.max(y + px(10), blockTop + qrSize + font.small.px + px(10)) + px(22);

  // Thank you.
  text(m.thanks, font.thanks, W / 2, y + font.thanks.px, "center");
  y += font.thanks.px + margin;
  return { ops, height: y };
}

function draw(ctx, op) {
  if (op.kind === "text") {
    ctx.font = op.fo.css;
    ctx.fillStyle = op.color;
    ctx.textAlign = op.align;
    ctx.textBaseline = "alphabetic";
    ctx.fillText(op.s, op.x, op.y);
  } else if (op.kind === "rule") {
    ctx.strokeStyle = op.color;
    ctx.lineWidth = op.w;
    ctx.beginPath();
    ctx.moveTo(op.x1, op.y);
    ctx.lineTo(op.x2, op.y);
    ctx.stroke();
  } else if (op.kind === "box") {
    ctx.fillStyle = op.color;
    ctx.fillRect(op.x, op.y, op.w, op.h);
  } else if (op.kind === "image") {
    ctx.drawImage(op.img, op.x, op.y, op.w, op.h);
  } else if (op.kind === "qr") {
    const n = op.qr.size, mod = op.size / (n + 8);
    ctx.fillStyle = "#fff";
    ctx.fillRect(op.x, op.y, op.size, op.size);
    ctx.fillStyle = "#000";
    for (let r = 0; r < n; r++) for (let c = 0; c < n; c++) {
      if (op.qr.isDark(r, c)) ctx.fillRect(Math.floor(op.x + (c + 4) * mod), Math.floor(op.y + (r + 4) * mod), Math.ceil(mod), Math.ceil(mod));
    }
  }
}
