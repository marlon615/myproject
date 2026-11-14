/**
 * Writes a content hash of every precached file into `const VERSION = "…";` in public/sw.js, so phones pick up
 * a new version exactly when something changed. Idempotent: the VERSION line itself is not part of the hash.
 * Usage: node scripts/stamp-sw.cjs
 */
const fs = require("fs");
const path = require("path");
const crypto = require("crypto");

const PUBLIC = path.join(__dirname, "..", "public");
const SW = path.join(PUBLIC, "sw.js");
const fileFor = (url) => path.join(PUBLIC, url === "/" ? "index.html" : url === "/v" ? "v.html" : url.slice(1));

const sw = fs.readFileSync(SW, "utf8");
const list = /const PRECACHE = \[([\s\S]*?)\];/.exec(sw);
if (!list) throw new Error("PRECACHE list not found in sw.js");
const urls = [...list[1].matchAll(/"([^"]+)"/g)].map((m) => m[1]);

const hash = crypto.createHash("sha256");
hash.update(sw.replace(/const VERSION = "[^"]*";/, ""));
for (const url of urls) {
  const file = fileFor(url);
  if (!fs.existsSync(file)) throw new Error(`Precached file is missing: ${url} (${file})`);
  hash.update(url + "\0");
  hash.update(fs.readFileSync(file));
}
const version = hash.digest("hex").slice(0, 12);
const next = sw.replace(/const VERSION = "[^"]*";/, `const VERSION = "${version}";`);
if (next !== sw) fs.writeFileSync(SW, next);
console.log(`sw.js VERSION ${version} (${urls.length} files)`);
