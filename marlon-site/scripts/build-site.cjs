/**
 * Builds the Marlon website: site/pages/*.html → public/*.html, each wrapped in site/layout.html with the shared
 * header and footer, plus robots.txt, sitemap.xml and site.webmanifest.
 *
 * Each page starts with a comment block:
 *   <!-- title: …  description: …  path: /x  [nav: x]  [schema: faq|product]  [sitemap: no]  [robots: noindex] -->
 * In pages, {{icon:name}} becomes an inline SVG icon (list below) and {{site}} the site's address.
 * Usage: node scripts/build-site.cjs      (SITE_URL=https://… to build for another address)
 */
const fs = require("fs"), path = require("path");
const ROOT = path.join(__dirname, ".."), SITE = path.join(ROOT, "site"), PUBLIC = path.join(ROOT, "public");
const SITE_URL = (process.env.SITE_URL || "https://marlon.marlon615.workers.dev").replace(/\/$/, "");
const EMAIL = "marlonapp.sales@gmail.com";
const read = (f) => fs.readFileSync(path.join(SITE, f), "utf8");
const esc = (s) => String(s).replace(/&/g, "&amp;").replace(/"/g, "&quot;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
const year = String(new Date().getUTCFullYear());

// Line icons (24×24, stroke = currentColor).
const P = {
  offline: '<path d="M2 8.8a15 15 0 0 1 4.2-2.6M22 8.8A15 15 0 0 0 10.7 5M5.5 12.5a9.6 9.6 0 0 1 3.1-1.9M18.5 12.5a9.6 9.6 0 0 0-2.4-1.6M9 16.2a4.8 4.8 0 0 1 6 0"/><circle cx="12" cy="19.5" r=".6" fill="currentColor"/><path d="m3 3 18 18"/>',
  lock: '<rect x="4.5" y="10.5" width="15" height="10" rx="2.5"/><path d="M8 10.5V7.5a4 4 0 0 1 8 0v3"/><path d="M12 14.5v2.5"/>',
  phonelock: '<rect x="6" y="2.5" width="12" height="19" rx="2.5"/><path d="M10.5 18.5h3"/><rect x="9" y="9.8" width="6" height="4.7" rx="1"/><path d="M10.2 9.8V8.7a1.8 1.8 0 0 1 3.6 0v1.1"/>',
  dashboard: '<rect x="3" y="3" width="7.5" height="9" rx="1.5"/><rect x="13.5" y="3" width="7.5" height="5" rx="1.5"/><rect x="13.5" y="11" width="7.5" height="10" rx="1.5"/><rect x="3" y="15" width="7.5" height="6" rx="1.5"/>',
  mic: '<rect x="9" y="2.5" width="6" height="11.5" rx="3"/><path d="M5.5 11a6.5 6.5 0 0 0 13 0M12 17.5v4M8.5 21.5h7"/>',
  sign: '<path d="M3 17c2.5-4 4.5-9 6.5-9S9 16 11 16s2.5-4 4-4 1 3 2.5 3c1 0 2-1 3.5-2.5"/><path d="M3 21h18"/>',
  send: '<path d="M21.5 2.5 10.5 13.5"/><path d="M21.5 2.5 14.5 21.5l-4-8-8-4 19-7z"/>',
  pdf: '<path d="M14 2.5H6.5A2 2 0 0 0 4.5 4.5v15a2 2 0 0 0 2 2h11a2 2 0 0 0 2-2V8z"/><path d="M14 2.5V8h5.5M8 13h8M8 17h5"/>',
  qr: '<rect x="3" y="3" width="7" height="7" rx="1"/><rect x="14" y="3" width="7" height="7" rx="1"/><rect x="3" y="14" width="7" height="7" rx="1"/><path d="M14 14h3v3h-3zM20 14v.01M14 20h.01M17 20h4v-3"/>',
  printer: '<path d="M6.5 9V3h11v6"/><rect x="3" y="9" width="18" height="8" rx="2"/><path d="M6.5 14h11v7h-11z"/>',
  users: '<circle cx="9" cy="8" r="3.5"/><path d="M2.5 20a6.5 6.5 0 0 1 13 0"/><circle cx="17.5" cy="9" r="2.6"/><path d="M16.5 14.2A5 5 0 0 1 22 19"/>',
  store: '<path d="M3.5 9.5 5 4h14l1.5 5.5"/><path d="M3.5 9.5a2.7 2.7 0 0 0 5.4 0 2.7 2.7 0 0 0 5.4 0 2.7 2.7 0 0 0 5.4 0"/><path d="M5 12v8.5h14V12M10 20.5v-5h4v5"/>',
  boss: '<path d="M3 21h18"/><path d="M5 21V8l7-4.5L19 8v13"/><path d="M9.5 21v-6h5v6M9 10.5h.01M15 10.5h.01"/>',
  truck: '<path d="M2.5 6.5h11v10h-11zM13.5 10h4.5l3.5 3.5v3h-8"/><circle cx="6.5" cy="18" r="2"/><circle cx="17" cy="18" r="2"/>',
  camera: '<path d="M3 8.5a2 2 0 0 1 2-2h2.5l1.5-2.5h6l1.5 2.5H19a2 2 0 0 1 2 2V18a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z"/><circle cx="12" cy="13" r="3.8"/>',
  chart: '<path d="M3 3v18h18"/><path d="M7 15v2M11 11v6M15 13v4M19 7v10"/>',
  undo: '<path d="M9 14 4 9l5-5"/><path d="M4 9h10.5a5.5 5.5 0 0 1 0 11H11"/>',
  shield: '<path d="M12 2.5 4 5.5v6c0 5 3.4 8.6 8 10 4.6-1.4 8-5 8-10v-6z"/><path d="m8.5 12 2.5 2.5 4.5-5"/>',
  key: '<circle cx="7.5" cy="15.5" r="4"/><path d="m10.5 12.5 9-9M16 7l3 3M14 9l2 2"/>',
  cloud: '<path d="M7 18.5a4.5 4.5 0 0 1-.6-9 6 6 0 0 1 11.5 1.5A3.8 3.8 0 0 1 17.5 18.5z"/>',
  eye: '<path d="M2 12s3.6-7 10-7 10 7 10 7-3.6 7-10 7S2 12 2 12z"/><circle cx="12" cy="12" r="3"/>',
  money: '<rect x="2.5" y="6" width="19" height="12" rx="2"/><circle cx="12" cy="12" r="2.8"/><path d="M6 9.5v.01M18 14.5v.01"/>',
  calendar: '<rect x="3" y="4.5" width="18" height="16.5" rx="2"/><path d="M3 9.5h18M8 2.5v4M16 2.5v4"/>',
  bell: '<path d="M6 9.5a6 6 0 0 1 12 0c0 6 2.5 7.5 2.5 7.5h-17S6 15.5 6 9.5z"/><path d="M10 20.5a2.2 2.2 0 0 0 4 0"/>',
  download: '<path d="M12 3v12M7 10l5 5 5-5M4 19.5h16"/>',
  refresh: '<path d="M20.5 12a8.5 8.5 0 0 1-15.2 5.2M3.5 12a8.5 8.5 0 0 1 15.2-5.2"/><path d="M19 3v4h-4M5 21v-4h4"/>',
  mail: '<rect x="2.5" y="4.5" width="19" height="15" rx="2"/><path d="m3 6 9 7 9-7"/>',
  check: '<path d="m4.5 12.5 5 5 10-11"/>',
  play: '<circle cx="12" cy="12" r="9.5"/><path d="m10 8.5 5.5 3.5-5.5 3.5z" fill="currentColor"/>',
  doc: '<path d="M14 2.5H6.5A2 2 0 0 0 4.5 4.5v15a2 2 0 0 0 2 2h11a2 2 0 0 0 2-2V8z"/><path d="M14 2.5V8h5.5M8 12.5h8M8 16.5h8"/>',
  globe: '<circle cx="12" cy="12" r="9.5"/><path d="M2.5 12h19M12 2.5c2.6 2.8 4 6 4 9.5s-1.4 6.7-4 9.5c-2.6-2.8-4-6-4-9.5s1.4-6.7 4-9.5z"/>',
  box: '<path d="M21 7.5 12 3 3 7.5v9L12 21l9-4.5z"/><path d="M3 7.5 12 12l9-4.5M12 12v9"/>',
  tag: '<path d="M3 12V4a1 1 0 0 1 1-1h8l9 9-9 9z"/><circle cx="7.5" cy="7.5" r="1.4"/>',
};
const icon = (name) => {
  if (!P[name]) throw new Error(`unknown icon: ${name}`);
  return `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true" focusable="false">${P[name]}</svg>`;
};

const ORG = {
  "@type": "Organization", "@id": `${SITE_URL}/#org`, name: "M. D. Williams Enterprise", brand: { "@type": "Brand", name: "Marlon" },
  url: SITE_URL, logo: `${SITE_URL}/icons/icon-512.png`, email: EMAIL,
  address: { "@type": "PostalAddress", addressLocality: "Gutters", addressRegion: "St. Catherine", addressCountry: "JM" },
};
const PRODUCT = {
  "@type": "SoftwareApplication", name: "Marlon", applicationCategory: "BusinessApplication", operatingSystem: "Android, iOS (installs from the browser)",
  description: "Offline delivery invoicing and route sales software for any business: invoices, signatures, a boss dashboard and rep phones that work without signal.",
  url: SITE_URL, publisher: { "@id": `${SITE_URL}/#org` },
  offers: [
    { "@type": "Offer", name: "Marlon", price: "79.00", priceCurrency: "USD", description: "One-time, per rep (a solo business counts as one rep). Covers the first year. Team discounts from 5 reps." },
    { "@type": "Offer", name: "Marlon Pro", price: "25.00", priceCurrency: "USD", description: "Per rep, per month, with the same team discounts." },
  ],
};
const strip = (html) => html.replace(/<[^>]+>/g, " ").replace(/&amp;/g, "&").replace(/&quot;/g, '"').replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&nbsp;/g, " ").replace(/\s+/g, " ").trim();

