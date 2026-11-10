/**
 * Share the receipt as a PDF (or a picture) through the phone's share sheet, so it can go to a printer's
 * app, WhatsApp, email or Files. Falls back to downloading where sharing files isn't supported.
 */
import { settings } from "./db.js";
import { canvasToPdfBlob } from "./pdf.js";
import { renderReceiptCanvas } from "./receipt.js";
import { choiceSheet, toast } from "./ui.js";
import { fileSafe, h, invoiceNo, withTotals } from "./util.js";

/** → "shared" | "downloaded" | "cancelled" | "failed" */
export function shareInvoicePdf(inv) {
  return shareReceipt(inv, "pdf");
}

/** Same, as a PNG picture (some printer apps only accept pictures). */
export function shareInvoiceImage(inv) {
  return shareReceipt(inv, "png");
}

async function shareReceipt(inv, kind) {
  const t = withTotals(inv);
  if (!t.items.length) { toast("Tick at least one product first."); return "failed"; }
  let file;
  try {
    file = await makeFile(t, kind);
  } catch (e) {
    console.error(e);
    toast("Couldn't make the file. Please try again.");
    return "failed";
  }
  return deliver(file, t);
}

async function makeFile(t, kind) {
  const paper = Number(await settings.get("paper", 58)) === 80 ? 80 : 58;
  const canvas = await renderReceiptCanvas(t, { paper, scale: 2 });
  const name = `Invoice-${invoiceNo(t.number)}-${fileSafe(t.store || "invoice")}`;
  if (kind === "pdf") {
    const blob = await canvasToPdfBlob(canvas, { widthMm: paper, title: `Invoice ${invoiceNo(t.number)}${t.store ? " - " + t.store : ""}` });
    return new File([blob], `${name}.pdf`, { type: "application/pdf" });
  }
  const blob = await new Promise((resolve, reject) => canvas.toBlob((b) => (b ? resolve(b) : reject(new Error("png"))), "image/png"));
  return new File([blob], `${name}.png`, { type: "image/png" });
}

async function deliver(file, t) {
  const title = `Invoice ${invoiceNo(t.number)}${t.store ? " · " + t.store : ""}`;
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
