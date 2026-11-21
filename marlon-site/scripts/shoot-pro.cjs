/**
 * Takes the website's Marlon Pro screenshots from the REAL app (marlon-app's Worker under `wrangler dev`, with a stand-in
 * for Google's Gemini), using a made-up sample business with realistic US-dollar prices:
 *   public/media/pro-accountant.webp    the accountant summary. The script refuses to save it unless, for every quarter
 *                                       and the year, gross − returns = net AND received + not yet paid = net.
 *   public/media/pro-order-form.webp    Shelf Order: the order form filled in from the shelf count (target − shelf)
 *   public/media/pro-order.webp         Shelf Order: the saved order as the driver shows it (who ordered, signature)
 * Nothing in marlon-app is changed: it is only run.   Usage: node scripts/shoot-pro.cjs
 */
const { chromium } = require("playwright");
const { spawn, spawnSync } = require("child_process");
const http = require("http"), path = require("path"), fs = require("fs"), os = require("os"), crypto = require("crypto");
const APP = path.join(__dirname, "..", "..", "marlon-app"), OUT = path.join(__dirname, "..", "public", "media");
const { setUp } = require(path.join(APP, "tests", "fixture.cjs"));
const PORT = 8841, GPORT = 8842, BASE = `http://localhost:${PORT}`;
const WRANGLER = path.join(APP, "..", "chief-of-staff", "node_modules", ".bin", "wrangler");
const post = (p, body, token) => fetch(BASE + p, { method: "POST", headers: { "content-type": "application/json", ...(token ? { Authorization: `Bearer ${token}` } : {}) }, body: JSON.stringify(body) });

const SAMPLE = {
  name: "Sample Foods (demo)", address: "Demo address only", phone: "+1 000 000 0000",
  products: [
    { name: "Mango Juice", price: "2.50", unit: "each" }, { name: "Coconut Water", price: "1.80", unit: "each" }, { name: "Eggs", price: "4.80", unit: "dozen" },
    { name: "Sweet Potato", price: "1.20", unit: "lb" }, { name: "Ginger Beer", price: "1.50", unit: "each" }, { name: "Hard Dough Bread", price: "3.20", unit: "each" },
  ],
};
// A year of sales, in date order. ["inv", date, store, [[product, qty]], paid?] and ["cn", date, store, [[product, qty, reason]]].
// Every credit note is used up by the same store's next invoice in the same quarter, so the figures reconcile.
const YEAR = [
  ["inv", "2026-01-12", "Bay Market", [["Mango Juice", 24], ["Eggs", 10]], true],
  ["inv", "2026-02-03", "Hill Top Grocery", [["Coconut Water", 40], ["Sweet Potato", 30]], true],
  ["inv", "2026-03-09", "Corner Shop", [["Mango Juice", 36], ["Hard Dough Bread", 20]], true],
  ["inv", "2026-04-14", "Bay Market", [["Mango Juice", 48], ["Eggs", 12]], true],
  ["cn", "2026-05-02", "Bay Market", [["Mango Juice", 6, "expired"]]],
  ["inv", "2026-05-20", "Bay Market", [["Mango Juice", 30], ["Coconut Water", 20]], true],
  ["inv", "2026-06-11", "Hill Top Grocery", [["Sweet Potato", 50], ["Ginger Beer", 24]], true],
  ["inv", "2026-07-08", "Corner Shop", [["Mango Juice", 60], ["Hard Dough Bread", 30]], true],
  ["inv", "2026-08-19", "Hill Top Grocery", [["Coconut Water", 60], ["Eggs", 15]], true],
  ["cn", "2026-09-02", "Hill Top Grocery", [["Eggs", 2, "damaged"]]],
  ["inv", "2026-09-16", "Hill Top Grocery", [["Ginger Beer", 40], ["Sweet Potato", 40]], true],
  ["inv", "2026-10-06", "Bay Market", [["Mango Juice", 72], ["Eggs", 20]], true],
  ["cn", "2026-10-20", "Bay Market", [["Mango Juice", 8, "expired"]]],
  ["inv", "2026-11-03", "Bay Market", [["Mango Juice", 48], ["Coconut Water", 30]], false],
  ["inv", "2026-11-12", "Corner Shop", [["Hard Dough Bread", 40], ["Ginger Beer", 24]], false],
];

