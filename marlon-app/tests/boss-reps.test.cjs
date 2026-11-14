/**
 * The boss sets up his own reps, with the real Worker (wrangler dev) and the real app at phone size:
 *   - "Add rep" names one of the rep places the company paid for and shows its link — never more places;
 *   - the rep's phone opens it with the boss's name for them filled in;
 *   - "Switch off" a rep: their phone stops working, their invoices stay under their name, and the SAME link is
 *     free: "Give to new rep" with a new name; the new rep's phone opens that same link; the old phone can't return.
 * Nothing here touches the live site.
 */
const { spawn, spawnSync } = require("child_process");
const fs = require("fs"), os = require("os"), path = require("path");
const { chromium } = require("playwright");
const { setUp } = require("./fixture.cjs");

const PORT = 8804, BASE = `http://localhost:${PORT}`;
const APP = path.join(__dirname, ".."), OUT = path.join(__dirname, "output");
const WRANGLER = path.join(APP, "..", "chief-of-staff", "node_modules", ".bin", "wrangler");
let failures = 0;
const check = (ok, name, extra = "") => { console.log(`${ok ? "PASS" : "FAIL"}  ${name}${extra ? "  — " + extra : ""}`); if (!ok) failures++; };
const PHONE = { viewport: { width: 390, height: 844 }, deviceScaleFactor: 2, isMobile: true, hasTouch: true };
const post = (p, body, token) => fetch(BASE + p, { method: "POST", headers: { "content-type": "application/json", ...(token ? { Authorization: `Bearer ${token}` } : {}) }, body: JSON.stringify(body) });

function startWorker(stateDir) {
  const log = [];
  const child = spawn(WRANGLER, ["dev", "--port", String(PORT), "--persist-to", stateDir, "--show-interactive-dev-session=false", "--log-level", "warn"], {
    cwd: APP, env: { ...process.env, WRANGLER_SEND_METRICS: "false", CLOUDFLARE_API_TOKEN: "placeholder-not-used-locally" }, stdio: ["ignore", "pipe", "pipe"],
  });
  child.stdout.on("data", (d) => log.push(String(d)));
  child.stderr.on("data", (d) => log.push(String(d)));
  const ready = (async () => {
    for (let i = 0; i < 120; i++) { try { if ((await fetch(`${BASE}/api/console/state`)).status) return; } catch { /* not yet */ } await new Promise((ok) => setTimeout(ok, 500)); }
    throw new Error(`wrangler dev didn't start:\n${log.join("")}`);
  })();
  return { ready, stop: () => new Promise((ok) => { child.once("exit", ok); child.kill("SIGTERM"); setTimeout(() => { child.kill("SIGKILL"); ok(); }, 5000); }) };
}

async function invoice(page, store, product, qty, price) {
  await page.evaluate(() => window.scrollTo(0, 0));
  await page.fill("#store", store);
  const row = page.locator(".prod-row", { hasText: product }).first();
  await row.locator(".prod-check").click();
  await row.locator(".qty-input").fill(String(qty));
  await row.locator(".price-input").fill(String(price));
  await page.waitForTimeout(900);
  await page.evaluate(() => window.__teamSync());
}

