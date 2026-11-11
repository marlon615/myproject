import { connect } from "cloudflare:sockets";

/** Where to reach Gmail. Tests can point these at local stand-in servers (MAIL_TEST_HOST, plain TCP). */
export interface MailHosts {
  imap: { hostname: string; port: number; tls: boolean };
  smtp: { hostname: string; port: number; tls: boolean };
}

export function mailHosts(env: { MAIL_TEST_HOST?: string; MAIL_TEST_IMAP_PORT?: string; MAIL_TEST_SMTP_PORT?: string }): MailHosts {
  if (env.MAIL_TEST_HOST) {
    return {
      imap: { hostname: env.MAIL_TEST_HOST, port: Number(env.MAIL_TEST_IMAP_PORT || 1143), tls: false },
      smtp: { hostname: env.MAIL_TEST_HOST, port: Number(env.MAIL_TEST_SMTP_PORT || 1025), tls: false },
    };
  }
  return {
    imap: { hostname: "imap.gmail.com", port: 993, tls: true },
    smtp: { hostname: "smtp.gmail.com", port: 465, tls: true },
  };
}

const enc = new TextEncoder();
const dec = new TextDecoder();

/** A line-oriented TCP/TLS connection with a byte buffer, used by the IMAP and SMTP clients. */
export class Conn {
  private reader: ReadableStreamDefaultReader<Uint8Array>;
  private writer: WritableStreamDefaultWriter<Uint8Array>;
  private buf = new Uint8Array(0);
  private socket: Socket;
  private deadline: number;

  private constructor(socket: Socket, timeoutMs: number) {
    this.socket = socket;
    this.reader = socket.readable.getReader();
    this.writer = socket.writable.getWriter();
    this.deadline = Date.now() + timeoutMs;
  }

  static async open(h: { hostname: string; port: number; tls: boolean }, timeoutMs = 25_000) {
    const socket = connect({ hostname: h.hostname, port: h.port }, { secureTransport: h.tls ? "on" : "off", allowHalfOpen: false });
    await socket.opened;
    return new Conn(socket, timeoutMs);
  }

  async write(s: string | Uint8Array) {
    await this.writer.write(typeof s === "string" ? enc.encode(s) : s);
  }

  private async fill() {
    if (Date.now() > this.deadline) throw new Error("The mail server took too long to answer.");
    const timeout = new Promise<never>((_, rej) => setTimeout(() => rej(new Error("The mail server took too long to answer.")), Math.max(1000, this.deadline - Date.now())));
    const { value, done } = await Promise.race([this.reader.read(), timeout]);
    if (done) throw new Error("The mail server closed the connection.");
    const next = new Uint8Array(this.buf.length + value.length);
    next.set(this.buf);
    next.set(value, this.buf.length);
    this.buf = next;
  }

  /** Reads one line, without the CRLF. */
  async readLine(): Promise<string> {
    for (;;) {
      const i = this.buf.indexOf(10);
      if (i >= 0) {
        const line = this.buf.subarray(0, i);
        this.buf = this.buf.slice(i + 1);
        return dec.decode(line).replace(/\r$/, "");
      }
      if (this.buf.length > 2_000_000) throw new Error("Mail server line too long.");
      await this.fill();
    }
  }

  /** Reads exactly n bytes. */
  async readBytes(n: number): Promise<Uint8Array> {
    while (this.buf.length < n) await this.fill();
    const out = this.buf.slice(0, n);
    this.buf = this.buf.slice(n);
    return out;
  }

  async close() {
    try { this.reader.releaseLock(); } catch {}
    try { this.writer.releaseLock(); } catch {}
    try { await this.socket.close(); } catch {}
  }
}
