/**
 * Chief's autonomous side: runs on Cloudflare's schedule, phone open or not.
 * It never sends anything to anyone but you without your yes: it prepares, notifies, and waits.
 */
import { b64url, sha256 } from "./crypto";
import { buildDailyDrafts } from "./draft";
import { decideReply, gmailCreds, gmailSend, type InboxRow, type ReplyRow } from "./inbox";
import type { QueueItem, VoiceReply } from "./phone";
import { addTodo } from "./todos";
import { draftItem } from "./voice";
import { pushCount, sendPush, type PushMessage } from "./push";
import { sendEmail } from "./send";
import { getSettings } from "./settings";
import { PRODUCT_NAME, type Draft, type Env } from "./types";

export interface Approval { id: number; token_hash: string; kind: "reply" | "outreach_batch" | "fyi"; ref: string; title: string; expires_at: string; used_at: string | null }

// ── The kill phrase: everything stops until you say resume ──

export async function isPaused(env: Env) {
  return (await env.DB.prepare("select value from settings where key = 'agent:paused'").first<{ value: string }>())?.value === "1";
}
/** Stops the autopilot and cancels every notification approval that hasn't been used. Drafts stay saved. */
export async function pauseAgent(env: Env) {
  await env.DB.batch([
    env.DB.prepare("insert into settings (key, value) values ('agent:paused', '1') on conflict(key) do update set value = '1'"),
    env.DB.prepare("update approvals set used_at = ? where used_at is null").bind(new Date().toISOString()),
  ]);
}
export async function resumeAgent(env: Env) {
  await env.DB.prepare("insert into settings (key, value) values ('agent:paused', '0') on conflict(key) do update set value = '0'").run();
}

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
  if (await isPaused(env)) return "none";
  if ((await pushCount(env)) > 0 && (await sendPush(env, msg)) > 0) return "push";
  const g = await gmailCreds(env);
  if (!g) return "none";
  const origin = await appOrigin(env);
  const link = new URL(msg.url, origin).toString();
  const r = await gmailSend(env, {
    to: g.user,
    subject: msg.title === "Chief" ? `Chief: ${msg.body.slice(0, 80)}` : `Chief: ${msg.title}`,
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
      title: "Chief",
      body: short(`Reply ready for ${who}: ${r.summary}`),
      url: `/?go=${token}`,
      approve: token,
      tag: `reply${r.replyId}`,
      emailBody: `${who} wrote: ${r.summary}\n\nChief's reply:\n\n${r.body}`,
    });
  }
  if (replies.length > top.length) {
    await notify(env, { title: "Chief", body: `${replies.length - top.length} more replies are ready for your yes.`, url: "/?say=brief", tag: "more-replies" });
  }
}

/** Something that matters but needs no reply (a failed payment, a deadline): tell the owner. */
export async function notifyImportant(env: Env, items: { inboxId: number; fromName: string; fromEmail: string; subject: string; summary: string }[]) {
  for (const m of items.slice(0, 3)) {
    const who = m.fromName || m.fromEmail;
    const token = await createApproval(env, "fyi", String(m.inboxId), `Important: ${who}`);
    await notify(env, {
      title: "Chief",
      body: short(`Important from ${who}: ${m.summary || m.subject}`),
      url: `/?go=${token}`,
      tag: `fyi${m.inboxId}`,
      emailBody: `Important email from ${who}\nSubject: ${m.subject}\n\n${m.summary}`,
    });
  }
}

/** Lock-screen sized: one short line. */
function short(s: string, n = 120) {
  const t = s.replace(/\s+/g, " ").trim();
  return t.length > n ? t.slice(0, n - 1).replace(/\s+\S*$/, "") + "…" : t;
}

const AUTOMATED_SENDER = /no-?reply|do-?not-?reply|notifications?@|mailer-daemon|billing@|alerts?@|receipts?@|support@|security@|updates?@|info@/i;

// ── What the voice screen reads when you tap a notification ──

