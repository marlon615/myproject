/** Small shared UI pieces (toast and bottom sheets) used by every screen. Styles: base.css (.toast, dialog.sheet). */
import { h } from "./util.js";

let toastEl = null, toastTimer = null;

/** Shows a short message at the bottom of the screen. */
export function toast(message, { ms = 2600 } = {}) {
  if (!toastEl) {
    toastEl = h("div", { class: "toast", role: "status", "aria-live": "polite" });
    document.body.append(toastEl);
  }
  toastEl.textContent = message;
  toastEl.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { toastEl.hidden = true; }, ms);
}

/**
 * Opens a modal sheet with a title, message (string or Node) and buttons.
 * choices: [{ label, value, primary?, danger? }] — resolves with the chosen value, or null if dismissed.
 * Optional `input`: { label, placeholder, type, inputmode } adds a text box; the resolved value is then
 * { choice, text }.
 */
export function choiceSheet({ title, message = "", choices, input = null }) {
  return new Promise((resolve) => {
    let box = null;
    const dlg = h("dialog", { class: "sheet", "aria-labelledby": "sheet-title" });
    const finish = (value) => {
      dlg.close();
      dlg.remove();
      resolve(input && value !== null ? { choice: value, text: box.value } : value);
    };
    const body = typeof message === "string" ? (message ? h("p", {}, message) : null) : message;
    if (input) {
      box = h("input", { type: input.type || "text", placeholder: input.placeholder || "", inputmode: input.inputmode || null, autocomplete: "off", "aria-label": input.label || title });
    }
    dlg.append(
      h("h2", { id: "sheet-title" }, title),
      body,
      input ? h("div", { class: "field" }, input.label ? h("label", {}, input.label) : null, box) : null,
      h("div", { class: "sheet-actions" },
        choices.map((c) => h("button", {
          type: "button",
          class: `btn${c.primary ? " btn-primary" : ""}${c.danger ? " btn-danger" : ""}`,
          onclick: () => finish(c.value),
        }, c.label)),
      ),
    );
    dlg.addEventListener("cancel", (e) => { e.preventDefault(); finish(null); });
    dlg.addEventListener("click", (e) => { if (e.target === dlg) finish(null); }); // tap outside
    document.body.append(dlg);
    dlg.showModal();
    (box || dlg.querySelector(".btn-primary") || dlg.querySelector("button"))?.focus();
  });
}

/** Yes/no question. Resolves true only when the main button is tapped. */
export async function confirmSheet({ title, message = "", okText = "OK", cancelText = "Cancel", danger = false }) {
  const v = await choiceSheet({
    title, message,
    choices: [{ label: cancelText, value: false }, { label: okText, value: true, primary: !danger, danger }],
  });
  return v === true;
}

/** Information with a single button. */
export async function alertSheet({ title, message = "", okText = "OK" }) {
  await choiceSheet({ title, message, choices: [{ label: okText, value: true, primary: true }] });
}
