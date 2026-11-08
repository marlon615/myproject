/** Chief's screens: one calm home screen, the passcode lock, and the hidden owner dashboard. */

export const esc = (v: unknown) =>
  String(v ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!);

const CSS = `
:root{color-scheme:dark;--bg:#09090b;--surface:#141418;--surface2:#1d1d23;--line:rgba(255,255,255,.08);--text:#f5f3ef;--muted:#8f8b84;--gold:#e9b864;--yes:#34c77b;--no:#ff6b5b}
*{box-sizing:border-box}html,body{margin:0;background:var(--bg)}
body{color:var(--text);font:17px/1.5 -apple-system,BlinkMacSystemFont,"SF Pro Text","Segoe UI",Roboto,sans-serif;-webkit-font-smoothing:antialiased}
a{color:var(--gold);text-decoration:none}
.wrap{max-width:560px;margin:0 auto;padding:calc(18px + env(safe-area-inset-top)) 20px calc(28px + env(safe-area-inset-bottom))}
.muted{color:var(--muted)}.small{font-size:.86rem}.center{text-align:center}
input{width:100%;font:inherit;font-size:16px;color:var(--text);background:var(--surface2);border:1px solid var(--line);border-radius:12px;padding:12px 13px;outline:none}
input:focus{border-color:var(--gold)}
label{display:block;font-size:.84rem;color:var(--muted);margin:14px 0 6px;font-weight:600}
.btn{display:inline-flex;align-items:center;justify-content:center;min-height:50px;padding:10px 20px;border-radius:14px;border:0;background:linear-gradient(180deg,#f0c777,#c8913a);color:#1a1205;font:inherit;font-weight:700;cursor:pointer}
.card{background:var(--surface);border:1px solid var(--line);border-radius:18px;padding:16px 18px;margin-bottom:12px}
h2{font-size:.76rem;letter-spacing:.09em;text-transform:uppercase;color:var(--muted);margin:24px 4px 8px;font-weight:700}
.flash{background:rgba(233,184,100,.12);color:#f3cf8c;border-radius:14px;padding:12px 14px;margin-bottom:14px;font-weight:600}
`;

