/**
 * Phone alerts and the self-updating owner dashboard, with the real Worker (wrangler dev) and a stand-in ntfy server
 * on this machine that records exactly what the Worker sends (the real ntfy.sh isn't contacted by this test):
 *   - "Turn on phone alerts" makes a private random topic; "Send test alert" posts to it and reports ntfy's answer;
 *   - a customer's "Ask for a reset link" sends one alert with the company and email, and the dashboard as tap action;
 *     asking again, or with an unknown email, sends nothing, and the customer sees the same answer either way;
 *   - alerts off: nothing is sent; ntfy failing: the dashboard says so;
 *   - the dashboard updates without reloading the page: pull down, Refresh, every 30 seconds, and coming back to it —
 *     and an update keeps a typed amount and an open reset link.
 */
const { spawn, spawnSync } = require("child_process");
const fs = require("fs"), os = require("os"), path = require("path"), http = require("http");
const { chromium } = require("playwright");

const PORT = 8814, NTFY = 8899, BASE = `http://localhost:${PORT}`;
const APP = path.join(__dirname, ".."), OUT = path.join(__dirname, "output");
const WRANGLER = path.join(APP, "..", "chief-of-staff", "node_modules", ".bin", "wrangler");
let failures = 0;
const check = (ok, name, extra = "") => { console.log(`${ok ? "PASS" : "FAIL"}  ${name}${extra ? "  — " + extra : ""}`); if (!ok) failures++; };
const PHONE = { viewport: { width: 390, height: 844 }, deviceScaleFactor: 2, isMobile: true, hasTouch: true };
const sleep = (ms) => new Promise((ok) => setTimeout(ok, ms));
const req = async (p, { method = "GET", body, token } = {}) => {
  const r = await fetch(BASE + p, { method, headers: { ...(body ? { "content-type": "application/json" } : {}), ...(token ? { Authorization: `Bearer ${token}` } : {}) }, body: body ? JSON.stringify(body) : undefined });
  return { status: r.status, data: r.status === 204 ? {} : await r.json().catch(() => ({})) };
};

// Stand-in ntfy: records each POST; can be told to fail.
const sent = [];
let ntfyFails = false;
const ntfy = http.createServer((rq, rs) => {
  let body = "";
  rq.on("data", (d) => (body += d));
  rq.on("end", () => {
    if (ntfyFails) { rs.writeHead(429); return rs.end('{"error":"limit"}'); }
    try { sent.push({ path: rq.url, type: rq.headers["content-type"], body: JSON.parse(body) }); } catch { sent.push({ raw: body }); }
    rs.writeHead(200, { "content-type": "application/json" }); rs.end('{"id":"test"}');
  });
});
const waitFor = async (fn, ms = 5000) => { for (let t = 0; t < ms; t += 100) { if (fn()) return true; await sleep(100); } return false; };

function startWorker(stateDir) {
  const log = [];
  const child = spawn(WRANGLER, ["dev", "--port", String(PORT), "--persist-to", stateDir, "--show-interactive-dev-session=false", "--log-level", "warn", "--var", `NTFY_URL:http://localhost:${NTFY}/`], {
    cwd: APP, env: { ...process.env, WRANGLER_SEND_METRICS: "false", CLOUDFLARE_API_TOKEN: "placeholder-not-used-locally" }, stdio: ["ignore", "pipe", "pipe"],
  });
  child.stdout.on("data", (d) => log.push(String(d)));
  child.stderr.on("data", (d) => log.push(String(d)));
  const ready = (async () => {
    for (let i = 0; i < 120; i++) { try { if ((await fetch(`${BASE}/api/owner/state`)).status) return; } catch { /* not yet */ } await sleep(500); }
    throw new Error(`wrangler dev didn't start:\n${log.join("")}`);
  })();
  return { ready, log, stop: () => new Promise((ok) => { child.once("exit", ok); child.kill("SIGTERM"); setTimeout(() => { child.kill("SIGKILL"); ok(); }, 5000); }) };
}

/** A real finger pull-down at the top of the page (touch events through Chrome's DevTools protocol). */
async function pullDown(page) {
  const cdp = await page.context().newCDPSession(page);
  const at = (y) => [{ x: 195, y, radiusX: 5, radiusY: 5, force: 1, id: 1 }];
  await cdp.send("Input.dispatchTouchEvent", { type: "touchStart", touchPoints: at(120) });
  for (let y = 140; y <= 300; y += 20) { await cdp.send("Input.dispatchTouchEvent", { type: "touchMove", touchPoints: at(y) }); await sleep(16); }
  const label = await page.textContent("#o-ptr");
  await cdp.send("Input.dispatchTouchEvent", { type: "touchEnd", touchPoints: [] });
  return label;
}

