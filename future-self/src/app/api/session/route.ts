import { NextResponse } from "next/server";
import { randomUUID } from "node:crypto";
import { currentUserId, setUserCookie } from "@/lib/auth";
import { ready } from "@/lib/db";
import { allow, clientIp, sameOrigin } from "@/lib/ratelimit";

export const dynamic = "force-dynamic";

/**
 * Called by the phone once set-up is finished, and again each time the app opens.
 * Gives the device an anonymous id (signed, http-only cookie). A new id counts as one sign-up.
 */
export async function POST(req: Request) {
  if (!sameOrigin(req)) return NextResponse.json({ error: "Forbidden" }, { status: 403 });

  let id = await currentUserId();
  const isNew = !id;
  if (!id) {
    if (!allow(`signup:${clientIp(req.headers)}`, 10, 60 * 60 * 1000)) {
      return NextResponse.json({ error: "Too many sign-ups from this network. Try again later." }, { status: 429 });
    }
    id = randomUUID();
    await setUserCookie(id);
  }

  try {
    const db = await ready();
    if (db) {
      await db`insert into fs_users (id) values (${id}) on conflict (id) do update set last_seen_at = now()`;
    }
  } catch (e) {
    console.error("[future-self] session:", (e as Error).message);
  }
  return NextResponse.json({ ok: true, new: isNew });
}
