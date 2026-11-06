import "server-only";
import { PDFDocument, StandardFonts, rgb, type PDFFont, type PDFPage } from "pdf-lib";
import { qrPng } from "@/lib/qr";

const INK = rgb(0.17, 0.13, 0.09);
const MUTED = rgb(0.45, 0.39, 0.33);
const ACCENT = rgb(0.71, 0.36, 0.2);
const CUT = rgb(0.8, 0.77, 0.72);

/** Standard PDF fonts only cover WinAnsi; swap/strip anything else so drawing never throws. */
function safe(s: string) {
  return s
    .replace(/[‘’]/g, "'")
    .replace(/[“”]/g, '"')
    .replace(/[–—]/g, "-")
    .replace(/…/g, "...")
    .replace(/[^\x20-\x7E\xA0-\xFF\n]/g, "");
}

function wrap(text: string, font: PDFFont, size: number, maxWidth: number): string[] {
  const lines: string[] = [];
  for (const para of safe(text).split(/\n/)) {
    let line = "";
    for (const word of para.split(/\s+/).filter(Boolean)) {
      const next = line ? `${line} ${word}` : word;
      if (font.widthOfTextAtSize(next, size) <= maxWidth) line = next;
      else {
        if (line) lines.push(line);
        line = word;
      }
    }
    if (line) lines.push(line);
  }
  return lines;
}

function centered(page: PDFPage, text: string, font: PDFFont, size: number, cx: number, y: number, color = INK) {
  const w = font.widthOfTextAtSize(text, size);
  page.drawText(text, { x: cx - w / 2, y, size, font, color });
}

/**
 * Letter-size PDF with four 4.25" x 5.5" pew cards (cut along the dotted lines).
 */
export async function buildPewCardPdf(opts: { churchName: string; serviceTimes: string; guestUrl: string }) {
  const pdf = await PDFDocument.create();
  pdf.setTitle(`${safe(opts.churchName)} - Pew Cards`);
  pdf.setCreator("ChurchFollow");
  const page = pdf.addPage([612, 792]);
  const serif = await pdf.embedFont(StandardFonts.TimesRomanBold);
  const sans = await pdf.embedFont(StandardFonts.Helvetica);
  const sansBold = await pdf.embedFont(StandardFonts.HelveticaBold);
  const qr = await pdf.embedPng(await qrPng(opts.guestUrl, 900));

  const W = 306, H = 396;
  const displayUrl = opts.guestUrl.replace(/^https?:\/\//, "");
  const services = opts.serviceTimes.split(/\r?\n/).map((s) => s.trim()).filter(Boolean).slice(0, 3);

  for (let col = 0; col < 2; col++) {
    for (let row = 0; row < 2; row++) {
      const x0 = col * W, y0 = row * H, cx = x0 + W / 2;
      let y = y0 + H - 46;

      centered(page, "WELCOME", sansBold, 9, cx, y, ACCENT);
      y -= 26;
      const nameSize = serif.widthOfTextAtSize(safe(opts.churchName), 20) > W - 40 ? 15 : 20;
      for (const line of wrap(opts.churchName, serif, nameSize, W - 40).slice(0, 2)) {
        centered(page, line, serif, nameSize, cx, y);
        y -= nameSize + 4;
      }
      y -= 4;
      centered(page, "We're so glad you're here today.", sans, 10.5, cx, y, MUTED);

      const qrSize = 150;
      y -= qrSize + 16;
      page.drawImage(qr, { x: cx - qrSize / 2, y, width: qrSize, height: qrSize });

      y -= 22;
      centered(page, "Scan with your phone camera to say hi", sansBold, 10.5, cx, y);
      y -= 14;
      centered(page, "No app needed - takes 20 seconds", sans, 9, cx, y, MUTED);
      y -= 14;
      const urlSize = sans.widthOfTextAtSize(displayUrl, 8) > W - 30 ? 6.5 : 8;
      centered(page, safe(displayUrl), sans, urlSize, cx, y, MUTED);

      y -= 22;
      for (const s of services) {
        const line = wrap(s, sans, 8.5, W - 40)[0] ?? "";
        centered(page, line, sans, 8.5, cx, y, INK);
        y -= 12;
      }
    }
  }

  // Dotted cut lines
  const dash = { dashArray: [3, 4], thickness: 0.6, color: CUT };
  page.drawLine({ start: { x: W, y: 0 }, end: { x: W, y: 792 }, ...dash });
  page.drawLine({ start: { x: 0, y: H }, end: { x: 612, y: H }, ...dash });

  return pdf.save();
}
