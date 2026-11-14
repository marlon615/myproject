/**
 * The maker's console (/console): buyers and their personal links (devices, amount paid, switch off), the money
 * collected, and anonymous counts of how the app is used. The first visit sets the passcode;
 * after that it asks for it (5 wrong tries per 15 minutes). The session lasts 12 hours, in this tab only.
 */
const root = document.getElementById("console");
const TOKEN = "marlon.console";
const getToken = () => { try { return sessionStorage.getItem(TOKEN) || ""; } catch { return ""; } };
const setToken = (t) => { try { if (t) sessionStorage.setItem(TOKEN, t); else sessionStorage.removeItem(TOKEN); } catch { /* fine */ } };
const NS = "http://www.w3.org/2000/svg";
const fmt = (n) => Number(n || 0).toLocaleString("en-US");
const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
const DAYS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
const dayText = (iso, withDow = true) => { const d = new Date(`${iso}T12:00:00Z`); return `${withDow ? DAYS[d.getUTCDay()] + " " : ""}${d.getUTCDate()} ${MONTHS[d.getUTCMonth()]}`; };

function el(tag, props = {}, ...kids) {
  const n = document.createElement(tag);
  for (const [k, v] of Object.entries(props)) {
    if (v === null || v === undefined || v === false) continue;
    if (k.startsWith("on")) n.addEventListener(k.slice(2), v);
    else if (k === "class") n.className = v;
    else n.setAttribute(k, v === true ? "" : String(v));
  }
  for (const k of kids.flat()) if (k !== null && k !== undefined && k !== false) n.append(k instanceof Node ? k : document.createTextNode(String(k)));
  return n;
}
const svg = (tag, attrs = {}) => { const n = document.createElementNS(NS, tag); for (const [k, v] of Object.entries(attrs)) n.setAttribute(k, String(v)); return n; };

async function api(path, { method = "GET", body, auth = false } = {}) {
  const headers = { "content-type": "application/json" };
  if (auth) headers.Authorization = `Bearer ${getToken()}`;
  const res = await fetch(path, { method, headers, body: body ? JSON.stringify(body) : undefined, cache: "no-store" });
  let data = null;
  try { data = await res.json(); } catch { /* empty */ }
  return { ok: res.ok, status: res.status, data: data || {} };
}

const intro = () => [...root.children].slice(0, 1);

function show(...nodes) { root.replaceChildren(...intro(), ...nodes); }

// ── Passcode ─────────────────────────────────────────────────────────────

function gate(claimed, message = "") {
  const pass = el("input", { type: "password", autocomplete: claimed ? "current-password" : "new-password", minlength: "8", required: true, id: "con-pass" });
  const again = claimed ? null : el("input", { type: "password", autocomplete: "new-password", minlength: "8", required: true, id: "con-pass2" });
  const error = el("p", { class: "con-error", role: "alert", hidden: !message }, message);
  const submit = el("button", { type: "submit", class: "btn btn-primary" }, claimed ? "Open the console" : "Set passcode and open");
  const form = el("form", { class: "card con-card con-gate", onsubmit: async (e) => {
    e.preventDefault();
    error.hidden = true;
    if (pass.value.length < 8) { error.textContent = "The passcode needs at least 8 characters."; error.hidden = false; return; }
    if (!claimed && pass.value !== again.value) { error.textContent = "The two passcodes don't match."; error.hidden = false; return; }
    submit.disabled = true;
    const r = await api(claimed ? "/api/console/login" : "/api/console/claim", { method: "POST", body: { passcode: pass.value } }).catch(() => ({ ok: false, data: { error: "No connection. Try again when you're online." } }));
    submit.disabled = false;
    if (r.ok && r.data.token) { setToken(r.data.token); load(); return; }
    if (r.status === 409) { gate(true, r.data.error); return; }
    error.textContent = r.data.error || "That didn't work. Please try again.";
    error.hidden = false;
  } },
  el("p", { class: "con-note" }, claimed
    ? "Enter your console passcode."
    : "First time here: choose a passcode for your console (at least 8 characters). Only someone with this passcode can open it — keep it to yourself."),
  claimed ? el("p", { class: "con-note" }, "Forgot it, or it asks for a passcode you never set? Whoever deploys the app can reset it (CONSOLE_GENERATION in wrangler.toml); the counts are kept.") : null,
  el("label", {}, "Passcode", pass),
  again ? el("label", {}, "Type it again", again) : null,
  error, submit);
  show(form);
  pass.focus();
}

