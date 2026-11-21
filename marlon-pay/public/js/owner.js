/**
 * Marlon Pay · the store owner's screens: the dashboard (cash paid out today, this week, this month and any date range,
 * by supplier and by staff member, search, every record with its signature, CSV and PDF for the accountant) and the
 * staff links (name a staff member, share their link, switch it off, or give the place to someone new).
 */
import { meta, notes, payouts } from "./db.js";
import { syncNow } from "./sync.js";
import { h, money, nameKey, periods, prettyDate, put, timeText } from "./util.js";
import { pagesToPdfBlob } from "./pdf.js";

const sum = (list) => list.reduce((t, p) => t + p.amountCents, 0);
const inRange = (from, to) => (p) => p.date >= from && p.date <= to;
function groupBy(list, keyOf) {
  const m = new Map();
  for (const p of list) { const k = keyOf(p) || "—"; const g = m.get(k) || { name: k, count: 0, cents: 0 }; g.count++; g.cents += p.amountCents; m.set(k, g); }
  return [...m.values()].sort((a, b) => b.cents - a.cents || a.name.localeCompare(b.name));
}
async function deliver(blob, name) {
  const file = new File([blob], name, { type: blob.type });
  if (navigator.canShare?.({ files: [file] }) && /iPhone|iPad|Android/i.test(navigator.userAgent)) {
    try { await navigator.share({ files: [file], title: name }); return; } catch (e) { if (e?.name === "AbortError") return; }
  }
  const url = URL.createObjectURL(file);
  const a = h("a", { href: url, download: name }); document.body.append(a); a.click(); a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 60000);
}
const csvCell = (v) => { const s = String(v ?? ""); return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s; };

