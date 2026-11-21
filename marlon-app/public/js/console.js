/**
 * The maker's console (/console): buyers and their personal links (devices, amount paid, switch off), the money
 * collected, and anonymous counts of how the app is used. The first visit sets the passcode;
 * after that it asks for it (5 wrong tries per 15 minutes). The session lasts 12 hours, in this tab only.
 */
import { MAX_REPS, TIER_LABELS, cleanEmail, cleanPhone, cleanReps, dueDayText, longDate, noticeLines, noticeText, proPrice, tierFor, waDigits } from "./pricing.js";
import { canvasToPdfBlob } from "./pdf.js";

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
  const phone = el("input", { type: "tel", id: "con-phone", autocomplete: "off", maxlength: "40", placeholder: "+1 876 555 0123" });
  const email = el("input", { type: "email", id: "con-email", autocomplete: "off", maxlength: "120", placeholder: "name@example.com" });
  const error = el("p", { class: "con-error", role: "alert", hidden: true });
  const tierHint = el("p", { class: "con-note con-tier-hint", hidden: true });
  const submit = el("button", { type: "submit", class: "btn btn-primary", disabled: true }, "Create link");
  const picked = () => choices.map((c) => c.querySelector("input")).find((i) => i.checked)?.value || "";
  const devices = () => { const v = picked(); if (v === "other") { const n = Number(other.value); return Number.isInteger(n) && n >= 1 && n <= 1000 ? n : null; } return v ? Number(v) : null; };
  const paid = () => { const t = amount.value.replace(/[$,\s]/g, ""); return /^\d+(\.\d{1,2})?$/.test(t) ? Number(t) : null; };
  const update = () => {
    devicesLegend.textContent = kind() === "team" ? "How many sales reps (rep phones)?" : "How many devices is it for?";
    other.hidden = picked() !== "other";
    other.disabled = other.hidden; // a number left in it doesn't count (or block the form) once another choice is picked
    const n = devices(), t = n ? tierFor(n) : null;
    tierHint.hidden = !(kind() === "team" && t);
    if (t) tierHint.textContent = t.pct ? `Team discount for ${n} reps: ${t.pct}% (${t.label}).` : `Team discount for ${n} rep${n === 1 ? "" : "s"}: none (${t.label}).`;
    submit.disabled = !(name.value.trim() && devices() !== null && paid() !== null);
  };
  const form = el("form", { class: "card con-card con-new", "aria-labelledby": "con-h-new", novalidate: true, oninput: update, onchange: update, onsubmit: async (e) => {
    e.preventDefault();
    update();
    if (submit.disabled) return;
    submit.disabled = true;
    error.hidden = true;
    const bad = cleanPhone(phone.value).error || cleanEmail(email.value).error;
    if (bad) { error.textContent = bad; error.hidden = false; update(); return; }
    const r = await api("/api/console/buyers", { method: "POST", auth: true, body: { name: name.value.trim(), devices: devices(), amount: paid(), kind: kind(), phone: phone.value, email: email.value } }).catch(() => ({ ok: false, data: { error: "No connection. Try again when you're online." } }));
    if (r.status === 401) { setToken(""); start(); return; }
    if (!r.ok) { error.textContent = r.data.error || "That didn't work. Please try again."; error.hidden = false; update(); return; }
    onCreated(r.data);
  } },
  el("h2", { id: "con-h-new" }, "New buyer link"),
  el("fieldset", { class: "con-field" }, el("legend", {}, "Solo or Team?"), el("div", { class: "con-chips" }, kinds)),
  el("label", { class: "con-field" }, "Buyer's name (for a team: the company)", name),
  el("fieldset", { class: "con-field con-devices" }, devicesLegend, el("div", { class: "con-chips" }, choices), other, tierHint),
  el("label", { class: "con-field" }, "How much did they pay?", el("span", { class: "con-money" }, el("span", { "aria-hidden": "true" }, "$"), amount)),
  el("label", { class: "con-field" }, el("span", {}, "Their phone ", el("small", {}, "(optional, with country code, for WhatsApp)")), phone),
  el("label", { class: "con-field" }, el("span", {}, "Their email ", el("small", {}, "(optional)")), email),
  el("p", { class: "con-note" }, "The link works on the first phones that open it, up to this number. Any other phone is blocked and told to contact you. A team also gets a boss link for the boss's phone."),
  error, submit);
  return form;
}

const bossLinkFor = (key) => `${location.origin}/boss?b=${key}`;

