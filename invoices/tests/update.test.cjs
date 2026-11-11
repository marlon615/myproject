/**
 * Updates reach the phone by themselves: a new deploy installs in the background and takes over at once.
 * During the splash the app reloads into it unseen (no second splash); mid-work it offers "Refresh" instead.
 */
const { chromium } = require("playwright");
const { start } = require("./serve.cjs");
const fs = require("fs"), os = require("os"), path = require("path");

const PORT = 8796;
let failures = 0;
const check = (ok, name, extra = "") => { console.log(`${ok ? "PASS" : "FAIL"}  ${name}${extra ? "  — " + extra : ""}`); if (!ok) failures++; };

(async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "invoices-update-"));
  fs.cpSync(path.join(__dirname, "..", "public"), root, { recursive: true });
  const SW = path.join(root, "sw.js");
  const deploy = (v) => fs.writeFileSync(SW, fs.readFileSync(SW, "utf8").replace(/const VERSION = "[^"]*";/, `const VERSION = "${v}";`));
  const srv = await start(PORT, { root });
  const browser = await chromium.launch();
  try {
    deploy("v1");
    const ctx = await browser.newContext({ viewport: { width: 390, height: 844 } });
    const page = await ctx.newPage();
    const errors = [];
    page.on("pageerror", (e) => errors.push(e.message));
    // First visit: installs offline support without reloading.
    await page.goto(`${srv.url}/?splash`);
    await page.evaluate(() => { window.__marker = 1; });
    await page.waitForFunction(() => navigator.serviceWorker.controller !== null, null, { timeout: 10000 });
    await page.waitForTimeout(500);
    check(await page.evaluate(() => window.__marker === 1), "first visit: offline copy installs without reloading the page");
    const keys1 = await page.evaluate(() => caches.keys());
    check(keys1.includes("mw-invoices-v1"), "version 1 stored on the phone", keys1.join(","));

    // Second launch (controlled), a new version is deployed while the splash shows → reload into it unseen.
    await page.goto(`${srv.url}/?splash`);
    await page.waitForSelector("#splash");
    deploy("v2");
    await page.evaluate(() => navigator.serviceWorker.getRegistration().then((r) => r.update()));
    await page.waitForFunction(() => performance.getEntriesByType("navigation")[0]?.type === "reload", null, { timeout: 10000 });
    await page.waitForFunction(() => window.__appReady === true, null, { timeout: 10000 });
    const after = await page.evaluate(async () => ({ splash: Boolean(document.getElementById("splash")), keys: await caches.keys() }));
    check(after.keys.includes("mw-invoices-v2") && !after.keys.includes("mw-invoices-v1"), "update during the splash: new version installed, old one removed", after.keys.join(","));
    check(!after.splash, "…and the app reloaded into it without showing the splash a second time");

    // Mid-work (splash gone): a newer version is offered with "Refresh", nothing reloads under the user.
    await page.evaluate(() => { window.__marker = 2; });
    await page.fill("#store", "Halfway Tree Market");
    deploy("v3");
    await page.evaluate(() => navigator.serviceWorker.getRegistration().then((r) => r.update()));
    await page.waitForSelector("#update-banner:not([hidden])", { timeout: 10000 });
    check(await page.evaluate(() => window.__marker === 2) && await page.inputValue("#store") === "Halfway Tree Market", "update mid-work: no reload, typing untouched, 'Refresh' offered");
    await page.click("#update-btn");
    // Wait for the NEW page (the old one had window.__marker) to finish starting.
    await page.waitForFunction(() => window.__marker === undefined && window.__appReady === true, null, { timeout: 10000 });
    const st = await page.inputValue("#store"), ks = await page.evaluate(() => caches.keys());
    check(st === "Halfway Tree Market" && ks.includes("mw-invoices-v3"), "'Refresh' loads the new version and keeps the invoice", `store="${st}" caches=${ks.join(",")}`);
    check(errors.length === 0, "no page errors", errors.join(" | "));
    await ctx.close();
  } finally {
    await browser.close();
    await srv.close();
    fs.rmSync(root, { recursive: true, force: true });
  }
  console.log(failures ? `\n${failures} check(s) failed` : "\nAll update checks passed");
  process.exit(failures ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