(async () => {
  fs.mkdirSync(OUT, { recursive: true });
  check(spawnSync(process.execPath, [path.join(APP, "scripts", "build-worker.cjs")], { cwd: APP }).status === 0, "the app packs into the Worker");
  await new Promise((ok) => ntfy.listen(NTFY, ok));
  const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), "forecast-alerts-"));
  const w = startWorker(stateDir);
  const browser = await chromium.launch();
  const errors = [];
  try {
    await w.ready;
    const owner = (await req("/api/owner/claim", { method: "POST", body: { passcode: "owner-pass-123" } })).data.token;
    const signup = async (company, email) => (await req("/api/signup", { method: "POST", body: { company, email, password: "password-123" } })).data;
    await signup("Sunny Farm & Café", "maria@sunnyfarm.test");
    await signup("Bay Market", "boss@baymarket.test");

    // Before alerts are on: asking sends nothing.
    await req("/api/reset-request", { method: "POST", body: { email: "boss@baymarket.test" } });
    await sleep(800);
    check(sent.length === 0, "with phone alerts off, nothing is sent");

    // ── Owner turns alerts on and sends a test ───────────────────────────────────────────────────────────────
    const ctx = await browser.newContext({ ...PHONE }); const O = await ctx.newPage();
    O.on("pageerror", (e) => errors.push(e.message));
    O.on("console", (m) => { if (m.type() === "error") errors.push("console: " + m.text()); });
    await O.goto(BASE + "/owner");
    await O.evaluate((t) => sessionStorage.setItem("forecast.owner", t), owner);
    await O.reload();
    await O.waitForSelector("#o-dash:not([hidden]) .cust");
    await O.click("#al-make");
    await O.waitForSelector("#al-on:not([hidden])");
    const topic = await O.textContent("#al-topic");
    check(/^forecast-[a-z2-9]{20}$/.test(topic), "'Turn on phone alerts' makes a private random topic name", topic.slice(0, 13) + "…");
    await O.click("#al-test");
    await O.waitForFunction(() => /Sent/.test(document.querySelector("#al-result").textContent));
    const test = sent.at(-1)?.body;
    check(test && test.topic === topic && test.title === "Test alert" && test.click === `${BASE}/owner` && sent.at(-1).type === "application/json",
      "'Send test alert' posts to that topic with the dashboard as the tap action, and says ntfy accepted it", await O.textContent("#al-result"));
    await O.locator("#alerts").screenshot({ path: path.join(OUT, "alerts-1-card-phone.png") });

    // ── A customer asks for a reset link → one alert with company + email ─────────────────────────────────
    const before = sent.length;
    const t0 = Date.now();
    const real = await req("/api/reset-request", { method: "POST", body: { email: "maria@sunnyfarm.test" } });
    const tReal = Date.now() - t0;
    check(await waitFor(() => sent.length === before + 1), "the customer's 'Ask for a reset link' sends an alert straight away");
    const a = sent.at(-1).body;
    check(a.topic === topic && a.title === "Password reset requested" && a.message.includes("Sunny Farm & Café") && a.message.includes("maria@sunnyfarm.test"),
      "the alert shows the company name (accents and & intact) and email", a.message.split("\n")[0]);
    check(a.click === `${BASE}/owner` && a.actions?.[0]?.url === `${BASE}/owner` && a.message.includes(`${BASE}/owner`) && a.priority === 4,
      "tapping it opens the owner dashboard (tap action, 'Open dashboard' button, and the link in the text)");
    const t1 = Date.now();
    const fake = await req("/api/reset-request", { method: "POST", body: { email: "nobody@nowhere.test" } });
    const tFake = Date.now() - t1;
    await req("/api/reset-request", { method: "POST", body: { email: "maria@sunnyfarm.test" } }); // asks again
    await sleep(800);
    check(sent.length === before + 1, "asking again, or with an email that has no account, sends no more alerts");
    check(JSON.stringify(real.data) === JSON.stringify(fake.data) && real.status === fake.status, "the customer sees the same answer either way", `${tReal} ms vs ${tFake} ms`);

    // ── The dashboard updates by itself: pull down, Refresh, 30 seconds, coming back ──────────────────────────
    const farm = () => O.locator(".cust", { hasText: "Sunny Farm" });
    // (The page was loaded before Maria asked.) Typed amount + an open reset link must survive the update.
    await farm().locator(".pay-amount").fill("25");
    O.once("dialog", (d) => d.accept());
    await farm().locator(".reset-link").click();
    await farm().locator(".reset-url").waitFor();
    const link = await farm().locator(".reset-url").inputValue();
    const reloads = [];
    O.on("framenavigated", (f) => { if (f === O.mainFrame()) reloads.push(f.url()); });
    check(!/Asked for a password reset/.test(await farm().textContent()), "before updating, the dashboard doesn't know Maria asked yet");
    await O.evaluate(() => window.scrollTo(0, 0)); // pull-down works from the top of the page, as on a phone
    await sleep(200);
    const label = await pullDown(O);
    check(/Release to refresh/.test(label), "pulling down at the top shows 'Release to refresh'", label);
    await O.waitForFunction(() => /Asked for a password reset/.test([...document.querySelectorAll(".cust")].find((c) => /Sunny Farm/.test(c.textContent)).textContent), null, { timeout: 5000 });
    check(reloads.length === 0, "letting go updates the dashboard — Maria's red label appears — without reloading the page");
    check(await farm().locator(".pay-amount").inputValue() === "25" && await farm().locator(".reset-url").inputValue() === link, "the update keeps the typed amount and the open reset link");
    await O.screenshot({ path: path.join(OUT, "alerts-2-label-phone.png") });

    // Maria uses the link in another browser → the label clears on the dashboard by itself within 30 seconds.
    await O.locator("#o-customers").click({ position: { x: 5, y: 5 } }); // nothing focused (an update waits while you type)
    await O.evaluate(() => document.activeElement?.blur());
    const r = await req("/api/reset", { method: "POST", body: { token: link.split("/").pop(), password: "new-password-1" } });
    check(r.status === 200, "Maria sets a new password from the link");
    const tClear = Date.now();
    await O.waitForFunction(() => !/Asked for a password reset/.test([...document.querySelectorAll(".cust")].find((c) => /Sunny Farm/.test(c.textContent)).textContent), null, { timeout: 35000 });
    check(reloads.length === 0, "the red label clears on its own (every-30-seconds update), no reload, no tap", `${((Date.now() - tClear) / 1000).toFixed(0)} s`);

    // Refresh button.
    await signup("Corner Shop", "corner@shop.test");
    await O.click("#o-refresh");
    await O.waitForSelector(".cust:has-text('Corner Shop')", { timeout: 5000 });
    check(/3\s*Customers/.test(await O.textContent("#o-tiles")), "the Refresh button updates it too");
    // Coming back to the page (e.g. after switching apps).
    await req("/api/reset-request", { method: "POST", body: { email: "corner@shop.test" } });
    await O.evaluate(() => { Object.defineProperty(document, "visibilityState", { value: "visible", configurable: true }); document.dispatchEvent(new Event("visibilitychange")); });
    await O.waitForFunction(() => /Asked for a password reset/.test([...document.querySelectorAll(".cust")].find((c) => /Corner Shop/.test(c.textContent)).textContent), null, { timeout: 5000 });
    check(true, "coming back to the dashboard updates it straight away");
    check(await waitFor(() => sent.at(-1)?.body?.message?.includes("corner@shop.test")), "…and Corner Shop's request pinged the phone too");

    // ntfy failing / alerts off.
    ntfyFails = true;
    await O.click("#al-test");
    await O.waitForFunction(() => /didn't accept/.test(document.querySelector("#al-result").textContent));
    check(/429/.test(await O.textContent("#al-result")), "if ntfy refuses, the dashboard says so (with ntfy's answer)", await O.textContent("#al-result"));
    ntfyFails = false;
    O.once("dialog", (d) => d.accept());
    await O.click("#al-stop");
    await O.waitForSelector("#al-off:not([hidden])");
    const n = sent.length;
    await signup("Late Shop", "late@shop.test");
    await req("/api/reset-request", { method: "POST", body: { email: "late@shop.test" } });
    await sleep(800);
    check(sent.length === n, "'Turn alerts off': no more alerts");
    check((await req("/api/owner/alerts", { token: (await signup("Sneaky", "sneaky@x.test")).token })).status === 401, "a customer can't read or change the alert settings");

    check(errors.length === 0, "no page errors", errors.join(" | "));
    await ctx.close();
  } finally {
    await browser.close();
    await w.stop();
    ntfy.close();
    if (failures) console.log(w.log.join("").slice(-3000));
    fs.rmSync(stateDir, { recursive: true, force: true });
  }
  console.log(failures ? `\n${failures} check(s) failed` : "\nAll alert and refresh checks passed");
  process.exit(failures ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
