/**
 * Personal links, end to end, with the real Worker (wrangler dev, local SQLite) and the real app at phone size:
 *   - the maker creates a buyer link in the console (name, devices 1/2/3/another number, amount — all required);
 *   - the link works on the first phones that open it, up to that number; any other phone is blocked and told to
 *     contact the maker; a phone with no link is blocked too;
 *   - after activation the app works offline;
 *   - the maker switches off one phone (it frees a place) or a whole buyer, and back on; the money collected adds up;
 *   - iPhone: "Add to Home Screen" first (the link travels with it), so one iPhone uses one place.
 * Nothing here touches the live site.
 */
const { spawn, spawnSync } = require("child_process");
const fs = require("fs"), os = require("os"), path = require("path");
const { chromium, devices } = require("playwright");
const { BUSINESS, setUp } = require("./fixture.cjs");

const PORT = 8799, BASE = `http://localhost:${PORT}`;
const APP = path.join(__dirname, ".."), OUT = path.join(__dirname, "output");
const WRANGLER = path.join(APP, "..", "chief-of-staff", "node_modules", ".bin", "wrangler");
let failures = 0;
const check = (ok, name, extra = "") => { console.log(`${ok ? "PASS" : "FAIL"}  ${name}${extra ? "  — " + extra : ""}`); if (!ok) failures++; };

function startWorker(stateDir) {
  const log = [];
  const child = spawn(WRANGLER, ["dev", "--port", String(PORT), "--persist-to", stateDir, "--show-interactive-dev-session=false", "--log-level", "warn"], {
    cwd: APP, env: { ...process.env, WRANGLER_SEND_METRICS: "false", CLOUDFLARE_API_TOKEN: "placeholder-not-used-locally" }, stdio: ["ignore", "pipe", "pipe"],
  });
  child.stdout.on("data", (d) => log.push(String(d)));
  child.stderr.on("data", (d) => log.push(String(d)));
  const ready = (async () => {
    for (let i = 0; i < 120; i++) {
      try { const r = await fetch(`${BASE}/api/console/state`); if (r.status) return; } catch { /* not yet */ }
      await new Promise((ok) => setTimeout(ok, 500));
    }
    throw new Error(`wrangler dev didn't start:\n${log.join("")}`);
  })();
  return { ready, stop: () => new Promise((ok) => { child.once("exit", ok); child.kill("SIGTERM"); setTimeout(() => { child.kill("SIGKILL"); ok(); }, 5000); }) };
}
const post = (p, body, token) => fetch(BASE + p, { method: "POST", headers: { "content-type": "application/json", ...(token ? { Authorization: `Bearer ${token}` } : {}) }, body: JSON.stringify(body) });
const PHONE = { viewport: { width: 390, height: 844 }, deviceScaleFactor: 2, isMobile: true, hasTouch: true,
  userAgent: "Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0 Mobile Safari/537.36" };

