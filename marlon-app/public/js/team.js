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
 *
 *   startTeamSync()          // on a team rep's phone, after the app has opened
 *   syncNow() → { sent, waiting }
 */
import { invoices, profile, settings } from "./db.js";
import { withTotals } from "./util.js";

const SENT = "teamSent"; // invoice id → what was last sent (exactly), so only changes go again
let running = null;
let started = false;

/** What the boss sees of an invoice. Drafts with nothing on them yet aren't sent. */
function forBoss(inv) {
  const t = withTotals(inv);
  if (!t.store && !t.items.length) return null;
  return {
    id: t.id, number: t.number, date: t.date, store: t.store || "", address: t.address || "", total: t.total,
    signed: Boolean(t.signature),
    items: t.items.map((it) => ({ name: it.name, qty: it.qty, unit: it.unit || "each", price: it.price, total: it.total })),
    payment: t.payment ? { status: t.payment.status, method: t.payment.method || "", termsDays: t.payment.termsDays ?? null, dueDate: t.payment.dueDate || "", paidAt: t.payment.paidAt || "" } : null,
    updatedAt: t.updatedAt || "",
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
    let done = 0;
    for (let i = 0; i < pending.length; i += 50) {
      const batch = pending.slice(i, i + 50);
      let res;
      try {
        res = await fetch("/api/team/sync", {
          method: "POST", headers: { "content-type": "application/json" }, cache: "no-store",
          body: JSON.stringify({ key: lic.key, device: lic.device, rep: me?.repName || "", invoices: batch.map((x) => x.b) }),
        });
      } catch { break; } // no signal: try again later
      if (!res.ok) break; // switched off (the licence check blocks the app) or a server hiccup: try later
      const { stored = [] } = await res.json().catch(() => ({}));
      const now = (await settings.get(SENT, {})) || {};
      for (const x of batch) if (stored.includes(x.b.id)) { now[x.b.id] = x.text; done++; }
      await settings.set(SENT, now);
    }
    return { sent: done, waiting: pending.length - done };
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
  window.__teamSync = syncNow;                      // (used by the tests)
}
