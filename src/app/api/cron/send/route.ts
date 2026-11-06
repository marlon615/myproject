import { processDueMessages } from "@/lib/messaging";

export const maxDuration = 60;

/**
 * Sends every text that's due (day-3 check-ins, day-7 invites, and any thank-you that
 * didn't go out instantly). Vercel Cron calls this with `Authorization: Bearer $CRON_SECRET`.
 */
export async function GET(req: Request) {
  const secret = process.env.CRON_SECRET;
  if (!secret) return new Response("CRON_SECRET not set", { status: 500 });
  if (req.headers.get("authorization") !== `Bearer ${secret}`) {
    return new Response("Unauthorized", { status: 401 });
  }
  const result = await processDueMessages();
  return Response.json(result);
}
