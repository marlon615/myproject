/**
 * Open-demo scale run (not part of the normal test suite): N products × 21 months through the real /demo page in a
 * real browser. Prints file size, read time, forecast time, requests and failures.
 * Usage: node tests/demoscale.cjs 10000 [20000 50000 …]
 */
const fs = require("fs"), os = require("os"), path = require("path"), { spawnSync } = require("child_process");
const { chromium } = require("playwright");
const { startWorker } = require("./helpers.cjs");
const APP = path.join(__dirname, "..");
const sizes = process.argv.slice(2).map(Number);
const m21 = Array.from({ length: 21 }, (_, i) => new Date(Date.UTC(2024, 9 + i, 1)).toISOString().slice(0, 7));

(async () => {
  if (spawnSync(process.execPath, [path.join(APP, "scripts", "build-worker.cjs")], { cwd: APP }).status !== 0) throw new Error("build failed");
  const out = {};
  for (const N of sizes) {
    const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), `demoscale-${N}-`));
    const w = startWorker(8910, stateDir, {});
    const browser = await chromium.launch();
    const r = { products: N };
    try {
      await w.ready;
      const file = path.join(stateDir, `load-${N}.csv`), fd = fs.openSync(file, "w");
      fs.writeSync(fd, "Month,Product,Sales\n");
      for (let p = 0; p < N; p++) {
        const base = 50 + (p % 97) * 13; let chunk = "";
        for (let t = 0; t < 21; t++) chunk += `${m21[t]},Product ${String(p).padStart(5, "0")},${Math.round(base * (1 + 0.01 * t) * (1 + 0.2 * Math.sin((t + p) / 1.9)) * 100) / 100}\n`;
        fs.writeSync(fd, chunk);
      }
      fs.closeSync(fd);
      r.fileMB = Math.round(fs.statSync(file).size / 1e5) / 10;
      const page = await (await browser.newContext({ viewport: { width: 1280, height: 900 }, acceptDownloads: true })).newPage();
      const errors = []; page.on("pageerror", (e) => errors.push(e.message));
      let calls = 0, failed = 0;
      page.on("requestfinished", async (q) => { if (q.url().includes("/api/demo/forecast")) { calls++; if ((await q.response())?.status() !== 200) failed++; } });
      page.on("requestfailed", (q) => { if (q.url().includes("/api/demo/forecast")) { calls++; failed++; } });
      await page.goto(`${w.base}/demo`);
      const t0 = Date.now();
      await page.setInputFiles("#d-file", file);
      await page.waitForFunction(() => !document.querySelector("#d-run")?.disabled && !document.querySelector("#d-map").hidden, null, { timeout: 600000 });
      r.readSeconds = (Date.now() - t0) / 1000;
      const t1 = Date.now();
      await page.click("#d-run");
      await page.waitForSelector("#d-result:not([hidden])", { timeout: 1800000 });
      r.forecastSeconds = (Date.now() - t1) / 1000;
      await page.waitForTimeout(500);
      r.requests = calls; r.failed = failed;
      r.lead = (await page.textContent("#d-r-lead")).trim().slice(0, 120);
      const [dl] = await Promise.all([page.waitForEvent("download"), page.click("#d-csv")]);
      r.csvLines = fs.readFileSync(await dl.path(), "utf8").trim().split("\n").length;
      r.errors = errors;
      r.ok = failed === 0 && r.csvLines === N + 2 && errors.length === 0;
    } catch (e) { r.ok = false; r.error = e.message.slice(0, 300); }
    await browser.close(); await w.stop();
    fs.rmSync(stateDir, { recursive: true, force: true });
    out[N] = r; console.log("RESULT", JSON.stringify(r));
  }
  fs.writeFileSync(path.join(__dirname, "output", "demoscale.json"), JSON.stringify(out, null, 2));
})().catch((e) => { console.error(e); process.exit(1); });