(async () => {
  fs.mkdirSync(OUT, { recursive: true });
  check(spawnSync(process.execPath, [path.join(APP, "scripts", "build-worker.cjs")], { cwd: APP }).status === 0, "the app packs into the Worker");
  const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), "marlon-boss-reps-"));
  const w = startWorker(stateDir);
  const browser = await chromium.launch();
  const errors = [];
  const watch = (p, who) => p.on("pageerror", (e) => errors.push(`${who}: ${e.message}`));
  try {
    await w.ready;
    const token = (await (await post("/api/console/claim", { passcode: "local-test-passcode" })).json()).token;
    const team = await (await post("/api/console/buyers", { name: "Test Team", devices: 2, amount: 300, kind: "team" }, token)).json();

    // The boss.
    const bctx = await browser.newContext({ ...PHONE });
    const boss = await bctx.newPage();
    watch(boss, "boss");
    await boss.goto(team.bossLink);
    await boss.fill("#boss-pass", "boss-secret-1");
    await boss.fill("#boss-pass2", "boss-secret-1");
    await boss.click("button[type=submit]");
    await boss.waitForSelector("#boss-team");
    check(/0 of 2 rep places in use/.test(await boss.textContent("#boss-places")) && await boss.locator(".boss-add-rep").isEnabled(), "the boss dashboard has 'Add rep': 0 of the 2 places the company paid for in use");
    const addRep = async (name, sel = ".boss-add-rep") => {
      boss.once("dialog", (d) => d.accept(name));
      await boss.click(sel);
      await boss.waitForFunction((n) => { const b = document.querySelector(".boss-new-link:not([hidden])"); return b && b.textContent.includes(`${n}'s link`); }, name, { timeout: 8000 });
      return boss.inputValue(".boss-link-input");
    };
    const andreLink = await addRep("Andre");
    check(/\/\?k=[0-9a-f]{32}$/.test(andreLink) && team.repLinks.includes(andreLink), "Add rep 'Andre': his link appears, ready to copy or share (one of the paid places)", andreLink);
    await boss.screenshot({ path: path.join(OUT, "boss-reps-1-added.png") });
    const biancaLink = await addRep("Bianca");
    check(biancaLink !== andreLink && team.repLinks.includes(biancaLink), "Add rep 'Bianca': a different link");
    check(/2 of 2 rep places in use/.test(await boss.textContent("#boss-places")) && await boss.locator(".boss-add-rep").isDisabled(), "with both places used, 'Add rep' is greyed out");
    const bossToken = await boss.evaluate(() => JSON.parse(sessionStorage.getItem("marlon.boss.token")));
    const extra = await post("/api/boss/add-rep", { name: "Extra" }, bossToken);
    check(extra.status === 409 && /2 rep places/.test((await extra.json()).error), "the server refuses a 3rd rep: the boss can't make extra links", `HTTP ${extra.status}`);

    // Andre's phone.
    const actx = await browser.newContext({ ...PHONE });
    const A = await actx.newPage();
    watch(A, "Andre");
    await A.goto(andreLink);
    await A.waitForSelector("#setup-rep");
    check(await A.inputValue("#setup-rep") === "Andre" && await A.inputValue("#setup-name") === "Test Team", "Andre opens his link: his name (from the boss) and the company are filled in");
    await setUp(A, { name: "Test Team", address: "", phone: "", products: [{ name: "Mango Juice", price: "250", unit: "each" }] });
    await invoice(A, "Bay Market", "Mango Juice", 4, 250);
    await boss.click("text=Refresh");
    await boss.waitForTimeout(400);
    check(/by Andre/.test(await boss.locator(".boss-inv", { hasText: "Bay Market" }).innerText()), "Andre's invoice reaches the boss, by Andre");

    // Andre leaves: the boss switches him off.
    boss.once("dialog", (d) => d.accept());
    await boss.locator(".boss-rep[data-n='1']").getByRole("button", { name: "Switch off" }).click();
    await boss.waitForFunction(() => /Free · this link is ready for a new rep/.test(document.querySelector(".boss-rep[data-n='1']")?.textContent || ""), null, { timeout: 8000 });
    check(true, "the boss switches Andre off: his place shows as free, ready for a new rep");
    await A.reload();
    await A.waitForSelector(".gate[data-reason='off']", { timeout: 8000 });
    check(true, "Andre's phone stops working");
    check(/by Andre/.test(await boss.locator(".boss-inv", { hasText: "Bay Market" }).innerText()), "Andre's invoices stay on the dashboard under Andre's name");
    await boss.screenshot({ path: path.join(OUT, "boss-reps-2-switched-off.png"), fullPage: true });

    // The same link for a new rep.
    const carlaLink = await addRep("Carla", ".boss-rep[data-n='1'] .boss-give");
    check(carlaLink === andreLink, "'Give to new rep' → Carla gets the SAME link (no new link made)", carlaLink);
    const cctx = await browser.newContext({ ...PHONE });
    const C = await cctx.newPage();
    watch(C, "Carla");
    await C.goto(carlaLink);
    await C.waitForSelector("#setup-rep");
    check(await C.inputValue("#setup-rep") === "Carla", "Carla's phone opens the same link, as Carla");
    await setUp(C, { name: "Test Team", address: "", phone: "", products: [{ name: "Ginger Beer", price: "150", unit: "each" }] });
    await invoice(C, "Corner Shop", "Ginger Beer", 10, 150);
    await boss.click("text=Refresh");
    await boss.waitForTimeout(400);
    check(/by Carla/.test(await boss.locator(".boss-inv", { hasText: "Corner Shop" }).innerText()) && /by Andre/.test(await boss.locator(".boss-inv", { hasText: "Bay Market" }).innerText()),
      "the boss sees Carla's invoice by Carla, and Andre's still by Andre");
    const table = await boss.$$eval("#boss-reps tr", (rs) => rs.map((r) => r.children[0].textContent.trim()));
    check(table.includes("Andre (switched off)") && table.includes("Carla"), "the totals list Andre (switched off) and Carla separately", table.join(" | "));
    await boss.screenshot({ path: path.join(OUT, "boss-reps-3-new-rep.png"), fullPage: true });

    // Andre can't come back.
    const aLic = await A.evaluate(async () => (await (await import("/js/db.js")).settings.get("license")));
    const back = await post("/api/activate", { key: aLic.key, device: aLic.device });
    check(back.status === 403, "Andre's old phone can't use the link again", `HTTP ${back.status}`);
    const team2 = (await (await fetch(`${BASE}/api/console/buyers`, { headers: { Authorization: `Bearer ${token}` } })).json()).buyers.find((b) => b.name === "Test Team");
    const reon = await post("/api/console/device-off", { id: team2.id, device: aLic.device, off: false }, token);
    check(reon.status === 409, "…not even if switched on again from your owner dashboard", `HTTP ${reon.status}`);
    const sneak = await post("/api/team/sync", { key: aLic.key, device: aLic.device, rep: "Andre", invoices: [{ id: "inv_late", total: 1, items: [] }] });
    check(sneak.status === 403, "…and it can't send invoices");
    check(errors.length === 0, "no page errors", errors.join(" | "));
    for (const c of [bctx, actx, cctx]) await c.close();
  } finally {
    await browser.close();
    await w.stop();
    fs.rmSync(stateDir, { recursive: true, force: true });
  }
  console.log(failures ? `\n${failures} check(s) failed` : "\nAll boss-reps checks passed");
  process.exit(failures ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
