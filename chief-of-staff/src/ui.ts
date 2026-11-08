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

// ── The one screen: a voice conversation, like a voice assistant ──

const HOME_CSS = `
.home{min-height:calc(100dvh - 60px);display:flex;flex-direction:column;align-items:center;text-align:center}
.top{width:100%;display:flex;justify-content:center;min-height:36px}
.pill{display:inline-flex;align-items:center;gap:9px;padding:8px 14px;border-radius:999px;background:var(--surface);border:1px solid var(--line);font-size:.86rem;color:var(--muted)}
.pill i{width:7px;height:7px;border-radius:50%;background:var(--yes);box-shadow:0 0 10px var(--yes)}.pill.wait i{background:var(--gold);box-shadow:0 0 10px var(--gold)}
.stage{flex:1;display:flex;flex-direction:column;align-items:center;justify-content:center;width:100%;padding:20px 0}
.orb{width:190px;height:190px;border-radius:50%;border:0;cursor:pointer;position:relative;-webkit-tap-highlight-color:transparent;
  background:radial-gradient(circle at 35% 28%,#fff5dc,var(--gold) 42%,#6e4c13 100%);box-shadow:0 0 0 1px rgba(233,184,100,.22),0 18px 80px rgba(233,184,100,.28);transition:transform .25s}
.orb.idle{animation:breathe 4.5s ease-in-out infinite}
.orb.listening{animation:listen 1.6s ease-out infinite;background:radial-gradient(circle at 35% 28%,#fffaf0,#f3cf86 45%,#8a6219 100%)}
.orb.thinking{animation:think 1.2s ease-in-out infinite}
.orb.speaking{animation:speak .9s ease-in-out infinite}
@keyframes breathe{50%{transform:scale(1.03)}}
@keyframes listen{0%{box-shadow:0 0 0 0 rgba(233,184,100,.45),0 18px 80px rgba(233,184,100,.3)}100%{box-shadow:0 0 0 42px rgba(233,184,100,0),0 18px 80px rgba(233,184,100,.3)}}
@keyframes think{50%{filter:brightness(1.18);transform:scale(.98)}}
@keyframes speak{0%,100%{transform:scale(1)}50%{transform:scale(1.07)}}
.state{margin-top:30px;font-size:1.05rem;font-weight:700;letter-spacing:.01em;min-height:1.5em}
.said{margin-top:14px;max-width:460px;font-size:1.12rem;line-height:1.5;color:var(--text);min-height:3em;transition:opacity .3s}
.you{margin-top:10px;max-width:460px;color:var(--muted);font-size:.95rem;min-height:1.4em;font-style:italic}
.draft{width:100%;text-align:left;background:var(--surface);border:1px solid rgba(233,184,100,.4);border-radius:20px;padding:16px 18px;margin-top:22px;animation:rise .3s ease}
.draft .meta{font-size:.82rem;color:var(--muted)}.draft .body{white-space:pre-wrap;margin-top:10px;line-height:1.55}
@keyframes rise{from{opacity:0;transform:translateY(8px)}to{opacity:1;transform:none}}
.foot{font-size:.82rem;color:var(--muted);margin-top:18px;max-width:380px}.foot a{color:var(--muted)}
.type{display:flex;gap:8px;width:100%;margin-top:16px}.type input{flex:1}
@media (prefers-reduced-motion:reduce){.orb{animation:none!important}}
`;