function startGemini() {
  const srv = http.createServer((req, res) => {
    req.on("data", () => {}); req.on("end", () => {
      const answer = { products: [{ name: "Mango Juice", count: 7 }, { name: "Coconut Water", count: 4 }, { name: "Eggs", count: 3 }] };
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ candidates: [{ content: { parts: [{ text: JSON.stringify(answer) }] } }] }));
    });
  });
  return new Promise((ok) => srv.listen(GPORT, () => ok(srv)));
}
function startWorker(stateDir) {
  const vars = { ALLOW_TEST_CLOCK: "1", GEMINI_BASE: `http://localhost:${GPORT}`, GEMINI_API_KEY: "sample-key", ENCRYPTION_KEY: crypto.randomBytes(32).toString("base64") };
  const child = spawn(WRANGLER, ["dev", "--port", String(PORT), "--persist-to", stateDir, "--show-interactive-dev-session=false", "--log-level", "warn",
    ...Object.entries(vars).flatMap(([k, v]) => ["--var", `${k}:${v}`])], { cwd: APP, env: { ...process.env, WRANGLER_SEND_METRICS: "false", CLOUDFLARE_API_TOKEN: "placeholder-not-used-locally" }, stdio: "ignore" });
  return { child, ready: (async () => { for (let i = 0; i < 120; i++) { try { if ((await fetch(`${BASE}/api/console/state`)).status) return; } catch {} await new Promise((r) => setTimeout(r, 500)); } throw new Error("wrangler dev didn't start"); })() };
}
async function signOn(page, selector) {
  await page.locator(selector).scrollIntoViewIfNeeded();
  const b = await page.locator(selector).boundingBox();
  await page.mouse.move(b.x + 40, b.y + b.height * 0.62); await page.mouse.down();
  for (let i = 1; i <= 22; i++) await page.mouse.move(b.x + 40 + i * 11, b.y + b.height * 0.62 - Math.sin(i / 2.2) * 34);
  await page.mouse.up();
}
async function toWebp(png, name, { top = 0, height = null } = {}) {
  const py = spawnSync("python3", ["-c", `
import sys
from PIL import Image
im = Image.open(sys.argv[1]).convert("RGB")
top, h = int(sys.argv[3]), int(sys.argv[4])
im = im.crop((0, top, im.width, min(im.height, top + h) if h > 0 else im.height))
im = im.resize((600, round(im.height * 600 / im.width)), Image.LANCZOS)
im.save(sys.argv[2], "WEBP", quality=82, method=6)
print(im.size)`, png, path.join(OUT, name), String(top), String(height || 0)], { encoding: "utf8" });
  if (py.status !== 0) throw new Error(py.stderr);
  console.log(name, py.stdout.trim());
}