// ── Numbers ──────────────────────────────────────────────────────────────

function tile(label, value, sub = "", shown = null) {
  return el("div", { class: "card con-tile" }, el("p", { class: "con-tile-label" }, label), el("p", { class: "con-tile-value num" }, shown ?? fmt(value)), sub ? el("p", { class: "con-tile-sub" }, sub) : null);
}

/** Charts on screen, redrawn when the screen size changes (so text stays its real size on any phone). */
const charts = new Set();
let resizeTimer = 0;
window.addEventListener("resize", () => {
  clearTimeout(resizeTimer);
  resizeTimer = setTimeout(() => { for (const c of charts) c.draw(); }, 150);
});
// Finger: a tap on a bar keeps its number showing; a tap anywhere else hides it.
document.addEventListener("pointerdown", (e) => { if (e.pointerType === "touch") for (const c of charts) if (!c.box.contains(e.target)) c.hide(); });

/** A 30-day column chart for one series, with a pointer/tap/focus tooltip and a table view. */
function chart(id, title, days, key, unit) {
  const box = el("div", { class: "con-chart" });
  const tip = el("div", { class: "con-tip", hidden: true });
  const max = Math.max(1, ...days.map((d) => d[key]));
  const step = max <= 5 ? 1 : max <= 10 ? 2 : Math.ceil(max / 4 / 5) * 5;
  const top = Math.ceil(max / step) * step;
  const hide = () => { tip.hidden = true; for (const b of box.querySelectorAll(".bar.is-hover")) b.classList.remove("is-hover"); };

  function draw() {
    if (!box.isConnected) { charts.delete(entry); return; }
    // One drawing unit = one screen pixel, so the labels are a readable 11px on a phone and on a computer.
    const W = Math.max(280, Math.round(box.clientWidth || 600)), H = 190, padL = 30, padB = 22, padT = 10, n = days.length;
    const band = (W - padL) / n, bw = Math.max(2, Math.min(24, band - 2));
    const y = (v) => padT + (H - padT - padB) * (1 - v / top);
    const s = svg("svg", { viewBox: `0 0 ${W} ${H}`, width: W, height: H, role: "img", "aria-label": `${title}: last 30 days, highest ${fmt(max)} on one day` });
    for (let v = 0; v <= top; v += step) {
      s.append(svg("line", { class: "grid", x1: padL, x2: W, y1: y(v), y2: y(v) }));
      const t = svg("text", { x: padL - 6, y: y(v) + 4, "text-anchor": "end" }); t.textContent = fmt(v); s.append(t);
    }
    days.forEach((d, i) => {
      const x = padL + i * band + (band - bw) / 2, v = d[key], yy = y(v), h = Math.max(0, H - padB - yy), r = Math.min(4, h, bw / 2);
      const path = v > 0
        ? `M${x},${H - padB} V${yy + r} Q${x},${yy} ${x + r},${yy} H${x + bw - r} Q${x + bw},${yy} ${x + bw},${yy + r} V${H - padB} Z`
        : `M${x},${H - padB - 1} H${x + bw}`;
      const bar = svg("path", { class: "bar", d: path, tabindex: "0", "aria-label": `${dayText(d.day)}: ${fmt(v)} ${unit}` });
      if (v === 0) { bar.setAttribute("stroke", "var(--chart-grid)"); bar.setAttribute("stroke-width", "2"); }
      const hit = svg("rect", { x: padL + i * band, y: padT, width: band, height: H - padT - padB, fill: "transparent" });
      const showTip = () => {
        hide();
        bar.classList.add("is-hover");
        tip.replaceChildren(el("strong", {}, fmt(v)), ` ${unit} · ${dayText(d.day)}`);
        tip.hidden = false;
        const k = s.getBoundingClientRect().width / W || 1;
        tip.style.left = `${Math.min(Math.max((x + bw / 2) * k, 70), W * k - 70)}px`; // kept inside the card at the edges
        tip.style.top = `${Math.min(yy, H - padB - 2) * k}px`;
      };
      // Mouse: shows while pointing. Finger: shows on the tap and stays after the finger lifts.
      for (const t of [hit, bar]) {
        t.addEventListener("pointerenter", (e) => { if (e.pointerType !== "touch") showTip(); });
        t.addEventListener("pointerleave", (e) => { if (e.pointerType !== "touch") hide(); });
        t.addEventListener("pointerdown", (e) => { if (e.pointerType === "touch") showTip(); });
      }
      bar.addEventListener("focus", showTip);
      bar.addEventListener("blur", hide);
      s.append(bar, hit);
      if ((n - 1 - i) % 7 === 0) { // a date under today's bar and every 7 days back
        const t = svg("text", { x: x + bw / 2, y: H - 6, "text-anchor": "middle" }); t.textContent = dayText(d.day, false); s.append(t);
      }
    });
    box.replaceChildren(s, tip);
  }
  const entry = { box, draw, hide };
  charts.add(entry);

  const table = el("table", { class: "con-table", hidden: true },
    el("thead", {}, el("tr", {}, el("th", {}, "Day"), el("th", {}, unit[0].toUpperCase() + unit.slice(1)))),
    el("tbody", {}, [...days].reverse().map((d) => el("tr", {}, el("td", {}, dayText(d.day)), el("td", { class: "num" }, fmt(d[key]))))));
  const toggle = el("button", { type: "button", class: "link-btn", "aria-expanded": "false", onclick: () => {
    table.hidden = !table.hidden;
    toggle.setAttribute("aria-expanded", String(!table.hidden));
    toggle.textContent = table.hidden ? "Show as a table" : "Hide the table";
  } }, "Show as a table");
  return el("section", { class: "card con-card", "aria-labelledby": id },
    el("div", { class: "con-chart-head" }, el("h2", { id }, title), toggle), box, table);
}

