/** Runs every tests/*.test.cjs one after another and prints a summary. Exit code 1 if any fail. */
const { spawnSync } = require("child_process");
const fs = require("fs");
const path = require("path");

const dir = __dirname;
const only = process.argv.slice(2);
const files = fs.readdirSync(dir).filter((f) => f.endsWith(".test.cjs") && (!only.length || only.some((o) => f.includes(o)))).sort();
fs.mkdirSync(path.join(dir, "output"), { recursive: true });

const results = [];
for (const f of files) {
  const started = process.hrtime.bigint();
  console.log(`\n━━ ${f} ━━`);
  const r = spawnSync(process.execPath, [path.join(dir, f)], { stdio: "inherit", cwd: path.join(dir, ".."), timeout: 15 * 60 * 1000 });
  const secs = Number(process.hrtime.bigint() - started) / 1e9;
  results.push({ f, ok: r.status === 0, secs, why: r.error ? r.error.message : r.signal ? `signal ${r.signal}` : `exit ${r.status}` });
}

console.log("\n━━ Summary ━━");
for (const r of results) console.log(`${r.ok ? "PASS" : "FAIL"}  ${r.f}  (${r.secs.toFixed(1)}s${r.ok ? "" : ", " + r.why})`);
const failed = results.filter((r) => !r.ok).length;
console.log(failed ? `\n${failed} of ${results.length} test files failed.` : `\nAll ${results.length} test files passed.`);
process.exit(failed ? 1 : 0);
