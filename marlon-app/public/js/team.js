/**
 * Team version: a rep's invoices go to the company's boss dashboard.
 *
 * Every invoice is saved on the phone first (as always). Whenever there's internet, the ones that are new or
 * changed since they were last sent (a new line, a price, "Payment received"…) go to the server, 50 at a time.
 * With no signal nothing is lost: they're simply still "not sent" and go as soon as there's a connection.
 * The server keeps one copy per invoice (sending the same invoice again just updates it), so nothing is doubled.
 *
 * What's sent: the invoice number, date, customer (store and address), products (name, amount, unit, price,
 * line total), total, signed yes/no and payment (paid or not, due date). Not the signature picture.
 * Back from the server: invoices the boss marked paid, which then show as paid on this phone too (once a minute
 * while the app is open, and with every send).
 *
 * Marlon Pro: the rep's credit notes (returns) go to the boss the same way (number, date, store, products with
 * quantities, prices and reasons, total, signed yes/no, how much has come off invoices). Not the signature picture.
 * Marlon Pro shelf orders go too (5 at a time): number, store, products (on shelf, target, ordered), status, and the
 * name and signature of the person who ordered (the server keeps those two encrypted), so the boss and a driver can see
 * who ordered it. Only while the company has Pro.
 *
 *   startTeamSync()          // on a team rep's phone, after the app has opened
 *   syncNow() → { sent, waiting }
 */
import { credits, invoices, orders, profile, settings } from "./db.js";
import { withTotals } from "./util.js";

const SENT = "teamSent"; // invoice id → what was last sent (exactly), so only changes go again
const SENT_CREDITS = "teamCreditsSent"; // credit note id → what was last sent
const SENT_ORDERS = "teamOrdersSent"; // order id → what was last sent
let running = null;
let started = false;
let lastAsked = 0; // when this phone last asked the server what the boss marked paid
const ASK_EVERY = 60000;

/** The boss marked some of this phone's invoices paid: show it here too (the next send carries it back). */
async function applyBossPaid(list) {
  let changed = 0;
  for (const { id, paidAt } of list || []) {
    const inv = await invoices.get(id);
    if (!inv || inv.payment?.status === "paid") continue;
    const payment = inv.payment
      ? { ...inv.payment, status: "paid", paidAt, markedBy: "boss" }
      : { status: "paid", method: "boss", termsDays: null, dueDate: null, recordedAt: paidAt, paidAt, markedBy: "boss" };
    await invoices.put({ ...inv, payment });
    changed++;
  }
  if (changed) document.dispatchEvent(new CustomEvent("team:paid", { detail: { changed } }));
  return changed;
}

/** What the boss sees of an invoice. Drafts with nothing on them yet aren't sent. */
function forBoss(inv) {
  const t = withTotals(inv);
  if (!t.store && !t.items.length) return null;
  return {
    id: t.id, number: t.number, date: t.date, store: t.store || "", address: t.address || "", total: t.total,
    signed: Boolean(t.signature),
    items: t.items.map((it) => ({ name: it.name, qty: it.qty, unit: it.unit || "each", price: it.price, total: it.total })),
    payment: t.payment ? { status: t.payment.status, method: t.payment.method || "", termsDays: t.payment.termsDays ?? null, dueDate: t.payment.dueDate || "", paidAt: t.payment.paidAt || "",
      ...(t.payment.markedBy === "boss" ? { markedBy: "boss" } : {}) } : null,
    updatedAt: t.updatedAt || "",
    ...(t.credit ? { subtotal: t.subtotal, credit: { amount: t.credit.amount, notes: t.credit.notes.map((n) => ({ id: n.id, number: n.number, amount: n.amount })) } } : {}),
  };
}

/** What the boss sees of a credit note (Marlon Pro returns). */
function creditForBoss(cn) {
  return {
    id: cn.id, number: cn.number, date: cn.date, store: cn.store || "", address: cn.address || "", total: cn.total, signed: Boolean(cn.signature), signer: cn.signerName || "",
    lines: cn.lines.map((l) => ({ name: l.name, qty: l.qty, unit: l.unit || "each", price: l.price, total: l.total, reason: l.reason })),
    applied: Math.round(Object.values(cn.appliedTo || {}).reduce((t, a) => t + Math.round((a.amount || 0) * 100), 0)) / 100,
    updatedAt: cn.updatedAt || "",
  };
}