// ── Buyers and their personal links ─────────────────────────────────────

const money = (cents) => (Number(cents || 0) / 100).toLocaleString("en-US", { style: "currency", currency: "USD" });
const dateText = (iso) => { const d = new Date(iso); return `${d.getDate()} ${MONTHS[d.getMonth()]} ${d.getFullYear()}`; };
const linkFor = (id) => `${location.origin}/?k=${id}`;

async function copyText(text, button) {
  try { await navigator.clipboard.writeText(text); } catch {
    const t = el("textarea", {}, text); document.body.append(t); t.select(); try { document.execCommand("copy"); } catch { /* fine */ } t.remove();
  }
  const was = button.textContent; button.textContent = "Copied"; setTimeout(() => { button.textContent = was; }, 1500);
}

function linkBox(link) {
  const input = el("input", { type: "text", readonly: true, value: link, class: "con-link", "aria-label": "Personal link", onfocus: (e) => e.target.select() });
  const copy = el("button", { type: "button", class: "btn con-copy", onclick: (e) => copyText(link, e.currentTarget) }, "Copy link");
  const share = navigator.share ? el("button", { type: "button", class: "btn btn-ghost", onclick: () => navigator.share({ title: "Marlon", text: "Your personal Marlon link", url: link }).catch(() => {}) }, "Share") : null;
  return el("div", { class: "con-linkbox" }, input, el("div", { class: "con-actions" }, copy, share));
}