export async function itemFor(env: Env, a: Approval, token: string): Promise<VoiceReply> {
  if (a.used_at) return { say: "That one was already handled." };
  if (a.kind === "reply") {
    const r = await env.DB.prepare("select * from replies where id = ?").bind(Number(a.ref)).first<ReplyRow>();
    const m = r ? await env.DB.prepare("select * from inbox where id = ?").bind(r.inbox_id).first<InboxRow>() : null;
    if (!r || !m || r.status !== "pending") return { say: "That reply was already handled." };
    const who = m.from_name || m.from_email;
    return { say: "", queue: [{
      say: `${who} wrote${m.subject ? ` about ${m.subject}` : ""}. ${m.summary} Here's the reply I drafted.`,
      show: { heading: `Reply to ${who}`, to: `${who} <${m.from_email}>`, subject: r.subject, context: m.summary, body: r.body },
      ask: "I recommend sending it. Should I send it?",
      decideUrl: `/approve/${token}`,
    }] };
  }
  if (a.kind === "fyi") {
    const m = await env.DB.prepare("select * from inbox where id = ?").bind(Number(a.ref)).first<InboxRow>();
    if (!m) return { say: "I can't find that email anymore." };
    const who = m.from_name || m.from_email;
    const automated = AUTOMATED_SENDER.test(m.from_email);
    return { say: "", queue: [{
      say: `Important email from ${who}.`,
      show: { heading: `Important: ${who}`, to: m.from_email, subject: m.subject, body: m.summary },
      ask: automated
        ? "It's an automated notice, so there's nothing to reply to. My recommendation: handle it today. Should I add it to your list?"
        : "My recommendation: answer it today. Should I draft a reply?",
      yesLabel: automated ? "Yes, add to my list" : "Yes, draft a reply",
      decideUrl: `/approve/${token}`,
    }] };
  }
  // A batch of outreach: read each one fully, yes or no on each.
  const ids = (JSON.parse(a.ref) as number[]).filter(Number.isInteger);
  const { results } = ids.length ? await env.DB.prepare(
    `select d.*, p.name, p.email, p.organization from drafts d join prospects p on p.id = d.prospect_id where d.id in (${ids.map(() => "?").join(",")}) and d.status = 'pending' order by d.id`,
  ).bind(...ids).all<Draft & { name: string; email: string; organization: string }>() : { results: [] };
  if (!results.length) return { say: "Those outreach emails were already handled." };
  const queue: QueueItem[] = results.map((d, i) => draftItem(d, d, i + 1, results.length));
  return { say: `You have ${results.length} outreach email${results.length === 1 ? "" : "s"} ready. I recommend sending ${results.length === 1 ? "it" : "them"}. I'll read each one, and you say yes or no.`, queue };
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
      title: "Chief",
      body: short(`${ids.length} outreach email${ids.length === 1 ? "" : "s"} ready for your yes. ${yesterday}`),
      url: `/?go=${token}`,
      approve: token,
      tag: "outreach",
    });
  } else {
    await notify(env, { title: "Chief", body: short(`Good morning. ${yesterday}`), url: "/?say=brief", tag: "morning" });
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

export async function runApproval(env: Env, a: Approval, decision: "yes" | "no"): Promise<{ ok: boolean; label?: string; error?: string; say?: string; queue?: QueueItem[] }> {
  if (await isPaused(env)) return { ok: false, error: "Chief is stopped. Say resume to start again." };
  const claim = await env.DB.prepare("update approvals set used_at = ? where id = ? and used_at is null").bind(new Date().toISOString(), a.id).run();
  if (!claim.meta.changes) return { ok: false, error: "This was already handled." };
  if (a.kind === "reply") {
    const r = await decideReply(env, Number(a.ref), decision);
    if (!r.ok) await env.DB.prepare("update approvals set used_at = null where id = ?").bind(a.id).run();
    return r.ok ? { ok: true, label: decision === "yes" ? "Sent ✓" : "Skipped" } : { ok: false, error: r.error };
  }
  if (a.kind === "fyi") {
    if (decision === "no") return { ok: true, label: "Okay." };
    const m = await env.DB.prepare("select * from inbox where id = ?").bind(Number(a.ref)).first<InboxRow>();
    if (!m) return { ok: false, error: "I can't find that email anymore." };
    await env.DB.prepare("update inbox set status = 'heard' where id = ? and status = 'new'").bind(m.id).run();
    if (AUTOMATED_SENDER.test(m.from_email)) {
      const t = await addTodo(env, `Handle: ${m.subject || m.summary}`.slice(0, 200));
      return { ok: true, say: `Added to your list: ${t?.text ?? m.subject}.` };
    }
    const s = await getSettings(env);
    const first = (m.from_name || "").replace(/"/g, "").trim().split(/\s+/)[0] || "there";
    const body = `Hi ${first},\n\nThanks for letting me know. I'm on it, and I'll get back to you today.\n\n${(s.senderName || "").split(/\s+/)[0]}`.trim();
    const subj = /^re:/i.test(m.subject) ? m.subject : `Re: ${m.subject}`;
    const rep = await env.DB.prepare("insert into replies (inbox_id, to_email, to_name, subject, body) values (?, ?, ?, ?, ?) returning id")
      .bind(m.id, m.from_email, m.from_name, subj.slice(0, 300), body).first<{ id: number }>();
    const who = m.from_name || m.from_email;
    return { ok: true, say: "Here's a reply.", queue: [{
      say: `Reply to ${who}.`, show: { heading: `Reply to ${who}`, to: `${who} <${m.from_email}>`, subject: subj, context: m.summary, body },
      ask: "Should I send it?", decideUrl: `/replies/${rep!.id}/decide`,
    }] };
  }
  const ids = (JSON.parse(a.ref) as number[]).filter(Number.isInteger);
  if (decision === "no") return { ok: true, label: "Okay, nothing sent. They're still in Review if you change your mind." };
  const r = await sendOutreachBatch(env, ids);
  const label = `Sent ${r.sent} of ${ids.length - r.skipped}.${r.failed.length ? ` ${r.failed.length} failed.` : ""}`;
  await notify(env, {
    title: "Chief",
    body: short(`Outreach results: ${label}${r.failed.length ? ` ${r.failed[0]}` : ""} I'll tell you when someone replies.`),
    url: "/dashboard",
    tag: "outreach-results",
  });
  return { ok: true, label };
}

export function productName(p: string) {
  return PRODUCT_NAME[p as "clientpulse"] ?? p;
}
