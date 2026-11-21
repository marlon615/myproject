/**
 * Marlon Pro reports, shared by the boss dashboard (boss.js) and a solo business's own dashboard (dashboard.js).
 * Pure functions: no screen, no storage. All money is added up in whole cents.
 *
 *   accountantSummary({ invoices, credits, year }) → by quarter (calendar: Jan–Mar …) and for the year to 31 December:
 *       invoices, gross sales (before credit notes), returns (credit notes issued), net sales, received, not yet paid
 *   returnsBreakdown(credits, repName) → returns by store, by product (with reasons) and by rep
 *   summaryCsv(...) → the same summary plus every invoice and credit note line, for the accountant
 */
const cents = (n) => { const x = Number(n); return Number.isFinite(x) ? Math.round(Number((x * 100).toFixed(4))) : 0; };
const dollars = (c) => c / 100;
export const QUARTERS = [["Q1", "Jan – Mar"], ["Q2", "Apr – Jun"], ["Q3", "Jul – Sep"], ["Q4", "Oct – Dec"]];
const quarterOf = (iso) => Math.floor((Number(String(iso).slice(5, 7)) - 1) / 3); // 0..3
const yearOf = (iso) => (/^\d{4}-\d{2}-\d{2}/.test(iso || "") ? Number(iso.slice(0, 4)) : null);
const isPaid = (inv) => inv?.payment?.status === "paid";
/** An invoice's amount before any credit note came off it. */
const grossOf = (inv) => cents(inv.subtotal ?? inv.total);

/** Years that have invoices or credit notes, newest first (this year always included). */
export function reportYears(invoices, credits, now = new Date()) {
  const ys = new Set([now.getFullYear()]);
  for (const x of [...(invoices || []), ...(credits || [])]) { const y = yearOf(x.date); if (y) ys.add(y); }
  return [...ys].sort((a, b) => b - a);
}

export function accountantSummary({ invoices = [], credits = [], year }) {
  const blank = () => ({ invoices: 0, gross: 0, returns: 0, net: 0, received: 0, unpaid: 0, creditNotes: 0 });
  const qs = QUARTERS.map(() => blank());
  for (const inv of invoices) {
    if (yearOf(inv.date) !== year) continue;
    if (!(inv.items || []).length && !cents(inv.total)) continue; // an empty draft isn't a sale
    const q = qs[quarterOf(inv.date)];
    q.invoices++;
    q.gross += grossOf(inv);
    if (isPaid(inv)) q.received += cents(inv.total); else q.unpaid += cents(inv.total);
  }
  for (const cn of credits) {
    if (yearOf(cn.date) !== year) continue;
    const q = qs[quarterOf(cn.date)];
    q.creditNotes++;
    q.returns += cents(cn.total);
  }
  const total = blank();
  for (const q of qs) { q.net = q.gross - q.returns; for (const k of Object.keys(total)) total[k] += q[k]; }
  const out = (q) => ({ invoices: q.invoices, creditNotes: q.creditNotes, gross: dollars(q.gross), returns: dollars(q.returns), net: dollars(q.net), received: dollars(q.received), unpaid: dollars(q.unpaid) });
  return { year, quarters: qs.map((q, i) => ({ q: QUARTERS[i][0], months: QUARTERS[i][1], ...out(q) })), total: out(total) };
}

const unitText = (qty, unit) => (unit === "dozen" ? `${qty} dozen` : unit === "lb" ? `${qty} lb` : unit === "bag" ? `${qty} bag${qty === 1 ? "" : "s"}` : `${qty}`);

