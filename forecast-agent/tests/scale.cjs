/**
 * Scale run (not part of the normal test suite): the full app with N products × 21 months, through the real API —
 * sign up, upload in parts, the accuracy test in the background, then the forecast. Prints timings and any error.
 * Usage: node tests/scale.cjs 10000 [20000 50000 …]
 */
const fs = require("fs"), os = require("os"), path = require("path");
const { startWorker, api, until, sleep } = require("./helpers.cjs");
const sizes = process.argv.slice(2).map(Number);
const ym = (i) => { const d = new Date(Date.UTC(2024, 9 + i, 1)); return d.toISOString().slice(0, 7); };
const months = Array.from({ length: 21 }, (_, i) => ym(i));

(async () => {
  const out = {};
  for (const N of sizes) {
    const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), `scale-${N}-`));
    const w = startWorker(8900, stateDir, {});
    const req = api(w.base);
    const r = { products: N };
    try {
      await w.ready;
      const owner = (await req("/api/owner/claim", { method: "POST", body: { passcode: "owner-pass-123" } })).data.token;
      const A = await req("/api/signup", { method: "POST", body: { company: "Scale Co", email: `s${N}@scale.test`, password: "scale-pass-1" } });
      await req("/api/owner/contract", { method: "POST", token: owner, body: { id: A.data.me.id, plan: "Enterprise", contract: 30000, allFeatures: true } });
      const tok = A.data.token;
      const series = Array.from({ length: N }, (_, p) => ({ product: `Product ${p}`, amount: months.map((_, t) => Math.round((50 + (p % 97) * 13) * (1 + 0.01 * t) * (1 + 0.2 * Math.sin((t + p) / 1.9)) * 100) / 100) }));
      const t0 = Date.now();
      let up = null, calls = 0;
      for (let i = 0; i < N; i += 40) { // the same 40-product parts the app sends
        const part = series.slice(i, i + 40);
        const res = up ? await req(`/api/uploads/${up}/series`, { method: "POST", token: tok, body: { name: "Scale", months, series: part } })
          : await req("/api/uploads", { method: "POST", token: tok, body: { name: "Scale", months, series: part, final: false } });
        calls++;
        if (res.status !== 200) throw new Error(`upload part ${i}: ${res.status} ${JSON.stringify(res.data).slice(0, 200)}`);
        if (!up) up = res.data.upload.id;
      }
      const fin = await req(`/api/uploads/${up}/finish`, { method: "POST", token: tok });
      if (fin.status !== 200) throw new Error(`finish: ${fin.status} ${JSON.stringify(fin.data).slice(0, 200)}`);
      r.uploadSeconds = (Date.now() - t0) / 1000; r.uploadRequests = calls + 1;
      // Watch the largest single stored value while the work runs (Cloudflare allows 2 MB per value).
      const { execFileSync } = require("child_process");
      const py = `import sqlite3,sys,glob\nm=0\nfor f in glob.glob(sys.argv[1]+'/**/*.sqlite',recursive=True):\n  try:\n    c=sqlite3.connect('file:'+f+'?mode=ro',uri=True)\n    for t in ['series','results','views','idx','stage','groups','jobs','partials']:\n      try:\n        col='payload' if t=='jobs' else 'blob'\n        v=c.execute(f'select max(length({col})) from {t}').fetchone()[0] or 0; m=max(m,v)\n      except Exception: pass\n  except Exception: pass\nprint(m)`;
      let maxValue = 0; const mon = setInterval(() => { try { maxValue = Math.max(maxValue, Number(execFileSync("python3", ["-c", py, stateDir]).toString().trim())); } catch { /* busy */ } }, 1500);
      const t1 = Date.now();
      const bt = await until(async () => { const u = (await req(`/api/uploads/${up}`, { token: tok })).data.upload; return u && (u.status === "ready" || u.status === "error") ? u : null; }, 3600_000, 2000);
      r.accuracyTestSeconds = (Date.now() - t1) / 1000;
      if (!bt || bt.status === "error" || !bt.backtest?.ok) throw new Error(`accuracy test: ${bt?.status} ${bt?.error || bt?.backtest?.reason || "timed out"}`);
      r.accuracy = bt.backtest.accuracy;
      const t2 = Date.now();
      await req(`/api/uploads/${up}/forecast`, { method: "POST", token: tok });
      const fc = await until(async () => { const u = (await req(`/api/uploads/${up}`, { token: tok })).data.upload; return u && u.forecast ? u : u?.status === "error" ? u : null; }, 3600_000, 2000);
      r.forecastSeconds = (Date.now() - t2) / 1000;
      if (!fc?.forecast?.ok) throw new Error(`forecast: ${fc?.status} ${fc?.error || "timed out"}`);
      const jobs = (await req("/api/jobs", { token: tok })).data.jobs;
      clearInterval(mon); r.maxStoredValueKB = Math.round(maxValue / 1024);
      r.steps = jobs.reduce((a, j) => a + (j.kind === "compute" ? Math.ceil(j.total / 12) : 0), 0);
      r.ok = true;
    } catch (e) { r.ok = false; r.error = e.message; r.log = w.log.join("").split("\n").filter((l) => /ERROR|Error|too big|SQLITE/.test(l)).slice(-5).join(" | "); }
    const files = []; const walk = (d) => { for (const e of fs.readdirSync(d, { withFileTypes: true })) { const p = path.join(d, e.name); e.isDirectory() ? walk(p) : files.push(p); } }; walk(stateDir);
    r.storageMB = Math.round(files.reduce((a, f) => a + fs.statSync(f).size, 0) / 1e5) / 10;
    await w.stop();
    fs.rmSync(stateDir, { recursive: true, force: true });
    out[N] = r;
    console.log("RESULT", JSON.stringify(r));
  }
  fs.writeFileSync(path.join(__dirname, "output", "scale.json"), JSON.stringify(out, null, 2));
})().catch((e) => { console.error(e); process.exit(1); });
