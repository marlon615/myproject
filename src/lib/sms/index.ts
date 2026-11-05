import "server-only";
import type { SmsProvider } from "./types";
import { consoleProvider } from "./console";
import { twilioProvider } from "./twilio";

/**
 * Provider registry. Pick one with the SMS_PROVIDER env var.
 * Add new providers here — nothing else in the app needs to change.
 */
const providers: Record<string, SmsProvider> = {
  console: consoleProvider,
  twilio: twilioProvider,
};

export function getSmsProvider(): SmsProvider {
  const name = (process.env.SMS_PROVIDER ?? "console").toLowerCase();
  const provider = providers[name];
  if (!provider) throw new Error(`Unknown SMS_PROVIDER "${name}". Options: ${Object.keys(providers).join(", ")}`);
  return provider;
}

export type { SmsProvider, SendResult, InboundMessage } from "./types";
