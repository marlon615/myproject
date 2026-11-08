/** Builds a plain-text email (RFC 5322 + MIME), safe for any language. */

const ascii = (s: string) => /^[\x20-\x7e]*$/.test(s);
const b64 = (s: string) => {
  const bytes = new TextEncoder().encode(s);
  let bin = "";
  for (const b of bytes) bin += String.fromCharCode(b);
  return btoa(bin);
};
/** Strips anything that could inject extra headers. */
const clean = (s: string) => s.replace(/[\r\n]+/g, " ").trim();
const word = (s: string) => (ascii(s) ? s : `=?UTF-8?B?${b64(s)}?=`);

export function addr(name: string, email: string) {
  const n = clean(name).replace(/"/g, "");
  return n ? `${ascii(n) ? `"${n}"` : word(n)} <${clean(email)}>` : `<${clean(email)}>`;
}

export function newMessageId(fromEmail: string) {
  const domain = fromEmail.split("@")[1] || "chief.local";
  return `<${crypto.randomUUID()}@${domain}>`;
}

export function buildMessage(o: {
  fromName: string; fromEmail: string; to: string; toName?: string; replyTo?: string;
  subject: string; text: string; inReplyTo?: string; references?: string; listUnsubscribe?: string; messageId: string;
}): string {
  const body = b64(o.text.replace(/\r?\n/g, "\r\n")).replace(/.{1,76}/g, "$&\r\n");
  const h = [
    `From: ${addr(o.fromName, o.fromEmail)}`,
    `To: ${addr(o.toName ?? "", o.to)}`,
    `Subject: ${word(clean(o.subject))}`,
    `Date: ${new Date().toUTCString().replace("GMT", "+0000")}`,
    `Message-ID: ${clean(o.messageId)}`,
    "MIME-Version: 1.0",
    "Content-Type: text/plain; charset=UTF-8",
    "Content-Transfer-Encoding: base64",
  ];
  if (o.replyTo) h.push(`Reply-To: ${clean(o.replyTo)}`);
  if (o.inReplyTo) h.push(`In-Reply-To: ${clean(o.inReplyTo)}`);
  if (o.references) h.push(`References: ${clean(o.references)}`);
  if (o.listUnsubscribe) h.push(`List-Unsubscribe: ${clean(o.listUnsubscribe)}`);
  return h.join("\r\n") + "\r\n\r\n" + body;
}