export function homePage(o: { waiting: number; canNotify: boolean; voiceJs: string; killPhrase: string }) {
  const pill = o.waiting ? `<div class="pill wait" id="pill"><i></i><span>${o.waiting} important email${o.waiting === 1 ? "" : "s"} waiting</span></div>`
    : `<div class="pill" id="pill"><i></i><span>All caught up</span></div>`;
  return shell("Chief", `<style>${HOME_CSS}</style>
<main class="home">
  <div class="top">${pill}</div>
  <section class="stage">
    <button class="orb idle" id="orb" aria-label="Talk to Chief"></button>
    <div class="state" id="state">Tap to talk</div>
    <div class="said" id="said">Talk to Chief like you'd talk to a person. It can read and answer your email and open your dashboards.</div>
    <div class="you" id="you"></div>
    <div class="draft" id="draft" hidden><div class="meta" id="dmeta"></div><div class="body" id="dbody"></div></div>
    <form class="type" id="type"><input id="typed" placeholder="Or type to Chief" autocomplete="off" enterkeyhint="send"><button class="btn">Send</button></form>
  </section>
  <div class="foot" id="foot">Keep Chief open on screen while you talk; if you switch apps it pauses and picks up when you're back. To stop everything, say “${esc(o.killPhrase)}”.${o.canNotify ? ` <a href="#" id="notify">Notify me about important email</a>` : ""}</div>
</main>
<script>
${o.voiceJs}
(function(){
  var $ = function(id){ return document.getElementById(id); };
  var SR = window.SpeechRecognition || window.webkitSpeechRecognition;
  var S = { on:false, mode:"idle", rec:null, id:null, token:0, lastSaid:"", quietUntil:0, paused:false, lock:null, voice:null, male:false };

  function setMode(m, label){
    S.mode = m; $("orb").className = "orb " + m;
    $("state").textContent = label || ({ idle:"Tap to talk", listening:"Listening", thinking:"Thinking", speaking:"Chief", paused:"Tap to continue" })[m] || "";
  }
  function newId(){ var a = new Uint8Array(18); crypto.getRandomValues(a); return btoa(String.fromCharCode.apply(null, a)).replace(/[+/=]/g, function(c){ return c === "+" ? "-" : c === "/" ? "_" : ""; }); }
  async function lockScreen(){ try { if (navigator.wakeLock) S.lock = await navigator.wakeLock.request("screen"); } catch(e){} }

  // ── Voice: the best deep male voice on this phone ──
  // The phone's most natural voices first (Premium, Enhanced, Neural, Google, online), robotic novelty voices left out.
  function rankedVoices(){
    var list = (speechSynthesis.getVoices ? speechSynthesis.getVoices() : []) || [];
    var lang = (navigator.language || "en-US").toLowerCase();
    return list.map(function(v){
      var n = (v.name || "") + " " + (v.voiceURI || ""), l = (v.lang || "").toLowerCase().replace("_", "-"), q = 0;
      if (l.slice(0, 2) !== lang.slice(0, 2)) return null;
      if (/\\b(fred|junior|ralph|albert|bruce|grandpa|grandma|rocko|eddy|zarvox|trinoids|whisper|bad news|good news|bells|boing|bubbles|cellos|organ|superstar|wobble|jester|shelley|sandy|flo|reed)\\b/i.test(n)) return null;
      if (/premium/i.test(n)) q += 50; else if (/enhanced|neural|natural/i.test(n)) q += 40; else if (/google|online|-network/i.test(n)) q += 30; else if (/siri/i.test(n)) q += 35;
      if (/compact/i.test(n)) q -= 10;
      if (l === lang) q += 8;
      var g = (CHIEF_MALE.test(n) || CHIEF_ANDROID_MALE.test(n)) ? "m" : (CHIEF_FEMALE.test(n) || CHIEF_ANDROID_FEMALE.test(n)) ? "f" : "";
      return { v: v, q: q, g: g };
    }).filter(Boolean).sort(function(a, b){ return b.q - a.q || (a.g === "m" ? -1 : 1); });
  }
  function store(k, v){ try { if (v == null) localStorage.removeItem(k); else localStorage.setItem(k, v); } catch(e){} }
  function stored(k){ try { return localStorage.getItem(k); } catch(e){ return null; } }
  S.rate = Number(stored("chiefRate")) || 1;
  function loadVoice(){
    var r = rankedVoices(), want = stored("chiefVoice2");
    var pick = r.filter(function(x){ return x.v.voiceURI === want; })[0] || r[0];
    S.voice = pick ? pick.v : null; S.ranked = r;
  }
  /** "Change your voice", "use a woman's voice", "talk slower": handled right here on the phone. */
  function voiceCommand(text){
    var t = text.toLowerCase();
    var r = S.ranked && S.ranked.length ? S.ranked : rankedVoices();
    if (!r.length && !/faster|slower/.test(t)) return false;
    var cur = r.map(function(x){ return x.v.voiceURI; }).indexOf(S.voice && S.voice.voiceURI);
    var choose = function(x, note){ if (!x) return speak("That's the only voice this phone has. You can download more in your iPhone settings, under Accessibility, Spoken Content, Voices.", listen);
      S.voice = x.v; store("chiefVoice2", x.v.voiceURI); speak(note || "How's this voice? If you want another one, just tell me.", listen); };
    if (/\\b(woman|women|female|lady|girl)\\b/.test(t) && /\\bvoice\\b/.test(t)) { choose(r.filter(function(x){ return x.g === "f"; })[0] || r.filter(function(x){ return x.g !== "m"; })[0]); return true; }
    if (/\\b(man|men|male|guy)\\b/.test(t) && /\\bvoice\\b/.test(t)) { choose(r.filter(function(x){ return x.g === "m"; })[0] || r.filter(function(x){ return x.g !== "f"; })[0]); return true; }
    if (/\\b(change|switch|different|another|new|next|other)\\b.*\\bvoice\\b|\\bvoice\\b.*\\b(annoying|change|switch|different)\\b/.test(t)) { choose(r.length > 1 ? r[(cur + 1) % r.length] : null); return true; }
    if (/\\b(talk|speak|go|read)\\b.*\\bfaster\\b|^faster\\b/.test(t)) { S.rate = Math.min(1.4, (S.rate || 1) + 0.12); store("chiefRate", String(S.rate)); speak("Okay, a little faster.", listen); return true; }
    if (/\\b(talk|speak|go|read)\\b.*\\bslower\\b|^slower\\b|slow down/.test(t)) { S.rate = Math.max(0.75, (S.rate || 1) - 0.12); store("chiefRate", String(S.rate)); speak("Okay, a little slower.", listen); return true; }
    return false;
  }
  if ("speechSynthesis" in window) { loadVoice(); try { speechSynthesis.addEventListener("voiceschanged", loadVoice); } catch(e){} }

  function pieces(text){
    var out = [], safe = text.replace(/(\\d)\\.(\\d)/g, "$1\\u2024$2");
    (safe.match(/[^.!?]+[.!?]*\\s*/g) || [safe]).forEach(function(p){
      p = p.replace(/\\u2024/g, ".").trim(); if (!p) return;
      while (p.length > 180) { var c = p.lastIndexOf(",", 180); if (c < 60) c = p.lastIndexOf(" ", 180); if (c < 1) c = 180; out.push(p.slice(0, c + 1)); p = p.slice(c + 1).trim(); }
      if (p) out.push(p);
    });
    return out;
  }
  function speak(text, then){
    $("said").textContent = text; S.lastSaid = text.toLowerCase();
    if (!("speechSynthesis" in window) || !text) { if (then) then(); return; }
    stopListening(); setMode("speaking");
    var token = ++S.token, done = false, started = Date.now(), parts = pieces(text);
    function finish(){ if (done || token !== S.token) return; done = true; setTimeout(function(){ if (token !== S.token) return; S.quietUntil = Date.now() + 600; if (then) then(); }, 300); }
    function go(){
      if (!S.voice) loadVoice();
      parts.forEach(function(p, i){
        var u = new SpeechSynthesisUtterance(p);
        if (S.voice) { u.voice = S.voice; u.lang = S.voice.lang; }
        u.pitch = 1; u.rate = S.rate || 1; // the voice as it was made to sound: no pitch tricks
        if (i === parts.length - 1) { u.onend = finish; u.onerror = finish; }
        speechSynthesis.speak(u);
      });
      (function poll(){ if (done || token !== S.token) return;
        if ((!speechSynthesis.speaking && !speechSynthesis.pending && Date.now() - started > 1500) || Date.now() - started > 9000 + text.split(/\\s+/).length * 900) return finish();
        setTimeout(poll, 400); })();
    }
    if (speechSynthesis.speaking || speechSynthesis.pending) { speechSynthesis.cancel(); setTimeout(go, 150); } else go();
  }
  function hush(){ S.token++; try { speechSynthesis.cancel(); } catch(e){} }

  // ── Listening: one thing you say at a time ──
  function stopListening(){ if (S.rec) { try { S.rec.abort(); } catch(e){} S.rec = null; } }
  function listen(){
    if (!S.on || S.paused) return;
    if (!SR) { setMode("listening", "Type to Chief"); return; }
    stopListening(); setMode("listening");
    var r = new SR(), final = ""; S.rec = r;
    r.lang = navigator.language || "en-US"; r.continuous = false; r.interimResults = true;
    r.onresult = function(e){
      var interim = "";
      for (var i = e.resultIndex; i < e.results.length; i++) { if (e.results[i].isFinal) final += e.results[i][0].transcript; else interim += e.results[i][0].transcript; }
      $("you").textContent = (final + interim).trim();
    };
    r.onerror = function(e){ if (e.error === "not-allowed" || e.error === "service-not-allowed") { S.on = false; setMode("idle", "Microphone is off"); $("said").textContent = "Allow the microphone for Chief in your phone's settings, then tap to talk."; } };
    r.onend = function(){
      if (S.rec !== r) return; S.rec = null;
      var t = final.trim();
      if (!S.on || S.paused) return;
      if (!t) return setTimeout(listen, 200); // nothing heard: keep listening (the mic is off while Chief talks, so it never hears itself)
      send(t);
    };
    try { r.start(); } catch(e){ setTimeout(listen, 500); }
  }
  function isEcho(t){
    var h = t.toLowerCase().replace(/[^a-z0-9 ]/g, " ").replace(/\\s+/g, " ").trim();
    return h.split(" ").length >= 3 && S.lastSaid.replace(/[^a-z0-9 ]/g, " ").replace(/\\s+/g, " ").indexOf(h) >= 0;
  }

  // ── Talking to Chief ──
  async function call(path, body){
    var r = await fetch(path, { method:"POST", credentials:"same-origin", headers:{ "Content-Type":"application/json" }, body: JSON.stringify(body) });
    if (r.status === 401) { location.href = "/login"; throw new Error("locked"); }
    return r.json();
  }
  function show(res){
    var d = res.draft;
    if (d) { $("dmeta").textContent = "To " + d.to + "  ·  " + d.subject; $("dbody").textContent = d.body; $("draft").hidden = false; }
    else $("draft").hidden = true;
    if (res.open) { var w = window.open(res.open, "_blank"); if (!w) location.href = res.open; }
    if (res.paused) $("state").textContent = "Stopped";
    if (typeof res.waiting === "number") { var p = $("pill"); p.className = "pill" + (res.waiting ? " wait" : ""); p.lastChild.textContent = res.waiting ? res.waiting + " important email" + (res.waiting === 1 ? "" : "s") + " waiting" : "All caught up"; }
  }
  function handle(res){
    show(res);
    speak(res.say, function(){ if (res.end) { S.on = false; setMode("idle"); return; } listen(); });
  }
  async function send(text){
    if (voiceCommand(text)) { $("you").textContent = text; return; }
    $("you").textContent = text; setMode("thinking");
    try { handle(await call("/api/talk", { id: S.id, text: text })); }
    catch(e){ speak("I couldn't reach the server. Check your connection.", listen); }
  }
  async function start(){
    S.on = true; S.paused = false; S.id = newId(); lockScreen();
    try { var u = new SpeechSynthesisUtterance(" "); u.volume = 0; speechSynthesis.speak(u); } catch(e){} // unlocks speech on iPhone
    setMode("thinking", "Connecting");
    try { handle(await call("/api/talk/start", { id: S.id })); }
    catch(e){ S.on = false; setMode("idle"); $("said").textContent = "Couldn't connect. Tap to try again."; }
  }

  $("orb").addEventListener("click", function(){
    if (!S.on) return start();
    if (S.paused) return resume(true);
    if (S.mode === "speaking") { hush(); listen(); }   // tap to interrupt Chief
  });
  $("type").addEventListener("submit", function(e){ e.preventDefault(); var t = $("typed").value.trim(); if (!t) return; $("typed").value = ""; if (!S.on) { S.on = true; S.id = S.id || newId(); } send(t); });

  // ── Leaving the app: pause; coming back: pick up where we were ──
  async function resume(fromTap){
    S.paused = false; lockScreen(); setMode("thinking", "Welcome back");
    try {
      var res = await call("/api/talk/resume", { id: S.id }); show(res);
      var before = S.token; speak(res.say, function(){ if (res.end) { S.on = false; setMode("idle"); return; } listen(); });
      if (!fromTap) setTimeout(function(){ if (S.token === before + 1 && !speechSynthesis.speaking && S.mode === "speaking") { hush(); S.paused = true; setMode("paused"); } }, 2500);
    } catch(e){ S.paused = true; setMode("paused"); }
  }
  document.addEventListener("visibilitychange", function(){
    if (!S.on) return;
    if (document.visibilityState === "hidden") { S.paused = true; hush(); stopListening(); setMode("paused"); }
    else if (S.paused) resume(false);
  });

  ${o.canNotify ? `var a = $("notify");
  if (a) {
    var standalone = matchMedia("(display-mode: standalone)").matches || navigator.standalone === true;
    if (!("serviceWorker" in navigator) || !("PushManager" in window) || (/iPhone|iPad/.test(navigator.userAgent) && !standalone) || Notification.permission === "denied") a.remove();
    else {
      navigator.serviceWorker.register("/sw.js").catch(function(){});
      var b64 = function(s){ s=s.replace(/-/g,"+").replace(/_/g,"/"); while(s.length%4) s+="="; var b=atob(s), u=new Uint8Array(b.length); for(var i=0;i<b.length;i++) u[i]=b.charCodeAt(i); return u; };
      var sub = async function(){ var reg = await navigator.serviceWorker.ready; var s = await reg.pushManager.getSubscription();
        if(!s){ var k = await (await fetch("/api/push-key")).json(); s = await reg.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: b64(k.key) }); }
        await fetch("/api/push-subscribe", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(s) }); a.textContent = "Notifications on"; };
      if (Notification.permission === "granted") sub();
      a.addEventListener("click", function(e){ e.preventDefault(); Notification.requestPermission().then(function(p){ if(p==="granted") sub(); }); });
    }
  }` : ""}
})();
</script>`);
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
<div class="muted small" style="max-width:300px;margin-bottom:16px">6 digits. It unlocks Chief.</div>
<input name="pin" inputmode="numeric" pattern="[0-9]{6}" maxlength="6" placeholder="••••••" required autofocus autocomplete="new-password" style="max-width:220px;text-align:center;font-size:1.5rem;letter-spacing:.4em">
<input name="pin2" inputmode="numeric" pattern="[0-9]{6}" maxlength="6" placeholder="Again" required autocomplete="new-password" style="max-width:220px;text-align:center;letter-spacing:.3em;margin-top:10px">
${error ? `<p style="color:var(--no);font-weight:600">${esc(error)}</p>` : ""}<button class="btn" style="margin-top:14px;min-width:200px">Save</button></form>`);
}

// ── Hidden owner dashboard (/owner, never linked from the app) ──

export interface OwnerData {
  flash?: string;
  gmail: { connected: boolean; address: string };
  ai: boolean;
  pin: boolean;
  waiting: number;
  repliesSent7: number;
  talks7: number;
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
<div style="display:grid;grid-template-columns:1fr 1fr;gap:10px;margin-top:16px">${tile("Important waiting", d.waiting)}${tile("Replies sent · 7 days", d.repliesSent7)}${tile("Conversations · 7 days", d.talks7)}${tile("Blocked senders", d.blocked.length)}</div>
<h2>Recent</h2><div class="card">${d.recent.length ? d.recent.map((r) => `<div style="display:flex;justify-content:space-between;gap:10px;padding:6px 0;border-bottom:1px solid var(--line)"><span>${esc(r.text)}</span><span class="muted small" style="white-space:nowrap">${esc(r.at)}</span></div>`).join("") : `<span class="muted">Nothing yet.</span>`}</div>
<h2>Connections</h2>
<div class="card small" style="line-height:2">${ok(d.gmail.connected)} Gmail ${d.gmail.address ? `· ${esc(d.gmail.address)}` : ""}<br>${ok(d.ai)} Anthropic key (understands plain words, writes and rewrites replies)<br>${ok(d.pin)} Passcode</div>
<form method="post" action="/owner/connect" class="card">
<div style="font-weight:700">Connect, once</div><div class="muted small">Only fill in what's missing. Everything is stored encrypted.</div>
<label>Anthropic API key</label><input name="anthropic" type="password" autocomplete="off" placeholder="${d.ai ? "Saved · paste to replace" : "sk-ant-…"}">
<label>Gmail app password${d.gmail.address ? "" : " (and address)"}</label>${d.gmail.address ? "" : `<input name="gmailAddress" type="email" placeholder="you@gmail.com" style="margin-bottom:8px">`}<input name="gmailPassword" type="password" autocomplete="off" placeholder="${d.gmail.connected ? "Saved · paste to replace" : "16 letters"}">
<button class="btn" style="width:100%;margin-top:16px">Save and connect</button></form>
${d.blocked.length ? `<h2>Blocked senders</h2><div class="card small">${d.blocked.map((b) => `<form method="post" action="/owner/unblock" style="display:flex;justify-content:space-between;align-items:center;padding:4px 0"><span>${esc(b)}</span><input type="hidden" name="email" value="${esc(b)}"><button style="background:none;border:0;color:var(--gold);font:inherit;cursor:pointer">Unblock</button></form>`).join("")}</div>` : ""}
<div class="center small" style="margin-top:20px"><a href="/" class="muted">Back to Chief</a> · <a href="/passcode" class="muted">${d.pin ? "Change" : "Create"} passcode</a></div>`);
}
