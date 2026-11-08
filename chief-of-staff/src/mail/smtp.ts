import { Conn } from "./net";

export class SmtpError extends Error {}

const b64 = (s: string) => {
  const bytes = new TextEncoder().encode(s);
  let bin = "";
  for (const b of bytes) bin += String.fromCharCode(b);
  return btoa(bin);
};

async function reply(c: Conn): Promise<{ code: number; text: string }> {
  let text = "";
  for (;;) {
    const line = await c.readLine();
    const m = line.match(/^(\d{3})([ -])(.*)$/);
    if (!m) throw new SmtpError("Unexpected answer from the mail server.");
    text += (text ? " " : "") + m[3];
    if (m[2] === " ") return { code: Number(m[1]), text };
  }
}

async function expect(c: Conn, codes: number[], what: string) {
  const r = await reply(c);
  if (!codes.includes(r.code)) {
    if (r.code === 535 || /Username and Password not accepted|BadCredentials/i.test(r.text)) {
      throw new SmtpError("Gmail rejected the email address or app password.");
    }
    throw new SmtpError(`${what} failed: ${r.code} ${r.text}`.slice(0, 300));
  }
  return r;
}

/**
 * Sends one already-built message through Gmail (implicit TLS on 465, AUTH PLAIN with an app password).
 * Gmail files it in Sent automatically.
 */
export async function smtpSend(
  h: { hostname: string; port: number; tls: boolean },
  user: string, pass: string, from: string, to: string[], message: string,
): Promise<void> {
  const c = await Conn.open(h);
  try {
    await expect(c, [220], "Connecting");
    await c.write("EHLO chief-of-staff\r\n");
    await expect(c, [250], "Hello");
    await c.write(`AUTH PLAIN ${b64(`\u0000${user}\u0000${pass}`)}\r\n`);
    await expect(c, [235], "Sign-in");
    await c.write(`MAIL FROM:<${from}>\r\n`);
    await expect(c, [250], "Sender");
    for (const t of to) {
      await c.write(`RCPT TO:<${t}>\r\n`);
      await expect(c, [250, 251], "Recipient");
    }
    await c.write("DATA\r\n");
    await expect(c, [354], "Message");
    // Dot-stuffing: a line starting with "." gets an extra "."
    const body = message.replace(/\r?\n/g, "\r\n").replace(/^\./gm, "..");
    await c.write(body + (body.endsWith("\r\n") ? "" : "\r\n") + ".\r\n");
    await expect(c, [250], "Sending");
    await c.write("QUIT\r\n");
  } finally {
    await c.close();
  }
}

/** Checks the address and app password without sending anything. */
export async function smtpCheck(h: { hostname: string; port: number; tls: boolean }, user: string, pass: string) {
  const c = await Conn.open(h);
  try {
    await expect(c, [220], "Connecting");
    await c.write("EHLO chief-of-staff\r\n");
    await expect(c, [250], "Hello");
    await c.write(`AUTH PLAIN ${b64(`\u0000${user}\u0000${pass}`)}\r\n`);
    await expect(c, [235], "Sign-in");
    await c.write("QUIT\r\n");
  } finally {
    await c.close();
  }
}
