/**
 * Share the receipt as a PDF (or a picture) through the phone's share sheet, so it can go to a printer's
 * app, WhatsApp, email or Files. Falls back to downloading where sharing files isn't supported.
 */
import { settings } from "./db.js";
import { canvasToPdfBlob } from "./pdf.js";
import { renderReceiptCanvas } from "./receipt.js";
import { LETTER_PT, renderLetterCanvas } from "./letter.js";
import { choiceSheet, toast } from "./ui.js";
import { fileSafe, h, invoiceNo, withTotals } from "./util.js";

/** The invoice to email or print on paper: one US Letter page. → "shared" | "downloaded" | "cancelled" | "failed" */
export function shareInvoicePdf(inv) {
  return shareReceipt(inv, "letter");
}

/**
 * Receipt size: a narrow copy for a 58 mm or 80 mm thermal printer, as a pure black-and-white picture exactly the
 * printer's width (384 or 576 dots), for the share sheet → the Bluetooth printer's app. Works on iPhone and Android.
 */
export function shareReceiptSize(inv, paper) {
  return shareReceipt(inv, "thermal", paper === 80 ? 80 : 58);
}

/** Asks 58 mm or 80 mm (the last choice first), then shares the receipt-size copy. */
export async function chooseReceiptSize(inv) {
  const last = Number(await settings.get("paper", 58)) === 80 ? 80 : 58;
  const choice = await choiceSheet({
    title: "Receipt size",
    message: h("p", {}, "A narrow copy for a thermal receipt printer. Choose your paper width, then pick your printer's app in the Share menu."),
    choices: [{ label: "Not now", value: null }, { label: "58 mm", value: 58, primary: last === 58 }, { label: "80 mm", value: 80, primary: last === 80 }],
  });
  if (!choice) return "cancelled";
  await settings.set("paper", choice);
  return shareReceiptSize(inv, choice);
}

/** Same, as a PNG picture (some printer apps only accept pictures). */
export function shareInvoiceImage(inv) {
  return shareReceipt(inv, "png");
}

async function shareReceipt(inv, kind, paper) {
  const t = withTotals(inv);
  if (!t.items.length) { toast("Tick at least one product first."); return "failed"; }
  let file;
  try {
    file = await makeReceiptFile(t, { kind, paper });
  } catch (e) {
    console.error(e);
    toast("Couldn't make the file. Please try again.");
    return "failed";
  }
  return deliverFile(file, `Invoice ${invoiceNo(t.number)}${t.store ? " · " + t.store : ""}`);
}

/**
 * The invoice as a File, named like Invoice-0007-Hill-Top-Grocery.pdf:
 *   kind "letter"  — the emailed / printed invoice: a one-page US Letter PDF
 *   kind "thermal" — receipt size for a 58 / 80 mm thermal printer: a black-and-white PNG exactly 384 / 576 dots wide
 *   kind "pdf" / "png" — the receipt-shaped PDF or picture (paper 58 | 80, default the owner's paper setting)
 */
export async function makeReceiptFile(inv, { kind = "pdf", paper } = {}) {
  const t = withTotals(inv);
  const name = `Invoice-${invoiceNo(t.number)}-${fileSafe(t.store || "invoice")}`;
  const title = `Invoice ${invoiceNo(t.number)}${t.store ? " - " + t.store : ""}`;
  if (kind === "letter") {
    const blob = await canvasToPdfBlob(await renderLetterCanvas(t), { page: LETTER_PT, title });
    return new File([blob], `${name}.pdf`, { type: "application/pdf" });
  }
  paper = paper === 58 || paper === 80 ? paper : Number(await settings.get("paper", 58)) === 80 ? 80 : 58;
  if (kind === "thermal") {
    const c = await renderReceiptCanvas(t, { paper, scale: 1, mono: true });
    const blob = await new Promise((resolve, reject) => c.toBlob((b) => (b ? resolve(b) : reject(new Error("png"))), "image/png"));
    return new File([blob], `Receipt-${paper}mm-${invoiceNo(t.number)}-${fileSafe(t.store || "invoice")}.png`, { type: "image/png" });
  }
  const canvas = await renderReceiptCanvas(t, { paper, scale: 2 });
  if (kind === "pdf") {
    const blob = await canvasToPdfBlob(canvas, { widthMm: paper, title: `Invoice ${invoiceNo(t.number)}${t.store ? " - " + t.store : ""}` });
    return new File([blob], `${name}.pdf`, { type: "application/pdf" });
  }
  const blob = await new Promise((resolve, reject) => canvas.toBlob((b) => (b ? resolve(b) : reject(new Error("png"))), "image/png"));
  return new File([blob], `${name}.png`, { type: "image/png" });
}

/** Hands a file to the phone's share sheet (Save to Files, WhatsApp, a printer app…), or downloads it. */
export async function deliverFile(file, title) {
  if (navigator.canShare?.({ files: [file] })) {
    try {
      await navigator.share({ files: [file], title });
      return "shared";
    } catch (e) {
      if (e?.name === "AbortError") return "cancelled";
      if (e?.name !== "NotAllowedError") { console.error(e); toast("Sharing didn't work, so the file was saved instead."); download(file); return "downloaded"; }
      // The tap that started this is too old for the browser (it took a moment to make the file): ask for a fresh tap.
      const choice = await choiceSheet({
        title: "Your file is ready",
        message: file.name,
        choices: [{ label: "Save to phone", value: "save" }, { label: "Share", value: "share", primary: true }],
      });
      if (choice === "share") {
        try { await navigator.share({ files: [file], title }); return "shared"; } catch (e2) { if (e2?.name === "AbortError") return "cancelled"; }
      }
      if (choice === null) return "cancelled";
      download(file);
      return "downloaded";
    }
  }
  download(file);
  toast("Saved to your downloads.");
  return "downloaded";
}

function download(file) {
  const url = URL.createObjectURL(file);
  const a = h("a", { href: url, download: file.name, style: "display:none" });
  document.body.append(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 60_000);
}
