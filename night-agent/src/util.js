/** Small helpers: Jamaica time, hashing, similarity, KV JSON. */
const te = new TextEncoder();
export const hex = (buf) => Array.from(new Uint8Array(buf), (b) => b.toString(16).padStart(2, "0")).join("");
export const randomHex = (n) => hex(crypto.getRandomValues(new Uint8Array(n)));
export const sha256 = async (s) => hex(await crypto.subtle.digest("SHA-256", te.encode(s)));

const JM = "America/Jamaica"; // UTC−5 all year (no daylight saving)
export function jamaica(now = Date.now()) {
  const p = Object.fromEntries(new Intl.DateTimeFormat("en-CA", { timeZone: JM, year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", hourCycle: "h23" }).formatToParts(new Date(now)).map((x) => [x.type, x.value]));
  return { date: `${p.year}-${p.month}-${p.day}`, hour: Number(p.hour), minute: Number(p.minute) };
}
export const jamaicaTime = (iso) => new Date(iso).toLocaleString("en-US", { timeZone: JM, month: "short", day: "numeric", hour: "numeric", minute: "2-digit" });
export const prettyNight = (id) => new Date(`${id}T12:00:00Z`).toLocaleDateString("en-US", { weekday: "long", month: "long", day: "numeric", year: "numeric", timeZone: "UTC" });

/** Words that matter in a title, for "is this the same idea?" checks. */
const STOP = new Set(["with", "that", "their", "from", "this", "have", "they", "into", "about", "software", "tool", "tools", "app", "apps", "small", "businesses", "business", "owners"]);
export const keyWords = (s) => new Set(String(s || "").toLowerCase().replace(/[^a-z0-9 ]+/g, " ").split(/\s+/).filter((w) => w.length > 3 && !STOP.has(w)).map((w) => w.replace(/(ies|es|s)$/, "")));
export function similar(a, b) {
  const x = keyWords(a), y = keyWords(b);
  if (!x.size || !y.size) return 0;
  let n = 0; for (const w of x) if (y.has(w)) n++;
  return n / (x.size + y.size - n);
}

export async function getJSON(kv, key, fallback = null) { try { return (await kv.get(key, "json")) ?? fallback; } catch { return fallback; } }
export const putJSON = (kv, key, value, opts) => kv.put(key, JSON.stringify(value), opts);
export const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);
export const domainOf = (u) => { try { return new URL(u).hostname.replace(/^www\./, ""); } catch { return ""; } };
