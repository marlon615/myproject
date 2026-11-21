/**
 * Marlon website test: runs the real Worker and static files with `wrangler dev` (fresh, empty inbox) and checks
 * every page at phone and desktop size, every internal link and image, SEO tags, the forbidden-content rules,
 * the price calculator against the Marlon app's own pricing.js, the demo video, the contact form and the inbox.
 * Usage: node tests/site.test.cjs      (BASE=https://… to check a live site, read-only: skips the form and inbox)
 */
const { chromium } = require("playwright");
const { spawn } = require("child_process");
const path = require("path"), fs = require("fs"), os = require("os");
const ROOT = path.join(__dirname, ".."), OUT = path.join(__dirname, "output");
const LIVE = process.env.BASE || null, PORT = 8831, BASE = LIVE || `http://localhost:${PORT}`;
const PAGES = ["/", "/how-it-works", "/features", "/pro", "/pricing", "/security", "/demo", "/faq", "/about", "/legal", "/privacy", "/contact", "/how-to-pay"];
const EMAIL = "marlonapp.sales@gmail.com";
let failures = 0;
const check = (ok, name, extra = "") => { console.log(`${ok ? "PASS" : "FAIL"}  ${name}${extra ? "  — " + extra : ""}`); if (!ok) failures++; };
const post = (p, body, headers = {}) => fetch(BASE + p, { method: "POST", headers: { "Content-Type": "application/json", Origin: BASE, ...headers }, body: JSON.stringify(body) });

async function startDev() {
  const state = fs.mkdtempSync(path.join(os.tmpdir(), "marlon-site-"));
  const p = spawn(path.join(ROOT, "..", "chief-of-staff", "node_modules", ".bin", "wrangler"), ["dev", "--port", String(PORT), "--persist-to", state, "--log-level", "error"], { cwd: ROOT, stdio: ["ignore", "pipe", "pipe"] });
  let log = ""; p.stdout.on("data", (d) => { log += d; }); p.stderr.on("data", (d) => { log += d; });
  for (let i = 0; i < 90; i++) {
    try { if ((await fetch(BASE + "/")).ok) return { stop: () => { p.kill("SIGTERM"); fs.rmSync(state, { recursive: true, force: true }); } }; } catch {}
    await new Promise((r) => setTimeout(r, 1000));
  }
  p.kill(); throw new Error("wrangler dev didn't start:\n" + log);
}