export async function ownerDashboard({ openRecord }) {
  const lic = await meta.get("license");
  const view = { from: periods().month, to: periods().today, q: "" };
  const box = h("main", { class: "wrap owner", id: "owner" });
  async function render() {
    const all = await payouts.all();
    const ns = await notes.all();
    const pr = periods();
    const tile = (label, list, id) => h("div", { class: "tile", id }, h("span", {}, label), h("strong", { class: "num" }, money(sum(list))), h("small", {}, `${list.length} payment${list.length === 1 ? "" : "s"}`));
    const today = all.filter((p) => p.date === pr.today), week = all.filter(inRange(pr.week, pr.today)), month = all.filter(inRange(pr.month, pr.today));
    const from = h("input", { type: "date", id: "od-from", value: view.from }), to = h("input", { type: "date", id: "od-to", value: view.to });
    const ranged = all.filter(inRange(view.from, view.to));
    const search = h("input", { type: "search", id: "od-search", class: "big-input", placeholder: "Supplier, invoice number or date", value: view.q, autocomplete: "off", "aria-label": "Search records" });
    const results = h("ul", { class: "rec-list", id: "od-results" });
    const drawResults = () => {
      view.q = search.value;
      const t = nameKey(view.q);
      const shown = t ? all.filter((p) => nameKey(p.supplierName).includes(t) || nameKey(p.invoiceNo).includes(t) || p.date.includes(t) || nameKey(prettyDate(p.date)).includes(t)) : ranged;
      put(results, shown.length ? shown.slice(0, 200).map((p) => h("li", {}, h("button", { type: "button", class: "rec-row", dataset: { id: p.id }, onclick: () => openRecord(p.id) },
        h("span", {}, h("strong", {}, p.supplierName), h("small", {}, `${prettyDate(p.date)} · Inv. ${p.invoiceNo || "—"} · ${p.staffName || "—"}${ns.some((n) => n.payoutId === p.id) ? " · has a correction note" : ""}`)),
        h("strong", { class: "num" }, money(p.amountCents))))) : h("li", { class: "empty" }, "No records match."));
    };
    search.addEventListener("input", drawResults);
    const table = (id, head, rows) => h("table", { class: "tbl", id }, h("thead", {}, h("tr", {}, head.map((x, i) => h("th", { class: i ? "num" : "" }, x)))),
      h("tbody", {}, rows.length ? rows.map((g) => h("tr", {}, h("td", {}, g.name), h("td", { class: "num" }, String(g.count)), h("td", { class: "num" }, money(g.cents)))) : h("tr", {}, h("td", { colspan: "3", class: "muted" }, "Nothing in these dates."))));
    const lastSync = await meta.get("lastSync");
    put(box,
      h("div", { class: "owner-head" }, h("h1", { class: "title" }, "Cash paid out"),
        h("button", { type: "button", class: "btn btn-small", id: "od-refresh", onclick: async (e) => { e.currentTarget.disabled = true; await syncNow(); render(); } }, "Refresh")),
      h("p", { class: "muted" }, lastSync ? `Up to date as of ${prettyDate(lastSync.slice(0, 10))}, ${timeText(lastSync)}. Records from staff devices arrive when those devices have signal.` : "Records from staff devices arrive when those devices have signal."),
      h("div", { class: "tiles" }, tile("Today", today, "od-today"), tile("This week", week, "od-week"), tile("This month", month, "od-month")),
      h("section", { class: "card" },
        h("h2", {}, "Any dates"),
        h("div", { class: "range" }, h("label", {}, h("span", {}, "From"), from), h("label", {}, h("span", {}, "To"), to)),
        h("p", { class: "range-total", id: "od-range-total" }, h("strong", { class: "num" }, money(sum(ranged))), ` paid in ${ranged.length} payment${ranged.length === 1 ? "" : "s"}, ${prettyDate(view.from)} – ${prettyDate(view.to)}`),
        h("h3", {}, "By supplier"), table("od-by-supplier", ["Supplier", "Payments", "Paid"], groupBy(ranged, (p) => p.supplierName)),
        h("h3", {}, "By staff member"), table("od-by-staff", ["Staff", "Payments", "Paid"], groupBy(ranged, (p) => p.staffName)),
        h("div", { class: "row" },
          h("button", { type: "button", class: "btn btn-primary", id: "od-csv", onclick: () => exportCsv(lic, ranged, ns, view) }, "Download CSV"),
          h("button", { type: "button", class: "btn btn-primary", id: "od-pdf", onclick: (e) => exportPdf(lic, ranged, ns, view, e.currentTarget) }, "Download PDF"))),
      h("section", { class: "card" }, h("h2", {}, "Find a record"), search, h("p", { class: "muted small" }, "Shows the dates above until you search. Tap a record to see its signature."), results));
    const onRange = () => { if (from.value && to.value) { view.from = from.value <= to.value ? from.value : to.value; view.to = from.value <= to.value ? to.value : from.value; render(); } };
    from.addEventListener("change", onRange); to.addEventListener("change", onRange);
    drawResults();
  }
  await render();
  return box;
}

function exportCsv(lic, list, ns, view) {
  const rows = [["Date", "Signed at", "Supplier", "Invoice number", "Amount paid", "Paid by", "From Marlon", "Correction notes", "Record id"]];
  for (const p of [...list].sort((a, b) => a.date.localeCompare(b.date) || a.signedAt.localeCompare(b.signedAt))) {
    rows.push([p.date, p.signedAt, p.supplierName, p.invoiceNo, (p.amountCents / 100).toFixed(2), p.staffName, p.fromMarlon ? `${p.fromMarlon.seller} (invoice total ${(p.fromMarlon.totalCents / 100).toFixed(2)})` : "",
      ns.filter((n) => n.payoutId === p.id).map((n) => `${n.createdAt.slice(0, 10)}: ${n.text}`).join(" | "), p.id]);
  }
  rows.push([], ["Total", "", "", "", (sum(list) / 100).toFixed(2)]);
  const csv = "﻿" + `${lic.storeName} — cash paid out, ${view.from} to ${view.to}\n` + rows.map((r) => r.map(csvCell).join(",")).join("\n") + "\n";
  return deliver(new Blob([csv], { type: "text/csv" }), `marlon-pay-${view.from}-to-${view.to}.csv`);
}

