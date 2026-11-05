import { createHmac, timingSafeEqual } from "node:crypto";
import type { SmsProvider } from "./types";

/**
 * Twilio provider (uses the REST API directly — no SDK needed).
 *
 * ┌─────────────────────────── PLUG YOUR KEYS IN HERE ───────────────────────────┐
 * │ Set these environment variables (locally in .env.local, on Vercel under      │
 * │ Project → Settings → Environment Variables):                                 │
 * │   SMS_PROVIDER=twilio                                                        │
 * │   TWILIO_ACCOUNT_SID=ACxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx                      │
 * │   TWILIO_AUTH_TOKEN=xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx                         │
 * │   TWILIO_FROM_NUMBER=+15555550123   (or TWILIO_MESSAGING_SERVICE_SID=MG...)  │
 * │ Then point your Twilio number's "A message comes in" webhook to:             │
 * │   https://YOUR-DOMAIN/api/sms/inbound   (HTTP POST)                          │
 * └──────────────────────────────────────────────────────────────────────────────┘
 */
const env = () => ({
  sid: process.env.TWILIO_ACCOUNT_SID ?? "",
  token: process.env.TWILIO_AUTH_TOKEN ?? "",
  from: process.env.TWILIO_FROM_NUMBER ?? "",
  messagingServiceSid: process.env.TWILIO_MESSAGING_SERVICE_SID ?? "",
});

export const twilioProvider: SmsProvider = {
  name: "twilio",

  async send(to, body) {
    const { sid, token, from, messagingServiceSid } = env();
    if (!sid || !token || (!from && !messagingServiceSid)) {
      return { ok: false, error: "Twilio is not configured (missing TWILIO_* env vars)." };
    }
    const form = new URLSearchParams({ To: to, Body: body });
    if (messagingServiceSid) form.set("MessagingServiceSid", messagingServiceSid);
    else form.set("From", from);

    try {
      const res = await fetch(`https://api.twilio.com/2010-04-01/Accounts/${sid}/Messages.json`, {
        method: "POST",
        headers: {
          Authorization: "Basic " + Buffer.from(`${sid}:${token}`).toString("base64"),
          "Content-Type": "application/x-www-form-urlencoded",
        },
        body: form,
      });
      const data = (await res.json().catch(() => ({}))) as { sid?: string; message?: string };
      if (!res.ok) return { ok: false, error: data.message ?? `Twilio HTTP ${res.status}` };
      return { ok: true, providerMessageId: data.sid };
    } catch (err) {
      return { ok: false, error: err instanceof Error ? err.message : String(err) };
    }
  },

  async parseInbound(req) {
    const { token } = env();
    const raw = await req.text();
    const params = new URLSearchParams(raw);

    // Verify the X-Twilio-Signature header so nobody can spoof replies.
    if (token) {
      const signature = req.headers.get("x-twilio-signature") ?? "";
      const url = publicUrl(req);
      const keys = [...new Set(params.keys())].sort();
      const data = url + keys.map((k) => k + (params.get(k) ?? "")).join("");
      const expected = createHmac("sha1", token).update(data).digest("base64");
      const a = Buffer.from(signature);
      const b = Buffer.from(expected);
      if (a.length !== b.length || !timingSafeEqual(a, b)) return null;
    }

    const from = params.get("From");
    const body = params.get("Body");
    if (!from || body == null) return null;
    return {
      from,
      to: params.get("To") ?? "",
      body,
      providerMessageId: params.get("MessageSid") ?? undefined,
    };
  },

  inboundResponse() {
    return new Response("<Response></Response>", {
      headers: { "Content-Type": "text/xml" },
    });
  },
};

/** Reconstruct the public URL Twilio called (Vercel sits behind a proxy). */
function publicUrl(req: Request) {
  const u = new URL(req.url);
  const host = req.headers.get("x-forwarded-host") ?? u.host;
  const proto = req.headers.get("x-forwarded-proto") ?? u.protocol.replace(":", "");
  return `${proto}://${host}${u.pathname}${u.search}`;
}
