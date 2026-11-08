import { footer } from "./draft";
import { gmailCreds, gmailSend } from "./inbox";
import { getSecret, type Settings } from "./settings";
import type { Env } from "./types";

export type SendResult = { ok: true; via: "gmail" } | { ok: true; via: "resend" } | { ok: true; via: "mailto"; href: string } | { ok: false; error: string };

export function mailtoHref(to: string, subject: string, body: string) {
  return `mailto:${encodeURIComponent(to)}?subject=${encodeURIComponent(subject)}&body=${encodeURIComponent(body)}`;
}

/**
 * Sends one approved email: from your Gmail if connected, else through Resend if set up.
 * Without them, the phone's own Mail app opens with the email filled in, ready to send.
 */
export async function sendEmail(env: Env, s: Settings, to: string, subject: string, body: string): Promise<SendResult> {
  const full = body + "\n" + footer(s);
  // 1) Your own Gmail, when connected.
  const g = await gmailCreds(env);
  if (g) {
    const r = await gmailSend(env, { to, subject, text: full, listUnsubscribe: `<mailto:${s.replyTo || g.user}?subject=unsubscribe>` });
    return r.ok ? { ok: true, via: "gmail" } : { ok: false, error: r.error };
  }
  // 2) Resend, when set up. 3) Otherwise the phone's Mail app.
  const key = await getSecret(env, "resend");
  if (!key || !s.senderEmail) return { ok: true, via: "mailto", href: mailtoHref(to, subject, full) };

  const res = await fetch("https://api.resend.com/emails", {
    method: "POST",
    headers: { Authorization: `Bearer ${key}`, "Content-Type": "application/json" },
    body: JSON.stringify({
      from: s.senderName ? `${s.senderName} <${s.senderEmail}>` : s.senderEmail,
      to: [to],
      subject,
      text: full,
      reply_to: s.replyTo || s.senderEmail,
      headers: { "List-Unsubscribe": `<mailto:${s.replyTo || s.senderEmail}?subject=unsubscribe>` },
    }),
  });
  if (res.ok) return { ok: true, via: "resend" };
  const err = await res.text().catch(() => "");
  let msg = `Email service said ${res.status}`;
  try {
    const j = JSON.parse(err) as { message?: string };
    if (j.message) msg += `: ${j.message}`;
  } catch {}
  return { ok: false, error: msg.slice(0, 300) };
}
