/** Makes public/og.png (1200×630), the picture shown when a Marlon link is shared. node scripts/make-og.cjs */
const { chromium } = require("playwright");
const path = require("path"), fs = require("fs");
const PUB = path.join(__dirname, "..", "public");
const shot = "data:image/webp;base64," + fs.readFileSync(path.join(PUB, "media", "app-invoice.webp")).toString("base64");
const icon = "data:image/svg+xml;base64," + fs.readFileSync(path.join(PUB, "icons", "icon.svg")).toString("base64");
const html = `<!doctype html><html><body style="margin:0">
<div style="width:1200px;height:630px;position:relative;overflow:hidden;background:#0f1a14;font-family:-apple-system,Segoe UI,Roboto,Helvetica,Arial,sans-serif;color:#c9d8ce">
  <div style="position:absolute;inset:0;background:radial-gradient(700px 420px at 90% 0%,rgba(31,143,78,.38),transparent 60%),radial-gradient(600px 360px at 0% 100%,rgba(194,112,42,.18),transparent 60%)"></div>
  <div style="position:absolute;left:72px;top:70px;width:640px">
    <div style="display:flex;align-items:center;gap:16px;margin-bottom:44px"><img src="${icon}" width="64" height="64" style="border-radius:14px"><span style="font-family:Georgia,'Times New Roman',serif;font-size:46px;font-weight:700;color:#fff">Marlon</span></div>
    <div style="font-family:Georgia,'Times New Roman',serif;font-size:60px;line-height:1.08;font-weight:700;color:#fff">Invoices that work <i style="color:#9be0b6">where the signal doesn’t.</i></div>
    <div style="font-size:26px;line-height:1.4;margin-top:26px;color:#b8cbbf">Offline delivery invoicing and route sales for any business, from one van to 100+ reps.</div>
  </div>
  <div style="position:absolute;right:86px;top:60px;width:300px;padding:10px;border-radius:40px;background:linear-gradient(145deg,#2a2f2b,#0b0d0c);box-shadow:0 30px 70px rgba(0,0,0,.45);transform:rotate(-3deg)">
    <div style="border-radius:31px;overflow:hidden;height:620px"><img src="${shot}" style="width:100%;display:block"></div>
  </div>
</div></body></html>`;
(async () => {
  const b = await chromium.launch();
  const p = await b.newPage({ viewport: { width: 1200, height: 630 } });
  await p.setContent(html, { waitUntil: "load" });
  await p.screenshot({ path: path.join(PUB, "og.png") });
  await b.close();
  console.log("og.png", fs.statSync(path.join(PUB, "og.png")).size, "bytes");
})();
