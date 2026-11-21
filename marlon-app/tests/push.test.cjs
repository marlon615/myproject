/**
 * Alerts when Marlon is closed (web push), with the real Worker, a stand-in push service on this machine, and Chromium:
 *   - the encryption (RFC 8291) is decrypted here by an independent implementation (Node's crypto), and the server's
 *     VAPID signature (RFC 8292) is checked against its public key;
 *   - a seller phone turns alerts on with one tap; when the buyer signs, the push goes to that phone only, encrypted;
 *   - the app's offline worker shows "Invoice 0001 signed · Signed by … on …" for a push, even with no page open;
 *   - the server only calls real push services, forgets subscriptions the push service says are gone, refuses other
 *     phones, and keeps subscriptions encrypted.
 */
const { spawn, spawnSync } = require("child_process");
const fs = require("fs"), os = require("os"), path = require("path"), crypto = require("crypto"), http = require("http");
const { chromium } = require("playwright");
const { setUp } = require("./fixture.cjs");

const PORT = 8807, PUSH = 8808, BASE = `http://localhost:${PORT}`, PUSHBASE = `http://localhost:${PUSH}`;
const APP = path.join(__dirname, ".."), OUT = path.join(__dirname, "output");
const WRANGLER = path.join(APP, "..", "chief-of-staff", "node_modules", ".bin", "wrangler");
const KEY = crypto.randomBytes(32).toString("base64");
let failures = 0;
const check = (ok, name, extra = "") => { console.log(`${ok ? "PASS" : "FAIL"}  ${name}${extra ? "  — " + extra : ""}`); if (!ok) failures++; };
const post = async (p, body) => { const r = await fetch(BASE + p, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) }); return { status: r.status, data: await r.json().catch(() => ({})) }; };
const sleep = (ms) => new Promise((ok) => setTimeout(ok, ms));
const PNG = "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==";

/** A "browser" push subscription: its own key pair and auth secret, so this test can decrypt what it receives. */
function browserKeys() { const ecdh = crypto.createECDH("prime256v1"); ecdh.generateKeys(); const auth = crypto.randomBytes(16); return { ecdh, auth, keys: { p256dh: ecdh.getPublicKey().toString("base64url"), auth: auth.toString("base64url") } }; }
/** RFC 8291 decryption, written separately from the Worker's code (Node crypto, not Web Crypto). */
function decrypt(body, { ecdh, auth }) {
  const salt = body.subarray(0, 16), rs = body.readUInt32BE(16), idlen = body[20], asPublic = body.subarray(21, 21 + idlen), ct = body.subarray(21 + idlen);
  const h = (k, d) => crypto.createHmac("sha256", k).update(d).digest();
  const ecdhSecret = ecdh.computeSecret(asPublic);
  const ikm = h(h(auth, ecdhSecret), Buffer.concat([Buffer.from("WebPush: info\0"), ecdh.getPublicKey(), asPublic, Buffer.from([1])]));
  const prk = h(salt, ikm);
  const cek = h(prk, Buffer.from("Content-Encoding: aes128gcm\0\x01")).subarray(0, 16), nonce = h(prk, Buffer.from("Content-Encoding: nonce\0\x01")).subarray(0, 12);
  const d = crypto.createDecipheriv("aes-128-gcm", cek, nonce); d.setAuthTag(ct.subarray(ct.length - 16));
  const plain = Buffer.concat([d.update(ct.subarray(0, ct.length - 16)), d.final()]);
  if (plain[plain.length - 1] !== 2 || rs !== 4096) throw new Error("bad record");
  return JSON.parse(plain.subarray(0, plain.length - 1).toString());
}
function verifyVapid(auth, serverKey) {
  const m = /^vapid t=([^,]+), k=(.+)$/.exec(auth || "");
  if (!m || m[2] !== serverKey) return null;
  const [hd, cl, sg] = m[1].split("."), pub = Buffer.from(serverKey, "base64url");
  const key = crypto.createPublicKey({ key: { kty: "EC", crv: "P-256", x: pub.subarray(1, 33).toString("base64url"), y: pub.subarray(33).toString("base64url") }, format: "jwk" });
  return crypto.verify("sha256", Buffer.from(`${hd}.${cl}`), { key, dsaEncoding: "ieee-p1363" }, Buffer.from(sg, "base64url")) ? JSON.parse(Buffer.from(cl, "base64url")) : null;
}
function startWorker(stateDir) {
  const log = [];
  const child = spawn(WRANGLER, ["dev", "--port", String(PORT), "--persist-to", stateDir, "--show-interactive-dev-session=false", "--log-level", "warn", "--var", `ENCRYPTION_KEY:${KEY}`, "--var", "ALLOW_TEST_CLOCK:1"],
    { cwd: APP, env: { ...process.env, WRANGLER_SEND_METRICS: "false", CLOUDFLARE_API_TOKEN: "placeholder-not-used-locally" }, stdio: ["ignore", "pipe", "pipe"] });
  child.stdout.on("data", (d) => log.push(String(d))); child.stderr.on("data", (d) => log.push(String(d)));
  const ready = (async () => { for (let i = 0; i < 120; i++) { try { if ((await fetch(`${BASE}/api/console/state`)).status) return; } catch { /* not yet */ } await sleep(500); } throw new Error(log.join("")); })();
  return { ready, stop: () => new Promise((ok) => { child.once("exit", ok); child.kill("SIGTERM"); setTimeout(() => { child.kill("SIGKILL"); ok(); }, 5000); }) };
}