export function shell(title: string, body: string) {
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1,viewport-fit=cover">
<meta name="robots" content="noindex,nofollow"><meta name="theme-color" content="#09090b"><meta name="apple-mobile-web-app-capable" content="yes"><meta name="apple-mobile-web-app-status-bar-style" content="black-translucent">
<meta name="apple-mobile-web-app-title" content="Chief"><link rel="manifest" href="/manifest.webmanifest"><link rel="apple-touch-icon" href="/icon-192.png">
<title>${esc(title)}</title><style>${CSS}</style></head><body><div class="wrap">${body}</div></body></html>`;
}

// ── The one screen ──

const HOME_CSS = `
.home{min-height:calc(100dvh - 60px);display:flex;flex-direction:column;align-items:center;justify-content:center;text-align:center}
.orb{width:168px;height:168px;border-radius:50%;display:grid;place-items:center;background:radial-gradient(circle at 35% 28%,#fff5dc,var(--gold) 42%,#6e4c13 100%);
  box-shadow:0 0 0 1px rgba(233,184,100,.22),0 18px 80px rgba(233,184,100,.30);animation:breathe 4s ease-in-out infinite;color:#1a1205}
.orb svg{width:54px;height:54px}
@keyframes breathe{50%{transform:scale(1.035);box-shadow:0 0 0 1px rgba(233,184,100,.22),0 18px 100px rgba(233,184,100,.42)}}
.title{font-size:1.9rem;font-weight:800;letter-spacing:-.02em;margin:30px 0 4px}
.num{font-size:1.15rem;color:var(--muted);font-variant-numeric:tabular-nums;letter-spacing:.02em}
.status{margin-top:34px;display:inline-flex;align-items:center;gap:9px;padding:9px 15px;border-radius:999px;background:var(--surface);border:1px solid var(--line);font-size:.9rem}
.status i{width:8px;height:8px;border-radius:50%;background:var(--yes);box-shadow:0 0 10px var(--yes)}.status.wait i{background:var(--gold);box-shadow:0 0 10px var(--gold)}
.hint{margin-top:18px;color:var(--muted);font-size:.9rem;max-width:340px}
.quiet{margin-top:28px;font-size:.85rem}.quiet a{color:var(--muted)}
@media (prefers-reduced-motion:reduce){.orb{animation:none}}
`;

const PHONE_ICON = '<svg viewBox="0 0 24 24" fill="currentColor"><path d="M6.6 10.8a15.1 15.1 0 0 0 6.6 6.6l2.2-2.2a1 1 0 0 1 1-.25 11.4 11.4 0 0 0 3.6.57 1 1 0 0 1 1 1V20a1 1 0 0 1-1 1A17 17 0 0 1 3 4a1 1 0 0 1 1-1h3.5a1 1 0 0 1 1 1c0 1.25.2 2.45.57 3.57a1 1 0 0 1-.25 1z"/></svg>';

export function homePage(o: { number: string | null; pretty: string; waiting: number; ready: boolean; canNotify: boolean }) {
  const status = !o.ready ? `<div class="status wait"><i></i>Chief's phone line is being set up</div>`
    : o.waiting ? `<div class="status wait"><i></i>${o.waiting} important email${o.waiting === 1 ? "" : "s"} waiting</div>`
    : `<div class="status"><i></i>All caught up</div>`;
  return shell("Chief", `<style>${HOME_CSS}</style>
<main class="home">
  ${o.number ? `<a class="orb" href="tel:${esc(o.number)}" aria-label="Call Chief">${PHONE_ICON}</a>` : `<div class="orb" aria-hidden="true">${PHONE_ICON}</div>`}
  <div class="title">Call Chief</div>
  <div class="num">${o.number ? esc(o.pretty) : "&nbsp;"}</div>
  ${status}
  <div class="hint">${o.number ? "Or just say “Hey Siri, call Chief.” Keep talking while you use any other app." : "As soon as the line is ready, you'll call Chief here."}</div>
  ${o.number ? `<div class="quiet"><a href="/chief.vcf">Save Chief to your contacts</a>${o.canNotify ? ` · <a href="#" id="notify">Notify me</a>` : ""}</div>` : ""}
</main>
${o.canNotify ? `<script>
(function(){
  var a = document.getElementById("notify"); if (!a) return;
  var standalone = matchMedia("(display-mode: standalone)").matches || navigator.standalone === true;
  if (!("serviceWorker" in navigator) || !("PushManager" in window) || (/iPhone|iPad/.test(navigator.userAgent) && !standalone) || Notification.permission === "denied") { a.previousSibling && a.previousSibling.remove(); a.remove(); return; }
  navigator.serviceWorker.register("/sw.js").catch(function(){});
  function b64(s){ s=s.replace(/-/g,"+").replace(/_/g,"/"); while(s.length%4) s+="="; var b=atob(s), u=new Uint8Array(b.length); for(var i=0;i<b.length;i++) u[i]=b.charCodeAt(i); return u; }
  async function sub(){ var reg = await navigator.serviceWorker.ready; var s = await reg.pushManager.getSubscription();
    if(!s){ var k = await (await fetch("/api/push-key")).json(); s = await reg.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: b64(k.key) }); }
    await fetch("/api/push-subscribe", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(s) }); a.textContent = "Notifications on"; }
  if (Notification.permission === "granted") { sub(); }
  a.addEventListener("click", function(e){ e.preventDefault(); Notification.requestPermission().then(function(p){ if(p==="granted") sub(); }); });
})();
</script>` : ""}`);
}

// ── Passcode lock ──

const LOCK_CSS = `
.lock{min-height:calc(100dvh - 60px);display:flex;flex-direction:column;align-items:center;justify-content:center;text-align:center;gap:6px}
.logo{width:60px;height:60px;border-radius:50%;background:radial-gradient(circle at 35% 30%,#fff3d6,var(--gold) 45%,#6b4a12);box-shadow:0 0 40px rgba(233,184,100,.35);margin-bottom:14px}
.dots{display:flex;gap:14px;margin:22px 0 26px}.dots i{width:13px;height:13px;border-radius:50%;border:1.5px solid var(--text);display:block}.dots i.on{background:var(--text)}
.shake{animation:shake .35s}@keyframes shake{25%{transform:translateX(-8px)}75%{transform:translateX(8px)}}
.pad{display:grid;grid-template-columns:repeat(3,76px);gap:16px 24px}
.pad button{width:76px;height:76px;border-radius:50%;border:0;background:var(--surface2);color:var(--text);font:400 1.9rem/1 -apple-system,BlinkMacSystemFont,sans-serif;cursor:pointer}
.pad button:active{background:#3a3a42}.pad .ghost{background:transparent;font-size:1rem;font-weight:600}
`;

