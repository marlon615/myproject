import "server-only";
import { headers } from "next/headers";

export const PRODUCT_NAME = "CallCairn";
export const TAGLINE = "Never miss an HVAC call again";

/** Monthly price shown in the UI (US dollars). The real charge comes from your PayPal plan (PAYPAL_PLAN_ID, see `npm run paypal:setup`). */
export const PRICE_MONTHLY_USD = 149;
/** The free pilot: one week, no payment details needed to start. */
export const TRIAL_DAYS = 7;

/**
 * The ONLY email that can open the private owner dashboard at /admin.
 * Changing who the owner is means changing this line and redeploying.
 */
export const OWNER_EMAIL = "foliopayments.ja@gmail.com";

/**
 * CallCairn's own US sales / demo line shown on the landing page, E.164.
 * Set PUBLIC_PHONE_NUMBER to a real number you own. The default is a fictional 555 number.
 */
export const PUBLIC_PHONE_E164 = process.env.PUBLIC_PHONE_NUMBER || "+15550100199";

export { US_TIMEZONES } from "./constants";

/**
 * Public base URL of the app, used in QR codes and texts.
 * Prefers APP_URL, then Vercel's production URL, then the incoming request host.
 */
export async function appUrl(): Promise<string> {
  if (process.env.APP_URL) return process.env.APP_URL.replace(/\/$/, "");
  if (process.env.VERCEL_PROJECT_PRODUCTION_URL)
    return `https://${process.env.VERCEL_PROJECT_PRODUCTION_URL}`;
  try {
    const h = await headers();
    const host = h.get("x-forwarded-host") ?? h.get("host");
    if (host) {
      const proto = h.get("x-forwarded-proto") ?? (host.startsWith("localhost") ? "http" : "https");
      return `${proto}://${host}`;
    }
  } catch {
    // Outside a request (e.g. cron) — fall through.
  }
  if (process.env.VERCEL_URL) return `https://${process.env.VERCEL_URL}`;
  return "http://localhost:3000";
}
