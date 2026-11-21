const enc = new TextEncoder();
const dec = new TextDecoder();

export function b64url(bytes: ArrayBuffer | Uint8Array): string {
  const u = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
  let s = "";
  for (const b of u) s += String.fromCharCode(b);
  return btoa(s).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}
export function fromB64url(s: string): Uint8Array {
  const pad = s.replace(/-/g, "+").replace(/_/g, "/") + "===".slice((s.length + 3) % 4);
  const bin = atob(pad);
  return Uint8Array.from(bin, (c) => c.charCodeAt(0));
}

/** Constant-time string comparison. */
export function safeEqual(a: string, b: string): boolean {
  const x = enc.encode(a), y = enc.encode(b);
  let diff = x.length ^ y.length;
  for (let i = 0; i < Math.max(x.length, y.length); i++) diff |= (x[i] ?? 0) ^ (y[i] ?? 0);
  return diff === 0;
}

async function hmacKey(secret: string) {
  return crypto.subtle.importKey("raw", enc.encode(secret), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
}
export async function hmac(secret: string, data: string): Promise<string> {
  return b64url(await crypto.subtle.sign("HMAC", await hmacKey(secret), enc.encode(data)));
}
export async function sha256(data: string): Promise<string> {
  return b64url(await crypto.subtle.digest("SHA-256", enc.encode(data)));
}

// ── Password hashing (PBKDF2-SHA256) ──
const ITER = 100_000;
export async function hashPassword(pw: string): Promise<string> {
  const salt = crypto.getRandomValues(new Uint8Array(16));
  const key = await crypto.subtle.importKey("raw", enc.encode(pw), "PBKDF2", false, ["deriveBits"]);
  const bits = await crypto.subtle.deriveBits({ name: "PBKDF2", hash: "SHA-256", salt, iterations: ITER }, key, 256);
  return `pbkdf2$${ITER}$${b64url(salt)}$${b64url(bits)}`;
}
export async function verifyPassword(pw: string, stored: string): Promise<boolean> {
  const [alg, iter, salt, hash] = stored.split("$");
  if (alg !== "pbkdf2" || !iter || !salt || !hash) return false;
  const key = await crypto.subtle.importKey("raw", enc.encode(pw), "PBKDF2", false, ["deriveBits"]);
  const bits = await crypto.subtle.deriveBits({ name: "PBKDF2", hash: "SHA-256", salt: fromB64url(salt), iterations: Number(iter) }, key, 256);
  return safeEqual(b64url(bits), hash);
}

// ── Encrypting saved API keys (AES-GCM, key derived from SESSION_SECRET) ──
async function aesKey(secret: string) {
  const raw = await crypto.subtle.digest("SHA-256", enc.encode("cos-keys:" + secret));
  return crypto.subtle.importKey("raw", raw, "AES-GCM", false, ["encrypt", "decrypt"]);
}
export async function encrypt(secret: string, plain: string): Promise<string> {
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const ct = await crypto.subtle.encrypt({ name: "AES-GCM", iv }, await aesKey(secret), enc.encode(plain));
  return `${b64url(iv)}.${b64url(ct)}`;
}
export async function decrypt(secret: string, sealed: string): Promise<string | null> {
  try {
    const [iv, ct] = sealed.split(".");
    const pt = await crypto.subtle.decrypt({ name: "AES-GCM", iv: fromB64url(iv) }, await aesKey(secret), fromB64url(ct));
    return dec.decode(pt);
  } catch {
    return null;
  }
}
