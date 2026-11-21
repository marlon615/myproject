/**
 * Builds the public website (site/pages/*.html) into public/, with one shared header, footer and layout.
 * Also puts the same header and footer on the demo (public/demo.html) and API guide (public/docs.html), between their
 * <!--site:header--> / <!--site:footer--> markers, and writes robots.txt and sitemap.xml.
 *
 * The domain is never written into a page: "__SITE_URL__" is replaced when a page is served, with the SITE_URL setting
 * in wrangler.toml (or, when that's empty, the address the visitor used). See worker/index.js.
 *
 * Each page starts with a comment block:  <!-- title: … / description: … / path: /x -->
 * Usage: node scripts/build-site.cjs   (build-worker.cjs runs it first)
 */
const fs = require("fs"), path = require("path");
const ROOT = path.join(__dirname, ".."), SITE = path.join(ROOT, "site"), PUBLIC = path.join(ROOT, "public");
const read = (f) => fs.readFileSync(path.join(SITE, f), "utf8");
const layout = read("layout.html"), year = String(new Date().getUTCFullYear());
const header = read("header.html").trim(), footer = read("footer.html").trim().replace("{{year}}", year);
const esc = (s) => s.replace(/&/g, "&amp;").replace(/"/g, "&quot;").replace(/</g, "&lt;");

const pages = [];
for (const file of fs.readdirSync(path.join(SITE, "pages")).filter((f) => f.endsWith(".html")).sort()) {
  const raw = read(path.join("pages", file));
  const m = raw.match(/^<!--([\s\S]*?)-->\s*/);
  if (!m) throw new Error(`${file}: missing the title/description/path comment`);
  const meta = Object.fromEntries(m[1].split("\n").map((l) => l.match(/^\s*(\w+):\s*(.*)$/)).filter(Boolean).map((x) => [x[1], x[2].trim()]));
  for (const k of ["title", "description", "path"]) if (!meta[k]) throw new Error(`${file}: missing ${k}`);
  const slug = file.replace(/\.html$/, "");
  const html = layout
    .replace(/{{title}}/g, esc(meta.title)).replace(/{{description}}/g, esc(meta.description)).replace(/{{path}}/g, meta.path === "/" ? "/" : meta.path)
    .replace("{{slug}}", slug).replace("{{header}}", header).replace("{{footer}}", footer).replace("{{content}}", raw.slice(m[0].length).trim());
  const out = slug === "home" ? "index.html" : `${slug}.html`;
  fs.writeFileSync(path.join(PUBLIC, out), html);
  if (meta.sitemap !== "no") pages.push(meta.path);
}

// The demo and the API guide keep their own content and styles; they get the site's header and footer.
for (const f of ["demo.html", "docs.html"]) {
  const p = path.join(PUBLIC, f);
  let s = fs.readFileSync(p, "utf8");
  for (const [name, html] of [["header", header], ["footer", footer]]) {
    const re = new RegExp(`<!--site:${name}-->[\\s\\S]*?<!--/site:${name}-->`);
    if (!re.test(s)) throw new Error(`${f}: missing <!--site:${name}--> markers`);
    s = s.replace(re, `<!--site:${name}-->\n${html}\n<!--/site:${name}-->`);
  }
  fs.writeFileSync(p, s);
}

fs.writeFileSync(path.join(PUBLIC, "robots.txt"), `User-agent: *\nDisallow: /app\nDisallow: /owner\nDisallow: /api/\nDisallow: /v1/\nSitemap: __SITE_URL__/sitemap.xml\n`);
fs.writeFileSync(path.join(PUBLIC, "sitemap.xml"), `<?xml version="1.0" encoding="UTF-8"?>\n<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n${[...pages, "/demo", "/docs"].map((p) => `  <url><loc>__SITE_URL__${p}</loc></url>`).join("\n")}\n</urlset>\n`);
console.log(`site: ${pages.length} pages built`);