/** "New buyer link": name, how many devices (1, 2, 3 or another number) and how much was paid — all needed. */
function newBuyerForm(onCreated) {
  const name = el("input", { type: "text", id: "con-buyer-name", maxlength: "80", autocomplete: "off", autocapitalize: "words", required: true });
  const kinds = [["solo", "Solo", "one business"], ["team", "Team", "a boss and sales reps"]].map(([v, label, sub]) => el("label", { class: "con-chip con-kind" },
    el("input", { type: "radio", name: "con-kind", value: v, checked: v === "solo" }), el("span", {}, label, el("small", {}, ` · ${sub}`))));
  const kind = () => kinds.map((c) => c.querySelector("input")).find((i) => i.checked)?.value || "solo";
  const devicesLegend = el("legend", {}, "How many devices is it for?");
  const choices = ["1", "2", "3", "other"].map((v) => el("label", { class: "con-chip" },
    el("input", { type: "radio", name: "con-devices", value: v }), el("span", {}, v === "other" ? "Another number" : v)));
  const other = el("input", { type: "number", id: "con-devices-other", min: "1", max: "1000", step: "1", inputmode: "numeric", placeholder: "How many?", hidden: true, "aria-label": "Number of devices" });
  const amount = el("input", { type: "text", id: "con-amount", inputmode: "decimal", autocomplete: "off", placeholder: "0.00", required: true });
  const error = el("p", { class: "con-error", role: "alert", hidden: true });
  const submit = el("button", { type: "submit", class: "btn btn-primary", disabled: true }, "Create link");
  const picked = () => choices.map((c) => c.querySelector("input")).find((i) => i.checked)?.value || "";
  const devices = () => { const v = picked(); if (v === "other") { const n = Number(other.value); return Number.isInteger(n) && n >= 1 && n <= 1000 ? n : null; } return v ? Number(v) : null; };
  const paid = () => { const t = amount.value.replace(/[$,\s]/g, ""); return /^\d+(\.\d{1,2})?$/.test(t) ? Number(t) : null; };
  const update = () => {
    devicesLegend.textContent = kind() === "team" ? "How many sales reps (rep phones)?" : "How many devices is it for?";
    other.hidden = picked() !== "other";
    other.disabled = other.hidden; // a number left in it doesn't count (or block the form) once another choice is picked
    submit.disabled = !(name.value.trim() && devices() !== null && paid() !== null);
  };
  const form = el("form", { class: "card con-card con-new", "aria-labelledby": "con-h-new", novalidate: true, oninput: update, onchange: update, onsubmit: async (e) => {
    e.preventDefault();
    update();
    if (submit.disabled) return;
    submit.disabled = true;
    error.hidden = true;
    const r = await api("/api/console/buyers", { method: "POST", auth: true, body: { name: name.value.trim(), devices: devices(), amount: paid(), kind: kind() } }).catch(() => ({ ok: false, data: { error: "No connection. Try again when you're online." } }));
    if (r.status === 401) { setToken(""); start(); return; }
    if (!r.ok) { error.textContent = r.data.error || "That didn't work. Please try again."; error.hidden = false; update(); return; }
    onCreated(r.data);
  } },
  el("h2", { id: "con-h-new" }, "New buyer link"),
  el("fieldset", { class: "con-field" }, el("legend", {}, "Solo or Team?"), el("div", { class: "con-chips" }, kinds)),
  el("label", { class: "con-field" }, "Buyer's name (for a team: the company)", name),
  el("fieldset", { class: "con-field con-devices" }, devicesLegend, el("div", { class: "con-chips" }, choices), other),
  el("label", { class: "con-field" }, "How much did they pay?", el("span", { class: "con-money" }, el("span", { "aria-hidden": "true" }, "$"), amount)),
  el("p", { class: "con-note" }, "The link works on the first phones that open it, up to this number. Any other phone is blocked and told to contact you. A team also gets a boss link for the boss's phone."),
  error, submit);
  return form;
}

