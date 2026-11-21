/**
 * "Send for signature", end to end with the real Worker (wrangler dev, local SQLite) and real phones (a seller's,
 * and a buyer's in another town with no app):
 *   - the seller makes an invoice and taps "Send for signature": a long secret link, saved and locked on the server;
 *   - the buyer opens the link with no login: the full invoice, read-only; only a name and a signature can be added;
 *   - the server enforces the lock: extra fields, a changed copy, or anything after signing are refused;
 *   - after signing: thank-you with the checkmark, "Signed by … on …", a PDF; the link then only shows the signed copy;
 *   - the seller's phone gets the signed copy by itself (exactly what was signed), with a message, and it's locked
 *     for good, also against changes saved straight into the phone's storage; the dashboard shows Sent/Opened/Signed;
 *   - links that aren't signed expire after 7 days (test clock), and the seller can send a new one; cancel works;
 *   - names and signatures are encrypted at rest, and no one else's phone can see another seller's invoices.
 */
const { spawn, spawnSync } = require("child_process");
const fs = require("fs"), os = require("os"), path = require("path"), crypto = require("crypto");
const { chromium } = require("playwright");
const { setUp } = require("./fixture.cjs");

const PORT = 8806, BASE = `http://localhost:${PORT}`;
const APP = path.join(__dirname, ".."), OUT = path.join(__dirname, "output");
const WRANGLER = path.join(APP, "..", "chief-of-staff", "node_modules", ".bin", "wrangler");
const KEY = crypto.randomBytes(32).toString("base64");
let failures = 0;
const check = (ok, name, extra = "") => { console.log(`${ok ? "PASS" : "FAIL"}  ${name}${extra ? "  — " + extra : ""}`); if (!ok) failures++; };
const SELLER = { name: "Sarah's Beauty", address: "12 Market Street, Ocho Rios", phone: "", products: [{ name: "Lip Gloss", price: "12.50", unit: "each" }, { name: "Hair Oil", price: "20", unit: "each" }, { name: "Face Cream", price: "35", unit: "each" }] };
const PHONE = { viewport: { width: 390, height: 844 }, deviceScaleFactor: 2, isMobile: true, hasTouch: true };
const post = async (p, body, headers = {}) => { const r = await fetch(BASE + p, { method: "POST", headers: { "content-type": "application/json", ...headers }, body: JSON.stringify(body) }); return { status: r.status, data: await r.json().catch(() => ({})) }; };
const row = (page, name) => page.locator(".prod-row", { hasText: name }).first();

function startWorker(stateDir) {
  const log = [];
  const child = spawn(WRANGLER, ["dev", "--port", String(PORT), "--persist-to", stateDir, "--show-interactive-dev-session=false", "--log-level", "warn", "--var", `ENCRYPTION_KEY:${KEY}`, "--var", "ALLOW_TEST_CLOCK:1"],
    { cwd: APP, env: { ...process.env, WRANGLER_SEND_METRICS: "false", CLOUDFLARE_API_TOKEN: "placeholder-not-used-locally" }, stdio: ["ignore", "pipe", "pipe"] });
  child.stdout.on("data", (d) => log.push(String(d))); child.stderr.on("data", (d) => log.push(String(d)));
  const ready = (async () => { for (let i = 0; i < 120; i++) { try { if ((await fetch(`${BASE}/api/console/state`)).status) return; } catch { /* not yet */ } await new Promise((ok) => setTimeout(ok, 500)); } throw new Error(log.join("")); })();
  return { ready, log, stop: () => new Promise((ok) => { child.once("exit", ok); child.kill("SIGTERM"); setTimeout(() => { child.kill("SIGKILL"); ok(); }, 5000); }) };
}
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
  await page.waitForTimeout(900);
}
const current = (page) => page.evaluate(async () => { const db = await import("/js/db.js"); const id = await db.settings.get("currentId"); return db.invoices.get(id); });
async function sign(page, name) {
  await page.fill("#sg-name", name);
  const box = await page.locator(".sg-canvas").boundingBox();
  await page.mouse.move(box.x + 30, box.y + 110); await page.mouse.down();
  for (let i = 1; i <= 12; i++) await page.mouse.move(box.x + 30 + i * 20, box.y + 110 - Math.sin(i / 2) * 40);
  await page.mouse.up();
}

