/**
 * Marlon Pro · Shelf photo: which of the company's own products are on a store shelf, and how many.
 *
 * The rep's phone sends one photo (shrunk on the phone to about 200 KB). It is matched ONLY against the company's own
 * saved products (My Products, kept on the server for that company): their names and sizes, plus one small reference
 * photo per product (up to 40), go to Google's Gemini API on the FREE tier (no billing is ever set up) with a strict
 * instruction: count the listed products, and put anything else it sees under "unknown". Back here, any name that isn't
 * one of the company's products becomes an unknown product too (nothing is invented), and counts are kept to whole
 * numbers 1–999. The shelf photo isn't stored anywhere by Marlon: it's sent to Gemini once and forgotten.
 *
 *   shelfCount(env, { image, mime, products: [{ id, label }], refs: [{ label, data }] })
 *     → { ok: true, found: [{ productId, name, count }], unknown: [{ description, count }], model } | { error, message }
 *   error: "setup" (no GEMINI_API_KEY) | "limit" (Google's free daily limit reached) | "failed"
 */
const DEFAULT_BASE = "https://generativelanguage.googleapis.com";
// Tried in order: the first one this key can use on the free tier answers. A model Google retired moves to the next.
const MODELS = ["gemini-flash-lite-latest", "gemini-flash-latest", "gemini-2.5-flash-lite", "gemini-2.5-flash"];

const SCHEMA = {
  type: "OBJECT",
  properties: {
    products: { type: "ARRAY", items: { type: "OBJECT", properties: { name: { type: "STRING" }, count: { type: "INTEGER" } }, required: ["name", "count"] } },
    unknown: { type: "ARRAY", items: { type: "OBJECT", properties: { description: { type: "STRING" }, count: { type: "INTEGER" } }, required: ["description", "count"] } },
  },
  required: ["products"],
};

const norm = (s) => String(s || "").toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();

export function shelfPrompt(labels, refLabels = []) {
  return `The LAST photo is a shelf in a store. Count how many units of each of THIS company's products you can see on that shelf (only these, by name):
${labels.map((p) => `- ${p}`).join("\n")}
${refLabels.length ? `\nBefore the shelf photo come reference photos of some of these products, each labelled with its name, so you can recognise them. The reference photos are not the shelf: don't count them.\n` : ""}
Rules:
- In "products", use exactly the product names above. Never add a product that isn't on the list to "products".
- Count individual units (bottles, packs, bags…) you can actually see. If a product isn't visible, leave it out.
- Anything else you can see that is NOT one of these products goes in "unknown", with a short description (e.g. "red can") and how many.
- If you're not sure whether something is one of these products, put it in "unknown" rather than guess.`;
}

/**
 * Keeps the company's own products (matched by name), with whole-number counts, summing duplicates. Names that aren't
 * the company's products, and Gemini's own "unknown" list, come back as unknown products.
 */
export function cleanFound(raw, products) {
  const byKey = new Map(products.map((p) => [norm(p.label), p]));
  const out = new Map(), unknown = [];
  const whole = (v) => { const n = Number(v); return Number.isFinite(n) && n > 0 ? Math.min(999, Math.round(n)) : 0; };
  for (const it of Array.isArray(raw?.products) ? raw.products : []) {
    const n = whole(it?.count);
    if (!n) continue;
    const p = byKey.get(norm(it?.name));
    if (p) out.set(p.id, Math.min(999, (out.get(p.id) || 0) + n));
    else unknown.push({ description: "", count: n }); // a name that isn't on the company's list: never shown as if it were
  }
  for (const it of Array.isArray(raw?.unknown) ? raw.unknown : []) {
    const n = whole(it?.count);
    if (n) unknown.push({ description: String(it?.description || "").replace(/\s+/g, " ").trim().slice(0, 60), count: n });
  }
  return {
    found: products.filter((p) => out.has(p.id)).map((p) => ({ productId: p.id, name: p.label, count: out.get(p.id) })),
    unknown: unknown.slice(0, 20),
  };
}

export async function shelfCount(env, { image, mime, products, refs = [] }) {
  if (!env.GEMINI_API_KEY) return { error: "setup", message: "Shelf photo isn't set up on this server yet (no Gemini key)." };
  const base = env.ALLOW_TEST_CLOCK === "1" && env.GEMINI_BASE ? env.GEMINI_BASE : DEFAULT_BASE;
  const parts = [{ text: shelfPrompt(products.map((p) => p.label), refs.map((r) => r.label)) }];
  for (const r of refs) parts.push({ text: `Reference photo: ${r.label}` }, { inline_data: { mime_type: "image/jpeg", data: r.data } });
  parts.push({ text: "The shelf photo:" }, { inline_data: { mime_type: mime, data: image } });
  const body = JSON.stringify({
    contents: [{ role: "user", parts }],
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
    return { ok: true, ...cleanFound(raw, products), model };
  }
  return { error: "failed", message: `No photo checker model was available (${last.slice(0, 80) || "none"}).` };
}