/** What the boss sees of a shelf order (Marlon Pro). */
function orderForBoss(o) {
  return {
    id: o.id, number: o.number, date: o.date, store: o.store || "", address: o.address || "", status: o.status,
    lines: o.lines.map((l) => ({ name: l.name, unit: l.unit || "each", onShelf: l.onShelf ?? 0, target: l.target ?? null, qty: l.qty })),
    signer: o.signerName || "", signature: o.signature || "", signedAt: o.signedAt || "", deliveredAt: o.deliveredAt || "", cancelledAt: o.cancelledAt || "",
    invoiceNumber: o.invoiceNumber ?? null, updatedAt: o.updatedAt || "",
  };
}

export async function syncNow() {
  if (running) return running;
  running = (async () => {
    const lic = await settings.get("license", null);
    if (!lic?.team || lic.state === "off" || (typeof navigator !== "undefined" && navigator.onLine === false)) return { sent: 0, waiting: null };
    const me = await profile.get();
    const sent = (await settings.get(SENT, {})) || {};
    const pending = [];
    for (const inv of await invoices.all()) {
      const b = forBoss(inv);
      if (!b) continue;
      const text = JSON.stringify(b);
      if (sent[b.id] !== text) pending.push({ b, text });
    }
    const sentCredits = (await settings.get(SENT_CREDITS, {})) || {};
    const pendingCredits = [];
    for (const cn of await credits.all()) {
      const b = creditForBoss(cn), text = JSON.stringify(b);
      if (sentCredits[b.id] !== text) pendingCredits.push({ b, text });
    }
    const sentOrders = (await settings.get(SENT_ORDERS, {})) || {};
    const pendingOrders = [];
    if (lic.pro) {
      for (const o of await orders.all()) {
        const b = orderForBoss(o), text = JSON.stringify(b);
        if (sentOrders[b.id] !== text) pendingOrders.push({ b, text });
      }
    }
    let done = 0;
    // Nothing to send: still ask (once a minute) whether the boss marked anything paid.
    if (!pending.length && !pendingCredits.length && !pendingOrders.length && Date.now() - lastAsked >= ASK_EVERY) pending.push(null);
    // Orders carry a signature picture, so they go 5 at a time (invoices and credit notes 50 at a time).
    const rounds = Math.max(Math.ceil(pending.length / 50), Math.ceil(pendingCredits.length / 50), Math.ceil(pendingOrders.length / 5), 0);
    for (let r = 0; r < rounds; r++) {
      const i = r * 50;
      const batch = pending.slice(i, i + 50).filter(Boolean);
      const creditBatch = pendingCredits.slice(i, i + 50);
      const orderBatch = pendingOrders.slice(r * 5, r * 5 + 5);
      let res;
      try {
        res = await fetch("/api/team/sync", {
          method: "POST", headers: { "content-type": "application/json" }, cache: "no-store",
          body: JSON.stringify({ key: lic.key, device: lic.device, rep: me?.repName || "", invoices: batch.map((x) => x.b), ...(creditBatch.length ? { credits: creditBatch.map((x) => x.b) } : {}),
            ...(orderBatch.length ? { orders: orderBatch.map((x) => x.b) } : {}) }),
        });
      } catch { break; } // no signal: try again later
      if (!res.ok) break; // switched off (the licence check blocks the app) or a server hiccup: try later
      lastAsked = Date.now();
      const { stored = [], storedCredits = [], storedOrders = [], paid = [] } = await res.json().catch(() => ({}));
      await applyBossPaid(paid);
      const now = (await settings.get(SENT, {})) || {};
      for (const x of batch) if (stored.includes(x.b.id)) { now[x.b.id] = x.text; done++; }
      await settings.set(SENT, now);
      if (creditBatch.length) {
        const nowC = (await settings.get(SENT_CREDITS, {})) || {};
        for (const x of creditBatch) if (storedCredits.includes(x.b.id)) nowC[x.b.id] = x.text;
        await settings.set(SENT_CREDITS, nowC);
      }
      if (orderBatch.length) {
        const nowO = (await settings.get(SENT_ORDERS, {})) || {};
        for (const x of orderBatch) if (storedOrders.includes(x.b.id)) nowO[x.b.id] = x.text;
        await settings.set(SENT_ORDERS, nowO);
      }
    }
    return { sent: done, waiting: pending.filter(Boolean).length - done };
  })().finally(() => { running = null; });
  return running;
}

export function startTeamSync() {
  if (started) return;
  started = true;
  const kick = () => { syncNow().catch(() => {}); };
  kick();
  setInterval(kick, 8000);                         // new or changed invoices go within a few seconds
  window.addEventListener("online", kick);          // the signal is back: send what's waiting
  document.addEventListener("visibilitychange", () => { if (document.visibilityState === "visible") kick(); });
  window.__teamSync = () => { lastAsked = 0; return syncNow(); }; // (used by the tests: ask right away)
}