/** "Delete": removes a buyer or team completely (after "Are you sure?"); its links stop working. */
function deleteButton(b, refresh) {
  const team = b.kind === "team";
  return el("button", { type: "button", class: "btn btn-ghost con-danger con-delete", onclick: async () => {
    const what = team
      ? `the team ${b.name}: its boss link, all ${b.devices} rep links, every phone and all ${b.invoices} invoice${b.invoices === 1 ? "" : "s"} sent to the boss`
      : `${b.name}: its link and every phone on it`;
    if (!confirm(`Are you sure?\n\nDelete ${what}.\n\nThe links stop working and any phone using them is blocked the next time it's online. ${money(b.amountCents)} comes off Money collected. This can't be undone.`)) return;
    const r = await api("/api/console/delete-buyer", { method: "POST", auth: true, body: { id: b.id } }).catch(() => ({ ok: false, data: {} }));
    if (!r.ok) { alert(r.data.error || "That didn't work. Please try again."); return; }
    refresh();
  } }, team ? "Delete team" : "Delete buyer");
}

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
      el("div", {}, el("strong", {}, `Rep ${slot.n}${d ? ` · ${d.repName || slot.name || "no name yet"} · ${d.label || "Device"}` : slot.name ? ` · ${slot.name}` : ""}`),
        el("span", { class: "con-phone-meta" }, d ? `${d.off ? "Switched off" : "Active"} · since ${dateText(d.firstAt)} · last seen ${dateText(d.lastAt)}` : slot.name ? "Added by the boss · link not opened yet" : "Link not opened yet")),
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

// ── Pro payment notices: shown to the maker only; sent to the customer only by tapping WhatsApp, PDF or email ──

const localToday = () => { const d = new Date(); return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`; };
const withTerms = (n) => ({ ...n, termsUrl: `${location.origin}/terms` });
const subjectFor = (n) => `Marlon Pro: your monthly payment (${n.company})`;

/** The company's saved payment notices, newest first, each with "Send again"; and a new one at today's price. */
function noticesList(b, refresh) {
  const list = b.notices || [];
  const make = el("button", { type: "button", class: "btn btn-ghost con-notice-new", onclick: async () => {
    const r = await api("/api/console/pro-notice", { method: "POST", auth: true, body: { id: b.id, startDate: localToday() } }).catch(() => ({ ok: false, data: {} }));
    if (!r.ok) { alert(r.data.error || "That didn't work. Please try again."); return; }
    showNotice(r.data.notice, b);
    refresh();
  } }, "New payment notice at today's price");
  return el("details", { class: "con-notices", open: list.length ? null : true },
    el("summary", {}, `Payment notices (${list.length})`),
    list.length ? el("ul", { class: "con-notice-list" }, list.map((n) => el("li", {},
      el("div", {}, el("strong", { class: "num" }, money(n.price.netCents)), el("span", { class: "con-phone-meta" }, `a month · starts ${longDate(n.startDate)} · made ${dateText(n.created)}`)),
      el("button", { type: "button", class: "btn con-notice-again", onclick: () => showNotice(n, b) }, "Send again")))) : el("p", { class: "con-note" }, "None yet."),
    make);
}

/** The pop-up (this console only): the message, the breakdown, and buttons to send it by WhatsApp, as a PDF or by email. */
function showNotice(notice, buyer = {}) {
  const n = withTerms(notice);
  const to = { phone: buyer.phone || "", email: buyer.email || "" }; // the company's current details fill in WhatsApp and email
  const text = noticeText(n);
  const p = n.price;
  const dlg = el("dialog", { class: "con-notice", "aria-labelledby": "con-notice-title" });
  const close = () => { dlg.close(); dlg.remove(); };
  const status = el("p", { class: "con-note con-notice-status", role: "status" });
  const wa = el("a", { class: "btn btn-primary con-send-wa", href: `https://wa.me/${waDigits(to.phone)}?text=${encodeURIComponent(text)}`, target: "_blank", rel: "noopener" }, to.phone ? `Send by WhatsApp to ${to.phone}` : "Send by WhatsApp");
  const mail = el("a", { class: "btn con-send-email", href: `mailto:${encodeURIComponent(to.email).replace(/%40/g, "@")}?subject=${encodeURIComponent(subjectFor(n))}&body=${encodeURIComponent(text)}` }, to.email ? `Send by email to ${to.email}` : "Send by email");
  const toLine = el("p", { class: "con-notice-to" },
    to.phone || to.email ? ["To: ", [to.phone, to.email].filter(Boolean).join(" · ")] : "No phone or email saved for this company: WhatsApp and email will ask who to send it to. Add them under “Contact” on its card.");
  const pdf = el("button", { type: "button", class: "btn con-send-pdf", onclick: async () => {
    pdf.disabled = true;
    try { const r = await sharePdf(n); status.textContent = r === "shared" ? "PDF shared." : r === "cancelled" ? "" : "PDF saved to your downloads. Attach it to a message to the customer."; }
    catch (e) { console.error(e); status.textContent = "Couldn't make the PDF. Please try again."; }
    pdf.disabled = false;
  } }, "Send as PDF");
  const copy = el("button", { type: "button", class: "btn btn-ghost con-notice-copy", onclick: (e) => copyText(text, e.currentTarget) }, "Copy text");
  dlg.append(
    el("div", { class: "con-notice-head" }, el("p", { class: "con-notice-kicker" }, "Payment notice · only you see this"), el("h2", { id: "con-notice-title" }, n.company)),
    el("div", { class: "con-notice-body" },
      el("p", { class: "con-notice-lead" }, `${n.company}: your monthly payment for Marlon Pro (owner dashboard plus ${p.reps} rep${p.reps === 1 ? "" : "s"}) is `, el("strong", {}, money(p.netCents)),
        `. Payment starts on ${longDate(n.startDate)} and is due on ${dueDayText(n.startDate)}.`),
      el("table", { class: "con-notice-table" },
        el("tbody", {}, noticeLines(n).map(([a, v]) => el("tr", {}, el("td", {}, a), el("td", { class: "num" }, v)))),
        el("tfoot", {}, el("tr", {}, el("th", {}, "Monthly total"), el("td", { class: "num" }, money(p.netCents))))),
      el("p", { class: "con-note" }, `Nothing is sent until you tap a button. ${to.phone && to.email ? "WhatsApp and email open with the customer and the message filled in." : "WhatsApp and email open with the message ready" + (to.phone || to.email ? "; the customer is filled in where saved." : ": choose the customer there.")}`),
      toLine,
      el("div", { class: "con-notice-actions" }, wa, pdf, mail, copy),
      status),
    el("button", { type: "button", class: "btn btn-ghost con-notice-close", onclick: close }, "Close"));
  dlg.addEventListener("cancel", (e) => { e.preventDefault(); close(); });
  document.body.append(dlg);
  dlg.showModal();
  return dlg;
}

