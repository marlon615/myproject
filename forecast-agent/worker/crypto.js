/**
 * Security building blocks (Web Crypto only, no libraries):
 *   random ids, SHA-256, HMAC, passwords (PBKDF2-SHA256, iteration count stored with each hash), AES-256-GCM
 *   encryption at rest, TOTP two-factor codes (RFC 6238), RS256 ID-token checks against a provider's keys (JWKS),
 *   and OAuth 1.0a request signing (NetSuite).
 */
const te = new TextEncoder(), td = new TextDecoder();
export const hex = (buf) => Array.from(new Uint8Array(buf), (b) => b.toString(16).padStart(2, "0")).join("");
export const randomHex = (n) => hex(crypto.getRandomValues(new Uint8Array(n)));
export const sha256 = async (text) => hex(await crypto.subtle.digest("SHA-256", te.encode(text)));
export const b64 = (bytes) => btoa(String.fromCharCode(...new Uint8Array(bytes)));
export const unb64 = (s) => Uint8Array.from(atob(s), (c) => c.charCodeAt(0));
export const b64url = (bytes) => b64(bytes).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
export const unb64url = (s) => unb64(s.replace(/-/g, "+").replace(/_/g, "/") + "===".slice((s.length + 3) % 4));
export const sameText = (a, b) => {
  a = String(a ?? ""); b = String(b ?? "");
  if (a.length !== b.length) return false;
  let x = 0; for (let i = 0; i < a.length; i++) x |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return x === 0;
};

const hmacKeys = new Map();
export async function hmac(hash, key, data) {
  let k = typeof key === "string" ? hmacKeys.get(`${hash}\u0000${key}`) : null;
  if (!k) {
    k = await crypto.subtle.importKey("raw", typeof key === "string" ? te.encode(key) : key, { name: "HMAC", hash }, false, ["sign"]);
    if (typeof key === "string" && hmacKeys.size < 100) hmacKeys.set(`${hash}\u0000${key}`, k); // the same key is used for every series name
  }
  return new Uint8Array(await crypto.subtle.sign("HMAC", k, typeof data === "string" ? te.encode(data) : data));
}

// ── Passwords ───────────────────────────────────────────────────────────────────────────────────────────────────
/** Stored as "pbkdf2$<iterations>$<salt>$<hash>". Older rows (salt and hash in separate columns, 5000 rounds) still work. */
export async function hashPassword(password, iterations) {
  const salt = randomHex(16);
  return `pbkdf2$${iterations}$${salt}$${await pbkdf2(password, salt, iterations)}`;
}
export async function checkPassword(password, stored, legacySalt) {
  if (!stored) { await pbkdf2(password, "no-such-user", 5000); return false; }
  if (stored.startsWith("pbkdf2$")) {
    const [, it, salt, h] = stored.split("$");
    return sameText(await pbkdf2(password, salt, Number(it)), h);
  }
  return sameText(await pbkdf2(password, legacySalt || "", 5000), stored);
}
export const passwordRounds = (stored) => (stored?.startsWith("pbkdf2$") ? Number(stored.split("$")[1]) : 5000);
async function pbkdf2(password, salt, iterations) {
  const key = await crypto.subtle.importKey("raw", te.encode(password), "PBKDF2", false, ["deriveBits"]);
  return hex(await crypto.subtle.deriveBits({ name: "PBKDF2", hash: "SHA-256", salt: te.encode(salt), iterations }, key, 256));
}

// ── Encryption at rest (AES-256-GCM) ────────────────────────────────────────────────────────────────────────────
// "v1:<base64(iv | ciphertext+tag)>". Text without the prefix is old, unencrypted data and is returned as is.
const keyCache = new Map();
async function aesKey(secret) {
  if (!secret) throw new Error("ENCRYPTION_KEY is not set");
  if (!keyCache.has(secret)) keyCache.set(secret, await crypto.subtle.importKey("raw", unb64(secret), "AES-GCM", false, ["encrypt", "decrypt"]));
  return keyCache.get(secret);
}
export async function encrypt(secret, text) {
  if (text === null || text === undefined) return null;
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const ct = new Uint8Array(await crypto.subtle.encrypt({ name: "AES-GCM", iv }, await aesKey(secret), te.encode(String(text))));
  const out = new Uint8Array(12 + ct.length); out.set(iv); out.set(ct, 12);
  return "v1:" + b64(out);
}
export async function decrypt(secret, stored) {
  if (stored === null || stored === undefined) return null;
  if (!String(stored).startsWith("v1:")) return stored; // written before encryption was added
  const raw = unb64(String(stored).slice(3));
  return td.decode(await crypto.subtle.decrypt({ name: "AES-GCM", iv: raw.slice(0, 12) }, await aesKey(secret), raw.slice(12)));
}
export const isEncrypted = (stored) => typeof stored === "string" && stored.startsWith("v1:");

