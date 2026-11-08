/**
 * Chief's autonomous side: runs on Cloudflare's schedule, phone open or not.
 * It never sends anything to anyone but you without your yes: it prepares, notifies, and waits.
 */
import { b64url, sha256 } from "./crypto";
import { buildDailyDrafts } from "./draft";
import { decideReply, gmailCreds, gmailSend } from "./inbox";
import { pushCount, sendPush, type PushMessage } from "./push";
import { sendEmail } from "./send";
import { getSettings } from "./settings";
import { PRODUCT_NAME, type Draft, type Env } from "./types";

export interface Approval { id: number; token_hash: string; kind: "reply" | "outreach_batch"; ref: string; title: string; expires_at: string; used_at: string | null }

// ── One-tap approval tokens ──

export async function createApproval(env: Env, kind: Approval["kind"], ref: string, title: string, days = 7): Promise<string> {
  const token = b64url(crypto.getRandomValues(new Uint8Array(24)));
  await env.DB.prepare("insert into approvals (token_hash, kind, ref, title, expires_at) values (?, ?, ?, ?, ?)")
    .bind(await sha256(token), kind, ref, title.slice(0, 200), new Date(Date.now() + days * 86400_000).toISOString()).run();
  return token;
}

export async function findApproval(env: Env, token: string): Promise<Approval | null> {
  if (!/^[A-Za-z0-9_-]{20,64}$/.test(token)) return null;
  const a = await env.DB.prepare("select * from approvals where token_hash = ?").bind(await sha256(token)).first<Approval>();
  if (!a || a.expires_at < new Date().toISOString()) return null;
  return a;
}

// ── Where the app lives (for links in emails) ──

