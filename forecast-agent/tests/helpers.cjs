/** Shared test helpers: start the real Worker locally (wrangler dev), make API calls, report checks. */
const { spawn } = require("child_process");
const path = require("path");
const APP = path.join(__dirname, "..");
const WRANGLER = path.join(APP, "..", "chief-of-staff", "node_modules", ".bin", "wrangler");
const sleep = (ms) => new Promise((ok) => setTimeout(ok, ms));

function checker() {
  let failures = 0;
  const check = (ok, name, extra = "") => { console.log(`${ok ? "PASS" : "FAIL"}  ${name}${extra ? "  — " + extra : ""}`); if (!ok) failures++; };
  return { check, failures: () => failures };
}
function startWorker(port, stateDir, vars = {}) {
  const log = [];
  const args = ["dev", "--port", String(port), "--persist-to", stateDir, "--show-interactive-dev-session=false", "--log-level", "warn"];
  for (const [k, v] of Object.entries(vars)) args.push("--var", `${k}:${v}`);
  const child = spawn(WRANGLER, args, { cwd: APP, env: { ...process.env, WRANGLER_SEND_METRICS: "false", CLOUDFLARE_API_TOKEN: "placeholder-not-used-locally" }, stdio: ["ignore", "pipe", "pipe"] });
  child.stdout.on("data", (d) => log.push(String(d)));
  child.stderr.on("data", (d) => log.push(String(d)));
  const base = `http://localhost:${port}`;
  const ready = (async () => {
    for (let i = 0; i < 120; i++) { try { if ((await fetch(`${base}/api/owner/state`)).status) return; } catch { /* not yet */ } await sleep(500); }
    throw new Error(`wrangler dev didn't start:\n${log.join("")}`);
  })();
  return { base, ready, log, stop: () => new Promise((ok) => { child.once("exit", ok); child.kill("SIGTERM"); setTimeout(() => { child.kill("SIGKILL"); ok(); }, 5000); }) };
}
function api(base) {
  return async (p, { method = "GET", body, token, raw, headers = {} } = {}) => {
    const r = await fetch(base + p, { method, redirect: "manual", headers: { ...(body && !raw ? { "content-type": "application/json" } : {}), ...(token ? { Authorization: `Bearer ${token}` } : {}), ...headers }, body: raw ?? (body ? JSON.stringify(body) : undefined) });
    const text = await r.text();
    let data = {}; try { data = text ? JSON.parse(text) : {}; } catch { data = { text }; }
    return { status: r.status, data, headers: r.headers };
  };
}
/** Polls until fn() returns truthy (or the time is up). */
async function until(fn, ms = 20000, every = 300) { const end = Date.now() + ms; while (Date.now() < end) { const v = await fn(); if (v) return v; await sleep(every); } return null; }
module.exports = { checker, startWorker, api, until, sleep, APP };
