import type { SmsProvider } from "./types";

/** Development provider: logs texts to the server console instead of sending them. */
export const consoleProvider: SmsProvider = {
  name: "console",
  async send(to, body) {
    console.log(`\n[sms:console] → ${to}\n${body}\n`);
    return { ok: true, providerMessageId: `console_${Date.now()}` };
  },
  async parseInbound(req) {
    const data = await req.json().catch(() => null);
    if (!data?.from || !data?.body) return null;
    return { from: data.from, to: data.to ?? "", body: data.body };
  },
};