/** One letter page: the company, the monthly payment, the breakdown, the start and due date. */
async function sharePdf(n) {
  const W = 1275, H = 1650, m = 100, c = document.createElement("canvas");
  c.width = W; c.height = H;
  const x = c.getContext("2d");
  x.fillStyle = "#fff"; x.fillRect(0, 0, W, H);
  const SANS = '-apple-system, BlinkMacSystemFont, "Helvetica Neue", Helvetica, Arial, sans-serif';
  const t = (str, size, px, py, { weight = 400, align = "left", color = "#111" } = {}) => { x.font = `${weight} ${size}px ${SANS}`; x.fillStyle = color; x.textAlign = align; x.fillText(String(str), px, py); };
  const wrap = (str, size, maxW, weight = 400) => { x.font = `${weight} ${size}px ${SANS}`; const out = []; let line = ""; for (const w of str.split(" ")) { const tryL = line ? `${line} ${w}` : w; if (x.measureText(tryL).width > maxW && line) { out.push(line); line = w; } else line = tryL; } if (line) out.push(line); return out; };
  const p = n.price;
  x.fillStyle = "#0f1411"; x.fillRect(0, 0, W, 150);
  t("Marlon Pro", 46, m, 95, { weight: 800, color: "#f3efe4" });
  t("PAYMENT NOTICE", 22, W - m, 92, { weight: 800, color: "#6cc495", align: "right" });
  let y = 240;
  t(n.company, 42, m, y, { weight: 800 }); y += 70;
  for (const l of wrap(`Your monthly payment for Marlon Pro (owner dashboard plus ${p.reps} rep${p.reps === 1 ? "" : "s"}) is ${money(p.netCents)}.`, 30, W - 2 * m)) { t(l, 30, m, y); y += 44; }
  for (const l of wrap(`Payment starts on ${longDate(n.startDate)} and is due on ${dueDayText(n.startDate)}.`, 30, W - 2 * m)) { t(l, 30, m, y); y += 44; }
  y += 40;
  x.fillStyle = "#f1f1f1"; x.fillRect(m, y, W - 2 * m, 56);
  t("PRICE BREAKDOWN", 20, m + 16, y + 37, { weight: 700, color: "#555" });
  t("PER MONTH", 20, W - m - 16, y + 37, { weight: 700, color: "#555", align: "right" });
  y += 56;
  for (const [a, v] of noticeLines(n)) { y += 54; t(a, 28, m + 16, y); t(v, 28, W - m - 16, y, { align: "right" }); y += 18; x.fillStyle = "#ddd"; x.fillRect(m, y, W - 2 * m, 2); }
  y += 74;
  t("Monthly total", 34, m + 16, y, { weight: 800 });
  t(money(p.netCents), 44, W - m - 16, y, { weight: 800, color: "#17633f", align: "right" });
  y += 90;
  t(`Terms and conditions: ${n.termsUrl}`, 22, m, y, { color: "#555" });
  const blob = await canvasToPdfBlob(c, { page: { w: 612, h: 792 }, title: `Marlon Pro payment notice · ${n.company}` });
  const file = new File([blob], `marlon-pro-payment-${n.company.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "") || "notice"}.pdf`, { type: "application/pdf" });
  if (navigator.canShare?.({ files: [file] })) {
    try { await navigator.share({ files: [file], title: subjectFor(n), text: `Marlon Pro payment notice for ${n.company}` }); return "shared"; } catch (e) { if (e?.name === "AbortError") return "cancelled"; }
  }
  const url = URL.createObjectURL(file);
  const a = el("a", { href: url, download: file.name, style: "display:none" });
  document.body.append(a); a.click(); a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 60000);
  return "downloaded";
}