const layout = read("layout.html");
const header = read("header.html").trim();
const footer = read("footer.html").trim().replace(/{{year}}/g, year);
const pages = [];
for (const file of fs.readdirSync(path.join(SITE, "pages")).filter((f) => f.endsWith(".html")).sort()) {
  const raw = read(path.join("pages", file));
  const m = raw.match(/^<!--([\s\S]*?)-->\s*/);
  if (!m) throw new Error(`${file}: missing the meta comment`);
  const meta = Object.fromEntries(m[1].split("\n").map((l) => l.match(/^\s*(\w+):\s*(.*)$/)).filter(Boolean).map((x) => [x[1], x[2].trim()]));
  for (const k of ["title", "description", "path"]) if (!meta[k]) throw new Error(`${file}: missing ${k}`);
  if (meta.description.length > 170) throw new Error(`${file}: description is ${meta.description.length} characters (keep it under 170)`);
  const slug = file.replace(/\.html$/, "");
  let content = raw.slice(m[0].length).trim().replace(/{{icon:([a-z]+)}}/g, (_, n) => icon(n)).replace(/{{site}}/g, SITE_URL).replace(/{{email}}/g, EMAIL);
  const graph = [ORG];
  if (meta.schema === "product") graph.push(PRODUCT);
  if (meta.schema === "faq") {
    const qa = [...content.matchAll(/<details[^>]*>\s*<summary>([\s\S]*?)<\/summary>\s*<div>([\s\S]*?)<\/div>\s*<\/details>/g)];
    if (qa.length < 5) throw new Error(`${file}: schema faq but only ${qa.length} questions found`);
    graph.push({ "@type": "FAQPage", mainEntity: qa.map(([, q, a]) => ({ "@type": "Question", name: strip(q), acceptedAnswer: { "@type": "Answer", text: strip(a) } })) });
  }
  const url = SITE_URL + (meta.path === "/" ? "/" : meta.path);
  const html = layout
    .replace(/{{title}}/g, esc(meta.title)).replace(/{{description}}/g, esc(meta.description)).replace(/{{url}}/g, url).replace(/{{site}}/g, SITE_URL)
    .replace("{{robots}}", meta.robots || "index, follow").replace("{{slug}}", slug)
    .replace("{{jsonld}}", JSON.stringify({ "@context": "https://schema.org", "@graph": graph }).replace(/</g, "\\u003c"))
    .replace("{{header}}", header.replace(/{{icon:([a-z]+)}}/g, (_, n) => icon(n)))
    .replace("{{footer}}", footer.replace(/{{email}}/g, EMAIL))
    .replace("{{content}}", content)
    .replace("{{scripts}}", meta.script ? `<script src="/${meta.script}" defer></script>` : "");
  const out = slug === "home" ? "index.html" : `${slug}.html`;
  fs.writeFileSync(path.join(PUBLIC, out), html);
  if (meta.sitemap !== "no") pages.push(meta.path);
}
fs.writeFileSync(path.join(PUBLIC, "robots.txt"), `User-agent: *\nAllow: /\nDisallow: /inbox\nDisallow: /api/\n\nSitemap: ${SITE_URL}/sitemap.xml\n`);
const today = new Date().toISOString().slice(0, 10);
fs.writeFileSync(path.join(PUBLIC, "sitemap.xml"), `<?xml version="1.0" encoding="UTF-8"?>\n<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n${pages
  .map((p) => `  <url><loc>${SITE_URL}${p === "/" ? "/" : p}</loc><lastmod>${today}</lastmod></url>`).join("\n")}\n</urlset>\n`);
fs.writeFileSync(path.join(PUBLIC, "site.webmanifest"), JSON.stringify({
  name: "Marlon", short_name: "Marlon", start_url: "/", display: "browser", background_color: "#0f1a14", theme_color: "#0f1a14",
  icons: [{ src: "/icons/icon-192.png", sizes: "192x192", type: "image/png" }, { src: "/icons/icon-512.png", sizes: "512x512", type: "image/png" }],
}, null, 2) + "\n");
console.log(`site: ${pages.length} pages in the sitemap, built for ${SITE_URL}`);
