/**
 * Private owner dashboard: PIN lock, totals, invoice history and settings.
 *
 * Renders into <section id="dashboard"> of index.html. app.js calls initDashboard() once, then
 * showDashboard() / hideDashboard() as the "#/owner" route opens and closes.
 * Everything is read from db.js on this phone. Stored text is only ever rendered with h() / textContent.
 */
import {
  eraseEverything, exportBackup, importBackup, invoices, products, requestPersistence, settings, storageStatus,
} from "./db.js";
import {
  SELLER, h, invoiceNo, money, monthLabel, parseISODate, prettyDate, qtyText, storeKey, tidy, toCents, todayISO,
  weekStartISO, withTotals,
} from "./util.js";
import { choiceSheet, confirmSheet, toast } from "./ui.js";
import { qrCanvas } from "./qr.js";
import { invoiceToUrl } from "./codec.js";
import { forgetPrinter, printInvoice, savedPrinterName } from "./printer.js";
import { shareInvoicePdf } from "./share.js";

const UNLOCK_MS = 5 * 60 * 1000;       // stays unlocked this long after the last dashboard activity
const PIN_ITERATIONS = 210000;         // PBKDF2-SHA-256 rounds for new PINs
const FREE_TRIES = 5;                  // wrong PINs allowed before the first wait…
const FIRST_WAIT_MS = 30 * 1000;       // …which lasts 30 s and doubles after each further wrong PIN…
const MAX_WAIT_MS = 60 * 60 * 1000;    // …up to an hour
const HISTORY_PAGE = 50;               // history rows added per "Show more"
const TOP_ROWS = 5;                    // rows in Top stores / Products sold before "Show all"
const MAX_MONTHS = 12;
const NOTICE_SEEN_KEY = "dashboard.pinResetNoticeSeen";   // localStorage: the pinResetAt already acknowledged

const TABS = [["overview", "Overview"], ["history", "History"], ["settings", "Settings"]];
const FILTERS = [["all", "All"], ["month", "This month"], ["unsigned", "Not signed"]];
const RANGES = [["month", "This month"], ["all", "All time"]];
const KEYS = [["1", ""], ["2", "ABC"], ["3", "DEF"], ["4", "GHI"], ["5", "JKL"], ["6", "MNO"], ["7", "PQRS"], ["8", "TUV"], ["9", "WXYZ"]];

let root = null;
let hooks = {};
let visible = false;
let idleTimer = 0;
let countdownTimer = 0;
let segmentCount = 0;

/** Lock state lives only in memory, so reopening the app always asks for the PIN again. */
const gate = { unlocked: false, lastActivity: 0, session: 0, failures: 0, waitUntil: 0 };
/** The keypad screen. mode: "unlock" | "verify" (current PIN before a change) | "create" | "confirm". */
const pad = { mode: "unlock", purpose: "", entry: "", first: "", len: 0, note: "", error: false, busy: false };
/** Where the owner is in the dashboard; kept while the app stays open. */
const view = {
  tab: "overview", detailId: null, listScroll: 0, query: "", filter: "all", shown: HISTORY_PAGE,
  storeRange: "month", productRange: "month", storesAll: false, productsAll: false,
  openProduct: null, renaming: null, removedOpen: false,
};
let data = { invoices: [], products: [], paper: 58, pinResetAt: null };
/** Live elements that are updated in place. */
const ui = {};

// ── Public API ───────────────────────────────────────────────────────────

/** Mounts the dashboard (hidden). hooks: { openInvoice(id), duplicateInvoice(id), newInvoice(), onProductsChanged(), close() } */
export function initDashboard(el, appHooks = {}) {
  if (!el) throw new Error("initDashboard() needs the dashboard <section> element.");
  if (!root) {
    document.addEventListener("visibilitychange", () => { if (document.visibilityState === "hidden") lockNow(); });
    for (const type of ["pointerdown", "keydown", "input", "wheel"]) {
      document.addEventListener(type, noteActivity, { capture: true, passive: true });
    }
    window.addEventListener("scroll", noteActivity, { passive: true });
    document.addEventListener("keydown", onPadKey);
  }
  root = el;
  hooks = appHooks || {};
  root.hidden = true;
  root.replaceChildren();
}

/** Shows the dashboard: the PIN screen unless it was used in the last 5 minutes, then fresh data. */
export async function showDashboard() {
  if (!root) throw new Error("Call initDashboard() before showDashboard().");
  if (!visible) {
    visible = true;
    root.hidden = false;
    window.scrollTo(0, 0);
    idleTimer = setInterval(checkIdle, 15000);
  }
  if (stillUnlocked()) {
    gate.lastActivity = Date.now();
    await showApp();
  } else {
    await lockNow();
  }
}

/** Hides the dashboard and drops its screen; it is rebuilt with fresh data next time. */
export function hideDashboard() {
  if (!root || !visible) return;
  visible = false;
  clearInterval(idleTimer);
  stopCountdown();
  cancelOpenSheets();
  root.hidden = true;
  root.replaceChildren();
}

// ── Lock and session ─────────────────────────────────────────────────────

function stillUnlocked() {
  return gate.unlocked && Date.now() - gate.lastActivity < UNLOCK_MS;
}

function noteActivity() {
  if (!visible || !gate.unlocked) return;
  if (stillUnlocked()) gate.lastActivity = Date.now();
  else lockNow();
}

function checkIdle() {
  if (gate.unlocked && !stillUnlocked()) lockNow();
}

function unlockNow() {
  gate.unlocked = true;
  gate.lastActivity = Date.now();
  gate.failures = 0;
  gate.waitUntil = 0;
  stopCountdown();
}

/** Locks right away. Work still running from the unlocked session sees a new session number and stops. */
function lockNow() {
  gate.unlocked = false;
  gate.session++;
  view.detailId = null;
  view.renaming = null;
  if (!root || !visible) {
    root?.replaceChildren();
    return Promise.resolve();
  }
  cancelOpenSheets();
  root.replaceChildren(); // nothing private stays on screen, not even for a moment
  return showLockScreen();
}

/** Dismisses open bottom sheets (ui.js treats a "cancel" event as "dismissed"). */
function cancelOpenSheets() {
  for (const dlg of document.querySelectorAll("dialog[open]")) {
    dlg.dispatchEvent(new Event("cancel", { cancelable: true }));
    if (dlg.open) dlg.close();
  }
}

// ── PIN storage (PBKDF2-SHA-256 via WebCrypto) ───────────────────────────

const canHash = Boolean(globalThis.crypto?.subtle);
const toBase64 = (bytes) => btoa(String.fromCharCode(...bytes));
const fromBase64 = (text) => Uint8Array.from(atob(text), (c) => c.charCodeAt(0));
const validLen = (n) => (Number.isInteger(n) && n >= 4 && n <= 6 ? n : 0);

async function derivePinHash(pinText, salt, iterations) {
  const key = await crypto.subtle.importKey("raw", new TextEncoder().encode(pinText), "PBKDF2", false, ["deriveBits"]);
  const bits = await crypto.subtle.deriveBits({ name: "PBKDF2", hash: "SHA-256", salt, iterations }, key, 256);
  return new Uint8Array(bits);
}

async function readPin() {
  const rec = await settings.get("pin", null);
  const ok = rec && typeof rec.salt === "string" && typeof rec.hash === "string" && Number.isInteger(rec.iter) && rec.iter > 0;
  return ok ? rec : null;
}

async function savePin(pinText, { reset = false } = {}) {
  const salt = crypto.getRandomValues(new Uint8Array(16));
  const hash = await derivePinHash(pinText, salt, PIN_ITERATIONS);
  // `len` lets the keypad check the PIN as soon as its last digit is typed, like a phone lock screen.
  await settings.set("pin", { salt: toBase64(salt), hash: toBase64(hash), iter: PIN_ITERATIONS, len: pinText.length });
  if (reset) await settings.set("pinResetAt", new Date().toISOString());
}

