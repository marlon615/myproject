import { NextResponse } from "next/server";
import { currentUserId } from "@/lib/auth";
import { track } from "@/lib/db";
import { allow, sameOrigin } from "@/lib/ratelimit";

export const dynamic = "force-dynamic";

/** Counts a win the person typed in by hand. The win's text stays on their phone; only the count is stored. */
export async function POST(req: Request) {
  if (!sameOrigin(req)) return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  const id = await currentUserId();
  if (!id) return NextResponse.json({ error: "Finish set-up first." }, { status: 401 });
  if (!allow(`win:${id}`, 30, 60 * 60 * 1000)) return NextResponse.json({ ok: true });
  await track(id, "win");
  return NextResponse.json({ ok: true });
}