const bossLinkFor = (key) => `${location.origin}/boss?b=${key}`;

/** Every rep link as one numbered message (plus the boss link), ready to send to the boss. */
function allRepLinks(company, links, bossLink) {
  const text = `Marlon for ${company}\n\nBoss link (for the boss only):\n${bossLink}\n\nRep links — one per rep, each works on one phone only:\n${links.map((l, i) => `Rep ${i + 1}: ${l}`).join("\n")}`;
  const copy = el("button", { type: "button", class: "btn btn-primary con-copy-all", onclick: (e) => copyText(text, e.currentTarget) }, `Copy all ${links.length} rep links + boss link`);
  const share = navigator.share ? el("button", { type: "button", class: "btn btn-ghost", onclick: () => navigator.share({ title: `Marlon for ${company}`, text }).catch(() => {}) }, "Share") : null;
  return el("div", { class: "con-replinks" },
    el("div", { class: "con-actions" }, copy, share),
    el("ol", { class: "con-replist" }, links.map((l, i) => el("li", { class: "con-rep-link" }, el("span", {}, `Rep ${i + 1}`), linkBox(l)))));
}

/** A team's reps: one row per rep link, with the phone that took it (if any). */
function slotList(b, refresh) {
  return el("ul", { class: "con-phones con-slots" }, b.slots.map((slot) => {
    const d = slot.phone;
    const link = `${location.origin}/?k=${slot.key}`;
    const copy = el("button", { type: "button", class: "btn btn-ghost", onclick: (e) => copyText(link, e.currentTarget) }, "Copy link");
    const replace = el("button", { type: "button", class: "btn btn-ghost con-danger", onclick: async () => {
      if (!confirm(`Replace rep ${slot.n}'s link? The old link stops working at once${d ? " and the phone on it is switched off" : ""}. Then send the new link to the rep.`)) return;
      const r = await api("/api/console/replace-rep-link", { method: "POST", auth: true, body: { id: b.id, n: slot.n } }).catch(() => ({ ok: false, data: {} }));
      if (!r.ok) { alert(r.data.error || "That didn't work. Please try again."); return; }
      refresh();
    } }, "Replace link");
    const toggle = d ? el("button", { type: "button", class: d.off ? "btn" : "btn btn-ghost con-danger", onclick: async () => {
      if (!d.off && !confirm(`Switch off ${d.repName || `rep ${slot.n}`}'s phone? It stops working the next time it's online.`)) return;
      const r = await api("/api/console/device-off", { method: "POST", auth: true, body: { id: b.id, device: d.device, off: !d.off } }).catch(() => ({ ok: false, data: {} }));
      if (!r.ok) { alert(r.data.error || "That didn't work. Please try again."); return; }
      refresh();
    } }, d.off ? "Switch on" : "Switch off") : null;
    return el("li", { class: d?.off ? "con-phone con-slot is-off" : "con-phone con-slot", "data-n": slot.n },
      el("div", {}, el("strong", {}, `Rep ${slot.n}${d ? ` · ${d.repName || "no name yet"} · ${d.label || "Device"}` : ""}`),
        el("span", { class: "con-phone-meta" }, d ? `${d.off ? "Switched off" : "Active"} · since ${dateText(d.firstAt)} · last seen ${dateText(d.lastAt)}` : "Link not opened yet")),
      el("div", { class: "con-slot-actions" }, toggle, copy, replace));
  }));
}