(async () => {
  spawnSync(process.execPath, [path.join(APP, "scripts", "build-worker.cjs")], { cwd: APP });
  const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), "marlon-shots-")), tmp = fs.mkdtempSync(path.join(os.tmpdir(), "marlon-png-"));
  const g = await startGemini(), w = startWorker(stateDir);
  const browser = await chromium.launch();
  try {
    await w.ready;
    const token = (await (await post("/api/console/claim", { passcode: "sample-passcode" })).json()).token;
    const buyer = (await (await post("/api/console/buyers", { name: SAMPLE.name, devices: 1, amount: 79 }, token)).json()).buyer;
    await post("/api/console/pro", { id: buyer.id, pro: true, reps: 1, discountPct: 0 }, token);
    const ctx = await browser.newContext({ viewport: { width: 390, height: 844 }, deviceScaleFactor: 2, isMobile: true, hasTouch: true, bypassCSP: true });
    await ctx.addInitScript(() => { navigator.canShare = () => true; navigator.share = async () => {}; });
    const page = await ctx.newPage();
    const errors = []; page.on("pageerror", (e) => errors.push(e.message));
    await page.goto(`${BASE}/?k=${buyer.id}`);
    await setUp(page, SAMPLE);
    await page.waitForSelector("#pro-orders");

    // ── A year of realistic sales, entered through the app's own storage ──
    const sums = await page.evaluate(async (year) => {
      const db = await import("/js/db.js"), util = await import("/js/util.js"), rep = await import("/js/pro-report.js");
      const prods = await db.products.all();
      const item = (name, qty) => { const p = prods.find((x) => x.name === name); return { productId: p.id, name, qty, unit: p.unit, price: p.price }; };
      const sig = (() => { const c = document.createElement("canvas"); c.width = 300; c.height = 100; const x = c.getContext("2d"); x.lineWidth = 4; x.beginPath(); x.moveTo(10, 70); x.bezierCurveTo(80, 0, 150, 120, 290, 30); x.stroke(); return c.toDataURL("image/png"); })();
      for (const [kind, date, store, lines, paid] of year) {
        if (kind === "cn") { await db.credits.create({ store, date, lines: lines.map(([n, q, reason]) => ({ ...item(n, q), reason })), signature: sig }); continue; }
        const inv = await db.invoices.put({ store, address: "", date, items: lines.map(([n, q]) => item(n, q)), signature: null });
        const due = new Date(date + "T12:00:00"); due.setDate(due.getDate() + 14);
        await db.invoices.setPayment(inv.id, paid ? { status: "paid", method: "cash", termsDays: 0, dueDate: null, recordedAt: date + "T12:00:00.000Z", paidAt: date + "T12:00:00.000Z" }
          : { status: "unpaid", method: "terms", termsDays: 14, dueDate: due.toISOString().slice(0, 10), recordedAt: date + "T12:00:00.000Z", paidAt: null });
        await db.invoices.put({ ...(await db.invoices.get(inv.id)), signature: sig }); // signed by the store: keeps its credit
      }
      const s = rep.accountantSummary({ invoices: (await db.invoices.all()).map(util.withTotals), credits: await db.credits.all(), year: 2026 });
      return [...s.quarters, { q: "Year", ...s.total }].map((q) => ({ q: q.q, gross: q.gross, returns: q.returns, net: q.net, received: q.received, unpaid: q.unpaid }));
    }, YEAR);
    const c = (n) => Math.round(n * 100);
    const bad = sums.filter((q) => c(q.gross) - c(q.returns) !== c(q.net) || c(q.received) + c(q.unpaid) !== c(q.net));
    for (const q of sums) console.log(`${q.q}: gross ${q.gross.toFixed(2)} − returns ${q.returns.toFixed(2)} = net ${q.net.toFixed(2)} · received ${q.received.toFixed(2)} + not yet paid ${q.unpaid.toFixed(2)} = ${(q.received + q.unpaid).toFixed(2)}`);
    if (bad.length) throw new Error(`The sample doesn't reconcile for ${bad.map((q) => q.q).join(", ")}: not saving the screenshot.`);

    // ── Accountant summary (owner dashboard → Pro) ──
    await page.click("#owner-link");
    await page.waitForSelector(".dash-key");
    const pin = async () => { for (const d of "2468") await page.locator(`.dash-key[aria-label="${d}"]`).click(); };
    await pin(); await page.getByRole("button", { name: "Continue" }).click(); await page.waitForSelector("text=Enter the same PIN again"); await pin();
    await page.waitForSelector(".dash-kpi");
    await page.getByRole("tab", { name: "Pro" }).click();
    await page.waitForSelector("#dash-accountant .pro-q.is-year");
    await page.addStyleTag({ content: ".dash-tabs, .dash-head, header { position: static !important; } .toast, [role=status].toast { display: none !important; }" }); // (sticky bars would sit over the capture)
    await page.locator("#dash-accountant").screenshot({ path: path.join(tmp, "acct.png") });
    await toWebp(path.join(tmp, "acct.png"), "pro-accountant.webp");
    await page.goto(`${BASE}/#/`); await page.reload(); await page.waitForFunction(() => window.__appReady === true);
    await page.waitForSelector("#pro-shelf");

    // ── Shelf photo → Make an order ──
    await page.click("#pro-shelf");
    await page.waitForSelector("dialog.pro-shelf[open]");
    await page.fill("#shelf-store", "Bay Market");
    const b64 = await page.evaluate(() => { const cv = document.createElement("canvas"); cv.width = 2000; cv.height = 1300; const x = cv.getContext("2d"); x.fillStyle = "#c9b48a"; x.fillRect(0, 0, 2000, 1300);
      for (let i = 0; i < 10; i++) { x.fillStyle = i % 2 ? "#f2a31b" : "#3a7d44"; x.fillRect(70 + i * 190, 260, 150, 560); } return cv.toDataURL("image/jpeg", 0.9).split(",")[1]; });
    await page.setInputFiles("#shelf-file", { name: "shelf.jpg", mimeType: "image/jpeg", buffer: Buffer.from(b64, "base64") });
    await page.waitForSelector(".shelf-out .shelf-order", { timeout: 15000 }).catch(async (e) => { throw new Error(`shelf result: ${(await page.textContent(".shelf-out")).trim()} | ${e.message.split("\n")[0]}`); });
    await page.click(".shelf-out .shelf-order");
    await page.waitForSelector("dialog.pro-order[open]");
    await page.fill("#ord-all-target", "24"); await page.locator("#ord-all-target").dispatchEvent("change");
    await page.fill("#ord-signer", "Store manager (sample)");
    await signOn(page, "#ord-sign");
    await page.waitForFunction(() => !document.getElementById("ord-save").disabled);
    await page.evaluate(() => document.querySelector("dialog.pro-order .pro-body").scrollTo(0, 0));
    await page.screenshot({ path: path.join(tmp, "form.png") });
    await toWebp(path.join(tmp, "form.png"), "pro-order-form.webp");
    await page.click("#ord-save");
    await page.waitForSelector("dialog.pro-order.is-done");
    await page.click("#ord-done");
    await page.click("#pro-orders");
    await page.waitForSelector(".ord-row");
    await page.click(".ord-row");
    await page.waitForSelector("dialog.pro-order-view[open]");
    await page.screenshot({ path: path.join(tmp, "order.png") });
    await toWebp(path.join(tmp, "order.png"), "pro-order.webp");
    if (errors.length) throw new Error("page errors: " + errors.join(" | "));
  } finally {
    await browser.close(); w.child.kill("SIGTERM"); g.close();
    fs.rmSync(stateDir, { recursive: true, force: true });
  }
  console.log("screenshots saved; working copies in", tmp);
})().catch((e) => { console.error(e); process.exit(1); });
