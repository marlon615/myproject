// Exposes the print/PDF/share modules to tests/print.test.cjs.
import { receiptModel, renderReceiptCanvas } from "/js/receipt.js";
import { canvasToPdfBlob } from "/js/pdf.js";
import { buildEscPos, printInvoice, savedPrinterName, forgetPrinter } from "/js/printer.js";
import { shareInvoicePdf, shareInvoiceImage } from "/js/share.js";
import { invoiceToUrl } from "/js/codec.js";
import { settings, init } from "/js/db.js";

const toB64 = async (blob) => { const b = new Uint8Array(await blob.arrayBuffer()); let s = ""; for (let i = 0; i < b.length; i += 0x8000) s += String.fromCharCode(...b.subarray(i, i + 0x8000)); return btoa(s); };

function signature() {
  const c = document.createElement("canvas"); c.width = 900; c.height = 300;
  const x = c.getContext("2d"); x.strokeStyle = "#000"; x.lineWidth = 6; x.lineCap = "round";
  x.beginPath(); x.moveTo(120, 210); x.bezierCurveTo(200, 40, 260, 260, 340, 120); x.bezierCurveTo(420, 20, 480, 250, 560, 150); x.lineTo(780, 170); x.stroke();
  return c.toDataURL("image/png");
}

window.sample = (n = 3, signed = true) => {
  const names = ["Beetroot Juice", "Mini Bammy", "Coconut Water Café", "Cucumber Juice", "Pumpkin Punch", "Green Juice", "Large Bammy", "Juicify Drink Grape", "Juicify Drink Fruit Punch", "Hot Pepper", "Shredded Callaloo", "Lemons", "Limes", "Grapefruit", "Okra", "Sorrel Drink 1L Bottle", "Ginger Beer Crate", "Sweet Potato Pudding"];
  return { id: "inv_test", number: 7, seller: "Marlon Williams", store: "Rose Hall Grocery & Wholesale", address: "12 Main Street\nMontego Bay, St James", date: "2026-11-10",
    items: names.slice(0, n).map((name, i) => ({ productId: "p" + i, name, qty: i === 1 ? 24 : 12 + i, price: i === 2 ? null : 350 + i * 25 })),
    signature: signed ? signature() : null, signedAt: signed ? "2026-11-10T19:45:00Z" : null };
};
window.T = {
  receiptPng: async (n, paper) => { const c = await renderReceiptCanvas(window.sample(n), { paper, scale: 2 }); return { w: c.width, h: c.height, png: c.toDataURL("image/png") }; },
  pdfB64: async (n, paper) => { const c = await renderReceiptCanvas(window.sample(n), { paper, scale: 2 }); return toB64(await canvasToPdfBlob(c, { widthMm: paper, title: "Invoice 0007 - Rose Hall" })); },
  escpos: (n, paper) => Array.from(buildEscPos(receiptModel(window.sample(n, false)), { paper })),
  url: (n) => invoiceToUrl(window.sample(n)),
  print: (n) => printInvoice(window.sample(n)),
  share: (kind) => (kind === "png" ? shareInvoiceImage : shareInvoicePdf)(window.sample(3)),
  setPaper: (p) => settings.set("paper", p),
  savedPrinterName, forgetPrinter,
};
init().then(() => { window.ready = true; });