export function lockPage(error?: string, mode: "pin" | "password" = "password", next = "") {
  const nx = next ? `<input type="hidden" name="next" value="${esc(next)}">` : "";
  if (mode === "pin") {
    return shell("Chief", `<style>${LOCK_CSS}</style>
<form class="lock" method="post" action="/login" id="f">${nx}<div class="logo"></div>
<div style="font-weight:700;font-size:1.15rem">Enter Passcode</div><div class="muted small">${error ? esc(error) : "Chief is private to you."}</div>
<div class="dots${error ? " shake" : ""}" id="d">${"<i></i>".repeat(6)}</div><input type="hidden" name="pin" id="p">
<div class="pad">${[1, 2, 3, 4, 5, 6, 7, 8, 9].map((n) => `<button type="button" data-k="${n}">${n}</button>`).join("")}<span></span><button type="button" data-k="0">0</button><button type="button" class="ghost" data-k="del">Delete</button></div>
<a href="/login?use=password" class="small" style="margin-top:22px">Use password instead</a></form>
<script>(function(){var v="",d=document.querySelectorAll("#d i");function k(x){if(x==="del")v=v.slice(0,-1);else if(v.length<6)v+=x;d.forEach(function(e,i){e.className=i<v.length?"on":""});if(v.length===6){document.getElementById("p").value=v;setTimeout(function(){document.getElementById("f").submit()},120)}}
document.querySelectorAll(".pad button").forEach(function(b){b.addEventListener("click",function(){k(b.getAttribute("data-k"))})});document.addEventListener("keydown",function(e){if(/^[0-9]$/.test(e.key))k(e.key);else if(e.key==="Backspace")k("del")})})();</script>`);
  }
  return shell("Chief", `<style>${LOCK_CSS}</style>
<form class="lock" method="post" action="/login">${nx}<div class="logo"></div><div style="font-weight:700;font-size:1.15rem">Chief</div>
<div class="muted small" style="margin-bottom:18px">Private. Owner only.</div>
<input name="password" type="password" autocomplete="current-password" placeholder="Password" required autofocus style="max-width:300px;text-align:center">
${error ? `<p style="color:var(--no);font-weight:600">${esc(error)}</p>` : ""}<button class="btn" style="margin-top:14px;min-width:200px">Unlock</button></form>`);
}

export function passcodePage(error?: string) {
  return shell("Chief", `<style>${LOCK_CSS}</style>
<form class="lock" method="post" action="/passcode"><div class="logo"></div><div style="font-weight:700;font-size:1.15rem">Create a passcode</div>
<div class="muted small" style="max-width:300px;margin-bottom:16px">6 digits. It unlocks Chief here, and you can say it on a call from any phone that isn't yours.</div>
<input name="pin" inputmode="numeric" pattern="[0-9]{6}" maxlength="6" placeholder="••••••" required autofocus autocomplete="new-password" style="max-width:220px;text-align:center;font-size:1.5rem;letter-spacing:.4em">
<input name="pin2" inputmode="numeric" pattern="[0-9]{6}" maxlength="6" placeholder="Again" required autocomplete="new-password" style="max-width:220px;text-align:center;letter-spacing:.3em;margin-top:10px">
${error ? `<p style="color:var(--no);font-weight:600">${esc(error)}</p>` : ""}<button class="btn" style="margin-top:14px;min-width:200px">Save</button></form>`);
}

// ── Hidden owner dashboard (/owner, never linked from the app) ──

export interface OwnerData {
  flash?: string;
  gmail: { connected: boolean; address: string };
  ai: boolean;
  twilio: boolean;
  chief: string;
  owner: string;
  pin: boolean;
  waiting: number;
  repliesSent7: number;
  calls7: number;
  blocked: string[];
  lastCheck: string;
  recent: { at: string; text: string }[];
}

