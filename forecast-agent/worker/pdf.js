/**
 * A one-page US Letter invoice PDF, written directly (PDF 1.4, the two built-in Helvetica fonts, no libraries).
 * Text is WinAnsi (Latin-1); other characters print as "?".
 */
const WINANSI = { "\u2014": "\x97", "\u2013": "\x96", "\u2018": "\x91", "\u2019": "\x92", "\u201c": "\x93", "\u201d": "\x94", "\u2022": "\x95", "\u20ac": "\x80", "\u2026": "\x85" };
const esc = (s) => String(s ?? "").replace(/[\u2013\u2014\u2018\u2019\u201c\u201d\u2022\u20ac\u2026]/g, (c) => WINANSI[c]).replace(/[^\x20-\x7e\x80-\xff]/g, "?").replace(/\\/g, "\\\\").replace(/\(/g, "\\(").replace(/\)/g, "\\)");
const money = (c) => `$${(c / 100).toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
const nice = (s) => (s ? new Date(`${s}T00:00:00Z`).toLocaleDateString("en-US", { timeZone: "UTC", month: "long", day: "numeric", year: "numeric" }) : "");
function wrap(text, width) {
  const out = [];
  for (const para of String(text || "").split(/\r?\n/)) {
    let line = "";
    for (const w of para.split(/\s+/)) { if ((line + " " + w).trim().length > width) { if (line) out.push(line); line = w; } else line = (line + " " + w).trim(); }
    out.push(line);
  }
  return out;
}

export function invoicePdf({ seller, buyer, invoice, instructions, contact }) {
  const ops = [];
  const text = (x, y, s, size = 10, bold = false, gray = 0.1) => ops.push(`BT /F${bold ? 2 : 1} ${size} Tf ${gray} g ${x} ${y} Td (${esc(s)}) Tj ET`);
  const right = (x, y, s, size = 10, bold = false) => text(x - String(s).length * size * (bold ? 0.56 : 0.5), y, s, size, bold); // close enough for Helvetica digits
  const rule = (y) => ops.push(`0.85 0.87 0.9 RG 0.8 w 54 ${y} m 558 ${y} l S`);
  // Header band
  ops.push("0.122 0.373 0.749 rg 0 732 612 60 re f");
  ops.push(`BT /F2 24 Tf 1 g 54 752 Td (${esc("Draxly")}) Tj ET`);
  ops.push(`BT /F1 10 Tf 1 g 140 756 Td (${esc("Know what to stock before you need it.")}) Tj ET`);
  ops.push(`BT /F2 18 Tf 1 g 470 752 Td (INVOICE) Tj ET`);
  let y = 700;
  text(54, y, seller || "Draxly", 11, true);
  right(558, y, `Invoice ${invoice.number}`, 11, true);
  y -= 16; right(558, y, `Issued: ${nice(invoice.issued)}`);
  y -= 14; right(558, y, `Due: ${nice(invoice.due)}`, 10, true);
  y = 650; text(54, y, "BILL TO", 8, true, 0.45); y -= 15; text(54, y, buyer, 12, true);
  y = 590; rule(y + 14);
  text(54, y, "Description", 9, true, 0.45); text(360, y, "Period", 9, true, 0.45); right(558, y, "Amount", 9, true);
  rule(y - 8); y -= 26;
  const desc = wrap(invoice.description, 52);
  desc.forEach((l, i) => text(54, y - i * 13, l, 10));
  text(360, y, `${nice(invoice.periodStart)} -`, 9); text(360, y - 12, nice(invoice.periodEnd), 9);
  right(558, y, money(invoice.amountCents), 10);
  y -= Math.max(desc.length, 2) * 13 + 12; rule(y + 4);
  y -= 16; text(380, y, "Total due (USD)", 11, true); right(558, y, money(invoice.amountCents), 12, true);
  if (invoice.status === "paid") {
    ops.push(`q 0.1 0.5 0.26 RG 2 w 0.1 0.5 0.26 rg 400 ${y - 50} 158 30 re S BT /F2 16 Tf 420 ${y - 42} Td (PAID ${esc(nice(invoice.paidAt))}) Tj ET Q`.replace("/F2 16", "/F2 11"));
  }
  y -= 80;
  text(54, y, "HOW TO PAY", 8, true, 0.45); y -= 15;
  for (const l of wrap(instructions || "Payment instructions will be sent separately.", 95).slice(0, 12)) { text(54, y, l, 10); y -= 13; }
  y -= 8; text(54, y, `Please include the invoice number ${invoice.number} with your payment.`, 9, false, 0.4);
  if (contact) { y -= 14; text(54, y, `Questions about this invoice? Email ${contact}`, 9, false, 0.4); }
  const terms = [
    "Draxly Enterprise: $30,000 per company per year on a one-year agreement, paid upfront or $2,500 a month by invoice.",
    "The agreement renews automatically each year unless cancelled. If cancelled early, the rest of the year is still owed.",
  ];
  terms.forEach((l, i) => text(54, 60 - i * 12, l, 8, false, 0.45));
  const content = ops.join("\n");
  const objs = [
    "<< /Type /Catalog /Pages 2 0 R >>",
    "<< /Type /Pages /Kids [3 0 R] /Count 1 >>",
    "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 4 0 R /F2 5 0 R >> >> /Contents 6 0 R >>",
    "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica /Encoding /WinAnsiEncoding >>",
    "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica-Bold /Encoding /WinAnsiEncoding >>",
    `<< /Length ${latin1(content).length} >>\nstream\n${content}\nendstream`,
    `<< /Title (${esc(`Draxly invoice ${invoice.number}`)}) /Producer (Draxly) >>`,
  ];
  let pdf = "%PDF-1.4\n%\xe2\xe3\xcf\xd3\n";
  const offsets = [];
  objs.forEach((o, i) => { offsets.push(latin1(pdf).length); pdf += `${i + 1} 0 obj\n${o}\nendobj\n`; });
  const xref = latin1(pdf).length;
  pdf += `xref\n0 ${objs.length + 1}\n0000000000 65535 f \n` + offsets.map((o) => `${String(o).padStart(10, "0")} 00000 n \n`).join("");
  pdf += `trailer\n<< /Size ${objs.length + 1} /Root 1 0 R /Info 7 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
  return latin1(pdf);
}
/** String (chars 0–255) → bytes, one byte per character. */
function latin1(s) { const b = new Uint8Array(s.length); for (let i = 0; i < s.length; i++) b[i] = s.charCodeAt(i) & 255; return b; }
export const toBase64 = (bytes) => { let s = ""; for (let i = 0; i < bytes.length; i += 0x8000) s += String.fromCharCode(...bytes.subarray(i, i + 0x8000)); return btoa(s); };
