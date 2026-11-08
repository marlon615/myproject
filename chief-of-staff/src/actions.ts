/** What Chief can do to an email when you tell it to on the call. */
import { gmailCreds, gmailSend, type InboxRow } from "./inbox";
import { Imap } from "./mail/imap";
import { mailHosts } from "./mail/net";
import type { Env } from "./types";

async function withInbox<T>(env: Env, fn: (im: Imap, user: string) => Promise<T>): Promise<T | null> {
  const c = await gmailCreds(env);
  if (!c) return null;
  const im = await Imap.login(mailHosts(env).imap, c.user, c.pass);
  try {
    await im.select("INBOX");
    return await fn(im, c.user);
  } finally {
    await im.logout();
  }
}

/** "Don't reply": done with it here, and marked read in Gmail. */
export async function dontReply(env: Env, m: InboxRow) {
  await env.DB.prepare("update inbox set status = 'dismissed' where id = ?").bind(m.id).run();
  await env.DB.prepare("update replies set status = 'rejected', decided_at = ? where inbox_id = ? and status = 'pending'").bind(new Date().toISOString(), m.id).run();
  if (m.uid) await withInbox(env, (im) => im.markRead([m.uid!])).catch((e) => console.error("mark read failed:", (e as Error).message));
}

/** "Block that sender": everything from them goes to Spam, now and on every future check. */
export async function blockSender(env: Env, m: InboxRow): Promise<number> {
  const email = m.from_email.toLowerCase();
  await env.DB.batch([
    env.DB.prepare("insert into blocked (email) values (?) on conflict(email) do nothing").bind(email),
    env.DB.prepare("update inbox set status = 'dismissed' where from_email = ? and status = 'new'").bind(email),
    env.DB.prepare("update replies set status = 'rejected', decided_at = ? where status = 'pending' and to_email = ?").bind(new Date().toISOString(), email),
  ]);
  const moved = await withInbox(env, async (im) => {
    const uids = await im.searchGmail(`in:inbox from:${email}`);
    if (!uids.length) return 0;
    const spam = (await im.specialMailbox("\\Junk")) ?? "[Gmail]/Spam";
    await im.move(uids, spam);
    return uids.length;
  }).catch((e) => { console.error("block move failed:", (e as Error).message); return 0; });
  return moved ?? 0;
}

/**
 * "Unsubscribe": uses the sender's own unsubscribe link (one-click when offered, else their unsubscribe email).
 * If they offer none, blocks them instead. Returns what to tell you.
 */
export async function unsubscribe(env: Env, m: InboxRow): Promise<string> {
  const who = m.from_name || m.from_email;
  const parts = [...m.unsub.matchAll(/<([^>]+)>/g)].map((x) => x[1].trim());
  const http = parts.find((p) => /^https:\/\//i.test(p));
  const mailto = parts.find((p) => /^mailto:/i.test(p));
  await dontReply(env, m);
  try {
    if (http && m.unsub_post) {
      const r = await fetch(http, { method: "POST", headers: { "Content-Type": "application/x-www-form-urlencoded" }, body: "List-Unsubscribe=One-Click", redirect: "follow" });
      if (r.ok || (r.status >= 300 && r.status < 400)) return `Done. I unsubscribed you from ${who}.`;
    }
    if (mailto) {
      const u = new URL(mailto);
      const to = decodeURIComponent(u.pathname);
      const subject = u.searchParams.get("subject") || "unsubscribe";
      const r = await gmailSend(env, { to, subject, text: u.searchParams.get("body") || "Please unsubscribe me from this list." });
      if (r.ok) return `Done. I sent ${who} your unsubscribe request.`;
    }
    if (http) {
      const r = await fetch(http, { method: "GET", redirect: "follow" });
      if (r.ok) return `I opened ${who}'s unsubscribe link. Most lists stop right away; if this one asks for a confirmation, I'll block them if they write again.`;
    }
  } catch (e) {
    console.error("unsubscribe failed:", (e as Error).message);
  }
  await blockSender(env, m);
  return `${who} doesn't offer a working unsubscribe link, so I blocked them instead. Their emails will go to Spam.`;
}