// ── TOTP (authenticator apps: Microsoft/Google Authenticator, 1Password, Authy…) ────────────────────────────────
const B32 = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";
export function base32(bytes) {
  let bits = 0, value = 0, out = "";
  for (const b of bytes) { value = (value << 8) | b; bits += 8; while (bits >= 5) { out += B32[(value >>> (bits - 5)) & 31]; bits -= 5; } }
  if (bits > 0) out += B32[(value << (5 - bits)) & 31];
  return out;
}
export function unbase32(s) {
  const clean = String(s).toUpperCase().replace(/[^A-Z2-7]/g, "");
  let bits = 0, value = 0; const out = [];
  for (const c of clean) { value = (value << 5) | B32.indexOf(c); bits += 5; if (bits >= 8) { out.push((value >>> (bits - 8)) & 255); bits -= 8; } }
  return new Uint8Array(out);
}
export const newTotpSecret = () => base32(crypto.getRandomValues(new Uint8Array(20)));
export async function totpAt(secret, counter) {
  const msg = new Uint8Array(8); let c = counter;
  for (let i = 7; i >= 0; i--) { msg[i] = c & 255; c = Math.floor(c / 256); }
  const h = await hmac("SHA-1", unbase32(secret), msg);
  const o = h[19] & 15;
  const n = ((h[o] & 127) << 24) | (h[o + 1] << 16) | (h[o + 2] << 8) | h[o + 3];
  return String(n % 1_000_000).padStart(6, "0");
}
/** Accepts the current 30-second code or one step either side (clock drift). Returns the step used, or null. */
export async function checkTotp(secret, code, now = Date.now()) {
  const c = String(code ?? "").replace(/\s/g, "");
  if (!/^\d{6}$/.test(c)) return null;
  const step = Math.floor(now / 30000);
  for (const d of [0, -1, 1]) if (sameText(await totpAt(secret, step + d), c)) return step + d;
  return null;
}
export const totpUri = (secret, account, issuer = "Forecasting Agent") =>
  `otpauth://totp/${encodeURIComponent(issuer)}:${encodeURIComponent(account)}?secret=${secret}&issuer=${encodeURIComponent(issuer)}&algorithm=SHA1&digits=6&period=30`;

// ── ID tokens (OpenID Connect, RS256) ───────────────────────────────────────────────────────────────────────────
export function decodeJwt(token) {
  const [h, p, s] = String(token).split(".");
  if (!h || !p || !s) throw new Error("not a JWT");
  return { header: JSON.parse(td.decode(unb64url(h))), payload: JSON.parse(td.decode(unb64url(p))), signed: te.encode(`${h}.${p}`), sig: unb64url(s) };
}
/** Checks the signature with the provider's published keys; the caller checks issuer, audience, expiry and nonce. */
export async function verifyJwt(token, jwks) {
  const t = decodeJwt(token);
  if (t.header.alg !== "RS256") throw new Error("unexpected algorithm");
  const jwk = (jwks.keys || []).find((k) => k.kid === t.header.kid && k.kty === "RSA");
  if (!jwk) throw new Error("signing key not found");
  const key = await crypto.subtle.importKey("jwk", { kty: "RSA", n: jwk.n, e: jwk.e, alg: "RS256", ext: true }, { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" }, false, ["verify"]);
  if (!(await crypto.subtle.verify("RSASSA-PKCS1-v1_5", key, t.sig, t.signed))) throw new Error("bad signature");
  return t.payload;
}
export async function pkce() {
  const verifier = b64url(crypto.getRandomValues(new Uint8Array(32)));
  const challenge = b64url(await crypto.subtle.digest("SHA-256", te.encode(verifier)));
  return { verifier, challenge };
}

// ── OAuth 1.0a (NetSuite token-based authentication, HMAC-SHA256) ────────────────────────────────────────────────
const pct = (s) => encodeURIComponent(s).replace(/[!'()*]/g, (c) => "%" + c.charCodeAt(0).toString(16).toUpperCase());
export async function oauth1Header({ method, url, realm, consumerKey, consumerSecret, token, tokenSecret, nonce = randomHex(16), timestamp = Math.floor(Date.now() / 1000) }) {
  const u = new URL(url);
  const params = { oauth_consumer_key: consumerKey, oauth_nonce: nonce, oauth_signature_method: "HMAC-SHA256", oauth_timestamp: String(timestamp), oauth_token: token, oauth_version: "1.0" };
  const all = [...Object.entries(params), ...u.searchParams.entries()].map(([k, v]) => [pct(k), pct(v)]).sort((a, b) => (a[0] === b[0] ? (a[1] < b[1] ? -1 : 1) : a[0] < b[0] ? -1 : 1));
  const base = [method.toUpperCase(), pct(`${u.origin}${u.pathname}`), pct(all.map(([k, v]) => `${k}=${v}`).join("&"))].join("&");
  const sig = b64(await hmac("SHA-256", `${pct(consumerSecret)}&${pct(tokenSecret)}`, base));
  return `OAuth realm="${realm}",` + Object.entries({ ...params, oauth_signature: sig }).map(([k, v]) => `${k}="${pct(v)}"`).join(",");
}
