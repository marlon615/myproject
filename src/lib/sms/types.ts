export type SendResult =
  | { ok: true; providerMessageId?: string }
  | { ok: false; error: string };

export type InboundMessage = { from: string; to: string; body: string; providerMessageId?: string };

/**
 * Every texting provider implements this interface.
 * To add a new provider (Telnyx, Plivo, Vonage, ...):
 *   1. Create src/lib/sms/<name>.ts that exports an SmsProvider.
 *   2. Register it in src/lib/sms/index.ts.
 *   3. Set SMS_PROVIDER=<name> plus that provider's keys in your environment.
 */
export interface SmsProvider {
  readonly name: string;
  /** Send a text. `to` is always E.164 (+1XXXXXXXXXX). */
  send(to: string, body: string): Promise<SendResult>;
  /**
   * Optional: parse an inbound-message webhook (replies, STOP) into a common shape.
   * Return null if the request isn't valid / can't be verified.
   */
  parseInbound?(req: Request): Promise<InboundMessage | null>;
  /** Optional: body to return to the provider after an inbound webhook. */
  inboundResponse?(): Response;
}