async function exportPdf(lic, list, ns, view, button) {
  button.disabled = true; button.textContent = "Making the PDF…";
  try {
    const sorted = [...list].sort((a, b) => a.date.localeCompare(b.date) || a.signedAt.localeCompare(b.signedAt));
    // Signatures of records made on other devices come from the store's server copy (decrypted for the owner).
    const missing = sorted.filter((p) => !p.signature).map((p) => p.id);
    for (let i = 0; i < missing.length; i += 100) {
      try {
        const res = await fetch("/api/signatures", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ key: lic.key, device: lic.device, ids: missing.slice(i, i + 100) }) });
        const sigs = (await res.json()).signatures || {};
        for (const [id, s] of Object.entries(sigs)) if (s) { await payouts.cacheSignature(id, s); const p = sorted.find((x) => x.id === id); if (p) p.signature = s; }
      } catch { /* offline: the PDF says which signatures couldn't be included */ }
    }
    const W = 1275, H = 1650, m = 80, rowH = 108, perPage = 11;
    const pages = [];
    const SANS = '-apple-system, BlinkMacSystemFont, "Helvetica Neue", Helvetica, Arial, sans-serif';
    const imgs = new Map();
    for (const p of sorted) if (p.signature) imgs.set(p.id, await new Promise((ok) => { const i = new Image(); i.onload = () => ok(i); i.onerror = () => ok(null); i.src = p.signature; }));
    const count = Math.max(1, Math.ceil(sorted.length / perPage));
    for (let pg = 0; pg < count; pg++) {
      const c = document.createElement("canvas"); c.width = W; c.height = H;
      const x = c.getContext("2d");
      x.fillStyle = "#fff"; x.fillRect(0, 0, W, H);
      const t = (s, size, px, py, { weight = 400, align = "left", color = "#111" } = {}) => { x.font = `${weight} ${size}px ${SANS}`; x.fillStyle = color; x.textAlign = align; x.fillText(String(s), px, py); };
      t(lic.storeName, 36, m, m + 20, { weight: 800 });
      t(`Cash paid out · ${prettyDate(view.from)} – ${prettyDate(view.to)}`, 24, m, m + 58, { color: "#444" });
      t(`Page ${pg + 1} of ${count}`, 20, W - m, m + 20, { align: "right", color: "#666" });
      if (pg === 0) t(`Total ${money(sum(sorted))} · ${sorted.length} payment${sorted.length === 1 ? "" : "s"}`, 26, W - m, m + 58, { align: "right", weight: 700 });
      let y = m + 100;
      x.fillStyle = "#f1f1f1"; x.fillRect(m, y, W - 2 * m, 40);
      const col = { date: m + 10, sup: m + 190, inv: m + 520, by: m + 690, amt: m + 960, sig: m + 985 };
      for (const [k, label] of [["date", "DATE"], ["sup", "SUPPLIER"], ["inv", "INVOICE"], ["by", "PAID BY"]]) t(label, 16, col[k], y + 26, { weight: 700, color: "#555" });
      t("AMOUNT", 16, col.amt, y + 26, { weight: 700, color: "#555", align: "right" }); t("SIGNATURE", 16, col.sig, y + 26, { weight: 700, color: "#555" });
      y += 40;
      for (const p of sorted.slice(pg * perPage, pg * perPage + perPage)) {
        const cut = (s, n) => (String(s).length > n ? `${String(s).slice(0, n - 1)}…` : String(s));
        t(prettyDate(p.date), 20, col.date, y + 40); t(cut(p.supplierName, 24), 20, col.sup, y + 40, { weight: 700 }); t(cut(p.invoiceNo, 12), 20, col.inv, y + 40);
        t(cut(p.staffName, 18), 20, col.by, y + 40); t(money(p.amountCents), 20, col.amt, y + 40, { align: "right", weight: 700 });
        t(`Signed ${timeText(p.signedAt)}`, 15, col.date, y + 68, { color: "#777" });
        const nn = ns.filter((n) => n.payoutId === p.id);
        if (nn.length) t(cut(`Correction ${nn[nn.length - 1].createdAt.slice(0, 10)}: ${nn[nn.length - 1].text}`, 70), 15, col.sup, y + 68, { color: "#9a3412" });
        const img = imgs.get(p.id);
        if (img) x.drawImage(img, col.sig, y + 8, 210, 70); else t("(signature not available offline)", 14, col.sig, y + 50, { color: "#999" });
        y += rowH; x.fillStyle = "#ddd"; x.fillRect(m, y - 8, W - 2 * m, 1);
      }
      t("Made with Marlon Pay. Each payment was signed by the supplier on the store's device; signed records can't be changed.", 15, m, H - m + 30, { color: "#777" });
      pages.push(c);
    }
    await deliver(await pagesToPdfBlob(pages, { title: `${lic.storeName} cash paid out` }), `marlon-pay-${view.from}-to-${view.to}.pdf`);
  } finally { button.disabled = false; button.textContent = "Download PDF"; }
}

