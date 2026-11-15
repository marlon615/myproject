/**
 * Security building blocks and the reorder maths, against published reference values (no server needed):
 *   - TOTP two-factor codes: RFC 6238 test vectors;
 *   - AES-256-GCM: round trip, old plain text still readable, tampering detected;
 *   - passwords: PBKDF2 hashes check, wrong ones don't, old-format hashes still work;
 *   - NetSuite OAuth 1.0a HMAC-SHA256 signature: equal to the one the independent Python library oauthlib 3.x
 *     produced for the same inputs (value recorded below);
 *   - ID-token signature checks (RS256) with a real RSA key: good token passes, altered token fails;
 *   - reorder suggestions: worked example checked by hand.
 */
(async () => {
  const C = await import("../worker/crypto.js");
  const R = await import("../worker/reorder.js");
  const { checker } = require("./helpers.cjs");
  const { check, failures } = checker();
  const nodeCrypto = require("crypto");

  const sec = C.base32(new TextEncoder().encode("12345678901234567890"));
  check(sec === "GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ", "base32 of the RFC 6238 test secret");
  check(await C.totpAt(sec, 1) === "287082" && await C.totpAt(sec, Math.floor(1111111109 / 30)) === "081804" && await C.totpAt(sec, Math.floor(1234567890 / 30)) === "005924" && await C.totpAt(sec, Math.floor(20000000000 / 30)) === "353130",
    "TOTP codes match the RFC 6238 test vectors (4 times)");
  check(await C.checkTotp(sec, "287082", 59000) === 1 && await C.checkTotp(sec, "287082", 59000 + 30000) === 1 && await C.checkTotp(sec, "287082", 59000 + 90000) === null && await C.checkTotp(sec, "12345", 59000) === null,
    "a code is accepted for its 30 seconds ±1 step, not later; malformed codes refused");
  check(/^otpauth:\/\/totp\/Forecasting%20Agent:a%40b\.c\?secret=[A-Z2-7]+&issuer=Forecasting%20Agent/.test(C.totpUri(C.newTotpSecret(), "a@b.c")), "authenticator-app link format");

  const key = C.b64(nodeCrypto.randomBytes(32));
  const e1 = await C.encrypt(key, "Mango Juice 4250.00"), e2 = await C.encrypt(key, "Mango Juice 4250.00");
  check(e1.startsWith("v1:") && !e1.includes("Mango") && e1 !== e2 && await C.decrypt(key, e1) === "Mango Juice 4250.00", "AES-256-GCM: encrypted text hides the data, differs every time (random IV), and decrypts");
  check(await C.decrypt(key, "old plain text") === "old plain text", "data stored before encryption still reads");
  let tamper = false; try { await C.decrypt(key, e1.slice(0, -6) + "AAAAAA"); } catch { tamper = true; }
  let wrongKey = false; try { await C.decrypt(C.b64(nodeCrypto.randomBytes(32)), e1); } catch { wrongKey = true; }
  check(tamper && wrongKey, "tampered data and the wrong key are both rejected");

  const h = await C.hashPassword("correct horse 1", 1000);
  check(/^pbkdf2\$1000\$[0-9a-f]{32}\$[0-9a-f]{64}$/.test(h) && await C.checkPassword("correct horse 1", h) && !(await C.checkPassword("correct horse 2", h)), "password hashes: salted PBKDF2-SHA256, right one passes, wrong one fails");
  const legacySalt = "a".repeat(32), legacy = nodeCrypto.pbkdf2Sync("old-password-1", legacySalt, 5000, 32, "sha256").toString("hex");
  check(await C.checkPassword("old-password-1", legacy, legacySalt) && C.passwordRounds(legacy) === 5000 && C.passwordRounds(h) === 1000, "passwords saved in the old format still work (and get upgraded at sign-in)");

  const mine = await C.oauth1Header({ method: "POST", url: "https://1234567-sb1.suitetalk.api.netsuite.com/services/rest/query/v1/suiteql?limit=1000&offset=0", realm: "1234567_SB1", consumerKey: "ck", consumerSecret: "cs", token: "tk", tokenSecret: "ts", nonce: "abc123", timestamp: 1700000000 });
  check(/oauth_signature="Rbf0FPcRDz1XflpQ9cdsIMX%2FjVSIL0TZ9yD0Zzu60ss%3D"/.test(mine) && /^OAuth realm="1234567_SB1",/.test(mine), "NetSuite OAuth 1.0a HMAC-SHA256 signature equals oauthlib's for the same inputs");

  const { publicKey, privateKey } = nodeCrypto.generateKeyPairSync("rsa", { modulusLength: 2048 });
  const jwk = { ...publicKey.export({ format: "jwk" }), kid: "k1", alg: "RS256", use: "sig" };
  const b64u = (o) => Buffer.from(JSON.stringify(o)).toString("base64url");
  const make = (claims) => { const head = b64u({ alg: "RS256", kid: "k1", typ: "JWT" }), body = b64u(claims); return `${head}.${body}.${nodeCrypto.sign("sha256", Buffer.from(`${head}.${body}`), privateKey).toString("base64url")}`; };
  const good = make({ sub: "1", aud: "app", nonce: "n" });
  check((await C.verifyJwt(good, { keys: [jwk] })).sub === "1", "an ID token signed with the provider's key passes");
  const [hh, , ss] = good.split(".");
  let forged = false; try { await C.verifyJwt(`${hh}.${b64u({ sub: "2", aud: "app", nonce: "n" })}.${ss}`, { keys: [jwk] }); } catch { forged = true; }
  let unknownKey = false; try { await C.verifyJwt(good, { keys: [{ ...jwk, kid: "other" }] }); } catch { unknownKey = true; }
  check(forged && unknownKey, "a token with changed claims, or signed by an unknown key, is rejected");

  // Reorder: 300 units over Nov–Jan (30+31+31 = 92 days) → 3.261/day; lead 14 days; 95% service (z 1.6449);
  // backtest error 20 units/month → safety = 1.6449 × 20 × √(14/30.4) = 22.33 → 23; reorder point = 3.261×14 + 22.33 = 67.98 → 68.
  // On hand 40 + on order 10 = 50 ≤ 67.98 → order up to 67.98 + 3.261×14 = 113.6 → 63.6 → case pack 12 → 72.
  const s = R.suggest({ product: "Mango Juice", location: "Store 1", onHand: 40, onOrder: 10, leadDays: 14, casePack: 12, unitCost: 2.5 }, { forecast: [100, 100, 100], months: ["2026-11", "2026-12", "2027-01"], rmse: 20 }, { serviceLevel: 0.95, reviewDays: 14, leadDays: 14 });
  check(s.status === "low" && s.dailyDemand === 3.3 && s.reorderPoint === 68 && s.safetyStock === 23 && s.suggestedQty === 72 && s.orderValue === 180 && s.daysOfCover === 12, "reorder maths matches the worked example", JSON.stringify(s));
  const plenty = R.suggest({ product: "X", onHand: 500 }, { forecast: [100, 100, 100], months: ["2026-11", "2026-12", "2027-01"], rmse: 20 });
  const out = R.suggest({ product: "Y", onHand: 0, minOrder: 50 }, { forecast: [30, 30, 30], months: ["2026-11", "2026-12", "2027-01"], rmse: null });
  check(plenty.status === "ok" && plenty.suggestedQty === 0 && out.status === "out" && out.suggestedQty >= 50, "plenty of stock → no order; out of stock → at least the minimum order");
  check(R.suggest({ product: "Z", onHand: 5 }, null).status === "nodata", "no sales history → no suggestion, says why");

  console.log(failures() ? `\n${failures()} check(s) failed` : "\nAll security and reorder checks passed");
  process.exit(failures() ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