// ── The customer's edit page (#buyer/<id>): tap any buyer card to open it ─────────────────────────────────────

const openBuyer = (id) => { location.hash = `#buyer/${id}`; };
/** The whole card opens the customer's page, except taps on its own buttons, links and fields. */
function tappable(b, card) {
  card.classList.add("is-tappable");
  card.addEventListener("click", (e) => {
    if (e.target.closest("button, a, input, select, textarea, summary, details, label, .con-link")) return;
    openBuyer(b.id);
  });
  card.querySelector(".con-buyer-head")?.append(el("button", { type: "button", class: "btn con-edit", "aria-label": `Edit ${b.name}`, onclick: () => openBuyer(b.id) }, "Edit ›"));
  return card;
}
/** On the card: contact and Pro at a glance (they're changed on the customer's page). */
function cardSummary(b) {
  return el("div", { class: "con-summary" },
    el("p", {}, el("strong", {}, "Contact: "), b.phone || b.email ? [b.phone, b.email].filter(Boolean).join(" · ") : el("span", { class: "con-muted" }, "none saved")),
    el("p", {}, el("strong", {}, "Marlon Pro: "), b.pro ? `on · ${b.proReps} rep${b.proReps === 1 ? "" : "s"} · ${money(b.proMonthlyCents)} a month` : el("span", { class: "con-muted" }, "off")),
    el("p", { class: "con-products" }, el("strong", {}, "My Products: "), `${b.productCount || 0} product${b.productCount === 1 ? "" : "s"}`, b.pro ? null : el("span", { class: "con-muted" }, " (Pro feature)")),
    el("button", { type: "button", class: "btn btn-primary btn-block con-edit-big", onclick: () => openBuyer(b.id) }, "Edit customer ›"));
}

