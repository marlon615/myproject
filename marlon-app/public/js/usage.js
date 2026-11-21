/**
 * Anonymous usage counts for the app's maker: how many businesses set it up, open it, write invoices, use voice,
 * print or share — never names, customers, products, prices or amounts. A random id made on this phone (linked to
 * nobody) tells phones apart, so the maker sees "how many businesses", not who.
 *
 * Counts wait on the phone and go when there's a connection; offline use is never held up.
 * The business can turn it off in the owner dashboard → Settings (setting "usage" = false).
 *
 *   track("open" | "setup" | "invoice" | "voice" | "print" | "pdf" | "picture")
 */
import { settings } from "./db.js";
import { todayISO } from "./util.js";

const KINDS = new Set(["open", "setup", "invoice", "voice", "print", "pdf", "picture"]);
const QUEUE = "usageQueue";
let chain = Promise.resolve(); // one change to the queue at a time
let sending = false;

export async function usageEnabled() {
  return (await settings.get("usage", true)) !== false;
}

export async function setUsageEnabled(on) {
  await settings.set("usage", Boolean(on));
  if (!on) await settings.set(QUEUE, []);
}

async function deviceId() {
  let id = await settings.get("deviceId", null);
  if (!id) {
    id = Array.from(crypto.getRandomValues(new Uint8Array(16)), (b) => b.toString(16).padStart(2, "0")).join("");
    await settings.set("deviceId", id);
  }
  return id;
}

/** Counts one thing that happened (nothing is sent when counting is off). Never throws, never waits on the network. */
export function track(kind) {
  if (!KINDS.has(kind)) return Promise.resolve();
  chain = chain.then(async () => {
    if (!(await usageEnabled())) return;
    const queue = (await settings.get(QUEUE, [])) || [];
    queue.push({ kind, day: todayISO() });
    await settings.set(QUEUE, queue.slice(-300));
  }).catch(() => {});
  chain.then(() => flush());
  return chain;
}

/** Sends what's waiting, when online. */
export async function flush() {
  if (sending || (typeof navigator !== "undefined" && navigator.onLine === false)) return;
  sending = true;
  try {
    if (!(await usageEnabled())) return;
    const queue = (await settings.get(QUEUE, [])) || [];
    if (!queue.length) return;
    const batch = queue.slice(0, 50);
    const res = await fetch("/api/ping", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ device: await deviceId(), events: batch }),
      keepalive: true,
    });
    if (res.ok) {
      chain = chain.then(async () => {
        const now = (await settings.get(QUEUE, [])) || [];
        await settings.set(QUEUE, now.slice(batch.length));
      }).catch(() => {});
    }
  } catch { /* offline or blocked: try again later */ } finally {
    sending = false;
  }
}

if (typeof window !== "undefined") window.addEventListener("online", () => { flush(); });
