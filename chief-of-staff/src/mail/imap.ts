import { Conn } from "./net";

/** One untagged server response: its text (literals replaced by {n}) and any literal byte blocks. */
interface Untagged { text: string; literals: Uint8Array[] }

const q = (s: string) => `"${s.replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"`;

export class ImapError extends Error {}

/** A minimal read-only IMAP client: just enough to list and fetch recent Gmail messages. */
export class Imap {
  private n = 0;
  private constructor(private c: Conn) {}

  static async login(h: { hostname: string; port: number; tls: boolean }, user: string, pass: string): Promise<Imap> {
    const c = await Conn.open(h);
    const im = new Imap(c);
    const greet = await c.readLine();
    if (!/^\* (OK|PREAUTH)/i.test(greet)) throw new ImapError("Gmail didn't greet us properly.");
    try {
      await im.cmd(`LOGIN ${q(user)} ${q(pass)}`);
    } catch (e) {
      await c.close();
      const m = (e as Error).message;
      if (/AUTHENTICATIONFAILED|Invalid credentials|LOGIN failed|authenticat/i.test(m)) {
        throw new ImapError("Gmail rejected the email address or app password.");
      }
      if (/IMAP access|disabled/i.test(m)) throw new ImapError("IMAP is turned off for this Gmail account.");
      throw e;
    }
    return im;
  }

  /** Sends a command and collects untagged responses until the tagged reply. */
  async cmd(command: string): Promise<Untagged[]> {
    const tag = `c${++this.n}`;
    await this.c.write(`${tag} ${command}\r\n`);
    const out: Untagged[] = [];
    let cur: Untagged | null = null;
    for (;;) {
      const line = await this.c.readLine();
      if (cur) {
        // continuation of a response that had a literal
        cur.text += line;
      } else if (line.startsWith(`${tag} `)) {
        const rest = line.slice(tag.length + 1);
        if (/^OK/i.test(rest)) return out;
        throw new ImapError(rest.replace(/^(NO|BAD)\s*/i, "") || "The mail server refused the request.");
      } else if (line.startsWith("+")) {
        continue;
      } else {
        cur = { text: line, literals: [] };
      }
      // A line ending in {n} is followed by n raw bytes, then more of the same response.
      const lit = cur.text.match(/\{(\d+)\}$/);
      if (lit) {
        cur.literals.push(await this.c.readBytes(Number(lit[1])));
        continue;
      }
      out.push(cur);
      cur = null;
    }
  }

  async examineInbox() {
    await this.cmd("EXAMINE INBOX");
  }

  /** Gmail search syntax via the X-GM-RAW extension; returns UIDs, newest last. */
  async searchGmail(query: string): Promise<number[]> {
    const res = await this.cmd(`UID SEARCH X-GM-RAW ${q(query)}`);
    const ids: number[] = [];
    for (const r of res) {
      const m = r.text.match(/^\* SEARCH\s*(.*)$/i);
      if (m) for (const x of m[1].trim().split(/\s+/)) if (/^\d+$/.test(x)) ids.push(Number(x));
    }
    return ids.sort((a, b) => a - b);
  }

  /** Fetches the first `bytes` of each message without marking it read. */
  async fetchRaw(uids: number[], bytes = 16000): Promise<{ uid: number; raw: Uint8Array }[]> {
    if (!uids.length) return [];
    const res = await this.cmd(`UID FETCH ${uids.join(",")} (UID BODY.PEEK[]<0.${bytes}>)`);
    const out: { uid: number; raw: Uint8Array }[] = [];
    for (const r of res) {
      if (!/^\* \d+ FETCH/i.test(r.text)) continue;
      const uid = Number(r.text.match(/UID (\d+)/i)?.[1]);
      if (uid && r.literals[0]) out.push({ uid, raw: r.literals[0] });
    }
    return out;
  }

  async logout() {
    try { await this.cmd("LOGOUT"); } catch {}
    await this.c.close();
  }
}
