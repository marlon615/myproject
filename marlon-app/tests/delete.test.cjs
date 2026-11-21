/**
 * "Delete" on the owner dashboard, with the real Worker (wrangler dev) and real phones at phone size:
 *   - "Are you sure?" first (cancel changes nothing);
 *   - deleting removes the buyer / team completely (nothing left anywhere on the server) and takes its amount off
 *     Money collected;
 *   - its links stop working: phones on them are blocked, the boss link is dead, reps can't send invoices.
 * Nothing here touches the live site.
 */
const { spawn, spawnSync } = require("child_process");
const fs = require("fs"), os = require("os"), path = require("path");
const { chromium } = require("playwright");
const { setUp } = require("./fixture.cjs");

const PORT = 8805, BASE = `http://localhost:${PORT}`;
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

(async () => {
  fs.mkdirSync(OUT, { recursive: true });
  check(spawnSync(process.execPath, [path.join(APP, "scripts", "build-worker.cjs")], { cwd: APP }).status === 0, "the app packs into the Worker");
  const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), "marlon-delete-"));
  const w = startWorker(stateDir);
  const browser = await chromium.launch();
  const errors = [];
  try {
    await w.ready;
    const token = (await (await post("/api/console/claim", { passcode: "local-test-passcode" })).json()).token;
    const list = async () => (await (await fetch(`${BASE}/api/console/buyers`, { headers: { Authorization: `Bearer ${token}` } })).json());
    const keep = await (await post("/api/console/buyers", { name: "Real Customer", devices: 1, amount: 200 }, token)).json();
    const solo = await (await post("/api/console/buyers", { name: "Test Company", devices: 1, amount: 50 }, token)).json();
    const team = await (await post("/api/console/buyers", { name: "Test Team", devices: 2, amount: 300, kind: "team" }, token)).json();
    check((await list()).totalCents === 55000, "before: three buyers, $550 collected");

    // Phones on the test buyers: a solo phone, a rep with an invoice sent, and a signed-in boss.
    const sctx = await browser.newContext({ ...PHONE }); const S = await sctx.newPage();
    await S.goto(solo.link); await setUp(S);
    const rctx = await browser.newContext({ ...PHONE }); const R = await rctx.newPage();
    await R.goto(team.repLinks[0]); await R.waitForSelector("#setup-rep"); await R.fill("#setup-rep", "Andre");
    await setUp(R, { name: "Test Team", address: "", phone: "", products: [{ name: "Mango Juice", price: "250", unit: "each" }] });
    await R.fill("#store", "Bay Market");
    await R.locator(".prod-row", { hasText: "Mango Juice" }).first().locator(".prod-check").click();
    await R.waitForTimeout(900);
    await R.evaluate(() => window.__teamSync());
    const bctx = await browser.newContext({ ...PHONE }); const B = await bctx.newPage();
    await B.goto(team.bossLink);
    await B.fill("#boss-pass", "boss-secret-1"); await B.fill("#boss-pass2", "boss-secret-1"); await B.click("button[type=submit]");
    await B.waitForSelector(".boss-inv");
    check(true, "the test team has a rep phone, an invoice on the server and a signed-in boss");

    // The owner dashboard.
    const octx = await browser.newContext({ ...PHONE }); const con = await octx.newPage();
    con.on("pageerror", (e) => errors.push(e.message));
    con.on("console", (m) => { if (m.type() === "error") errors.push("console: " + m.text()); });
    con.on("response", (r) => { if (r.url().includes("/api/") && !r.ok()) errors.push(`${r.status()} ${r.url()}`); });
    await con.goto(`${BASE}/console`);
    await con.evaluate((t) => sessionStorage.setItem("marlon.console", t), token);
    await con.reload();
    await con.waitForSelector(".con-buyer", { timeout: 8000 }).catch(async () => { console.log("PAGE ERRORS:", JSON.stringify(errors)); });
    check(await con.locator(".con-delete").count() === 3, "every buyer and team has a Delete button");
    let asked = "";
    con.once("dialog", (d) => { asked = d.message(); d.dismiss(); });
    await con.locator(".con-team", { hasText: "Test Team" }).locator(".con-delete").click();
    await con.waitForTimeout(400);
    check(/Are you sure\?/.test(asked) && /Test Team/.test(asked) && /can't be undone/.test(asked) && (await list()).buyers.length === 3, "it asks 'Are you sure?' first; Cancel deletes nothing", asked.split("\n").slice(0, 3).join(" / "));
    await con.locator(".con-team", { hasText: "Test Team" }).screenshot({ path: path.join(OUT, "delete-1-button.png") });
    con.once("dialog", (d) => d.accept());
    const deleted = con.waitForResponse((r) => r.url().endsWith("/api/console/delete-buyer"));
    await con.locator(".con-team", { hasText: "Test Team" }).locator(".con-delete").click();
    const dteam = await (await deleted).json();
    await con.waitForFunction(() => !/Test Team/.test(document.querySelector(".con-buyers")?.textContent || ""), null, { timeout: 8000 });
    check(dteam.removed.devices >= 2 && dteam.removed.invoices === 1 && dteam.removed.slots === 2 && dteam.removed.sessions >= 1, "the team had phones, rep links, an invoice and a boss session…", JSON.stringify(dteam.removed));
    check(Object.values(dteam.left).every((n) => n === 0), "…and after Delete nothing of it is left anywhere on the server", JSON.stringify(dteam.left));
    con.once("dialog", (d) => d.accept());
    await con.locator(".con-buyer", { hasText: "Test Company" }).locator(".con-delete").click();
    await con.waitForFunction(() => !/Test Company/.test(document.querySelector(".con-buyers")?.textContent || ""), null, { timeout: 8000 });
    const after = await list();
    check(after.buyers.length === 1 && after.buyers[0].name === "Real Customer" && after.totalCents === 20000, "both test buyers are gone from your dashboard; the real one stays; Money collected is $200", `${after.buyers.map((b) => b.name)} · ${after.totalCents}`);
    await con.screenshot({ path: path.join(OUT, "delete-2-after.png") });

    // Their links stop working.
    for (const [label, key] of [["the solo link", new URL(solo.link).searchParams.get("k")], ["rep link 1", new URL(team.repLinks[0]).searchParams.get("k")], ["rep link 2 (never used)", new URL(team.repLinks[1]).searchParams.get("k")]]) {
      const r = await (await post("/api/activate", { key, device: "a".repeat(32) })).json();
      check(r.ok === false && r.reason === "unknown", `${label} no longer works`, JSON.stringify(r));
    }
    await S.reload(); await S.waitForSelector(".gate[data-reason='off']", { timeout: 8000 });
    check(true, "the solo phone is blocked the next time it opens online");
    await R.reload(); await R.waitForSelector(".gate[data-reason='off']", { timeout: 8000 });
    const lic = await R.evaluate(async () => (await (await import("/js/db.js")).settings.get("license")));
    check((await post("/api/team/sync", { key: lic.key, device: lic.device, rep: "Andre", invoices: [{ id: "inv_late", total: 1, items: [] }] })).status === 403, "the rep's phone is blocked and can't send invoices");
    await B.reload(); await B.waitForSelector("[data-reason='blocked']", { timeout: 8000 });
    check(/doesn't work|isn't valid/.test(await B.textContent("#boss")), "the boss link no longer works", (await B.textContent("#boss")).replace(/\s+/g, " ").slice(0, 80));
    const keepOk = await (await post("/api/activate", { key: keep.buyer.id, device: "b".repeat(32) })).json();
    check(keepOk.ok, "the buyer that wasn't deleted still works");
    check(errors.length === 0, "no page errors", errors.join(" | "));
    for (const c of [sctx, rctx, bctx, octx]) await c.close();
  } finally {
    await browser.close();
    await w.stop();
    fs.rmSync(stateDir, { recursive: true, force: true });
  }
  console.log(failures ? `\n${failures} check(s) failed` : "\nAll delete checks passed");
  process.exit(failures ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
