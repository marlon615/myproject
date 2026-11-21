/**
 * The real Worker (worker/index.js + its Durable Object), run locally with `wrangler dev` (workerd, local SQLite):
 *   - serves the app, the customer page and the maker's console;
 *   - /api/ping keeps anonymous counts only (nothing else that's sent is stored);
 *   - the console: first visit sets the passcode, then only that passcode opens it; 5 wrong tries (even sent all at
 *     once) lock it for 15 minutes; raising CONSOLE_GENERATION lets the passcode be set again and keeps the counts;
 *   - the console page itself (phone size): passcode screen, tiles, charts, table view, Lock.
 * Nothing here touches the live site.
 */
const { spawn, spawnSync } = require("child_process");
const fs = require("fs"), os = require("os"), path = require("path");
const { chromium } = require("playwright");

const PORT = 8797;
const BASE = `http://localhost:${PORT}`;
const APP = path.join(__dirname, "..");
const WRANGLER = path.join(APP, "..", "chief-of-staff", "node_modules", ".bin", "wrangler");
const OUT = path.join(__dirname, "output");
let failures = 0;
const check = (ok, name, extra = "") => { console.log(`${ok ? "PASS" : "FAIL"}  ${name}${extra ? "  — " + extra : ""}`); if (!ok) failures++; };