async function pinMatches(pinText, rec) {
  const got = await derivePinHash(pinText, fromBase64(rec.salt), rec.iter);
  const want = fromBase64(rec.hash);
  let diff = got.length ^ want.length; // constant-time compare
  for (let i = 0; i < got.length; i++) diff |= got[i] ^ (want[i] ?? 0);
  return diff === 0;
}

// ── Keypad screen ────────────────────────────────────────────────────────

async function showLockScreen() {
  const session = gate.session;
  const rec = await readPin().catch(() => null);
  if (session !== gate.session || !visible) return;
  setPad(rec ? { mode: "unlock", len: validLen(rec.len) } : { mode: "create", purpose: "setup" });
}

function setPad(next) {
  Object.assign(pad, { mode: "unlock", purpose: "", entry: "", first: "", len: 0, note: "", error: false, busy: false }, next);
  renderPad();
}

function padCopy() {
  if (pad.mode === "confirm") return { prompt: "Enter the same PIN again", hint: "Just to be sure." };
  if (pad.mode === "verify") return { prompt: "Enter your current PIN", hint: "Then you can choose a new one." };
  if (pad.mode === "create" && pad.purpose === "setup") {
    return { prompt: "Create a PIN", hint: "Choose 4 to 6 digits. You'll enter it to open the owner dashboard." };
  }
  if (pad.mode === "create") return { prompt: "Choose a new PIN", hint: "Choose 4 to 6 digits." };
  return { prompt: "Enter your PIN", hint: "" };
}

/** Most digits this step takes; the step goes ahead by itself when it is reached. */
function padMax() {
  if (pad.mode === "confirm") return pad.first.length;
  if ((pad.mode === "unlock" || pad.mode === "verify") && pad.len) return pad.len;
  return 6;
}

const checksPin = () => pad.mode === "unlock" || pad.mode === "verify";
const waitLeft = () => Math.max(0, gate.waitUntil - Date.now());
const padBlocked = () => !canHash || (checksPin() && waitLeft() > 0);

function renderPad() {
  stopCountdown();
  const copy = padCopy();
  const key = (digit, letters) => h("button", { type: "button", class: "dash-key", "aria-label": digit, onclick: () => pressDigit(digit) },
    h("span", { class: "dash-key-digit", "aria-hidden": "true" }, digit),
    h("span", { class: "dash-key-letters", "aria-hidden": "true" }, letters));
  ui.padKeys = [
    ...KEYS.map(([digit, letters]) => key(digit, letters)),
    h("span", { "aria-hidden": "true" }),
    key("0", ""),
    h("button", { type: "button", class: "dash-key dash-key-plain", "aria-label": "Delete last digit", onclick: pressBack }, icon("backspace")),
  ];
  const needsGo = pad.mode === "create" || (checksPin() && !pad.len);
  ui.padGo = needsGo ? h("button", { type: "button", class: "btn btn-primary dash-pad-go", onclick: submitPad }, pad.mode === "create" ? "Continue" : "Unlock") : null;
  ui.padPrompt = h("h2", { class: "dash-pad-prompt", tabindex: "-1" }, copy.prompt);
  ui.dots = h("div", { class: "dash-dots", role: "img" });
  ui.padNote = h("p", { class: "dash-pad-note", role: "status" });
  ui.padWait = h("p", { class: "dash-pad-wait num", "aria-hidden": "true" });

  let link = null;
  if (pad.mode === "unlock") link = h("button", { type: "button", class: "btn btn-ghost", onclick: forgotPin }, "Forgot PIN?");
  else if (pad.purpose === "reset" || pad.purpose === "change") link = h("button", { type: "button", class: "btn btn-ghost", onclick: cancelPinFlow }, "Cancel");
  else if (pad.mode === "confirm") link = h("button", { type: "button", class: "btn btn-ghost", onclick: () => setPad({ mode: "create", purpose: pad.purpose }) }, "Start again");

  if (!canHash) pad.note = "This browser can't check a PIN here. Open the app from its home-screen icon or its https:// link.";
  else if (checksPin() && waitLeft() > 0 && !pad.note) pad.note = "Too many wrong tries.";

  ui.lockBox = h("div", { class: "dash-lock-main" },
    h("div", { class: "dash-lock-badge", "aria-hidden": "true" }, icon("lock")),
    h("p", { class: "dash-kicker" }, SELLER),
    h("h1", { class: "dash-lock-title" }, "Owner dashboard"),
    ui.padPrompt,
    copy.hint ? h("p", { class: "dash-pad-hint" }, copy.hint) : null,
    ui.dots,
    ui.padNote,
    ui.padWait,
    h("div", { class: "dash-keypad" }, ui.padKeys),
    ui.padGo,
    link ? h("div", { class: "dash-pad-links" }, link) : null);
  root.replaceChildren(h("div", { class: "dash-lock" }, h("div", { class: "dash-lock-top" }, backToInvoiceButton()), ui.lockBox));
  updatePad();
  if (checksPin() && waitLeft() > 0) startCountdown();
  ui.padPrompt.focus({ preventScroll: true });
}

function updatePad() {
  const typed = pad.entry.length;
  const slots = pad.mode === "create" ? Math.max(4, typed) : padMax();
  ui.dots.replaceChildren(...Array.from({ length: slots }, (_, i) => h("span", { class: i < typed ? "dash-dot is-on" : "dash-dot" })));
  ui.dots.setAttribute("aria-label", pad.mode === "create" ? `${plural(typed, "digit")} entered` : `${typed} of ${slots} digits entered`);
  const blocked = padBlocked();
  for (const k of ui.padKeys) if (k instanceof HTMLButtonElement) k.disabled = blocked;
  if (ui.padGo) ui.padGo.disabled = blocked || typed < 4;
  ui.padNote.textContent = pad.note;
}

function padError(message) {
  pad.note = message;
  pad.error = true;
  updatePad();
  ui.lockBox.classList.remove("is-error");
  void ui.lockBox.offsetWidth; // restarts the shake animation
  ui.lockBox.classList.add("is-error");
}

function pressDigit(digit) {
  if (pad.busy || padBlocked() || pad.entry.length >= padMax()) return;
  pad.entry += digit;
  if (pad.error) {
    pad.error = false;
    pad.note = "";
    ui.lockBox.classList.remove("is-error");
  }
  updatePad();
  if (pad.entry.length === padMax()) submitPad();
}

function pressBack() {
  if (pad.busy || padBlocked() || !pad.entry) return;
  pad.entry = pad.entry.slice(0, -1);
  updatePad();
}

function submitPad() {
  if (pad.busy || padBlocked() || pad.entry.length < 4) return;
  const entry = pad.entry;
  if (pad.mode === "create") setPad({ mode: "confirm", purpose: pad.purpose, first: entry });
  else if (pad.mode === "confirm") confirmNewPin(entry);
  else checkEnteredPin(entry);
}

async function confirmNewPin(entry) {
  const { purpose } = pad;
  if (entry !== pad.first) {
    setPad({ mode: "create", purpose });
    padError("Those PINs didn't match. Please choose one again.");
    return;
  }
  const session = gate.session;
  pad.busy = true;
  try {
    await savePin(entry, { reset: purpose === "reset" });
  } catch {
    if (session !== gate.session) return;
    setPad({ mode: "create", purpose });
    padError("Couldn't save the PIN. Please try again.");
    return;
  }
  if (session !== gate.session || !visible) return;
  unlockNow();
  toast(purpose === "change" ? "PIN changed." : purpose === "reset" ? "New PIN saved." : "PIN created. Keep it to yourself.");
  if (purpose === "change") view.tab = "settings";
  await showApp();
}

