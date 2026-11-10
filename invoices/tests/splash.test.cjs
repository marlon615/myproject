/** Startup splash: "Marlon" + "Delivery Invoices", five seconds, smooth fade, never into a blank page. */
const { chromium } = require("playwright");
const { start } = require("./serve.cjs");
const path = require("path");

const PORT = 8795;
let failures = 0;
const check = (ok, name, extra = "") => { console.log(`${ok ? "PASS" : "FAIL"}  ${name}${extra ? "  — " + extra : ""}`); if (!ok) failures++; };

async function state(page) {
  return page.evaluate(() => {
    const s = document.getElementById("splash");
    return {
      present: !!s,
      opacity: s ? Number(getComputedStyle(s).opacity) : 0,
      leaving: s ? s.classList.contains("is-leaving") : true,
      inert: document.getElementById("app").inert,
      htmlLocked: document.documentElement.classList.contains("splash-active"),
      doneAt: window.__splashDoneAt ?? null,
      now: performance.now(),
    };
  });
}

(async () => {
  const srv = await start(PORT);
  const browser = await chromium.launch();
  const out = path.join(__dirname, "output");
  try {
    // 1) Normal launch: app ready immediately → visible for 5 s, then fades out and is removed.
    {
      const ctx = await browser.newContext({ viewport: { width: 390, height: 844 }, deviceScaleFactor: 2, isMobile: true, hasTouch: true });
      const page = await ctx.newPage();
      const errors = [];
      page.on("pageerror", (e) => errors.push(e.message));
      page.on("console", (m) => { if (m.type() === "error") errors.push(m.text()); });
      await page.goto(`${srv.url}/__tests/splash-harness.html?splash&ready=0`);
      await page.waitForTimeout(800);
      let s = await state(page);
      check(s.present && s.opacity === 1 && s.inert && s.htmlLocked, "splash visible at launch, page behind is inert", JSON.stringify({ opacity: s.opacity, inert: s.inert }));
      const text = await page.locator("#splash").innerText();
      check(/^Marlon\s+Delivery Invoices$/i.test(text.trim()), "splash text is 'Marlon' + 'Delivery Invoices'", JSON.stringify(text));
      const box = await page.locator(".splash-name").boundingBox();
      const vw = 390, vh = 844;
      const cx = box.x + box.width / 2, cy = box.y + box.height / 2;
      check(Math.abs(cx - vw / 2) < 4 && cy > vh * 0.3 && cy < vh * 0.6 && box.height >= 60, "name is large and centered", `center=(${cx.toFixed(0)},${cy.toFixed(0)}) h=${box.height.toFixed(0)}`);
      await page.screenshot({ path: path.join(out, "splash-light.png") });
      await page.waitForTimeout(4600 - 800 - 300);
      s = await state(page);
      check(s.present && !s.leaving && s.opacity === 1, "still fully visible just before 5 s", `t=${s.now.toFixed(0)}ms`);
      // Sample during the fade to make sure it is gradual, not a jump.
      await page.waitForFunction(() => document.getElementById("splash")?.classList.contains("is-leaving") ?? true, null, { timeout: 3000 });
      const leaveAt = await page.evaluate(() => performance.now());
      check(leaveAt >= 4950 && leaveAt <= 5400, "fade starts at ~5 s", `${leaveAt.toFixed(0)}ms`);
      await page.waitForTimeout(350);
      s = await state(page);
      check(s.present ? s.opacity > 0.05 && s.opacity < 0.95 : false, "fade is gradual (mid-fade opacity between 0 and 1)", `opacity=${s.opacity.toFixed(2)}`);
      check(!s.inert, "page becomes usable as soon as the fade begins");
      await page.waitForFunction(() => !document.getElementById("splash"), null, { timeout: 3000 });
      s = await state(page);
      check(!s.present && !s.htmlLocked && s.doneAt !== null && s.doneAt < 6600, "splash removed after the fade", `done at ${s.doneAt?.toFixed(0)}ms`);
      await page.click("#b", { timeout: 1000 });
      check(true, "main page clickable afterwards");
      check(errors.length === 0, "no console errors", errors.join(" | "));
      await ctx.close();
    }
    // 2) Dark mode look.
    {
      const ctx = await browser.newContext({ viewport: { width: 390, height: 844 }, deviceScaleFactor: 2, colorScheme: "dark" });
      const page = await ctx.newPage();
      await page.goto(`${srv.url}/__tests/splash-harness.html?splash&ready=0`);
      await page.waitForTimeout(500);
      const bg = await page.evaluate(() => getComputedStyle(document.getElementById("splash")).backgroundColor);
      check(bg !== "rgb(255, 255, 255)", "dark mode uses a dark clean background", bg);
      await page.screenshot({ path: path.join(out, "splash-dark.png") });
      await ctx.close();
    }
    // 3) App not ready at 5 s → waits for app:ready (never fades into a blank page).
    {
      const ctx = await browser.newContext({ viewport: { width: 390, height: 844 } });
      const page = await ctx.newPage();
      await page.goto(`${srv.url}/__tests/splash-harness.html?splash&ready=6500`);
      await page.waitForTimeout(5800);
      let s = await state(page);
      check(s.present && !s.leaving, "waits past 5 s while the app is still loading");
      await page.waitForFunction(() => document.getElementById("splash")?.classList.contains("is-leaving") ?? true, null, { timeout: 3000 });
      const t = await page.evaluate(() => performance.now());
      check(t >= 6450 && t <= 7000, "fades right after the app reports ready", `${t.toFixed(0)}ms`);
      await ctx.close();
    }
    // 4) App never signals → capped at 10 s.
    {
      const ctx = await browser.newContext({ viewport: { width: 390, height: 844 } });
      const page = await ctx.newPage();
      await page.goto(`${srv.url}/__tests/splash-harness.html?splash&ready=never`);
      await page.waitForFunction(() => document.getElementById("splash")?.classList.contains("is-leaving") ?? true, null, { timeout: 12000 });
      const t = await page.evaluate(() => performance.now());
      check(t >= 9950 && t <= 10500, "never holds the app longer than 10 s", `${t.toFixed(0)}ms`);
      await ctx.close();
    }
    // 5) Reduced motion: still leaves at ~5 s with a short gentle fade.
    {
      const ctx = await browser.newContext({ viewport: { width: 390, height: 844 }, reducedMotion: "reduce" });
      const page = await ctx.newPage();
      await page.goto(`${srv.url}/__tests/splash-harness.html?splash&ready=0`);
      const dur = await page.evaluate(() => getComputedStyle(document.getElementById("splash")).transitionDuration);
      check(/0\.25s/.test(dur), "reduced motion keeps a short fade (not removed by the global rule)", dur);
      await page.waitForFunction(() => !document.getElementById("splash"), null, { timeout: 7000 });
      const t = await page.evaluate(() => window.__splashDoneAt);
      check(t >= 5000 && t <= 5800, "reduced motion: gone shortly after 5 s", `${t?.toFixed(0)}ms`);
      await ctx.close();
    }
    // 6) Automated browsers skip it unless ?splash is given (keeps the other test suites fast).
    {
      const ctx = await browser.newContext({ viewport: { width: 390, height: 844 } });
      const page = await ctx.newPage();
      await page.goto(`${srv.url}/__tests/splash-harness.html?ready=0`);
      await page.waitForTimeout(150);
      const s = await state(page);
      check(!s.present && !s.inert && !s.htmlLocked, "skipped for automated test browsers without ?splash");
      await ctx.close();
    }
  } finally {
    await browser.close();
    await srv.close();
  }
  console.log(failures ? `\n${failures} check(s) failed` : "\nAll splash checks passed");
  process.exit(failures ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
