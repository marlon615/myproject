/**
 * Web Push from the Worker, with Web Crypto only (no libraries):
 *   - VAPID (RFC 8292): an ES256-signed JWT identifies this server to the push service;
 *   - message encryption (RFC 8291, "aes128gcm" content coding, RFC 8188), so only the seller's phone can read it.
 *
 *   newVapidKeys()                                  → { publicKey (base64url, 65-byte point), privateJwk }
 *   vapidHeader(endpoint, keys, subject, now?)      → "vapid t=<jwt>, k=<publicKey>"
 *   encryptPayload(subscriptionKeys, text, opts?)   → Uint8Array body (salt | rs | idlen | keyid | ciphertext)
 *   sendPush(subscription, keys, subject, payload)  → { ok, status, gone }   (gone: 404/410, the phone unsubscribed)
 *   pushEndpointOk(url, { allowLocal })             → only real push services (no calling arbitrary addresses)
 */
const te = new TextEncoder();
export const b64url = (u8) => { let s = ""; for (let i = 0; i < u8.length; i += 0x8000) s += String.fromCharCode.apply(null, u8.subarray(i, i + 0x8000)); return btoa(s).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, ""); };
export const unb64url = (s) => Uint8Array.from(atob(String(s).replace(/-/g, "+").replace(/_/g, "/") + "===".slice((String(s).length + 3) % 4)), (c) => c.charCodeAt(0));
const concat = (...parts) => { const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0)); let o = 0; for (const p of parts) { out.set(p, o); o += p.length; } return out; };
async function hmac(key, data) {
  const k = await crypto.subtle.importKey("raw", key, { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  return new Uint8Array(await crypto.subtle.sign("HMAC", k, data));
}

export async function newVapidKeys() {
  const kp = await crypto.subtle.generateKey({ name: "ECDSA", namedCurve: "P-256" }, true, ["sign", "verify"]);
  return { publicKey: b64url(new Uint8Array(await crypto.subtle.exportKey("raw", kp.publicKey))), privateJwk: await crypto.subtle.exportKey("jwk", kp.privateKey) };
}

/** The Authorization header for one push service (aud = its origin), valid for 12 hours. */
export async function vapidHeader(endpoint, keys, subject, now = Date.now()) {
  const header = b64url(te.encode(JSON.stringify({ typ: "JWT", alg: "ES256" })));
  const claims = b64url(te.encode(JSON.stringify({ aud: new URL(endpoint).origin, exp: Math.floor(now / 1000) + 12 * 3600, sub: subject })));
  const key = await crypto.subtle.importKey("jwk", keys.privateJwk, { name: "ECDSA", namedCurve: "P-256" }, false, ["sign"]);
  const sig = new Uint8Array(await crypto.subtle.sign({ name: "ECDSA", hash: "SHA-256" }, key, te.encode(`${header}.${claims}`))); // r | s, as JWT wants
  return `vapid t=${header}.${claims}.${b64url(sig)}, k=${keys.publicKey}`;
}

/**
 * RFC 8291: encrypts `text` for a subscription { p256dh, auth } (base64url). One record, rs = 4096.
 * opts.salt / opts.localKeys only for tests with fixed values.
 */
export async function encryptPayload({ p256dh, auth }, text, opts = {}) {
  const uaPublic = unb64url(p256dh), authSecret = unb64url(auth);
  if (uaPublic.length !== 65 || uaPublic[0] !== 4 || authSecret.length !== 16) throw new Error("bad subscription keys");
  const local = opts.localKeys || await crypto.subtle.generateKey({ name: "ECDH", namedCurve: "P-256" }, true, ["deriveBits"]);
  const asPublic = new Uint8Array(await crypto.subtle.exportKey("raw", local.publicKey));
  const uaKey = await crypto.subtle.importKey("raw", uaPublic, { name: "ECDH", namedCurve: "P-256" }, false, []);
  const ecdh = new Uint8Array(await crypto.subtle.deriveBits({ name: "ECDH", public: uaKey }, local.privateKey, 256));
  const prkKey = await hmac(authSecret, ecdh);
  const ikm = await hmac(prkKey, concat(te.encode("WebPush: info\0"), uaPublic, asPublic, new Uint8Array([1])));
  const salt = opts.salt || crypto.getRandomValues(new Uint8Array(16));
  const prk = await hmac(salt, ikm);
  const cek = (await hmac(prk, te.encode("Content-Encoding: aes128gcm\0\x01"))).slice(0, 16);
  const nonce = (await hmac(prk, te.encode("Content-Encoding: nonce\0\x01"))).slice(0, 12);
  const key = await crypto.subtle.importKey("raw", cek, "AES-GCM", false, ["encrypt"]);
  const record = concat(te.encode(text), new Uint8Array([2])); // 0x02: the last (and only) record
  const ct = new Uint8Array(await crypto.subtle.encrypt({ name: "AES-GCM", iv: nonce }, key, record));
  const head = new Uint8Array(21); head.set(salt); new DataView(head.buffer).setUint32(16, 4096); head[20] = asPublic.length;
  return concat(head, asPublic, ct);
}

const PUSH_HOSTS = [/^fcm\.googleapis\.com$/, /^android\.googleapis\.com$/, /^updates\.push\.services\.mozilla\.com$/, /^push\.services\.mozilla\.com$/, /^web\.push\.apple\.com$/, /^[a-z0-9-]+\.notify\.windows\.com$/];
export function pushEndpointOk(url, { allowLocal = false } = {}) {
  let u; try { u = new URL(url); } catch { return false; }
  if (allowLocal && u.protocol === "http:" && (u.hostname === "localhost" || u.hostname === "127.0.0.1")) return true;
  return u.protocol === "https:" && !u.port && PUSH_HOSTS.some((re) => re.test(u.hostname));
}

export async function sendPush(sub, keys, subject, payload, { ttl = 86400, topic } = {}) {
  const body = await encryptPayload(sub.keys, JSON.stringify(payload));
  const headers = { "Content-Encoding": "aes128gcm", "Content-Type": "application/octet-stream", TTL: String(ttl), Urgency: "high", Authorization: await vapidHeader(sub.endpoint, keys, subject) };
  if (topic) headers.Topic = topic; // a newer message with the same topic replaces one still waiting
  try {
    const res = await fetch(sub.endpoint, { method: "POST", headers, body, signal: AbortSignal.timeout(10000) });
    return { ok: res.ok, status: res.status, gone: res.status === 404 || res.status === 410 };
  } catch { return { ok: false, status: 0, gone: false }; }
}
