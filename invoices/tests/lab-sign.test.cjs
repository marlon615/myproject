/**
 * Signing-effect test page (/lab/sign), with a real finger-style touch at phone size: the ink writes "Thank you" in
 * step with the finger, the real signature is saved exactly as drawn, and on lift the words finish, settle, the name
 * appears, the green tick draws and a gentle tap fires. Also checks the page stays out of the app.
 */
const { chromium } = require("playwright");
const { start } = require("./serve.cjs");
const path = require("path");
const fs = require("fs");

const PORT = 8797, OUT = path.join(__dirname, "output");
let failures = 0;
const check = (ok, name, extra = "") => { console.log(`${ok ? "PASS" : "FAIL"}  ${name}${extra ? "  — " + extra : ""}`); if (!ok) failures++; };
const MOCK = `window.__buzz = []; Object.defineProperty(navigator, "vibrate", { configurable: true, value: (p) => { window.__buzz.push(p); return true; } });`;

/** A signature-like path (two strokes: a first name and a surname), drawn with touch events. */
async function sign(page, cdp, { strokes = 2, pauseMs = 250, steps = 46 } = {}) {
  const box = await page.locator("#pad").boundingBox();
  const pts = [];
  for (let s = 0; s < strokes; s++) {
    const stroke = [];
    const x0 = box.x + 30 + s * (box.width * 0.42), y0 = box.y + box.height * 0.55;
    for (let i = 0; i <= steps; i++) {
      const u = i / steps;
      stroke.push({ x: x0 + u * box.width * 0.38, y: y0 - Math.sin(u * Math.PI * 3.2) * 34 - u * 12 + Math.cos(u * 17) * 6 });
    }
    pts.push(stroke);
  }
  for (let s = 0; s < pts.length; s++) {
    const stroke = pts[s];
    await cdp.send("Input.dispatchTouchEvent", { type: "touchStart", touchPoints: [{ x: stroke[0].x, y: stroke[0].y, id: 1 }] });
    for (let i = 1; i < stroke.length; i++) {
      await cdp.send("Input.dispatchTouchEvent", { type: "touchMove", touchPoints: [{ x: stroke[i].x, y: stroke[i].y, id: 1 }] });
      await page.waitForTimeout(14);
    }
    await cdp.send("Input.dispatchTouchEvent", { type: "touchEnd", touchPoints: [] });
    if (s < pts.length - 1) await page.waitForTimeout(pauseMs);
  }
  return pts;
}