function startWorker(stateDir, generation) {
  const log = [];
  const child = spawn(WRANGLER, ["dev", "--port", String(PORT), "--persist-to", stateDir, "--var", `CONSOLE_GENERATION:${generation}`,
    "--show-interactive-dev-session=false", "--log-level", "warn"], {
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
  return { ready, log, stop: () => new Promise((ok) => { child.once("exit", ok); child.kill("SIGTERM"); setTimeout(() => { child.kill("SIGKILL"); ok(); }, 5000); }) };
}

const post = (p, body, headers = {}) => fetch(BASE + p, { method: "POST", headers: { "content-type": "application/json", ...headers }, body: typeof body === "string" ? body : JSON.stringify(body), redirect: "manual" });
const get = (p, headers = {}) => fetch(BASE + p, { headers, redirect: "manual" });
const today = new Date().toISOString().slice(0, 10);
const daysAgo = (n) => { const d = new Date(); d.setUTCDate(d.getUTCDate() - n); return d.toISOString().slice(0, 10); };

(async () => {
  fs.mkdirSync(OUT, { recursive: true });
  const build = spawnSync(process.execPath, [path.join(APP, "scripts", "build-worker.cjs")], { cwd: APP, encoding: "utf8" });
  check(build.status === 0, "the app packs into the Worker", (build.stdout || build.stderr).trim());
  const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), "marlon-worker-"));
  let w = startWorker(stateDir, 1);
  const browser = await chromium.launch();
  try {
    await w.ready;

    // ── Serving the app ──────────────────────────────────────────────────
    const home = await get("/");
    const homeHtml = await home.text();
    check(home.status === 200 && /id="setup"/.test(homeHtml) && /Marlon/.test(homeHtml), "/ serves the app (with its setup screen)");
    check(/Content-Security-Policy/i.test([...home.headers.keys()].join(" ")) || home.headers.get("content-security-policy"), "the app has its security headers");
    check((await get("/v")).status === 200, "/v (customer page) is served");
    const con = await get("/console");
    const conHtml = await con.text();
    check(con.status === 200 && /Maker's console/.test(conHtml) && /noindex/.test(conHtml), "/console is served, and asks search engines not to list it");
    const conRedirect = await get("/console.html");
    check(conRedirect.status === 307 && new URL(conRedirect.headers.get("location"), BASE).pathname === "/console", "/console.html redirects to /console");
    check((await get("/no-such-page")).status === 404, "unknown pages get the 404 page");
    const sw = await (await get("/sw.js")).text();
    check(/marlon-app-/.test(sw), "the service worker is the sellable copy's own (its caches can't mix with any other app)");

    // ── /api/ping: anonymous counts only ────────────────────────────────
    check((await get("/api/ping")).status === 405, "GET /api/ping is refused");
    check((await post("/api/ping", "not json")).status === 400, "a ping that isn't JSON is refused");
    check((await post("/api/ping", { device: "x", events: [{ kind: "open", day: today }] })).status === 400, "a ping with a malformed phone id is refused");
    check((await post("/api/ping", { device: "a1b2c3d4e5f6a7b8", events: [{ kind: "steal", day: today }] })).status === 400, "a ping with no known kinds is refused");
    check((await post("/api/ping", { device: "a1b2c3d4e5f6a7b8", events: [{ kind: "open", day: today }], pad: "x".repeat(7000) })).status === 400, "an oversized ping is refused");
    const A = "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa", B = "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb";
    const marker = "Zebra Corner Shop 4471";
    const r1 = await post("/api/ping", { device: A, store: marker, events: [
      { kind: "setup", day: today, name: marker }, { kind: "open", day: today }, { kind: "invoice", day: today, total: 99999 },
      { kind: "invoice", day: today }, { kind: "voice", day: today }, { kind: "print", day: today }, { kind: "pdf", day: today }, { kind: "bogus", day: today }] });
    check(r1.status === 204, "phone A's counts are accepted (204)");
    const r2 = await post("/api/ping", { device: B, events: [{ kind: "setup", day: daysAgo(3) }, { kind: "open", day: daysAgo(3) }, { kind: "invoice", day: daysAgo(3) }, { kind: "open", day: today }, { kind: "picture", day: today }] });
    check(r2.status === 204, "phone B's counts are accepted (204)");
    check((await post("/api/ping", { device: B, events: [{ kind: "open", day: "1999-01-01" }] })).status === 204, "a ping with an impossible day is still accepted (counted as today)");
    const many = Array.from({ length: 80 }, () => ({ kind: "invoice", day: today }));
    check((await post("/api/ping", { device: A, events: many })).status === 204, "a ping with 80 events is accepted (only the first 50 count)");

    // ── The console's passcode ───────────────────────────────────────────
    check((await (await get("/api/console/state")).json()).claimed === false, "before anyone sets it, the console has no passcode");
    check((await get("/api/console/stats")).status === 401, "the numbers can't be read without signing in");
    check((await post("/api/console/claim", { passcode: "short" })).status === 400, "a passcode under 8 characters is refused");
    const pass = "tea-and-toast-77";
    const claim = await post("/api/console/claim", { passcode: pass });
    const { token } = await claim.json();
    check(claim.status === 200 && /^[0-9a-f]{64}$/.test(token || ""), "the first visit sets the passcode and signs in");
    const claim2 = await post("/api/console/claim", { passcode: "someone-else-1" });
    check(claim2.status === 409, "nobody can set it a second time", `HTTP ${claim2.status}`);
    check((await (await get("/api/console/state")).json()).claimed === true, "the console now asks for the passcode");

    // ── The numbers ──────────────────────────────────────────────────────
    const stRes = await get("/api/console/stats", { Authorization: `Bearer ${token}` });
    const st = await stRes.json();
    check(stRes.status === 200, "signed in, the numbers can be read");
    check(st.businesses === 2 && st.phones === 2, "2 businesses set up, 2 phones", `${st.businesses} / ${st.phones}`);
    check(st.activeToday === 2 && st.active7 === 2 && st.active30 === 2, "2 used it today, this week and this month", `${st.activeToday}/${st.active7}/${st.active30}`);
    check(st.totals.invoice === 2 + 1 + 50, "invoices: 2 + 1 + the first 50 of the big batch = 53", String(st.totals.invoice));
    // Opens: A 1, B 2 (3 days ago and today), plus the ping with an impossible day = 4.
    check(st.totals.open === 4 && st.totals.voice === 1 && st.totals.print === 1 && st.totals.pdf === 1 && st.totals.picture === 1 && st.totals.setup === 2, "every kind counted once per event (open 4, voice, print, pdf, picture 1, setup 2)", JSON.stringify(st.totals));
    check(!("bogus" in st.totals), "unknown kinds are dropped");
    const dayB = st.days.find((d) => d.day === daysAgo(3));
    const dayT = st.days.find((d) => d.day === today);
    check(st.days.length === 30 && dayB && dayB.active === 1 && dayB.invoices === 1 && dayB.setups === 1, "3 days ago: 1 business active, 1 invoice, 1 set up", JSON.stringify(dayB));
    check(dayT && dayT.active === 2 && dayT.invoices === 52 && dayT.setups === 1, "today: 2 active, 52 invoices, 1 set up", JSON.stringify(dayT));
    check(st.passcodeSince === today, "the console shows when the passcode was set", st.passcodeSince);
    check(!JSON.stringify(st).includes(marker) && !JSON.stringify(st).includes("99999"), "the numbers carry no names or amounts");

    // Nothing but counts is stored: search the Worker's whole local database for what phone A slipped in.
    const stored = (dir) => fs.readdirSync(dir, { withFileTypes: true }).flatMap((d) => d.isDirectory() ? stored(path.join(dir, d.name)) : [path.join(dir, d.name)]);
    const files = stored(stateDir);
    const hits = files.filter((f) => { const b = fs.readFileSync(f); return b.includes(Buffer.from(marker)) || b.includes(Buffer.from("99999")); });
    check(files.some((f) => /sqlite$/.test(f)) && hits.length === 0, "the stored data holds no names or amounts (searched every stored file)", `${files.length} files, hits: ${hits.join(", ") || "none"}`);

    // ── Wrong passcodes, even all at once ────────────────────────────────
    const wrong = await post("/api/console/login", { passcode: "not-the-passcode" });
    const wrongBody = await wrong.json();
    check(wrong.status === 401 && /4 more tries/.test(wrongBody.error), "a wrong passcode is refused and says how many tries are left", wrongBody.error);
    const burst = await Promise.all(Array.from({ length: 10 }, (_, i) => post("/api/console/login", { passcode: `guess-number-${i}` })));
    const codes = burst.map((r) => r.status);
    check(codes.filter((c) => c === 401).length === 4 && codes.filter((c) => c === 429).length === 6, "10 guesses sent at the same moment: only 4 more are checked, the rest wait (5 tries per 15 minutes)", codes.join(","));
    const locked = await post("/api/console/login", { passcode: pass });
    check(locked.status === 429 && Number(locked.headers.get("retry-after")) > 0, "after 5 wrong tries even the right passcode waits", `HTTP ${locked.status}, Retry-After ${locked.headers.get("retry-after")}`);
    check((await get("/api/console/stats", { Authorization: `Bearer ${token}` })).status === 200, "…while the owner's open session keeps working");
    check((await get("/api/console/stats", { Authorization: "Bearer " + "0".repeat(64) })).status === 401, "a made-up session is refused");
    const out = await post("/api/console/logout", {}, { Authorization: `Bearer ${token}` });
    check(out.status === 204 && (await get("/api/console/stats", { Authorization: `Bearer ${token}` })).status === 401, "Lock ends the session");

    // ── Reset: raise CONSOLE_GENERATION, redeploy ────────────────────────
    await w.stop();
    w = startWorker(stateDir, 2);
    await w.ready;
    check((await (await get("/api/console/state")).json()).claimed === false, "after raising CONSOLE_GENERATION the passcode can be set again");
    check((await post("/api/console/login", { passcode: pass })).status !== 200, "the old passcode no longer opens it");
    const reclaim = await post("/api/console/claim", { passcode: "new-passcode-2026" });
    const token2 = (await reclaim.json()).token;
    const st2 = await (await get("/api/console/stats", { Authorization: `Bearer ${token2}` })).json();
    check(reclaim.status === 200 && st2.businesses === 2 && st2.totals.invoice === 53, "the new passcode works and every count is kept", `businesses ${st2.businesses}, invoices ${st2.totals.invoice}`);

    // ── The console page (phone size) ────────────────────────────────────
    const ctx = await browser.newContext({ viewport: { width: 390, height: 844 }, deviceScaleFactor: 2 });
    const page = await ctx.newPage();
    const errors = [];
    page.on("pageerror", (e) => errors.push(e.message));
    // (The deliberate wrong passcode below gets a 401 answer, which the browser logs; that one is expected.)
    page.on("console", (m) => { if (m.type() === "error" && !/\/api\/console\/login/.test(m.location()?.url || "")) errors.push(`${m.text()} ${m.location()?.url || ""}`); });
    await page.goto(`${BASE}/console`);
    await page.waitForSelector("#con-pass");
    check(await page.locator("#con-pass2").count() === 0 && /Enter your console passcode/.test(await page.textContent("#console")), "the page asks for the passcode (it's already set)");
    await page.screenshot({ path: path.join(OUT, "console-gate.png") });
    await page.fill("#con-pass", "wrong-passcode-1");
    await page.click("button[type=submit]");
    await page.waitForSelector(".con-error:not([hidden])");
    check(/isn't right/.test(await page.textContent(".con-error")), "a wrong passcode shows a clear message", await page.textContent(".con-error"));
    await page.fill("#con-pass", "new-passcode-2026");
    await page.click("button[type=submit]");
    await page.waitForSelector(".con-tile");
    const tiles = await page.$$eval(".con-tile", (ts) => ts.map((t) => [t.querySelector(".con-tile-label").textContent, t.querySelector(".con-tile-value").textContent]));
    const tile = (label) => (tiles.find((t) => t[0] === label) || [])[1];
    check(tile("Businesses set up") === "2" && tile("Using it today") === "2" && tile("Invoices made") === "53", "the tiles show the same numbers as the server", JSON.stringify(tiles));
    check(await page.locator(".con-chart svg").count() === 2 && await page.locator(".con-chart svg").first().locator(".bar").count() === 30, "two charts, 30 days each");
    const todayHit = page.locator(".con-chart").nth(1).locator("svg rect").nth(29); // the (wider) hit area over today's bar
    await todayHit.hover();
    const tip = await page.locator(".con-chart").nth(1).locator(".con-tip").textContent();
    check(/52 invoices/.test(tip), "pointing at today's bar shows its number", tip);
    await page.mouse.move(5, 5);
    check(await page.locator(".con-chart").nth(1).locator(".con-tip").isHidden(), "…and hides when the pointer moves away");
    await page.locator(".con-chart-head button").nth(1).click();
    const rows = await page.locator(".con-table").nth(1).locator("tbody tr").count();
    check(rows === 30, "'Show as a table' lists all 30 days", String(rows));
    await page.locator(".con-chart-head button").nth(1).click();
    const scrollW = await page.evaluate(() => document.documentElement.scrollWidth);
    check(scrollW <= 390, "no sideways scrolling on a phone", `${scrollW}px`);
    const labels = await page.locator(".con-chart").first().locator("svg text").evaluateAll((ts) => ts.map((t) => { const b = t.getBoundingClientRect(); return { text: t.textContent, x: b.x, y: b.y, w: b.width, h: b.height, size: parseFloat(getComputedStyle(t).fontSize) * (t.ownerSVGElement.getBoundingClientRect().width / t.ownerSVGElement.viewBox.baseVal.width) }; }));
    const overlap = labels.some((a, i) => labels.some((b, j) => j > i && a.x < b.x + b.w && b.x < a.x + a.w && a.y < b.y + b.h && b.y < a.y + a.h));
    check(!overlap, "chart labels don't overlap", labels.map((l) => l.text).join(" "));
    check(labels.every((l) => l.size >= 10.5), "chart labels show at their real size (about 11px) on a phone", labels.map((l) => l.size.toFixed(1)).join(","));
    await page.evaluate(() => window.scrollTo(0, 0));
    await page.screenshot({ path: path.join(OUT, "console-numbers.png"), fullPage: true });
    // A finger tap keeps the number showing after the finger lifts.
    const touchCtx = await browser.newContext({ viewport: { width: 390, height: 844 }, hasTouch: true, isMobile: true });
    const tp = await touchCtx.newPage();
    await tp.goto(`${BASE}/console`);
    await tp.evaluate((t) => sessionStorage.setItem("marlon.console", t), await page.evaluate(() => sessionStorage.getItem("marlon.console")));
    await tp.reload();
    await tp.waitForSelector(".con-tile");
    const todayHitT = tp.locator(".con-chart").first().locator("svg rect").nth(29);
    await todayHitT.scrollIntoViewIfNeeded();
    const box = await todayHitT.boundingBox();
    await tp.touchscreen.tap(box.x + box.width / 2, box.y + box.height / 2);
    await tp.waitForTimeout(300);
    const tTip = tp.locator(".con-chart").first().locator(".con-tip");
    check(await tTip.isVisible() && /2 businesses/.test(await tTip.textContent()), "on a phone, tapping a bar shows its number and it stays after lifting the finger", await tTip.textContent());
    await tp.touchscreen.tap(20, 400);
    await tp.waitForTimeout(200);
    check(await tTip.isHidden(), "…and tapping elsewhere hides it");
    await touchCtx.close();
    await page.getByRole("button", { name: "Lock", exact: true }).click();
    await page.waitForSelector("#con-pass");
    check(await page.evaluate(() => sessionStorage.getItem("marlon.console")) === null, "Lock signs out on this phone");
    check(errors.length === 0, "no errors on the console page", errors.join(" | "));
    await ctx.close();
  } finally {
    await browser.close();
    await w.stop();
    fs.rmSync(stateDir, { recursive: true, force: true });
  }
  console.log(failures ? `\n${failures} check(s) failed` : "\nAll worker checks passed");
  process.exit(failures ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