async function checkEnteredPin(entry) {
  const session = gate.session;
  pad.busy = true;
  let rec = null, ok = false;
  try {
    rec = await readPin();
    ok = Boolean(rec) && (await pinMatches(entry, rec));
  } catch {
    ok = false;
  }
  pad.busy = false;
  if (session !== gate.session || !visible) return;
  if (!rec) return setPad({ mode: "create", purpose: pad.mode === "verify" ? "change" : "setup" });
  if (!ok) return wrongPin();
  gate.failures = 0;
  gate.waitUntil = 0;
  if (pad.mode === "verify") return setPad({ mode: "create", purpose: "change" });
  unlockNow();
  await showApp();
}

function wrongPin() {
  gate.failures++;
  pad.entry = "";
  if (gate.failures >= FREE_TRIES) {
    const wait = Math.min(FIRST_WAIT_MS * 2 ** (gate.failures - FREE_TRIES), MAX_WAIT_MS);
    gate.waitUntil = Date.now() + wait;
    padError(`Too many wrong tries. Please wait ${waitWords(wait)}.`);
    startCountdown();
  } else {
    const left = FREE_TRIES - gate.failures;
    padError(left <= 2 ? `Wrong PIN. ${left} more ${left === 1 ? "try" : "tries"} before a short wait.` : "Wrong PIN. Please try again.");
  }
}

function startCountdown() {
  stopCountdown();
  const tick = () => {
    if (!ui.padWait?.isConnected) return stopCountdown();
    const left = waitLeft();
    if (left > 0) {
      ui.padWait.textContent = `Try again in ${clockText(left)}`;
      return;
    }
    stopCountdown();
    ui.padWait.textContent = "";
    pad.note = "";
    pad.error = false;
    ui.lockBox.classList.remove("is-error");
    updatePad();
  };
  tick();
  countdownTimer = setInterval(tick, 1000);
}

function stopCountdown() {
  clearInterval(countdownTimer);
  countdownTimer = 0;
}

/** Physical keyboards: digits, Backspace and Enter work on the keypad screen. */
function onPadKey(e) {
  if (!visible || !ui.padPrompt?.isConnected || e.defaultPrevented || e.altKey || e.ctrlKey || e.metaKey) return;
  if (e.target?.closest?.("input, textarea, select, dialog")) return;
  if (/^\d$/.test(e.key)) {
    e.preventDefault();
    pressDigit(e.key);
  } else if (e.key === "Backspace") {
    e.preventDefault();
    pressBack();
  } else if (e.key === "Enter" && ui.padGo && !e.target?.closest?.("button")) {
    e.preventDefault();
    submitPad();
  }
}

async function forgotPin() {
  const answer = await choiceSheet({
    title: "Forgot your PIN?",
    message: "Your invoices are safe and will be kept. The PIN only keeps casual eyes out of this dashboard; it doesn't lock or encrypt anything. To choose a new PIN, type RESET below.",
    input: { label: "Type RESET", placeholder: "RESET" },
    choices: [{ label: "Cancel", value: false }, { label: "Choose a new PIN", value: true, primary: true }],
  });
  if (!answer || answer.choice !== true || !visible || gate.unlocked) return;
  if (answer.text.trim().toUpperCase() !== "RESET") {
    toast("Type RESET to choose a new PIN.");
    return;
  }
  setPad({ mode: "create", purpose: "reset" });
}

async function startPinChange() {
  const session = gate.session;
  const rec = await readPin().catch(() => null);
  if (session !== gate.session || !visible) return;
  setPad(rec ? { mode: "verify", purpose: "change", len: validLen(rec.len) } : { mode: "create", purpose: "change" });
  window.scrollTo(0, 0);
}

function cancelPinFlow() {
  if (gate.unlocked) {
    view.tab = "settings";
    showApp();
  } else {
    showLockScreen();
  }
}

// ── Dashboard shell ──────────────────────────────────────────────────────

async function loadData() {
  const [list, prods, paper, pinResetAt] = await Promise.all([
    invoices.all(), products.all({ includeHidden: true }), settings.get("paper", 58), settings.get("pinResetAt", null),
  ]);
  data = { invoices: list.map(withTotals), products: prods, paper: Number(paper) === 80 ? 80 : 58, pinResetAt };
}

async function showApp() {
  const session = gate.session;
  try {
    await loadData();
  } catch (err) {
    if (session === gate.session) toast(err.message || "Couldn't read the invoices saved on this phone.");
  }
  if (session !== gate.session || !visible) return;
  stopCountdown();
  buildShell();
  renderPanel();
  ui.title.focus({ preventScroll: true });
}

/** Re-reads everything and redraws the current tab. */
async function refresh() {
  const session = gate.session;
  try {
    await loadData();
  } catch (err) {
    toast(err.message || "Couldn't read the invoices saved on this phone.");
    return;
  }
  if (session === gate.session && visible && ui.panel?.isConnected) renderPanel();
}

function backToInvoiceButton() {
  return h("button", { type: "button", class: "btn btn-ghost dash-back", onclick: () => callHook("close") }, icon("back"), "Back to invoice");
}

function buildShell() {
  ui.tabs = TABS.map(([id, label]) => h("button", {
    type: "button", role: "tab", id: `dash-tab-${id}`, class: "dash-tab", "aria-controls": "dash-panel",
    onclick: () => selectTab(id), onkeydown: onTabKey,
  }, label));
  ui.title = h("h1", { class: "dash-title", tabindex: "-1" }, "Owner dashboard");
  ui.tabBar = h("div", { class: "dash-tabs" }, h("div", { class: "dash-tablist", role: "tablist", "aria-label": "Dashboard sections" }, ui.tabs));
  ui.panel = h("div", { class: "dash-panel", id: "dash-panel", role: "tabpanel" });
  root.replaceChildren(h("div", { class: "dash-app" },
    h("header", { class: "dash-header" },
      h("div", { class: "dash-topbar" },
        backToInvoiceButton(),
        h("button", { type: "button", class: "btn dash-lock-now", onclick: () => lockNow() }, icon("lock"), "Lock")),
      h("p", { class: "dash-kicker" }, SELLER),
      ui.title),
    ui.tabBar,
    ui.panel));
  syncTabs();
}

function syncTabs() {
  TABS.forEach(([id], i) => {
    ui.tabs[i].setAttribute("aria-selected", String(id === view.tab));
    ui.tabs[i].tabIndex = id === view.tab ? 0 : -1;
  });
  ui.panel.setAttribute("aria-labelledby", `dash-tab-${view.tab}`);
}

function selectTab(id, { focus = false } = {}) {
  view.tab = id;
  view.detailId = null;
  view.renaming = null;
  syncTabs();
  renderPanel();
  scrollToPanel();
  if (focus) ui.tabs[TABS.findIndex(([t]) => t === id)].focus();
}

function onTabKey(e) {
  const i = TABS.findIndex(([id]) => id === view.tab);
  const next = { ArrowRight: i + 1, ArrowLeft: i - 1, Home: 0, End: TABS.length - 1 }[e.key];
  if (next === undefined) return;
  e.preventDefault();
  selectTab(TABS[(next + TABS.length) % TABS.length][0], { focus: true });
}

/** Brings the top of the panel into view without hiding the tab bar under the header. */
function scrollToPanel() {
  const top = ui.tabBar.getBoundingClientRect().top + window.scrollY;
  if (window.scrollY > top) window.scrollTo(0, top);
}

function renderPanel() {
  let content;
  if (view.tab === "settings") content = settingsView();
  else if (view.tab === "history") {
    const inv = view.detailId && data.invoices.find((x) => x.id === view.detailId);
    content = inv ? detailView(inv) : historyView();
  } else content = overviewView();
  ui.panel.replaceChildren(...content);
}

// ── Overview: totals ─────────────────────────────────────────────────────

