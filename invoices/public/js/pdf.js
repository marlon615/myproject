/**
 * A minimal, valid single-page PDF 1.4 made from a canvas: the canvas becomes a JPEG embedded with
 * /DCTDecode (PDF readers decode JPEG natively), on a page exactly `widthMm` wide. No libraries, offline.
 */
import { SELLER, asciiFold } from "./util.js";

const enc = new TextEncoder();

/** PDF literal string: printable ASCII with \, ( and ) escaped. */
const pdfString = (s) => "(" + asciiFold(s).replace(/[\\()]/g, (c) => "\\" + c) + ")";

const pdfDate = (d = new Date()) => {
  const p = (n) => String(n).padStart(2, "0");
  return `D:${d.getUTCFullYear()}${p(d.getUTCMonth() + 1)}${p(d.getUTCDate())}${p(d.getUTCHours())}${p(d.getUTCMinutes())}${p(d.getUTCSeconds())}Z`;
};

function canvasJpeg(canvas, quality) {
  return new Promise((resolve, reject) => {
    canvas.toBlob((b) => (b ? resolve(b) : reject(new Error("Couldn't make the receipt picture."))), "image/jpeg", quality);
  });
}

/** → Blob (application/pdf) */
export async function canvasToPdfBlob(canvas, { widthMm = 58, title = "Invoice" } = {}) {
  const jpeg = new Uint8Array(await (await canvasJpeg(canvas, 0.92)).arrayBuffer());
  const w = +(widthMm * 72 / 25.4).toFixed(2);
  const h = +(w * canvas.height / canvas.width).toFixed(2);
  const content = `q ${w} 0 0 ${h} 0 0 cm /Im0 Do Q\n`;

  const parts = [];
  const offsets = [];
  let length = 0;
  const push = (data) => { const bytes = typeof data === "string" ? enc.encode(data) : data; parts.push(bytes); length += bytes.length; };
  const obj = (n, body) => { offsets[n] = length; push(`${n} 0 obj\n`); for (const b of [].concat(body)) push(b); push("\nendobj\n"); };

  push("%PDF-1.4\n");
  push(new Uint8Array([0x25, 0xe2, 0xe3, 0xcf, 0xd3, 0x0a])); // "%âãÏÓ" comment: tells tools the file is binary

  obj(1, "<< /Type /Catalog /Pages 2 0 R >>");
  obj(2, "<< /Type /Pages /Kids [3 0 R] /Count 1 >>");
  obj(3, `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 ${w} ${h}] /Resources << /XObject << /Im0 4 0 R >> /ProcSet [/PDF /ImageC] >> /Contents 5 0 R >>`);
  obj(4, [
    `<< /Type /XObject /Subtype /Image /Width ${canvas.width} /Height ${canvas.height} /ColorSpace /DeviceRGB /BitsPerComponent 8 /Filter /DCTDecode /Length ${jpeg.length} >>\nstream\n`,
    jpeg,
    "\nendstream",
  ]);
  obj(5, `<< /Length ${enc.encode(content).length} >>\nstream\n${content}endstream`);
  obj(6, `<< /Title ${pdfString(title)} /Author ${pdfString(SELLER)} /Creator (Marlon Williams Invoices) /Producer (Marlon Williams Invoices) /CreationDate (${pdfDate()}) >>`);

  const xrefAt = length;
  let xref = "xref\n0 7\n0000000000 65535 f \n";
  for (let n = 1; n <= 6; n++) xref += `${String(offsets[n]).padStart(10, "0")} 00000 n \n`;
  push(xref);
  push(`trailer\n<< /Size 7 /Root 1 0 R /Info 6 0 R >>\nstartxref\n${xrefAt}\n%%EOF\n`);

  return new Blob(parts, { type: "application/pdf" });
}
