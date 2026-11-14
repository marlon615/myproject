/**
 * First-run setup: the business types its company name, address and phone, and adds its products with their
 * prices. Saved on this phone only (IndexedDB); nothing is sent anywhere. Shown until it's finished; everything can
 * be changed later in the owner dashboard → Settings.
 *
 *   const business = await runSetup(rootElement)   // resolves after "Start invoicing"
 */
import { profile, products } from "./db.js";
import { UNITS, UNIT_NAMES, h, parseAmount, priceInputText, tidy } from "./util.js";
import { toast } from "./ui.js";

const DRAFT_KEY = "marlon.setupDraft"; // what was typed so far, if the app is closed half-way (this phone only)

const readDraft = () => { try { return JSON.parse(localStorage.getItem(DRAFT_KEY) || "null"); } catch { return null; } };
const writeDraft = (d) => { try { localStorage.setItem(DRAFT_KEY, JSON.stringify(d)); } catch { /* private mode: fine */ } };
const clearDraft = () => { try { localStorage.removeItem(DRAFT_KEY); } catch { /* fine */ } };

export function runSetup(root) {
  return new Promise((resolve) => {
    const draft = readDraft() || {};
    const field = (label, control, hint = null) => h("label", { class: "setup-field" },
      h("span", { class: "setup-label" }, label), control, hint ? h("span", { class: "setup-hint" }, hint) : null);

    const name = h("input", { type: "text", id: "setup-name", autocomplete: "organization", autocapitalize: "words", maxlength: "80", required: true, placeholder: "e.g. Island Fresh Distributors" });
    const address = h("textarea", { id: "setup-address", rows: "2", autocomplete: "street-address", autocapitalize: "words", maxlength: "200", placeholder: "Street, town" });
    const phone = h("input", { type: "tel", id: "setup-phone", autocomplete: "tel", inputmode: "tel", maxlength: "40", placeholder: "e.g. 876 555 0123" });
    name.value = draft.name || "";
    address.value = draft.address || "";
    phone.value = draft.phone || "";

    const list = h("ul", { class: "setup-products", "aria-label": "Your products" });
    function productRow(p = {}) {
      const pName = h("input", { type: "text", class: "setup-pname", autocapitalize: "words", maxlength: "60", placeholder: "Product name", "aria-label": "Product name" });
      const pPrice = h("input", { type: "text", class: "setup-pprice num", inputmode: "decimal", autocomplete: "off", placeholder: "Price", "aria-label": "Price" });
      const pUnit = h("select", { class: "setup-punit", "aria-label": "Sold by" }, UNITS.map((u) => h("option", { value: u }, u === "each" ? "each" : `per ${UNIT_NAMES[u]}`)));
      pName.value = p.name || "";
      pPrice.value = p.price === undefined || p.price === null ? "" : priceInputText(p.price);
      pUnit.value = UNITS.includes(p.unit) ? p.unit : "each";
      const remove = h("button", { type: "button", class: "btn btn-icon setup-remove", "aria-label": "Remove this product", onclick: () => { li.remove(); save(); if (!list.children.length) addRow(); } }, "×");
      const li = h("li", { class: "setup-prow" }, pName, h("span", { class: "setup-money" }, h("span", { "aria-hidden": "true" }, "$"), pPrice), pUnit, remove);
      return li;
    }
    const addRow = (p) => { const li = productRow(p); list.append(li); return li; };
    (draft.products?.length ? draft.products : [{}, {}, {}]).forEach(addRow);

    const readAll = () => ({
      name: name.value, address: address.value, phone: phone.value,
      products: [...list.querySelectorAll(".setup-prow")].map((li) => ({
        name: li.querySelector(".setup-pname").value, price: li.querySelector(".setup-pprice").value, unit: li.querySelector(".setup-punit").value,
      })),
    });
    const save = () => writeDraft(readAll());

    const error = h("p", { class: "setup-error", role: "alert", hidden: true });
    const start = h("button", { type: "submit", class: "btn btn-primary btn-block btn-tall setup-start" }, "Start invoicing");
    const form = h("form", { class: "setup", novalidate: true, "aria-labelledby": "setup-title" },
      h("header", { class: "setup-head" },
        h("p", { class: "setup-kicker" }, "Welcome to Marlon"),
        h("h1", { id: "setup-title" }, "Set up your business"),
        h("p", { class: "setup-lead" }, "It takes a minute. Everything you type here stays on this phone.")),
      h("section", { class: "card setup-card", "aria-labelledby": "setup-h-business" },
        h("h2", { class: "setup-h", id: "setup-h-business" }, "Your business"),
        field("Company name", name, "Shows at the top of the app and on every receipt."),
        field("Address", address),
        field("Phone", phone)),
      h("section", { class: "card setup-card", "aria-labelledby": "setup-h-products" },
        h("h2", { class: "setup-h", id: "setup-h-products" }, "Your products"),
        h("p", { class: "setup-hint setup-hint-top" }, "Add what you sell, with your usual price. You can change a price on any invoice."),
        list,
        h("button", { type: "button", class: "btn btn-ghost setup-add", onclick: () => { addRow().querySelector("input").focus(); } }, "+ Add another product")),
      h("p", { class: "setup-note" }, "You can change all of this later: owner dashboard → Settings."),
      h("p", { class: "setup-note setup-privacy" }, "Your customers, invoices and prices never leave this phone. The app only sends anonymous counts (how many invoices, no names or amounts) so its maker can see how many businesses use it. You can turn that off in Settings."),
      error,
      start);

    form.addEventListener("input", save);
    form.addEventListener("change", save);
    form.addEventListener("submit", async (e) => {
      e.preventDefault();
      const all = readAll();
      error.hidden = true;
      if (!tidy(all.name)) {
        error.textContent = "Type your company name first.";
        error.hidden = false;
        name.focus();
        return;
      }
      const items = all.products.map((p) => ({ name: tidy(p.name), price: parseAmount(p.price), rawPrice: tidy(p.price), unit: p.unit }));
      const badPrice = items.find((p) => p.name && p.rawPrice && p.price === null);
      if (badPrice) {
        error.textContent = `Check the price of ${badPrice.name}: numbers only, like 250 or 12.50.`;
        error.hidden = false;
        return;
      }
      const nameless = items.find((p) => !p.name && p.rawPrice);
      if (nameless) {
        error.textContent = "Give each product with a price a name (or clear its price).";
        error.hidden = false;
        return;
      }
      start.disabled = true;
      start.textContent = "Saving…";
      try {
        const seen = new Set();
        for (const p of items) {
          const key = p.name.toLowerCase();
          if (!p.name || seen.has(key)) continue;
          seen.add(key);
          await products.add(p.name, { price: p.price, unit: p.unit });
        }
        const saved = await profile.set({ name: all.name, address: all.address, phone: all.phone });
        clearDraft();
        resolve(saved);
      } catch (err) {
        start.disabled = false;
        start.textContent = "Start invoicing";
        toast(err?.message || "Couldn't save on this phone. Free up some space, then try again.");
      }
    });

    root.replaceChildren(form);
    requestAnimationFrame(() => { if (!name.value) name.focus({ preventScroll: true }); });
  });
}
