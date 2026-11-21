/**
 * Local static server for tests — behaves like the Cloudflare deployment:
 *   "/" → index.html, "/v" → v.html (any "/name" → name.html), "/dir/" → dir/index.html,
 *   headers from public/_headers, 404 → public/404.html with status 404.
 * Test-only extras (never deployed):
 *   "/__tests/<file>" serves tests/harness/<file> (harness pages; scripts must be external files — CSP).
 *   start(port, { stubMissing: true }) answers missing public *.js with "export {};" and *.css with ""
 *   (lets one builder test while other builders' files don't exist yet).
 *   "/api/*" is a stand-in for the Worker's API (worker/index.js): POST /api/ping answers 204 and keeps each body in
 *   srv.pings (so tests can check exactly what leaves the phone); /api/activate, /api/check and /api/contact follow
 *   the personal-link rules (srv.licenses); /api/console/* is a small in-memory console.
 *   The real Worker API is tested in tests/worker.test.cjs (wrangler dev).
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

function apiStub(req, res, urlPath, pings, con, licenses, activations) {
  const reply = (status, data) => {
    res.writeHead(status, { "Content-Type": "application/json", "Cache-Control": "no-store" });
    res.end(data === undefined ? "" : JSON.stringify(data));
  };
  let raw = "";
  req.on("data", (c) => { raw += c; });
  req.on("end", () => {
    let body = {};
    try { body = raw ? JSON.parse(raw) : {}; } catch { return reply(400, { error: "bad request" }); }
    const auth = (req.headers.authorization || "").replace(/^Bearer\s+/i, "");
    if (urlPath === "/api/ping" && req.method === "POST") { pings.push({ body, raw, headers: req.headers }); return reply(204); }
    // Personal links (the same rules as the Worker; a well-formed key nobody set up works on up to 100 phones).
    if ((urlPath === "/api/activate" || urlPath === "/api/check") && req.method === "POST") {
      const ok = (k) => typeof k === "string" && /^[0-9a-f]{32}$/.test(k);
      if (!ok(body.key) || !ok(body.device)) return reply(403, { ok: false, reason: "unknown", contact: con.contact });
      if (!licenses.has(body.key)) licenses.set(body.key, { devices: 100, off: false, phones: new Map() });
      const l = licenses.get(body.key);
      activations.push({ path: urlPath, key: body.key, device: body.device });
      if (l.off) return reply(403, { ok: false, reason: "off", contact: con.contact });
      if (l.phones.has(body.device)) return l.phones.get(body.device).off ? reply(403, { ok: false, reason: "off", contact: con.contact }) : reply(200, { ok: true });
      if (urlPath === "/api/check") return reply(403, { ok: false, reason: "off", contact: con.contact });
      if ([...l.phones.values()].filter((d) => !d.off).length >= l.devices) return reply(403, { ok: false, reason: "full", contact: con.contact });
      l.phones.set(body.device, { off: false });
      return reply(200, { ok: true });
    }
    if (urlPath === "/api/contact") return reply(200, { contact: con.contact });
    if (urlPath === "/api/console/state") return reply(200, { claimed: Boolean(con.passcode) });
    if (urlPath === "/api/console/claim" || urlPath === "/api/console/login") {
      const pass = String(body.passcode || "");
      if (pass.length < 8) return reply(400, { error: "The passcode needs at least 8 characters." });
      if (urlPath.endsWith("claim")) { if (con.passcode) return reply(409, { error: "A passcode is already set. Enter it to open the console." }); con.passcode = pass; }
      else if (pass !== con.passcode) return reply(401, { error: "That passcode isn't right." });
      con.token = `t${Date.now()}`;
      return reply(200, { token: con.token });
    }
    if (urlPath === "/api/console/stats") return auth && auth === con.token ? reply(200, con.stats()) : reply(401, { error: "Please enter your passcode again." });
    if (urlPath === "/api/console/logout") { con.token = null; return reply(204); }
    return reply(404, { error: "not found" });
  });
}

/** Counts the stand-in console shows, made from the pings this server received (same shape as the Worker's). */
function stubStats(pings) {
  const KINDS = ["open", "setup", "invoice", "voice", "print", "pdf", "picture"];
  const today = new Date().toISOString().slice(0, 10);
  const add = (iso, n) => { const d = new Date(`${iso}T12:00:00Z`); d.setUTCDate(d.getUTCDate() + n); return d.toISOString().slice(0, 10); };
  const days = Array.from({ length: 30 }, (_, k) => ({ day: add(today, k - 29), active: 0, invoices: 0, setups: 0 }));
  const totals = Object.fromEntries(KINDS.map((k) => [k, 0]));
  const phones = new Set(), set = new Set(), activeByDay = new Map();
  for (const p of pings) for (const e of p.body.events || []) {
    totals[e.kind] = (totals[e.kind] || 0) + 1;
    phones.add(p.body.device);
    if (e.kind === "setup") set.add(p.body.device);
    if (!activeByDay.has(e.day)) activeByDay.set(e.day, new Set());
    activeByDay.get(e.day).add(p.body.device);
    const d = days.find((x) => x.day === e.day);
    if (d && e.kind === "invoice") d.invoices++;
    if (d && e.kind === "setup") d.setups++;
  }
  for (const d of days) d.active = activeByDay.get(d.day)?.size || 0;
  return { today, businesses: set.size, phones: phones.size, activeToday: days[29].active, active7: phones.size, active30: phones.size,
    totals, last30: { ...totals }, days, passcodeSince: today };
}

function start(port, { stubMissing = false, root = null } = {}) {
  if (root) ROOT = root;
  const pings = [], activations = [], licenses = new Map();
  const con = { passcode: null, token: null, contact: "", stats: () => stubStats(pings) };
  const server = http.createServer((req, res) => {
    const urlPath = new URL(req.url, "http://x").pathname;
    if (urlPath.startsWith("/api/")) return apiStub(req, res, urlPath, pings, con, licenses, activations);
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
    pings,
    console: con,
    licenses,     // key → { devices, off, phones: Map(device → { off }) }
    activations,  // every /api/activate and /api/check call
    close: () => new Promise((done) => { server.close(done); server.closeAllConnections?.(); }),
  })));
}

module.exports = { start };

if (require.main === module) {
  const port = Number(process.argv[2]) || 8790;
  start(port, { stubMissing: process.argv.includes("--stub-missing") }).then((s) => console.log(`ready ${s.url}`));
}