function phoneList(b, list, refresh, { boss = false } = {}) {
  if (!list.length) return el("p", { class: "con-note" }, boss ? "The boss hasn't opened the boss link yet." : "No phone has opened this link yet.");
  return el("ul", { class: "con-phones" }, list.map((d, i) => el("li", { class: d.off ? "con-phone is-off" : "con-phone" },
    el("div", {}, el("strong", {}, `${i + 1}. ${boss ? "Boss · " : d.repName ? `${d.repName} · ` : ""}${d.label || "Device"}`),
      el("span", { class: "con-phone-meta" }, `${d.off ? "Switched off" : "Active"} · since ${dateText(d.firstAt)} · last seen ${dateText(d.lastAt)}`)),
    el("button", { type: "button", class: d.off ? "btn" : "btn btn-ghost con-danger", onclick: async () => {
      const who = boss ? `${b.name}'s boss phone` : d.repName ? `${d.repName}'s phone` : `${b.name}'s ${d.label || "device"}`;
      if (!d.off && !confirm(`Switch off ${who}? It stops working the next time it's online${boss ? "" : ", and frees a place for another phone"}.`)) return;
      const r = await api("/api/console/device-off", { method: "POST", auth: true, body: { id: b.id, device: d.device, off: !d.off } }).catch(() => ({ ok: false, data: {} }));
      if (!r.ok) { alert(r.data.error || "That didn't work. Please try again."); return; }
      refresh();
    } }, d.off ? "Switch on" : "Switch off"))));
}

function buyerCard(b, refresh) {
  if (b.kind === "team") return teamCard(b, refresh);
  const toggleBuyer = el("button", { type: "button", class: b.off ? "btn" : "btn btn-ghost con-danger", onclick: async () => {
    if (!b.off && !confirm(`Switch off ${b.name}? All their phones stop opening Marlon the next time they're online.`)) return;
    const r = await api("/api/console/buyer-off", { method: "POST", auth: true, body: { id: b.id, off: !b.off } }).catch(() => ({ ok: false, data: {} }));
    if (!r.ok) { alert(r.data.error || "That didn't work. Please try again."); return; }
    refresh();
  } }, b.off ? "Switch buyer on again" : "Switch off whole buyer");
  const phones = b.phones.length ? el("ul", { class: "con-phones" }, b.phones.map((d, i) => el("li", { class: d.off ? "con-phone is-off" : "con-phone" },
    el("div", {}, el("strong", {}, `${i + 1}. ${d.label || "Device"}`), el("span", { class: "con-phone-meta" }, `${d.off ? "Switched off" : "Active"} · since ${dateText(d.firstAt)} · last seen ${dateText(d.lastAt)}`)),
    el("button", { type: "button", class: d.off ? "btn" : "btn btn-ghost con-danger", onclick: async () => {
      if (!d.off && !confirm(`Switch off ${b.name}'s ${d.label || "device"}? It stops opening Marlon the next time it's online, and frees a place for another phone.`)) return;
      const r = await api("/api/console/device-off", { method: "POST", auth: true, body: { id: b.id, device: d.device, off: !d.off } }).catch(() => ({ ok: false, data: {} }));
      if (!r.ok) { alert(r.data.error || "That didn't work. Please try again."); return; }
      refresh();
    } }, d.off ? "Switch on" : "Switch off")))) : el("p", { class: "con-note" }, "No phone has opened this link yet.");
  return el("article", { class: b.off ? "card con-card con-buyer is-off" : "card con-card con-buyer", dataset: { id: b.id } },
    el("div", { class: "con-buyer-head" },
      el("h3", {}, b.name, b.off ? el("span", { class: "con-badge" }, "Switched off") : null),
      el("strong", { class: "num" }, money(b.amountCents))),
    el("p", { class: "con-buyer-meta" }, `${b.active} of ${b.devices} device${b.devices === 1 ? "" : "s"} in use · created ${dateText(b.created)}`),
    phones,
    el("details", { class: "con-buyer-link" }, el("summary", {}, "Their personal link"), linkBox(linkFor(b.id))),
    el("div", { class: "con-actions" }, toggleBuyer));
}

