/**
 * The customer's thank-you, after they sign and tap Done: a green checkmark that draws itself,
 * "Thank you, <store>", the invoice number and the total, for about two seconds with a gentle haptic tap.
 * A tap (or Esc) skips it. Then the invoice with its QR code is back.
 *
 * buzz()                               one short, gentle haptic tap; call it straight from the tap
 * showThanks({ store, number, total }) → Promise, resolves when it has gone
 */
import { h, invoiceNo, money } from "./util.js";

const SHOW_MS = 2000;   // on screen this long (the drawing takes the first ~0.9 s)
const FADE_MS = 300;
const NS = "http://www.w3.org/2000/svg";

/** One gentle haptic tap. Android: vibrate(). iPhone (Safari 18+, no vibrate()): a hidden switch toggle gives a light tick. */
export function buzz() {
  try {
    if (typeof navigator.vibrate === "function" && navigator.vibrate(35)) return;
  } catch { /* not allowed here */ }
  try {
    const label = document.createElement("label");
    label.setAttribute("aria-hidden", "true");
    label.style.display = "none";
    const input = document.createElement("input");
    input.type = "checkbox";
    input.setAttribute("switch", "");
    label.append(input);
    document.head.append(label);
    label.click();
    label.remove();
  } catch { /* this phone has no haptics */ }
}

function svgEl(tag, attrs) {
  const node = document.createElementNS(NS, tag);
  for (const [k, v] of Object.entries(attrs)) node.setAttribute(k, v);
  return node;
}

function checkmark() {
  const svg = svgEl("svg", { viewBox: "0 0 96 96", class: "thanks-check", "aria-hidden": "true" });
  svg.append(
    svgEl("circle", { class: "thanks-disc", cx: "48", cy: "48", r: "44" }),
    svgEl("circle", { class: "thanks-ring", cx: "48", cy: "48", r: "44", transform: "rotate(-90 48 48)" }), // starts at 12 o'clock
    svgEl("path", { class: "thanks-tick", d: "M30 49.5 42.5 62 67 35.5" }));
  return svg;
}

export function showThanks({ store, number, total }) {
  return new Promise((resolve) => {
    const name = String(store || "").trim();
    const box = h("div", { class: "thanks", role: "status", "aria-live": "assertive" },
      h("div", { class: "thanks-inner" },
        checkmark(),
        h("p", { class: "thanks-title" }, name ? `Thank you, ${name}` : "Thank you!"),
        h("p", { class: "thanks-meta num" }, `Invoice No. ${invoiceNo(number)}`),
        h("p", { class: "thanks-total num" }, money(total))));
    let gone = false;
    const onKey = (e) => { if (e.key === "Escape" || e.key === "Enter" || e.key === " ") { e.preventDefault(); close(); } };
    function close() {
      if (gone) return;
      gone = true;
      clearTimeout(timer);
      document.removeEventListener("keydown", onKey, true);
      box.classList.add("is-leaving");
      setTimeout(() => { box.remove(); resolve(); }, FADE_MS);
    }
    const timer = setTimeout(close, SHOW_MS);
    box.addEventListener("click", close);
    document.addEventListener("keydown", onKey, true);
    document.body.append(box);
  });
}
