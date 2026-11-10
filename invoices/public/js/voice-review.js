/**
 * Review screen for a spoken invoice: check every line before the customer signs, tap any line to fix it.
 * Lines that weren't clearly understood stay highlighted until they're fixed or removed — nothing is guessed.
 *
 * reviewSpokenInvoice(parsed, { products, onSpeakAgain }) → Promise<{ store, address, lines } | null>
 * "Speak again" calls onSpeakAgain() inside the tap (so listening can start straight away) and resolves null.
 */
import {
  UNITS, UNIT_NAMES, defaultUnitFor, h, lastPriceFor, lineTotal, money, normalizeUnit, parseAmount, priceInputText, qtyText,
  qtyWithUnit, sumTotals,
} from "./util.js";

const BLOCKING = new Set(["product", "which", "quantity", "price"]);
const blocking = (line) => Boolean(line.issue && BLOCKING.has(line.issue.kind));

export function reviewSpokenInvoice(parsed, { products, onSpeakAgain } = {}) {
  return new Promise((resolve) => {
    const byId = new Map(products.map((p) => [p.id, p]));
    const lines = parsed.lines.map((l) => ({ ...l }));
    let openKey = null, keySeq = 0;

    const dlg = h("dialog", { class: "review", "aria-labelledby": "review-title" });
    const store = h("input", { type: "text", class: "review-input", autocomplete: "off", autocapitalize: "words", "aria-label": "Store name", placeholder: "Store name" });
    store.value = parsed.store || "";
    const address = h("textarea", { class: "review-input", rows: "2", autocapitalize: "words", "aria-label": "Store address", placeholder: "Store address" });
    address.value = parsed.address || "";
    const list = h("ul", { class: "review-lines", "aria-label": "Products heard" });
    const totalAmt = h("strong", { class: "review-total-amt num" });
    const totalCount = h("span", { class: "review-total-count" });
    const apply = h("button", { type: "button", class: "btn btn-primary btn-block review-apply" });
    const finish = (value) => { dlg.close(); dlg.remove(); resolve(value); };

    const recheck = (line) => {
      const p = line.productId ? byId.get(line.productId) : null;
      if (!p) return { kind: "product", message: line.heard ? `Didn't catch the product (heard “${line.heard}”).` : "Choose the product." };
      if (!(parseAmount(line.qty) > 0)) return { kind: "quantity", message: "How many? Add the amount." };
      if (parseAmount(line.price) === null) return { kind: "noPrice", message: "No price yet. Tap to add it." };
      return null;
    };

    function choose(line, id) {
      const p = byId.get(id);
      if (!p) return;
      line.productId = id;
      line.name = p.name;
      if (!line.unitSaid) line.unit = line.unit || defaultUnitFor(p);
      if (line.price === null) {
        const last = lastPriceFor(p, line.unit);
        if (last !== null) { line.price = last; line.priceFrom = "last time"; }
      }
      line.issue = recheck(line);
      render();
    }

    function editor(line) {
      const sel = h("select", { class: "review-select", "aria-label": "Product" },
        h("option", { value: "" }, "Choose a product…"),
        products.map((p) => h("option", { value: p.id }, p.name)));
      sel.value = line.productId || "";
      const qty = h("input", { type: "text", inputmode: "decimal", class: "review-input num", autocomplete: "off", "aria-label": "Amount", placeholder: "Amount" });
      qty.value = line.qty === null ? "" : qtyText(line.qty);
      const unit = h("select", { class: "review-select", "aria-label": "Unit" }, UNITS.map((u) => h("option", { value: u }, UNIT_NAMES[u])));
      unit.value = normalizeUnit(line.unit);
      const price = h("input", { type: "text", inputmode: "decimal", class: "review-input num", autocomplete: "off", "aria-label": "Price per unit", placeholder: "Add price" });
      price.value = line.price === null ? "" : priceInputText(line.price);
      let priceTyped = false;
      price.addEventListener("input", () => { priceTyped = true; });
      const offerPrice = () => {
        const p = byId.get(sel.value);
        if (!p || priceTyped) return;
        const last = lastPriceFor(p, unit.value);
        price.value = last === null ? "" : priceInputText(last);
      };
      sel.addEventListener("change", () => { const p = byId.get(sel.value); if (p && !line.unitSaid) unit.value = defaultUnitFor(p); offerPrice(); });
      unit.addEventListener("change", offerPrice);

      const save = () => {
        const p = byId.get(sel.value);
        line.productId = p ? p.id : null;
        line.name = p ? p.name : "";
        line.qty = parseAmount(qty.value);
        line.unit = normalizeUnit(unit.value);
        const newPrice = parseAmount(price.value);
        if (newPrice !== line.price) line.priceFrom = newPrice === null ? null : priceTyped ? "typed" : "last time";
        line.price = newPrice;
        line.issue = recheck(line);
        openKey = null;
        render();
      };
      const field = (label, control) => h("label", { class: "review-field" }, h("span", { class: "review-field-label" }, label), control);
      return h("div", { class: "review-editor" },
        field("Product", sel),
        h("div", { class: "review-pair" }, field("Amount", qty), field("Unit", unit)),
        field(`Price per ${unit.value === "lb" ? "pound" : unit.value === "each" ? "item" : unit.value}`, h("span", { class: "review-money" }, h("span", { "aria-hidden": "true" }, "$"), price)),
        h("div", { class: "review-editor-actions" },
          h("button", { type: "button", class: "btn btn-ghost review-remove", onclick: () => { lines.splice(lines.indexOf(line), 1); openKey = null; render(); } }, "Remove line"),
          h("button", { type: "button", class: "btn btn-primary", onclick: save }, "Done")));
    }

    function row(line) {
      const p = line.productId ? byId.get(line.productId) : null;
      const cls = blocking(line) ? " needs-fix" : line.issue ? " needs-look" : "";
      const li = h("li", { class: `review-line${cls}${openKey === line.key ? " is-open" : ""}`, dataset: { key: line.key } });
      const name = p ? p.name : line.heard ? `“${line.heard}”` : "Which product?";
      const calc = `${line.qty === null ? "How many?" : qtyWithUnit(line.qty, line.unit)} × ${line.price === null ? "no price" : money(line.price)}`;
      li.append(h("button", { type: "button", class: "review-line-main", "aria-expanded": String(openKey === line.key), onclick: () => { openKey = openKey === line.key ? null : line.key; render(); } },
        h("span", { class: "review-line-name" }, name),
        h("span", { class: "review-line-calc num" }, calc),
        h("span", { class: "review-line-total num" }, line.qty === null || line.price === null ? "—" : money(lineTotal(line.qty, line.price)))));
      if (line.issue) li.append(h("p", { class: "review-issue" }, line.issue.message));
      else if (line.priceFrom === "last time") li.append(h("p", { class: "review-note" }, "Price from last time"));
      const choices = (line.issue?.choices || []).filter((id) => byId.has(id));
      if (choices.length && openKey !== line.key) {
        li.append(h("div", { class: "review-choices", role: "group", "aria-label": "Choose the product" },
          choices.map((id) => h("button", { type: "button", class: "review-chip", onclick: () => choose(line, id) }, byId.get(id).name))));
      }
      if (openKey === line.key) li.append(editor(line));
      return li;
    }

    function render() {
      list.replaceChildren(...lines.map(row));
      const priced = lines.filter((l) => l.productId && l.qty !== null && l.price !== null);
      totalAmt.textContent = money(sumTotals(priced));
      const n = lines.length;
      totalCount.textContent = `${n} product${n === 1 ? "" : "s"}`;
      const fix = lines.filter(blocking).length;
      apply.disabled = fix > 0 || n === 0;
      apply.textContent = n === 0 ? "Nothing to add yet" : fix ? `Fix ${fix} highlighted line${fix === 1 ? "" : "s"} first` : "Put on invoice";
      store.classList.toggle("needs-look", !store.value.trim());
      const open = list.querySelector(".is-open");
      if (open) requestAnimationFrame(() => open.scrollIntoView({ block: "nearest", behavior: "smooth" }));
    }

    apply.addEventListener("click", () => {
      if (apply.disabled) return;
      finish({
        store: store.value.trim(),
        address: address.value.trim(),
        lines: lines.map((l) => ({ productId: l.productId, qty: parseAmount(l.qty), unit: normalizeUnit(l.unit), price: parseAmount(l.price) })),
      });
    });
    store.addEventListener("input", render);

    const heard = parsed.transcript
      ? h("details", { class: "review-heard" }, h("summary", {}, "What I heard"), h("p", {}, parsed.transcript))
      : null;
    dlg.append(
      h("header", { class: "review-head" },
        h("h2", { id: "review-title" }, "Check before the customer signs"),
        h("p", {}, "Tap any line to fix it. Lines in orange need a look.")),
      h("div", { class: "review-body" },
        h("section", { class: "review-card" },
          h("label", { class: "review-field" }, h("span", { class: "review-field-label" }, "Store"), store),
          h("label", { class: "review-field" }, h("span", { class: "review-field-label" }, parsed.addressFrom === "last time" ? "Address (from last time)" : "Address"), address)),
        list,
        h("button", { type: "button", class: "btn btn-ghost review-add", onclick: () => {
          const line = { key: `r${++keySeq}`, productId: null, name: "", qty: null, unit: "each", price: null, priceFrom: null, heard: "", issue: { kind: "product", message: "Choose the product." } };
          lines.push(line);
          openKey = line.key;
          render();
        } }, "+ Add a line"),
        heard),
      h("footer", { class: "review-foot" },
        h("div", { class: "review-total" }, h("span", { class: "review-total-label" }, "Total", totalCount), totalAmt),
        apply,
        h("div", { class: "review-secondary" },
          h("button", { type: "button", class: "btn btn-ghost", onclick: () => { finish(null); onSpeakAgain?.(); } }, "Speak again"),
          h("button", { type: "button", class: "btn btn-ghost", onclick: () => finish(null) }, "Cancel"))));
    dlg.addEventListener("cancel", (e) => { e.preventDefault(); finish(null); });
    document.body.append(dlg);
    render();
    dlg.showModal();
    dlg.querySelector(".review-head h2").focus?.();
  });
}