/** Name, phone, email (Contact, at the top), then Marlon Pro (on/off, reps, special deal, the monthly total), one Save. */
function editPage(b, back) {
  const field = (label, input, hint = null) => el("label", { class: "con-field" }, el("span", {}, label, hint ? el("small", {}, ` ${hint}`) : null), input);
  const name = el("input", { type: "text", id: "ed-name", maxlength: "80", autocomplete: "off", autocapitalize: "words", value: b.name });
  const phone = el("input", { type: "tel", id: "ed-phone", maxlength: "40", autocomplete: "off", placeholder: "+1 876 555 0123", value: b.phone || "" });
  const email = el("input", { type: "email", id: "ed-email", maxlength: "120", autocomplete: "off", placeholder: "name@example.com", value: b.email || "" });
  const pro = el("input", { type: "checkbox", id: "ed-pro", role: "switch", checked: b.pro || null });
  const reps = el("input", { type: "number", id: "ed-reps", inputmode: "numeric", min: "1", max: String(MAX_REPS), step: "1", value: String(b.proReps || (b.kind === "team" ? b.devices : 1)) });
  const deal = el("input", { type: "number", id: "ed-deal", inputmode: "decimal", min: "0", max: "100", step: "0.5", value: String(b.discountPct || 0) });
  const repsLabel = el("span", {}, "Reps");
  const switchText = el("span", { class: "ed-switch-text" }, b.pro ? "On" : "Off");
  const lines = el("ul", { class: "con-pro-lines num", "aria-live": "polite" });
  const total = el("p", { class: "con-pro-price num" });
  const proFields = el("div", { class: "ed-pro-fields" }, el("label", { class: "con-field" }, repsLabel, reps), field("Special deal %", deal, "(optional, on top of the team discount)"), lines, total);
  const msg = el("p", { class: "con-error ed-error", role: "alert", hidden: true });
  const save = el("button", { type: "submit", class: "btn btn-primary btn-block btn-tall ed-save" }, "Save");
  const errorAt = (input, text) => { msg.textContent = text; msg.hidden = false; for (const x of [name, phone, email, reps, deal]) x.classList.toggle("is-wrong", x === input); input?.focus(); };
  const show = () => {
    proFields.hidden = !pro.checked;
    switchText.textContent = pro.checked ? "On" : "Off";
    repsLabel.textContent = pro.checked && !b.pro ? "How many reps do they have?" : "Reps";
    const r = cleanReps(reps.value), d = Number(deal.value || 0);
    if (!pro.checked) return;
    if (r === null || !Number.isFinite(d) || d < 0 || d > 100) { lines.replaceChildren(); total.textContent = r === null ? "Type how many reps they have (1 or more)." : "The special deal must be between 0 and 100 %."; return; }
    const pp = proPrice(r, d);
    lines.replaceChildren(...noticeLines({ price: pp }).map(([a, v]) => el("li", {}, el("span", {}, a), el("span", {}, v))));
    total.replaceChildren(el("span", {}, "Monthly total"), el("strong", {}, money(pp.netCents)));
  };
  pro.addEventListener("change", () => { show(); if (pro.checked && !b.pro) { reps.focus(); reps.select(); } });
  reps.addEventListener("input", show);
  deal.addEventListener("input", show);
  const form = el("form", { class: "ed-form", novalidate: true, onsubmit: async (e) => {
    e.preventDefault();
    msg.hidden = true;
    for (const x of [name, phone, email, reps, deal]) x.classList.remove("is-wrong");
    if (!name.value.trim()) return errorAt(name, "Type the customer's name.");
    const ph = cleanPhone(phone.value), em = cleanEmail(email.value);
    if (ph.error) return errorAt(phone, ph.error);
    if (em.error) return errorAt(email, em.error);
    const r = cleanReps(reps.value), d = Number(deal.value || 0);
    if (pro.checked && r === null) return errorAt(reps, "Type how many reps they have: a whole number, 1 or more.");
    if (!Number.isFinite(d) || d < 0 || d > 100) return errorAt(deal, "The special deal must be between 0 and 100 %.");
    const turningOn = pro.checked && !b.pro, turningOff = !pro.checked && b.pro;
    if (turningOn) {
      const pp = proPrice(r, d);
      if (!confirm(`Switch Marlon Pro on for ${name.value.trim()}?\n\n${noticeLines({ price: pp }).map(([a, v]) => `${a}: ${v}`).join("\n")}\nMonthly total: ${money(pp.netCents)}\n\nTheir phones${b.kind === "team" ? " and boss dashboard" : ""} show the Pro features the next time they're online.`)) return;
    }
    if (turningOff && !confirm(`Switch Marlon Pro off for ${name.value.trim()}?\n\nThe Pro features disappear from their phones the next time they're online. Their invoices, returns and credit notes are kept.`)) return;
    save.disabled = true;
    save.textContent = "Saving…";
    const res = await api("/api/console/buyer-update", { method: "POST", auth: true, body: { id: b.id, name: name.value, phone: phone.value, email: email.value, pro: pro.checked, reps: pro.checked ? r : (cleanReps(reps.value) ?? null), discountPct: d, startDate: localToday() } })
      .catch(() => ({ ok: false, data: { error: "No connection. Try again when you're online." } }));
    save.disabled = false;
    save.textContent = "Save";
    if (!res.ok) { const at = { name, phone, email, reps, deal }[res.data.field] || null; return errorAt(at, res.data.error || "That didn't work. Please try again."); }
    await back({ stay: b.id, saved: true });
    if (res.data.notice) showNotice(res.data.notice, res.data.buyer); // switched on just now: the payment notice, on this console only
  } },
  el("section", { class: "card con-card ed-section", "aria-labelledby": "ed-h-contact" },
    el("h2", { id: "ed-h-contact" }, "Contact"),
    field(b.kind === "team" ? "Company name" : "Customer's name", name),
    field("Phone", phone, "(start with + and the country code, for WhatsApp)"),
    field("Email", email),
    b.kind === "team" ? el("p", { class: "con-note" }, "A new name shows on the boss dashboard and on rep phones set up from now on. Rep phones already set up keep the name they started with.") : null),
  el("section", { class: "card con-card ed-section", "aria-labelledby": "ed-h-pro" },
    el("div", { class: "ed-pro-head" },
      el("h2", { id: "ed-h-pro" }, "Marlon Pro"),
      el("label", { class: "ed-switch" }, pro, el("span", { class: "ed-switch-track", "aria-hidden": "true" }), switchText)),
    el("p", { class: "con-note" }, "$25 per rep a month, minus the automatic team discount for that many reps, then any special deal."),
    proFields,
    b.pro ? noticesList(b, () => back({ stay: b.id })) : null),
  el("div", { class: "ed-savebar" }, msg, save));
  show();
  return el("div", { class: "ed-page", dataset: { id: b.id } },
    el("button", { type: "button", class: "btn btn-ghost ed-back", onclick: () => back() }, "‹ All buyers"),
    el("div", { class: "ed-title" }, el("h1", {}, b.name), el("span", { class: b.kind === "team" ? "con-badge con-badge-team" : "con-badge con-badge-off" }, b.kind === "team" ? "Team" : "Solo"),
      b.pro ? el("span", { class: "con-badge con-badge-pro" }, "Pro") : null),
    el("p", { class: "con-note" }, `${b.kind === "team" ? `${b.devices} rep place${b.devices === 1 ? "" : "s"}` : `${b.devices} device${b.devices === 1 ? "" : "s"}`} · paid ${money(b.amountCents)} · created ${dateText(b.created)}`),
    form);
}

