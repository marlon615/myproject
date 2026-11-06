import { getSmsProvider } from "@/lib/sms";
import { normalizeUsPhone } from "@/lib/utils";
import { recordInbound } from "@/lib/messaging";

/** Inbound text webhook (guest replies, STOP/START). Point your provider's webhook here. */
export async function POST(req: Request) {
  const provider = getSmsProvider();
  if (!provider.parseInbound) return new Response("Inbound not supported by provider", { status: 501 });

  // The console (dev) provider has no signature, so require the cron secret to stop spoofing.
  if (provider.name === "console" && req.headers.get("authorization") !== `Bearer ${process.env.CRON_SECRET}`) {
    return new Response("Unauthorized", { status: 401 });
  }

  const inbound = await provider.parseInbound(req);
  if (!inbound) return new Response("Invalid request", { status: 403 });

  const from = normalizeUsPhone(inbound.from) ?? inbound.from;
  await recordInbound(from, inbound.body, inbound.providerMessageId);
  return provider.inboundResponse?.() ?? Response.json({ ok: true });
}
