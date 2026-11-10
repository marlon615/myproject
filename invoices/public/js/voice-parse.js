/**
 * Understands a spoken invoice, e.g.
 *   "Sarah Supermarket, 14 Wellington Street, Brownstone, two dozen beetroot juice, one dozen cucumber juice,
 *    five dozen large bammy, fifty pounds okra at two fifty"
 *
 * parseSpokenInvoice(text, { products, stores, today }) →
 *   { store, address, addressFrom, date, dateHeard, lines, transcript }
 *   line: { key, productId, name, qty, unit, price, priceFrom ("said" | null), heard, issue }
 *
 * Prices are only ever the ones said for this invoice ("24 beetroot juice 315 per unit", "16 green juice at 230");
 * nothing is filled in from earlier invoices. A spoken date ("12th of the 11th 2026") sets the invoice date.
 *   issue: null | { kind, message, choices? }   kind: "product" | "which" | "quantity" | "price" | "noPrice" | "store"
 *
 * Nothing unclear is guessed: a word that doesn't clearly match a product, a missing amount, or a price that
 * can't be read comes back as a line with an `issue`, for the review screen to highlight.
 * Pure (no DOM), so it can be tested anywhere.
 */
import { defaultUnitFor, normalizeUnit, todayISO } from "./util.js";

// ── Words ────────────────────────────────────────────────────────────────

const ONES = { zero: 0, oh: 0, one: 1, two: 2, three: 3, four: 4, five: 5, six: 6, seven: 7, eight: 8, nine: 9, ten: 10,
  eleven: 11, twelve: 12, thirteen: 13, fourteen: 14, fifteen: 15, sixteen: 16, seventeen: 17, eighteen: 18, nineteen: 19 };
const TENS = { twenty: 20, thirty: 30, forty: 40, fourty: 40, fifty: 50, sixty: 60, seventy: 70, eighty: 80, ninety: 90 };
const CONNECTORS = new Set(["and", "also", "plus", "then", "the", "some", "with", "um", "uh", "er", "ok", "okay", "next"]);
const PRICE_WORDS = new Set(["at", "for", "@", "$", "price", "priced", "cost", "costs"]);
/** Words that only ever describe a price ("per unit", "each") — never part of a product name. */
const PER_WORDS = new Set(["per", "each", "apiece", "unit", "units", "item", "items"]);
const STREET_WORDS = new Set(["street", "st", "road", "rd", "avenue", "ave", "lane", "ln", "drive", "dr", "way", "close", "crescent",
  "boulevard", "blvd", "terrace", "place", "square", "highway", "hwy", "circle", "court", "path", "district", "plaza"]);
const BUSINESS_WORDS = new Set(["supermarket", "supermarkets", "store", "stores", "shop", "shops", "mart", "minimart", "market", "markets",
  "grocery", "groceries", "wholesale", "wholesales", "pharmacy", "bakery", "restaurant", "limited", "ltd", "enterprise", "enterprises",
  "bar", "cafe", "deli", "supplies", "foods", "variety", "plaza", "kitchen", "farm", "farms", "company", "co"]);
const SMALL_WORDS = new Set(["and", "of", "the", "at", "in", "on", "by", "for", "de"]);

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
  if (t[j]?.w === "of") j++;
  return { qty, unit, end: j };
}

// ── Product matching ─────────────────────────────────────────────────────

const BUILTIN_ALIASES = {
  "Beetroot Juice": ["beet root juice", "beet juice", "beetroot", "beet root", "beat root juice", "beetroots"],
  "Cucumber Juice": ["cucumber", "cucumbers"],
  "Pumpkin Punch": ["pumpkin", "pumpkin punches"],
  "Green Juice": ["greens juice", "green juices"],
  "Mini Bammy": ["mini bammies", "mini bammie", "small bammy", "small bammies", "mini bammys"],
  "Large Bammy": ["large bammies", "large bammie", "big bammy", "big bammies", "large bammys"],
  "Juicify Drink Grape": ["juicify grape", "grape juicify", "juicify grape drink", "grape drink", "grape"],
  "Juicify Drink Fruit Punch": ["juicify fruit punch", "fruit punch juicify", "fruit punch drink", "fruit punch"],
  "Hot Pepper": ["hot peppers", "scotch bonnet", "scotch bonnets", "scotch bonnet pepper", "scotch bonnet peppers", "pepper", "peppers"],
  "Shredded Callaloo": ["callaloo", "calaloo", "kalaloo", "calalu", "shredded calaloo", "shred callaloo"],
  "Lemons": ["lemon"],
  "Limes": ["lime"],
  "Grapefruit": ["grapefruits", "grape fruit", "grape fruits"],
  "Okra": ["okras", "ochro", "ochra", "okro"],
};
const GENERIC = new Set(["juice", "juices", "drink", "drinks"]);

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