/** The automatic team discounts (plain Marlon and Marlon Pro use the same table). */
function tiersCard(tiers) {
  return el("section", { class: "card con-card con-tiers", "aria-labelledby": "con-h-tiers" },
    el("h2", { id: "con-h-tiers" }, "Team discounts"),
    el("p", { class: "con-note" }, "Applied automatically by number of reps, for plain Marlon and Marlon Pro. A special deal % is applied on top."),
    el("table", { class: "con-tier-table" }, el("tbody", {}, (tiers || TIER_LABELS).map((t) => el("tr", {}, el("td", {}, t.label), el("td", { class: "num" }, t.pct ? `${t.pct}% off` : "No discount"))))));
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
  return tappable(b, el("article", { class: b.off ? "card con-card con-buyer is-off" : "card con-card con-buyer", dataset: { id: b.id } },
    el("div", { class: "con-buyer-head" },
      el("h3", {}, b.name, b.pro ? el("span", { class: "con-badge con-badge-pro" }, "Pro") : null, b.off ? el("span", { class: "con-badge" }, "Switched off") : null),
      el("strong", { class: "num" }, money(b.amountCents))),
    el("p", { class: "con-buyer-meta" }, `${b.active} of ${b.devices} device${b.devices === 1 ? "" : "s"} in use · created ${dateText(b.created)}`),
    phones,
    cardSummary(b),
    el("details", { class: "con-buyer-link" }, el("summary", {}, "Their personal link"), linkBox(linkFor(b.id))),
    el("div", { class: "con-actions" }, toggleBuyer, deleteButton(b, refresh))));
}