(async () => {
  fs.mkdirSync(OUT, { recursive: true });
  // ── The crypto on its own ────────────────────────────────────────────────────────────────────────────
  const W = await import("../worker/webpush.js");
  const bk = browserKeys(), text = JSON.stringify({ hello: "Jada Brown ✓" });
  check(JSON.stringify(decrypt(Buffer.from(await W.encryptPayload(bk.keys, text)), bk)) === text, "the message encryption (RFC 8291) is decrypted correctly by a separate implementation");
  const vk = await W.newVapidKeys();
  const claims = verifyVapid(await W.vapidHeader("https://fcm.googleapis.com/fcm/send/x", vk, "https://marlon.example"), vk.publicKey);
  check(claims && claims.aud === "https://fcm.googleapis.com" && claims.sub === "https://marlon.example" && claims.exp > Date.now() / 1000 && claims.exp <= Date.now() / 1000 + 86400, "the VAPID token (RFC 8292) is signed with the server's key, for the push service's origin, valid under 24 hours");
  check(["https://fcm.googleapis.com/fcm/send/a", "https://web.push.apple.com/b", "https://updates.push.services.mozilla.com/c", "https://wns2-par02p.notify.windows.com/d"].every((u) => W.pushEndpointOk(u))
    && !["https://evil.example.com/x", "http://fcm.googleapis.com/x", "https://fcm.googleapis.com:444/x", "file:///etc/passwd", "http://localhost:1/x"].some((u) => W.pushEndpointOk(u)), "only real push services are accepted (Google, Apple, Mozilla, Microsoft over HTTPS), nothing else");

  // ── Stand-in push service ────────────────────────────────────────────────────────────────────────────
  const got = [];
  const pushSrv = http.createServer((rq, rs) => { const c = []; rq.on("data", (d) => c.push(d)); rq.on("end", () => { got.push({ path: rq.url, headers: rq.headers, body: Buffer.concat(c) }); rs.writeHead(rq.url.includes("gone") ? 410 : 201); rs.end(); }); });
  await new Promise((ok) => pushSrv.listen(PUSH, ok));
  check(spawnSync(process.execPath, [path.join(APP, "scripts", "build-worker.cjs")], { cwd: APP }).status === 0, "the app packs into the Worker");
  const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), "marlon-push-"));
  const w = startWorker(stateDir);
  const browser = await chromium.launch();
  const errors = [];
  try {
    await w.ready;
    const maker = (await fetch(`${BASE}/api/console/claim`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ passcode: "maker-pass-123" }) }).then((r) => r.json())).token;
    const A = await fetch(`${BASE}/api/console/buyers`, { method: "POST", headers: { "content-type": "application/json", Authorization: `Bearer ${maker}` }, body: JSON.stringify({ name: "Sarah's Beauty", devices: 2, amount: 0 }) }).then((r) => r.json());
    const key = A.buyer.id, dev = "c".repeat(32);
    await post("/api/activate", { key, device: dev });
    const k1 = (await fetch(`${BASE}/api/push/key`).then((r) => r.json())).key, k2 = (await fetch(`${BASE}/api/push/key`).then((r) => r.json())).key;
    check(k1 && k1 === k2 && Buffer.from(k1, "base64url").length === 65, "the server makes its own push key once (no extra secret to set up) and keeps it", k1?.slice(0, 12));

    const one = browserKeys(), gone = browserKeys();
    check((await post("/api/push/subscribe", { key, device: dev, subscription: { endpoint: `${PUSHBASE}/push/one`, keys: one.keys } })).status === 200
      && (await post("/api/push/subscribe", { key, device: dev, subscription: { endpoint: `${PUSHBASE}/push/gone`, keys: gone.keys } })).status === 200, "a seller's phone can turn alerts on");
    check((await post("/api/push/subscribe", { key, device: dev, subscription: { endpoint: "https://evil.example.com/collect", keys: one.keys } })).status === 400
      && (await post("/api/push/subscribe", { key, device: dev, subscription: { endpoint: `${PUSHBASE}/push/x`, keys: {} } })).status === 400, "subscriptions to anything but a push service, or without keys, are refused");
    check((await post("/api/push/subscribe", { key, device: "d".repeat(32), subscription: { endpoint: `${PUSHBASE}/push/spy`, keys: one.keys } })).status === 403, "a phone that isn't the seller's can't sign up for their alerts");

    // The buyer signs → the push goes out.
    const inv = { id: "inv_push1", number: 1, date: "2026-11-19", seller: "Sarah's Beauty", store: "Jada Brown", items: [{ name: "Lip Gloss", qty: 3, unit: "each", price: 12.5 }] };
    const c = (await post("/api/sign/create", { key, device: dev, invoice: inv })).data;
    const v = (await post("/api/sign/view", { token: c.token })).data;
    const t0 = Date.now();
    const s = await post("/api/sign/submit", { token: c.token, name: "Jada Brown", signature: PNG, digest: v.digest });
    check(s.status === 200 && Date.now() - t0 < 3000, "the buyer's signing isn't held up by the alert", `${Date.now() - t0} ms`);
    for (let i = 0; i < 40 && got.length < 2; i++) await sleep(250);
    const p1 = got.find((g) => g.path === "/push/one"), pg = got.find((g) => g.path === "/push/gone");
    const cl = p1 && verifyVapid(p1.headers.authorization, k1);
    check(p1 && p1.headers["content-encoding"] === "aes128gcm" && Number(p1.headers.ttl) > 0 && p1.headers.urgency === "high" && cl && cl.aud === PUSHBASE && cl.sub === BASE, "the seller's phone gets a push: encrypted (aes128gcm), signed by the server (VAPID), marked urgent");
    const msg = p1 && decrypt(p1.body, one);
    check(msg && msg.type === "signed" && msg.invoiceId === "inv_push1" && msg.number === 1 && msg.signer === "Jada Brown" && !Number.isNaN(Date.parse(msg.signedAt)), "…and only that phone can read it: invoice No. 1, signed by Jada Brown, with the time", JSON.stringify(msg));
    check(!JSON.stringify(msg).includes("data:image"), "the push carries no signature picture (the app fetches the signed copy itself)");
    check(Boolean(pg), "the push service's 'gone' answer is received…");
    got.length = 0;
    const c2 = (await post("/api/sign/create", { key, device: dev, invoice: { ...inv, id: "inv_push2", number: 2 } })).data;
    const v2 = (await post("/api/sign/view", { token: c2.token })).data;
    await post("/api/sign/submit", { token: c2.token, name: "Kemar Lewis", signature: PNG, digest: v2.digest });
    for (let i = 0; i < 40 && !got.length; i++) await sleep(250); await sleep(500);
    check(got.length === 1 && got[0].path === "/push/one", "…and that subscription is forgotten: the next alert only goes to the phone that's still subscribed", got.map((g) => g.path).join(", "));

    // ── In Chromium: one tap turns alerts on; the app's offline worker shows the alert ─────────────────
    const ctx = await browser.newContext({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true, permissions: ["clipboard-read", "clipboard-write"] });
    const fake = browserKeys();
    // This test browser has no real push service, so its subscription points at the stand-in (the app code is unchanged).
    await ctx.addInitScript(({ endpoint, keys }) => {
      let sub = null;
      const make = () => ({ endpoint, options: {}, toJSON: () => ({ endpoint, keys }), unsubscribe: async () => { sub = null; return true; } });
      PushManager.prototype.subscribe = async function () { sub = make(); return sub; };
      PushManager.prototype.getSubscription = async function () { return sub; };
      Object.defineProperty(Notification, "permission", { get: () => window.__perm || "default", configurable: true });
      Notification.requestPermission = async () => { window.__perm = "granted"; return "granted"; };
    }, { endpoint: `${PUSHBASE}/push/browser`, keys: fake.keys });
    const P = await ctx.newPage(); P.on("pageerror", (e) => errors.push(e.message));
    await P.goto(A.link);
    await setUp(P, { name: "Sarah's Beauty", address: "", phone: "", products: [{ name: "Lip Gloss", price: "12.50", unit: "each" }] });
    await P.evaluate(() => navigator.serviceWorker.ready);
    await P.fill("#store", "Tanya Reid");
    const row = P.locator(".prod-row", { hasText: "Lip Gloss" }).first();
    await row.locator(".prod-check").click(); await row.locator(".qty-input").fill("2");
    await P.waitForTimeout(900);
    await P.locator("#send-sign-btn").scrollIntoViewIfNeeded(); await P.click("#send-sign-btn");
    await P.waitForSelector("#remote-status .btn-alert", { timeout: 8000 });
    check(true, "after sending, the seller is offered '🔔 Alert me when they sign'");
    await P.click("#remote-status .btn-alert");
    await P.waitForSelector("#remote-status .remote-push p", { timeout: 8000 });
    check(/even with Marlon closed/.test(await P.textContent("#remote-status .remote-push")), "one tap turns alerts on, and it says so");
    await P.screenshot({ path: path.join(OUT, "push-1-alerts-on.png") });
    const inv3 = await P.evaluate(async () => { const db = await import("/js/db.js"); return db.invoices.get(await db.settings.get("currentId")); });
    got.length = 0;
    const t3 = inv3.remote.link.split("/s/")[1];
    const v3 = (await post("/api/sign/view", { token: t3 })).data;
    await post("/api/sign/submit", { token: t3, name: "Tanya Reid", signature: PNG, digest: v3.digest });
    for (let i = 0; i < 40 && !got.some((g) => g.path === "/push/browser"); i++) await sleep(250);
    const pb = got.find((g) => g.path === "/push/browser");
    check(pb && decrypt(pb.body, fake).signer === "Tanya Reid", "when the buyer signs, the push goes to the subscription this phone made");

    // Deliver that push into the app's real offline worker (as the phone's push service would).
    await ctx.grantPermissions(["notifications"], { origin: BASE });
    const cdp = await ctx.newCDPSession(P);
    const regs = []; cdp.on("ServiceWorker.workerRegistrationUpdated", (e) => regs.push(...e.registrations));
    await cdp.send("ServiceWorker.enable"); await sleep(500);
    const reg = regs.find((r) => r.scopeURL.startsWith(BASE));
    // This headless browser doesn't keep notifications on screen, so the worker's own showNotification call is recorded.
    const sw = ctx.serviceWorkers().find((x) => x.url().startsWith(BASE)) || await ctx.waitForEvent("serviceworker");
    await sw.evaluate(() => { self.__shown = []; const show = self.registration.showNotification.bind(self.registration); self.registration.showNotification = (title, o) => { self.__shown.push({ title, body: o.body, tag: o.tag }); return show(title, o).catch(() => {}); }; });
    await cdp.send("ServiceWorker.deliverPushMessage", { origin: BASE, registrationId: reg.registrationId, data: JSON.stringify(decrypt(pb.body, fake)) });
    await sleep(800);
    const notes = await sw.evaluate(() => self.__shown);
    const note = notes.find((n) => n.tag === `signed-${inv3.id}`);
    check(note && note.title === `Invoice ${String(inv3.number).padStart(4, "0")} signed` && /^Signed by Tanya Reid on [A-Z][a-z]{2} \d{1,2}, \d{4}, \d{1,2}:\d{2} [AP]M$/.test(note.body), "the app's offline worker shows the alert: 'Invoice 000N signed · Signed by Tanya Reid on [date, time]'", JSON.stringify(note));
    await P.waitForSelector("#remote-status.is-signed", { timeout: 8000 });
    check(true, "with Marlon open, the push also makes it fetch the signed copy straight away");
    check(notes.filter((n) => n.tag === `signed-${inv3.id}`).length === 1, "the alert never shows twice for the same invoice (same tag as the app's own)");

    // ── Stored securely ──────────────────────────────────────────────────────────────────────────────────
    const files = []; const walk = (d) => { for (const e of fs.readdirSync(d, { withFileTypes: true })) { const p = path.join(d, e.name); if (e.isDirectory()) { if (e.name !== "observability") walk(p); } else files.push(fs.readFileSync(p)); } }; walk(stateDir);
    const leak = ["push/one", "push/browser", one.keys.p256dh.slice(0, 30), fake.keys.auth, vk.privateJwk.d].filter((x) => files.some((b) => b.includes(Buffer.from(x))));
    check(leak.length === 0, "push subscriptions and the server's private push key are stored encrypted", leak.join(", "));
    check(errors.length === 0, "no page errors", errors.join(" | "));
  } finally {
    await browser.close(); await w.stop(); pushSrv.close(); fs.rmSync(stateDir, { recursive: true, force: true });
  }
  if (failures) { console.log(`\n${failures} check(s) failed`); process.exit(1); }
  console.log("\nAll alert (web push) checks passed");
})().catch((e) => { console.error(e); process.exit(1); });