(async () => {
  const srv = await start(PORT);
  const browser = await chromium.launch();
  const errors = [];
  try {
    // Not part of the app: no link from the app, not cached for offline, its files are its own.
    const sw = fs.readFileSync(path.join(__dirname, "..", "public", "sw.js"), "utf8");
    const index = fs.readFileSync(path.join(__dirname, "..", "public", "index.html"), "utf8");
    check(!/\/lab\//.test(sw) && !/\/lab\//.test(index) && !/lab\//.test(fs.readFileSync(path.join(__dirname, "..", "public", "js", "app.js"), "utf8")), "the test page is not linked from the app or cached by it");
    const res = await fetch(`${srv.url}/lab/sign`);
    check(res.status === 200 && /The signature that says thank you/.test(await res.text()), "the test page is served at /lab/sign");

    const ctx = await browser.newContext({ viewport: { width: 390, height: 844 }, deviceScaleFactor: 3, isMobile: true, hasTouch: true });
    await ctx.addInitScript(MOCK);
    const page = await ctx.newPage();
    page.on("pageerror", (e) => errors.push(e.message));
    page.on("console", (m) => { if (m.type() === "error") errors.push(m.text()); });
    await page.goto(`${srv.url}/lab/sign`);
    await page.waitForFunction(() => window.__lab && window.__lab.st.total > 0);
    const cdp = await ctx.newCDPSession(page);
    const pad = await page.evaluate(() => { const r = document.getElementById("pad").getBoundingClientRect(); return { w: Math.round(r.width), h: Math.round(r.height) }; });
    check(pad.h >= 170 && pad.h <= 176, "same size as the app's signature box (172 px tall)", JSON.stringify(pad));
    check(!(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth)), "no sideways scroll on a phone");

    // Mid-signature: the words are being written in step with the finger; the real ink stays hidden.
    const box = await page.locator("#pad").boundingBox();
    await cdp.send("Input.dispatchTouchEvent", { type: "touchStart", touchPoints: [{ x: box.x + 40, y: box.y + 100, id: 1 }] });
    let shownAt = [];
    for (let i = 1; i <= 30; i++) {
      await cdp.send("Input.dispatchTouchEvent", { type: "touchMove", touchPoints: [{ x: box.x + 40 + i * 7, y: box.y + 100 - Math.sin(i / 3) * 30, id: 1 }] });
      await page.waitForTimeout(16);
      if (i === 10 || i === 30) shownAt.push(await page.evaluate(() => window.__lab.st.shown));
    }
    await page.waitForTimeout(120);
    const mid = await page.evaluate(() => ({ phase: window.__lab.st.phase, shown: window.__lab.st.shown, total: window.__lab.st.total, sigOpacity: getComputedStyle(document.getElementById("sig")).opacity }));
    check(mid.phase === "writing" && shownAt[0] > 0 && shownAt[1] > shownAt[0] && mid.shown < mid.total * 0.9, "while signing, 'Thank you' is written in step with the finger", `${shownAt.map((n) => Math.round(n)).join(" → ")} of ${Math.round(mid.total)} px`);
    check(mid.sigOpacity === "0", "the real signature is recorded underneath, not shown");
    await page.screenshot({ path: path.join(OUT, "lab-sign-1-writing.png") });
    const inkPixels = await page.evaluate(() => { const c = document.getElementById("ink"); const d = c.getContext("2d").getImageData(0, 0, c.width, c.height).data; let n = 0; for (let i = 3; i < d.length; i += 4) if (d[i] > 128) n++; return n; });
    check(inkPixels > 500, "ink is on the pad", `${inkPixels} px`);
    await cdp.send("Input.dispatchTouchEvent", { type: "touchEnd", touchPoints: [] });

    // A second stroke soon after (a surname) continues the same signature.
    await page.waitForTimeout(300);
    check(await page.evaluate(() => window.__lab.st.phase) === "writing", "a short lift is still the same signature");
    await sign(page, cdp, { strokes: 1 });
    const t0 = Date.now();
    await page.waitForFunction(() => window.__lab.st.phase === "finishing" || window.__lab.st.phase === "settling", null, { timeout: 3000 });
    const liftToFinish = Date.now() - t0;
    check(liftToFinish < 1200, "after the finger lifts, the words finish", `${liftToFinish} ms`);
    await page.waitForFunction(() => window.__lab.st.phase === "settling", null, { timeout: 3000 });
    check(await page.evaluate(() => Math.abs(window.__lab.st.shown - window.__lab.st.total) < 0.5), "'Thank you' is written to the end");
    await page.waitForTimeout(450);
    await page.screenshot({ path: path.join(OUT, "lab-sign-2-settling.png") });
    await page.waitForFunction(() => window.__lab.st.phase === "done", null, { timeout: 4000 });
    await page.waitForTimeout(150);
    const end = await page.evaluate(() => ({
      who: document.getElementById("who").textContent, shown: document.getElementById("sealed").classList.contains("is-shown"),
      checked: document.getElementById("sealed").classList.contains("is-checked"),
      tick: parseFloat(getComputedStyle(document.querySelector(".lab-check .tick")).strokeDashoffset),
      stroke: getComputedStyle(document.querySelector(".lab-check .tick")).stroke,
      buzz: window.__buzz, status: document.getElementById("status").textContent,
      settled: getComputedStyle(document.getElementById("ink")).transform,
    }));
    check(end.who === "Sarah Supermarket" && end.shown, "the name appears under the words", end.who);
    check(end.checked && end.tick < 1 && end.stroke === "rgb(23, 99, 63)", "then the green tick draws itself", `offset ${end.tick}`);
    check(JSON.stringify(end.buzz) === "[35]", "and a gentle tap", JSON.stringify(end.buzz));
    check(end.settled !== "none", "the words settle in (shrink a touch and rise)", end.settled);
    check(end.status === "Signed. Thank you, Sarah Supermarket.", "status says it's signed", end.status);
    await page.screenshot({ path: path.join(OUT, "lab-sign-3-done.png") });

    // The real signature is saved exactly as drawn (the app's own signature pad), not the words.
    const saved = await page.evaluate(async () => {
      const img = document.getElementById("saved-img");
      await img.decode();
      const c = document.createElement("canvas"); c.width = img.naturalWidth; c.height = img.naturalHeight;
      const g = c.getContext("2d"); g.drawImage(img, 0, 0);
      const d = g.getImageData(0, 0, c.width, c.height).data; let ink = 0;
      for (let i = 3; i < d.length; i += 4) if (d[i] > 128) ink++;
      return { w: c.width, h: c.height, ink, visible: !document.getElementById("saved").hidden, same: img.src === window.__lab.pad.toDataURL() };
    });
    check(saved.visible && saved.w === 900 && saved.h === 300 && saved.ink > 1500 && saved.same, "the real signature is saved exactly as drawn (900×300, same as the app)", JSON.stringify(saved));
    await page.locator("#saved").scrollIntoViewIfNeeded();
    await page.screenshot({ path: path.join(OUT, "lab-sign-4-saved.png") });

    // Sign again; another name; a tap alone isn't a signature.
    await page.click("#again");
    check(await page.evaluate(() => window.__lab.st.phase === "idle" && window.__lab.pad.isEmpty() && document.getElementById("saved").hidden), "Sign again starts over");
    await page.fill("#who-input", "Corner Shop");
    await page.evaluate(() => window.scrollTo(0, 0));
    await sign(page, cdp, { strokes: 2, pauseMs: 200 });
    await page.waitForFunction(() => window.__lab.st.phase === "done", null, { timeout: 6000 });
    check(await page.textContent("#who") === "Corner Shop", "works for any name");
    await page.click("#again");
    const b2 = await page.locator("#pad").boundingBox();
    await cdp.send("Input.dispatchTouchEvent", { type: "touchStart", touchPoints: [{ x: b2.x + 100, y: b2.y + 80, id: 1 }] });
    await cdp.send("Input.dispatchTouchEvent", { type: "touchEnd", touchPoints: [] });
    await page.waitForTimeout(1100);
    check(await page.evaluate(() => window.__lab.st.phase) === "idle", "a tap alone isn't taken as a signature");

    // Reduced motion: no movement, the end state appears straight away.
    const ctx2 = await browser.newContext({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true, reducedMotion: "reduce" });
    await ctx2.addInitScript(MOCK);
    const p2 = await ctx2.newPage();
    await p2.goto(`${srv.url}/lab/sign`);
    await p2.waitForFunction(() => window.__lab && window.__lab.st.total > 0);
    const cdp2 = await ctx2.newCDPSession(p2);
    await sign(p2, cdp2, { strokes: 1 });
    await p2.waitForFunction(() => window.__lab.st.phase === "done", null, { timeout: 4000 });
    check(await p2.evaluate(() => parseFloat(getComputedStyle(document.querySelector(".lab-check .tick")).strokeDashoffset)) < 1, "reduced motion: the tick is simply there");
    await ctx2.close();

    check(errors.length === 0, "no console errors", errors.join(" | "));
  } finally {
    await browser.close();
    await srv.close();
  }
  console.log(failures ? `\n${failures} check(s) failed` : "\nAll lab-sign checks passed");
  process.exit(failures ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
