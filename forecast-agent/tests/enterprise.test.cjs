/**
 * The enterprise features end to end, with the real Worker (wrangler dev) and a stand-in email service (Resend API
 * shape) on this machine. Nothing here touches the live site or sends real email.
 *   owner: contract + plan + feature switches, platform email settings (secrets never come back), ARR
 *   team: invites (emailed), roles enforced on the server, last-admin protection
 *   two-factor: setup with a real TOTP code, sign-in with code, code reuse refused, backup codes, required for all
 *   data: multi-location upload (by store and region, adds up), a large upload worked through in the background,
 *         drill-down, encryption at rest (looks inside the stored database files)
 *   API: keys (shown once, hashed), scopes, revoke, rate limit, /v1/sales, /v1/files (file drop), /v1/forecasts
 *   stock: /v1/inventory → reorder suggestions → low-stock email to admins/managers (not viewers)
 *   weekly report: schedule + send now → email; activity log has it all; companies can't see each other
 *   browser (phone size): the new sections render with real data, no page errors
 */
const { spawnSync } = require("child_process");
const fs = require("fs"), os = require("os"), path = require("path"), http = require("http");
const { chromium } = require("playwright");
const { checker, startWorker, api, until, sleep, APP } = require("./helpers.cjs");

const PORT = 8830, MAIL = 8831, OUT = path.join(__dirname, "output");
const { check, failures } = checker();
const mails = [];
const mailer = http.createServer((rq, rs) => {
  let b = ""; rq.on("data", (d) => (b += d));
  rq.on("end", () => { try { mails.push({ auth: rq.headers.authorization, ...JSON.parse(b) }); } catch { /* ignore */ } rs.writeHead(200, { "content-type": "application/json" }); rs.end('{"id":"m1"}'); });
});
const months = (start, n) => Array.from({ length: n }, (_, i) => { const d = new Date(Date.UTC(+start.slice(0, 4), +start.slice(5) - 1 + i, 1)); return d.toISOString().slice(0, 7); });

