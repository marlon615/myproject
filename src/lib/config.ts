import "server-only";
import { headers } from "next/headers";

/** Monthly price shown in the UI. The real charge comes from your Stripe price (STRIPE_PRICE_ID). */
export const PRICE_MONTHLY_USD = 39;
export const TRIAL_DAYS = 7;

/** Follow-up cadence after a guest submits the form. */
export const CHECKIN_AFTER_DAYS = 3;
export const INVITE_AFTER_DAYS = 7;

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
