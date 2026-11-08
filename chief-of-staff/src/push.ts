/**
 * Web Push without any library: VAPID (RFC 8292) for identifying this server,
 * and aes128gcm payload encryption (RFC 8291) so only the phone can read the notification.
 */
import { b64url, decrypt, encrypt, fromB64url } from "./crypto";
import type { Env } from "./types";

const enc = new TextEncoder();

function concat(...parts: Uint8Array[]) {
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let o = 0;
  for (const p of parts) { out.set(p, o); o += p.length; }
  return out;
}

// ── VAPID keys: made once, private key stored encrypted ──

export async function vapidKeys(env: Env): Promise<{ publicRaw: Uint8Array; privateKey: CryptoKey }> {
  const pub = await env.DB.prepare("select value from settings where key = 'vapid:public'").first<{ value: string }>();
  const priv = await env.DB.prepare("select value from settings where key = 'vapid:private'").first<{ value: string }>();
  if (pub && priv) {
    const jwk = JSON.parse((await decrypt(env.SESSION_SECRET, priv.value)) ?? "null");
    if (jwk) {
      const privateKey = await crypto.subtle.importKey("jwk", jwk, { name: "ECDSA", namedCurve: "P-256" }, false, ["sign"]);
      return { publicRaw: fromB64url(pub.value), privateKey };
    }
  }
  const kp = (await crypto.subtle.generateKey({ name: "ECDSA", namedCurve: "P-256" }, true, ["sign", "verify"])) as CryptoKeyPair;
  const publicRaw = new Uint8Array((await crypto.subtle.exportKey("raw", kp.publicKey)) as ArrayBuffer);
  const jwk = await crypto.subtle.exportKey("jwk", kp.privateKey);
  await env.DB.batch([
    env.DB.prepare("insert into settings (key, value) values ('vapid:public', ?) on conflict(key) do update set value = excluded.value").bind(b64url(publicRaw)),
    env.DB.prepare("insert into settings (key, value) values ('vapid:private', ?) on conflict(key) do update set value = excluded.value").bind(await encrypt(env.SESSION_SECRET, JSON.stringify(jwk))),
  ]);
  return { publicRaw, privateKey: kp.privateKey };
}

async function vapidAuth(env: Env, endpoint: string, subject: string) {
  const { publicRaw, privateKey } = await vapidKeys(env);
  const aud = new URL(endpoint).origin;
  const header = b64url(enc.encode(JSON.stringify({ typ: "JWT", alg: "ES256" })));
  const claims = b64url(enc.encode(JSON.stringify({ aud, exp: Math.floor(Date.now() / 1000) + 12 * 3600, sub: subject })));
  const sig = await crypto.subtle.sign({ name: "ECDSA", hash: "SHA-256" }, privateKey, enc.encode(`${header}.${claims}`));
  return `vapid t=${header}.${claims}.${b64url(sig)}, k=${b64url(publicRaw)}`;
}

// ── Payload encryption (aes128gcm) ──

async function hkdf(salt: Uint8Array, ikm: ArrayBuffer | Uint8Array, info: Uint8Array, bits: number) {
  const key = await crypto.subtle.importKey("raw", ikm, "HKDF", false, ["deriveBits"]);
  return new Uint8Array(await crypto.subtle.deriveBits({ name: "HKDF", hash: "SHA-256", salt, info }, key, bits));
}

export async function encryptPayload(p256dh: string, authSecret: string, plaintext: Uint8Array): Promise<Uint8Array> {
  const uaPublic = fromB64url(p256dh);
  const auth = fromB64url(authSecret);
  const local = (await crypto.subtle.generateKey({ name: "ECDH", namedCurve: "P-256" }, true, ["deriveBits"])) as CryptoKeyPair;
  const asPublic = new Uint8Array((await crypto.subtle.exportKey("raw", local.publicKey)) as ArrayBuffer);
  const uaKey = await crypto.subtle.importKey("raw", uaPublic, { name: "ECDH", namedCurve: "P-256" }, false, []);
  const shared = await crypto.subtle.deriveBits({ name: "ECDH", public: uaKey } as unknown as SubtleCryptoDeriveKeyAlgorithm, local.privateKey, 256);
  const ikm = await hkdf(auth, shared, concat(enc.encode("WebPush: info\0"), uaPublic, asPublic), 256);
  const salt = crypto.getRandomValues(new Uint8Array(16));
  const cek = await hkdf(salt, ikm, enc.encode("Content-Encoding: aes128gcm\0"), 128);
  const nonce = await hkdf(salt, ikm, enc.encode("Content-Encoding: nonce\0"), 96);
  const key = await crypto.subtle.importKey("raw", cek, "AES-GCM", false, ["encrypt"]);
  const ct = new Uint8Array(await crypto.subtle.encrypt({ name: "AES-GCM", iv: nonce }, key, concat(plaintext, new Uint8Array([2]))));
  const rs = new Uint8Array([0, 0, 16, 0]); // record size 4096
  return concat(salt, rs, new Uint8Array([asPublic.length]), asPublic, ct);
}

// ── Sending ──

export interface PushMessage {
  title: string;
  body: string;
  url: string;           // opened when the notification is tapped
  approve?: string;      // one-tap approval token (Android shows a "Yes, send" button)
  tag?: string;
}

/** Sends to every subscribed phone. Returns how many got it; forgets phones that unsubscribed. */
export async function sendPush(env: Env, msg: PushMessage, subject = "mailto:owner@chief.local"): Promise<number> {
  const { results } = await env.DB.prepare("select * from push_subs").all<{ id: number; endpoint: string; p256dh: string; auth: string }>();
  let ok = 0;
  for (const s of results) {
    try {
      const body = await encryptPayload(s.p256dh, s.auth, enc.encode(JSON.stringify(msg)));
      const res = await fetch(s.endpoint, {
        method: "POST",
        headers: {
          Authorization: await vapidAuth(env, s.endpoint, subject),
          "Content-Encoding": "aes128gcm",
          "Content-Type": "application/octet-stream",
          TTL: "86400",
          Urgency: "high",
          ...(msg.tag ? { Topic: msg.tag.replace(/[^A-Za-z0-9_-]/g, "").slice(0, 32) } : {}),
        },
        body,
      });
      if (res.status === 404 || res.status === 410) await env.DB.prepare("delete from push_subs where id = ?").bind(s.id).run();
      else if (res.ok) ok++;
      else console.error("push failed", res.status, (await res.text()).slice(0, 200));
    } catch (e) {
      console.error("push error:", (e as Error).message);
    }
  }
  return ok;
}

export async function pushCount(env: Env) {
  return (await env.DB.prepare("select count(*) as n from push_subs").first<{ n: number }>())?.n ?? 0;
}