(async () => {
  const C = await import("../worker/crypto.js");
  fs.mkdirSync(OUT, { recursive: true });
  check(spawnSync(process.execPath, [path.join(APP, "scripts", "build-worker.cjs")], { cwd: APP }).status === 0, "the app packs into the Worker");
  await new Promise((ok) => mailer.listen(MAIL, ok));
  const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), "forecast-ent-"));
  const w = startWorker(PORT, stateDir, { EMAIL_URL: `http://localhost:${MAIL}/emails` });
  const req = api(w.base);
  const browser = await chromium.launch();
  const errors = [];
  try {
    await w.ready;
    const owner = (await req("/api/owner/claim", { method: "POST", body: { passcode: "owner-pass-123" } })).data.token;
    const A = await req("/api/signup", { method: "POST", body: { company: "Harbor Retail Group", email: "cfo@harbor.test", password: "admin-pass-1" } });
    const admin = A.data.token, aid = A.data.me.id;

    // ── Owner: contract, features, platform email ───────────────────────────────────────────────────────────
    const low = await req("/api/owner/contract", { method: "POST", token: owner, body: { id: aid, plan: "Enterprise", contract: 20000 } });
    check(low.status === 400 && low.data.belowMinimum, "a contract under $30,000 a year is refused (unless confirmed)", low.data.error);
    const ct = await req("/api/owner/contract", { method: "POST", token: owner, body: { id: aid, plan: "Enterprise", contract: 45000, start: "2026-01-01", end: "2027-12-31", note: "PO 7781", allFeatures: true } });
    const cust = (await req("/api/owner/customers", { token: owner })).data;
    const ca = cust.customers.find((c) => c.id === aid);
    check(ct.status === 200 && ca.plan === "Enterprise" && ca.contractCents === 4500000 && ca.contractActive && cust.totals.arrCents === 4500000 && Object.values(ca.features).every(Boolean),
      "owner records a $45,000/year Enterprise contract: ARR $45,000, every feature switched on");
    await req("/api/owner/platform", { method: "POST", token: owner, body: { emailKey: "re_test_SECRET_123", emailFrom: "Forecasts <reports@forecast.test>" } });
    const pl = await req("/api/owner/platform", { token: owner });
    check(pl.data.platform.emailKey === true && pl.data.platform.emailFrom.includes("reports@") && !JSON.stringify(pl.data).includes("SECRET"), "platform email key is saved encrypted and never sent back (shows as 'saved')");

    // ── Team ─────────────────────────────────────────────────────────────────────────────────────────────────
    const invM = await req("/api/team", { method: "POST", token: admin, body: { email: "ops@harbor.test", name: "Olivia Ops", role: "manager" } });
    const invV = await req("/api/team", { method: "POST", token: admin, body: { email: "board@harbor.test", name: "Ben Board", role: "viewer" } });
    const invMail = mails.find((m) => m.to?.[0] === "ops@harbor.test");
    check(invM.status === 200 && invM.data.emailed && invMail && invMail.subject.includes("Harbor Retail Group") && invMail.html.includes(invM.data.link) && invMail.auth === "Bearer re_test_SECRET_123", "admin invites a manager: the invite is emailed with the link", invMail?.subject);
    const tokOf = (link) => link.split("/").pop();
    const info = await req(`/api/invite?token=${tokOf(invM.data.link)}`);
    const M = await req("/api/invite", { method: "POST", body: { token: tokOf(invM.data.link), name: "Olivia Ops", password: "manager-pass-1" } });
    const V = await req("/api/invite", { method: "POST", body: { token: tokOf(invV.data.link), name: "Ben Board", password: "viewer-pass-1" } });
    let manager = M.data.token; const viewer = V.data.token;
    check(info.data.company === "Harbor Retail Group" && info.data.role === "manager" && M.data.me.role === "manager" && V.data.me.role === "viewer" && M.data.recoveryCode, "invites accepted: a manager and a viewer join (each gets a recovery code)");
    check((await req("/api/invite", { method: "POST", body: { token: tokOf(invM.data.link), password: "again-pass-1" } })).status === 410, "an invite link works once");
    const smallUpload = { name: "x", months: months("2025-01", 12), series: [{ product: "P", amount: Array(12).fill(10) }] };
    check((await req("/api/uploads", { method: "POST", token: viewer, body: smallUpload })).status === 403 && (await req("/api/uploads", { token: viewer })).status === 200, "viewer: can see data, can't upload");
    check((await req("/api/team", { token: manager })).status === 403 && (await req("/api/keys", { method: "POST", token: manager, body: {} })).status === 403 && (await req("/api/audit", { token: viewer })).status === 403, "manager can't manage the team or API keys; viewer can't read the activity log");
    const team = (await req("/api/team", { token: admin })).data.users;
    const me0 = team.find((u) => u.email === "cfo@harbor.test");
    check((await req(`/api/team/${me0.id}`, { method: "PATCH", token: admin, body: { role: "viewer" } })).status === 400, "the last admin can't be demoted");

    // ── Two-factor ───────────────────────────────────────────────────────────────────────────────────────────
    const setup = await req("/api/2fa/setup", { method: "POST", token: manager });
    const nowCode = async () => C.totpAt(setup.data.secret, Math.floor(Date.now() / 30000));
    check((await req("/api/2fa/enable", { method: "POST", token: manager, body: { code: "000000" } })).status === 400, "a wrong code doesn't turn two-factor on");
    const en = await req("/api/2fa/enable", { method: "POST", token: manager, body: { code: await nowCode() } });
    check(en.status === 200 && en.data.backupCodes.length === 10, "two-factor turned on with a real authenticator code; 10 backup codes shown once");
    const l1 = await req("/api/login", { method: "POST", body: { email: "ops@harbor.test", password: "manager-pass-1" } });
    check(l1.data.twoFactor && l1.data.ticket && !l1.data.token, "signing in now asks for the code (no session from the password alone)");
    check((await req("/api/login/2fa", { method: "POST", body: { ticket: l1.data.ticket, code: "123456" } })).status === 401, "a wrong code is refused");
    // A fresh code (not the one used to switch it on).
    await until(async () => (await nowCode()) !== (await C.totpAt(setup.data.secret, Math.floor((Date.now() - 30000) / 30000))) || true, 1000);
    let step = Math.floor(Date.now() / 30000);
    const enStep = step; // code used for enabling was this step (or the previous): wait for the next step to be safe
    await until(async () => Math.floor(Date.now() / 30000) > enStep, 31000, 500);
    const code2 = await nowCode();
    const l2 = await req("/api/login/2fa", { method: "POST", body: { ticket: l1.data.ticket, code: code2 } });
    check(l2.status === 200 && l2.data.token, "the right code signs in");
    manager = l2.data.token;
    const l3 = await req("/api/login", { method: "POST", body: { email: "ops@harbor.test", password: "manager-pass-1" } });
    check((await req("/api/login/2fa", { method: "POST", body: { ticket: l3.data.ticket, code: code2 } })).status === 401, "the same code can't be used twice");
    const l4 = await req("/api/login", { method: "POST", body: { email: "ops@harbor.test", password: "manager-pass-1" } });
    const bk = await req("/api/login/2fa", { method: "POST", body: { ticket: l4.data.ticket, code: en.data.backupCodes[0] } });
    const l5 = await req("/api/login", { method: "POST", body: { email: "ops@harbor.test", password: "manager-pass-1" } });
    check(bk.status === 200 && bk.data.usedBackup && bk.data.backupLeft === 9 && (await req("/api/login/2fa", { method: "POST", body: { ticket: l5.data.ticket, code: en.data.backupCodes[0] } })).status === 401, "a backup code signs in once, then it's used up (9 left)");
    const refuse = await req("/api/settings", { method: "POST", token: admin, body: { require2fa: true } });
    check(refuse.status === 400 && /yourself first/.test(refuse.data.error), "an admin can't require two-factor for everyone before turning it on for themselves (no lock-out)", refuse.data.error);
    const as = await req("/api/2fa/setup", { method: "POST", token: admin });
    await req("/api/2fa/enable", { method: "POST", token: admin, body: { code: await C.totpAt(as.data.secret, Math.floor(Date.now() / 30000)) } });
    check((await req("/api/settings", { method: "POST", token: admin, body: { require2fa: true } })).status === 200, "with two-factor on for themselves, the admin can require it for everyone");
    const vl = await req("/api/login", { method: "POST", body: { email: "board@harbor.test", password: "viewer-pass-1" } });
    const blocked = await req("/api/uploads", { token: vl.data.token });
    check(vl.data.me.mustEnroll2fa && blocked.status === 403 && blocked.data.enroll2fa && (await req("/api/me", { token: vl.data.token })).status === 200, "company requires two-factor: a user without it must set it up before doing anything else");
    check((await req("/api/settings", { method: "POST", token: admin, body: { require2fa: false } })).status === 200, "the admin can switch the requirement off again");

    // ── Multi-location data ──────────────────────────────────────────────────────────────────────────────────
    const ax = months("2023-10", 36);
    const stores = [["Harbor Point Store", "North"], ["Bayview Store", "North"], ["Canal Street Store", "South"]];
    const prods = ["Zephyr Widget", "Nimbus Lamp", "Quartz Kettle", "Ember Mug"];
    const series = [];
    stores.forEach(([s, r], si) => prods.forEach((p, pi) => {
      const base = 100 + si * 40 + pi * 25;
      series.push({ product: p, location: s, region: r, amount: ax.map((_, t) => Math.round(base * (1 + 0.01 * t) * (1 + 0.25 * Math.sin((t + 3) / 1.9)) * 10 * 100) / 100), units: ax.map((_, t) => Math.round(base * (1 + 0.01 * t) * (1 + 0.25 * Math.sin((t + 3) / 1.9)))) });
    }));
    const up = await req("/api/uploads", { method: "POST", token: manager, body: { name: "Stores FY24-26", months: ax, series } });
    const multi = up.data.upload;
    check(up.status === 200 && multi.locations === 3 && multi.regions === 2 && multi.products === 4 && multi.series === 12 && multi.status === "ready", "manager uploads 4 products × 3 stores × 2 regions (sales and quantities)", `${multi.series} series, ${multi.status}`);
    const bt = (await req(`/api/uploads/${multi.id}`, { token: manager })).data.upload.backtest;
    check(bt.ok && bt.locations.length === 3 && bt.regions.length === 2 && bt.accuracy > 70 && bt.summary.some((s) => /By location/.test(s)), "accuracy test by product, store and region", `${bt.accuracy}%`);
    const fc = (await req(`/api/uploads/${multi.id}/forecast`, { method: "POST", token: manager })).data.forecast;
    const tot = fc.total.forecast.reduce((a, b) => a + b, 0), byLoc = fc.locations.reduce((a, l) => a + l.next3, 0), byReg = fc.regions.reduce((a, l) => a + l.next3, 0), byProd = fc.products.reduce((a, l) => a + l.next3, 0);
    check(Math.abs(tot - byLoc) < 0.1 && Math.abs(tot - byReg) < 0.1 && Math.abs(tot - byProd) < 0.1, "stores, regions and products all add up to the same total", `${Math.round(tot)} = ${Math.round(byLoc)} = ${Math.round(byReg)} = ${Math.round(byProd)}`);
    const north = fc.regions.find((r) => r.name === "North"), nStores = fc.locations.filter((l) => ["Harbor Point Store", "Bayview Store"].includes(l.name));
    check(Math.abs(north.next3 - nStores.reduce((a, l) => a + l.next3, 0)) < 0.1, "a region equals the sum of its stores");
    const drill = (await req(`/api/uploads/${multi.id}/drill?product=${encodeURIComponent("Zephyr Widget")}`, { token: viewer.length ? manager : manager })).data;
    check(drill.rows.length === 3 && drill.rows.every((r) => r.forecast?.length === 3) && Math.abs(drill.rows.reduce((a, r) => a + r.next3, 0) - fc.products.find((p) => p.name === "Zephyr Widget").next3) < 0.1, "drill-down: one product in each of its 3 stores, adding up to the product total");
    // Large upload: 400 series → worked through in the background, with progress.
    const big = [];
    for (let i = 0; i < 400; i++) big.push({ product: `SKU-${String(i % 80).padStart(3, "0")}`, location: `Store ${1 + Math.floor(i / 80)}`, region: i < 240 ? "East" : "West", amount: ax.slice(-18).map((_, t) => 50 + (i % 13) * 7 + t * 2 + (t % 12 === 11 ? 30 : 0)) });
    const bu = await req("/api/uploads", { method: "POST", token: manager, body: { name: "Big chain", months: ax.slice(-18), series: big.slice(0, 250), final: false } });
    await req(`/api/uploads/${bu.data.upload.id}/series`, { method: "POST", token: manager, body: { name: "Big chain", months: ax.slice(-18), series: big.slice(250) } });
    const fin = await req(`/api/uploads/${bu.data.upload.id}/finish`, { method: "POST", token: manager });
    const progress = new Set();
    const done = await until(async () => { const u = (await req(`/api/uploads/${bu.data.upload.id}`, { token: manager })).data.upload; if (u.progress !== null) progress.add(u.progress); return u.status === "ready" ? u : null; }, 60000, 200);
    check(fin.data.upload.status === "processing" && done && done.series === 400 && done.backtest.ok && done.locations === 5, "a 400-series upload (sent in 2 parts) is worked through in the background", `progress seen: ${[...progress].sort((a, b) => a - b).join(", ")}%`);

    // ── Encryption at rest: look inside the stored database files ────────────────────────────────────────────
    const files = [];
    const walk = (d) => { for (const e of fs.readdirSync(d, { withFileTypes: true })) { const p = path.join(d, e.name); if (e.isDirectory()) walk(p); else files.push(p); } };
    walk(stateDir);
    const blob = Buffer.concat(files.filter((f) => /sqlite|\.db|wal/i.test(f)).map((f) => fs.readFileSync(f)));
    const has = (s) => blob.includes(Buffer.from(s, "utf8"));
    check(blob.length > 0 && has("Harbor Retail Group"), "(the search works: the company name, which isn't secret, is found in the stored files)", `${files.length} files, ${Math.round(blob.length / 1024)} KB`);
    check(!has("Zephyr Widget") && !has("Harbor Point Store") && !has("SKU-042") && !has("re_test_SECRET_123"), "product names, store names and the email key are NOT in the stored files (encrypted)");

    // ── API keys, /v1 ────────────────────────────────────────────────────────────────────────────────────────
    const key = (await req("/api/keys", { method: "POST", token: admin, body: { name: "Data warehouse" } })).data;
    const readOnly = (await req("/api/keys", { method: "POST", token: admin, body: { name: "BI read", scopes: ["forecasts:read"] } })).data;
    const keys = (await req("/api/keys", { token: admin })).data.keys;
    check(/^fa_live_[0-9a-f]{8}_[0-9a-f]{48}$/.test(key.key) && keys.length === 2 && !JSON.stringify(keys).includes(key.key.slice(17)), "API key shown once; the list shows only its prefix");
    const rows = [];
    for (const m of months("2025-05", 18)) for (const s of ["Online", "Airport Kiosk"]) rows.push({ date: `${m}-15`, product: "Ember Mug", location: s, region: "Travel", amount: 1200 + rows.length * 3, quantity: 60 + (rows.length % 5) });
    const s1 = await req("/v1/sales", { method: "POST", token: key.key, body: { rows } });
    check(s1.status === 202 && s1.data.accepted === 36 && s1.data.months.length === 18, "/v1/sales: 36 rows accepted (18 months, 2 locations)");
    check((await req("/v1/sales", { method: "POST", token: readOnly.key, body: { rows } })).status === 403, "a read-only key can't send sales");
    const apiUp = await until(async () => (await req("/api/uploads", { token: admin })).data.uploads.find((u) => u.source === "api" && u.status === "ready"), 30000);
    const v1f = await req("/v1/forecasts?upload=api&view=location", { token: readOnly.key });
    check(apiUp && v1f.status === 200 && v1f.data.forecast.items.length === 2 && v1f.data.accuracy !== null, "/v1/forecasts: forecast by location for the API data, readable with a read-only key");
    // Resending a month replaces it (no double counting).
    await req("/v1/sales", { method: "POST", token: key.key, body: { rows: rows.slice(0, 2) } });
    await sleep(800);
    const again = (await req(`/api/uploads/${apiUp.id}/drill?product=Ember%20Mug&mode=backtest`, { token: admin })).data;
    check(again.rows.length === 2, "resending the same rows replaces those months (no double counting)");
    const csv = "Order Date,SKU,Store,Region,Qty,Net Sales\n" + months("2025-01", 14).flatMap((m) => [`${m.slice(5)}/20/${m.slice(0, 4)},Quartz Kettle,Mall Store,West,${20 + +m.slice(5)},"$${(400 + +m.slice(5) * 10).toFixed(2)}"`, `${m.slice(5)}/21/${m.slice(0, 4)},Nimbus Lamp,Mall Store,West,5,$99.50`]).join("\n") + "\n";
    const fd = await req("/v1/files?dateOrder=mdy", { method: "POST", token: key.key, raw: csv, headers: { "content-type": "text/csv" } });
    const dropped = await until(async () => (await req("/api/uploads", { token: admin })).data.uploads.find((u) => u.source === "filedrop" && u.status === "ready"), 30000);
    check(fd.status === 202 && dropped && dropped.products === 2 && dropped.locations === 1 && dropped.months === 14 && dropped.measures.includes("units"), "/v1/files (HTTPS file drop): a CSV export is read in the background (columns recognised, 14 months, quantities too)");
    await req("/api/owner/features", { method: "POST", token: owner, body: { id: aid, features: { api: false } } });
    check((await req("/v1/jobs", { token: key.key })).status === 402, "API switched off by the owner → 402");
    await req("/api/owner/features", { method: "POST", token: owner, body: { id: aid, features: { api: true } } });
    await req(`/api/keys/${readOnly.prefix}`, { method: "DELETE", token: admin });
    check((await req("/v1/jobs", { token: readOnly.key })).status === 401, "a revoked key stops working");
    let last;
    for (let i = 0; i < 125; i++) last = await req("/v1/jobs", { token: key.key });
    check(last.status === 429, "more than 120 calls a minute on one key → 429");

    // ── Stock, reorder suggestions, low-stock email ──────────────────────────────────────────────────────────
    await req("/api/stock/settings", { method: "POST", token: manager, body: { mainUpload: multi.id, serviceLevel: 0.95, reviewDays: 14, leadDays: 10 } });
    const before = mails.length;
    await sleep(61000); // the API key's minute passes (rate limit) before using it again
    const inv = await req("/v1/inventory", { method: "POST", token: key.key, body: { items: [
      { product: "Zephyr Widget", location: "Harbor Point Store", on_hand: 5, on_order: 0, lead_time_days: 14, case_pack: 10, unit_cost: 4 },
      { product: "Nimbus Lamp", location: "Harbor Point Store", on_hand: 0, lead_time_days: 7 },
      { product: "Quartz Kettle", location: "Bayview Store", on_hand: 100000 },
      { product: "Mystery Item", location: "Bayview Store", on_hand: 3 },
    ] } });
    const ro = await until(async () => { const r = (await req("/api/reorder", { token: viewer.length ? manager : manager })).data; return r.ok && !r.pending ? r : null; }, 40000);
    const z = ro?.items.find((x) => x.product === "Zephyr Widget"), n = ro?.items.find((x) => x.product === "Nimbus Lamp"), q = ro?.items.find((x) => x.product === "Quartz Kettle"), mys = ro?.items.find((x) => x.product === "Mystery Item");
    check(inv.status === 202 && ro && z.status === "low" && z.suggestedQty > 0 && z.suggestedQty % 10 === 0 && n.status === "out" && q.status === "ok" && q.suggestedQty === 0 && mys.status === "nodata",
      "reorder suggestions: low item gets an order in whole cases, out-of-stock flagged, plenty → none, unknown item says no data", `Zephyr: order ${z?.suggestedQty}, ${z?.daysOfCover} days left`);
    const lowMails = await until(async () => { const l = mails.slice(before).filter((m) => /Low stock/.test(m.subject)); return l.length >= 2 ? l : null; }, 15000);
    const lowTo = (lowMails || []).map((m) => m.to[0]).sort();
    check(lowTo.join() === "cfo@harbor.test,ops@harbor.test" && lowMails[0].html.includes("Zephyr Widget"), "low-stock email goes to the admin and the manager (not the viewer), listing the items", lowMails?.[0]?.subject);
    const n2 = mails.length;
    await req("/v1/inventory", { method: "POST", token: key.key, body: { items: [{ product: "Zephyr Widget", location: "Harbor Point Store", on_hand: 4 }] } });
    await until(async () => { const r = (await req("/api/reorder", { token: manager })).data; return r.ok && !r.pending; }, 20000);
    await sleep(1000);
    check(!mails.slice(n2).some((m) => /Low stock/.test(m.subject)), "no repeat email for items already reported (for 7 days)");
    await req("/api/prefs", { method: "POST", token: manager, body: { lowStock: false } });

    // ── Weekly report ────────────────────────────────────────────────────────────────────────────────────────
    const rs = await req("/api/reports", { method: "POST", token: admin, body: { enabled: true, weekday: 1, hour: 7 } });
    const nr = new Date(rs.data.nextRun);
    check(rs.data.enabled && nr > new Date() && nr.getUTCDay() === 1 && nr.getUTCHours() === 7, "weekly report scheduled for Monday 07:00 (company time zone: UTC)", nr.toISOString());
    const n3 = mails.length;
    await req("/api/reports/send", { method: "POST", token: admin });
    const rep = await until(async () => { const l = mails.slice(n3).filter((m) => /Weekly forecast/.test(m.subject)); return l.length >= 2 ? l : null; }, 30000);
    check(rep && rep.map((m) => m.to[0]).sort().join() === "cfo@harbor.test,ops@harbor.test" && rep[0].html.includes("Biggest changes by product") && rep[0].text.includes("Forecast"), "'Send one now': the weekly report is emailed to admins and managers", rep?.[0]?.subject);

    // ── Activity log, owner view, separation ─────────────────────────────────────────────────────────────────
    const log = (await req("/api/audit?limit=500", { token: admin })).data.events.map((e) => e.action);
    const want = ["company created", "joined the team", "invited a user", "turned on two-factor sign-in", "signed in (two-factor)", "signed in (backup code used)", "two-factor code wrong", "uploaded sales", "made a forecast", "created an API key", "revoked an API key", "sales received through the API", "file received through the API", "stock levels updated", "low-stock email sent", "weekly report sent", "changed security settings"];
    const missing = want.filter((x) => !log.includes(x));
    check(!missing.length, "the activity log records sign-ins, team changes, two-factor, uploads, forecasts, API keys, API data, stock, emails and settings", missing.length ? `missing: ${missing.join(", ")}` : `${log.length} events`);
    const oc = (await req("/api/owner/customers", { token: owner })).data.customers.find((c) => c.id === aid);
    const oa = await req(`/api/owner/customers/${aid}/audit`, { token: owner });
    check(oc.users.length === 3 && oc.users.find((u) => u.email === "ops@harbor.test").twoFactor && oa.data.events.length > 10, "owner sees the company's 3 users (with two-factor status) and its activity log");
    await req("/api/owner/features", { method: "POST", token: owner, body: { id: aid, features: { connectors: false } } });
    check((await req("/api/connections", { token: admin })).status === 402, "owner switches Connections off → the company can't use them");
    const B = await req("/api/signup", { method: "POST", body: { company: "Other Co", email: "boss@other.test", password: "other-pass-1" } });
    check((await req(`/api/uploads/${multi.id}`, { token: B.data.token })).status === 404 && [402, 404].includes((await req(`/api/uploads/${multi.id}/drill?product=Zephyr%20Widget`, { token: B.data.token })).status) && (await req("/api/uploads", { token: B.data.token })).data.uploads.length === 0,
      "another company can't see this company's data, even with exact ids");
    check((await req("/v1/jobs", { token: key.key.replace(/.$/, (c) => (c === "a" ? "b" : "a")) })).status === 401, "a key with one character changed is refused");

    // ── Browser, phone size ──────────────────────────────────────────────────────────────────────────────────
    const ctx = await browser.newContext({ viewport: { width: 390, height: 844 }, deviceScaleFactor: 2, isMobile: true, hasTouch: true });
    const P = await ctx.newPage();
    P.on("pageerror", (e) => errors.push(e.message));
    P.on("console", (m) => { if (m.type() === "error" && !/status of (40[0-9]|429)/.test(m.text())) errors.push("console: " + m.text()); });
    await P.goto(w.base + "/");
    await P.evaluate((t) => localStorage.setItem("forecast.token", t), admin);
    await P.goto(`${w.base}/#/u/${multi.id}`);
    await P.reload();
    await P.waitForSelector("#fc:not([hidden])");
    check(await P.isVisible("#nav") && /3 locations · 2 regions/.test(await P.textContent("#r-meta")), "result page: navigation, and '3 locations · 2 regions'", await P.textContent("#r-meta"));
    await P.selectOption("#fc-by", "locations");
    check(/By store/.test(await P.textContent("#fc-table-title")) && (await P.locator("#fc-table tbody tr").count()) === 4, "forecast 'View by' store: 3 stores + total");
    await P.selectOption("#fc-by", "products");
    await P.selectOption("#fc-pick", { label: "Zephyr Widget" });
    await P.waitForSelector("#fc-drill:not([hidden])");
    check((await P.locator("#fc-drill-table tbody tr").count()) === 3, "picking a product shows it in each store");
    await P.screenshot({ path: path.join(OUT, "ent-1-forecast-by-store-phone.png"), fullPage: true });
    await P.goto(`${w.base}/#/stock`);
    await P.waitForSelector("#ro-table tbody tr");
    check(/Out of stock/.test(await P.textContent("#ro-table")) && /Zephyr Widget/.test(await P.textContent("#ro-table")), "Stock page shows reorder suggestions");
    await P.screenshot({ path: path.join(OUT, "ent-2-stock-phone.png"), fullPage: true });
    await P.goto(`${w.base}/#/team`);
    await P.waitForSelector("#team-table tbody tr");
    check((await P.locator("#team-table tbody tr").count()) === 3, "Team page lists the 3 people with their roles");
    await P.goto(`${w.base}/#/activity`);
    await P.waitForSelector("#act-table tbody tr");
    check((await P.locator("#act-table tbody tr").count()) >= 20, "Activity page shows the log");
    check(/On\./.test(await (async () => { await P.goto(`${w.base}/#/account`); await P.waitForSelector("#account:not([hidden])"); return P.textContent("#tf-status"); })()), "Settings shows the admin's two-factor as on");
    await P.evaluate((t) => localStorage.setItem("forecast.token", t), viewer); // the viewer hasn't set it up yet
    await P.reload();
    await P.waitForSelector("#account:not([hidden])");
    check(!(await P.isVisible('#nav a[data-nav="team"]')) && !(await P.isVisible('#nav a[data-nav="activity"]')), "a viewer doesn't see the Team or Activity sections");
    await P.click("#tf-start");
    await P.waitForSelector("#tf-qr svg");
    check(await P.isVisible("#tf-qr svg"), "two-factor setup shows a QR code for the authenticator app");
    await P.screenshot({ path: path.join(OUT, "ent-3-twofactor-phone.png"), fullPage: true });
    const O = await ctx.newPage();
    O.on("pageerror", (e) => errors.push("owner: " + e.message));
    await O.goto(w.base + "/owner");
    await O.evaluate((t) => sessionStorage.setItem("forecast.owner", t), owner);
    await O.reload();
    await O.waitForSelector(".cust");
    check(/\$45,000\.00\s*Annual contract value/.test(await O.textContent("#o-tiles")) && /Enterprise/.test(await O.locator(".cust", { hasText: "Harbor Retail Group" }).textContent()), "owner dashboard: ARR $45,000 and the Enterprise plan");
    await O.screenshot({ path: path.join(OUT, "ent-4-owner-phone.png"), fullPage: true });
    check(errors.length === 0, "no page errors", errors.join(" | "));
    await ctx.close();
  } finally {
    await browser.close();
    await w.stop();
    mailer.close();
    if (failures()) console.log(w.log.join("").slice(-3000));
    fs.rmSync(stateDir, { recursive: true, force: true });
  }
  console.log(failures() ? `\n${failures()} check(s) failed` : "\nAll enterprise checks passed");
  process.exit(failures() ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
