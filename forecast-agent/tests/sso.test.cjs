/**
 * Single sign-on (Microsoft, Google) against a stand-in identity provider on this machine that behaves like the
 * real ones: authorization code + PKCE (it checks the code verifier), RS256-signed ID tokens, published keys (JWKS).
 *   - join from an invite, sign in from the sign-in page (in a real browser), join by allowed email domain (viewer)
 *   - refused: unknown people, an unverified Google email, Microsoft's editable `email` claim used to impersonate,
 *     a token for another app, a wrong nonce, a forged signature, an expired token, a replayed sign-in
 *   - "everyone must use single sign-on" turns passwords off; switching the feature off never locks a company out
 */
const { spawnSync } = require("child_process");
const fs = require("fs"), os = require("os"), path = require("path"), http = require("http"), crypto = require("crypto");
const { chromium } = require("playwright");
const { checker, startWorker, api, sleep, APP } = require("./helpers.cjs");

const PORT = 8860, IDP = 8861, IDP_BASE = `http://localhost:${IDP}`, OUT = path.join(__dirname, "output");
const { check, failures } = checker();
const { publicKey, privateKey } = crypto.generateKeyPairSync("rsa", { modulusLength: 2048 });
const { privateKey: rogueKey } = crypto.generateKeyPairSync("rsa", { modulusLength: 2048 });
const jwk = { ...publicKey.export({ format: "jwk" }), kid: "idp-1", alg: "RS256", use: "sig" };
const codes = new Map();
let identity = null;   // who "signs in" at the provider next: { claims } plus optional { tamper } tricks
const b64u = (o) => Buffer.from(JSON.stringify(o)).toString("base64url");
function sign(claims, key = privateKey) { const h = b64u({ alg: "RS256", kid: "idp-1", typ: "JWT" }), p = b64u(claims); return `${h}.${p}.${crypto.sign("sha256", Buffer.from(`${h}.${p}`), key).toString("base64url")}`; }

const idp = http.createServer(async (rq, rs) => {
  let body = ""; for await (const c of rq) body += c;
  const u = new URL(rq.url, IDP_BASE), [, provider, step] = u.pathname.split("/");
  if (step === "jwks") { rs.writeHead(200, { "content-type": "application/json" }); return rs.end(JSON.stringify({ keys: [jwk] })); }
  if (step === "authorize") {
    const code = crypto.randomBytes(8).toString("hex");
    codes.set(code, { provider, nonce: u.searchParams.get("nonce"), challenge: u.searchParams.get("code_challenge"), clientId: u.searchParams.get("client_id"), redirect: u.searchParams.get("redirect_uri"), who: identity });
    rs.writeHead(302, { Location: `${u.searchParams.get("redirect_uri")}?code=${code}&state=${u.searchParams.get("state")}` });
    return rs.end();
  }
  if (step === "token") {
    const f = new URLSearchParams(body), c = codes.get(f.get("code"));
    codes.delete(f.get("code"));
    const secretOk = f.get("client_secret") === (provider === "microsoft" ? "ms-secret" : "g-secret");
    const pkceOk = c && crypto.createHash("sha256").update(f.get("code_verifier") || "").digest("base64url") === c.challenge;
    if (!c || !secretOk || !pkceOk || f.get("redirect_uri") !== c.redirect) { rs.writeHead(400, { "content-type": "application/json" }); return rs.end(JSON.stringify({ error: "invalid_grant", pkceOk, secretOk })); }
    const t = c.who.tamper || {}, nowS = Math.floor(Date.now() / 1000);
    const claims = { iss: `${IDP_BASE}/${provider}`, aud: t.aud || c.clientId, nonce: t.nonce || c.nonce, iat: nowS, exp: t.expired ? nowS - 3600 : nowS + 3600, sub: "s-" + crypto.randomBytes(4).toString("hex"), ...c.who.claims };
    let token = sign(claims, t.rogue ? rogueKey : privateKey);
    rs.writeHead(200, { "content-type": "application/json" });
    return rs.end(JSON.stringify({ id_token: token, access_token: "x", token_type: "Bearer" }));
  }
  rs.writeHead(404); rs.end();
});