(async () => {
  fs.mkdirSync(OUT, { recursive: true });
  check(spawnSync(process.execPath, [path.join(APP, "scripts", "build-worker.cjs")], { cwd: APP }).status === 0, "the app packs into the Worker");
  const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), "marlon-sign-"));
  const w = startWorker(stateDir);
  const browser = await chromium.launch();
  const errors = [];
  const watch = (p, who) => p.on("pageerror", (e) => errors.push(`${who}: ${e.message}`));
  try {
    await w.ready;
    const maker = (await post("/api/console/claim", { passcode: "maker-pass-123" })).data.token;
    const auth = { Authorization: `Bearer ${maker}` };
    const A = (await post("/api/console/buyers", { name: "Sarah's Beauty", devices: 1, amount: 50 }, auth)).data;
    const B = (await post("/api/console/buyers", { name: "Other Seller", devices: 1, amount: 50 }, auth)).data;

    // ── The seller sends an invoice ────────────────────────────────────────────────────────────────────────
    const sctx = await browser.newContext({ ...PHONE, permissions: ["clipboard-read", "clipboard-write"] });
    const S = await sctx.newPage(); watch(S, "seller");
    await S.goto(A.link);
    await setUp(S, SELLER);
    await makeInvoice(S, "Jada Brown", [["Lip Gloss", 3, "12.50"], ["Hair Oil", 1, "20"]]);
    await S.locator("#send-sign-btn").scrollIntoViewIfNeeded();
    await S.click("#send-sign-btn");
    await S.waitForSelector("#remote-status.is-sent", { timeout: 10000 });
    const inv1 = await current(S);
    const link = inv1.remote?.link || "";
    check(/^http:\/\/localhost:8806\/s\/[0-9a-f]{64}$/.test(link), "'Send for signature' makes a unique, hard-to-guess link (256-bit random) and offers it to share", link.replace(/[0-9a-f]{56}$/, "…"));
    const clip = await S.evaluate(() => navigator.clipboard.readText()).catch(() => "");
    check(clip.includes(link) && /please check and sign your invoice from Sarah's Beauty/.test(clip), "with no share sheet (desktop test browser), the link and a short message are copied, ready to paste into WhatsApp or Instagram", clip.slice(0, 90));
    const sentText = await S.textContent("#remote-status");
    check(/Sent for signature, waiting for Jada Brown/.test(sentText) && await S.isHidden("#send-sign-btn"), "the seller sees 'Sent for signature, waiting for Jada Brown'", `${sentText} | send button hidden: ${await S.isHidden("#send-sign-btn")}`);
    await S.screenshot({ path: path.join(OUT, "sign-1-seller-sent.png") });
    // While it's waiting, the seller can't quietly change it.
    await S.evaluate(() => window.scrollTo(0, 0));
    await S.click("#store");
    await S.waitForSelector("dialog[open]");
    check(/Cancel link and edit/.test(await S.textContent("dialog[open]")), "while the buyer has the link, changing the invoice first asks to cancel the link");
    await S.click("dialog[open] button:has-text('Keep it')");
    await S.waitForTimeout(300);

    // ── The buyer opens the link on their own phone, with no app and no login ────────────────────────────
    const bctx = await browser.newContext({ ...PHONE, acceptDownloads: true });
    const P = await bctx.newPage(); watch(P, "buyer");
    await P.goto(link);
    await P.waitForSelector(".sg-invoice");
    const page = (await P.innerText("#sg")).replace(/\s+/g, " ");
    check(/Sarah's Beauty sent you this invoice to sign/.test(page) && /Jada Brown/.test(page) && /Lip Gloss 3 \$12\.50 \$37\.50/.test(page) && /Hair Oil 1 \$20\.00 \$20\.00/.test(page) && /Total \$57\.50/.test(page),
      "the buyer sees the full invoice: seller, buyer, items, quantities, prices and the total ($57.50)");
    check(await P.locator("#sg input").count() === 1 && await P.locator("#sg textarea, #sg select, [contenteditable]").count() === 0 && await P.locator(".sg-invoice input").count() === 0,
      "everything on the invoice is read-only: the only field is the buyer's own name (plus the signature box)");
    check(await P.isDisabled(".sg-go"), "'Sign and confirm' stays off until they type their name and sign");
    await P.screenshot({ path: path.join(OUT, "sign-2-buyer-open.png"), fullPage: true });
    const token = link.split("/s/")[1];
    const view = (await post("/api/sign/view", { token })).data;
    await S.evaluate(async () => (await import("/js/remote.js")).checkNow());
    check((await current(S)).remote.state === "opened" && /Opened by the buyer/.test(await S.textContent("#remote-status")), "the seller sees it was opened");

    // ── The lock is on the server ─────────────────────────────────────────────────────────────────────────
    const png = "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==";
    let r = await post("/api/sign/submit", { token, name: "Jada Brown", signature: png, digest: view.digest, invoice: { ...view.invoice, total: 1 } });
    check(r.status === 400, "sending a changed invoice with the signature is refused (only name and signature are accepted)", `${r.status}`);
    r = await post("/api/sign/submit", { token, name: "Jada Brown", signature: png, digest: crypto.createHash("sha256").update(JSON.stringify({ ...view.invoice, total: 1 })).digest("hex") });
    check(r.status === 409, "signing a different version than the one that was sent is refused", `${r.status}`);
    for (const m of ["PUT", "PATCH", "DELETE"]) { const x = await fetch(`${BASE}/api/sign/view`, { method: m, body: "{}" }); if (x.status < 400) check(false, `no ${m} on signing links`); }
    check((await post("/api/sign/view", { token: crypto.randomBytes(32).toString("hex") })).status === 404, "a made-up link finds nothing");
    const bdev = "b".repeat(32);
    await post("/api/activate", { key: B.buyer.id, device: bdev });
    const other = await post("/api/sign/status", { key: B.buyer.id, device: bdev, ack: [] });
    check(other.status === 200 && other.data.links.length === 0, "another seller's phone sees none of this seller's invoices");
    check((await post("/api/sign/status", { key: A.buyer.id, device: bdev, ack: [] })).status === 403 && (await post("/api/sign/create", { key: A.buyer.id, device: bdev, invoice: view.invoice })).status === 403, "a phone that isn't this seller's can't read their statuses or send in their name");

    // ── The buyer signs ───────────────────────────────────────────────────────────────────────────────────
    await sign(P, "Jada Brown");
    check(await P.isEnabled(".sg-go"), "after typing a name and signing, 'Sign and confirm' turns on");
    await P.click(".sg-go");
    await P.waitForSelector(".sg-done");
    const done = (await P.textContent("#sg")).replace(/\s+/g, " ");
    check(await P.locator(".sg-check").count() === 1 && /Thank you, Jada Brown/.test(done) && /Signed by Jada Brown on [A-Z][a-z]{2} \d{1,2}, \d{4}, \d{1,2}:\d{2} [AP]M/.test(done) && /You don't need to send anything back/.test(done),
      "the buyer sees the thank-you with the green checkmark and 'Signed by Jada Brown on [date, time]'", done.match(/Signed by[^.]*?[AP]M/)?.[0]);
    await P.waitForTimeout(1200); // the checkmark draws itself
    await P.screenshot({ path: path.join(OUT, "sign-3-buyer-thanks.png") });
    const [dl] = await Promise.all([P.waitForEvent("download"), P.click(".sg-pdf")]);
    const pdf = fs.readFileSync(await dl.path());
    check(pdf.slice(0, 5).toString() === "%PDF-" && pdf.length > 20000 && /^Invoice-\d{4}-Jada-Brown\.pdf$/.test(dl.suggestedFilename()), "they can download a PDF copy of the signed receipt", `${dl.suggestedFilename()}, ${Math.round(pdf.length / 1024)} KB`);
    r = await post("/api/sign/submit", { token, name: "Someone Else", signature: png, digest: view.digest });
    check(r.data.state === "signed" && r.data.signer === "Jada Brown" && r.data.already === true, "the link works once: signing again changes nothing (still signed by Jada Brown)");
    await P.goto(link);
    await P.waitForSelector(".sg-done");
    check(/This invoice is signed/.test(await P.textContent("#sg")) && await P.locator(".sg-go, #sg-name").count() === 0, "opening the link again only shows the signed copy");

    // ── The seller gets the signed copy by itself ────────────────────────────────────────────────────────
    await S.evaluate(async () => (await import("/js/remote.js")).checkNow());
    await S.waitForSelector("#remote-status.is-signed", { timeout: 10000 });
    const got = await current(S);
    const signedView = (await post("/api/sign/view", { token })).data;
    const same = JSON.stringify(got.items.map(({ name, qty, unit, price, total }) => ({ name, qty, unit, price, total }))) === JSON.stringify(signedView.invoice.items) && got.total === signedView.invoice.total && got.store === signedView.invoice.store;
    check(got.signerName === "Jada Brown" && got.signature === signedView.signature && got.signedAt === signedView.signedAt && same, "the seller's phone has the signed copy, exactly what the buyer signed (items, prices, total, signature, time)");
    check(/Signed by Jada Brown on/.test(await S.textContent("#remote-status")) && /signed invoice No\./.test(await S.textContent("body")), "…shown on the invoice as 'Signed by Jada Brown on …', with a message");
    await S.screenshot({ path: path.join(OUT, "sign-4-seller-signed.png") });
    await S.evaluate(() => window.scrollTo(0, 0));
    await S.click("#store");
    await S.waitForSelector("dialog[open]");
    check(/This invoice is signed/.test(await S.textContent("dialog[open]")) && /can't be changed/.test(await S.textContent("dialog[open]")), "once signed, the seller can't edit it either");
    await S.click("dialog[open] button");
    const forced = await S.evaluate(async () => { const db = await import("/js/db.js"); const id = await db.settings.get("currentId"); const inv = await db.invoices.get(id); await db.invoices.put({ ...inv, items: [{ name: "Lip Gloss", qty: 30, unit: "each", price: 1 }], store: "Changed" }); return db.invoices.get(id); });
    check(forced.store === "Jada Brown" && forced.total === 57.5, "even a change saved straight into the phone's storage is ignored: the signed invoice stays as signed");
    check((await post("/api/sign/create", { key: A.buyer.id, device: (await S.evaluate(async () => (await (await import("/js/db.js")).settings.get("license")).device)), invoice: { ...view.invoice, items: [{ name: "Lip Gloss", qty: 1, unit: "each", price: 1 }] } })).status === 409, "and the server refuses to send a signed invoice again");

    // ── Dashboard statuses ────────────────────────────────────────────────────────────────────────────────
    await makeInvoice(S, "Kemar Lewis", [["Face Cream", 2, "35"]]);
    await S.locator("#send-sign-btn").scrollIntoViewIfNeeded(); await S.click("#send-sign-btn"); await S.waitForSelector("#remote-status.is-sent");
    const inv2 = await current(S);
    await S.evaluate(() => window.scrollTo(0, 0));
    await S.click("#owner-link");
    await S.waitForSelector(".dash-key");
    const pin = async () => { for (const d of "2580") await S.locator(`.dash-key[aria-label="${d}"]`).click(); };
    await pin();
    await S.getByRole("button", { name: "Continue" }).click();
    await S.waitForSelector("text=Enter the same PIN again");
    await pin();
    await S.waitForSelector(".dash-kpi", { timeout: 8000 });
    await S.getByRole("tab", { name: "History" }).click();
    await S.waitForSelector(".dash-row", { timeout: 8000 });
    const hist = (await S.textContent("#dashboard")).replace(/\s+/g, " ");
    check(/Jada Brown.*?Signed/.test(hist) && /Kemar Lewis.*?Sent/.test(hist), "the dashboard shows each invoice's status: Jada Brown 'Signed', Kemar Lewis 'Sent'", hist.slice(0, 200));
    await S.screenshot({ path: path.join(OUT, "sign-5-dashboard.png") });
    await S.evaluate(() => { location.hash = "#/"; });

    // ── Expiry after 7 days, and sending again ───────────────────────────────────────────────────────────
    const t2 = inv2.remote.link.split("/s/")[1], later = { "X-Test-Now": String(Date.now() + 8 * 86_400_000) };
    r = await post("/api/sign/view", { token: t2 }, later);
    check(r.status === 410 && r.data.state === "expired" && /expired/.test(r.data.error), "a link that isn't signed stops working after 7 days");
    const lic = await S.evaluate(async () => (await (await import("/js/db.js")).settings.get("license")));
    const st = await post("/api/sign/status", { key: lic.key, device: lic.device, ack: [] }, later);
    check(st.data.links.find((l) => l.invoiceId === inv2.id)?.state === "expired", "…and the seller's status shows it expired");
    const again = await post("/api/sign/create", { key: lic.key, device: lic.device, invoice: { ...view.invoice, id: inv2.id, store: "Kemar Lewis", items: [{ name: "Face Cream", qty: 2, unit: "each", price: 35 }] } });
    check(again.status === 200 && (await post("/api/sign/view", { token: again.data.token })).data.state === "open" && (await post("/api/sign/view", { token: t2 })).data.state === "replaced", "the seller can send it again: a fresh link works, the old one says a newer link was sent");

    // ── Cancel and edit ──────────────────────────────────────────────────────────────────────────────────
    await S.reload(); await S.waitForFunction(() => window.__appReady === true);
    await S.evaluate(async () => (await import("/js/remote.js")).checkNow());
    await S.waitForTimeout(400);
    await S.locator("#remote-status button:has-text('Cancel and edit')").click();
    await S.waitForSelector("dialog[open]");
    await S.click("dialog[open] button:has-text('Cancel link and edit')");
    await S.waitForFunction(() => document.getElementById("remote-status").hidden === true);
    const cancelled = await post("/api/sign/view", { token: again.data.token });
    check(cancelled.status === 410 && cancelled.data.state === "cancelled" && await S.isVisible("#send-sign-btn"), "'Cancel and edit' cancels the link (the buyer is told) and the seller can change the invoice and send again");

    // ── Stored securely ──────────────────────────────────────────────────────────────────────────────────
    const files = []; const walk = (d) => { for (const e of fs.readdirSync(d, { withFileTypes: true })) { const p = path.join(d, e.name); e.isDirectory() ? walk(p) : files.push([p, fs.readFileSync(p)]); } };
    // The app's stored data (Durable Object storage). Left out: wrangler dev's own local request trace (v3/observability),
    // which records page addresses on this machine only; request logs aren't switched on for the live Worker.
    walk(stateDir); files.splice(0, files.length, ...files.filter(([p]) => !p.includes(`${path.sep}observability${path.sep}`)));
    check(files.some(([p]) => /\.sqlite$/.test(p)), "the check reads the app's stored data (the Durable Object's database)", files.map(([p]) => path.relative(stateDir, p)).filter((p) => /\.sqlite$/.test(p)).join(", "));
    const leak = ["Jada Brown", "Lip Gloss", "Sarah's Beauty sent", signedView.signature.slice(22, 80), token].filter((x) => files.some(([, b]) => b.includes(Buffer.from(x))))
      .map((x) => `${x.slice(0, 12)} in ${files.filter(([, b]) => b.includes(Buffer.from(x))).map(([p]) => path.relative(stateDir, p)).join(", ")}`);
    check(leak.length === 0, "buyer names, signatures and invoices are encrypted at rest, and the secret links themselves aren't stored (only a hash)", leak.join(", "));
    check(errors.length === 0, "no page errors", errors.join(" | "));
  } finally {
    await browser.close(); await w.stop(); fs.rmSync(stateDir, { recursive: true, force: true });
  }
  if (failures) { console.log(`\n${failures} check(s) failed`); process.exit(1); }
  console.log("\nAll send-for-signature checks passed");
})().catch((e) => { console.error(e); process.exit(1); });