function teamCard(b, refresh) {
  const toggle = el("button", { type: "button", class: b.off ? "btn" : "btn btn-ghost con-danger", onclick: async () => {
    if (!b.off && !confirm(`Switch off the whole company ${b.name}? The boss and every rep stop working the next time they're online.`)) return;
    const r = await api("/api/console/buyer-off", { method: "POST", auth: true, body: { id: b.id, off: !b.off } }).catch(() => ({ ok: false, data: {} }));
    if (!r.ok) { alert(r.data.error || "That didn't work. Please try again."); return; }
    refresh();
  } }, b.off ? "Switch company on again" : "Switch off whole company");
  return el("article", { class: b.off ? "card con-card con-buyer con-team is-off" : "card con-card con-buyer con-team", "data-id": b.id },
    el("div", { class: "con-buyer-head" },
      el("h3", {}, b.name, el("span", { class: "con-badge con-badge-team" }, "Team"), b.off ? el("span", { class: "con-badge" }, "Switched off") : null),
      el("strong", { class: "num" }, money(b.amountCents))),
    el("p", { class: "con-buyer-meta" }, `${b.active} of ${b.devices} rep phone${b.devices === 1 ? "" : "s"} in use · ${b.invoices} invoice${b.invoices === 1 ? "" : "s"} sent to the boss · created ${dateText(b.created)}`),
    el("h4", { class: "con-sub" }, "Boss phone"), phoneList(b, b.bossPhones, refresh, { boss: true }),
    el("h4", { class: "con-sub" }, "Reps"), b.slots.length ? slotList(b, refresh) : phoneList(b, b.phones, refresh),
    el("details", { class: "con-buyer-link" }, el("summary", {}, "Their links"),
      b.slots.length
        ? allRepLinks(b.name, b.slots.map((x) => `${location.origin}/?k=${x.key}`), bossLinkFor(b.bossKey))
        : [el("p", { class: "con-note" }, "Rep link (shared, from before personal rep links):"), linkBox(linkFor(b.id)), el("p", { class: "con-note" }, "Boss link:"), linkBox(bossLinkFor(b.bossKey))]),
    el("div", { class: "con-actions" }, toggle));
}

function contactForm(contact, refresh) {
  const input = el("input", { type: "text", id: "con-contact", maxlength: "200", value: contact || "", placeholder: "e.g. your name and WhatsApp number" });
  return el("form", { class: "card con-card", "aria-labelledby": "con-h-contact", onsubmit: async (e) => {
    e.preventDefault();
    const r = await api("/api/console/contact", { method: "POST", auth: true, body: { contact: input.value } }).catch(() => ({ ok: false, data: {} }));
    if (!r.ok) { alert(r.data.error || "That didn't work. Please try again."); return; }
    refresh();
  } },
  el("h2", { id: "con-h-contact" }, "What blocked phones are told"),
  el("p", { class: "con-note" }, "A phone without a link, with a link that's full, or switched off sees: “To get access, contact …”."),
  el("label", { class: "con-field" }, "Your contact", input),
  el("button", { type: "submit", class: "btn" }, "Save"));
}

function buyersSection(data, refresh) {
  const phonesActive = data.buyers.reduce((n, b) => n + (b.off ? 0 : b.active), 0);
  return [
    el("div", { class: "con-tiles con-tiles-3" },
      tile("Money collected", null, `from ${fmt(data.buyers.length)} buyer${data.buyers.length === 1 ? "" : "s"}`, money(data.totalCents)),
      tile("Buyers", data.buyers.length, `${fmt(data.buyers.filter((b) => b.off).length)} switched off`),
      tile("Phones active", phonesActive, "on all buyers")),
    newBuyerForm((r) => {
      refresh(r.bossLink
        ? el("div", { class: "card con-card con-created" }, el("h2", {}, `Team links for ${r.buyer.name}`),
          el("p", { class: "con-note" }, `${r.buyer.devices} sales rep${r.buyer.devices === 1 ? "" : "s"} · paid ${money(r.buyer.amountCents)}.`),
          el("h3", {}, "Boss link — for the boss only"), el("div", { class: "con-boss-link" }, linkBox(r.bossLink)),
          el("h3", {}, `${r.repLinks.length} rep links — one for each rep`),
          el("p", { class: "con-note" }, "Each link works on one phone only: the first phone that opens it. Give each rep their own link."),
          allRepLinks(r.buyer.name, r.repLinks, r.bossLink))
        : el("div", { class: "card con-card con-created" }, el("h2", {}, `Link for ${r.buyer.name}`),
          el("p", { class: "con-note" }, `${r.buyer.devices} device${r.buyer.devices === 1 ? "" : "s"} · paid ${money(r.buyer.amountCents)}. Send this link to the buyer:`), linkBox(r.link)));
    }),
    el("section", { class: "con-buyers", "aria-labelledby": "con-h-buyers" },
      el("h2", { id: "con-h-buyers" }, "Buyers"),
      data.buyers.length ? data.buyers.map((b) => buyerCard(b, () => refresh())) : el("p", { class: "con-note" }, "No buyers yet. Create a link above for each person who buys Marlon.")),
    contactForm(data.contact, () => refresh()),
  ];
}

