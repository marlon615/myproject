/**
 * A small PDF writer: each canvas becomes one US Letter page (612 × 792 points) holding that canvas as a JPEG.
 * No library, no server, works offline.   pagesToPdfBlob([canvas, …], { title }) → Blob (application/pdf)
 */
const enc = new TextEncoder();
const jpegOf = (canvas) => new Promise((ok, no) => canvas.toBlob((b) => (b ? ok(b) : no(new Error("Couldn't make the page picture."))), "image/jpeg", 0.88));

export async function pagesToPdfBlob(canvases, { title = "Marlon Pay" } = {}) {
  const W = 612, H = 792;
  const parts = [], offsets = [];
  let length = 0;
  const push = (d) => { const b = typeof d === "string" ? enc.encode(d) : d; parts.push(b); length += b.length; };
  const obj = (n, ...body) => { offsets[n] = length; push(`${n} 0 obj\n`); for (const b of body) push(b); push("\nendobj\n"); };
  push("%PDF-1.4\n"); push(new Uint8Array([0x25, 0xe2, 0xe3, 0xcf, 0xd3, 0x0a]));
  const n = canvases.length;
  // 1 catalog, 2 pages, 3 info; then for page i: page 4+3i, content 5+3i, image 6+3i
  obj(1, "<< /Type /Catalog /Pages 2 0 R >>");
  obj(2, `<< /Type /Pages /Count ${n} /Kids [${canvases.map((_, i) => `${4 + 3 * i} 0 R`).join(" ")}] >>`);
  obj(3, `<< /Title (${String(title).replace(/[()\\]/g, "")}) /Producer (Marlon Pay) >>`);
  for (let i = 0; i < n; i++) {
    const c = canvases[i];
    const jpeg = new Uint8Array(await (await jpegOf(c)).arrayBuffer());
    const content = `q ${W} 0 0 ${H} 0 0 cm /Im0 Do Q\n`;
    obj(4 + 3 * i, `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 ${W} ${H}] /Resources << /XObject << /Im0 ${6 + 3 * i} 0 R >> >> /Contents ${5 + 3 * i} 0 R >>`);
    obj(5 + 3 * i, `<< /Length ${content.length} >>\nstream\n${content}endstream`);
    obj(6 + 3 * i, `<< /Type /XObject /Subtype /Image /Width ${c.width} /Height ${c.height} /ColorSpace /DeviceRGB /BitsPerComponent 8 /Filter /DCTDecode /Length ${jpeg.length} >>\nstream\n`, jpeg, "\nendstream");
  }
  const xref = length, total = 4 + 3 * n;
  push(`xref\n0 ${total}\n0000000000 65535 f \n`);
  for (let i = 1; i < total; i++) push(`${String(offsets[i]).padStart(10, "0")} 00000 n \n`);
  push(`trailer\n<< /Size ${total} /Root 1 0 R /Info 3 0 R >>\nstartxref\n${xref}\n%%EOF\n`);
  return new Blob(parts, { type: "application/pdf" });
}