function overviewView() {
  const totals = periodTotals(data.invoices, todayISO());
  const out = [];
  const notice = resetNotice();
  if (notice) out.push(notice);
  out.push(h("section", { class: "dash-section", "aria-labelledby": "dash-h-totals" },
    h("h2", { class: "section-title", id: "dash-h-totals" }, "Totals"),
    h("div", { class: "dash-kpis" },
      kpiTile("today", "Today", totals.today),
      kpiTile("week", "This week", totals.week),
      kpiTile("month", "This month", totals.month),
      kpiTile("all", "All time", totals.all)),
    h("p", { class: "dash-caption" }, "By invoice date. Weeks run Monday to Sunday.")));
  if (!data.invoices.length) {
    out.push(h("div", { class: "card dash-empty" },
      icon("receipt"),
      h("h2", { class: "dash-empty-title" }, "No invoices yet"),
      h("p", {}, "Your totals, best stores and top products will show here once you save an invoice."),
      h("button", { type: "button", class: "btn btn-primary", onclick: () => callHook("newInvoice") }, "Write an invoice")));
    return out;
  }
  out.push(
    monthlySection(),
    rankingSection({
      id: "dash-h-stores", title: "Top stores", rangeKey: "storeRange", allKey: "storesAll",
      rows: storeTotals, meta: (r) => plural(r.count, "invoice"),
    }),
    rankingSection({
      id: "dash-h-products", title: "Products sold", rangeKey: "productRange", allKey: "productsAll",
      rows: productTotals, meta: (r) => `${qtyText(r.milli / 1000)} sold`,
    }));
  return out;
}

function periodTotals(list, today) {
  const week = weekStartISO(today), month = today.slice(0, 7);
  const t = { today: { cents: 0, count: 0 }, week: { cents: 0, count: 0 }, month: { cents: 0, count: 0 }, all: { cents: 0, count: 0 } };
  const add = (bucket, inv) => { bucket.cents += toCents(inv.total); bucket.count++; };
  for (const inv of list) {
    add(t.all, inv);
    if (inv.date === today) add(t.today, inv);
    if (weekStartISO(inv.date) === week) add(t.week, inv);
    if (monthKey(inv.date) === month) add(t.month, inv);
  }
  return t;
}

function kpiTile(key, label, { cents, count }) {
  const value = moneyCents(cents);
  return h("div", { class: "card dash-kpi", dataset: { kpi: key } },
    h("p", { class: "dash-kpi-label" }, label),
    h("p", { class: "dash-kpi-value", style: `--w:${glyphWidth(value)}` }, value),
    h("p", { class: "dash-kpi-sub" }, plural(count, "invoice")));
}

/** Width of a money string in digit widths (separators are narrow); the CSS uses it to fit KPI values. */
const glyphWidth = (text) => [...text].reduce((w, c) => w + (/[\d$]/.test(c) ? 1 : 0.45), 0).toFixed(2);

function resetNotice() {
  const at = data.pinResetAt;
  if (!at || readNoticeSeen() === at) return null;
  const notice = h("div", { class: "dash-notice", role: "note" },
    icon("shield"),
    h("p", {}, h("strong", {}, `PIN was reset on ${dateTimeText(at)}.`), " If that wasn't you, someone else may have used this phone."),
    h("button", { type: "button", class: "btn btn-ghost", onclick: () => { writeNoticeSeen(at); notice.remove(); ui.title.focus({ preventScroll: true }); } }, "Got it"));
  return notice;
}

function monthlySection() {
  const months = monthlyTotals(data.invoices);
  const shown = months.slice(0, MAX_MONTHS);
  const top = Math.max(1, ...shown.map((m) => m.cents));
  return h("section", { class: "dash-section", "aria-labelledby": "dash-h-months" },
    h("h2", { class: "section-title", id: "dash-h-months" }, "Monthly totals"),
    h("div", { class: "card dash-card" },
      h("ol", { class: "dash-meters" }, shown.map((m) => meterRow({
        label: monthLabel(m.key), value: moneyCents(m.cents), meta: plural(m.count, "invoice"), share: m.cents / top, dataset: { month: m.key },
      }))),
      months.length > MAX_MONTHS ? h("p", { class: "dash-caption" }, `The ${MAX_MONTHS} most recent months with invoices.`) : null));
}

function monthlyTotals(list) {
  const map = new Map();
  for (const inv of list) {
    const key = monthKey(inv.date);
    if (!key) continue;
    const m = map.get(key) || { key, cents: 0, count: 0 };
    m.cents += toCents(inv.total);
    m.count++;
    map.set(key, m);
  }
  return [...map.values()].sort((a, b) => b.key.localeCompare(a.key));
}

/** A card listing the biggest stores or products, with its own This month / All time switch. */
function rankingSection({ id, title, rangeKey, allKey, rows, meta }) {
  const body = h("div", { class: "card dash-card" });
  const draw = () => {
    const month = todayISO().slice(0, 7);
    const list = view[rangeKey] === "month" ? data.invoices.filter((inv) => monthKey(inv.date) === month) : data.invoices;
    const all = rows(list);
    if (!all.length) {
      body.replaceChildren(h("p", { class: "dash-empty-note" }, "No invoices this month yet."));
      return;
    }
    const top = Math.max(1, all[0].cents);
    const shown = view[allKey] ? all : all.slice(0, TOP_ROWS);
    body.replaceChildren(
      h("ol", { class: "dash-meters" }, shown.map((r) => meterRow({ label: r.name, value: moneyCents(r.cents), meta: meta(r), share: r.cents / top }))),
      all.length > TOP_ROWS
        ? h("button", { type: "button", class: "btn btn-ghost dash-more", "aria-expanded": String(view[allKey]), onclick: () => { view[allKey] = !view[allKey]; draw(); } },
          view[allKey] ? "Show fewer" : `Show all ${all.length}`)
        : ""); // replaceChildren would turn null into the text "null"
  };
  draw();
  return h("section", { class: "dash-section", "aria-labelledby": id },
    h("div", { class: "dash-section-head" },
      h("h2", { class: "section-title", id }, title),
      segmented({ label: `${title}: period`, options: RANGES, value: view[rangeKey], onChange: (v) => { view[rangeKey] = v; draw(); } })),
    body);
}

function storeTotals(list) {
  const map = new Map();
  for (const inv of list) { // newest first, so each store keeps its latest spelling
    const key = storeKey(inv.store);
    const s = map.get(key) || { name: tidy(inv.store) || "No store name", cents: 0, count: 0 };
    s.cents += toCents(inv.total);
    s.count++;
    map.set(key, s);
  }
  return [...map.values()].sort((a, b) => b.cents - a.cents || b.count - a.count || a.name.localeCompare(b.name));
}

function productTotals(list) {
  const names = new Map(data.products.map((p) => [p.id, p.name]));
  const map = new Map();
  for (const inv of list) {
    for (const it of inv.items) {
      // Known products are grouped by id (and shown with their current name); anything else by name.
      const key = names.has(it.productId) ? it.productId : `name:${foldText(it.name)}`;
      const p = map.get(key) || { name: names.get(it.productId) || it.name || "Unnamed product", cents: 0, milli: 0 };
      p.cents += toCents(it.total);
      p.milli += Math.round((it.qty ?? 0) * 1000);
      map.set(key, p);
    }
  }
  return [...map.values()].sort((a, b) => b.cents - a.cents || b.milli - a.milli || a.name.localeCompare(b.name));
}

function meterRow({ label, value, meta, share, dataset }) {
  const fill = h("span", { class: "dash-bar-fill" });
  if (share > 0) fill.style.width = `max(4px, ${(Math.min(1, share) * 100).toFixed(2)}%)`;
  return h("li", { class: "dash-meter", dataset },
    h("div", { class: "dash-meter-head" },
      h("span", { class: "dash-meter-label" }, label),
      h("span", { class: "dash-meter-value num" }, value)),
    h("div", { class: "dash-meter-foot" },
      h("span", { class: "dash-bar", "aria-hidden": "true" }, fill),
      h("span", { class: "dash-meter-meta num" }, meta)));
}

