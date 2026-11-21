import { NextResponse } from "next/server";
import Anthropic from "@anthropic-ai/sdk";
import { futureSelfReply } from "@/lib/ai";
import { currentUserId } from "@/lib/auth";
import { DAILY_CHAT_LIMIT } from "@/lib/config";
import { ready, track } from "@/lib/db";
import { allow, clientIp, sameOrigin } from "@/lib/ratelimit";
import type { ChatRequest, ChatTurn } from "@/lib/types";

export const dynamic = "force-dynamic";
export const maxDuration = 60;

const str = (v: unknown, max: number) => (typeof v === "string" ? v.replace(/\s+/g, " ").trim().slice(0, max) : "");

function parse(body: unknown): ChatRequest | null {
  if (!body || typeof body !== "object") return null;
  const b = body as Record<string, unknown>;
  const p = (b.profile ?? {}) as Record<string, unknown>;
  const mode = b.mode === "checkin" ? "checkin" : "talk";
  const history: ChatTurn[] = Array.isArray(b.history)
    ? b.history.slice(-12).flatMap((t) => {
        const r = t as Record<string, unknown>;
        const text = str(r?.text, 1500);
        return text && (r.role === "user" || r.role === "future") ? [{ role: r.role, text }] : [];
      })
    : [];
  const c = (b.checkin ?? {}) as Record<string, unknown>;
  const req: ChatRequest = {
    mode,
    profile: { name: str(p.name, 60), goals: str(p.goals, 1200), moneyTarget: str(p.moneyTarget, 200), habits: str(p.habits, 800) },
    message: str(b.message, 2000),
    history,
    recentWins: Array.isArray(b.recentWins) ? b.recentWins.slice(0, 8).map((w) => str(w, 120)).filter(Boolean) : [],
    streak: Math.max(0, Math.min(10000, Math.floor(Number(b.streak) || 0))),
    checkin: mode === "checkin" ? { yesterday: str(c.yesterday, 1500), move: str(c.move, 600) } : undefined,
    localTime: str(b.localTime, 80) || undefined,
  };
  if (!req.profile.name) return null;
  if (mode === "talk" && !req.message) return null;
  if (mode === "checkin" && !req.checkin?.yesterday && !req.checkin?.move) return null;
  return req;
}

async function usedToday(userId: string): Promise<number> {
  try {
    const db = await ready();
    if (!db) return 0;
    const [r] = await db<{ n: number }[]>`
      select count(*)::int as n from fs_events
      where user_id = ${userId} and kind in ('chat', 'checkin') and created_at > now() - interval '24 hours'`;
    return r?.n ?? 0;
  } catch {
    return 0;
  }
}

export async function POST(req: Request) {
  if (!sameOrigin(req)) return NextResponse.json({ error: "Forbidden" }, { status: 403 });

  const userId = await currentUserId();
  if (!userId) return NextResponse.json({ error: "Finish set-up first." }, { status: 401 });

  if (!allow(`chat:u:${userId}`, 8, 60_000) || !allow(`chat:ip:${clientIp(req.headers)}`, 30, 60_000)) {
    return NextResponse.json({ error: "Slow down a little. Take a breath and try again in a minute." }, { status: 429 });
  }
  if ((await usedToday(userId)) >= DAILY_CHAT_LIMIT) {
    return NextResponse.json({ error: "That's enough talk for today. Go do the thing, and come back tomorrow." }, { status: 429 });
  }

  const raw = await req.text();
  if (raw.length > 40_000) return NextResponse.json({ error: "Message too long." }, { status: 413 });
  let body: unknown;
  try {
    body = JSON.parse(raw);
  } catch {
    return NextResponse.json({ error: "Bad request." }, { status: 400 });
  }
  const parsed = parse(body);
  if (!parsed) return NextResponse.json({ error: "Say something first." }, { status: 400 });

  if (!process.env.ANTHROPIC_API_KEY) {
    return NextResponse.json({ error: "The app isn't connected to the AI yet (ANTHROPIC_API_KEY is missing on the server)." }, { status: 503 });
  }

  try {
    const out = await futureSelfReply(parsed);
    await track(userId, parsed.mode === "checkin" ? "checkin" : "chat");
    if (out.win) await track(userId, "win");
    return NextResponse.json(out);
  } catch (e) {
    if (e instanceof Anthropic.RateLimitError) {
      return NextResponse.json({ error: "I'm getting a lot of calls right now. Try again in a moment." }, { status: 503 });
    }
    if (e instanceof Anthropic.AuthenticationError) {
      console.error("[future-self] Anthropic rejected the API key");
      return NextResponse.json({ error: "The AI key on the server is wrong. The owner needs to fix ANTHROPIC_API_KEY." }, { status: 503 });
    }
    if (e instanceof Anthropic.APIError) {
      console.error("[future-self] Anthropic error", e.status, e.message);
    } else {
      console.error("[future-self] chat failed:", (e as Error).message);
    }
    return NextResponse.json({ error: "I couldn't get through just now. Try again." }, { status: 502 });
  }
}
