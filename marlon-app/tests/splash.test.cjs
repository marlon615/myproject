/** Opening animation: dark, "Marlon" thrown at the screen from far away, slams in full size with one small shake, holds 1 s, then the app — under 1.5 s. */
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
    // 1) Normal launch: app ready immediately → the name builds in, holds, fades out at ~1.5–2 s and is removed.
    {
      const ctx = await browser.newContext({ viewport: { width: 390, height: 844 }, deviceScaleFactor: 2, isMobile: true, hasTouch: true });
      const page = await ctx.newPage();
      const errors = [];
      page.on("pageerror", (e) => errors.push(e.message));
      page.on("console", (m) => { if (m.type() === "error") errors.push(m.text()); });
      await page.goto(`${srv.url}/__tests/splash-harness.html?splash&ready=0`);
      // The word flies in from far away: sampled as fast as possible.
      const samples = [];
      for (let i = 0; i < 40; i++) {
        const r = await page.evaluate(() => { const sp = document.getElementById("splash"); if (!sp) return null; const svg = sp.querySelector(".splash-name svg");
          return { t: performance.now(), op: Number(getComputedStyle(svg).opacity), w: svg.getBoundingClientRect().width, shake: getComputedStyle(sp).transform }; });
        if (!r) break; samples.push(r);
        if (r.t > 700) break;
        await page.waitForTimeout(15);
      }
      const full = Math.max(...samples.map((x) => x.w));
      const grow = samples.filter((x) => x.op > 0 && x.w < full * 0.98);
      check(samples[0].op === 0 || samples[0].w < full * 0.3, "it starts dark, the word not yet there", JSON.stringify(samples[0]));
      check(grow.length >= 2 && grow[0].w < full * 0.5 && grow.every((x, i) => i === 0 || x.w >= grow[i - 1].w), "the word flies at the screen from far away, growing fast", grow.map((x) => `${x.t.toFixed(0)}ms:${(100 * x.w / full).toFixed(0)}%`).join(" "));
      const landed = samples.find((x) => x.w >= full * 0.99);
      check(landed && landed.t < 600, "…and slams into place full size", landed ? `full size at ${landed.t.toFixed(0)}ms` : "never full size");
      const moved = samples.filter((x) => x.shake !== "none" && x.shake !== "matrix(1, 0, 0, 1, 0, 0)");
      check(moved.length >= 1 && moved.every((x) => x.t >= landed.t - 40 && x.t <= landed.t + 220), "…with one small shake of the screen as it lands", moved.map((x) => `${x.t.toFixed(0)}ms ${x.shake}`).join(" | "));
      await page.screenshot({ path: path.join(out, "splash-2-name.png") });
      check(await page.locator("#splash canvas, #splash rect, #splash .splash-shine").count() === 0, "no sparkles, confetti or gold band anywhere");
      let s = await state(page);
      check(s.present && s.opacity === 1 && !s.leaving && s.inert && s.htmlLocked, "everything stays fully visible until the fade; page behind is inert", `t=${s.now.toFixed(0)}ms`);
      const name = await page.evaluate(() => {
        const n = document.querySelector("#splash .splash-name");
        const svg = n && n.querySelector("svg");
        return svg ? svg.getAttribute("aria-label") : n && n.textContent.trim();
      });
      check(name === "Marlon", "name reads 'Marlon'", JSON.stringify(name));
      const onlyText = await page.evaluate(() => document.getElementById("splash").textContent.replace(/\s+/g, " ").trim());
      check(await page.locator("#splash .splash-tag").count() === 0 && onlyText === "Marlon", "the splash shows only 'Marlon' (no line underneath)", JSON.stringify(onlyText));
      const theme = await page.evaluate(() => document.querySelector('meta[name="theme-color"]').content);
      check(theme === "#000000", "status bar colour is black during the splash", theme);
      const box = await page.locator(".splash-name").boundingBox();
      const vw = 390, vh = 844;
      const cx = box.x + box.width / 2, cy = box.y + box.height / 2;
      check(Math.abs(cx - vw / 2) < 4 && cy > vh * 0.3 && cy < vh * 0.6 && box.height >= 60, "name is large and centered", `center=(${cx.toFixed(0)},${cy.toFixed(0)}) h=${box.height.toFixed(0)}`);
      // Sample during the fade to make sure it is gradual, not a jump.
      await page.waitForFunction(() => document.getElementById("splash")?.classList.contains("is-leaving") ?? true, null, { timeout: 3000 });
      const leaveAt = await page.evaluate(() => performance.now());
      check(leaveAt - landed.t >= 950 && leaveAt - landed.t <= 1250, "the word holds for one second, then the app opens", `fade at ${leaveAt.toFixed(0)}ms, ${(leaveAt - landed.t).toFixed(0)}ms after it landed`);
      await page.screenshot({ path: path.join(out, "splash-4-fading.png") });
      await page.waitForTimeout(50);
      s = await state(page);
      check(s.present ? s.opacity < 0.95 : true, "a quick fade into the app", `opacity=${s.opacity.toFixed(2)}`);
      check(!s.inert, "page becomes usable as soon as the fade begins");
      await page.waitForFunction(() => !document.getElementById("splash"), null, { timeout: 3000 });
      s = await state(page);
      check(!s.present && !s.htmlLocked && s.doneAt !== null && s.doneAt < 1500, "the whole thing is under 1.5 seconds", `done at ${s.doneAt?.toFixed(0)}ms`);
      const themeAfter = await page.evaluate(() => document.querySelector('meta[name="theme-color"]').content);
      check(themeAfter === "#17633f", "status bar colour restored afterwards", themeAfter);
      await page.click("#b", { timeout: 1000 });
      check(true, "main page clickable afterwards");
      check(errors.length === 0, "no console errors", errors.join(" | "));
      await ctx.close();
    }
    // 2) Always dark: same dark background whether the phone is in light or dark mode.
    for (const scheme of ["light", "dark"]) {
      const ctx = await browser.newContext({ viewport: { width: 390, height: 844 }, deviceScaleFactor: 2, colorScheme: scheme });
      const page = await ctx.newPage();
      await page.goto(`${srv.url}/__tests/splash-harness.html?splash&ready=0`);
      await page.waitForTimeout(500);
      const c = await page.evaluate(() => ({
        bg: getComputedStyle(document.getElementById("splash")).backgroundColor,
        root: getComputedStyle(document.documentElement).backgroundColor,
        ink: getComputedStyle(document.querySelector("#splash .splash-name")).color,
      }));
      check(c.bg === "rgb(0, 0, 0)" && c.root === "rgb(0, 0, 0)", `always black (${scheme} mode phone)`, JSON.stringify(c));
      if (scheme === "dark") await page.screenshot({ path: path.join(out, "splash-dark.png") });
      await ctx.close();
    }
    // 3) App not ready after the animation → waits for app:ready (never fades into a blank page).
    {
      const ctx = await browser.newContext({ viewport: { width: 390, height: 844 } });
      const page = await ctx.newPage();
      await page.goto(`${srv.url}/__tests/splash-harness.html?splash&ready=6500`);
      await page.waitForTimeout(5800);
      let s = await state(page);
      check(s.present && !s.leaving, "waits (past the animation) while the app is still loading");
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
    // 5) Reduced motion: the name just fades in (no movement), then a short gentle fade at ~1.5 s.
    {
      const ctx = await browser.newContext({ viewport: { width: 390, height: 844 }, reducedMotion: "reduce" });
      const page = await ctx.newPage();
      await page.goto(`${srv.url}/__tests/splash-harness.html?splash&ready=0`);
      const dur = await page.evaluate(() => getComputedStyle(document.getElementById("splash")).transitionDuration);
      check(/0\.12s/.test(dur), "reduced motion keeps a short fade (not removed by the global rule)", dur);
      await page.waitForTimeout(400);
      const rm = await page.evaluate(() => ({ anim: getComputedStyle(document.querySelector("#splash .splash-name svg")).animationName, sparks: !!document.querySelector("#splash canvas") }));
      check(rm.anim === "splash-fade" && !rm.sparks, "reduced motion: no flying or shaking — the word just appears", JSON.stringify(rm));
      await page.waitForFunction(() => !document.getElementById("splash"), null, { timeout: 7000 });
      const t = await page.evaluate(() => window.__splashDoneAt);
      check(t >= 1000 && t < 1500, "reduced motion: into the app in under 1.5 s", `${t?.toFixed(0)}ms`);
      await ctx.close();
    }
    // 6b) Tap anywhere skips straight to the main page — and the tap never presses what's underneath.
    for (const how of ["touch", "mouse"]) {
      const ctx = await browser.newContext({ viewport: { width: 390, height: 844 }, isMobile: how === "touch", hasTouch: how === "touch" });
      const page = await ctx.newPage();
      await page.goto(`${srv.url}/__tests/splash-harness.html?splash&ready=0`);
      await page.waitForTimeout(500);
      const b = await page.locator("#b").boundingBox();          // tap exactly over the hidden button
      const x = b.x + b.width / 2, y = b.y + b.height / 2;
      const tapAt = await page.evaluate(() => performance.now());
      if (how === "touch") await page.touchscreen.tap(x, y); else await page.mouse.click(x, y);
      await page.waitForFunction(() => document.getElementById("splash")?.classList.contains("is-leaving") ?? true, null, { timeout: 2000 });
      const leaveAt = await page.evaluate(() => performance.now());
      check(leaveAt - tapAt < 250, `${how} tap starts the fade at once`, `${(leaveAt - tapAt).toFixed(0)}ms after the tap (t=${leaveAt.toFixed(0)}ms)`);
      await page.waitForFunction(() => !document.getElementById("splash"), null, { timeout: 2000 });
      const r = await page.evaluate(() => ({ clicks: window.__bClicks, doneAt: window.__splashDoneAt, inert: document.getElementById("app").inert }));
      check(r.doneAt < tapAt + 1300 && !r.inert, `${how} tap: gone after one smooth fade, page usable`, `gone at ${r.doneAt.toFixed(0)}ms`);
      check(r.clicks === 0, `${how} tap does not press the button underneath`, `clicks=${r.clicks}`);
      await page.waitForTimeout(400);
      check(await page.evaluate(() => window.__bClicks) === 0, `${how} tap: still no stray click afterwards`);
      await ctx.close();
    }
    // 6c) A key press skips too (desktop / keyboard users).
    {
      const ctx = await browser.newContext({ viewport: { width: 390, height: 844 } });
      const page = await ctx.newPage();
      await page.goto(`${srv.url}/__tests/splash-harness.html?splash&ready=0`);
      await page.waitForTimeout(900);
      await page.keyboard.press("Space");
      await page.waitForFunction(() => !document.getElementById("splash"), null, { timeout: 2000 });
      const t = await page.evaluate(() => window.__splashDoneAt);
      check(t < 2200, "a key press skips too", `gone at ${t.toFixed(0)}ms`);
      await ctx.close();
    }
    // 6d) Tap while the app is still loading: waits for it, but no more than 1.5 s after the tap.
    {
      const ctx = await browser.newContext({ viewport: { width: 390, height: 844 }, hasTouch: true, isMobile: true });
      const page = await ctx.newPage();
      await page.goto(`${srv.url}/__tests/splash-harness.html?splash&ready=1400`);
      await page.waitForTimeout(500);
      await page.touchscreen.tap(195, 600);
      await page.waitForFunction(() => document.getElementById("splash")?.classList.contains("is-leaving") ?? true, null, { timeout: 3000 });
      const t1 = await page.evaluate(() => performance.now());
      check(t1 >= 1350 && t1 <= 1700, "tap before the app is ready: fades the moment it is ready", `${t1.toFixed(0)}ms`);
      await ctx.close();
      const ctx2 = await browser.newContext({ viewport: { width: 390, height: 844 }, hasTouch: true, isMobile: true });
      const page2 = await ctx2.newPage();
      await page2.goto(`${srv.url}/__tests/splash-harness.html?splash&ready=never`);
      await page2.waitForTimeout(500);
      const tapAt = await page2.evaluate(() => performance.now());
      await page2.touchscreen.tap(195, 600);
      await page2.waitForFunction(() => document.getElementById("splash")?.classList.contains("is-leaving") ?? true, null, { timeout: 3000 });
      const t2 = await page2.evaluate(() => performance.now());
      check(t2 - tapAt >= 1400 && t2 - tapAt <= 1800, "tap with a stuck app: fades after at most 1.5 s", `${(t2 - tapAt).toFixed(0)}ms after the tap`);
      await ctx2.close();
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