/** All the ways each product may be said. */
function buildMatcher(products) {
  const entries = [];
  for (const p of products) {
    const name = p.name.toLowerCase();
    const forms = new Set([name, ...(BUILTIN_ALIASES[p.name] || [])]);
    const words = name.split(/\s+/);
    const core = words.filter((w) => !GENERIC.has(w));
    if (core.length && core.length < words.length && core.join("").length >= 4) forms.add(core.join(" "));
    for (const f of [...forms]) {
      if (f.endsWith("s") && f.length > 4) forms.add(f.slice(0, -1));
      else forms.add(`${f}s`);
    }
    for (const f of forms) entries.push({ product: p, words: f.split(/\s+/).length, c: compact(f), k: soundKey(f) });
  }
  return entries;
}

const scoreWindow = (text, e) => Math.max(similarity(compact(text), e.c), similarity(soundKey(text), e.k) - 0.03);

/**
 * Best product said at t[i] (1–5 words). → { product, score, end, runnerUp } | null
 * Words that are numbers, units or price words never start or join a product name.
 */
function matchAt(t, i, matcher) {
  const stop = (tok) => !tok || wordNumber(tok.w) !== null || unitAt([tok], 0) || PRICE_WORDS.has(tok.w) || PER_WORDS.has(tok.w) || CONNECTORS.has(tok.w) || tok.w === "of";
  if (stop(t[i])) return null;
  const best = new Map(); // product id → { score, end }
  for (let len = 1; len <= 5 && i + len <= t.length; len++) {
    if (stop(t[i + len - 1])) break;
    const text = t.slice(i, i + len).map((x) => x.w).join(" ");
    for (const e of matcher) {
      if (Math.abs(e.words - len) > 1) continue;
      const s = scoreWindow(text, e);
      const cur = best.get(e.product.id);
      if (!cur || s > cur.score || (s === cur.score && i + len > cur.end)) best.set(e.product.id, { product: e.product, score: s, end: i + len });
    }
    if (t[i + len - 1].pause) break; // names don't run across a comma
  }
  const ranked = [...best.values()].sort((a, b) => b.score - a.score || b.end - a.end);
  if (!ranked.length || ranked[0].score < 0.6) return null;
  return { ...ranked[0], runnerUp: ranked[1] || null };
}

const isConfident = (m) => m && (m.score >= 0.86 || (m.score >= 0.76 && (!m.runnerUp || m.score - m.runnerUp.score >= 0.1)));

