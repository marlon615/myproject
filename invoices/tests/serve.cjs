/**
 * Local static server for tests — behaves like the Cloudflare deployment:
 *   "/" → index.html, "/v" → v.html (any "/name" → name.html), "/dir/" → dir/index.html,
 *   headers from public/_headers, 404 → public/404.html with status 404.
 * Test-only extras (never deployed):
 *   "/__tests/<file>" serves tests/harness/<file> (harness pages; scripts must be external files — CSP).
 *   start(port, { stubMissing: true }) answers missing public *.js with "export {};" and *.css with ""
 *   (lets one builder test while other builders' files don't exist yet).
 * Usage: node tests/serve.cjs <port> [--stub-missing]     (prints "ready http://localhost:<port>")
 * In a test: const srv = await require('./serve.cjs').start(8791); … await srv.close();
 */
const http = require("http");
const fs = require("fs");
const path = require("path");

let ROOT = path.join(__dirname, "..", "public");
const HARNESS = path.join(__dirname, "harness");
const TYPES = {
  ".html": "text/html; charset=utf-8", ".js": "text/javascript; charset=utf-8", ".mjs": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8", ".json": "application/json", ".webmanifest": "application/manifest+json",
  ".png": "image/png", ".svg": "image/svg+xml", ".ico": "image/x-icon", ".jpg": "image/jpeg", ".txt": "text/plain; charset=utf-8",
};

function parseHeaders() {
  const file = path.join(ROOT, "_headers");
  if (!fs.existsSync(file)) return [];
  const rules = [];
  let cur = null;
  for (const raw of fs.readFileSync(file, "utf8").split("\n")) {
    if (!raw.trim() || raw.trim().startsWith("#")) continue;
    if (!/^\s/.test(raw)) { cur = { pattern: raw.trim(), headers: {} }; rules.push(cur); continue; }
    const i = raw.indexOf(":");
    if (cur && i > 0) cur.headers[raw.slice(0, i).trim()] = raw.slice(i + 1).trim();
  }
  return rules;
}

function matches(pattern, urlPath) {
  if (pattern.endsWith("*")) return urlPath.startsWith(pattern.slice(0, -1));
  return pattern === urlPath;
}

function resolve(urlPath) {
  let p = decodeURIComponent(urlPath.split("?")[0]);
  if (p.includes("\0") || p.split("/").includes("..")) return null;
  const candidates = p.endsWith("/") ? [p + "index.html"] : [p, p + ".html", p + "/index.html"];
  for (const c of candidates) {
    const f = path.join(ROOT, c);
    if (f.startsWith(ROOT) && fs.existsSync(f) && fs.statSync(f).isFile() && !path.basename(f).startsWith("_")) return f;
  }
  return null;
}

function start(port, { stubMissing = false, root = null } = {}) {
  if (root) ROOT = root;
  const server = http.createServer((req, res) => {
    const urlPath = new URL(req.url, "http://x").pathname;
    if (urlPath.startsWith("/__tests/")) {
      const rel = decodeURIComponent(urlPath.slice("/__tests/".length));
      const f = path.join(HARNESS, rel);
      if (!rel.split("/").includes("..") && f.startsWith(HARNESS) && fs.existsSync(f) && fs.statSync(f).isFile()) {
        res.writeHead(200, { "Content-Type": TYPES[path.extname(f)] || "application/octet-stream", "Cache-Control": "no-cache",
          "Content-Security-Policy": (parseHeaders().find((r) => r.pattern === "/*") || { headers: {} }).headers["Content-Security-Policy"] || "" });
        return fs.createReadStream(f).pipe(res);
      }
    }
    const rules = parseHeaders();
    const send = (status, file) => {
      const headers = { "Content-Type": TYPES[path.extname(file)] || "application/octet-stream", "Cache-Control": "no-cache" };
      for (const r of rules) if (matches(r.pattern, urlPath)) Object.assign(headers, r.headers);
      res.writeHead(status, headers);
      if (req.method === "HEAD") return res.end();
      fs.createReadStream(file).pipe(res);
    };
    const f = resolve(urlPath);
    if (f) return send(200, f);
    if (stubMissing && /\.(js|css)$/.test(urlPath)) {
      res.writeHead(200, { "Content-Type": urlPath.endsWith(".js") ? TYPES[".js"] : TYPES[".css"], "Cache-Control": "no-cache", "X-Stub": "1" });
      return res.end(urlPath.endsWith(".js") ? "export {};\n" : "");
    }
    const nf = path.join(ROOT, "404.html");
    if (fs.existsSync(nf)) return send(404, nf);
    res.writeHead(404, { "Content-Type": "text/plain" });
    res.end("Not found");
  });
  return new Promise((ok) => server.listen(port, () => ok({
    url: `http://localhost:${port}`,
    close: () => new Promise((done) => { server.close(done); server.closeAllConnections?.(); }),
  })));
}

module.exports = { start };

if (require.main === module) {
  const port = Number(process.argv[2]) || 8790;
  start(port, { stubMissing: process.argv.includes("--stub-missing") }).then((s) => console.log(`ready ${s.url}`));
}
