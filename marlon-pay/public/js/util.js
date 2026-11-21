/** Small helpers shared by Marlon Pay's screens. */
export function h(tag, props = {}, ...children) {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(props || {})) {
    if (v === null || v === undefined || v === false) continue;
    if (k.startsWith("on") && typeof v === "function") el.addEventListener(k.slice(2).toLowerCase(), v);
    else if (k === "class") el.className = v;
    else if (k === "dataset") Object.assign(el.dataset, v);
    else if (k in el && !k.includes("-") && typeof v !== "boolean") el[k] = v;
    else el.setAttribute(k, v === true ? "" : String(v));
  }
  for (const c of children.flat(Infinity)) {
    if (c === null || c === undefined || c === false) continue;
    el.append(c instanceof Node ? c : document.createTextNode(String(c)));
  }
  return el;
}
/** Replaces an element's children, skipping empty values (replaceChildren would print "null"). */
export const put = (el, ...nodes) => el.replaceChildren(...nodes.flat(Infinity).filter((n) => n !== null && n !== undefined && n !== false));
export const money = (cents) => (Number(cents || 0) / 100).toLocaleString("en-US", { style: "currency", currency: "USD" });
/** "1,250.50" / "$12" → 125050 / 1200 cents, or null. */
export function toCents(text) {
  const t = String(text ?? "").replace(/[$,\s]/g, "");
  if (!/^\d+(\.\d{1,2})?$/.test(t)) return null;
  return Math.round(Number(t) * 100);
}
export const centsText = (c) => (c === null || c === undefined ? "" : (c / 100).toFixed(2));
export const uid = (p) => `${p}${Date.now().toString(36)}${Array.from(crypto.getRandomValues(new Uint8Array(6)), (b) => b.toString(16).padStart(2, "0")).join("")}`;
export const pad2 = (n) => String(n).padStart(2, "0");
export const isoOf = (d) => `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}`;
export const todayISO = () => isoOf(new Date());
/** Monday of this week, and the 1st of this month (weeks run Monday to Sunday, like Marlon). */
export function periods(now = new Date()) {
  const monday = new Date(now); monday.setDate(now.getDate() - ((now.getDay() + 6) % 7));
  return { today: isoOf(now), week: isoOf(monday), month: `${isoOf(now).slice(0, 8)}01` };
}
const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
export const prettyDate = (iso) => { const [y, m, d] = String(iso).split("-").map(Number); return y ? `${d} ${MONTHS[m - 1]} ${y}` : ""; };
export const timeText = (isoTime) => (isoTime ? new Date(isoTime).toLocaleTimeString([], { hour: "numeric", minute: "2-digit" }) : "");
export const tidy = (s) => String(s ?? "").replace(/\s+/g, " ").trim();
export const nameKey = (s) => tidy(s).toLowerCase();
export function loadImage(src) {
  return new Promise((resolve, reject) => { const img = new Image(); img.onload = () => resolve(img); img.onerror = () => reject(new Error("Could not load image")); img.src = src; });
}