export function ownerPage(d: OwnerData) {
  const ok = (b: boolean) => (b ? `<span style="color:var(--yes)">●</span>` : `<span style="color:var(--no)">●</span>`);
  const tile = (label: string, v: string | number) => `<div class="card" style="margin:0"><div class="muted small">${label}</div><div style="font-size:1.8rem;font-weight:800">${esc(v)}</div></div>`;
  return shell("Owner · Chief", `${d.flash ? `<div class="flash">${esc(d.flash)}</div>` : ""}
<div style="font-size:1.9rem;font-weight:800;letter-spacing:-.02em;margin:6px 0 2px">Owner</div>
<div class="muted small">Private. Not linked anywhere in the app. ${esc(d.lastCheck)}</div>
<div style="display:grid;grid-template-columns:1fr 1fr;gap:10px;margin-top:16px">${tile("Important waiting", d.waiting)}${tile("Replies sent · 7 days", d.repliesSent7)}${tile("Calls · 7 days", d.calls7)}${tile("Blocked senders", d.blocked.length)}</div>
<h2>Recent</h2><div class="card">${d.recent.length ? d.recent.map((r) => `<div style="display:flex;justify-content:space-between;gap:10px;padding:6px 0;border-bottom:1px solid var(--line)"><span>${esc(r.text)}</span><span class="muted small" style="white-space:nowrap">${esc(r.at)}</span></div>`).join("") : `<span class="muted">Nothing yet.</span>`}</div>
<h2>Connections</h2>
<div class="card small" style="line-height:2">${ok(d.gmail.connected)} Gmail ${d.gmail.address ? `· ${esc(d.gmail.address)}` : ""}<br>${ok(d.ai)} Anthropic key (understands plain words, writes and rewrites replies)<br>${ok(d.twilio)} Phone line ${d.chief ? `· ${esc(d.chief)}` : ""}<br>${ok(Boolean(d.owner))} Your mobile ${d.owner ? `· ${esc(d.owner)}` : ""}<br>${ok(d.pin)} Passcode</div>
<form method="post" action="/owner/connect" class="card">
<div style="font-weight:700">Connect, once</div><div class="muted small">Only fill in what's missing. Everything is stored encrypted.</div>
<label>Your mobile number (calls from it skip the passcode)</label><input name="owner" inputmode="tel" placeholder="${esc(d.owner || "(214) 555-0100")}">
<label>Anthropic API key</label><input name="anthropic" type="password" autocomplete="off" placeholder="${d.ai ? "Saved · paste to replace" : "sk-ant-…"}">
<label>Twilio Account SID</label><input name="twilioSid" autocomplete="off" placeholder="${d.twilio ? "Saved · paste to replace" : "AC…"}">
<label>Twilio Auth Token</label><input name="twilioToken" type="password" autocomplete="off" placeholder="${d.twilio ? "Saved · paste to replace" : "32 characters"}">
<label>Gmail app password${d.gmail.address ? "" : " (and address)"}</label>${d.gmail.address ? "" : `<input name="gmailAddress" type="email" placeholder="you@gmail.com" style="margin-bottom:8px">`}<input name="gmailPassword" type="password" autocomplete="off" placeholder="${d.gmail.connected ? "Saved · paste to replace" : "16 letters"}">
<button class="btn" style="width:100%;margin-top:16px">Save and connect</button></form>
${d.blocked.length ? `<h2>Blocked senders</h2><div class="card small">${d.blocked.map((b) => `<form method="post" action="/owner/unblock" style="display:flex;justify-content:space-between;align-items:center;padding:4px 0"><span>${esc(b)}</span><input type="hidden" name="email" value="${esc(b)}"><button style="background:none;border:0;color:var(--gold);font:inherit;cursor:pointer">Unblock</button></form>`).join("")}</div>` : ""}
<div class="center small" style="margin-top:20px"><a href="/" class="muted">Back to Chief</a> · <a href="/passcode" class="muted">${d.pin ? "Change" : "Create"} passcode</a></div>`);
}
