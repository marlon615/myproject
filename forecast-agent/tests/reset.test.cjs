/**
 * Password reset for customers, with the real Worker (wrangler dev) and a real browser at phone size:
 *   - the recovery code from signup resets a forgotten password (self-service); it then stops working and a new one
 *     is shown; the old password and every old session stop working; the data is still there;
 *   - wrong codes are limited (5 per 15 minutes) and get the same answer as an unknown email;
 *   - "Ask for a reset link": same answer for any email; the owner sees who asked, makes a one-time 24-hour link,
 *     the customer opens it and chooses a new password; the link can't be used twice; made-up links fail;
 *   - signed in: change password (current one needed; other devices signed out), make a new recovery code;
 *   - a switched-off account can't get back in through a reset.
 * Nothing here touches the live site.
 */
const { spawn, spawnSync } = require("child_process");
const fs = require("fs"), os = require("os"), path = require("path");
const { chromium } = require("playwright");

const PORT = 8812, BASE = `http://localhost:${PORT}`;
const APP = path.join(__dirname, ".."), OUT = path.join(__dirname, "output");
const WRANGLER = path.join(APP, "..", "chief-of-staff", "node_modules", ".bin", "wrangler");
let failures = 0;
const check = (ok, name, extra = "") => { console.log(`${ok ? "PASS" : "FAIL"}  ${name}${extra ? "  — " + extra : ""}`); if (!ok) failures++; };
const PHONE = { viewport: { width: 390, height: 844 }, deviceScaleFactor: 2, isMobile: true, hasTouch: true };
const req = async (p, { method = "GET", body, token } = {}) => {
  const r = await fetch(BASE + p, { method, headers: { ...(body ? { "content-type": "application/json" } : {}), ...(token ? { Authorization: `Bearer ${token}` } : {}) }, body: body ? JSON.stringify(body) : undefined });
  return { status: r.status, data: r.status === 204 ? {} : await r.json().catch(() => ({})) };
};
const login = (email, password) => req("/api/login", { method: "POST", body: { email, password } });

function startWorker(stateDir) {
  const log = [];
  const child = spawn(WRANGLER, ["dev", "--port", String(PORT), "--persist-to", stateDir, "--show-interactive-dev-session=false", "--log-level", "warn"], {
    cwd: APP, env: { ...process.env, WRANGLER_SEND_METRICS: "false", CLOUDFLARE_API_TOKEN: "placeholder-not-used-locally" }, stdio: ["ignore", "pipe", "pipe"],
  });
  child.stdout.on("data", (d) => log.push(String(d)));
  child.stderr.on("data", (d) => log.push(String(d)));
  const ready = (async () => {
    for (let i = 0; i < 120; i++) { try { if ((await fetch(`${BASE}/api/owner/state`)).status) return; } catch { /* not yet */ } await new Promise((ok) => setTimeout(ok, 500)); }
    throw new Error(`wrangler dev didn't start:\n${log.join("")}`);
  })();
  return { ready, log, stop: () => new Promise((ok) => { child.once("exit", ok); child.kill("SIGTERM"); setTimeout(() => { child.kill("SIGKILL"); ok(); }, 5000); }) };
}

