/**
 * Marlon Pro · Shelf photo: which of the company's own products are on a store shelf, and how many.
 *
 * The rep's phone sends one photo (shrunk on the phone to about 200 KB) and the company's product names. The photo
 * goes to Google's Gemini API on the FREE tier (no billing is ever set up) with a strict instruction: count only the
 * listed products, and answer only in the JSON shape below. Back here, any name that isn't one of the company's
 * products is dropped (nothing invented), and counts are kept to whole numbers 0–999.
 * The photo isn't stored anywhere by Marlon: it's sent to Gemini once and forgotten.
 *
 *   shelfCount(env, { image, mime, products }) → { ok: true, found: [{ name, count }], model } | { error, message }
 *   error: "setup" (no GEMINI_API_KEY) | "limit" (Google's free daily limit reached) | "failed"
 */
const DEFAULT_BASE = "https://generativelanguage.googleapis.com";
// Tried in order: the first one this key can use on the free tier answers. A model Google retired moves to the next.
const MODELS = ["gemini-flash-lite-latest", "gemini-flash-latest", "gemini-2.5-flash-lite", "gemini-2.5-flash"];

const SCHEMA = {
  type: "OBJECT",
  properties: { products: { type: "ARRAY", items: { type: "OBJECT", properties: { name: { type: "STRING" }, count: { type: "INTEGER" } }, required: ["name", "count"] } } },
  required: ["products"],
};

const norm = (s) => String(s || "").toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();

export function shelfPrompt(products) {
  return `This is a photo of a shelf in a store. Count how many units of each of THESE products you can see on the shelf (only these, by name):
${products.map((p) => `- ${p}`).join("\n")}

Rules:
- Use exactly the product names above. Never add a product that isn't on the list.
- Count individual units (bottles, packs, bags…) you can actually see. If a product isn't visible, leave it out.
- If you're not sure what a product is, leave it out rather than guess.`;
}

/** Keeps only the company's own products (matched by name), with whole-number counts; sums duplicates. */
export function cleanFound(raw, products) {
  const byKey = new Map(products.map((p) => [norm(p), p]));
  const out = new Map();
  for (const it of Array.isArray(raw?.products) ? raw.products : []) {
    const name = byKey.get(norm(it?.name));
    const n = Number(it?.count);
    if (!name || !Number.isFinite(n) || n <= 0) continue;
    out.set(name, Math.min(999, (out.get(name) || 0) + Math.round(n)));
  }
  return products.filter((p) => out.has(p)).map((p) => ({ name: p, count: out.get(p) }));
}

export async function shelfCount(env, { image, mime, products }) {
  if (!env.GEMINI_API_KEY) return { error: "setup", message: "Shelf photo isn't set up on this server yet (no Gemini key)." };
  const base = env.ALLOW_TEST_CLOCK === "1" && env.GEMINI_BASE ? env.GEMINI_BASE : DEFAULT_BASE;
  const body = JSON.stringify({
    contents: [{ role: "user", parts: [{ text: shelfPrompt(products) }, { inline_data: { mime_type: mime, data: image } }] }],
    generationConfig: { temperature: 0, responseMimeType: "application/json", responseSchema: SCHEMA },
  });
  let last = "";
  for (const model of MODELS) {
    let res;
    try {
      res = await fetch(`${base}/v1beta/models/${encodeURIComponent(model)}:generateContent`, {
        method: "POST", headers: { "content-type": "application/json", "x-goog-api-key": env.GEMINI_API_KEY }, body, signal: AbortSignal.timeout(45000),
      });
    } catch (e) { return { error: "failed", message: `Couldn't reach the photo checker (${e?.name === "TimeoutError" ? "it took too long" : "network"}). Try again.` }; }
    const b = await res.json().catch(() => ({}));
    const msg = String(b?.error?.message || "");
    if (res.status === 429 || /RESOURCE_EXHAUSTED|quota/i.test(msg)) return { error: "limit", message: "Today's free photo checks are used up. Try again tomorrow." };
    if (res.status === 404 || /no longer available|not found for API version|not supported for generateContent/i.test(msg)) { last = msg; continue; }
    if (!res.ok) return { error: "failed", message: res.status === 400 && /API key/i.test(msg) ? "The photo checker's key isn't working. Contact the seller." : "The photo checker couldn't read this photo. Try again." };
    const text = (b.candidates?.[0]?.content?.parts || []).map((p) => p.text || "").join("");
    let raw;
    try { raw = JSON.parse(text); } catch { return { error: "failed", message: "The photo checker's answer wasn't readable. Try again." }; }
    return { ok: true, found: cleanFound(raw, products), model };
  }
  return { error: "failed", message: `No photo checker model was available (${last.slice(0, 80) || "none"}).` };
}
