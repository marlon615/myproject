import type { Approval } from "./agent";
import type { InboxRow, ReplyRow } from "./inbox";
import { PRODUCT_NAME, type Draft, type Env } from "./types";
import { esc, page } from "./views";

const BUTTONS = `
<div class="row" style="position:sticky;bottom:0;background:var(--bg);padding:12px 0 calc(12px + env(safe-area-inset-bottom))">
  <button class="btn btn-no" name="decision" value="no">No</button>
  <button class="btn btn-yes" name="decision" value="yes">Yes, send</button>
</div>`;

/** What you see when you tap a notification: the item, and one Yes. */
export async function approvalPage(env: Env, a: Approval): Promise<string> {
  if (a.kind === "reply") {
    const r = await env.DB.prepare("select * from replies where id = ?").bind(Number(a.ref)).first<ReplyRow>();
    const m = r ? await env.DB.prepare("select * from inbox where id = ?").bind(r.inbox_id).first<InboxRow>() : null;
    if (!r || !m || r.status !== "pending") return approvalDonePage("Already handled.", true);
    return page("Approve reply", `<h1>Reply to ${esc(m.from_name || m.from_email)}</h1>
<div class="card"><div class="muted small">They wrote · ${esc(m.subject)}</div><p style="margin:6px 0 0">${esc(m.summary)}</p></div>
<form method="post">
<div class="card"><div class="muted small">Chief's reply · ${esc(r.subject)}</div><p style="white-space:pre-wrap;margin:6px 0 0">${esc(r.body)}</p></div>
<p class="muted small">Sends from your Gmail, in the same thread. Want to change a word? <a href="/review">Edit it in Review</a>.</p>
${BUTTONS}</form>`, { bare: true });
  }
  const ids = (JSON.parse(a.ref) as number[]).filter(Number.isInteger);
  if (!ids.length) return approvalDonePage("Nothing to send.", true);
  const { results } = await env.DB.prepare(
    `select d.*, p.name, p.email, p.organization from drafts d join prospects p on p.id = d.prospect_id where d.id in (${ids.map(() => "?").join(",")}) and d.status = 'pending' order by d.id`,
  ).bind(...ids).all<Draft & { name: string; email: string; organization: string }>();
  if (!results.length) return approvalDonePage("Already handled.", true);
  return page("Approve outreach", `<h1>${results.length} outreach email${results.length === 1 ? "" : "s"}</h1>
<p class="muted small">Tap any one to read it. One yes sends them all from your Gmail. To change or skip a single email, use <a href="/review">Review</a>.</p>
${results.map((d) => `<details class="card"><summary><span class="badge b-${d.product}">${PRODUCT_NAME[d.product]}</span> <b>${esc(d.name || d.email)}</b>${d.organization ? ` · ${esc(d.organization)}` : ""}<div class="muted small">${esc(d.subject)}</div></summary><p style="white-space:pre-wrap">${esc(d.body)}</p></details>`).join("")}
<form method="post">${BUTTONS.replace("Yes, send", `Yes, send all ${results.length}`)}</form>`, { bare: true });
}

export function approvalDonePage(message: string, ok: boolean) {
  return page("Done", `<div class="card" style="margin-top:14vh;text-align:center"><p style="font-size:2.4rem;margin:0">${ok ? "✓" : "⚠️"}</p><h1>${esc(message)}</h1><p><a class="btn btn-primary" href="/">Open Chief</a></p></div>`, { bare: true });
}
