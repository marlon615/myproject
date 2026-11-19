/**
 * Google Gemini API (free tier), REST, no libraries.
 *
 *   listModels(env)                          → ["gemini-2.5-flash", …]  models this key can call with generateContent
 *   ask(env, model, prompt, { search, json, schema }) → { text, sources, supports, queries }
 *       search: true  → Grounding with Google Search: the answer comes with the web pages it was based on
 *       json/schema   → structured JSON output (only without search)
 *   GeminiError: .kind = "limit" (429 / quota) | "no-grounding" (not on this tier/model) | "location" (region not
 *                supported) | "key" (missing/invalid key) | "model" (not found) | "other"
 *   supportedSources(answer, line) → the grounding sources Google attached to that part of the answer (never invented)
 */
const DEFAULT_BASE = "https://generativelanguage.googleapis.com";

export class GeminiError extends Error {
  constructor(kind, message, status) { super(message); this.kind = kind; this.status = status; }
}
const base = (env) => (env.ALLOW_TEST === "1" && env.GEMINI_BASE ? env.GEMINI_BASE : DEFAULT_BASE);

function classify(status, body) {
  const msg = String(body?.error?.message || body?.error?.status || `HTTP ${status}`);
  if (status === 429 || /RESOURCE_EXHAUSTED|quota|rate limit/i.test(msg)) return new GeminiError("limit", msg, status);
  if (/location is not supported|not available in your country|region/i.test(msg)) return new GeminiError("location", msg, status);
  if (status === 401 || /API key not valid|API_KEY_INVALID|PERMISSION_DENIED.*key|missing.*key/i.test(msg)) return new GeminiError("key", msg, status);
  if (/google_search|grounding|search tool|tool.*not supported|free tier/i.test(msg)) return new GeminiError("no-grounding", msg, status);
  if (status === 404) return new GeminiError("model", msg, status);
  return new GeminiError("other", msg, status);
}

async function call(env, path, init, timeoutMs) {
  if (!env.GEMINI_API_KEY) throw new GeminiError("key", "No Gemini API key yet (GEMINI_API_KEY).", 0);
  let res;
  try {
    res = await fetch(`${base(env)}${path}`, { ...init, headers: { "content-type": "application/json", "x-goog-api-key": env.GEMINI_API_KEY, ...(init.headers || {}) }, signal: AbortSignal.timeout(timeoutMs) });
  } catch (e) { throw new GeminiError("other", `Couldn't reach Gemini (${e?.name === "TimeoutError" ? "timed out" : "network"}).`, 0); }
  const body = await res.json().catch(() => ({}));
  if (!res.ok) throw classify(res.status, body);
  return body;
}

export async function listModels(env) {
  const out = [];
  let token = "";
  for (let page = 0; page < 5; page++) {
    const b = await call(env, `/v1beta/models?pageSize=200${token ? `&pageToken=${encodeURIComponent(token)}` : ""}`, { method: "GET" }, 20000);
    for (const m of b.models || []) if ((m.supportedGenerationMethods || []).includes("generateContent")) out.push(String(m.name).replace(/^models\//, ""));
    token = b.nextPageToken;
    if (!token) break;
  }
  return out;
}

export async function ask(env, model, prompt, { search = false, schema = null, temperature = 0.2 } = {}) {
  const body = { contents: [{ role: "user", parts: [{ text: prompt }] }], generationConfig: { temperature } };
  if (search) body.tools = [{ google_search: {} }];
  if (schema) Object.assign(body.generationConfig, { responseMimeType: "application/json", responseSchema: schema });
  const b = await call(env, `/v1beta/models/${encodeURIComponent(model)}:generateContent`, { method: "POST", body: JSON.stringify(body) }, 90000);
  const cand = b.candidates?.[0];
  if (!cand) throw new GeminiError("other", `No answer (${b.promptFeedback?.blockReason || "empty"}).`, 200);
  const text = (cand.content?.parts || []).map((p) => p.text || "").join("");
  const gm = cand.groundingMetadata || {};
  const sources = (gm.groundingChunks || []).map((c) => (c.web?.uri ? { uri: String(c.web.uri), title: String(c.web.title || "") } : null));
  const supports = (gm.groundingSupports || []).map((s) => ({ text: String(s.segment?.text || ""), chunks: (s.groundingChunkIndices || []).filter((i) => Number.isInteger(i)) }));
  return { text, sources, supports, queries: gm.webSearchQueries || [], usage: b.usageMetadata || null };
}

const norm = (s) => String(s || "").toLowerCase().replace(/[‘’]/g, "'").replace(/[“”]/g, '"').replace(/\s+/g, " ").trim();
/**
 * The grounding sources Google attached to a line of the answer: every support whose segment overlaps the line.
 * Returns [] when Google didn't attach any — then the line has no proof and is left out.
 */
const unlabel = (s) => s.replace(/^\s*[*-]?\s*\**[a-z]+\**\s*:\s*/, "");
const numbers = (s) => s.match(/\d+(?:[.,]\d+)?/g) || [];
export function supportedSources(answer, line) {
  const l = unlabel(norm(line));
  if (l.length < 3) return [];
  const idx = new Set(), nums = numbers(l);
  for (const s of answer.supports) {
    const t = unlabel(norm(s.text));
    if (t.length < 3) continue;
    // Any number in the line (a price, a count) must appear in the backing text itself: no made-up numbers.
    if (nums.length && !nums.every((n) => t.includes(n))) continue;
    const loose = l.split(" ").filter((w) => w.length > 3).length >= 4 && overlap(l, t) >= 0.6; // only for real sentences
    if (t.includes(l) || (l.length >= 12 && l.includes(t) && t.length >= 12) || loose) for (const i of s.chunks) idx.add(i);
  }
  return [...idx].map((i) => answer.sources[i]).filter(Boolean);
}
function overlap(a, b) {
  const wa = new Set(a.split(" ").filter((w) => w.length > 3)), wb = new Set(b.split(" ").filter((w) => w.length > 3));
  if (!wa.size || !wb.size) return 0;
  let n = 0; for (const w of wa) if (wb.has(w)) n++;
  return n / Math.min(wa.size, wb.size);
}