// ── Staff links ─────────────────────────────────────────────────────────────────────────────────────────────────
export async function staffScreen() {
  const lic = await meta.get("license");
  const box = h("main", { class: "wrap", id: "staff" });
  const call = async (path, body = {}) => {
    try {
      const res = await fetch(path, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ key: lic.key, device: lic.device, ...body }) });
      return { ok: res.ok, data: await res.json().catch(() => ({})) };
    } catch { return { ok: false, data: { error: "No connection. Staff links need the internet." } }; }
  };
  async function render(r = null, msg = "") {
    r ||= await call("/api/staff");
    if (!r.ok) { put(box, h("h1", { class: "title" }, "Staff"), h("p", { class: "error" }, r.data.error)); return; }
    const { places, total } = r.data;
    const name = h("input", { type: "text", id: "st-name", class: "big-input", maxlength: "60", autocapitalize: "words", placeholder: "Staff member's name" });
    put(box,
      h("h1", { class: "title" }, "Staff"),
      h("p", { class: "muted" }, `Each staff member gets their own link. It works on the first device that opens it. ${places.length} of ${total} staff place${total === 1 ? "" : "s"} in use.`),
      msg ? h("p", { class: "ok-msg", role: "status" }, msg) : null,
      places.length < total ? h("form", { class: "card form", onsubmit: async (e) => { e.preventDefault(); const x = await call("/api/staff/add", { name: name.value }); if (x.ok) render(x, `Added ${name.value.trim()}. Send them their link below.`); else render(null, x.data.error); } },
        h("label", { class: "field" }, h("span", { class: "field-label" }, "Add a staff member"), name), h("button", { type: "submit", class: "btn btn-primary btn-xl", id: "st-add" }, "Add and get their link")) : null,
      h("ul", { class: "staff-list" }, places.map((p) => h("li", { class: `card staff${p.off ? " is-off" : ""}`, dataset: { n: String(p.n) } },
        h("div", { class: "staff-top" }, h("strong", {}, p.name), h("span", { class: `badge ${p.off ? "is-off" : p.device ? "is-on" : ""}` }, p.off ? "Switched off" : p.device ? `On ${p.device.label}` : "Link not opened yet")),
        h("input", { type: "text", class: "staff-link", readOnly: true, value: p.link, "aria-label": `${p.name}'s link` }),
        h("div", { class: "row" },
          h("button", { type: "button", class: "btn btn-small st-copy", onclick: async (e) => { try { await navigator.clipboard.writeText(p.link); e.currentTarget.textContent = "Copied ✓"; } catch { e.currentTarget.previousSibling; } } }, "Copy link"),
          navigator.share ? h("button", { type: "button", class: "btn btn-small", onclick: () => navigator.share({ title: "Marlon Pay", text: `${p.name}, your Marlon Pay link (open it on your own phone):`, url: p.link }).catch(() => {}) }, "Share") : null,
          h("button", { type: "button", class: "btn btn-small st-off", onclick: async () => { const x = await call("/api/staff/off", { n: p.n, off: !p.off }); render(x.ok ? x : null, x.ok ? (p.off ? `${p.name}'s link works again.` : `${p.name}'s link is switched off. Their device stops working the next time it's online.`) : x.data.error); } }, p.off ? "Switch on" : "Switch off"),
          h("button", { type: "button", class: "btn btn-small btn-ghost st-replace", onclick: async () => {
            const who = prompt(`Give ${p.name}'s place to a new staff member. Their name:`);
            if (!who) return;
            const x = await call("/api/staff/replace", { n: p.n, name: who });
            render(x.ok ? x : null, x.ok ? `${who.trim()} has a new link. ${p.name}'s old link no longer works.` : x.data.error);
          } }, "Give to new staff"))))));
  }
  await render();
  return box;
}
