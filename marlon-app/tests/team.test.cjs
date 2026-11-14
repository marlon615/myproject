/**
 * Team version, end to end, with the real Worker (wrangler dev, local SQLite) and the real app at phone size:
 *   - an upgrade: data saved by the previous Worker (no teams) is kept and keeps working;
 *   - the maker's console: Solo or Team; a team gets a rep link (N rep phones) and a boss link;
 *   - reps: "Your name" at setup; invoices saved on the phone first, sent to the boss when online, waiting offline;
 *     changes (paid) go too; nothing doubles; a third rep phone on a 2-rep team is blocked;
 *   - the boss: his own phone and passcode; every invoice, rep, customer, products, total, paid or not, totals for
 *     today / this week / this month per rep and for the company; offline shows the last data;
 *   - the maker switches off one rep (blocked, can't send) or the whole company (boss and reps blocked);
 *   - solo buyers send nothing.
 * Nothing here touches the live site.
 */
const { spawn, spawnSync, execFileSync } = require("child_process");
const fs = require("fs"), os = require("os"), path = require("path");
const { chromium, devices } = require("playwright");
const { setUp } = require("./fixture.cjs");

const PORT = 8802, BASE = `http://localhost:${PORT}`;
const APP = path.join(__dirname, ".."), OUT = path.join(__dirname, "output");
const WRANGLER = path.join(APP, "..", "chief-of-staff", "node_modules", ".bin", "wrangler");
let failures = 0;
const check = (ok, name, extra = "") => { console.log(`${ok ? "PASS" : "FAIL"}  ${name}${extra ? "  — " + extra : ""}`); if (!ok) failures++; };

