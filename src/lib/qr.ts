import "server-only";
import QRCode from "qrcode";

const QR_OPTS = { errorCorrectionLevel: "M" as const, margin: 1, color: { dark: "#2b2118", light: "#ffffff" } };

export function qrSvg(text: string) {
  return QRCode.toString(text, { ...QR_OPTS, type: "svg" });
}

export function qrPng(text: string, width = 1024) {
  return QRCode.toBuffer(text, { ...QR_OPTS, type: "png", width });
}