/** Products whose words sound like the heard words (for "which product?" suggestions). */
function suggest(heardWords, products) {
  const scored = [];
  for (const p of products) {
    const forms = [p.name, ...(BUILTIN_ALIASES[p.name] || [])].flatMap((f) => f.toLowerCase().split(/\s+/)).filter((w) => !GENERIC.has(w) && w.length > 2);
    let s = 0;
    for (const hw of heardWords) for (const f of forms) s = Math.max(s, similarity(compact(hw), compact(f)), similarity(soundKey(hw), soundKey(f)) - 0.05);
    if (s >= 0.6) scored.push({ id: p.id, s });
  }
  return scored.sort((a, b) => b.s - a.s).slice(0, 3).map((x) => x.id);
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

function splitHeader(tokens, stores) {
  if (!tokens.length) return { store: "", address: "" };
  // 1) Said with pauses (commas): "Sarah Supermarket, 14 Wellington Street, Brownstone"
  const chunks = [];
  let cur = [];
  for (const tok of tokens) { cur.push(tok); if (tok.pause) { chunks.push(cur); cur = []; } }
  if (cur.length) chunks.push(cur);
  let storeToks, addrToks;
  if (chunks.length >= 2) {
    storeToks = chunks[0];
    addrToks = chunks.slice(1).flat();
  } else {
    // 2) The address starts at the house number…
    const num = tokens.findIndex((tok, i) => i > 0 && (isDigits(tok.w) || (tok.w in ONES || tok.w in TENS)));
    // 3) …or right after a business word (Supermarket, Store, Wholesale…)
    let biz = -1;
    tokens.forEach((tok, i) => { if (BUSINESS_WORDS.has(tok.w) && i < tokens.length - 1) biz = i; });
    const cut = num > 0 ? num : biz >= 0 ? biz + 1 : -1;
    storeToks = cut > 0 ? tokens.slice(0, cut) : tokens;
    addrToks = cut > 0 ? tokens.slice(cut) : [];
  }
  let store = titleCase(storeToks);
  let address = formatAddress(addrToks);
  let addressFrom = address ? "said" : null;
  // A store used before: keep its spelling, and its address if none was said.
  const key = compact(store);
  const known = key && (stores || []).map((s) => ({ s, sim: similarity(key, compact(s.name)) })).sort((a, b) => b.sim - a.sim)[0];
  if (known && known.sim >= 0.85) {
    store = known.s.name;
    if (!address && known.s.address) { address = known.s.address; addressFrom = "last time"; }
  }
  return { store, address, addressFrom };
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
  return { date: null, heard: "", rest: text };
}

// ── The whole invoice ────────────────────────────────────────────────────

/** Where the products start: the first amount followed by a product (or a unit), or a product followed by an amount. */
function findItemsStart(t, matcher) {
  for (let i = 0; i < t.length; i++) {
    const q = readQuantity(t, i);
    if (q) {
      const m = matchAt(t, q.end, matcher);
      if (q.unit || isConfident(m)) return i;
    }
    const m = matchAt(t, i, matcher);
    if (isConfident(m)) {
      const after = readQuantity(t, m.end);
      if (after?.unit) return i;                                   // "okra fifty pounds"
      if (t[m.end] && PRICE_WORDS.has(t[m.end].w)) return i;       // "beetroot juice at 350"
      if (after && t[after.end] && PRICE_WORDS.has(t[after.end].w)) return i; // "fruit punch 24 at 375"
    }
  }
  return t.length;
}

let keySeq = 0;
const nextKey = () => `v${++keySeq}`;

export function parseSpokenInvoice(text, { products = [], stores = [], today = todayISO() } = {}) {
  const spokenDate = extractDate(String(text || ""), today);
  const t = tokenize(spokenDate.rest);
  const matcher = buildMatcher(products);
  const byId = new Map(products.map((p) => [p.id, p]));
  const start = findItemsStart(t, matcher);
  const { store, address, addressFrom } = splitHeader(t.slice(0, start), stores);
  const lines = [];
  let i = start;
  const skip = () => { while (t[i] && (CONNECTORS.has(t[i].w) || t[i].w === "of")) i++; };
  const lineStartsAt = (k) => { const q = readQuantity(t, k); return Boolean(q && (q.unit || isConfident(matchAt(t, q.end, matcher)))); };

  while (i < t.length) {
    skip();
    if (i >= t.length) break;
    const from = i;
    let q = readQuantity(t, i);
    if (q) { i = q.end; skip(); }
    let m = matchAt(t, i, matcher);
    const line = { key: nextKey(), productId: null, name: "", qty: q ? q.qty : null, unit: q ? q.unit : null, price: null, priceFrom: null, heard: "", issue: null };
    if (m && isConfident(m)) {
      i = m.end;
      line.productId = m.product.id;
      line.name = m.product.name;
    } else if (m) {
      // Close to more than one product (or not close enough): show what was heard and ask — never pick for them.
      const heardWords = t.slice(i, m.end);
      line.heard = heardWords.map((x) => x.raw).join(" ");
      i = m.end;
      const soundsLike = suggest(heardWords.map((x) => x.w), products);
      const close = m.runnerUp && m.runnerUp.score >= 0.55 ? [m.runnerUp.product.id] : [];
      const choices = [...new Set([m.product.id, ...soundsLike, ...close])].slice(0, 3);
      line.issue = { kind: "which", message: `Which product is “${line.heard}”?`, choices };
    } else {
      // Words that aren't a product we know: keep them, and ask.
      const words = [];
      while (t[i] && !PRICE_WORDS.has(t[i].w) && !PER_WORDS.has(t[i].w) && !readQuantity(t, i) && !CONNECTORS.has(t[i].w)) { words.push(t[i]); i++; if (t[i - 1].pause) break; }
      if (!words.length && !q) { i = Math.max(i, from + 1); continue; } // stray word we can't use at all
      line.heard = words.map((x) => x.raw).join(" ");
      line.issue = { kind: "product", message: words.length ? `Didn't catch the product (heard “${line.heard}”).` : "Didn't catch the product.", choices: suggest(words.map((x) => x.w), products) };
    }
    // Amount said after the product ("okra fifty pounds", "fruit punch 24 at 375") — unless that number is clearly the
    // amount of the next product ("… 2 dozen cucumber juice").
    if (line.qty === null) {
      const after = readQuantity(t, i);
      if (after && (after.unit || !isConfident(matchAt(t, after.end, matcher)))) { line.qty = after.qty; line.unit = after.unit; i = after.end; }
    }
    // Unit price for this line: "at 230", "for 300", "$250", "315 per unit", "250 each", "4200 per dozen",
    // "300 a pound" — or a number right after the product that isn't the next product's amount ("… 315, 16 green juice").
    let price = null;
    if (t[i] && PRICE_WORDS.has(t[i].w)) {
      price = readPrice(t, t[i].w === "$" ? i : i + 1, { lineStartsAt });
      if (!price && !line.issue) { line.issue = { kind: "price", message: "Didn't catch the price." }; i++; }
    } else if (t[i] && wordNumber(t[i].w) !== null && (line.productId || line.issue?.kind === "which")) {
      const cand = readPrice(t, i, { lineStartsAt });
      if (cand && (perMarkerAt(t, cand.end) || cand.end >= t.length || (line.qty !== null && !lineStartsAt(i)))) price = cand;
    }
    if (price) {
      line.price = price.value;
      line.priceFrom = "said";
      i = price.end;
      const per = perMarkerAt(t, i);
      if (per) {
        if (per.unit && !line.unit) line.unit = per.unit;
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
      if (line.priceFrom === "said") {
        if (twin.priceFrom === "said" && twin.price !== line.price) twin.issue = { kind: "price", message: "Two different prices were said." };
        twin.price = line.price; twin.priceFrom = "said";
      }
      if (twin.price !== null && twin.issue?.kind === "noPrice") twin.issue = null;
    } else merged.push(line);
  }

  return {
    store,
    address,
    addressFrom,
    date: spokenDate.date,
    dateHeard: spokenDate.heard,
    storeIssue: store ? null : { kind: "store", message: "Didn't hear the store name." },
    lines: merged,
    transcript: String(text || "").trim(),
  };
}

/** How many lines need attention (used to pick the best of several possible transcripts). */
export const issueCount = (parsed) => parsed.lines.filter((l) => l.issue && l.issue.kind !== "noPrice").length * 2
  + parsed.lines.filter((l) => l.issue?.kind === "noPrice").length + (parsed.storeIssue ? 1 : 0);

/** Parses each candidate transcript (best first) and keeps the one with the fewest unclear parts. */
export function bestParse(candidates, ctx) {
  let best = null;
  for (const text of candidates) {
    if (!String(text || "").trim()) continue;
    const parsed = parseSpokenInvoice(text, ctx);
    if (!best || issueCount(parsed) < issueCount(best)) best = parsed;
  }
  return best || parseSpokenInvoice("", ctx);
}

export const _test = { tokenize, readNumber, readPrice, readQuantity, similarity, soundKey };
