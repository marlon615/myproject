"use client";

import type { ChatRequest, ChatResponse } from "@/lib/types";

export async function register() {
  try {
    await fetch("/api/session", { method: "POST", credentials: "same-origin" });
  } catch {
    /* offline: try again next time */
  }
}

export async function askFutureSelf(body: ChatRequest): Promise<{ reply: string; win: string | null }> {
  let res: Response;
  try {
    res = await fetch("/api/chat", {
      method: "POST",
      credentials: "same-origin",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
  } catch {
    throw new Error("You're offline. Connect to the internet and try again.");
  }
  if (res.status === 401) {
    await register();
    return askFutureSelf(body);
  }
  const data = (await res.json().catch(() => ({ error: "Something went wrong. Try again." }))) as ChatResponse;
  if ("error" in data) throw new Error(data.error);
  return data;
}

export function countManualWin() {
  fetch("/api/win", { method: "POST", credentials: "same-origin" }).catch(() => {});
}
