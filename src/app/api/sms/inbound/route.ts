import { after } from "next/server";
import { getSmsProvider } from "@/lib/sms";
import { normalizeUsPhone } from "@/lib/utils";
import { contractorForNumber } from "@/lib/voice";
import { findOrStartConversation, respond } from "@/lib/agent";
import { handleKeywords, logInbound, sendText, isOptedOut } from "@/lib/messaging";
import { serviceActive } from "@/lib/billing";

export const maxDuration = 60;

/**
 * Inbound texts to a contractor's CallCairn line (replies to text-backs, or people who text
 * the number directly). The assistant answers each one.
 */
export async function POST(req: Request) {
  const provider = getSmsProvider();
  if (!provider.parseInbound) return new Response("Inbound not supported by provider", { status: 501 });

  // The console (dev) provider has no signature, so require the cron secret to stop spoofing.
  if (provider.name === "console" && req.headers.get("authorization") !== `Bearer ${process.env.CRON_SECRET}`) {
    return new Response("Unauthorized", { status: 401 });
  }

  const inbound = await provider.parseInbound(req);
  if (!inbound) return new Response("Invalid request", { status: 403 });
  const ok = () => provider.inboundResponse?.() ?? Response.json({ ok: true });

  const c = await contractorForNumber(inbound.to);
  if (!c) return ok();
  const from = normalizeUsPhone(inbound.from) ?? inbound.from;
  // Ignore the contractor texting their own line (e.g. replying to an alert).
  if (from === c.alertPhone || from === c.businessPhone) {
    await logInbound(c, from, inbound.body, "reply", null, inbound.providerMessageId);
    return ok();
  }

  const keyword = await handleKeywords(c, from, inbound.body);
  if (keyword) {
    await logInbound(c, from, inbound.body, keyword === "stop" ? "optout" : "optin", null, inbound.providerMessageId);
    return ok(); // Carrier / Twilio sends the standard STOP / START confirmations.
  }

  const conv = await findOrStartConversation(c, from, "sms");
  await logInbound(c, from, inbound.body, "reply", conv.id, inbound.providerMessageId);
  if (!serviceActive(c) || (await isOptedOut(c.id, from))) return ok();

  // Every assistant text starts with "<Business> automated assistant:" (see sendText), so the
  // caller is told it's automated in each message.
  // Reply after acknowledging Twilio, so a slow model call never times out the webhook.
  after(async () => {
    const turn = await respond(c, conv, inbound.body, "sms");
    await sendText(c, from, turn.reply, conv.status === "booked" && turn.end ? "confirmation" : "assistant", conv.id);
  });
  return ok();
}