function render(st, buyers, notice = null) {
  const used = st.last30.print + st.last30.pdf + st.last30.picture;
  charts.clear();
  const refresh = (n = null) => load(n);
  show(
    ...(notice ? [notice] : []),
    ...buyersSection(buyers, refresh),
    el("h2", { class: "con-section" }, "How the app is used (anonymous counts)"),
    el("div", { class: "con-tiles" },
      tile("Businesses set up", st.businesses, `${fmt(st.phones)} phones in all`),
      tile("Using it today", st.activeToday, "businesses"),
      tile("This week", st.active7, "businesses, last 7 days"),
      tile("This month", st.active30, "businesses, last 30 days")),
    el("div", { class: "con-tiles" },
      tile("Invoices made", st.last30.invoice, `last 30 days · ${fmt(st.totals.invoice)} in all`),
      tile("Voice entries", st.last30.voice, "last 30 days"),
      tile("Printed or shared", used, "receipts, PDFs, pictures · 30 days"),
      tile("New businesses", st.last30.setup, "set up in the last 30 days")),
    chart("con-h-active", "Businesses using Marlon each day", st.days, "active", "businesses"),
    chart("con-h-invoices", "Invoices made each day", st.days, "invoices", "invoices"),
    el("p", { class: "con-note" }, `Days are counted in UTC, up to ${dayText(st.today)}. Phones send their counts when they're online, so today can still grow. A business using two phones counts as two. Businesses can switch counting off in their settings.${st.passcodeSince ? ` Passcode set on ${dayText(st.passcodeSince)}.` : ""}`),
    el("div", { class: "con-actions" },
      el("button", { type: "button", class: "btn", onclick: () => load() }, "Refresh"),
      el("button", { type: "button", class: "btn btn-ghost", onclick: async () => { await api("/api/console/logout", { method: "POST", auth: true }).catch(() => {}); setToken(""); start(); } }, "Lock")));
  for (const c of charts) c.draw(); // now that they're on screen and have a width
}

async function load(notice = null) {
  const fail = () => ({ ok: false, status: 0, data: {} });
  const [r, b] = await Promise.all([api("/api/console/stats", { auth: true }).catch(fail), api("/api/console/buyers", { auth: true }).catch(fail)]);
  if (r.ok && b.ok) { render(r.data, b.data, notice); if (notice) window.scrollTo(0, 0); return; }
  if (r.status === 401 || b.status === 401) { setToken(""); start(); return; }
  show(el("p", { class: "con-error" }, r.data.error || "Couldn't load the numbers. Check the connection and try again."), el("button", { type: "button", class: "btn", onclick: () => load() }, "Try again"));
}

async function start() {
  if (getToken()) { load(); return; }
  const r = await api("/api/console/state").catch(() => ({ ok: false, data: {} }));
  if (!r.ok) { show(el("p", { class: "con-error" }, r.data.error || "Couldn't reach the console. Check the connection and try again.")); return; }
  gate(Boolean(r.data.claimed));
}

start();
window.__console = { ready: true };
