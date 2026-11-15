/**
 * Email through Resend (https://resend.com — free tier; needs your own key and, to reach any inbox, a domain you
 * verify with them). The key and From address are set on the owner dashboard and stored encrypted. Each recipient
 * gets their own email (nobody sees the other recipients).
 */
const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);

export async function sendEmail(env, dir, { to, subject, html, text }) {
  const key = await dir.secret("emailKey"), from = await dir.secret("emailFrom");
  if (!key || !from) return { ok: false, sent: 0, reason: "Email isn't set up yet (owner dashboard → Email)." };
  let sent = 0; const errors = [];
  for (const addr of [...new Set(to)].slice(0, 40)) {
    try {
      const res = await fetch(env.EMAIL_URL || "https://api.resend.com/emails", {
        method: "POST", headers: { Authorization: `Bearer ${key}`, "Content-Type": "application/json" },
        body: JSON.stringify({ from, to: [addr], subject, html, text }),
      });
      if (res.ok) sent++; else errors.push(`${res.status}`);
    } catch (e) { errors.push("network"); }
  }
  return { ok: sent > 0, sent, reason: errors.length ? `Some emails failed (${[...new Set(errors)].join(", ")})` : "" };
}

const shell = (title, body, link) => `<!doctype html><html><body style="margin:0;background:#f6f7f9;font-family:system-ui,-apple-system,Segoe UI,Roboto,sans-serif;color:#14181f">
<div style="max-width:640px;margin:0 auto;padding:24px 16px"><div style="background:#fff;border:1px solid #e1e4ea;border-radius:12px;padding:24px">
<h1 style="font-size:20px;margin:0 0 12px">${esc(title)}</h1>${body}
${link ? `<p style="margin:20px 0 0"><a href="${esc(link)}" style="display:inline-block;background:#1f5fbf;color:#fff;text-decoration:none;padding:10px 16px;border-radius:8px;font-weight:600">Open the Forecasting Agent</a></p>` : ""}
</div><p style="color:#6b7380;font-size:12px;margin:12px 4px">You get this because of your notification settings in the Forecasting Agent (Settings → Emails).</p></div></body></html>`;
const table = (head, rows) => `<table style="border-collapse:collapse;width:100%;font-size:14px">
<tr>${head.map((h, i) => `<th style="text-align:${i ? "right" : "left"};color:#6b7380;font-weight:600;padding:6px 8px;border-bottom:1px solid #e1e4ea">${esc(h)}</th>`).join("")}</tr>
${rows.map((r) => `<tr>${r.map((c, i) => `<td style="text-align:${i ? "right" : "left"};padding:6px 8px;border-bottom:1px solid #eef0f3">${esc(c)}</td>`).join("")}</tr>`).join("")}</table>`;
const money = (v, kind) => (kind === "units" ? `${Math.round(v).toLocaleString("en-US")} units` : v.toLocaleString("en-US", { style: "currency", currency: "USD", maximumFractionDigits: 0 }));
const sum = (a) => a.reduce((s, v) => s + v, 0);

export function weeklyReport({ company, uploadName, forecast, backtest, low, link, monthLabel }) {
  const k = forecast.kind, next = sum(forecast.total.forecast), last = sum(forecast.total.history.slice(-3));
  const ch = last > 0 ? Math.round(((next - last) / last) * 100) : null;
  const movers = [...forecast.products].map((p) => ({ name: p.name, d: p.next3 - p.last3, next: p.next3 })).sort((a, b) => Math.abs(b.d) - Math.abs(a.d)).slice(0, 5);
  const regions = (forecast.regions || []).slice(0, 8);
  const body = `<p style="margin:0 0 12px">Forecast for <b>${esc(monthLabel(forecast.months[0]))} to ${esc(monthLabel(forecast.months[2]))}</b> from <b>${esc(uploadName)}</b>:</p>
<p style="font-size:28px;font-weight:700;margin:0">${esc(money(next, k))}</p>
<p style="margin:4px 0 16px;color:#4a5260">${ch === null ? "" : `${ch === 0 ? "About the same as" : `${Math.abs(ch)}% ${ch > 0 ? "more than" : "less than"}`} the last 3 months (${esc(money(last, k))}).`}
${backtest?.ok ? ` Accuracy test: <b>${backtest.accuracy}%</b>.` : ""}</p>
<ul style="padding-left:18px;margin:0 0 16px">${forecast.summary.slice(0, 4).map((s) => `<li style="margin:4px 0">${esc(s)}</li>`).join("")}</ul>
<h2 style="font-size:16px;margin:16px 0 6px">Biggest changes by product</h2>
${table(["Product", "Next 3 months", "Change"], movers.map((m) => [m.name, money(m.next, k), `${m.d >= 0 ? "+" : "−"}${money(Math.abs(m.d), k)}`]))}
${regions.length > 1 ? `<h2 style="font-size:16px;margin:16px 0 6px">By region</h2>${table(["Region", "Next 3 months", "Last 3 months"], regions.map((r) => [r.name, money(r.next3, k), money(r.last3, k)]))}` : ""}
${low?.length ? `<h2 style="font-size:16px;margin:16px 0 6px">Low stock (${low.length})</h2>${table(["Item", "Location", "On hand", "Order"], low.slice(0, 10).map((x) => [x.product, x.location || "—", String(x.onHand), String(x.suggestedQty)]))}` : ""}`;
  const text = `Forecast ${monthLabel(forecast.months[0])}–${monthLabel(forecast.months[2])} (${uploadName}): ${money(next, k)}${ch === null ? "" : ` (${ch >= 0 ? "+" : ""}${ch}% vs last 3 months)`}.\n${forecast.summary.slice(0, 4).join("\n")}\n${link}`;
  return { subject: `Weekly forecast — ${company}: ${money(next, k)} expected over the next 3 months`, html: shell(`Weekly forecast for ${company}`, body, link), text };
}

export function lowStockEmail({ company, items, link }) {
  const out = items.filter((x) => x.status === "out").length;
  const body = `<p style="margin:0 0 12px">${items.length} item${items.length === 1 ? " is" : "s are"} at or below the reorder point${out ? ` (${out} out of stock)` : ""}. Suggested orders are based on the forecast and each item's lead time.</p>
${table(["Item", "Location", "On hand", "Days left", "Suggested order"], items.slice(0, 50).map((x) => [x.product, x.location || "—", String(x.onHand), x.daysOfCover === null ? "—" : String(x.daysOfCover), String(x.suggestedQty)]))}
${items.length > 50 ? `<p style="color:#6b7380">…and ${items.length - 50} more in the app.</p>` : ""}`;
  const text = `${items.length} items at or below the reorder point:\n` + items.slice(0, 50).map((x) => `- ${x.product}${x.location ? ` @ ${x.location}` : ""}: on hand ${x.onHand}, order ${x.suggestedQty}`).join("\n") + `\n${link}`;
  return { subject: `Low stock at ${company}: ${items.length} item${items.length === 1 ? "" : "s"} to reorder`, html: shell(`Low stock — ${company}`, body, link), text };
}

export function inviteEmail({ company, inviter, link, role }) {
  const body = `<p>${esc(inviter)} invited you to <b>${esc(company)}</b> on the Forecasting Agent as ${role === "admin" ? "an admin" : `a ${esc(role)}`}.</p><p>The link works for 7 days.</p>`;
  return { subject: `You're invited to ${company} on the Forecasting Agent`, html: shell("You're invited", body, link), text: `${inviter} invited you to ${company} on the Forecasting Agent. Accept within 7 days: ${link}` };
}