// ── History ──────────────────────────────────────────────────────────────

function historyView() {
  const search = h("input", {
    type: "search", class: "dash-search-input", value: view.query, placeholder: "Search store or number",
    "aria-label": "Search by store or invoice number", autocomplete: "off", enterkeyhint: "search",
    oninput: (e) => { view.query = e.currentTarget.value; view.shown = HISTORY_PAGE; renderHistory(); },
    onkeydown: (e) => { if (e.key === "Enter") e.currentTarget.blur(); },
  });
  ui.chips = FILTERS.map(([id, label]) => h("button", {
    type: "button", class: "dash-chip", "aria-pressed": String(view.filter === id), dataset: { filter: id },
    onclick: () => {
      view.filter = id;
      view.shown = HISTORY_PAGE;
      for (const chip of ui.chips) chip.setAttribute("aria-pressed", String(chip.dataset.filter === id));
      renderHistory();
    },
  }, icon("check"), label));
  ui.historySummary = h("p", { class: "dash-summary num", role: "status" });
  ui.historyList = h("div", { class: "dash-history" });
  renderHistory();
  return [
    h("div", { class: "dash-search", role: "search" }, icon("search"), search),
    h("div", { class: "dash-chips", role: "group", "aria-label": "Show" }, ui.chips),
    ui.historySummary,
    ui.historyList,
  ];
}