(async () => {
  fs.mkdirSync(OUT, { recursive: true });
  check(spawnSync(process.execPath, [path.join(APP, "scripts", "build-worker.cjs")], { cwd: APP }).status === 0, "the app packs into the Worker");
  const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), "forecast-reset-"));
  const w = startWorker(stateDir);
  const browser = await chromium.launch();
  const errors = [];
  const watch = (page, who) => {
    page.on("pageerror", (e) => errors.push(`${who}: ${e.message}`));
    page.on("console", (m) => { if (m.type() === "error" && !/status of (400|401|402|403|409|410|429)/.test(m.text())) errors.push(`${who} console: ${m.text()}`); });
  };
  const EMAIL = "maria@sunnyfarm.test";
  try {
    await w.ready;
    const owner = (await req("/api/owner/claim", { method: "POST", body: { passcode: "owner-pass-123" } })).data.token;

    // ── Sign up in the browser: the recovery code is shown once ──────────────────────────────────────────────
    const ctx = await browser.newContext({ ...PHONE, acceptDownloads: true }); const P = await ctx.newPage(); watch(P, "customer");
    await P.goto(BASE + "/app");
    await P.fill("#company", "Sunny Farm"); await P.fill("#email", EMAIL); await P.fill("#password", "first-password-1");
    await P.click("#auth-submit");
    await P.waitForSelector("#code:not([hidden])");
    const code1 = await P.textContent("#code-value");
    check(/^[A-Z2-9]{5}(-[A-Z2-9]{5}){3}$/.test(code1), "signup shows a recovery code", code1.replace(/[A-Z2-9]{5}$/, "•••••"));
    const [dl] = await Promise.all([P.waitForEvent("download"), P.click("#code-save")]);
    check(fs.readFileSync(await dl.path(), "utf8").includes(code1), "the code can be downloaded as a file");
    await P.screenshot({ path: path.join(OUT, "reset-1-code-phone.png") });
    check(await P.isDisabled("#code-continue"), "Continue waits until 'I've saved my recovery code' is ticked");
    await P.check("#code-ok"); await P.click("#code-continue");
    await P.waitForSelector("#home:not([hidden])");
    const oldToken = await P.evaluate(() => localStorage.getItem("forecast.token"));
    // Some data, to show a reset keeps it.
    const months = Array.from({ length: 12 }, (_, i) => `2025-${String(i + 1).padStart(2, "0")}`);
    await req("/api/uploads", { method: "POST", token: oldToken, body: { name: "Farm sales", kind: "money", months, products: { Eggs: months.map((_, i) => 100 + i * 5) } } });
    const codeAgain = await req("/api/me", { token: oldToken });
    check(!JSON.stringify(codeAgain.data).includes(code1.replace(/-/g, "")) && !JSON.stringify(codeAgain.data).includes(code1), "the code is never sent again by the server");

    // ── Forgot password, with the recovery code (in the browser) ─────────────────────────────────────────────
    await P.click("#signout");
    await P.waitForSelector("#auth:not([hidden])");
    check(await P.isVisible("text=Forgot your password?"), "the sign-in form has 'Forgot your password?'");
    await P.click("text=Forgot your password?");
    await P.waitForSelector("#forgot:not([hidden])");
    await P.fill("#f-email", EMAIL); await P.fill("#f-code", "AAAAA-BBBBB-CCCCC-DDDDD"); await P.fill("#f-password", "second-password-2");
    await P.click("#f-submit");
    await P.waitForSelector("#f-error:not([hidden])");
    const wrongMsg = await P.textContent("#f-error");
    const unknownMsg = (await req("/api/recover", { method: "POST", body: { email: "nobody@nowhere.test", code: code1, password: "whatever-123" } })).data.error;
    check(/don't match/.test(wrongMsg) && wrongMsg === unknownMsg, "a wrong code gets the same answer as an unknown email", wrongMsg);
    // Lower case and no dashes still work (people retype codes).
    await P.fill("#f-code", code1.toLowerCase().replace(/-/g, " "));
    await P.click("#f-submit");
    await P.waitForSelector("#code:not([hidden])");
    const code2 = await P.textContent("#code-value");
    check(/new recovery code/.test(await P.textContent("#code-title")) && code2 !== code1, "the right code (typed in lower case, with spaces) resets it and shows a NEW recovery code");
    await P.check("#code-ok"); await P.click("#code-continue");
    await P.waitForSelector("#home:not([hidden])");
    check(/Farm sales/.test(await P.textContent("#uploads")), "signed straight in, and the data is still there");
    check((await login(EMAIL, "first-password-1")).status === 401 && (await login(EMAIL, "second-password-2")).status === 200, "the old password stops working; the new one works");
    check((await req("/api/me", { token: oldToken })).status === 401, "sessions from before the reset are signed out");
    check((await req("/api/recover", { method: "POST", body: { email: EMAIL, code: code1, password: "third-password-3" } })).status === 401, "the used recovery code can't be used again");

    // Guessing is limited.
    // Guessing is limited (on a second account, so the 15-minute wait doesn't get in the way of the checks below).
    const G = "guess@sunnyfarm.test";
    const gCode = (await req("/api/signup", { method: "POST", body: { company: "Guess Test", email: G, password: "guess-password-0" } })).data.recoveryCode;
    let last;
    for (let i = 0; i < 6; i++) last = await req("/api/recover", { method: "POST", body: { email: G, code: `ZZZZZ-ZZZZZ-ZZZZZ-ZZZ${i}Z`, password: "guess-password-1" } });
    check(last.status === 429, "6 wrong recovery codes in a row: told to wait");
    check((await req("/api/recover", { method: "POST", body: { email: G, code: gCode, password: "guess-password-1" } })).status === 429, "…even the right code waits until the 15 minutes pass");

    // ── No code: ask for a reset link; the owner makes one ───────────────────────────────────────────────────
    const askReal = await req("/api/reset-request", { method: "POST", body: { email: EMAIL } });
    const askFake = await req("/api/reset-request", { method: "POST", body: { email: "nobody@nowhere.test" } });
    check(askReal.status === 200 && askFake.status === 200 && JSON.stringify(askReal.data) === JSON.stringify(askFake.data), "'Ask for a reset link' answers the same for any email");
    const octx = await browser.newContext({ ...PHONE }); const O = await octx.newPage(); watch(O, "owner");
    await O.goto(BASE + "/owner");
    await O.evaluate((t) => sessionStorage.setItem("forecast.owner", t), owner);
    await O.reload();
    const card = O.locator(".cust", { hasText: "Sunny Farm" });
    await card.waitFor();
    check(/Asked for a password reset/.test(await card.textContent()), "the owner dashboard shows that Sunny Farm asked for a reset");
    O.once("dialog", (d) => d.accept());
    await card.locator(".reset-link").click();
    await card.locator(".reset-url").waitFor();
    const link = await card.locator(".reset-url").inputValue();
    check(new RegExp(`^${BASE}/#/reset/[0-9a-f]{64}$`).test(link), "one click makes a one-time reset link to send", link.replace(/[0-9a-f]{56}$/, "…"));
    await O.screenshot({ path: path.join(OUT, "reset-2-owner-link-phone.png"), fullPage: true });

    // The customer opens it (a fresh phone, signed out).
    const pctx = await browser.newContext({ ...PHONE }); const Q = await pctx.newPage(); watch(Q, "customer-2");
    await Q.goto(link);
    await Q.waitForSelector("#reset:not([hidden])");
    check(Q.url().endsWith("#/reset") && !/[0-9a-f]{64}/.test(Q.url()), "the link opens 'Choose a new password' and its secret leaves the address bar");
    await Q.fill("#r-password", "link-password-4"); await Q.fill("#r-password2", "link-password-x"); await Q.click("#r-submit");
    check(/don't match/.test(await Q.textContent("#r-error")), "the two new passwords must match");
    await Q.fill("#r-password2", "link-password-4"); await Q.click("#r-submit");
    await Q.waitForSelector("#code:not([hidden])");
    const code3 = await Q.textContent("#code-value");
    await Q.check("#code-ok"); await Q.click("#code-continue");
    await Q.waitForSelector("#home:not([hidden])");
    check(/Farm sales/.test(await Q.textContent("#uploads")), "new password set from the link: signed in, data intact, new recovery code shown");
    check((await login(EMAIL, "link-password-4")).status === 200 && (await login(EMAIL, "second-password-2")).status === 401, "the link's new password works; the previous one doesn't");
    const token = link.split("/").pop();
    check((await req("/api/reset", { method: "POST", body: { token, password: "again-password-5" } })).status === 410, "the same link can't be used twice");
    check((await req("/api/reset", { method: "POST", body: { token: "a".repeat(64), password: "again-password-5" } })).status === 410, "a made-up link doesn't work");
    await O.reload(); await card.waitFor();
    check(!/Asked for a password reset/.test(await card.textContent()) && !/A link is active/.test(await card.textContent()), "after the reset, the owner's 'asked' note and active link are cleared");
    check((await req("/api/recover", { method: "POST", body: { email: EMAIL, code: code2, password: "x-password-6" } })).status !== 200, "the recovery code from before the link reset no longer works");

    // ── Signed in: change password, new recovery code ────────────────────────────────────────────────────────
    const other = (await login(EMAIL, "link-password-4")).data.token; // another device
    await Q.click("#account-link");
    await Q.waitForSelector("#account:not([hidden])");
    await Q.fill("#pw-current", "not-my-password"); await Q.fill("#pw-new", "changed-password-7"); await Q.click("#pw-form button");
    await Q.waitForSelector("#pw-error:not([hidden])");
    check(/current password isn't right/.test(await Q.textContent("#pw-error")), "changing the password needs the current one");
    await Q.fill("#pw-current", "link-password-4"); await Q.click("#pw-form button");
    await Q.waitForSelector("#code:not([hidden])");
    await Q.check("#code-ok"); await Q.click("#code-continue");
    await Q.waitForSelector("#home:not([hidden])");
    const qToken = await Q.evaluate(() => localStorage.getItem("forecast.token"));
    check((await req("/api/me", { token: qToken })).status === 200 && (await req("/api/me", { token: other })).status === 401, "password changed: this device stays signed in, other devices are signed out");
    check((await login(EMAIL, "changed-password-7")).status === 200, "the changed password works");
    await Q.click("#account-link");
    await Q.fill("#rc-password", "changed-password-7"); await Q.click("#rc-form button");
    await Q.waitForSelector("#code:not([hidden])");
    const code5 = await Q.textContent("#code-value");
    await Q.check("#code-ok"); await Q.click("#code-continue");
    check(/^[A-Z2-9]{5}(-[A-Z2-9]{5}){3}$/.test(code5) && code5 !== code3, "'Make a new recovery code' gives a new code");
    check((await req("/api/recover", { method: "POST", body: { email: EMAIL, code: code3, password: "x-password-8" } })).status === 401, "…and the previous code stops working");

    // ── A switched-off account can't come back through a reset ───────────────────────────────────────────────
    const id = (await req("/api/owner/customers", { token: owner })).data.customers.find((c) => c.email === EMAIL).id;
    await req("/api/owner/switch", { method: "POST", token: owner, body: { id, account: false } });
    const offCode = await req("/api/recover", { method: "POST", body: { email: EMAIL, code: code5, password: "off-password-9" } });
    const offLink = (await req("/api/owner/reset-link", { method: "POST", token: owner, body: { id } })).data.token;
    const offViaLink = await req("/api/reset", { method: "POST", body: { token: offLink, password: "off-password-9" } });
    check(offCode.status === 403 && offViaLink.status === 403 && (await login(EMAIL, "off-password-9")).status !== 200, "switched off: neither the code nor a link lets them back in");
    check((await req("/api/owner/reset-link", { method: "POST", token: oldToken, body: { id } })).status === 401, "only the owner can make reset links");

    check(errors.length === 0, "no page errors", errors.join(" | "));
    for (const c of [ctx, octx, pctx]) await c.close();
  } finally {
    await browser.close();
    await w.stop();
    if (failures) console.log(w.log.join("").slice(-3000));
    fs.rmSync(stateDir, { recursive: true, force: true });
  }
  console.log(failures ? `\n${failures} check(s) failed` : "\nAll password-reset checks passed");
  process.exit(failures ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