function teamCard(b, refresh) {
  const toggle = el("button", { type: "button", class: b.off ? "btn" : "btn btn-ghost con-danger", onclick: async () => {
    if (!b.off && !confirm(`Switch off the whole company ${b.name}? The boss and every rep stop working the next time they're online.`)) return;
    const r = await api("/api/console/buyer-off", { method: "POST", auth: true, body: { id: b.id, off: !b.off } }).catch(() => ({ ok: false, data: {} }));
    if (!r.ok) { alert(r.data.error || "That didn't work. Please try again."); return; }
    refresh();
  } }, b.off ? "Switch company on again" : "Switch off whole company");
  return tappable(b, el("article", { class: b.off ? "card con-card con-buyer con-team is-off" : "card con-card con-buyer con-team", "data-id": b.id },
    el("div", { class: "con-buyer-head" },
      el("h3", {}, b.name, el("span", { class: "con-badge con-badge-team" }, "Team"), b.pro ? el("span", { class: "con-badge con-badge-pro" }, "Pro") : null, b.off ? el("span", { class: "con-badge" }, "Switched off") : null),
      el("strong", { class: "num" }, money(b.amountCents))),
    el("p", { class: "con-buyer-meta" }, `${b.active} of ${b.devices} rep phone${b.devices === 1 ? "" : "s"} in use · ${b.invoices} invoice${b.invoices === 1 ? "" : "s"} sent to the boss · created ${dateText(b.created)}`),
    el("h4", { class: "con-sub" }, "Boss phone"), phoneList(b, b.bossPhones, refresh, { boss: true }),
    el("h4", { class: "con-sub" }, "Reps"), b.slots.length ? slotList(b, refresh) : phoneList(b, b.phones, refresh),
    cardSummary(b),
    el("details", { class: "con-buyer-link" }, el("summary", {}, "Their links"),
      b.slots.length
        ? allRepLinks(b.name, b.slots.map((x) => `${location.origin}/?k=${x.key}`), bossLinkFor(b.bossKey))
        : [el("p", { class: "con-note" }, "Rep link (shared, from before personal rep links):"), linkBox(linkFor(b.id)), el("p", { class: "con-note" }, "Boss link:"), linkBox(bossLinkFor(b.bossKey))]),
    el("div", { class: "con-actions" }, toggle, deleteButton(b, refresh))));
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
    el("div", { class: "con-tiles con-tiles-3" },
      tile("Pro each month", null, `${fmt(data.buyers.filter((b) => b.pro && !b.off).length)} compan${data.buyers.filter((b) => b.pro && !b.off).length === 1 ? "y" : "ies"} with Pro on (after discounts)`, money(data.proMonthlyCents || 0))),
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
    tiersCard(data.teamTiers),
    paySection(),
    contactForm(data.contact, () => refresh()),
    el("p", { class: "con-note con-terms" }, el("a", { href: "/terms", target: "_blank", rel: "noopener" }, "Marlon terms and conditions (with the Marlon Pro section)")),
  ];
}