function startWorker(stateDir, cwd = APP) {
  const log = [];
  const child = spawn(WRANGLER, ["dev", "--port", String(PORT), "--persist-to", stateDir, "--show-interactive-dev-session=false", "--log-level", "warn"], {
    cwd, env: { ...process.env, WRANGLER_SEND_METRICS: "false", CLOUDFLARE_API_TOKEN: "placeholder-not-used-locally" }, stdio: ["ignore", "pipe", "pipe"],
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
const PHONE = { viewport: { width: 390, height: 844 }, deviceScaleFactor: 2, isMobile: true, hasTouch: true };
const pad = (n) => String(n).padStart(2, "0");
const localISO = (d = new Date()) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
const row = (page, name) => page.locator(".prod-row", { hasText: name }).first();

async function makeInvoice(page, store, lines) {
  await page.click("#new-btn").catch(() => {});
  await page.waitForTimeout(250);
  if (await page.locator("dialog.pay .pay-skip").count()) { await page.click("dialog.pay .pay-skip"); await page.waitForTimeout(250); }
  await page.evaluate(() => window.scrollTo(0, 0));
  await page.fill("#store", store);
  for (const [name, qty, price] of lines) {
    await row(page, name).locator(".prod-check").click();
    await row(page, name).locator(".qty-input").fill(String(qty));
    await row(page, name).locator(".price-input").fill(String(price));
  }
  await page.waitForTimeout(900); // autosave
}
const markPaid = (page, store) => page.evaluate(async (s) => {
  const db = await import("/js/db.js");
  const inv = (await db.invoices.all()).find((i) => i.store === s);
  await db.invoices.put({ ...inv, payment: { status: "paid", method: "cash", termsDays: null, dueDate: null, paidAt: new Date().toISOString() } });
}, store);

(async () => {
  fs.mkdirSync(OUT, { recursive: true });
  const build = spawnSync(process.execPath, [path.join(APP, "scripts", "build-worker.cjs")], { cwd: APP, encoding: "utf8" });
  check(build.status === 0, "the app packs into the Worker");
  const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), "marlon-team-"));
  const browser = await chromium.launch();
  const errors = [];
  const watch = (page, who) => page.on("pageerror", (e) => errors.push(`${who}: ${e.message}`));
  let w;
  try {
    // ── Upgrade: the previous Worker (no teams) saves a buyer; the new Worker keeps it ─────────────────────────
    const oldDir = fs.mkdtempSync(path.join(os.tmpdir(), "marlon-old-worker-"));
    fs.mkdirSync(path.join(oldDir, "worker"));
    fs.writeFileSync(path.join(oldDir, "worker", "index.js"), execFileSync("git", ["show", "b5c9a8b:marlon-app/worker/index.js"], { cwd: APP }));
    fs.copyFileSync(path.join(APP, "worker", "assets.generated.js"), path.join(oldDir, "worker", "assets.generated.js"));
    fs.copyFileSync(path.join(APP, "wrangler.toml"), path.join(oldDir, "wrangler.toml"));
    w = startWorker(stateDir, oldDir);
    await w.ready;
    const token0 = (await (await post("/api/console/claim", { passcode: "local-test-passcode" })).json()).token;
    const oldBuyer = await (await post("/api/console/buyers", { name: "Old Solo Shop", devices: 1, amount: 99 }, token0)).json();
    const oldPhone = "c".repeat(32);
    check((await post("/api/activate", { key: oldBuyer.buyer.id, device: oldPhone })).status === 200, "previous version: a solo buyer and phone saved");
    const oldTeam = await (await post("/api/console/buyers", { name: "Old Team Co", devices: 3, amount: 10, kind: "team" }, token0)).json();
    check((await post("/api/activate", { key: oldTeam.buyer.id, device: "e".repeat(32) })).status === 200, "previous version: a team with the old shared rep link, one rep phone in");
    await w.stop();
    fs.rmSync(oldDir, { recursive: true, force: true });
    w = startWorker(stateDir);
    await w.ready;
    const login = await (await post("/api/console/login", { passcode: "local-test-passcode" })).json();
    const token = login.token;
    const list0 = await (await fetch(`${BASE}/api/console/buyers`, { headers: { Authorization: `Bearer ${token}` } })).json();
    const kept = list0.buyers.find((b) => b.id === oldBuyer.buyer.id);
    const recheck = await (await post("/api/check", { key: oldBuyer.buyer.id, device: oldPhone })).json();
    check(kept && kept.kind === "solo" && kept.phones.length === 1 && list0.totalCents === 10900 && recheck.ok && recheck.team === false,
      "after the upgrade: the old buyer, its phone and the money total are all kept, and it still works as solo", JSON.stringify({ kind: kept?.kind, phones: kept?.phones.length, total: list0.totalCents, recheck }));
    const legacy = await (await post("/api/activate", { key: oldTeam.buyer.id, device: "f".repeat(32) })).json();
    check(legacy.ok && legacy.team, "after the upgrade: a team made before personal rep links keeps its shared rep link working", JSON.stringify(legacy));
    const soloSync = await post("/api/team/sync", { key: oldBuyer.buyer.id, device: oldPhone, rep: "x", invoices: [{ id: "inv_x", total: 1, items: [] }] });
    check(soloSync.status === 403, "a solo buyer can't send invoices anywhere", `HTTP ${soloSync.status}`);
    await post("/api/console/contact", { contact: "the seller on WhatsApp 876 555 0100" }, token);
    const big = await (await post("/api/console/buyers", { name: "Big Team Ltd", devices: 25, amount: 2500, kind: "team" }, token)).json();
    check(big.repLinks.length === 25 && new Set(big.repLinks).size === 25 && Boolean(big.bossLink), "a 25-rep team gets 25 separate rep links and one boss link", `${big.repLinks.length} rep links`);

    // ── The console: Solo or Team ───────────────────────────────────────────────────────────────────────────────
    const owner = await browser.newContext({ ...PHONE });
    const con = await owner.newPage();
    watch(con, "console");
    await con.goto(`${BASE}/console`);
    await con.evaluate((t) => sessionStorage.setItem("marlon.console", t), token);
    await con.reload();
    await con.waitForSelector(".con-new");
    check(await con.locator(".con-kind input[value='solo']").isChecked(), "a new buyer is Solo unless you pick Team");
    await con.locator(".con-kind", { hasText: "Team" }).click();
    check(/sales reps/.test(await con.textContent(".con-devices legend")), "picking Team asks how many sales reps", await con.textContent(".con-devices legend"));
    await con.fill("#con-buyer-name", "Island Fresh Distributors");
    await con.locator(".con-chips input[value='2']").check();
    await con.fill("#con-amount", "500");
    await con.screenshot({ path: path.join(OUT, "team-1-new-team.png") });
    await con.click(".con-new button[type=submit]");
    await con.waitForSelector(".con-created .con-boss-link .con-link");
    const repLinks = await con.locator(".con-created .con-rep-link .con-link").evaluateAll((xs) => xs.map((x) => x.value));
    const bossLink = await con.inputValue(".con-created .con-boss-link .con-link");
    check(repLinks.length === 2 && new Set(repLinks).size === 2 && repLinks.every((l) => /\/\?k=[0-9a-f]{32}$/.test(l)) && /\/boss\?b=[0-9a-f]{32}$/.test(bossLink),
      "a 2-rep team gets a boss link and a separate personal link for each rep", `${repLinks.join(" | ")} | ${bossLink}`);
    await con.locator(".con-created .con-copy-all").click();
    const copied = await con.waitForFunction(() => /Copied/.test(document.querySelector(".con-created .con-copy-all")?.textContent || ""), null, { timeout: 3000 }).then(() => true, () => false);
    check(copied, "'Copy all rep links + boss link' copies them as one message to send");
    const repLink = repLinks[0];
    await con.screenshot({ path: path.join(OUT, "team-2-links.png") });
    const teamId = (await (await fetch(`${BASE}/api/console/buyers`, { headers: { Authorization: `Bearer ${token}` } })).json()).buyers.find((b) => b.name === "Island Fresh Distributors").id;

    // ── Rep A: name at setup, works offline, sends when online ──────────────────────────────────────────────────
    const ctxA = await browser.newContext({ ...PHONE });
    const A = await ctxA.newPage();
    watch(A, "rep A");
    await A.goto(repLink);
    await A.waitForSelector("#setup-rep");
    check(/sent to your company's boss dashboard/.test(await A.textContent(".setup-privacy")), "a team rep's setup says invoices go to the boss");
    await A.fill("#setup-rep", "Andre Brown");
    await setUp(A);
    await A.evaluate(() => navigator.serviceWorker.ready);
    await A.waitForTimeout(800);
    await ctxA.setOffline(true);
    await makeInvoice(A, "Bay Market", [["Mango Juice", 12, 250]]);
    await A.waitForTimeout(9000); // longer than the 8-second sending cycle
    const countOf = async () => (await (await fetch(`${BASE}/api/console/buyers`, { headers: { Authorization: `Bearer ${token}` } })).json()).buyers.find((b) => b.id === teamId).invoices;
    check(await countOf() === 0 && await A.textContent("#grand-amount") === "$3,000.00", "offline: the invoice is made and saved on the phone; nothing is sent yet");
    await A.reload();
    await A.waitForFunction(() => window.__appReady === true);
    check(await A.inputValue("#store") === "Bay Market", "…it's still there after closing and opening the app offline");
    await ctxA.setOffline(false);
    await A.evaluate(() => window.dispatchEvent(new Event("online")));
    let n = 0;
    for (let i = 0; i < 30 && (n = await countOf()) < 1; i++) await A.waitForTimeout(500);
    check(n === 1, "back online: the waiting invoice is sent to the boss by itself", `${n} on the server`);
    await makeInvoice(A, "Hill Top Grocery", [["Coconut Water", 10, 180], ["Eggs", 2, 480]]);
    await markPaid(A, "Bay Market");

    // ── Rep B, and a third phone ────────────────────────────────────────────────────────────────────────────────
    const ctxB = await browser.newContext({ ...PHONE });
    const B = await ctxB.newPage();
    watch(B, "rep B");
    await B.goto(repLinks[1]);
    await B.waitForSelector("#setup-rep");
    await B.fill("#setup-rep", "Bianca Grant");
    await setUp(B);
    await makeInvoice(B, "Corner Shop", [["Ginger Beer", 24, 150]]);
    const ctxC = await browser.newContext({ ...PHONE });
    const C = await ctxC.newPage();
    await C.goto(repLinks[0]);
    await C.waitForSelector(".gate[data-reason='full']");
    check(/already in use/.test(await C.textContent(".gate")), "Andre's link passed to someone else: their phone is blocked (it's locked to Andre's phone)");
    await ctxC.close();
    for (let i = 0; i < 40 && (n = await countOf()) < 3; i++) await A.waitForTimeout(500);
    check(n === 3, "every invoice from both reps reaches the server (no doubles)", `${n} invoices`);

    // ── The boss ────────────────────────────────────────────────────────────────────────────────────────────────
    const ctxBoss = await browser.newContext({ ...PHONE });
    const boss = await ctxBoss.newPage();
    watch(boss, "boss");
    await boss.goto(bossLink);
    await boss.waitForSelector("#boss-pass2");
    check(/Island Fresh Distributors/.test(await boss.textContent("#boss")), "the boss link opens the boss dashboard on his phone, asking him to set his passcode");
    check(/\/boss\?b=[0-9a-f]{32}$/.test(boss.url()), "the boss link stays in the address (a Home Screen icon made from it opens the same dashboard)", boss.url());
    await boss.fill("#boss-pass", "boss-secret-1");
    await boss.fill("#boss-pass2", "boss-secret-1");
    await boss.click("button[type=submit]");
    await boss.waitForSelector("#boss-reps");
    await boss.waitForTimeout(300);
    const today = localISO();
    const invTexts = await boss.locator(".boss-inv").allInnerTexts();
    const bay = invTexts.find((t) => /Bay Market/.test(t)) || "", hill = invTexts.find((t) => /Hill Top Grocery/.test(t)) || "", corner = invTexts.find((t) => /Corner Shop/.test(t)) || "";
    check(invTexts.length === 3, "the boss sees every invoice from every rep", `${invTexts.length}`);
    check(/by Andre Brown/.test(bay) && /12 × Mango Juice/.test(bay) && /\$3,000\.00/.test(bay) && /Paid/.test(bay), "…which rep made it, the customer, the products, the total, and Paid", bay.replace(/\s+/g, " "));
    check(/by Andre Brown/.test(hill) && /10 × Coconut Water/.test(hill) && /2 dozen × Eggs/.test(hill) && /\$2,760\.00/.test(hill) && /Not paid/.test(hill), "…and Not paid", hill.replace(/\s+/g, " "));
    check(/by Bianca Grant/.test(corner) && /\$3,600\.00/.test(corner), "…from the other rep too", corner.replace(/\s+/g, " "));
    const table = await boss.$$eval("#boss-reps tr", (rs) => rs.map((r) => [...r.children].map((c) => c.textContent.trim())));
    const andre = table.find((r) => r[0] === "Andre Brown"), bianca = table.find((r) => r[0] === "Bianca Grant"), company = table.find((r) => r[0] === "Whole company");
    check(andre && andre.slice(1).join("|") === "$5,760.00|$5,760.00|$5,760.00" && bianca && bianca.slice(1).join("|") === "$3,600.00|$3,600.00|$3,600.00"
      && company && company.slice(1).join("|") === "$9,360.00|$9,360.00|$9,360.00", "totals for today, this week and this month, per rep and for the whole company", JSON.stringify(table));
    check(await boss.textContent("[data-total='today']") === "$9,360.00", "…and the company's total for today at the top", await boss.textContent("[data-total='today']"));
    check(!/\bnull\b|\bundefined\b|NaN/.test(await boss.locator("#boss").innerText()), "no stray null/undefined/NaN text on the boss dashboard");
    await boss.screenshot({ path: path.join(OUT, "team-3-boss.png"), fullPage: true });
    await boss.selectOption("#boss-rep", { label: "Bianca Grant" });
    check(await boss.locator(".boss-inv").count() === 1, "the boss can look at one rep's invoices");
    await boss.selectOption("#boss-rep", "all");
    await boss.selectOption("#boss-status", "unpaid");
    check(await boss.locator(".boss-inv").count() === 2, "…or just the ones not paid yet");
    await boss.selectOption("#boss-status", "all");
    // ── The boss marks a rep's invoice paid; it shows on the rep's phone ───────────────────────────────────────
    check(await boss.locator("input, textarea").count() === 0 && await boss.locator(".boss-inv", { hasText: "Bay Market" }).locator(".boss-mark-paid").count() === 0,
      "the boss can't type anything (no invoice writing); 'Mark paid' only shows on invoices not paid yet");
    boss.once("dialog", (d) => d.accept());
    await boss.locator(".boss-inv", { hasText: "Hill Top Grocery" }).locator(".boss-mark-paid").click();
    await boss.waitForFunction(() => /Paid · marked by you/.test([...document.querySelectorAll(".boss-inv")].find((x) => /Hill Top/.test(x.textContent))?.textContent || ""));
    check(true, "the boss ticks Andre's Hill Top Grocery invoice as paid");
    await boss.screenshot({ path: path.join(OUT, "team-3b-boss-marked-paid.png") });
    await A.evaluate(() => window.__teamSync());
    const onRep = await A.evaluate(async () => (await (await import("/js/db.js")).invoices.all()).find((i) => i.store === "Hill Top Grocery").payment);
    check(onRep?.status === "paid" && onRep.markedBy === "boss", "…and it shows as paid on Andre's phone", JSON.stringify(onRep));
    const repView = await A.evaluate(async () => { const { paymentState } = await import("/js/payment.js"); const db = await import("/js/db.js"); return paymentState((await db.invoices.all()).find((i) => i.store === "Hill Top Grocery")).text; });
    check(/marked by your boss/.test(repView), "the rep's own dashboard says it was marked paid by the boss", repView);
    const aLic = await A.evaluate(async () => (await (await import("/js/db.js")).settings.get("license")));
    const stale = await post("/api/team/sync", { key: aLic.key, device: aLic.device, rep: "Andre Brown", invoices: [{ id: (await A.evaluate(async () => (await (await import("/js/db.js")).invoices.all()).find((i) => i.store === "Hill Top Grocery").id)), store: "Hill Top Grocery", total: 2760, items: [], payment: { status: "unpaid" } }] });
    check(stale.ok, "an old 'not paid' copy sent from a phone is accepted…");
    await boss.click("text=Refresh");
    await boss.waitForTimeout(400);
    check(/Paid · marked by you/.test(await boss.locator(".boss-inv", { hasText: "Hill Top Grocery" }).innerText()), "…but can't undo the boss's 'paid'");
    const write = await fetch(`${BASE}/api/boss/invoices`, { method: "POST", headers: { "content-type": "application/json" }, body: "{}" });
    check(write.status === 404, "there's no way for the boss to write invoices (the server has no such thing)", `HTTP ${write.status}`);
    // A change on a rep's phone (paid) reaches the boss.
    await markPaid(B, "Corner Shop");
    await B.waitForTimeout(9500);
    await boss.click("text=Refresh");
    await boss.waitForTimeout(500);
    check(/Paid/.test(await boss.locator(".boss-inv", { hasText: "Corner Shop" }).innerText()) && await countOf() === 3, "a rep marking an invoice paid updates the boss (still one copy of it)");
    // Offline: the last data.
    await ctxBoss.setOffline(true);
    await boss.reload().catch(() => {});
    await boss.waitForSelector(".boss-inv", { timeout: 8000 });
    check(/No connection/.test(await boss.textContent("#boss")) && await boss.locator(".boss-inv").count() === 3, "offline, the boss dashboard shows what it last loaded");
    await ctxBoss.setOffline(false);
    // Passcode needed again in a new session; wrong passcode refused.
    const boss2ctx = await browser.newContext({ ...PHONE });
    const boss2 = await boss2ctx.newPage();
    await boss2.goto(bossLink);
    await boss2.waitForSelector("#boss-pass");
    check(await boss2.locator("#boss-pass2").count() === 0, "the boss's passcode is already set: another phone has to enter it");
    await boss2.fill("#boss-pass", "wrong-guess");
    await boss2.click("button[type=submit]");
    await boss2.waitForSelector(".boss-error:not([hidden])");
    check(/isn't right/.test(await boss2.textContent(".boss-error")), "a wrong passcode is refused");
    const snoop = await fetch(`${BASE}/api/boss/data`, { headers: { Authorization: "Bearer " + "0".repeat(64) } });
    check(snoop.status === 401, "nobody gets the invoices without the boss's passcode");
    const third = await post("/api/boss/activate", { boss: new URL(bossLink).searchParams.get("b"), device: "d".repeat(32) });
    check(third.status === 403, "the boss link works on 2 boss phones at most (his browser and his Home Screen icon)", `HTTP ${third.status}`);
    await boss2ctx.close();

    // ── The owner console: boss phone and rep phones; switch off one rep, then the company ──────────────────────
    await con.reload();
    await con.waitForSelector(".con-team");
    const team = con.locator(".con-team", { hasText: "Island Fresh Distributors" });
    const teamText = (await team.innerText()).replace(/\s+/g, " ");
    check(/2 of 2 rep phones in use/.test(teamText) && /3 invoices sent to the boss/.test(teamText) && /Boss ·/.test(teamText) && /Andre Brown ·/.test(teamText) && /Bianca Grant ·/.test(teamText),
      "your dashboard shows the team: the boss phone and each rep phone by name", teamText.slice(0, 220));
    await team.screenshot({ path: path.join(OUT, "team-4-console-team.png") });
    con.once("dialog", (d) => d.accept());
    await team.locator(".con-phone", { hasText: "Andre Brown" }).getByRole("button", { name: "Switch off" }).click();
    await con.waitForFunction(() => /1 of 2 rep phones in use/.test([...document.querySelectorAll(".con-team")].find((x) => /Island Fresh/.test(x.textContent))?.textContent || ""));
    await A.reload();
    await A.waitForSelector(".gate[data-reason='off']", { timeout: 8000 });
    const repA = await A.evaluate(async () => (await (await import("/js/db.js")).settings.get("license")));
    const refused = await post("/api/team/sync", { key: repA.key, device: repA.device, rep: "Andre Brown", invoices: [{ id: "inv_late", total: 5, items: [] }] });
    check(refused.status === 403, "one rep switched off: that phone is blocked and can't send invoices", `sync HTTP ${refused.status}`);
    await B.reload();
    await B.waitForFunction(() => window.__appReady === true);
    check(await B.locator("#invoice-screen").isVisible(), "…while the other rep keeps working");
    // Replace a rep's link: the old link dies and the phone on it is switched off; the new link works on a new phone.
    con.once("dialog", (d) => d.accept());
    await con.locator(".con-team", { hasText: "Island Fresh Distributors" }).locator(".con-slot[data-n='2']").getByRole("button", { name: "Replace link" }).click();
    await con.waitForFunction(() => /Link not opened yet/.test([...document.querySelectorAll(".con-team")].find((x) => /Island Fresh/.test(x.textContent))?.querySelector(".con-slot[data-n='2']")?.textContent || ""));
    await B.reload();
    await B.waitForSelector(".gate[data-reason='off']", { timeout: 8000 });
    const dead = await post("/api/activate", { key: new URL(repLinks[1]).searchParams.get("k"), device: "9".repeat(32) });
    check((await dead.json()).reason === "unknown", "Replace link: the old link stops working and the phone on it is switched off");
    const fresh = (await (await fetch(`${BASE}/api/console/buyers`, { headers: { Authorization: `Bearer ${token}` } })).json()).buyers.find((b) => b.id === teamId).slots.find((x) => x.n === 2).key;
    check((await (await post("/api/activate", { key: fresh, device: "8".repeat(32) })).json()).ok, "…and the new link works on the rep's new phone");
    // ── One phone, already set up as a solo business, opens a rep link: it asks, then switches to the team ───────
    const solo = await (await post("/api/console/buyers", { name: "Test Company", devices: 2, amount: 1 }, token)).json();
    const ctxS = await browser.newContext({ ...PHONE });
    const S = await ctxS.newPage();
    watch(S, "solo-then-rep phone");
    await S.goto(solo.link);
    await setUp(S, { name: "Test Company", address: "", phone: "", products: [{ name: "Juice", price: "100", unit: "each" }] });
    const freshSlot = new URL(big.repLinks[1]).searchParams.get("k"); // Big Team Ltd's Rep 2 link, not opened yet
    await S.goto(`${BASE}/?k=${freshSlot}`);
    await S.waitForSelector(".gate[data-reason='switch']");
    const sw = (await S.textContent(".gate")).replace(/\s+/g, " ");
    check(/set up for Test Company/.test(sw) && /Big Team Ltd \(rep 2\)/.test(sw), "a phone already set up as Test Company that opens Rep 2's link: it says so and asks (no longer silently opens Test Company)", sw.slice(0, 160));
    await S.screenshot({ path: path.join(OUT, "team-6-switch.png") });
    S.once("dialog", (d) => d.accept());
    await S.click(".gate-switch");
    await S.waitForSelector("#setup-rep", { timeout: 10000 });
    check(await S.inputValue("#setup-name") === "Big Team Ltd" && await S.getAttribute("#setup-name", "readonly") !== null && await S.locator(".prod-row").count() === 0,
      "after switching: it opens as a rep of the team (company filled in and locked), with Test Company's products gone");
    await S.fill("#setup-rep", "Carla Reid");
    await setUp(S, { name: "Big Team Ltd", address: "", phone: "", products: [{ name: "Mango Juice", price: "250", unit: "each" }] });
    check(await S.textContent("#company-name") === "Big Team Ltd", "…and works as that rep");
    const m = await (await fetch(`${BASE}/manifest.webmanifest?k=${freshSlot}`)).json();
    check(m.id === `/?k=${freshSlot}` && m.start_url === `/?k=${freshSlot}`, "on an iPhone, each personal link installs as its own Home Screen app (its own identity and storage)", JSON.stringify({ id: m.id, start: m.start_url }));
    // Keep: opening another link and choosing to keep the current business changes nothing.
    await S.goto(solo.link);
    await S.waitForSelector(".gate[data-reason='switch']");
    await S.click(".gate-keep");
    await S.waitForFunction(() => window.__appReady === true && document.getElementById("company-name")?.textContent === "Big Team Ltd", null, { timeout: 8000 });
    check(!S.url().includes("k="), "choosing 'Keep' leaves the phone as it was");
    // The boss page keeps its link in the address (so a Home Screen icon of it opens the same dashboard).
    await ctxS.close();
    await con.reload();
    await con.waitForSelector(".con-team");
    await con.locator(".con-team", { hasText: "Island Fresh Distributors" }).screenshot({ path: path.join(OUT, "team-4b-console-reps.png") });
    con.once("dialog", (d) => d.accept());
    await con.locator(".con-team", { hasText: "Island Fresh Distributors" }).getByRole("button", { name: "Switch off whole company" }).click();
    await con.locator(".con-team.is-off", { hasText: "Island Fresh Distributors" }).waitFor();
    await boss.reload();
    await boss.waitForSelector("[data-reason='blocked']", { timeout: 8000 });
    await B.reload();
    await B.waitForSelector(".gate[data-reason='off']", { timeout: 8000 });
    check(true, "whole company switched off: the boss and every rep are blocked");
    await boss.screenshot({ path: path.join(OUT, "team-5-boss-switched-off.png") });

    check(errors.length === 0, "no page errors", errors.join(" | "));
    for (const c of [ctxA, ctxB, ctxBoss, owner]) await c.close();
  } finally {
    await browser.close();
    if (w) await w.stop();
    fs.rmSync(stateDir, { recursive: true, force: true });
  }
  console.log(failures ? `\n${failures} check(s) failed` : "\nAll team checks passed");
  process.exit(failures ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