(async () => {
  fs.mkdirSync(OUT, { recursive: true });
  const dev = LIVE ? null : await startDev();
  // Live mode from this cloud session: the browser goes through the session's HTTPS proxy, like curl does.
  const px = LIVE && (process.env.HTTPS_PROXY || process.env.https_proxy);
  const pu = px ? new URL(px) : null;
  const browser = await chromium.launch(pu ? { proxy: { server: `${pu.protocol}//${pu.host}`, username: decodeURIComponent(pu.username), password: decodeURIComponent(pu.password) } } : {});
  const CTX = pu ? { ignoreHTTPSErrors: true } : {}; // the proxy re-signs HTTPS with its own certificate
  try {
    // ── Every page: status, one h1, SEO tags, structured data, sign-off, phone and desktop layout, no errors ─────
    const phone = await browser.newContext({ ...CTX, viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true });
    const small = await browser.newContext({ ...CTX, viewport: { width: 320, height: 640 }, isMobile: true, hasTouch: true });
    const desk = await browser.newContext({ ...CTX, viewport: { width: 1366, height: 900 } });
    const titles = new Set(), links = new Set(), allText = [];
    for (const p of PAGES) {
      const res = await fetch(BASE + p);
      const html = await res.text();
      check(res.status === 200, `${p}: loads (HTTP 200)`, String(res.status));
      const title = (html.match(/<title>([^<]*)<\/title>/) || [])[1] || "";
      const desc = (html.match(/<meta name="description" content="([^"]*)"/) || [])[1] || "";
      const canon = (html.match(/<link rel="canonical" href="([^"]*)"/) || [])[1] || "";
      check(title.length >= 15 && title.length <= 75 && !titles.has(title) && desc.length >= 60 && desc.length <= 170, `${p}: its own title and description`, `${title.length}/${desc.length} chars`);
      titles.add(title);
      check(canon === `https://marlon.marlon615.workers.dev${p}` && /property="og:image" content="https:\/\/marlon\.marlon615\.workers\.dev\/og\.png"/.test(html) && /name="twitter:card"/.test(html), `${p}: canonical address and share picture`);
      const ld = JSON.parse((html.match(/<script type="application\/ld\+json">([\s\S]*?)<\/script>/) || [])[1] || "{}");
      check(ld["@graph"]?.some((x) => x["@type"] === "Organization" && x.name === "M. D. Williams Enterprise" && x.address?.addressLocality === "Gutters"), `${p}: structured data names M. D. Williams Enterprise, Gutters`);
      check((html.match(/<h1[\s>]/g) || []).length === 1, `${p}: exactly one main heading`);
      check(/The Marlon Team, M\. D\. Williams Enterprise/.test(html) && /Gutters, St\. Catherine, Jamaica/.test(html) && html.includes(`mailto:${EMAIL}`), `${p}: footer signed by the Marlon Team, with Gutters, St. Catherine, Jamaica and the email`);
      check(/rel="icon" href="\/icons\/icon\.svg"/.test(html) && /rel="apple-touch-icon"/.test(html) && !/style="/.test(html), `${p}: favicon tags, and no inline styles (the CSP blocks them)`);
      for (const m of html.matchAll(/href="([^"#]*)(#[^"]*)?"/g)) links.add(m[1] || p);
      for (const m of html.matchAll(/src="([^"]+)"/g)) links.add(m[1]);
      allText.push([p, html]);

      for (const [ctx, tag] of [[phone, "phone"], [small, "small phone (320 px)"], [desk, "desktop"]]) {
        const pg = await ctx.newPage(); const errs = [];
        pg.on("console", (m) => { if (m.type() === "error") errs.push(m.text()); });
        pg.on("pageerror", (e) => errs.push(e.message));
        await pg.goto(BASE + p, { waitUntil: "networkidle" });
        await pg.evaluate(async () => { for (let y = 0; y < document.body.scrollHeight; y += 500) { scrollTo(0, y); await new Promise((r) => setTimeout(r, 40)); } });
        await pg.waitForFunction(() => [...document.images].every((i) => i.complete), null, { timeout: 15000 }).catch(() => {});
        const r = await pg.evaluate(() => ({ sw: document.documentElement.scrollWidth, w: innerWidth, broken: [...document.images].filter((i) => !i.naturalWidth).map((i) => i.getAttribute("src")),
          wide: [...document.querySelectorAll("main *")].filter((e) => { const b = e.getBoundingClientRect(); return b.width > 0 && b.right > innerWidth + 1 && getComputedStyle(e).position !== "fixed" && !e.closest(".sr"); }).slice(0, 3).map((e) => e.tagName + "." + e.className) }));
        check(r.sw <= r.w && r.wide.length === 0, `${p}: no sideways scrolling on ${tag}`, r.sw > r.w || r.wide.length ? `${r.sw}px wide: ${r.wide.join(", ")}` : "");
        const tables = await pg.evaluate(() => [...document.querySelectorAll("main table, main .table-wrap")].map((t) => ({ over: t.scrollWidth - t.clientWidth, right: Math.round(t.getBoundingClientRect().right) })));
        if (tables.length) check(tables.every((t) => t.over <= 1 && t.right <= r.w), `${p}: every table fits the screen on ${tag} (nothing cut off or scrolling sideways)`, JSON.stringify(tables));
        check(r.broken.length === 0, `${p}: every picture loads on ${tag}`, r.broken.join(", "));
        check(errs.length === 0, `${p}: no errors or blocked content on ${tag}`, errs.join(" | ").slice(0, 200));
        if (tag === "phone") await pg.screenshot({ path: path.join(OUT, `site-${p === "/" ? "home" : p.slice(1)}-phone.png`), fullPage: true });
        if (tag === "desktop" && p === "/") await pg.screenshot({ path: path.join(OUT, "site-home-desktop.png"), fullPage: false });
        await pg.close();
      }
    }

    // ── Every internal link and file resolves; the terms link points at the existing /terms page ─────────────────
    const internal = [...links].filter((l) => l.startsWith("/") && !l.startsWith("//"));
    const bad = [];
    for (const l of internal) { const r = await fetch(BASE + l); if (r.status !== 200) bad.push(`${l} → ${r.status}`); }
    check(bad.length === 0 && internal.length > 30, `every internal link and file works (${internal.length} checked)`, bad.join(", "));
    check(links.has("https://marlon-app.marlon615.workers.dev/terms"), "the legal links point to the existing /terms page of the Marlon app");
    const r404 = await fetch(BASE + "/no-such-page");
    check(r404.status === 404 && /We couldn’t find that page/.test(await r404.text()), "an unknown address shows the 404 page with HTTP 404");

    // ── Content rules: no bank details, no phone numbers or calls, no fake reviews, customers or certifications ───
    const bodyText = allText.map(([p, h]) => [p, h.replace(/<script[\s\S]*?<\/script>/g, "").replace(/<[^>]+>/g, " ").replace(/\s+/g, " ")]);
    const hits = (re) => bodyText.filter(([, t]) => re.test(t)).map(([p]) => p);
    check(hits(/\b(IBAN|SWIFT|BIC|routing number|account number|sort code|branch code|bank transit)\b/i).length === 0 && hits(/\b\d{8,}\b/).length === 0, "no bank details or long account-like numbers anywhere");
    const bankMentions = bodyText.flatMap(([p, t]) => (t.match(/[^.]*\bbank\b[^.]*\./gi) || []).map((s) => [p, s.trim()]));
    check(bankMentions.every(([, s]) => /never publish bank details/i.test(s)), "the word 'bank' only appears in 'we never publish bank details'", bankMentions.map(([p, s]) => `${p}: ${s}`).join(" | ").slice(0, 200));
    check(!allText.some(([, h]) => /href="tel:|calendly|book a (call|meeting)|schedule a (call|meeting)/i.test(h)) && hits(/\+?1?[ (]*876[ )-]*\d{3}[ -]?\d{4}/).length === 0, "no phone number, call or meeting booking anywhere");
    check(hits(/testimonial|★|5 stars|trusted by|our customers include|as seen in/i).length === 0, "no reviews, star ratings or customer logos");
    const certs = bodyText.flatMap(([p, t]) => (t.match(/[^.]*\b(SOC 2|ISO 27001|PCI|HIPAA|GDPR certified)\b[^.]*\./g) || []).map((s) => [p, s]));
    check(certs.length > 0 && certs.every(([, s]) => /doesn’t hold|No, and we won’t claim/.test(s)), "certifications are only mentioned to say Marlon doesn't hold them");
    check(hits(/\b(Marlon Williams|Mr\.|Mrs\.|Ms\.|CEO|founder)\b/).length === 0, "no personal names or titles (signed as the Marlon Team)");
    const contactHtml = allText.find(([p]) => p === "/contact")[1];
    check(contactHtml.includes(`mailto:${EMAIL}`) && /no phone calls|don’t take phone calls/i.test(contactHtml.replace(/<[^>]+>/g, " ")), "the contact page gives the email and says there are no calls or meetings");
    const payText = bodyText.find(([p]) => p === "/how-to-pay")[1];
    check(/only on your official invoice/i.test(payText) && /after the terms are signed/i.test(payText), "How to pay: payment details only on the official invoice, after the terms are signed");
    const homeText = bodyText.find(([p]) => p === "/")[1];
    check(["Works offline", "Rep links locked to one phone", "Boss dashboard", "Voice entry", "Signatures", "WhatsApp, PDF or email"].every((k) => homeText.includes(k)), "the home page names every key benefit");
    const proText = bodyText.find(([p]) => p === "/pro")[1];
    check(/Shelf photo/.test(proText) && /Accountant summary/.test(proText) && /Returns and credit notes/.test(proText), "the Pro page covers shelf photo, accountant summary, returns and credit notes");
    const priceText = bodyText.find(([p]) => p === "/pricing")[1];
    check(/\$79 one-time, per rep/.test(priceText) && /Covers the first year/.test(priceText) && /Minor updates are always free/.test(priceText) && /\$25 per rep, per month/.test(priceText), "pricing: $79 one-time covering the first year, minor updates free, Pro $25 per rep a month");

    // ── Prices: the tables and the calculator match the Marlon app's own pricing.js ───────────────────────────────
    const pricing = await import(path.join(ROOT, "..", "marlon-app", "public", "js", "pricing.js"));
    const usd = (c) => (c / 100).toLocaleString("en-US", { style: "currency", currency: "USD" });
    const marlonCents = (n) => { const t = pricing.tierFor(n), g = n * 7900, d = Math.round(g * t.pct / 100); return { g, d, net: g - d, pct: t.pct }; };
    const rows = [...(allText.find(([p]) => p === "/pricing")[1].match(/<tbody>([\s\S]*?)<\/tbody>/) || [])[1].matchAll(/<tr><td[^>]*>([^<]+)<\/td><td[^>]*>([^<]+)<\/td><td class="num"[^>]*>([^<]+)<\/td><td class="num"[^>]*>([^<]+)<\/td><\/tr>/g)];
    const tableOk = rows.length === 6 && rows.every(([, reps, , m, pro]) => { const n = parseInt(reps, 10); return m === usd(marlonCents(n).net / n) && pro === usd(pricing.proPrice(n).netCents / n); });
    check(tableOk, "the discount table's per-rep prices match pricing.js for every tier", rows.map((r) => `${r[1]} ${r[3]} ${r[4]}`).join(" | "));
    const proRows = [...allText.find(([p]) => p === "/pro")[1].matchAll(/<td class="num"[^>]*>(\d+) reps?: (\$[\d,.]+)<\/td>/g)];
    check(proRows.length === 6 && proRows.every(([, n, v]) => v === usd(pricing.proPrice(Number(n)).netCents)), "the Pro page's examples match pricing.js", proRows.map((r) => `${r[1]}: ${r[2]}`).join(", "));
    const cp = await phone.newPage();
    await cp.goto(BASE + "/pricing#calculator");
    const calcBad = [];
    for (const n of [1, 4, 5, 9, 10, 24, 25, 49, 50, 99, 100, 150, 1000]) {
      await cp.fill("#calc-reps", String(n));
      const got = await cp.evaluate(() => ({ m: document.querySelector('[data-out="marlon"]').textContent, p: document.querySelector('[data-out="pro"]').textContent }));
      const want = { m: usd(marlonCents(n).net), p: usd(pricing.proPrice(n).netCents) };
      if (got.m !== want.m || got.p !== want.p) calcBad.push(`${n}: ${got.m}/${got.p} want ${want.m}/${want.p}`);
    }
    check(calcBad.length === 0, "the price calculator matches pricing.js from 1 to 1,000 reps (e.g. 10 reps: $671.50 once, $212.50 a month)", calcBad.join(" | "));
    await cp.close();

    // ── Phone menu ────────────────────────────────────────────────────────────────────────────────────────────────
    const mp = await phone.newPage();
    await mp.goto(BASE + "/features");
    const hiddenBefore = await mp.locator("#nav-menu").isHidden();
    await mp.click(".nav-toggle");
    check(hiddenBefore && await mp.locator('#nav-menu a[href="/pricing"]').isVisible() && await mp.getAttribute(".nav-toggle", "aria-expanded") === "true" && await mp.getAttribute('[data-nav="features"]', "aria-current") === "page",
      "on a phone the menu opens from the button and marks the current page");
    await mp.screenshot({ path: path.join(OUT, "site-menu-phone.png") });
    await mp.close();

    // ── Demo video ───────────────────────────────────────────────────────────────────────────────────────────────
    const vp = await phone.newPage();
    await vp.goto(BASE + "/demo");
    await vp.waitForFunction(() => document.getElementById("demo-video").readyState >= 1, null, { timeout: 15000 });
    const meta = await vp.evaluate(() => { const v = document.getElementById("demo-video"); return { d: v.duration, w: v.videoWidth, h: v.videoHeight }; });
    check(meta.d > 35 && meta.d < 60 && meta.w === 540 && meta.h === 1168, "the demo video loads (H.264 MP4, 540×1168, about 42 s)", JSON.stringify(meta));
    await vp.click('.chapters [data-t="24"]');
    await vp.waitForFunction(() => document.getElementById("demo-video").currentTime >= 24, null, { timeout: 8000 }).catch(() => {});
    check(await vp.evaluate(() => document.getElementById("demo-video").currentTime) >= 24, "tapping a chapter jumps the video to that moment (0:24)");
    await vp.close();

    // ── SEO files ────────────────────────────────────────────────────────────────────────────────────────────────
    const sm = await (await fetch(BASE + "/sitemap.xml")).text(), rb = await (await fetch(BASE + "/robots.txt")).text();
    check(PAGES.every((p) => sm.includes(`<loc>https://marlon.marlon615.workers.dev${p}</loc>`)) && !sm.includes("/inbox") && !sm.includes("/404"), "the sitemap lists all 13 pages (not the inbox or 404)");
    check(/Disallow: \/inbox/.test(rb) && /Sitemap: https:\/\/marlon\.marlon615\.workers\.dev\/sitemap\.xml/.test(rb), "robots.txt points to the sitemap and keeps the inbox out of search");
    const faqLd = JSON.parse(allText.find(([p]) => p === "/faq")[1].match(/<script type="application\/ld\+json">([\s\S]*?)<\/script>/)[1])["@graph"].find((x) => x["@type"] === "FAQPage");
    check(faqLd && faqLd.mainEntity.length >= 20, "the FAQ page gives search engines its questions and answers", `${faqLd?.mainEntity.length} questions`);
    const headers = (await fetch(BASE + "/")).headers;
    check(/default-src 'self'/.test(headers.get("content-security-policy") || "") && /max-age=31536000/.test(headers.get("strict-transport-security") || "") && headers.get("x-frame-options") === "DENY",
      "security headers: content security policy, HTTPS only (HSTS), no framing");
    const rg = await fetch(BASE + "/media/marlon-demo.mp4", { headers: { Range: "bytes=0-1023" } });
    check(rg.status === 206 && /^bytes 0-1023\/\d+$/.test(rg.headers.get("content-range") || "") && (await rg.arrayBuffer()).byteLength === 1024, "the video is served in byte ranges (iPhone Safari needs this to play it)", `HTTP ${rg.status} ${rg.headers.get("content-range")}`);
    const et = (await fetch(BASE + "/features")).headers.get("etag");
    check(Boolean(et) && (await fetch(BASE + "/features", { headers: { "If-None-Match": et } })).status === 304, "unchanged pages answer '304 not modified' (fast repeat visits)");
    const red = await fetch(BASE + "/pricing.html", { redirect: "manual" });
    check(red.status === 301 && /\/pricing$/.test(red.headers.get("location") || ""), "old-style /pricing.html addresses redirect to /pricing", `HTTP ${red.status}`);
    const inboxRes = await fetch(BASE + "/inbox");
    check(/noindex/.test(inboxRes.headers.get("x-robots-tag") || "") && /no-store/.test(inboxRes.headers.get("cache-control") || ""), "the inbox page is sent with 'noindex' and 'no-store'");
    const inboxHtml = await inboxRes.text();
    check(/<meta name="robots" content="noindex, nofollow">/.test(inboxHtml), "the private inbox page asks search engines not to index it");

    if (!LIVE) {
      // ── Contact form → inbox ───────────────────────────────────────────────────────────────────────────────────
      const fp = await phone.newPage(); const ferrs = [];
      fp.on("pageerror", (e) => ferrs.push(e.message));
      await fp.goto(BASE + "/contact?topic=pro");
      check(await fp.inputValue("#f-topic") === "Marlon Pro", "a link from the Pro page picks the 'Marlon Pro' topic");
      await fp.click("#contact-form button[type=submit]");
      check(/add your name/i.test(await fp.textContent("#form-msg")) && await fp.locator("#f-name.is-wrong").count() === 1, "sending an empty form says what's missing and marks the box");
      await fp.fill("#f-name", "Test Buyer"); await fp.fill("#f-company", "Sample Distributors Ltd"); await fp.fill("#f-email", "not-an-email");
      await fp.fill("#f-message", "We have 12 reps and want Marlon Pro.");
      await fp.click("#contact-form button[type=submit]");
      check(/check your email/i.test(await fp.textContent("#form-msg")), "a broken email address is caught before sending");
      await fp.fill("#f-email", "buyer@sample-distributors.example");
      await fp.selectOption("#f-reps", "10–24 reps");
      await fp.click("#contact-form button[type=submit]");
      await fp.waitForSelector("#form-done:not([hidden])", { timeout: 8000 });
      check(/your message has been sent/i.test(await fp.textContent("#form-done")) && (await fp.textContent("#form-done")).includes(EMAIL), "a filled-in form is sent and says we'll reply from the sales email");
      await fp.screenshot({ path: path.join(OUT, "site-contact-sent-phone.png") });
      check(ferrs.length === 0, "no errors on the contact page");
      await fp.close();

      const trap = await post("/api/contact", { name: "Bot", company: "Bot", email: "bot@example.com", message: "spam", website: "http://spam.example" });
      check(trap.status === 200, "a bot that fills the hidden field is told 'ok' (and nothing is saved, checked below)");
      const foreign = await post("/api/contact", { name: "X", company: "Y", email: "x@example.com", message: "hello" }, { Origin: "https://evil.example" });
      check(foreign.status === 403, "another website can't post to the contact form", `HTTP ${foreign.status}`);
      const noMsg = await post("/api/contact", { name: "X", company: "Y", email: "x@example.com", message: "" });
      check(noMsg.status === 400 && (await noMsg.json()).field === "message", "the server refuses a message with no text");

      // Inbox: the first visit sets the passcode, then only it opens the inbox.
      check((await (await fetch(BASE + "/api/inbox/messages")).status) === 401, "the inbox can't be read without signing in");
      const ip = await phone.newPage();
      await ip.goto(BASE + "/inbox");
      await ip.waitForSelector("#inbox-gate:not([hidden])");
      check(/Choose the inbox passcode/.test(await ip.textContent("#inbox-gate-title")), "first visit to /inbox asks to choose the passcode");
      await ip.fill("#inbox-pass", "short"); await ip.fill("#inbox-pass2", "short"); await ip.click("#inbox-go");
      check(/at least 10 characters/.test(await ip.textContent("#inbox-msg")), "a short passcode is refused");
      await ip.fill("#inbox-pass", "correct horse battery"); await ip.fill("#inbox-pass2", "correct horse battery"); await ip.click("#inbox-go");
      await ip.waitForSelector("#inbox-main:not([hidden])");
      const cards = await ip.locator(".msg").allTextContents();
      check(cards.length === 1 && /Test Buyer · Sample Distributors Ltd/.test(cards[0]) && /Marlon Pro · 10–24 reps/.test(cards[0]) && /We have 12 reps/.test(cards[0]),
        "the message arrives in the inbox with the name, company, topic, reps and text (the bot's was not saved)", cards.join(" | ").slice(0, 160));
      check((await ip.getAttribute(".msg a.btn-primary", "href")).startsWith("mailto:buyer@sample-distributors.example?subject="), "'Reply by email' opens an email to the sender");
      await ip.screenshot({ path: path.join(OUT, "site-inbox-phone.png"), fullPage: true });
      await ip.click(".msg .btn-ghost");
      await ip.waitForSelector(".msg.done");
      check(/0 not handled yet/.test(await ip.textContent("#inbox-count")), "a message can be marked handled");
      ip.once("dialog", (d) => d.accept());
      await ip.click(".msg .btn-danger");
      await ip.waitForFunction(() => document.querySelectorAll(".msg").length === 0);
      check(/No messages yet/.test(await ip.textContent("#inbox-count")), "a message can be deleted");
      await ip.click("#inbox-out");
      await ip.waitForSelector("#inbox-gate:not([hidden])");
      check(/Sign in/.test(await ip.textContent("#inbox-gate-title")), "after signing out, the inbox asks for the passcode (not to choose a new one)");
      await ip.close();
      const reclaim = await post("/api/inbox/claim", { passcode: "somebody else 12345" });
      check(reclaim.status === 409, "once set, nobody can choose a new passcode", `HTTP ${reclaim.status}`);
      let last;
      for (let i = 0; i < 6; i++) last = await post("/api/inbox/login", { passcode: "wrong passcode " + i });
      check(last.status === 429, "after 5 wrong passcodes, the inbox makes you wait", `HTTP ${last.status}`);
      let flood;
      for (let i = 0; i < 6; i++) flood = await post("/api/contact", { name: "N", company: "C", email: "n@example.com", message: "message " + i });
      check(flood.status === 429, "one visitor can't send more than 5 messages an hour", `HTTP ${flood.status}`);
    }
  } finally {
    await browser.close();
    dev?.stop();
  }
  console.log(failures ? `\n${failures} check(s) failed` : "\nAll website checks passed");
  process.exit(failures ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