(async () => {
  fs.mkdirSync(OUT, { recursive: true });
  check(spawnSync(process.execPath, [path.join(APP, "scripts", "build-worker.cjs")], { cwd: APP }).status === 0, "the app packs into the Worker");
  await new Promise((ok) => idp.listen(IDP, ok));
  const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), "forecast-sso-"));
  const w = startWorker(PORT, stateDir, { OIDC_TEST_BASE: IDP_BASE });
  const req = api(w.base);
  const browser = await chromium.launch();
  /** The whole redirect dance without a browser; returns where the app sends the browser in the end. */
  async function ssoAs(provider, who, query = "") {
    identity = who;
    const start = await req(`/api/sso/${provider}/start${query}`);
    const authUrl = start.headers.get("location");
    const back = await fetch(authUrl, { redirect: "manual" });
    const cb = new URL(back.headers.get("location"));
    const fin = await req(cb.pathname + cb.search);
    const loc = fin.headers.get("location") || "";
    const code = /#\/sso\/([0-9a-f]{48})$/.exec(loc)?.[1];
    const redeemed = code ? await req("/api/sso/redeem", { method: "POST", body: { code } }) : null;
    return { authUrl, loc, code, me: redeemed?.data.me, token: redeemed?.data.token, callback: cb.pathname + cb.search };
  }
  const MS = (upn, extra = {}) => ({ claims: { tid: "11111111-2222-3333-4444-555555555555", oid: "o-1", preferred_username: upn, ...extra } });
  const G = (email, verified = true, extra = {}) => ({ claims: { email, email_verified: verified, ...extra } });
  try {
    await w.ready;
    const owner = (await req("/api/owner/claim", { method: "POST", body: { passcode: "owner-pass-123" } })).data.token;
    check((await req("/api/sso/microsoft/start")).headers.get("location").endsWith("#/login?sso=unavailable"), "before the owner sets up the Microsoft app, the button explains it isn't available");
    await req("/api/owner/platform", { method: "POST", token: owner, body: { msClientId: "ms-client", msSecret: "ms-secret", googleClientId: "g-client", googleSecret: "g-secret" } });
    const A = await req("/api/signup", { method: "POST", body: { company: "Harbor Retail Group", email: "cfo@harbor.test", password: "admin-pass-1" } });
    const admin = A.data.token, aid = A.data.me.id;

    const notOn = await ssoAs("microsoft", MS("cfo@harbor.test"));
    check(/sso=notEnabled/.test(notOn.loc), "a company without the single sign-on feature can't use it");
    await req("/api/owner/contract", { method: "POST", token: owner, body: { id: aid, plan: "Enterprise", contract: 50000, allFeatures: true } });

    const s1 = await ssoAs("microsoft", MS("CFO@harbor.test"));
    const au = new URL(s1.authUrl);
    check(au.searchParams.get("code_challenge_method") === "S256" && au.searchParams.get("client_id") === "ms-client" && au.searchParams.get("nonce") && au.searchParams.get("redirect_uri") === `${w.base}/api/sso/callback`, "the sign-in request uses PKCE (S256), the right app, a nonce and the right return address");
    check(s1.me?.email === "cfo@harbor.test" && s1.me.role === "admin" && s1.token, "an existing user signs in with Microsoft (name matched case-insensitively)");
    check((await req(s1.callback)).headers.get("location").includes("sso=expired"), "the same sign-in can't be replayed");
    check((await req("/api/sso/redeem", { method: "POST", body: { code: s1.code } })).status === 410, "the one-time code from the redirect works once");

    // Invite → join with Microsoft.
    const inv = await req("/api/team", { method: "POST", token: admin, body: { email: "pat@harbor.test", name: "Pat", role: "manager" } });
    const it = inv.data.link.split("/").pop();
    const j = await ssoAs("microsoft", MS("pat@harbor.test"), `?invite=${it}&email=pat%40harbor.test`);
    check(j.me?.email === "pat@harbor.test" && j.me.role === "manager" && j.me.user.sso === "microsoft", "an invited person joins with Microsoft and gets the role they were invited with");
    // Unknown person; domain join; Google checks.
    check(/sso=unknown/.test((await ssoAs("google", G("stranger@harbor.test"))).loc), "someone not invited is refused (until the company allows its domain)");
    await req("/api/settings", { method: "POST", token: admin, body: { ssoDomains: "harbor.test" } });
    const jd = await ssoAs("google", G("new.hire@harbor.test"));
    check(jd.me?.email === "new.hire@harbor.test" && jd.me.role === "viewer", "with harbor.test allowed, a new colleague joins with Google as a viewer");
    check(/sso=failed/.test((await ssoAs("google", G("other@harbor.test", false))).loc), "a Google account with an unverified email is refused");
    const evil = await ssoAs("microsoft", MS("attacker@evil.test", { email: "cfo@harbor.test" }));
    check(/sso=unknown/.test(evil.loc) && !evil.me, "Microsoft's editable email claim can't be used to sign in as someone else (the verified sign-in name is used)");
    check(/sso=failed/.test((await ssoAs("microsoft", { ...MS("cfo@harbor.test"), tamper: { aud: "some-other-app" } })).loc), "a token issued for another app is refused");
    check(/sso=failed/.test((await ssoAs("microsoft", { ...MS("cfo@harbor.test"), tamper: { nonce: "replayed-nonce" } })).loc), "a token with the wrong nonce is refused");
    check(/sso=failed/.test((await ssoAs("microsoft", { ...MS("cfo@harbor.test"), tamper: { rogue: true } })).loc), "a token signed with somebody else's key is refused");
    check(/sso=failed/.test((await ssoAs("microsoft", { ...MS("cfo@harbor.test"), tamper: { expired: true } })).loc), "an expired token is refused");
    const log = (await req("/api/audit?limit=200", { token: admin })).data.events.map((e) => `${e.user} ${e.action}`);
    check(log.some((l) => /cfo@harbor.test signed in with Microsoft/.test(l)) && log.some((l) => /new.hire@harbor.test joined through Google sign-in \(viewer\)/.test(l)), "single sign-ons are in the activity log");

    // Everyone must use single sign-on.
    await req("/api/settings", { method: "POST", token: admin, body: { requireSso: true } });
    const pw = await req("/api/login", { method: "POST", body: { email: "cfo@harbor.test", password: "admin-pass-1" } });
    check(pw.status === 403 && pw.data.sso, "with single sign-on required, password sign-in is refused (and says to use the button)");
    check((await ssoAs("google", G("cfo@harbor.test"))).me?.email === "cfo@harbor.test", "…while signing in with Microsoft/Google still works");
    await req("/api/owner/features", { method: "POST", token: owner, body: { id: aid, features: { sso: false } } });
    check((await req("/api/login", { method: "POST", body: { email: "cfo@harbor.test", password: "admin-pass-1" } })).status === 200, "if the owner switches single sign-on off, the requirement is lifted so nobody is locked out");
    await req("/api/owner/features", { method: "POST", token: owner, body: { id: aid, features: { sso: true } } });

    // In a real browser: the sign-in page's Microsoft button, all the way to the signed-in app.
    const ctx = await browser.newContext({ viewport: { width: 390, height: 844 }, deviceScaleFactor: 2, isMobile: true, hasTouch: true });
    const P = await ctx.newPage();
    const errors = [];
    P.on("pageerror", (e) => errors.push(e.message));
    await P.goto(w.base + "/app");
    await P.click("#tab-login");
    await P.waitForSelector("#sso-ms:not([hidden])");
    check(await P.isVisible("#sso-ms") && await P.isVisible("#sso-google"), "the sign-in page shows 'Sign in with Microsoft' and 'Sign in with Google'");
    await P.screenshot({ path: path.join(OUT, "sso-1-buttons-phone.png") });
    identity = MS("pat@harbor.test");
    await P.click("#sso-ms");
    await P.waitForSelector("#home:not([hidden])", { timeout: 15000 });
    check(/Harbor Retail Group/.test(await P.textContent("#who-name")) && P.url().endsWith("#/") && !(await P.evaluate(() => location.hash.includes("sso/"))), "clicking it signs in and lands in the app (the one-time code is cleared from the address bar)");
    check(errors.length === 0, "no page errors", errors.join(" | "));
    await ctx.close();
  } finally {
    await browser.close();
    await w.stop();
    idp.close();
    if (failures()) console.log(w.log.join("").slice(-3000));
    fs.rmSync(stateDir, { recursive: true, force: true });
  }
  console.log(failures() ? `\n${failures()} check(s) failed` : "\nAll single sign-on checks passed");
  process.exit(failures() ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
