/**
 * The public website, with the real Worker (wrangler dev) and a real browser at desktop and phone size:
 *   - every page loads, has a Draxly title and a canonical link built from SITE_URL (the domain lives in one setting);
 *   - every link between pages works; the demo, API guide, app sign-in and owner dashboard are still reachable;
 *   - no phone numbers, booking links, fake proof (reviews, "trusted by", logos) or personal names;
 *   - pricing and contract terms are stated; the contact form reaches the owner dashboard;
 *   - old app links (/#/billing from earlier emails) land in the app at /app;
 *   - no page scrolls sideways on a phone, the menu opens, and no page has errors.
 */
const fs = require("fs"), os = require("os"), path = require("path"), { spawnSync } = require("child_process");
const { chromium } = require("playwright");
const { checker, startWorker, api, APP } = require("./helpers.cjs");

const PORT = 8930, SITE = "https://www.draxly-example.test", CE = "draxlyforecast@gmail.com", OUT = path.join(__dirname, "output");
const { check, failures } = checker();
const PAGES = ["/", "/how-it-works", "/integrations", "/security", "/pricing", "/free-demo", "/faq", "/about", "/legal", "/terms", "/privacy", "/dpa", "/contact"];

(async () => {
  fs.mkdirSync(OUT, { recursive: true });
  check(spawnSync(process.execPath, [path.join(APP, "scripts", "build-worker.cjs")], { cwd: APP }).status === 0, "the website and app pack into the Worker");
  const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), "draxly-site-"));
  const w = startWorker(PORT, stateDir, { SITE_URL: SITE });
  const req = api(w.base);
  const browser = await chromium.launch();
  try {
    await w.ready;
    const html = {};
    for (const p of [...PAGES, "/demo", "/docs"]) { const r = await fetch(w.base + p); html[p] = await r.text(); if (r.status !== 200) html[p] = `STATUS ${r.status}`; }
    check(PAGES.every((p) => /<title>[^<]*Draxly[^<]*<\/title>/.test(html[p])), "all 13 pages load with a Draxly title (Home, How it works, Integrations, Security, Pricing, Free demo, FAQ, About, Legal, Terms, Privacy, DPA, Contact)",
      PAGES.filter((p) => !/<title>[^<]*Draxly/.test(html[p])).join(", "));
    check(PAGES.every((p) => html[p].includes(`<link rel="canonical" href="${SITE}${p === "/" ? "/" : p}">`)) && !Object.values(html).some((t) => t.includes("__SITE_URL__")), "every page's canonical link uses SITE_URL, and no placeholder is left showing");
    check(html["/docs"].includes(`curl -X POST ${SITE}/v1/sales`) && !Object.values(html).some((t) => /marlon615\.workers\.dev/.test(t)), "the API guide's examples use SITE_URL; no page has the workers.dev address written in");
    const robots = await (await fetch(`${w.base}/robots.txt`)).text(), sitemap = await (await fetch(`${w.base}/sitemap.xml`)).text();
    check(robots.includes(`Sitemap: ${SITE}/sitemap.xml`) && /Disallow: \/owner/.test(robots) && /Disallow: \/app/.test(robots) && PAGES.every((p) => sitemap.includes(`<loc>${SITE}${p}</loc>`)), "robots.txt and sitemap.xml list the pages on the SITE_URL domain; the app and owner dashboard are kept out of search");

    // Links between pages
    const links = new Set();
    for (const t of Object.values(html)) for (const m of t.matchAll(/href="(\/[^"#?]*)/g)) links.add(m[1]);
    const broken = [];
    for (const l of links) { const r = await fetch(w.base + l, { redirect: "manual" }); if (r.status >= 400) broken.push(`${l} ${r.status}`); }
    check(broken.length === 0 && links.has("/demo") && links.has("/app") && links.has("/docs") && links.has("/terms") && links.has("/privacy") && links.has("/dpa"), `all ${links.size} links between pages work, including the demo, API guide, sign-in and legal pages`, broken.join(", "));
    check(html["/free-demo"].includes('href="/demo"') && html["/demo"].includes('id="d-file"'), "the Free test demo page links to the open demo, which still works at /demo");

    // What must not be on the site
    const all = Object.entries(html).map(([p, t]) => [p, t.replace(/<script[\s\S]*?<\/script>/g, "")]);
    const text = (t) => t.replace(/<[^>]+>/g, " ");
    const bad = (re) => all.filter(([, t]) => re.test(text(t)) || re.test(t)).map(([p]) => p);
    check(bad(/tel:|\(?\b\d{3}\)?[-.\s]\d{3}[-.]\d{4}\b|\+1[\s-]?\d{3}/).length === 0, "no phone numbers anywhere", bad(/tel:|\(?\b\d{3}\)?[-.\s]\d{3}[-.]\d{4}\b/).join(", "));
    check(bad(/calendly|book a (call|demo|meeting)|schedule a (call|demo|meeting)|zoom\.us|meet\.google|teams\.microsoft/i).length === 0, "no call, meeting or video-call booking anywhere");
    check(bad(/trusted by|our customers include|testimonial|★|5 stars|customer stor|case stud|as seen in|\baward(s|-winning)?\b/i).length === 0, "no customer logos, reviews, testimonials or 'trusted by' claims");
    check(bad(/(?<!Are you )SOC ?2 (certified|compliant)|ISO 27001 certified|HIPAA compliant|GDPR certified/i).length === 0 && /(doesn't|don't) currently hold SOC 2/i.test(text(html["/security"])) && /Not currently/.test(html["/faq"]), "no certifications claimed; the security page says plainly that there's no SOC 2 or ISO 27001");
    const names = all.filter(([, t]) => /Williams/.test(text(t).replace(/M\. D\. Williams Enterprise/g, ""))).map(([p]) => p);
    check(names.length === 0, "no personal names: 'Williams' only ever appears as M. D. Williams Enterprise", names.join(", "));
    check(PAGES.every((p) => html[p].includes(`mailto:${CE}`)) && PAGES.every((p) => (text(html[p]).match(/[A-Za-z0-9._%+-]+@[A-Za-z0-9-]+(\.[A-Za-z0-9-]+)+/g) || []).every((e) => e === CE)), "every page shows draxlyforecast@gmail.com and no other email");
    check(PAGES.every((p) => /© \d{4} M\. D\. Williams Enterprise, trading as Draxly/.test(html[p])), "every page names the company: © M. D. Williams Enterprise, trading as Draxly");

    // Pricing and contract
    const pr = text(html["/pricing"]);
    check(/\$30,000/.test(pr) && /\$2,500 a month/.test(pr) && /one-year agreement/i.test(pr) && /renews automatically/.test(pr) && /rest of that year is still owed/.test(pr) && /Unlimited users/i.test(pr),
      "pricing: $30,000 a year or $2,500 a month on a one-year agreement, auto-renewal, early cancellation owes the rest of the year, unlimited users");
    check(["NetSuite", "SAP S/4HANA", "Dynamics 365 Business Central", "QuickBooks Online", "Shopify", "Square", "/v1/files", "HTTPS file drop"].every((k) => text(html["/integrations"]).includes(k)), "integrations: NetSuite, SAP, Dynamics, QuickBooks, Shopify, Square, the API and HTTPS file drop");
    check(["Terms of Service", "Privacy Policy", "Data Processing Addendum"].every((k) => html["/legal"].includes(k)) && /Sub-processors/.test(html["/dpa"]) && /CCPA/.test(html["/privacy"]) && /Limitation of liability/.test(html["/terms"]), "legal: Terms, Privacy Policy (with US state rights) and DPA (with sub-processors)");

    // The app and the owner dashboard still work at their addresses
    check(/id="auth"|id="login"|Sign in/.test(await (await fetch(`${w.base}/app`)).text()) && (await fetch(`${w.base}/owner`)).status === 200, "the customer app is at /app and the owner dashboard still at /owner");

    // Browser: desktop and phone
    const errors = [];
    for (const [name, viewport] of [["desktop", { width: 1366, height: 900 }], ["phone", { width: 390, height: 844 }]]) {
      const ctx = await browser.newContext({ viewport, ...(name === "phone" ? { isMobile: true, hasTouch: true, deviceScaleFactor: 2 } : {}) });
      const P = await ctx.newPage();
      P.on("pageerror", (e) => errors.push(`${name} ${P.url()}: ${e.message}`));
      P.on("console", (m) => { if (m.type() === "error" && !/404/.test(m.text())) errors.push(`${name} ${P.url()}: ${m.text()}`); });
      const wide = [];
      for (const p of [...PAGES, "/demo", "/docs"]) { await P.goto(w.base + p); const d = await P.evaluate(() => document.documentElement.scrollWidth - window.innerWidth); if (d > 0) wide.push(`${p} +${d}px`); }
      check(wide.length === 0, `${name}: no page scrolls sideways`, wide.join(", "));
      if (name === "phone") {
        await P.goto(w.base + "/");
        check(!(await P.isVisible("#nav-menu a[href='/pricing']")), "phone: the menu starts closed");
        await P.click(".nav-toggle");
        check(await P.isVisible("#nav-menu a[href='/pricing']") && await P.isVisible("#nav-menu a[href='/free-demo']"), "phone: the menu button opens every page link and the Free demo button");
        await P.screenshot({ path: path.join(OUT, "site-phone-menu.png") });
        await P.click("#nav-menu a[href='/pricing']");
        await P.waitForURL(/\/pricing$/);
        check(await P.getAttribute("#nav-menu a[href='/pricing']", "aria-current") === "page", "phone: the menu marks the page you're on");
        await P.goto(w.base + "/"); await P.screenshot({ path: path.join(OUT, "site-phone-home.png"), fullPage: true });
      } else {
        await P.goto(w.base + "/"); await P.screenshot({ path: path.join(OUT, "site-home.png"), fullPage: true });
        await P.goto(w.base + "/pricing"); await P.screenshot({ path: path.join(OUT, "site-pricing.png"), fullPage: true });
      }
      await ctx.close();
    }

    // The contact form reaches the owner dashboard
    const owner = (await req("/api/owner/claim", { method: "POST", body: { passcode: "owner-pass-123" } })).data.token;
    const C = await (await browser.newContext({ viewport: { width: 390, height: 844 } })).newPage();
    C.on("pageerror", (e) => errors.push(`contact: ${e.message}`));
    await C.goto(`${w.base}/contact`);
    await C.click("button[type=submit]");
    check(/name and company/.test(await C.textContent("#form-msg")), "contact form: sending it empty asks for the missing details");
    await C.fill("#c-name", "Test Buyer"); await C.fill("#c-email", "buyer@coastal-foods.test"); await C.fill("#c-company", "Coastal Foods Test Co");
    await C.selectOption("#c-sales", "$50M to $100M"); await C.fill("#c-erp", "NetSuite"); await C.selectOption("#c-topic", "Pricing and contract");
    await C.fill("#c-message", "We'd like an order form for the annual plan.");
    await C.click("button[type=submit]");
    await C.waitForSelector("#form-done:not([hidden])", { timeout: 10000 });
    check(true, "contact form: a filled-in message sends and says thanks");
    await C.screenshot({ path: path.join(OUT, "site-contact-sent.png") });
    const leads = (await req("/api/owner/demo", { token: owner })).data.leads;
    const lead = leads.find((l) => l.email === "buyer@coastal-foods.test");
    check(lead && lead.company === "Coastal Foods Test Co" && /Topic: Pricing and contract/.test(lead.message) && /Annual sales: \$50M to \$100M/.test(lead.message) && /Systems: NetSuite/.test(lead.message) && /order form/.test(lead.message),
      "…and it shows on the owner dashboard with the topic, sales range, systems and message", JSON.stringify(lead)?.slice(0, 200));

    // Old app links from earlier emails go to the app
    const O = await (await browser.newContext()).newPage();
    await O.goto(`${w.base}/#/billing`);
    await O.waitForURL(/\/app#\/billing$/, { timeout: 8000 });
    check(true, "an old link like /#/billing (from an earlier email) opens the app at /app#/billing");
    await O.goto(`${w.base}/#/reset/abc123`);
    await O.waitForURL(/\/app#\/reset\/abc123$/, { timeout: 8000 });
    check(true, "…and old password-reset and invite links keep working the same way");

    check(errors.length === 0, "no page errors", errors.join(" | "));
  } finally {
    await browser.close();
    await w.stop();
    fs.rmSync(stateDir, { recursive: true, force: true });
  }
  if (failures()) { console.log(`\n${failures()} check(s) failed`); process.exit(1); }
  console.log("\nAll website checks passed");
})().catch((e) => { console.error(e); process.exit(1); });