/** Returns by store, by product and by rep (a solo business has one "rep": itself). */
export function returnsBreakdown(credits = [], repName = () => "") {
  const byStore = new Map(), byProduct = new Map(), byRep = new Map();
  let total = 0;
  for (const cn of credits) {
    const t = cents(cn.total);
    total += t;
    const sk = String(cn.store || "No store name").trim();
    const s = byStore.get(sk.toLowerCase()) || { store: sk, notes: 0, amount: 0 };
    s.notes++; s.amount += t; byStore.set(sk.toLowerCase(), s);
    const rk = cn.rep || "";
    const r = byRep.get(rk) || { rep: repName(rk) || "You", notes: 0, amount: 0 };
    r.notes++; r.amount += t; byRep.set(rk, r);
    for (const l of cn.lines || []) {
      const pk = `${String(l.name).toLowerCase()}|${l.unit || "each"}`;
      const p = byProduct.get(pk) || { name: l.name, unit: l.unit || "each", qty: 0, expired: 0, damaged: 0, amount: 0 };
      const q = Number(l.qty) || 0;
      p.qty = Math.round((p.qty + q) * 1000) / 1000;
      if (l.reason === "damaged") p.damaged = Math.round((p.damaged + q) * 1000) / 1000; else p.expired = Math.round((p.expired + q) * 1000) / 1000;
      p.amount += cents(l.total);
      byProduct.set(pk, p);
    }
  }
  const sorted = (m) => [...m.values()].sort((a, b) => b.amount - a.amount).map((x) => ({ ...x, amount: dollars(x.amount) }));
  return { total: dollars(total), notes: credits.length, byStore: sorted(byStore), byProduct: sorted(byProduct).map((p) => ({ ...p, qtyText: unitText(p.qty, p.unit) })), byRep: sorted(byRep) };
}

const csvCell = (v) => { const s = String(v ?? ""); return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s; };
const csvRow = (cells) => cells.map(csvCell).join(",");
const n2 = (x) => (Math.round(Number(x || 0) * 100) / 100).toFixed(2);
const no = (n) => String(n || "").padStart(4, "0");

/** The accountant's file: the summary, then every invoice and every credit note line of that year. */
export function summaryCsv({ company, year, invoices = [], credits = [], repName = () => "" }) {
  const s = accountantSummary({ invoices, credits, year });
  const rows = [
    [`${company} — sales summary for ${year} (year ending 31 December ${year})`],
    ["Prepared by Marlon from the invoices and credit notes in the app. Your accountant still needs to check it before you file your taxes."],
    [],
    ["Quarter", "Months", "Invoices", "Gross sales", "Returns (credit notes)", "Net sales", "Received", "Not yet paid"],
    ...s.quarters.map((q) => [q.q, q.months, q.invoices, n2(q.gross), n2(q.returns), n2(q.net), n2(q.received), n2(q.unpaid)]),
    [`Year ${year}`, "Jan – Dec", s.total.invoices, n2(s.total.gross), n2(s.total.returns), n2(s.total.net), n2(s.total.received), n2(s.total.unpaid)],
    [],
    ["INVOICES"],
    ["Date", "Invoice no.", "Rep", "Store", "Gross", "Credit note credit", "Total", "Paid"],
    ...invoices.filter((i) => yearOf(i.date) === year && ((i.items || []).length || cents(i.total)))
      .sort((a, b) => a.date.localeCompare(b.date) || (a.number || 0) - (b.number || 0))
      .map((i) => [i.date, no(i.number), repName(i.rep || ""), i.store || "", n2(grossOf(i) / 100), n2(i.credit?.amount || 0), n2(i.total), isPaid(i) ? "Paid" : "Not paid"]),
    [],
    ["CREDIT NOTES (returns)"],
    ["Date", "Credit note no.", "Rep", "Store", "Product", "Quantity", "Unit", "Reason", "Price", "Amount"],
    ...credits.filter((c) => yearOf(c.date) === year).sort((a, b) => a.date.localeCompare(b.date) || (a.number || 0) - (b.number || 0))
      .flatMap((c) => (c.lines || []).map((l) => [c.date, `CN-${no(c.number)}`, repName(c.rep || ""), c.store || "", l.name, l.qty, l.unit || "each", l.reason === "damaged" ? "Damaged" : "Expired", n2(l.price), n2(l.total)])),
  ];
  return "﻿" + rows.map(csvRow).join("\r\n") + "\r\n"; // the BOM lets Excel read the dashes and names correctly
}
