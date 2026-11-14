/** Opening animation: completely black, a cannon blast of gold confetti filling the screen, then "Marlon" whole (never before the blast settles), held ~1 s, then the app. */
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
      // Black, then the blast; "Marlon" must not show at all until the blast has settled. Sampled every ~60 ms.
      const samples = [];
      while (true) {
        const r = await page.evaluate(() => {
          const sp = document.getElementById("splash"); if (!sp) return null;
          const c = sp.querySelector("canvas.splash-sparks"); let lit = 0, quads = [0, 0, 0, 0];
          if (c) { const W = c.width, H = c.height, d = c.getContext("2d").getImageData(0, 0, W, H).data;
            for (let y = 0; y < H; y += 6) for (let x = 0; x < W; x += 6) { const k = (y * W + x) * 4; if (d[k + 3] > 60) { lit++; quads[(y < H / 2 ? 0 : 2) + (x < W / 2 ? 0 : 1)]++; } } }
          return { t: performance.now(), word: Number(getComputedStyle(sp.querySelector(".splash-name svg")).opacity), lit, quads };
        });
        if (!r || r.word > 0.05) { if (r) samples.push(r); break; }
        samples.push(r);
        if (r.t > 1200 && !samples.find((x) => x.saved)) { r.saved = true; await page.screenshot({ path: path.join(out, "splash-1-blast.png") }); }
        await page.waitForTimeout(40);
      }
      const before = samples.filter((x) => x.word <= 0.05);
      const firstWord = samples[samples.length - 1];
      check(before.length > 0 && before[0].t < 300 && before[0].lit === 0, "it starts completely black, nothing showing", `t=${before[0]?.t.toFixed(0)}ms lit=${before[0]?.lit}`);
      const flash = before.find((x) => x.t > 300 && x.t < 600 && x.lit > 20000);
      check(Boolean(flash), "the blast starts with a flash across the screen", flash ? `${flash.lit} lit points at ${flash.t.toFixed(0)}ms` : "no flash");
      const after = before.filter((x) => x.t > 800).reduce((m, x) => (x.lit > m.lit ? x : m), { lit: 0 });
      check(after.lit > 400 && after.quads.every((q) => q > 40), "then confetti fills the whole screen (all four quarters), after the flash has gone", `${after.lit} confetti points at ${after.t?.toFixed(0)}ms, quarters ${after.quads}`);
      check(firstWord.t >= 1450, "'Marlon' is not visible at all until the blast has settled", `first visible at ${firstWord.t.toFixed(0)}ms; ${before.length} samples before showed no name`);
      await page.waitForTimeout(400);
      await page.screenshot({ path: path.join(out, "splash-2-name.png") });
      check(await page.locator("#splash .splash-name path.splash-word").count() === 1, "the name appears whole, all at once (one shape, no spelling out)");
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
      check(leaveAt - firstWord.t >= 850 && leaveAt - firstWord.t <= 1250, "the name is held for about one second, then the fade into the app", `fade at ${leaveAt.toFixed(0)}ms, ${(leaveAt - firstWord.t).toFixed(0)}ms after the name`);
      await page.screenshot({ path: path.join(out, "splash-4-fading.png") });
      await page.waitForTimeout(200);
      s = await state(page);
      check(s.present ? s.opacity > 0.05 && s.opacity < 0.95 : false, "fade is gradual (mid-fade opacity between 0 and 1)", `opacity=${s.opacity.toFixed(2)}`);
      check(!s.inert, "page becomes usable as soon as the fade begins");
      await page.waitForFunction(() => !document.getElementById("splash"), null, { timeout: 3000 });
      s = await state(page);
      check(!s.present && !s.htmlLocked && s.doneAt !== null && s.doneAt <= 3400, "into the app after about three seconds in all", `done at ${s.doneAt?.toFixed(0)}ms`);
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
      check(/0\.25s/.test(dur), "reduced motion keeps a short fade (not removed by the global rule)", dur);
      await page.waitForTimeout(400);
      const rm = await page.evaluate(() => ({ anim: getComputedStyle(document.querySelector("#splash .splash-name svg")).animationName, sparks: !!document.querySelector("#splash canvas") }));
      check(rm.anim === "splash-fade" && !rm.sparks, "reduced motion: no blast and no movement — the name just fades in", JSON.stringify(rm));
      await page.waitForFunction(() => !document.getElementById("splash"), null, { timeout: 7000 });
      const t = await page.evaluate(() => window.__splashDoneAt);
      check(t >= 1400 && t <= 2200, "reduced motion: into the app at about 1.5–2 s", `${t?.toFixed(0)}ms`);
      await ctx.close();
    }
    // 6b) Tap anywhere skips straight to the main page — and the tap never presses what's underneath.
    for (const how of ["touch", "mouse"]) {
      const ctx = await browser.newContext({ viewport: { width: 390, height: 844 }, isMobile: how === "touch", hasTouch: how === "touch" });
      const page = await ctx.newPage();
      await page.goto(`${srv.url}/__tests/splash-harness.html?splash&ready=0`);
      await page.waitForTimeout(1200);
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
