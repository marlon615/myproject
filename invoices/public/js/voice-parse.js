/**
 * Understands a spoken invoice, e.g.
 *   "Sarah Supermarket, 14 Wellington Street, Brownstone, two dozen beetroot juice, one dozen cucumber juice,
 *    five dozen large bammy, fifty pounds okra at two fifty"
 *
 * parseSpokenInvoice(text, { products, stores, today }) →
 *   { store, address, addressFrom, savedAddress, date, dateHeard, lines, transcript }
 *
 * Nothing is decided by position. A phrase with an amount, a dozen, a price or a product name is a product line and
 * never goes in the address. The address is optional: it is filled only from a phrase that clearly is one (a house
 * number and street, a street/road/avenue/lane, the town said right after a street, or a known place), otherwise it
 * stays blank. A store used before offers its last address (savedAddress) but never fills it by itself.
 *   line: { key, productId, name, qty, unit, price, priceFrom ("said" | null), saidAs ("2 dozen" when converted), heard, issue }
 *
 * Products are matched loosely (case, plurals, extra words and close sounds don't matter); the one best match is used,
 * and it only asks "which product?" when two products are equally close. "Dozen" means 12: dozens become single items.
 *
 * Prices are only ever the ones said for this invoice ("24 beetroot juice 315 per unit", "16 green juice at 230");
 * nothing is filled in from earlier invoices. A spoken date ("12th of the 11th 2026") sets the invoice date.
 *   issue: null | { kind, message, choices? }   kind: "product" | "which" | "quantity" | "price" | "noPrice" | "store"
 *
 * Nothing said is dropped. What can't be settled — two products equally close, words that match no product, a missing
 * amount, a price that can't be read — comes back as a line with an `issue`, for the review screen to highlight.
 * Only filler ("please", "okay", "that's all") is left out.
 * Pure (no DOM), so it can be tested anywhere.
 */
import { defaultUnitFor, normalizeUnit, todayISO } from "./util.js";

// ── Words ────────────────────────────────────────────────────────────────

const ONES = { zero: 0, oh: 0, one: 1, two: 2, three: 3, four: 4, five: 5, six: 6, seven: 7, eight: 8, nine: 9, ten: 10,
  eleven: 11, twelve: 12, thirteen: 13, fourteen: 14, fifteen: 15, sixteen: 16, seventeen: 17, eighteen: 18, nineteen: 19 };
const TENS = { twenty: 20, thirty: 30, forty: 40, fourty: 40, fifty: 50, sixty: 60, seventy: 70, eighty: 80, ninety: 90 };
const CONNECTORS = new Set(["and", "also", "plus", "then", "the", "some", "with", "um", "uh", "er", "ok", "okay", "next", "please", "thanks"]);
const PRICE_WORDS = new Set(["at", "for", "@", "$", "price", "priced", "cost", "costs"]);
/** Words that only ever describe a price ("per unit", "each") — never part of a product name. */
const PER_WORDS = new Set(["per", "each", "apiece", "unit", "units", "item", "items"]);
const STREET_WORDS = new Set(["street", "st", "road", "rd", "avenue", "ave", "lane", "ln", "drive", "dr", "way", "close", "crescent",
  "boulevard", "blvd", "terrace", "place", "square", "highway", "hwy", "circle", "court", "path", "district", "plaza"]);
const BUSINESS_WORDS = new Set(["supermarket", "supermarkets", "store", "stores", "shop", "shops", "mart", "minimart", "market", "markets",
  "grocery", "groceries", "wholesale", "wholesales", "pharmacy", "bakery", "restaurant", "limited", "ltd", "enterprise", "enterprises",
  "bar", "cafe", "deli", "supplies", "foods", "variety", "plaza", "kitchen", "farm", "farms", "company", "co"]);
const SMALL_WORDS = new Set(["and", "of", "the", "at", "in", "on", "by", "for", "de"]);
/** Words that carry no product ("please", "that's all", "thank you"): a phrase made only of these is left out. */
const FILLER = new Set([...CONNECTORS, "please", "thanks", "thank", "you", "thats", "that", "is", "its", "it", "all", "everything",
  "done", "finished", "alright", "right", "so", "yes", "yeah", "no", "oh", "well", "now", "just", "like", "good", "great",
  "perfect", "cool", "cheers", "bye", "goodbye", "sir", "maam", "boss", "invoice", "delivery", "order", "total", "a", "an", "of", "to", "be", "will",
  "very", "much", "lot", "lots", "have", "nice", "day", "appreciate", "appreciated", "welcome", "again", "see", "later", "soon", "take", "care",
  "god", "bless", "hello", "hi", "morning", "afternoon", "evening", "night", "here", "there", "we", "go", "this", "one", "for"]);

const isDigits = (w) => /^\d+(\.\d+)?$/.test(w);
const wordNumber = (w) => (isDigits(w) ? Number(w) : w in ONES ? ONES[w] : w in TENS ? TENS[w] : null);