const NUMBER_QUERY = /^(?:#|no\.?|number)?\s*0*(\d+)$/i;

function filterHistory(list, query, filter, month) {
  const q = foldText(query);
  const number = NUMBER_QUERY.exec(query.trim());
  return list.filter((inv) => {
    if (filter === "month" && monthKey(inv.date) !== month) return false;
    if (filter === "unsigned" && inv.signature) return false;
    if (!q) return true;
    return (number && Number(number[1]) === inv.number) || foldText(inv.store).includes(q);
  });
}

function renderHistory() {
  const rows = filterHistory(data.invoices, view.query, view.filter, todayISO().slice(0, 7));
  const cents = rows.reduce((sum, inv) => sum + toCents(inv.total), 0);
  ui.historySummary.textContent = rows.length ? `${plural(rows.length, "invoice")} · ${moneyCents(cents)}` : "";
  if (!rows.length) {
    let text = "No invoices yet. Saved invoices will show here.";
    if (data.invoices.length) text = view.query.trim() ? `No invoices match “${view.query.trim()}”.` : "No invoices to show here.";
    ui.historyList.replaceChildren(h("p", { class: "card dash-empty-note" }, text));
    return;
  }
  const monthCents = new Map();
  for (const inv of rows) monthCents.set(monthKey(inv.date), (monthCents.get(monthKey(inv.date)) || 0) + toCents(inv.total));
  const groups = [];
  for (const inv of rows.slice(0, view.shown)) {
    const key = monthKey(inv.date);
    if (groups.at(-1)?.key !== key) groups.push({ key, list: [] });
    groups.at(-1).list.push(inv);
  }
  ui.historyList.replaceChildren(
    ...groups.map((g) => h("section", { class: "dash-group" },
      h("h3", { class: "dash-group-head" },
        h("span", {}, g.key ? monthLabel(g.key) : "No date"),
        h("span", { class: "num" }, moneyCents(monthCents.get(g.key)))),
      h("ul", { class: "card dash-rows" }, g.list.map(historyRow)))),
    rows.length > view.shown
      ? h("button", { type: "button", class: "btn btn-block dash-more", onclick: () => { view.shown += HISTORY_PAGE; renderHistory(); } },
        `Show ${Math.min(HISTORY_PAGE, rows.length - view.shown)} more`)
      : ""); // replaceChildren would turn null into the text "null"
}

function historyRow(inv) {
  const no = invoiceNo(inv.number), signed = Boolean(inv.signature), store = inv.store || "No store name";
  return h("li", {},
    h("button", {
      type: "button", class: "dash-row", dataset: { id: inv.id },
      "aria-label": `${store}, invoice No. ${no}, ${prettyDate(inv.date)}, ${money(inv.total)}, ${signed ? "signed" : "not signed"}`,
      onclick: () => openDetail(inv.id),
    },
    h("span", { class: "dash-row-meta num" }, `No. ${no} · ${prettyDate(inv.date)}`),
    h("span", { class: "dash-row-total num" }, money(inv.total)),
    h("span", { class: "dash-row-store" }, store),
    signed ? h("span", { class: "dash-badge is-signed" }, icon("check"), "Signed") : h("span", { class: "dash-badge is-unsigned" }, "Not signed")));
}

// ── Invoice detail ───────────────────────────────────────────────────────

function openDetail(id) {
  view.listScroll = window.scrollY;
  view.detailId = id;
  renderPanel();
  scrollToPanel();
  document.getElementById("dash-detail-title")?.focus({ preventScroll: true });
}

function closeDetail() {
  const id = view.detailId;
  view.detailId = null;
  renderPanel();
  window.scrollTo(0, view.listScroll);
  ui.panel.querySelector(`.dash-row[data-id="${CSS.escape(id || "")}"]`)?.focus({ preventScroll: true });
}

function detailView(inv) {
  const no = invoiceNo(inv.number);
  const missing = inv.items.filter((it) => it.price === null).length;
  const signature = signatureSrc(inv.signature);
  return [
    h("button", { type: "button", class: "btn btn-ghost dash-back dash-back-list", onclick: closeDetail }, icon("back"), "All invoices"),
    h("article", { class: "dash-detail", "aria-labelledby": "dash-detail-title" },
      h("div", { class: "card dash-sheet" },
        h("p", { class: "dash-kicker" }, `Invoice No. ${no}`),
        h("h2", { class: "dash-detail-store", id: "dash-detail-title", tabindex: "-1" }, inv.store || "No store name"),
        inv.address ? h("p", { class: "dash-detail-address" }, inv.address) : null,
        h("p", { class: "dash-detail-date" }, prettyDate(inv.date)),
        inv.items.length
          ? h("ul", { class: "dash-items" }, inv.items.map((it) => h("li", { class: "dash-item" },
            h("span", { class: "dash-item-name" }, it.name || "Unnamed product"),
            h("span", { class: "dash-item-total num" }, it.price === null ? "—" : money(it.total)),
            h("span", { class: "dash-item-calc num" }, `${qtyText(it.qty) || "0"} × ${it.price === null ? "no price yet" : money(it.price)}`))))
          : h("p", { class: "dash-items-none" }, "No products ticked on this invoice."),
        h("div", { class: "dash-total" },
          h("span", { class: "dash-total-label" }, "Total", h("span", { class: "dash-total-count" }, plural(inv.items.length, "item"))),
          h("span", { class: "dash-total-value" }, money(inv.total)))),
      missing
        ? h("p", { class: "dash-warn" }, icon("alert"),
          `${plural(missing, "item")} ${missing === 1 ? "has" : "have"} no price yet. Tap Open and edit to add ${missing === 1 ? "it" : "them"}.`)
        : null,
      h("section", { class: "dash-section", "aria-labelledby": "dash-h-signature" },
        h("h3", { class: "section-title", id: "dash-h-signature" }, "Customer signature"),
        h("div", { class: "card dash-card" }, signature
          ? h("figure", { class: "dash-signature" },
            h("img", { src: signature, alt: "Customer's signature" }),
            h("figcaption", {}, inv.signedAt ? `Signed ${dateTimeText(inv.signedAt)}` : "Signed by the customer"))
          : h("p", { class: "dash-signature-none" }, inv.signature ? "Signed by the customer" : "Not signed"))),
      h("section", { class: "dash-section", "aria-labelledby": "dash-h-qr" },
        h("h3", { class: "section-title", id: "dash-h-qr" }, "QR code"),
        h("div", { class: "card dash-card dash-qr" },
          qrFor(inv),
          h("p", { class: "dash-help" }, "The customer can scan this with their phone camera to see the invoice."))),
      detailActions(inv)),
  ];
}

function qrFor(inv) {
  try {
    const canvas = qrCanvas(invoiceToUrl(inv), { px: 220 });
    canvas.setAttribute("role", "img");
    canvas.setAttribute("aria-label", `QR code for invoice No. ${invoiceNo(inv.number)}`);
    return canvas;
  } catch {
    return h("p", { class: "dash-help" }, "This invoice is too long to fit in a QR code.");
  }
}

function detailActions(inv) {
  return h("div", { class: "dash-actions" },
    h("button", { type: "button", class: "btn btn-primary btn-block", onclick: () => callHook("openInvoice", inv.id) }, icon("pencil"), "Open and edit"),
    h("div", { class: "dash-actions-row" },
      // Printing must start inside the tap itself (Web Bluetooth needs the gesture): nothing is awaited first.
      h("button", { type: "button", class: "btn", onclick: (e) => runTask(e.currentTarget, () => printInvoice(inv), "Printing didn't work. Try Share PDF instead.") },
        icon("printer"), "Print"),
      h("button", { type: "button", class: "btn", onclick: (e) => runTask(e.currentTarget, () => shareInvoicePdf(inv), "Couldn't make the PDF. Please try again.") },
        icon("share"), "Share PDF")),
    h("button", { type: "button", class: "btn btn-block", onclick: () => callHook("duplicateInvoice", inv.id) }, icon("copy"), "Duplicate as new invoice"),
    h("button", { type: "button", class: "btn btn-danger btn-block", onclick: () => deleteInvoice(inv) }, icon("trash"), "Delete invoice"));
}

/** Starts a print or share task from a tap; its button stays disabled until the task settles. */
function runTask(button, task, failMessage) {
  button.disabled = true;
  let result;
  try {
    result = Promise.resolve(task());
  } catch (err) {
    result = Promise.reject(err);
  }
  result.catch((err) => { console.warn(err); toast(failMessage); }).finally(() => { button.disabled = false; });
}

async function deleteInvoice(inv) {
  const session = gate.session;
  const no = invoiceNo(inv.number);
  const ok = await confirmSheet({
    title: `Delete invoice No. ${no}?`,
    message: `${inv.store || "No store name"} · ${money(inv.total)}. It will be gone from this phone for good.`,
    okText: "Delete",
    danger: true,
  });
  if (!ok || session !== gate.session) return;
  try {
    await invoices.remove(inv.id);
  } catch (err) {
    toast(err.message || "Couldn't delete that invoice. Please try again.");
    return;
  }
  toast(`Invoice No. ${no} deleted.`);
  view.detailId = null;
  await refresh();
  window.scrollTo(0, view.listScroll);
}

// ── Settings ─────────────────────────────────────────────────────────────

function settingsView() {
  return [printerSection(), productsSection(), backupSection(), storageSection(), pinSection(), eraseSection()];
}

function settingsSection(id, title, ...body) {
  return h("section", { class: "dash-section", "aria-labelledby": id },
    h("h2", { class: "section-title", id }, title),
    h("div", { class: "card dash-card" }, ...body));
}

function printerSection() {
  const name = h("p", { class: "dash-printer-name" });
  const forget = h("button", { type: "button", class: "btn", hidden: true, onclick: forgetSavedPrinter }, "Forget printer");
  const showPrinter = (printerName) => {
    name.textContent = printerName || "No printer saved yet. You'll choose one the first time you print.";
    name.classList.toggle("muted", !printerName);
    forget.hidden = !printerName;
  };
  async function forgetSavedPrinter() {
    try {
      await forgetPrinter();
    } catch {
      toast("Couldn't forget the printer. Please try again.");
      return;
    }
    toast("Printer forgotten. You'll choose it again next time you print.");
    showPrinter(null);
  }
  Promise.resolve().then(savedPrinterName).then(showPrinter, () => showPrinter(null));
  return settingsSection("dash-h-printer", "Receipt printer",
    h("div", { class: "dash-field" },
      h("p", { class: "dash-field-label", id: "dash-paper-label" }, "Paper width"),
      segmented({ labelledBy: "dash-paper-label", options: [[58, "58 mm"], [80, "80 mm"]], value: data.paper, onChange: setPaper }),
      h("p", { class: "dash-help" }, "Most small Bluetooth receipt printers use 58 mm paper.")),
    h("div", { class: "dash-field" },
      h("p", { class: "dash-field-label" }, "Printer"),
      h("div", { class: "dash-printer" }, name, forget)));
}

async function setPaper(mm) {
  try {
    await settings.set("paper", mm);
  } catch {
    toast("Couldn't save that. Please try again.");
    return;
  }
  data.paper = mm;
  toast(`Receipts will print on ${mm} mm paper.`);
}

function productsSection() {
  ui.productList = h("ul", { class: "dash-plist" });
  ui.removedBox = h("div", { class: "dash-removed-box" });
  const form = addProductForm();
  renderProducts();
  return settingsSection("dash-h-products", "Products",
    h("p", { class: "dash-help" }, "The list on every new invoice. Old invoices keep the names they were written with."),
    ui.productList, form, ui.removedBox);
}

function renderProducts() {
  const shown = data.products.filter((p) => !p.hidden);
  const removed = data.products.filter((p) => p.hidden);
  ui.productList.replaceChildren(...shown.map((p, i) => (view.renaming === p.id ? renameRow(p) : productRow(p, i, shown))));
  ui.removedBox.replaceChildren(...(removed.length ? [removedProducts(removed)] : []));
}

function productRow(p, index, shown) {
  const open = view.openProduct === p.id;
  const action = (label, iconName, act, disabled = false) => h("button", {
    type: "button", class: "btn", dataset: { act }, disabled, onclick: () => productAction(p, act, index, shown),
  }, icon(iconName), label);
  return h("li", { class: open ? "dash-prow is-open" : "dash-prow", dataset: { id: p.id } },
    h("button", {
      type: "button", class: "dash-prow-main", dataset: { act: "toggle" }, "aria-expanded": String(open),
      onclick: () => { view.openProduct = open ? null : p.id; renderProducts(); focusProduct(p.id, "toggle"); },
    }, h("span", { class: "dash-prow-name" }, p.name), icon("chevron")),
    open
      ? h("div", { class: "dash-prow-actions", role: "group", "aria-label": p.name },
        action("Move up", "up", "up", index === 0),
        action("Move down", "down", "down", index === shown.length - 1),
        action("Rename", "pencil", "rename"),
        action("Remove", "trash", "remove"))
      : null);
}

async function productAction(p, act, index, shown) {
  if (act === "rename") {
    view.renaming = p.id;
    renderProducts();
    ui.productList.querySelector(".dash-rename input")?.select();
    return;
  }
  try {
    if (act === "remove") await products.hide(p.id);
    else await products.move(p.id, act === "up" ? -1 : 1);
  } catch (err) {
    toast(err.message || "Couldn't change the product list. Please try again.");
    return;
  }
  if (act === "remove") {
    view.openProduct = null;
    toast(`${p.name} was removed from the list. You can restore it below.`);
  }
  await productsChanged();
  if (act === "remove") focusProduct((shown[index + 1] || shown[index - 1])?.id, "toggle");
  else focusProduct(p.id, act);
}

/** Puts focus back on a product's control after the list is redrawn (or its toggle if that control is disabled). */
function focusProduct(id, act) {
  if (!id) return;
  const row = ui.productList.querySelector(`[data-id="${CSS.escape(id)}"]`);
  const target = row?.querySelector(`[data-act="${act}"]`);
  (target && !target.disabled ? target : row?.querySelector('[data-act="toggle"]'))?.focus();
}

function renameRow(p) {
  const input = h("input", { type: "text", value: p.name, maxlength: "60", autocomplete: "off", enterkeyhint: "done", "aria-label": `New name for ${p.name}` });
  const close = () => { view.renaming = null; renderProducts(); focusProduct(p.id, "toggle"); };
  input.addEventListener("keydown", (e) => { if (e.key === "Escape") { e.preventDefault(); close(); } });
  const save = async (e) => {
    e.preventDefault();
    const name = tidy(input.value);
    if (!name) {
      toast("Type a product name first.");
      input.focus();
      return;
    }
    if (name === p.name) return close();
    if (data.products.some((o) => o.id !== p.id && o.name.toLowerCase() === name.toLowerCase())) {
      toast(`There's already a product called ${name}.`);
      input.focus();
      return;
    }
    try {
      await products.rename(p.id, name);
    } catch (err) {
      toast(err.message || "Couldn't rename that product. Please try again.");
      return;
    }
    toast(`Renamed to ${name}.`);
    view.renaming = null;
    await productsChanged();
    focusProduct(p.id, "toggle");
  };
  return h("li", { class: "dash-prow is-open", dataset: { id: p.id } },
    h("form", { class: "dash-rename", onsubmit: save },
      input,
      h("div", { class: "dash-rename-actions" },
        h("button", { type: "button", class: "btn", onclick: close }, "Cancel"),
        h("button", { type: "submit", class: "btn btn-primary" }, "Save"))));
}

function addProductForm() {
  const input = h("input", { type: "text", placeholder: "New product name", "aria-label": "New product name", maxlength: "60", autocomplete: "off", enterkeyhint: "done" });
  const add = async (e) => {
    e.preventDefault();
    const name = tidy(input.value);
    if (!name) {
      toast("Type a product name first.");
      input.focus();
      return;
    }
    const existing = data.products.find((p) => p.name.toLowerCase() === name.toLowerCase());
    if (existing && !existing.hidden) {
      toast(`${existing.name} is already on the list.`);
      return;
    }
    try {
      await products.add(name);
    } catch (err) {
      toast(err.message || "Couldn't add that product. Please try again.");
      return;
    }
    input.value = "";
    toast(existing ? `${existing.name} is back on the list.` : `Added ${name}.`);
    await productsChanged();
  };
  return h("form", { class: "dash-add", onsubmit: add },
    input,
    h("button", { type: "submit", class: "btn btn-primary" }, icon("plus"), "Add"));
}

function removedProducts(list) {
  return h("details", { class: "dash-removed", open: view.removedOpen, ontoggle: (e) => { view.removedOpen = e.currentTarget.open; } },
    h("summary", {}, `Removed products (${list.length})`),
    h("ul", { class: "dash-plist" }, list.map((p) => h("li", { class: "dash-prow dash-prow-removed", dataset: { id: p.id } },
      h("span", { class: "dash-prow-name" }, p.name),
      h("button", { type: "button", class: "btn", dataset: { act: "restore" }, onclick: () => restoreProduct(p) }, icon("undo"), "Restore")))));
}

async function restoreProduct(p) {
  try {
    await products.unhide(p.id);
  } catch (err) {
    toast(err.message || "Couldn't restore that product. Please try again.");
    return;
  }
  toast(`${p.name} is back on the list.`);
  await productsChanged();
}

async function productsChanged() {
  callHook("onProductsChanged");
  try {
    data.products = await products.all({ includeHidden: true });
  } catch {
    // keep showing the last list read
  }
  if (ui.productList?.isConnected) renderProducts();
}

function backupSection() {
  const fileInput = h("input", {
    type: "file", accept: "application/json,.json", id: "dash-restore-file", class: "visually-hidden",
    tabindex: "-1", "aria-hidden": "true", onchange: restoreFromFile,
  });
  return settingsSection("dash-h-backup", "Backup",
    h("p", { class: "dash-help" }, "Save a copy of all your invoices and products as a file you can keep in Files, Drive or email. Restore it on this phone or a new one."),
    h("div", { class: "dash-stack" },
      h("button", { type: "button", class: "btn btn-block", onclick: saveBackup }, icon("download"), "Save backup file"),
      h("button", { type: "button", class: "btn btn-block", onclick: () => fileInput.click() }, icon("upload"), "Restore from backup"),
      fileInput),
    h("p", { class: "dash-help dash-help-last" }, "Restoring adds what's in the file. Nothing on this phone is deleted."));
}

async function saveBackup(e) {
  const button = e.currentTarget;
  button.disabled = true;
  try {
    const backup = await exportBackup();
    const file = new File([JSON.stringify(backup)], `invoices-backup-${todayISO()}.json`, { type: "application/json" });
    const outcome = await shareOrDownload(file);
    if (outcome === "shared") toast("Backup ready. Keep the file somewhere safe.");
    else if (outcome === "downloaded") toast("Backup file saved to your downloads.");
  } catch {
    toast("Couldn't make the backup file. Please try again.");
  } finally {
    button.disabled = false;
  }
}

/** Shares a file with the phone's share sheet when it can, otherwise downloads it. */
async function shareOrDownload(file) {
  if (navigator.canShare?.({ files: [file] })) {
    try {
      await navigator.share({ files: [file], title: file.name });
      return "shared";
    } catch (err) {
      if (err?.name === "AbortError") return "cancelled";
      // Making the file took too long for this tap to count: ask for one more tap.
      if (err?.name === "NotAllowedError") return offerFileAgain(file);
      // Any other sharing problem: download instead.
    }
  }
  downloadFile(file);
  return "downloaded";
}

async function offerFileAgain(file) {
  const choice = await choiceSheet({
    title: "Your backup file is ready",
    message: `${file.name} · ${sizeText(file.size)}`,
    choices: [{ label: "Download", value: "download" }, { label: "Share", value: "share", primary: true }],
  });
  if (choice === "share") {
    try {
      await navigator.share({ files: [file], title: file.name });
      return "shared";
    } catch (err) {
      if (err?.name === "AbortError") return "cancelled";
    }
  } else if (choice !== "download") {
    return "cancelled";
  }
  downloadFile(file);
  return "downloaded";
}

function downloadFile(file) {
  const url = URL.createObjectURL(file);
  const link = h("a", { href: url, download: file.name, hidden: true });
  document.body.append(link);
  link.click();
  link.remove();
  setTimeout(() => URL.revokeObjectURL(url), 60000);
}

async function restoreFromFile(e) {
  const input = e.currentTarget;
  const file = input.files?.[0];
  input.value = "";
  if (!file) return;
  let backup;
  try {
    backup = JSON.parse(await file.text());
  } catch {
    toast("That file isn't a backup from this app.");
    return;
  }
  let counts;
  try {
    counts = await importBackup(backup);
  } catch (err) {
    toast(err.message || "Couldn't restore that file.");
    return;
  }
  callHook("onProductsChanged");
  toast(restoreMessage(counts), { ms: 4500 });
  await refresh();
}

function restoreMessage({ invoicesAdded, invoicesUpdated, productsAdded }) {
  const parts = [];
  if (invoicesAdded) parts.push(plural(invoicesAdded, "new invoice"));
  if (invoicesUpdated) parts.push(plural(invoicesUpdated, "updated invoice"));
  if (productsAdded) parts.push(plural(productsAdded, "new product"));
  if (!parts.length) return "Nothing new: this phone already has everything in that backup.";
  return `Restored ${parts.length > 1 ? `${parts.slice(0, -1).join(", ")} and ${parts.at(-1)}` : parts[0]}.`;
}

function storageSection() {
  const box = h("div", { class: "dash-storage" },
    h("p", { class: "dash-stat" }, icon("receipt"), `${plural(data.invoices.length, "invoice")} saved on this phone.`));
  const extra = h("div", { class: "dash-storage-extra" });
  const showStatus = (st) => {
    const lines = st.persisted
      ? [h("p", { class: "dash-stat is-ok" }, icon("shield"), "Kept safe: the browser won't clear it to free up space.")]
      : [
        h("p", { class: "dash-stat" }, icon("alert"), "The browser could clear saved data if the phone runs low on space. Save a backup file now and then."),
        h("button", { type: "button", class: "btn btn-block", onclick: askToKeep }, icon("shield"), "Ask the browser to keep it"),
      ];
    if (st.usage !== null) lines.push(h("p", { class: "dash-help dash-help-last" }, `Using ${sizeText(st.usage)} of space.`));
    extra.replaceChildren(...lines);
  };
  async function askToKeep() {
    const kept = await requestPersistence();
    toast(kept ? "Done. The browser will keep your data." : "The browser said not yet. Installing the app on your home screen usually helps.");
    showStatus(await storageStatus());
  }
  storageStatus().then(showStatus, () => {});
  box.append(extra);
  return settingsSection("dash-h-storage", "Storage", box);
}

function pinSection() {
  return settingsSection("dash-h-pin", "PIN",
    h("p", { class: "dash-help" }, "The PIN keeps casual eyes out of this dashboard. It doesn't encrypt your invoices."),
    data.pinResetAt ? h("p", { class: "dash-help" }, `PIN was last reset on ${dateTimeText(data.pinResetAt)}.`) : null,
    h("button", { type: "button", class: "btn btn-block", onclick: startPinChange }, icon("lock"), "Change PIN"));
}

function eraseSection() {
  return settingsSection("dash-h-erase", "Start over",
    h("p", { class: "dash-help" }, "Erase every invoice, product and setting on this phone. Save a backup file first if you might need them."),
    h("button", { type: "button", class: "btn btn-danger btn-block", onclick: eraseAll }, icon("trash"), "Erase everything"));
}

async function eraseAll() {
  const session = gate.session;
  const answer = await choiceSheet({
    title: "Erase everything?",
    message: "This deletes every invoice, product and setting on this phone, including your PIN. It can't be undone. Save a backup file first if you might need them.",
    input: { label: "Type ERASE to confirm", placeholder: "ERASE" },
    choices: [{ label: "Cancel", value: false }, { label: "Erase everything", value: true, danger: true }],
  });
  if (!answer || answer.choice !== true || session !== gate.session) return;
  if (answer.text.trim().toUpperCase() !== "ERASE") {
    toast("Nothing was erased. Type ERASE to confirm.");
    return;
  }
  try {
    await eraseEverything();
  } catch (err) {
    toast(err.message || "Couldn't erase. Please try again.");
    return;
  }
  callHook("onProductsChanged");
  toast("Everything on this phone was erased.");
  await refresh();
}

// ── Small helpers ────────────────────────────────────────────────────────

/** A two-or-more-way switch built from real radio buttons (arrow keys work), styled as a segmented control. */
function segmented({ label, labelledBy, options, value, onChange }) {
  const name = `dash-seg-${++segmentCount}`;
  return h("div", { class: "dash-seg", role: "radiogroup", "aria-label": label, "aria-labelledby": labelledBy },
    options.map(([v, text]) => h("label", { class: "dash-seg-opt" },
      h("input", { type: "radio", name, value: String(v), checked: v === value, onchange: () => onChange(v) }),
      h("span", {}, text))));
}

function callHook(name, ...args) {
  const report = (err) => { console.error(err); toast("Something went wrong. Please try again."); };
  try {
    Promise.resolve(hooks[name]?.(...args)).catch(report);
  } catch (err) {
    report(err);
  }
}

const plural = (n, word) => `${n.toLocaleString("en-US")} ${n === 1 ? word : `${word}s`}`;
const moneyCents = (cents) => money(cents / 100);
const monthKey = (iso) => (parseISODate(iso) ? iso.slice(0, 7) : "");
const foldText = (s) => String(s ?? "").normalize("NFD").replace(/[̀-ͯ]/g, "").toLowerCase().replace(/\s+/g, " ").trim();
const signatureSrc = (s) => (typeof s === "string" && /^data:image\/(png|jpeg|webp);base64,/.test(s) ? s : null);
const clockText = (ms) => {
  const s = Math.ceil(ms / 1000);
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`;
};

function waitWords(ms) {
  const s = Math.round(ms / 1000);
  if (s < 60) return plural(s, "second");
  const m = Math.round(s / 60);
  return m < 60 ? plural(m, "minute") : plural(Math.round(m / 60), "hour");
}

function dateTimeText(iso) {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "";
  return `${prettyDate(todayISO(d))} at ${d.toLocaleTimeString("en-US", { hour: "numeric", minute: "2-digit" })}`;
}

function sizeText(bytes) {
  if (bytes < 1024 * 1024) return `${Math.max(1, Math.round(bytes / 1024))} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

function readNoticeSeen() {
  try {
    return localStorage.getItem(NOTICE_SEEN_KEY);
  } catch {
    return null;
  }
}

function writeNoticeSeen(value) {
  try {
    localStorage.setItem(NOTICE_SEEN_KEY, value);
  } catch {
    // Storage blocked (private mode): the notice may show again next time.
  }
}

// ── Icons (inline SVG, 24×24, stroked in currentColor) ───────────────────

const ICONS = {
  alert: "M12 3.5 21.5 20h-19L12 3.5zM12 10v4.5M12 17.5h.01",
  back: "M15 18l-6-6 6-6",
  backspace: "M21 5H9l-6 7 6 7h12a1 1 0 0 0 1-1V6a1 1 0 0 0-1-1zM17 9l-6 6M11 9l6 6",
  check: "M5 12.5l4.5 4.5L19 7.5",
  chevron: "M6 9l6 6 6-6",
  copy: "M9 9h11v11H9zM5 15H4V4h11v1",
  down: "M12 5v14M6 13l6 6 6-6",
  download: "M12 3v12M7 10l5 5 5-5M5 21h14",
  upload: "M12 21V9M7 14l5-5 5 5M5 3h14",
  lock: "M7 11h10a2 2 0 0 1 2 2v6a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2v-6a2 2 0 0 1 2-2zM8.5 11V8a3.5 3.5 0 0 1 7 0v3",
  pencil: "M4 20h4L18.5 9.5l-4-4L4 16v4zM13 7l4 4",
  plus: "M12 5v14M5 12h14",
  printer: "M7 9V3h10v6M7 17H5a2 2 0 0 1-2-2v-4a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2v4a2 2 0 0 1-2 2h-2M7 14h10v7H7z",
  receipt: "M6 3h12v18l-3-2-3 2-3-2-3 2V3zM9 8h6M9 12h6M9 16h3",
  search: "M10.5 4a6.5 6.5 0 1 0 0 13 6.5 6.5 0 0 0 0-13zM20 20l-4.8-4.8",
  share: "M12 3v12M8 7l4-4 4 4M5 12v7a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2v-7",
  shield: "M12 3l8 3v6c0 5-3.5 8-8 9-4.5-1-8-4-8-9V6l8-3zM9 12l2 2 4-4",
  trash: "M4 7h16M9 7V4h6v3M6 7l1 13h10l1-13M10 11v6M14 11v6",
  undo: "M9 14L4 9l5-5M4 9h10.5a5.5 5.5 0 0 1 0 11H11",
  up: "M12 19V5M6 11l6-6 6 6",
};

function icon(name) {
  const ns = "http://www.w3.org/2000/svg";
  const svg = document.createElementNS(ns, "svg");
  svg.setAttribute("viewBox", "0 0 24 24");
  svg.setAttribute("class", "dash-icon");
  svg.setAttribute("aria-hidden", "true");
  svg.setAttribute("focusable", "false");
  const path = document.createElementNS(ns, "path");
  path.setAttribute("d", ICONS[name] || "");
  svg.append(path);
  return svg;
}
