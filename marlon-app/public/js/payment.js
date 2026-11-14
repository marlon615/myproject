/**
 * Payment, for the owner (or sales rep) only: how each invoice is being paid.
 *   Cash     → Paid at once.
 *   7 days   → Unpaid, due 7 days after the invoice date.
 *   14 days  → Unpaid, due 14 days after the invoice date.
 * An unpaid invoice turns red on its due day and stays red; it never clears itself — only "Payment received"
 * on that exact invoice clears it. Every invoice has its own payment and due date, so one store can have several.
 *
 * Payment is never shown on the customer's copies (QR page, PDF, picture, paper receipt) or the signing screen:
 * only on the dashboard and History.
 *
 * paymentPage(inv, { skipText }) → Promise<payment | null>   the private page (null = not now)
 * paymentState(inv, today)       → { kind: "none" | "paid" | "unpaid" | "due", text, short, dueDate?, days? }
 */
import { h, invoiceNo, money, parseISODate, prettyDate, todayISO } from "./util.js";

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
const DAYS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];

/** "2026-11-11" + 7 → "2026-11-18" */
export function addDays(iso, n) {
  const p = parseISODate(iso) || parseISODate(todayISO());
  return new Date(Date.UTC(p.y, p.m - 1, p.d + n)).toISOString().slice(0, 10);
}

/** Whole days from a to b ("YYYY-MM-DD"): positive when b is later. */
export function daysBetween(a, b) {
  const x = parseISODate(a), y = parseISODate(b);
  if (!x || !y) return 0;
  return Math.round((Date.UTC(y.y, y.m - 1, y.d) - Date.UTC(x.y, x.m - 1, x.d)) / 86400000);
}

/** "Wed 18 Nov" (with the year when it isn't this year). */
export function dueText(iso, today = todayISO()) {
  const p = parseISODate(iso);
  if (!p) return String(iso || "");
  const dow = DAYS[new Date(Date.UTC(p.y, p.m - 1, p.d)).getUTCDay()];
  return `${dow} ${p.d} ${MONTHS[p.m - 1]}${String(p.y) === today.slice(0, 4) ? "" : ` ${p.y}`}`;
}

/** The payment for a choice: "cash" (paid now) or 7 / 14 (unpaid, due that many days after the invoice date). */
export function makePayment(choice, invoiceDate, now = new Date()) {
  const at = now.toISOString();
  if (choice === "cash") return { status: "paid", method: "cash", termsDays: 0, dueDate: null, recordedAt: at, paidAt: at };
  const days = Number(choice) === 14 ? 14 : 7;
  return { status: "unpaid", method: "terms", termsDays: days, dueDate: addDays(invoiceDate || todayISO(now), days), recordedAt: at, paidAt: null };
}

/** The same payment, now received (the terms and due date stay on record). */
export const markReceived = (payment, now = new Date()) => ({ ...payment, status: "paid", paidAt: now.toISOString() });

/**
 * Where one invoice stands, for the owner:
 *   none   — no payment recorded yet       paid — paid (cash, or received later)
 *   unpaid — on 7/14 days, not due yet     due  — its due day has come or passed: red until "Payment received"
 */
export function paymentState(inv, today = todayISO()) {
  const p = inv?.payment;
  if (!p) return { kind: "none", text: "No payment set", short: "No payment set" };
  if (p.status === "paid") {
    const when = p.paidAt ? prettyDate(p.paidAt.slice(0, 10)) : "";
    if (p.method === "cash") return { kind: "paid", text: `Paid in cash${when ? ` · ${when}` : ""}`, short: "Paid · cash" };
    return { kind: "paid", text: `Paid${when ? ` on ${when}` : ""} (was ${p.termsDays} days, due ${dueText(p.dueDate, today)})`, short: "Paid" };
  }
  const days = daysBetween(today, p.dueDate); // > 0: days left · 0: due today · < 0: overdue
  if (days > 0) {
    return { kind: "unpaid", dueDate: p.dueDate, days,
      text: `Unpaid · ${p.termsDays} days · due ${dueText(p.dueDate, today)} (${days === 1 ? "tomorrow" : `in ${days} days`})`,
      short: `Unpaid · due ${dueText(p.dueDate, today)}` };
  }
  const late = days === 0 ? "Due today" : `Overdue ${-days} day${days === -1 ? "" : "s"}`;
  return { kind: "due", dueDate: p.dueDate, days, text: `${late} · was due ${dueText(p.dueDate, today)} · ${p.termsDays} days`, short: late };
}