export async function appOrigin(env: Env) {
  return (await env.DB.prepare("select value from settings where key = 'app:origin'").first<{ value: string }>())?.value ?? "https://chief-of-staff.marlon615.workers.dev";
}
export async function rememberOrigin(env: Env, origin: string) {
  if (!/^https:\/\//.test(origin)) return;
  await env.DB.prepare("insert into settings (key, value) values ('app:origin', ?) on conflict(key) do update set value = excluded.value").bind(origin).run();
}

// ── Notifications: phone first, email to yourself as the backup ──

export async function notify(env: Env, msg: PushMessage & { emailBody?: string }): Promise<"push" | "email" | "none"> {
  if ((await pushCount(env)) > 0 && (await sendPush(env, msg)) > 0) return "push";
  const g = await gmailCreds(env);
  if (!g) return "none";
  const origin = await appOrigin(env);
  const link = new URL(msg.url, origin).toString();
  const r = await gmailSend(env, {
    to: g.user,
    subject: `Chief: ${msg.title}`,
    text: `${msg.emailBody ?? msg.body}\n\n${msg.approve ? "Approve with one tap" : "Open"}: ${link}\n\n— Chief of Staff`,
  });
  return r.ok ? "email" : "none";
}

// ── New inbox replies → one notification each ──

export async function notifyNewReplies(env: Env, replies: { replyId: number; fromName: string; fromEmail: string; summary: string; body: string }[]) {
  const top = replies.slice(0, 3);
  for (const r of top) {
    const who = r.fromName || r.fromEmail;
    const token = await createApproval(env, "reply", String(r.replyId), `Reply to ${who}`);
    await notify(env, {
      title: `Reply to ${who} is ready`,
      body: `${r.summary}`.slice(0, 180),
      url: `/approve/${token}`,
      approve: token,
      tag: `reply${r.replyId}`,
      emailBody: `${who} wrote: ${r.summary}\n\nChief's reply:\n\n${r.body}`,
    });
  }
  if (replies.length > top.length) {
    await notify(env, { title: `${replies.length - top.length} more replies ready`, body: "Open Chief to review them.", url: "/review", tag: "more-replies" });
  }
}


// ── Morning: draft outreach, ask for one yes, report yesterday ──

export async function morningRun(env: Env): Promise<string> {
  const r = await buildDailyDrafts(env, "cron");
  const { results } = await env.DB.prepare("select id from drafts where status = 'pending' order by id").all<{ id: number }>();
  const since = new Date(Date.now() - 24 * 3600_000).toISOString();
  const [sent, failed, replied] = await Promise.all([
    env.DB.prepare("select count(*) as n from drafts where status = 'sent' and sent_at > ?").bind(since).first<{ n: number }>(),
    env.DB.prepare("select count(*) as n from drafts where status = 'failed' and decided_at > ?").bind(since).first<{ n: number }>(),
    env.DB.prepare("select count(*) as n from inbox i join prospects p on p.email = i.from_email where i.created_at > ?").bind(since).first<{ n: number }>(),
  ]);
  const yesterday = `Yesterday: ${sent?.n ?? 0} outreach sent${failed?.n ? `, ${failed.n} failed` : ""}, ${replied?.n ?? 0} prospect ${replied?.n === 1 ? "reply" : "replies"}.`;
  if (results.length) {
    const ids = results.map((x) => x.id);
    const token = await createApproval(env, "outreach_batch", JSON.stringify(ids), `${ids.length} outreach emails`, 2);
    await notify(env, {
      title: `${ids.length} outreach email${ids.length === 1 ? "" : "s"} ready`,
      body: `${yesterday} Tap to read them, then one yes sends them all.`,
      url: `/approve/${token}`,
      approve: token,
      tag: "outreach",
    });
  } else {
    await notify(env, { title: "Good morning", body: `${yesterday} ${r.note}`, url: "/", tag: "morning" });
  }
  return `${r.note} ${yesterday}`;
}

// ── Doing what you approved ──

export async function sendOutreachBatch(env: Env, ids: number[]): Promise<{ sent: number; failed: string[]; skipped: number }> {
  const s = await getSettings(env);
  let sent = 0, skipped = 0;
  const failed: string[] = [];
  for (const id of ids) {
    const d = await env.DB.prepare("select d.*, p.email, p.name, p.status as pstatus from drafts d join prospects p on p.id = d.prospect_id where d.id = ?").bind(id)
      .first<Draft & { email: string; name: string; pstatus: string }>();
    if (!d || d.status !== "pending" || d.pstatus === "do_not_contact" || d.pstatus === "not_interested" || d.pstatus === "replied") { skipped++; continue; }
    const claim = await env.DB.prepare("update drafts set status = 'approved', decided_at = ? where id = ? and status = 'pending'").bind(new Date().toISOString(), id).run();
    if (!claim.meta.changes) { skipped++; continue; }
    const r = await sendEmail(env, s, d.email, d.subject, d.body);
    const now = new Date().toISOString();
    if (r.ok && r.via !== "mailto") {
      await env.DB.batch([
        env.DB.prepare("update drafts set status = 'sent', sent_at = ?, error = null where id = ?").bind(now, id),
        env.DB.prepare("update prospects set touches = touches + 1, last_sent_at = ?, status = case when status = 'new' then 'contacted' else status end where id = ?").bind(now, d.prospect_id),
      ]);
      sent++;
    } else {
      const err = r.ok ? "Gmail isn't connected, so it couldn't be sent from the cloud." : r.error;
      await env.DB.prepare("update drafts set status = 'pending', error = ? where id = ?").bind(err, id).run();
      failed.push(`${d.name || d.email}: ${err}`);
    }
  }
  return { sent, failed, skipped };
}

export async function runApproval(env: Env, a: Approval, decision: "yes" | "no"): Promise<{ ok: boolean; label?: string; error?: string }> {
  const claim = await env.DB.prepare("update approvals set used_at = ? where id = ? and used_at is null").bind(new Date().toISOString(), a.id).run();
  if (!claim.meta.changes) return { ok: false, error: "This was already handled." };
  if (a.kind === "reply") {
    const r = await decideReply(env, Number(a.ref), decision);
    if (!r.ok) await env.DB.prepare("update approvals set used_at = null where id = ?").bind(a.id).run();
    return r.ok ? { ok: true, label: decision === "yes" ? "Sent ✓" : "Skipped" } : { ok: false, error: r.error };
  }
  const ids = (JSON.parse(a.ref) as number[]).filter(Number.isInteger);
  if (decision === "no") return { ok: true, label: "Okay, nothing sent. They're still in Review if you change your mind." };
  const r = await sendOutreachBatch(env, ids);
  const label = `Sent ${r.sent} of ${ids.length - r.skipped}.${r.failed.length ? ` ${r.failed.length} failed.` : ""}`;
  await notify(env, {
    title: "Outreach results",
    body: `${label}${r.failed.length ? ` ${r.failed[0]}` : ""} I'll tell you when someone replies.`,
    url: "/dashboard",
    tag: "outreach-results",
  });
  return { ok: true, label };
}

export function productName(p: string) {
  return PRODUCT_NAME[p as "clientpulse"] ?? p;
}