/** Words with their original spelling, lower-case form and whether a comma/full stop followed them. */
function tokenize(text) {
  const src = String(text || "")
    .replace(/[‘’ʼ]/g, "'")
    .replace(/&/g, " and ")
    .replace(/(\d),(?=\d{3}\b)/g, "$1")                 // 1,250 → 1250
    .replace(/(\d)\s*(lbs?|pounds?|doz(?:en)?s?|bags?)\b/gi, "$1 $2") // 50lb → 50 lb
    .replace(/[-–—/]/g, " ");
  const tokens = [];
  for (const m of src.matchAll(/\$|\d+(?:\.\d+)?|[A-Za-z][A-Za-z']*|[,;:.!?]/g)) {
    const raw = m[0];
    if (/^[,;:.!?]$/.test(raw)) { if (tokens.length) tokens[tokens.length - 1].pause = true; continue; }
    const w = raw.toLowerCase().replace(/'s$/, "s").replace(/'/g, "");
    if (!w) continue;
    tokens.push({ raw, w, pause: false });
  }
  return tokens;
}

// ── Numbers ──────────────────────────────────────────────────────────────

/**
 * Reads "fifty", "two hundred and fifty", "12", "one and a half", "2.5" at t[i]. → { value, end } | null
 * opts.lineStartsAt(k): true when a new product line starts at t[k] — then "and" there isn't part of this number
 * ("at four hundred and two bags of limes" is 400, then 2 bags of limes).
 */
function readNumber(t, i, opts = {}) {
  let j = i;
  if (t[j] && isDigits(t[j].w)) {
    let value = Number(t[j].w);
    j++;
    if (t[j]?.w === "and" && t[j + 1]?.w === "a" && t[j + 2]?.w === "half") { value += 0.5; j += 3; }
    return { value, end: j };
  }
  let total = 0, cur = 0, used = false, last = null;
  while (j < t.length) {
    const w = t[j].w;
    if (w in ONES || w in TENS) {
      const v = ONES[w] ?? TENS[w];
      if (used && !(last === "tens" && v < 10) && last !== "hundred" && last !== "thousand" && last !== "and") break; // a new number starts
      cur += v;
      last = w in TENS ? "tens" : "ones";
    } else if (w === "hundred" && used) {
      cur = (cur || 1) * 100; last = "hundred";
    } else if (w === "thousand" && used) {
      total += (cur || 1) * 1000; cur = 0; last = "thousand";
    } else if (w === "and" && used && (last === "hundred" || last === "thousand") && t[j + 1] && (t[j + 1].w in ONES || t[j + 1].w in TENS)
      && !opts.lineStartsAt?.(j + 1)) {
      last = "and";
    } else if (w === "a" && !used && (t[j + 1]?.w === "hundred" || t[j + 1]?.w === "thousand")) {
      cur = 1; last = "ones";
    } else break;
    used = true;
    j++;
  }
  if (!used) return null;
  let value = total + cur;
  if (t[j]?.w === "and" && t[j + 1]?.w === "a" && t[j + 2]?.w === "half") { value += 0.5; j += 3; }
  else if (t[j]?.w === "point" && t[j + 1] && wordNumber(t[j + 1].w) !== null && wordNumber(t[j + 1].w) < 10) {
    let digits = "";
    j++;
    while (t[j] && wordNumber(t[j].w) !== null && wordNumber(t[j].w) < 10) { digits += String(wordNumber(t[j].w)); j++; }
    value = Number(`${value}.${digits}`);
  }
  return { value, end: j };
}

/**
 * Reads a price at t[i]: "two fifty" → 250, "three seventy five" → 375, "twelve fifty" → 1250, "250", "$2.50",
 * "three hundred", "two dollars fifty cents" → 2.5. → { value, end } | null
 */
function readPrice(t, i, opts = {}) {
  let j = i;
  if (t[j]?.w === "$") j++;
  // Spoken shorthand: [1–19] then [10–99] (or "oh" + digit): "two fifty", "twelve fifty", "two oh five".
  const a = t[j] && ONES[t[j].w];
  if (a >= 1 && t[j + 1] && t[j + 1].w !== "hundred" && t[j + 1].w !== "thousand") {
    let k = j + 1, b = null;
    if (t[k].w in TENS) { b = TENS[t[k].w]; k++; if (t[k] && ONES[t[k].w] >= 1 && ONES[t[k].w] <= 9) { b += ONES[t[k].w]; k++; } }
    else if (ONES[t[k].w] >= 10) { b = ONES[t[k].w]; k++; }
    else if (t[k].w === "oh" && t[k + 1] && ONES[t[k + 1].w] >= 1 && ONES[t[k + 1].w] <= 9) { b = ONES[t[k + 1].w]; k += 2; }
    if (b !== null && !(t[k] && /^(dollars?|cents?|hundred|thousand)$/.test(t[k].w))) return { value: a * 100 + b, end: k };
  }
  const n = readNumber(t, j, opts);
  if (!n) return null;
  let value = n.value, end = n.end;
  if (t[end] && /^dollars?$/.test(t[end].w)) {
    end++;
    if (t[end]?.w === "and") end++;
    const c = readNumber(t, end);
    if (c && c.value < 100) { value += c.value / 100; end = c.end; if (t[end] && /^cents?$/.test(t[end].w)) end++; }
  }
  return { value: Math.round(value * 100) / 100, end };
}

// ── Quantities and units ─────────────────────────────────────────────────

function unitAt(t, j) {
  const w = t[j]?.w;
  if (!w) return null;
  if (/^doz(en)?s?$/.test(w)) return { unit: "dozen", end: j + 1 };
  if (/^(bags?|sacks?)$/.test(w)) return { unit: "bag", end: j + 1 };
  if (/^(pounds?|lbs?|pds?)$/.test(w)) return { unit: "lb", end: j + 1 };
  if (/^(each|pieces?|bottles?|units?|pcs)$/.test(w)) return { unit: "each", end: j + 1 };
  return null;
}

/**
 * After a price: "per unit", "per item", "per dozen", "per pound", "per bag", "each", "apiece", "a dozen", "a pound".
 * → { unit: "dozen"|"bag"|"lb"|null (null = per item), end } | null
 */
function perMarkerAt(t, j) {
  const w = t[j]?.w;
  if (!w) return null;
  if (w === "each" || w === "apiece") return { unit: null, end: j + 1 };
  if (w !== "per" && w !== "a" && w !== "an") return null;
  const next = t[j + 1]?.w;
  const u = unitAt(t, j + 1);
  if (u) return { unit: u.unit === "each" ? null : u.unit, end: u.end };
  if (next && /^(unit|units|item|items|one|piece|pieces)$/.test(next)) return { unit: null, end: j + 2 };
  return w === "per" ? { unit: null, end: j + 1 } : null;
}

/** "two dozen", "a dozen", "half a dozen", "fifty pounds of", "3 bags", "12". → { qty, unit|null, end } | null */
function readQuantity(t, i) {
  let j = i, qty = null;
  const w = t[j]?.w;
  if (w === "half") { qty = 0.5; j++; if (t[j]?.w === "a" || t[j]?.w === "an") j++; }
  else if ((w === "a" || w === "an") && unitAt(t, j + 1)) { qty = 1; j++; }
  else if ((w === "to" || w === "too") && unitAt(t, j + 1)) { qty = 2; j++; } // "to dozen" is how "two dozen" is often heard
  else if (w === "for" && unitAt(t, j + 1)) { qty = 4; j++; }
  else {
    const n = readNumber(t, j);
    if (!n) return null;
    qty = n.value;
    j = n.end;
  }
  let unit = null;
  const u = unitAt(t, j);
  if (u) { unit = u.unit; j = u.end; }
  else if (t[j] && /^(doesnt|doesn|dozn|dosen|dozan|dozed)$/.test(t[j].w)) { unit = "dozen"; j++; } // "two doesn't beetroot"
  if (t[j]?.w === "of") j++;
  return { qty, unit, end: j };
}

// ── Product matching ─────────────────────────────────────────────────────
// A product is matched loosely, by the words that make it different: case, plurals, extra words and the generic
// "juice"/"drink" don't matter, close sounds count ("bambi" ≈ "bammy", "kalaloo" ≈ "callaloo"), and split or joined
// words are the same ("beet root" = "beetroot"). The single best match is used — the review screen is where mistakes
// get fixed. Only when two products are equally close ("bammy": Mini or Large?) does it ask.

const BUILTIN_ALIASES = {
  "Beetroot Juice": ["beetroot", "beet root", "beet root juice", "beet juice", "beat root", "beat root juice", "beet route", "beetroot juices"],
  "Cucumber Juice": ["cucumber", "cucumber juices", "cue cumber"],
  "Pumpkin Punch": ["pumpkin", "punkin punch", "pumpkin punches"],
  "Green Juice": ["greens juice", "green juices"],
  "Mini Bammy": ["mini bammie", "mini bammies", "mini bami", "mini bambi", "small bammy", "small bammies"],
  "Large Bammy": ["large bammie", "large bammies", "large bami", "large bambi", "big bammy", "big bammies"],
  "Juicify Drink Grape": ["juicify grape", "grape juicify", "grape drink", "grape", "juicy fi grape"],
  "Juicify Drink Fruit Punch": ["juicify fruit punch", "fruit punch juicify", "fruit punch", "juicy fi fruit punch"],
  "Hot Pepper": ["hot peppers", "pepper", "peppers", "scotch bonnet", "scotch bonnets", "scotch bonnet pepper"],
  "Shredded Callaloo": ["callaloo", "calaloo", "kalaloo", "calalu", "kallaloo", "shredded calaloo"],
  "Lemons": ["lemon"],
  "Limes": ["lime"],
  "Grapefruit": ["grape fruit", "grapefruits"],
  "Okra": ["okras", "ochro", "ochra", "okro", "ocra", "oprah"],
};
const GENERIC = new Set(["juice", "juices", "drink", "drinks"]);
const TIE = 0.02;       // scores this close count as "equally close"
const MIN_MATCH = 0.5;  // below this, nothing was clearly said

const compact = (s) => s.toLowerCase().replace(/[^a-z0-9]/g, "");
/** A rough sound-alike key: "bammie" ≈ "bammy", "kalaloo" ≈ "callaloo", "ochra" ≈ "okra". */
const soundKey = (s) => compact(s)
  .replace(/ph/g, "f").replace(/ck/g, "k").replace(/q/g, "k").replace(/c(?=[eiy])/g, "s").replace(/c/g, "k").replace(/ch/g, "k")
  .replace(/z/g, "s").replace(/ie\b|y\b/g, "i").replace(/ies$/, "is").replace(/(.)\1+/g, "$1");

function similarity(a, b) {
  if (a === b) return 1;
  const m = a.length, n = b.length;
  if (!m || !n) return 0;
  let prev = Array.from({ length: n + 1 }, (_, k) => k);
  for (let x = 1; x <= m; x++) {
    const row = [x];
    for (let y = 1; y <= n; y++) row[y] = Math.min(prev[y] + 1, row[y - 1] + 1, prev[y - 1] + (a[x - 1] === b[y - 1] ? 0 : 1));
    prev = row;
  }
  return 1 - prev[n] / Math.max(m, n);
}

/** Singular, plain form: "bammies" → "bammy", "lemons" → "lemon", "peppers" → "pepper". */
function stem(w) {
  if (w.length > 4 && w.endsWith("ies")) return `${w.slice(0, -3)}y`;
  if (w.length > 4 && /(?:ch|sh|x|z|ss)es$/.test(w)) return w.slice(0, -2);
  if (w.length > 3 && w.endsWith("s") && !w.endsWith("ss")) return w.slice(0, -1);
  return w;
}

/** How alike two spoken words are (1 = same), ignoring plurals and allowing close sounds. */
function wordSim(a, b) {
  const x = stem(a), y = stem(b);
  if (x === y) return 1;
  return Math.max(similarity(x, y), similarity(soundKey(x), soundKey(y)) - 0.02);
}

/** Each product's names (its own and the usual ways it's said), as the words that tell it apart. */
function buildMatcher(products) {
  const forms = [];
  for (const p of products) {
    for (const name of new Set([p.name.toLowerCase(), ...(BUILTIN_ALIASES[p.name] || [])])) {
      const words = name.split(/\s+/).filter(Boolean);
      const key = words.filter((w) => !GENERIC.has(w));
      forms.push({ product: p, key: key.length ? key : words });
    }
  }
  return forms;
}

/**
 * Share of a product's telling words that were heard (closely), less a little for each extra word heard.
 * strict: the first word heard must be part of the name (so "Rose Hall Grocery okra" isn't read as one product).
 */
function formScore(W, form, strict = false) {
  const used = new Set();
  let sum = 0;
  for (const k of form.key) {
    let best = 0, at = [];
    W.forEach((w, j) => { const s = wordSim(w, k); if (s > best) { best = s; at = [j]; } });
    for (let j = 0; j + 1 < W.length; j++) { const s = wordSim(W[j] + W[j + 1], k); if (s > best) { best = s; at = [j, j + 1]; } }
    if (best >= 0.75) { sum += best; for (const j of at) used.add(j); }
  }
  let score = sum / form.key.length;
  const joined = similarity(compact(W.join("")), compact(form.key.join(""))); // "beetroot" heard for "beet root"
  if (joined >= 0.85 && joined > score) { score = joined; W.forEach((_, j) => used.add(j)); }
  if (strict && !used.has(0)) return -Infinity;
  const extra = W.filter((w, j) => !used.has(j) && !GENERIC.has(w)).length;
  return score - 0.12 * extra;
}

/**
 * The product said at t[i] (1–5 words). → { product, score, end, ties: [other products just as close] } | null
 * Numbers, units and price words never start or join a product name. Extra words around the name are allowed
 * ("fresh beetroot juice"), unless `strict` (used while the store and address may still be being said).
 */
function matchAt(t, i, matcher, { strict = false } = {}) {
  const stop = (tok) => !tok || wordNumber(tok.w) !== null || unitAt([tok], 0) || PRICE_WORDS.has(tok.w) || PER_WORDS.has(tok.w) || CONNECTORS.has(tok.w) || tok.w === "of";
  if (stop(t[i])) return null;
  const best = new Map(); // product id → { product, score, end }: its best reading of the words here
  const atEnd = new Map(); // end → Map(product id → score): every product's score for the same words
  for (let len = 1; len <= 5 && i + len <= t.length; len++) {
    if (stop(t[i + len - 1])) break;
    const W = t.slice(i, i + len).map((x) => x.w);
    const scores = new Map();
    for (const form of matcher) {
      const s = formScore(W, form, strict);
      if (s > (scores.get(form.product.id) ?? -Infinity)) scores.set(form.product.id, s);
      const cur = best.get(form.product.id);
      if (!cur || s > cur.score + 1e-9 || (Math.abs(s - cur.score) <= 1e-9 && i + len > cur.end)) best.set(form.product.id, { product: form.product, score: s, end: i + len });
    }
    atEnd.set(i + len, scores);
    if (t[i + len - 1].pause) break; // names don't run across a comma
  }
  // Best first; on equal scores the reading that explains more of what was said ("grape fruit" over "grape").
  const ranked = [...best.values()].sort((a, b) => b.score - a.score || b.end - a.end);
  if (!ranked.length || ranked[0].score < MIN_MATCH) return null;
  const top = ranked[0];
  const same = atEnd.get(top.end);
  const ties = ranked.slice(1).filter((r) => (same.get(r.product.id) ?? -Infinity) >= top.score - TIE).map((r) => r.product);
  return { ...top, ties };
}

/** One best match (nothing else equally close). */
const isConfident = (m) => Boolean(m) && m.ties.length === 0;

/** Products with a word that sounds like the heard words (suggestions when nothing matched). */
function suggest(heardWords, products) {
  const scored = new Map();
  for (const form of buildMatcher(products)) {
    for (const hw of heardWords) for (const k of [...form.key, ...form.product.name.toLowerCase().split(/\s+/)]) {
      const s = wordSim(hw, k);
      if (s >= 0.6 && s > (scored.get(form.product.id) || 0)) scored.set(form.product.id, s);
    }
  }
  return [...scored.entries()].sort((a, b) => b[1] - a[1]).slice(0, 3).map(([id]) => id);
}

// ── Store and address ────────────────────────────────────────────────────

function titleCase(tokens) {
  return tokens.map((tok, i) => {
    if (/^\d/.test(tok.raw)) return tok.raw;
    if (/[A-Z]/.test(tok.raw.slice(1))) return tok.raw; // keep "McDonald", "KFC"
    const lower = tok.raw.toLowerCase();
    if (i > 0 && SMALL_WORDS.has(lower)) return lower;
    return lower.charAt(0).toUpperCase() + lower.slice(1);
  }).join(" ").replace(/\s+'s\b/g, "'s");
}

/** "fourteen wellington street brownstone" → "14 Wellington Street, Brownstone" */
function formatAddress(tokens) {
  const out = [];
  for (let i = 0; i < tokens.length;) {
    const n = readNumber(tokens, i);
    if (n && n.end > i && !isDigits(tokens[i].w) && tokens[i].w !== "a") {
      out.push({ raw: String(n.value), w: String(n.value), pause: tokens[n.end - 1].pause });
      i = n.end;
      continue;
    }
    out.push(tokens[i]);
    i++;
  }
  const parts = [];
  let cur = [];
  out.forEach((tok, i) => {
    cur.push(tok);
    const breakHere = tok.pause || (STREET_WORDS.has(tok.w) && i < out.length - 1 && !STREET_WORDS.has(out[i + 1].w));
    if (breakHere) { parts.push(cur); cur = []; }
  });
  if (cur.length) parts.push(cur);
  return parts.map(titleCase).filter(Boolean).join(", ");
}

/** Street words that make a phrase an address even without a house number ("Wellington Street", "Hope Road"). */
const STRONG_STREET = new Set(["street", "st", "road", "rd", "avenue", "ave", "lane", "ln", "drive", "dr", "boulevard", "blvd",
  "crescent", "highway", "hwy", "terrace"]);

/** Known places (Jamaica: parishes, towns, areas), so "Sarah Supermarket, Montego Bay" fills the address. */
const PLACES = [
  "kingston", "new kingston", "half way tree", "halfway tree", "constant spring", "liguanea", "papine", "stony hill", "cross roads",
  "spanish town", "portmore", "old harbour", "linstead", "bog walk", "ewarton", "may pen", "hayes", "chapelton", "frankfield",
  "mandeville", "christiana", "spaldings", "santa cruz", "black river", "junction", "montego bay", "mobay", "falmouth", "lucea",
  "savanna la mar", "sav la mar", "negril", "whitehouse", "ocho rios", "st anns bay", "saint anns bay", "browns town", "runaway bay",
  "discovery bay", "claremont", "port maria", "annotto bay", "highgate", "oracabessa", "port antonio", "buff bay", "morant bay",
  "yallahs", "seaforth", "st andrew", "saint andrew", "st catherine", "saint catherine", "clarendon", "manchester", "st elizabeth",
  "saint elizabeth", "westmoreland", "hanover", "st james", "saint james", "trelawny", "st ann", "saint ann", "st mary",
  "saint mary", "portland", "st thomas", "saint thomas",
].map((p) => p.split(" ")).sort((a, b) => b.length - a.length);

/** A known place at t[i] ("Montego Bay", "Kingston 10") → end index | null. */
function placeAt(t, i) {
  for (const words of PLACES) {
    if (words.every((w, k) => t[i + k]?.w === w)) {
      let end = i + words.length;
      // Kingston's postal districts: "Kingston 10," (the number then a pause, or nothing after it).
      if (words[0] === "kingston" && t[end] && isDigits(t[end].w) && Number(t[end].w) <= 20 && (t[end].pause || end + 1 >= t.length)) end++;
      return end;
    }
  }
  return null;
}

/** Words that can't be part of a street or town: amounts, prices, units, filler. */
const notPlaceWord = (t, k) => {
  const w = t[k].w;
  return wordNumber(w) !== null || Boolean(unitAt(t, k)) || PRICE_WORDS.has(w) || PER_WORDS.has(w) || CONNECTORS.has(w)
    || ["a", "an", "half", "to", "too", "of", "dozen"].includes(w);
};

/**
 * The town said right after a street ("…, Brownstone"): a known place, or 1–3 other words that are not an amount,
 * price, unit, product or store name, ending at a comma or before the next amount. → end index | null
 */
function townAt(t, k, matcher) {
  if (k >= t.length) return null;
  const place = placeAt(t, k);
  if (place) return place;
  let m = k;
  while (m < t.length && m - k < 4) {
    if (notPlaceWord(t, m) || BUSINESS_WORDS.has(t[m].w) || STREET_WORDS.has(t[m].w)) break;
    if (matchAt(t, m, matcher, { strict: true })) return m > k ? m : null; // a product name is never part of the address
    m++;
    if (t[m - 1].pause) break;
  }
  if (m === k || m - k > 3) return null;
  // More plain words before a comma (or a store name) means this isn't a town.
  if (!t[m - 1].pause && m < t.length && !notPlaceWord(t, m) && !matchAt(t, m, matcher, { strict: true })) return null;
  return m;
}

/**
 * A phrase that clearly is an address, at t[i] → { start, end } | null:
 *   "14 Wellington Street", "fourteen Red Hills Road", "at 6 Hope Road" — a house number and a street
 *   "Wellington Street", "Red Hills Road" — a street (street, road, avenue, lane, drive…) without a number
 *   "Montego Bay", "Kingston 10" — a known place
 * A street can be followed by its town ("14 Wellington Street, Brownstone").
 */
function addressAt(t, i, matcher) {
  let j = i;
  if (t[j] && /^(at|on|in|address|located)$/.test(t[j].w) && t[j + 1]) j++;
  const n = readNumber(t, j);
  const house = Boolean(n && !unitAt(t, n.end) && !/^(doesnt|doesn|dozn)$/.test(t[n.end]?.w || ""));
  const k = house ? n.end : j;
  for (let m = k; m < Math.min(t.length, k + 5); m++) {
    if (notPlaceWord(t, m)) break;
    if (m > k && (house ? STREET_WORDS : STRONG_STREET).has(t[m].w)) {
      let end = m + 1;
      while (t[end] && STREET_WORDS.has(t[end].w) && !t[end - 1].pause) end++;   // "… Road East"
      const town = townAt(t, end, matcher);
      return { start: j, end: town || end };
    }
    if (t[m].pause) break;
  }
  if (house) return null;
  const place = placeAt(t, j);
  return place ? { start: j, end: place } : null;
}

/**
 * The store's name at t[i] → { start, end } | null. It runs to its business word ("…Supermarket", "…Wholesale"),
 * a comma, or the first amount. Without a business word only the first thing said can be the store, and never when
 * it is a product line (an amount, a price, or nothing but a product's name) or an address.
 */
function storeAt(t, i, matcher, { first }) {
  const run = [];
  for (let k = i; k < t.length && run.length < 7; k++) {
    const w = t[k].w;
    if (wordNumber(w) !== null || PRICE_WORDS.has(w) || PER_WORDS.has(w)) break;
    if (["a", "an", "half", "to", "too", "for"].includes(w) && unitAt(t, k + 1)) break;   // "a dozen …"
    if (k > i && unitAt(t, k)) break;
    run.push(k);
    if (t[k].pause) break;
  }
  if (!run.length) return null;
  let biz = -1;
  for (const k of run) if (BUSINESS_WORDS.has(t[k].w) && !(t[k + 1] && STREET_WORDS.has(t[k + 1].w) && !t[k].pause)) biz = k;
  if (biz >= 0) {
    // "Shop X," / "Sarah Supermarket Brownstone,": a short name after the business word, up to a comma, is part of it.
    const last = run.at(-1);
    const tail = last - biz;
    if (t[last].pause && tail >= 1 && tail <= 2 && !matchAt(t, biz + 1, matcher, { strict: true }) && !addressAt(t, biz + 1, matcher)) return { start: i, end: last + 1 };
    return { start: i, end: biz + 1 };
  }
  if (!first || addressAt(t, i, matcher)) return null;
  const m = matchAt(t, i, matcher, { strict: true });
  if (m && m.score >= 0.9 && m.end > run.at(-1)) return null; // nothing but a product's name: a product line
  let end = run.at(-1) + 1;
  // "Sarah, Supermarket," — a business word said after a pause still belongs to the name.
  if (t[end - 1].pause && t[end] && BUSINESS_WORDS.has(t[end].w)) end++;
  else if (t[end - 1].pause && t[end + 1] && BUSINESS_WORDS.has(t[end + 1].w) && !t[end].pause && !notPlaceWord(t, end)) end += 2;
  return { start: i, end };
}

// ── Dates ────────────────────────────────────────────────────────────────

const ORDINALS = { first: 1, second: 2, third: 3, fourth: 4, fifth: 5, sixth: 6, seventh: 7, eighth: 8, ninth: 9, tenth: 10,
  eleventh: 11, twelfth: 12, thirteenth: 13, fourteenth: 14, fifteenth: 15, sixteenth: 16, seventeenth: 17, eighteenth: 18,
  nineteenth: 19, twentieth: 20, thirtieth: 30 };
const MONTHS = ["january", "february", "march", "april", "may", "june", "july", "august", "september", "october", "november", "december"];
const MONTH_RE = "january|february|march|april|may|june|july|august|september|october|november|december|jan|feb|mar|apr|jun|jul|aug|sept|sep|oct|nov|dec";
const ORD_RE = "(?:\\d{1,2}(?:st|nd|rd|th)?|(?:twenty|thirty)[\\s-]+(?:first|second|third|fourth|fifth|sixth|seventh|eighth|ninth)|first|second|third|fourth|fifth|sixth|seventh|eighth|ninth|tenth|eleventh|twelfth|thirteenth|fourteenth|fifteenth|sixteenth|seventeenth|eighteenth|nineteenth|twentieth|thirtieth)";
const YEAR_RE = "(?:\\d{4}|twenty[\\s-]+twenty(?:[\\s-]+(?:one|two|three|four|five|six|seven|eight|nine))?|two[\\s-]+thousand(?:[\\s-]+and)?[\\s-]+twenty(?:[\\s-]+(?:one|two|three|four|five|six|seven|eight|nine))?)";
const LEAD_RE = "(?:\\b(?:dated|date|on)\\s+)?(?:the\\s+)?";

function ordinalValue(s) {
  const w = s.toLowerCase().replace(/[\s-]+/g, " ").trim();
  const d = /^(\d{1,2})(?:st|nd|rd|th)?$/.exec(w);
  if (d) return Number(d[1]);
  const two = /^(twenty|thirty) (\w+)$/.exec(w);
  if (two) return (two[1] === "twenty" ? 20 : 30) + (ORDINALS[two[2]] || 0);
  return ORDINALS[w] ?? null;
}
function yearValue(s, fallback) {
  if (!s) return fallback;
  const w = s.toLowerCase().replace(/[\s-]+/g, " ").trim();
  if (/^\d{4}$/.test(w)) return Number(w);
  const tail = /twenty(?: (\w+))?$/.exec(w);
  return tail ? 2020 + (ONES[tail[1]] || 0) : fallback;
}
const monthValue = (s) => {
  const w = s.toLowerCase();
  const i = MONTHS.findIndex((m) => m === w || m.slice(0, 3) === w.slice(0, 3));
  return i >= 0 ? i + 1 : null;
};

/**
 * Finds a spoken date — "12th of the 11th 2026", "the twelfth of November", "November 12th, 2026", "12/11/2026"
 * (day first) — and removes it from the text so it never ends up in the store or address.
 * → { date: "YYYY-MM-DD" | null, heard, rest }
 */
export function extractDate(text, today = todayISO()) {
  const thisYear = Number(String(today).slice(0, 4)) || new Date().getFullYear();
  const patterns = [
    [new RegExp(`${LEAD_RE}(${ORD_RE})\\s+of\\s+(?:the\\s+)?(${ORD_RE})(?:\\s*,?\\s*(${YEAR_RE}))?`, "i"), (m) => [ordinalValue(m[1]), ordinalValue(m[2]), m[3]]],
    [new RegExp(`${LEAD_RE}(${ORD_RE})\\s+(?:of\\s+)?(${MONTH_RE})\\b(?:\\s*,?\\s*(${YEAR_RE}))?`, "i"), (m) => [ordinalValue(m[1]), monthValue(m[2]), m[3]]],
    [new RegExp(`(?:\\b(?:dated|date|on)\\s+)?\\b(${MONTH_RE})\\s+(?:the\\s+)?(${ORD_RE})\\b(?:\\s*,?\\s*(${YEAR_RE}))?`, "i"), (m) => [ordinalValue(m[2]), monthValue(m[1]), m[3]]],
    [/(?:\b(?:dated|date|on)\s+)?\b(\d{1,2})[/.-](\d{1,2})[/.-](\d{2}|\d{4})\b/i, (m) => [Number(m[1]), Number(m[2]), m[3].length === 2 ? String(2000 + Number(m[3])) : m[3]]],
  ];
  for (const [re, read] of patterns) {
    const m = re.exec(text);
    if (!m) continue;
    const [day, month, yearText] = read(m);
    const year = yearValue(yearText, thisYear);
    if (!day || !month || month > 12) continue;
    const dim = new Date(Date.UTC(year, month, 0)).getUTCDate();
    if (day < 1 || day > dim) continue;
    const date = `${year}-${String(month).padStart(2, "0")}-${String(day).padStart(2, "0")}`;
    const rest = (text.slice(0, m.index) + ", " + text.slice(m.index + m[0].length)).replace(/\s*,\s*(,\s*)+/g, ", ");
    return { date, heard: m[0].trim(), rest };
  }
  // "today", "yesterday", "tomorrow" (never the address)
  const rel = /\b(?:(?:dated|date|for|on)\s+)?(today|tonight|this morning|this afternoon|yesterday|tomorrow)(?:'?s\s+date)?\b/i.exec(text);
  if (rel) {
    const shift = { yesterday: -1, tomorrow: 1 }[rel[1].toLowerCase()] || 0;
    const base = new Date(`${today}T12:00:00Z`);
    base.setUTCDate(base.getUTCDate() + shift);
    const rest = (text.slice(0, rel.index) + ", " + text.slice(rel.index + rel[0].length)).replace(/\s*,\s*(,\s*)+/g, ", ");
    return { date: base.toISOString().slice(0, 10), heard: rel[0].trim(), rest };
  }
  return { date: null, heard: "", rest: text };
}

// ── The whole invoice ────────────────────────────────────────────────────

let keySeq = 0;
const nextKey = () => `v${++keySeq}`;

export function parseSpokenInvoice(text, { products = [], stores = [], today = todayISO() } = {}) {
  const spokenDate = extractDate(String(text || ""), today);
  const t = tokenize(spokenDate.rest);
  const matcher = buildMatcher(products);
  const byId = new Map(products.map((p) => [p.id, p]));
  const lines = [];
  let storeToks = null;
  const addressParts = [];
  let i = 0;
  const skip = () => { while (t[i] && (CONNECTORS.has(t[i].w) || t[i].w === "of")) i++; };
  const lineStartsAt = (k) => { const q = readQuantity(t, k); return Boolean(q && (q.unit || matchAt(t, q.end, matcher))); };
  // A number followed by a word is the next line's amount ("… a dozen lemons, 4 juice"), not this line's price.
  const amountStartsAt = (k) => {
    if (lineStartsAt(k)) return true;
    const q = readQuantity(t, k), nx = q && t[q.end];
    return Boolean(nx && !t[q.end - 1].pause && wordNumber(nx.w) === null && !PRICE_WORDS.has(nx.w) && !PER_WORDS.has(nx.w)
      && !CONNECTORS.has(nx.w) && nx.w !== "a" && nx.w !== "an" && !/^(dollars?|cents?)$/.test(nx.w));
  };

  while (i < t.length) {
    skip();
    if (i >= t.length) break;
    const from = i;
    // The store: the name said before the products.
    if (!storeToks) {
      const st = storeAt(t, i, matcher, { first: lines.length === 0 });
      if (st) { storeToks = t.slice(st.start, st.end); i = st.end; continue; }
    }
    // An address, only from a phrase that clearly is one.
    const addr = addressAt(t, i, matcher);
    if (addr) { addressParts.push(t.slice(addr.start, addr.end)); i = addr.end; continue; }
    // Otherwise: a product line (an amount, a product's name, a price) — or extra words, left out.
    let q = readQuantity(t, i);
    if (q) { i = q.end; skip(); }
    let m = matchAt(t, i, matcher);
    const line = { key: nextKey(), productId: null, name: "", qty: q ? q.qty : null, unit: q ? q.unit : null, price: null, priceFrom: null, pricePer: null, saidAs: "", heard: "", issue: null };
    if (m && isConfident(m)) {
      i = m.end;
      line.productId = m.product.id;
      line.name = m.product.name;
    } else if (m) {
      // Two products equally close to what was said: the only time it asks.
      line.heard = t.slice(i, m.end).map((x) => x.raw).join(" ");
      i = m.end;
      line.issue = { kind: "which", message: `Which product is “${line.heard}”?`, choices: [m.product.id, ...m.ties.map((p) => p.id)].slice(0, 4) };
    } else {
      // Words that aren't a product we know. Never dropped: they become a line to fix on the review screen.
      // Only filler on its own ("please", "okay", "that's all") is left out.
      const words = [];
      while (t[i] && !PRICE_WORDS.has(t[i].w) && !PER_WORDS.has(t[i].w) && !readQuantity(t, i) && !CONNECTORS.has(t[i].w) && !addressAt(t, i, matcher)) { words.push(t[i]); i++; if (t[i - 1].pause) break; }
      const meaningful = words.filter((x) => !FILLER.has(x.w));
      const strayPrice = !words.length && t[i] && PRICE_WORDS.has(t[i].w) && readPrice(t, t[i].w === "$" ? i : i + 1);
      if (!q && !meaningful.length && !strayPrice) { i = Math.max(i, from + 1); continue; }
      line.heard = words.map((x) => x.raw).join(" ");
      line.issue = { kind: "product", message: words.length ? `Didn't catch the product (heard “${line.heard}”).` : "Didn't catch the product.", choices: suggest(words.map((x) => x.w), products) };
      // Said before any product, with no amount: it may have been part of the address — offer that as one tap.
      if (!q && !lines.length && meaningful.length && !meaningful.some((x) => GENERIC.has(x.w))) line.issue.address = titleCase(words);
    }
    // Amount said after the product ("okra fifty pounds", "fruit punch 24 at 375") — unless that number is clearly the
    // amount of the next product ("… 2 dozen cucumber juice").
    // An amount followed by a product belongs to that product (amounts are usually said first: "one dozen cucumber"),
    // unless that product has its own amount after it ("okra fifty pounds hot pepper four pounds").
    if (line.qty === null && !addressAt(t, i, matcher)) {
      const after = readQuantity(t, i);
      const next = after && matchAt(t, after.end, matcher);
      const amountAfter = (k) => { const a = readQuantity(t, k); return Boolean(a && !matchAt(t, a.end, matcher)); };
      const forNext = next && (!line.productId || t[i - 1]?.pause || !amountAfter(next.end));
      if (after && !forNext && (after.unit || !isConfident(next))) { line.qty = after.qty; line.unit = after.unit; i = after.end; }
    }
    // Unit price for this line: "at 230", "for 300", "$250", "315 per unit", "250 each", "4200 per dozen",
    // "300 a pound" — or a number right after the product that isn't the next product's amount ("… 315, 16 green juice").
    let price = null;
    if (t[i] && PRICE_WORDS.has(t[i].w)) {
      price = readPrice(t, t[i].w === "$" ? i : i + 1, { lineStartsAt });
      if (!price && !line.issue) { line.issue = { kind: "price", message: "Didn't catch the price." }; i++; }
    } else if (t[i] && wordNumber(t[i].w) !== null && (line.productId || line.issue?.kind === "which")) {
      const cand = readPrice(t, i, { lineStartsAt });
      if (cand && (perMarkerAt(t, cand.end) || cand.end >= t.length || (line.qty !== null && !amountStartsAt(i)))) price = cand;
    }
    if (price) {
      line.price = price.value;
      line.priceFrom = "said";
      i = price.end;
      const per = perMarkerAt(t, i);
      if (per) {
        line.pricePer = per.unit || "each";
        const countable = (u) => !u || u === "each" || u === "dozen"; // dozens and single items convert (12 to a dozen)
        if (countable(per.unit) && countable(line.unit)) { /* settled below */ }
        else if (per.unit && !line.unit) line.unit = per.unit;
        else if (per.unit && line.unit && per.unit !== line.unit && !line.issue) {
          line.issue = { kind: "price", message: `The price was per ${per.unit === "lb" ? "pound" : per.unit}, but the amount was in ${line.unit === "lb" ? "pounds" : line.unit === "each" ? "items" : line.unit + "s"}.` };
        }
        i = per.end;
      }
    }
    // Any leftover price words ("per unit" said twice, "each") are part of this line, never a product of their own.
    while (t[i] && (PER_WORDS.has(t[i].w) || (t[i].w === "a" && t[i + 1] && PER_WORDS.has(t[i + 1].w)))) i++;
    lines.push(line);
    if (i === from) i++; // always move on
  }

  // Units, and what still needs a look. (Prices are only the ones said for this invoice.)
  for (const line of lines) {
    const p = line.productId ? byId.get(line.productId) : null;
    line.unitSaid = Boolean(line.unit);
    // "Dozen" means 12: "two dozen beetroot" is 24 beetroot. A price is per item unless "per dozen" was said;
    // a price per dozen becomes the price per item when it splits evenly to the cent (otherwise the line stays in dozens).
    const perDozen = line.pricePer === "dozen";
    if (line.qty !== null && (line.unit === "dozen" || (perDozen && (!line.unit || line.unit === "each")))) {
      const items = Math.round((line.unit === "dozen" ? line.qty * 12 : line.qty) * 1000) / 1000;
      const cents = line.price === null ? null : Math.round(line.price * 100);
      if (line.unit === "dozen") line.saidAs = `${Number(line.qty.toFixed(3))} dozen`;
      if (!perDozen || cents === null || cents % 12 === 0) {
        line.qty = items;
        line.unit = "each";
        if (perDozen && cents !== null) { line.price = cents / 12 / 100; line.saidPrice = `${cents / 100} a dozen`; }
      } else if (items % 12 === 0) {
        line.qty = items / 12;
        line.unit = "dozen";
        line.saidAs = "";
      } else {
        line.qty = items;
        line.unit = "each";
        line.price = Math.round(cents / 12) / 100;
        if (!line.issue) line.issue = { kind: "price", message: "The price was per dozen. Check the price per item." };
      }
      line.unitSaid = true;
    }
    line.unit = normalizeUnit(line.unit || (p ? defaultUnitFor(p) : "each"));
    if (!line.issue && line.qty === null) line.issue = { kind: "quantity", message: "How many? I didn't catch the amount." };
    if (!line.issue && line.productId && line.price === null) line.issue = { kind: "noPrice", message: `No price said${line.unit === "each" ? "" : ` per ${line.unit === "lb" ? "pound" : line.unit}`}. Tap to add it.` };
  }

  // The same product said twice in the same unit: one line.
  const merged = [];
  const mergeable = (l) => !l.issue || l.issue.kind === "noPrice";
  for (const line of lines) {
    const twin = line.productId && mergeable(line) && merged.find((x) => x.productId === line.productId && x.unit === line.unit && mergeable(x));
    if (twin) {
      twin.qty = (twin.qty || 0) + (line.qty || 0);
      twin.saidAs = "";
      if (line.priceFrom === "said") {
        if (twin.priceFrom === "said" && twin.price !== line.price) twin.issue = { kind: "price", message: "Two different prices were said." };
        twin.price = line.price; twin.priceFrom = "said";
      }
      if (twin.price !== null && twin.issue?.kind === "noPrice") twin.issue = null;
    } else merged.push(line);
  }

  // Store (a store used before keeps its spelling) and address (only what was clearly said as one).
  let store = storeToks ? titleCase(storeToks) : "";
  const address = addressParts.map(formatAddress).filter(Boolean).join(", ");
  let savedAddress = "";
  const key = compact(store);
  const known = key && (stores || []).map((s) => ({ s, sim: similarity(key, compact(s.name)) })).sort((a, b) => b.sim - a.sim)[0];
  if (known && known.sim >= 0.85) {
    store = known.s.name;
    if (!address && known.s.address) savedAddress = known.s.address; // offered on the review screen, never filled in by itself
  }

  return {
    store,
    address,
    addressFrom: address ? "said" : null,
    savedAddress,
    date: spokenDate.date,
    dateHeard: spokenDate.heard,
    storeIssue: store ? null : { kind: "store", message: "Didn't hear the store name." },
    lines: merged,
    transcript: String(text || "").trim(),
  };
}

/** How many lines need attention. */
export const issueCount = (parsed) => parsed.lines.filter((l) => l.issue && l.issue.kind !== "noPrice").length * 2
  + parsed.lines.filter((l) => l.issue?.kind === "noPrice").length + (parsed.storeIssue ? 1 : 0);

/**
 * How well one reading of what was said went, best first: the most product lines matched (a tie between two products
 * counts half), then the fewest lines left to fix, then a store heard. Fewer lines never wins by itself, so a reading
 * that lost a line can't be preferred.
 */
export function rank(parsed) {
  const matched = parsed.lines.filter((l) => l.productId).length + 0.5 * parsed.lines.filter((l) => l.issue?.kind === "which").length;
  const unclear = parsed.lines.filter((l) => l.issue && !["noPrice", "which"].includes(l.issue.kind)).length;
  return [matched, -unclear, parsed.store ? 1 : 0];
}
const better = (a, b) => { for (let k = 0; k < a.length; k++) if (a[k] !== b[k]) return a[k] > b[k]; return false; };

/** Parses each whole transcript the phone offered (its best guess first) and keeps the one that matches the most products. */
export function bestParse(candidates, ctx) {
  let best = null, bestRank = null;
  for (const text of candidates) {
    if (!String(text || "").trim()) continue;
    const parsed = parseSpokenInvoice(text, ctx), r = rank(parsed);
    if (!best || better(r, bestRank)) { best = parsed; bestRank = r; }
  }
  return best || parseSpokenInvoice("", ctx);
}

/**
 * The phone hears an invoice phrase by phrase, with up to three guesses for each phrase: segments = [[guess1, guess2…], …].
 * Starting from its best guesses, tries each other guess phrase by phrase and keeps any that makes the invoice match
 * more products (two passes, so several misheard phrases are all put right). Every phrase is always included.
 */
export function bestParseSegments(segments, ctx) {
  const segs = (segments || []).map((alts) => (alts || []).filter((a) => String(a || "").trim())).filter((alts) => alts.length);
  if (!segs.length) return parseSpokenInvoice("", ctx);
  const pick = segs.map(() => 0);
  const read = () => parseSpokenInvoice(segs.map((alts, k) => alts[pick[k]]).join(" "), ctx);
  let best = read(), bestRank = rank(best);
  for (let pass = 0; pass < 2; pass++) {
    let changed = false;
    segs.forEach((alts, k) => {
      for (let a = 0; a < alts.length; a++) {
        if (a === pick[k]) continue;
        const keep = pick[k];
        pick[k] = a;
        const parsed = read(), r = rank(parsed);
        if (better(r, bestRank)) { best = parsed; bestRank = r; changed = true; } else pick[k] = keep;
      }
    });
    if (!changed) break;
  }
  return best;
}

export const _test = { tokenize, readNumber, readPrice, readQuantity, similarity, soundKey };
