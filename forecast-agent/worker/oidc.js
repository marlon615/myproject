/**
 * Single sign-on with Microsoft (Entra ID, work and personal accounts) and Google, using OpenID Connect:
 * authorization code + PKCE, then the ID token's signature is checked against the provider's published keys, with
 * issuer, audience, expiry and a one-time nonce. The platform owner registers one app with each provider and pastes
 * its client ID and secret on the owner dashboard (stored encrypted).
 *
 * Which email we trust: Google — `email` only when `email_verified` is true. Microsoft — `preferred_username` (the
 * sign-in name, which must be a domain the tenant has verified), not the editable `email` claim.
 */
import { verifyJwt, decodeJwt } from "./crypto.js";

export const PROVIDERS = {
  microsoft: {
    name: "Microsoft", clientIdKey: "msClientId", secretKey: "msSecret", scope: "openid email profile",
    authorize: "https://login.microsoftonline.com/common/oauth2/v2.0/authorize",
    token: "https://login.microsoftonline.com/common/oauth2/v2.0/token",
    jwks: "https://login.microsoftonline.com/common/discovery/v2.0/keys",
    issuerOk: (c) => typeof c.tid === "string" && c.iss === `https://login.microsoftonline.com/${c.tid}/v2.0`,
    identity: (c) => ({ email: String(c.preferred_username || "").toLowerCase(), subject: `${c.tid}:${c.oid || c.sub}` }),
  },
  google: {
    name: "Google", clientIdKey: "googleClientId", secretKey: "googleSecret", scope: "openid email profile",
    authorize: "https://accounts.google.com/o/oauth2/v2/auth",
    token: "https://oauth2.googleapis.com/token",
    jwks: "https://www.googleapis.com/oauth2/v3/certs",
    issuerOk: (c) => c.iss === "https://accounts.google.com" || c.iss === "accounts.google.com",
    identity: (c) => ({ email: c.email_verified === true ? String(c.email || "").toLowerCase() : "", subject: c.sub }),
  },
};

/** In tests only (OIDC_TEST_BASE set), a local stand-in provider replaces the real endpoints. */
export function endpoints(env, provider) {
  const p = PROVIDERS[provider];
  if (!env.OIDC_TEST_BASE) return p;
  const b = `${env.OIDC_TEST_BASE}/${provider}`;
  return { ...p, authorize: `${b}/authorize`, token: `${b}/token`, jwks: `${b}/jwks`, issuerOk: (c) => c.iss === b };
}

const jwksCache = new Map();
async function keys(url) {
  const hit = jwksCache.get(url);
  if (hit && hit.until > Date.now()) return hit.jwks;
  const res = await fetch(url, { signal: AbortSignal.timeout(10000) });
  if (!res.ok) throw new Error("couldn't load the provider's keys");
  const jwks = await res.json();
  jwksCache.set(url, { jwks, until: Date.now() + 3600_000 });
  return jwks;
}

export function authorizeUrl(ep, { clientId, redirectUri, state, nonce, challenge, loginHint }) {
  const u = new URL(ep.authorize);
  const q = { client_id: clientId, response_type: "code", redirect_uri: redirectUri, scope: ep.scope, state, nonce, code_challenge: challenge, code_challenge_method: "S256", response_mode: "query", prompt: "select_account" };
  if (loginHint) q.login_hint = loginHint;
  for (const [k, v] of Object.entries(q)) u.searchParams.set(k, v);
  return u.toString();
}

/** Code → verified identity { email, subject }, or throws with a short reason. */
export async function finishSignIn(ep, { clientId, clientSecret, code, redirectUri, verifier, nonce }) {
  const res = await fetch(ep.token, {
    method: "POST", headers: { "Content-Type": "application/x-www-form-urlencoded", Accept: "application/json" },
    body: new URLSearchParams({ grant_type: "authorization_code", client_id: clientId, client_secret: clientSecret, code, redirect_uri: redirectUri, code_verifier: verifier }),
    signal: AbortSignal.timeout(15000),
  });
  if (!res.ok) throw new Error(`the provider refused the sign-in (${res.status})`);
  const { id_token } = await res.json();
  if (!id_token) throw new Error("no ID token");
  let claims;
  try { claims = await verifyJwt(id_token, await keys(ep.jwks)); }
  catch (e) {
    // Keys rotate: reload once and try again.
    jwksCache.delete(ep.jwks);
    claims = await verifyJwt(id_token, await keys(ep.jwks));
  }
  const now = Math.floor(Date.now() / 1000);
  const aud = Array.isArray(claims.aud) ? claims.aud : [claims.aud];
  if (!aud.includes(clientId)) throw new Error("token for another app");
  if (!ep.issuerOk(claims)) throw new Error("unexpected issuer");
  if (!(claims.exp > now - 60) || (claims.nbf && claims.nbf > now + 60)) throw new Error("token expired");
  if (claims.nonce !== nonce) throw new Error("sign-in replay");
  const id = ep.identity(claims);
  if (!id.email || !id.email.includes("@")) throw new Error("no verified email");
  return id;
}
export { decodeJwt };