/** Unpaid invoices first by due date (red ones first), each on its own. */
export const byDueDate = (a, b) => String(a.payment?.dueDate || "").localeCompare(String(b.payment?.dueDate || "")) || (a.number || 0) - (b.number || 0);

const ICON = {
  lock: "M7.5 10.5V8a4.5 4.5 0 0 1 9 0v2.5M6 10.5h12a1 1 0 0 1 1 1v8a1 1 0 0 1-1 1H6a1 1 0 0 1-1-1v-8a1 1 0 0 1 1-1z",
  cash: "M3.5 7h17v10h-17zM12 14.5a2.5 2.5 0 1 0 0-5 2.5 2.5 0 0 0 0 5zM6.5 10v4M17.5 10v4",
  calendar: "M4.5 6.5h15v13h-15zM4.5 10.5h15M8.5 4v4M15.5 4v4",
};
function icon(name) {
  const ns = "http://www.w3.org/2000/svg";
  const svg = document.createElementNS(ns, "svg");
  svg.setAttribute("viewBox", "0 0 24 24");
  svg.setAttribute("class", "icon");
  svg.setAttribute("aria-hidden", "true");
  const path = document.createElementNS(ns, "path");
  path.setAttribute("d", ICON[name]);
  svg.append(path);
  return svg;
}

/**
 * The private payment page (full screen). Resolves with the payment chosen, or null for "Not now".
 * Shown only after the customer is done; nothing on it is ever printed or shared.
 */
export function paymentPage(inv, { skipText = "Not now", today = todayISO() } = {}) {
  return new Promise((resolve) => {
    const dlg = h("dialog", { class: "pay", "aria-labelledby": "pay-title", "aria-describedby": "pay-private" });
    const finish = (value) => { dlg.close(); dlg.remove(); resolve(value); };
    const option = (choice, title, sub, iconName, cls = "") =>
      h("button", { type: "button", class: `pay-option${cls}`, dataset: { choice }, onclick: () => finish(makePayment(choice, inv.date)) },
        h("span", { class: "pay-option-icon" }, icon(iconName)),
        h("span", { class: "pay-option-text" }, h("span", { class: "pay-option-title" }, title), h("span", { class: "pay-option-sub" }, sub)));
    dlg.append(
      h("header", { class: "pay-head" },
        h("p", { class: "pay-private", id: "pay-private" }, icon("lock"), "Only you see this page"),
        h("h2", { id: "pay-title", tabindex: "-1" }, "How is it being paid?")),
      h("div", { class: "pay-body" },
        h("div", { class: "pay-summary" },
          h("p", { class: "pay-store" }, inv.store || "No store name"),
          h("p", { class: "pay-meta num" }, `Invoice No. ${invoiceNo(inv.number)} · ${prettyDate(inv.date)}`),
          h("p", { class: "pay-total num" }, money(inv.total))),
        h("div", { class: "pay-options", role: "group", "aria-label": "Payment" },
          option("cash", "Cash", "I collected the money. Goes in as Paid.", "cash", " is-cash"),
          option("7", "7 days", `Unpaid until it's paid. Due ${dueText(addDays(inv.date, 7), today)}.`, "calendar"),
          option("14", "14 days", `Unpaid until it's paid. Due ${dueText(addDays(inv.date, 14), today)}.`, "calendar")),
        h("p", { class: "pay-note" }, "This goes on your dashboard and History only. The customer's receipt, PDF, picture and QR page never show it.")),
      h("footer", { class: "pay-foot" },
        h("button", { type: "button", class: "btn btn-ghost btn-block pay-skip", onclick: () => finish(null) }, skipText)));
    dlg.addEventListener("cancel", (e) => { e.preventDefault(); finish(null); });
    document.body.append(dlg);
    dlg.showModal();
    dlg.querySelector("#pay-title").focus({ preventScroll: true });
  });
}