(async () => {
  fs.mkdirSync(OUT, { recursive: true });
  const build = spawnSync(process.execPath, [path.join(APP, "scripts", "build-worker.cjs")], { cwd: APP, encoding: "utf8" });
  check(build.status === 0, "the app packs into the Worker");
  const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), "marlon-license-"));
  const w = startWorker(stateDir);
  const browser = await chromium.launch();
  const errors = [];
  const watch = (page, who) => { page.on("pageerror", (e) => errors.push(`${who}: ${e.message}`)); };
  try {
    await w.ready;
    const token = (await (await post("/api/console/claim", { passcode: "local-test-passcode" })).json()).token;
    check(/^[0-9a-f]{64}$/.test(token || ""), "console passcode set (local test copy only)");

    // ── API rules ────────────────────────────────────────────────────────────────────────────────────────────
    check((await fetch(`${BASE}/api/console/buyers`)).status === 401 && (await post("/api/console/buyers", { name: "X", devices: 1, amount: 1 })).status === 401, "only the maker (signed in) can see or create buyers");
    const bad = async (body) => (await post("/api/console/buyers", body, token)).status;
    check(await bad({ name: "", devices: 1, amount: 10 }) === 400 && await bad({ name: "A", devices: 0, amount: 10 }) === 400 && await bad({ name: "A", devices: 1.5, amount: 10 }) === 400
      && await bad({ name: "A", devices: 2 }) === 400 && await bad({ name: "A", devices: 2, amount: "" }) === 400 && await bad({ name: "A", devices: 2, amount: -5 }) === 400,
      "a buyer needs a name, a whole number of devices (1 or more) and an amount paid (0 or more)");
    await post("/api/console/contact", { contact: "the seller on WhatsApp 876 555 0100" }, token);
    const mk = async (name, devices, amount) => (await post("/api/console/buyers", { name, devices, amount }, token)).json();
    const solo = await mk("Race Test Shop", 1, 0.01);
    const race = await Promise.all(Array.from({ length: 6 }, (_, i) => post("/api/activate", { key: solo.buyer.id, device: `${i}`.repeat(32).slice(0, 32).replace(/[^0-9a-f]/g, "a") })));
    const raceOk = race.filter((r) => r.status === 200).length;
    check(raceOk === 1, "6 phones opening a 1-device link at the same moment: exactly 1 gets in", `${raceOk} got in`);
    const bogus = await post("/api/activate", { key: "f".repeat(32), device: "a".repeat(32) });
    check(bogus.status === 403 && (await bogus.json()).reason === "unknown", "a made-up link is refused");

    // ── The console: create a buyer link (devices + amount required) ────────────────────────────────────────
    const owner = await browser.newContext({ ...PHONE });
    const con = await owner.newPage();
    watch(con, "console");
    await con.goto(`${BASE}/console`);
    await con.evaluate((t) => sessionStorage.setItem("marlon.console", t), token);
    await con.reload();
    await con.waitForSelector(".con-new");
    const create = con.locator(".con-new button[type=submit]");
    check(await create.isDisabled(), "'Create link' can't be pressed on an empty form");
    await con.fill("#con-buyer-name", "Island Fresh Distributors");
    await con.locator(".con-chip", { hasText: "2" }).click();
    check(await create.isDisabled(), "…nor with a name and devices but no amount paid");
    await con.locator(".con-chip", { hasText: "2" }).click();
    await con.fill("#con-amount", "150");
    await con.locator(".con-chips input[value='2']").evaluate((i) => { i.checked = false; i.dispatchEvent(new Event("change", { bubbles: true })); });
    check(await create.isDisabled(), "…nor with an amount but no number of devices");
    await con.locator(".con-chip", { hasText: "Another number" }).click();
    check(await con.locator("#con-devices-other").isVisible() && await create.isDisabled(), "'Another number' asks how many, and waits for it");
    await con.fill("#con-devices-other", "0");
    check(await create.isDisabled(), "0 devices isn't accepted");
    await con.locator(".con-chip", { hasText: "2" }).click();
    check(await con.locator("#con-devices-other").isHidden() && await create.isEnabled(), "name, 2 devices and $150: now it can be created");
    await con.screenshot({ path: path.join(OUT, "license-1-new-buyer.png") });
    await create.click();
    await con.waitForSelector(".con-created .con-link");
    const link = await con.inputValue(".con-created .con-link");
    check(/^http:\/\/localhost:8799\/\?k=[0-9a-f]{32}$/.test(link), "the console shows the buyer's personal link with a Copy button", link);
    await con.screenshot({ path: path.join(OUT, "license-2-link-created.png") });
    const key = new URL(link).searchParams.get("k");

    // ── Phones opening the link ──────────────────────────────────────────────────────────────────────────────
    const nolinkCtx = await browser.newContext({ ...PHONE });
    const nolink = await nolinkCtx.newPage();
    watch(nolink, "no link");
    await nolink.goto(`${BASE}/`);
    await nolink.waitForSelector(".gate");
    const nl = await nolink.textContent(".gate");
    check(/Open your personal link/.test(nl) && /contact the seller on WhatsApp 876 555 0100/.test(nl) && await nolink.locator("#invoice-screen").isHidden() && await nolink.locator("#setup-name").count() === 0,
      "a phone without a personal link is blocked, with your contact message", nl.replace(/\s+/g, " ").slice(0, 120));
    await nolink.screenshot({ path: path.join(OUT, "license-3-no-link.png") });
    await nolinkCtx.close();

    const ctxA = await browser.newContext({ ...PHONE });
    const A = await ctxA.newPage();
    watch(A, "phone A");
    await A.goto(link);
    await setUp(A);
    check(await A.textContent("#company-name") === BUSINESS.name && !A.url().includes("k="), "phone 1 opens the link: activated, sets up, the link's key leaves the address bar", A.url());
    const ids = await A.evaluate(async () => { const { settings } = await import("/js/db.js"); return { lic: (await settings.get("license")).device, usage: await settings.get("deviceId", null) }; });
    check(ids.lic && ids.lic !== ids.usage, "the anonymous counts use a different random id than the licence (they can't be tied to a buyer)", JSON.stringify(ids));
    const ctxB = await browser.newContext({ ...PHONE, userAgent: devices["iPhone 13"].userAgent.replace("Safari", "Safari") });
    await ctxB.addInitScript(() => Object.defineProperty(navigator, "standalone", { get: () => true })); // an iPhone home-screen app
    const B = await ctxB.newPage();
    watch(B, "phone B");
    await B.goto(link);
    await B.waitForSelector("#setup-name");
    check(true, "phone 2 opens the link: activated (setup shows)");
    const ctxC = await browser.newContext({ ...PHONE });
    const C = await ctxC.newPage();
    watch(C, "phone C");
    await C.goto(link);
    await C.waitForSelector(".gate");
    const ct = await C.textContent(".gate");
    check(/already in use/.test(ct) && /contact the seller on WhatsApp/.test(ct) && await C.locator("#setup-name").count() === 0, "phone 3 on a 2-device link: blocked, told to contact you", ct.replace(/\s+/g, " ").slice(0, 110));
    await C.screenshot({ path: path.join(OUT, "license-4-full.png") });

    // Offline after activation.
    await A.evaluate(() => navigator.serviceWorker.ready);
    await A.waitForTimeout(800);
    await ctxA.setOffline(true);
    await A.reload();
    await A.waitForFunction(() => window.__appReady === true);
    check(await A.locator("#invoice-screen").isVisible() && await A.textContent("#company-name") === BUSINESS.name, "after activation the app opens with no internet");
    await ctxA.setOffline(false);

    // ── The console list ───────────────────────────────────────────────────────────────────────────────────────
    await con.reload();
    await con.waitForSelector(".con-buyer");
    const card = con.locator(".con-buyer", { hasText: "Island Fresh Distributors" });
    const meta = await card.locator(".con-buyer-meta").textContent();
    const phones = await card.locator(".con-phone").allTextContents();
    check(/2 of 2 devices in use/.test(meta) && /\$150\.00/.test(await card.textContent()) && /created \d+ [A-Z][a-z]{2} 20\d\d/.test(meta), "each buyer: name, devices in use, amount paid, date", meta);
    check(phones.length === 2 && /Android · Chrome/.test(phones[0]) && /iPhone/.test(phones[1]) && phones.every((p) => /Active/.test(p)), "…and which phones are active", phones.map((p) => p.replace(/\s+/g, " ")).join(" | "));

    // Switch off one phone: it's blocked when it next opens online, stays blocked offline, and its place is free.
    con.once("dialog", (d) => d.accept());
    await card.locator(".con-phone").nth(0).getByRole("button", { name: "Switch off" }).click();
    await con.waitForFunction(() => /1 of 2 devices in use/.test(document.querySelector(".con-buyer-meta")?.textContent || ""));
    await A.reload();
    await A.waitForSelector(".gate[data-reason='off']", { timeout: 8000 });
    check(/switched off on this phone/.test(await A.textContent(".gate")) && await A.locator("#invoice-screen").isHidden(), "the switched-off phone is blocked the next time it opens online",
      `${(await A.textContent(".gate")).replace(/\s+/g, " ").slice(0, 80)} | main hidden: ${await A.locator("#invoice-screen").isHidden()}`);
    await A.screenshot({ path: path.join(OUT, "license-5-switched-off.png") });
    await ctxA.setOffline(true);
    await A.reload();
    await A.waitForSelector(".gate[data-reason='off']", { timeout: 8000 });
    check(true, "…and stays blocked offline");
    await ctxA.setOffline(false);
    await C.reload();
    await C.waitForSelector("#setup-name", { timeout: 8000 });
    check(true, "the freed place lets another phone in (phone 3 now activates)");
    const full = await post("/api/console/device-off", { id: key, device: ids.lic, off: false }, token);
    check(full.status === 409, "switching phone 1 back on while both places are taken is refused (switch another off first)", `HTTP ${full.status}`);
    // Whole buyer off, then on again.
    await con.reload();
    await con.waitForSelector(".con-buyer");
    con.once("dialog", (d) => d.accept());
    await con.locator(".con-buyer", { hasText: "Island Fresh Distributors" }).getByRole("button", { name: "Switch off whole buyer" }).click();
    await con.waitForSelector(".con-buyer.is-off");
    await B.reload();
    await B.waitForSelector(".gate[data-reason='off']", { timeout: 8000 });
    check(true, "switching off the whole buyer blocks all their phones");
    await con.locator(".con-buyer", { hasText: "Island Fresh Distributors" }).getByRole("button", { name: "Switch buyer on again" }).click();
    await con.waitForSelector(".con-buyer:not(.is-off)");
    await B.reload();
    await B.waitForSelector("#setup-name", { timeout: 8000 });
    check(true, "switching the buyer on again lets them back in");
    // Phone 1 back on (after freeing phone 3's place), with its data intact.
    const cDevice = await C.evaluate(async () => (await (await import("/js/db.js")).settings.get("license")).device);
    await post("/api/console/device-off", { id: key, device: cDevice, off: true }, token);
    check((await post("/api/console/device-off", { id: key, device: ids.lic, off: false }, token)).status === 200, "phone 1 switched on again once a place is free");
    await A.reload();
    await A.waitForFunction(() => window.__appReady === true);
    await A.waitForTimeout(500);
    check(await A.locator("#invoice-screen").isVisible() && await A.textContent("#company-name") === BUSINESS.name, "phone 1 opens again with all its data still there");

    // ── iPhone in Safari: add to Home Screen first ────────────────────────────────────────────────────────────
    const second = await mk("Hilltop Bakery", 1, 49.99);
    const ctxI = await browser.newContext({ ...devices["iPhone 13"], deviceScaleFactor: 2 });
    await ctxI.addInitScript(() => Object.defineProperty(navigator, "standalone", { get: () => false }));
    const I = await ctxI.newPage();
    watch(I, "iPhone Safari");
    await I.goto(second.link);
    await I.waitForSelector(".gate[data-reason='install']");
    check(/Add Marlon to your Home Screen/.test(await I.textContent(".gate")), "iPhone in Safari: asks to Add to Home Screen first (Safari and the Home Screen keep separate storage)");
    const mhref = await I.getAttribute('link[rel="manifest"]', "href");
    const manifest = await (await fetch(BASE + mhref)).json();
    check(mhref === `/manifest.webmanifest?k=${second.buyer.id}` && manifest.start_url === `/?k=${second.buyer.id}`, "the Home Screen app starts at the personal link", manifest.start_url);
    const unused = await (await fetch(`${BASE}/api/console/buyers`, { headers: { Authorization: `Bearer ${token}` } })).json();
    check(unused.buyers.find((b) => b.id === second.buyer.id).active === 0, "…and Safari itself doesn't use up a place");
    await I.screenshot({ path: path.join(OUT, "license-6-iphone-add-to-home.png") });
    await ctxI.close();
    const ctxH = await browser.newContext({ ...devices["iPhone 13"], deviceScaleFactor: 2 });
    await ctxH.addInitScript(() => Object.defineProperty(navigator, "standalone", { get: () => true }));
    const H = await ctxH.newPage();
    watch(H, "iPhone Home Screen");
    await H.goto(BASE + manifest.start_url);
    await H.waitForSelector("#setup-name");
    check(true, "opened from the Home Screen: activated, setup shows");
    await ctxH.close();

    // ── Money collected ──────────────────────────────────────────────────────────────────────────────────────
    await con.reload();
    await con.waitForSelector(".con-tile");
    const moneyTile = await con.locator(".con-tile", { hasText: "Money collected" }).locator(".con-tile-value").textContent();
    check(moneyTile === "$200.00", "money collected adds up every buyer: $0.01 + $150 + $49.99 = $200.00", moneyTile);
    check(await con.locator(".con-buyer").count() === 3, "every buyer is listed", String(await con.locator(".con-buyer").count()));
    await con.screenshot({ path: path.join(OUT, "license-7-console-buyers.png"), fullPage: true });
    check(errors.length === 0, "no page errors", errors.join(" | "));
    for (const c of [ctxA, ctxB, ctxC, owner]) await c.close();
  } finally {
    await browser.close();
    await w.stop();
    fs.rmSync(stateDir, { recursive: true, force: true });
  }
  console.log(failures ? `\n${failures} check(s) failed` : "\nAll license checks passed");
  process.exit(failures ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