// ── Marlon Pay (the store-side app): every store, paid or unpaid, counts and problems — never names or amounts ──
const PAY_PROBLEMS = {
  "other-device": "A second device tried to open a link that's already in use",
  "staff-off": "A switched-off staff link tried to work",
  "store-off": "Someone tried to use the store while it's switched off",
  "changed-record": "A device sent a changed copy of a signed record (refused, the original kept)",
};
function paySection() {
  const box = el("section", { class: "con-pay", id: "con-pay", "aria-labelledby": "con-h-pay" }, el("h2", { id: "con-h-pay" }, "Marlon Pay stores"), el("p", { class: "con-note" }, "Loading…"));
  const name = el("input", { type: "text", id: "pay-name", maxlength: "80", autocomplete: "off", autocapitalize: "words", placeholder: "e.g. Hill Top Grocery" });
  const places = el("input", { type: "number", id: "pay-places", min: "0", max: "50", step: "1", inputmode: "numeric", value: "2" });
  const msg = el("p", { class: "con-error", role: "alert", hidden: true });
  let created = null;
  async function draw() {
    const r = await api("/api/console/pay", { auth: true }).catch(() => ({ ok: false, data: {} }));
    const d = r.data || {};
    if (!r.ok || !d.connected) {
      box.replaceChildren(el("h2", { id: "con-h-pay" }, "Marlon Pay stores"), el("p", { class: "con-note", id: "pay-off" }, d.error || "Marlon Pay isn't connected yet."));
      return;
    }
    const card = (st) => {
      const toggle = (label, on, change) => el("button", { type: "button", class: `btn btn-small ${on ? "is-on" : ""}`, "aria-pressed": String(on), onclick: async (e) => {
        e.currentTarget.disabled = true;
        const x = await api("/api/console/pay/set", { method: "POST", auth: true, body: { id: st.id, ...change } }).catch(() => null);
        if (!x?.ok) { msg.textContent = x?.data?.error || "That didn't work."; msg.hidden = false; }
        draw();
      } }, label);
      return el("article", { class: `card con-card con-pay-store${st.off ? " is-off" : ""}`, "data-id": st.id },
        el("div", { class: "con-buyer-head" }, el("h3", {}, st.name),
          el("span", { class: `con-badge ${st.paid ? "con-badge-pro" : "con-badge-off"} pay-paid-badge` }, st.paid ? "Paid" : "Unpaid"), st.off ? el("span", { class: "con-badge con-badge-off" }, "Switched off") : null),
        el("p", { class: "con-note" }, `Since ${dayText(st.created.slice(0, 10), false)} · ${st.devices} device${st.devices === 1 ? "" : "s"} in use · ${st.staffNamed} of ${st.places} staff place${st.places === 1 ? "" : "s"} named${st.lastActive ? ` · last active ${dayText(st.lastActive.slice(0, 10), false)}` : ""}`),
        el("dl", { class: "con-pay-counts" },
          el("dt", {}, "Suppliers"), el("dd", {}, String(st.suppliers)),
          el("dt", {}, "Payments signed"), el("dd", {}, `${st.payouts} in all · ${st.payouts30} in 30 days`),
          el("dt", {}, "Problems"), el("dd", { class: st.problems30 ? "con-pay-has-problems" : "" }, st.problems30 ? `${st.problems30} in 30 days` : "None")),
        st.problems.length ? el("details", { class: "con-pay-problems" }, el("summary", {}, "Latest problems"),
          el("ul", {}, st.problems.map((p) => el("li", {}, el("strong", {}, `${dayText(p.at.slice(0, 10), false)}: `), PAY_PROBLEMS[p.kind] || p.kind, p.detail ? ` (${p.detail})` : "")))) : null,
        el("details", { class: "con-buyer-link" }, el("summary", {}, "Owner link"), linkBox(st.ownerLink)),
        el("div", { class: "con-actions" },
          toggle(st.paid ? "Mark unpaid" : "Mark paid", st.paid, { paid: !st.paid }),
          toggle(st.off ? "Switch store on" : "Switch store off", st.off, { off: !st.off })));
    };
    box.replaceChildren(...[ // (flattened and without empty values: replaceChildren would print them)
      el("h2", { id: "con-h-pay" }, "Marlon Pay stores"),
      el("p", { class: "con-note" }, "Stores using Marlon Pay, the signed cash-payout book. You see counts and problems only: each store's suppliers, amounts and signatures stay private to that store."),
      el("form", { class: "card con-card con-pay-new", onsubmit: async (e) => {
        e.preventDefault(); msg.hidden = true;
        const x = await api("/api/console/pay", { method: "POST", auth: true, body: { name: name.value, places: Number(places.value) } }).catch(() => null);
        if (!x?.ok) { msg.textContent = x?.data?.error || "That didn't work."; msg.hidden = false; return; }
        created = x.data.store; name.value = ""; draw();
      } },
        el("h3", {}, "New Marlon Pay store"),
        el("label", { class: "con-field" }, el("span", {}, "Store name"), name),
        el("label", { class: "con-field" }, el("span", {}, "Staff places (links for staff, besides the owner)"), places),
        msg, el("button", { type: "submit", class: "btn btn-primary", id: "pay-create" }, "Create store and owner link")),
      created ? el("div", { class: "card con-card con-created", id: "pay-created" }, el("h3", {}, `Owner link for ${created.name}`),
        el("p", { class: "con-note" }, "Send this to the store owner. It works on the first device that opens it. The owner adds staff and sends their links from Marlon Pay."), linkBox(created.ownerLink)) : null,
      d.stores.length ? d.stores.map(card) : el("p", { class: "con-note" }, "No Marlon Pay stores yet.")].flat().filter(Boolean));
  }
  draw();
  return box;
}

let lastStats = null, lastBuyers = null;
const buyerFromHash = () => (/^#buyer\/([0-9a-f]{32})$/.exec(location.hash) || [])[1] || null;
window.addEventListener("hashchange", () => { if (lastStats && lastBuyers) render(lastStats, lastBuyers); });

function render(st, buyers, notice = null) {
  lastStats = st; lastBuyers = buyers;
  const editing = buyerFromHash() && buyers.buyers.find((x) => x.id === buyerFromHash());
  if (editing) {
    const back = async ({ stay = null, saved = false } = {}) => {
      if (stay) {
        const b = await api("/api/console/buyers", { auth: true }).catch(() => ({ ok: false }));
        if (b.ok) { lastBuyers = b.data; render(st, b.data, saved ? el("div", { class: "card con-card con-saved", role: "status" }, "Saved.") : null); }
        return;
      }
      history.replaceState(null, "", location.pathname + location.search);
      render(st, lastBuyers);
      document.querySelector(`.con-buyer[data-id="${editing.id}"]`)?.scrollIntoView({ block: "center" });
    };
    show(...(notice ? [notice] : []), editPage(editing, back));
    window.scrollTo(0, 0);
    return;
  }
  if (buyerFromHash()) history.replaceState(null, "", location.pathname + location.search); // that customer isn't here (deleted)
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
