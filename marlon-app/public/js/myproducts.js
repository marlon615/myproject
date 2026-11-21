/**
 * Marlon Pro · My Products — the company's own products (name, size, price, how it's sold, up to 3 photos taken with
 * the phone camera). Kept on the server for that company only; shelf photo matches only these products.
 * Shared by the owner's dashboard on a solo phone (can edit), a team rep's dashboard (read only) and the boss
 * dashboard (can edit). The page passes its own way of talking to the server:
 *
 *   myProductsSection({ load: () => catalog | null, api: (sub, body) => { ok, status, data }, onChanged, readOnlyNote })
 *     catalog: { canEdit, products: [{ id, name, size, price, unit, photos: [{ id, thumb }] }] }
 *     sub: "" | "/save" | "/delete" | "/photo" | "/photo-delete" | "/photo-get"   (POST /api/pro/products…)
 */
import { h, money } from "./util.js";

const UNITS = [["each", "Each"], ["dozen", "Per dozen"], ["bag", "Per bag"], ["lb", "Per lb"]];
const unitText = (u) => (UNITS.find(([v]) => v === u) || UNITS[0])[1].toLowerCase();
const priceText = (p) => (p.price === null || p.price === undefined ? "no price" : `${money(p.price)} ${p.unit === "each" ? "each" : unitText(p.unit)}`);

/** A camera photo, shrunk on the phone: the product photo (512 px) and a small thumbnail, both JPEG base64. */
export async function shrinkPhoto(file) {
  const url = URL.createObjectURL(file);
  try {
    const img = await new Promise((ok, no) => { const i = new Image(); i.onload = () => ok(i); i.onerror = () => no(new Error("That photo couldn't be opened.")); i.src = url; });
    const draw = (max, q) => {
      const k = Math.min(1, max / Math.max(img.naturalWidth, img.naturalHeight));
      const c = document.createElement("canvas");
      c.width = Math.max(1, Math.round(img.naturalWidth * k)); c.height = Math.max(1, Math.round(img.naturalHeight * k));
      c.getContext("2d").drawImage(img, 0, 0, c.width, c.height);
      const d = c.toDataURL("image/jpeg", q);
      return d.slice(d.indexOf(",") + 1);
    };
    return { image: draw(512, 0.72), thumb: draw(120, 0.6) };
  } finally { URL.revokeObjectURL(url); }
}

export function myProductsSection({ load, api, onChanged = () => {}, readOnlyNote = "Your boss manages your company's products." }) {
  const box = h("section", { class: "mp", id: "my-products", "aria-labelledby": "mp-h" });
  const msg = (text, bad = false) => h("p", { class: bad ? "mp-msg is-bad" : "mp-msg", role: bad ? "alert" : "status" }, text);
  let cat = null, editing = null, notice = null;

  async function refresh() {
    cat = await load();
    render();
  }
  async function call(sub, body) {
    let r;
    try { r = await api(sub, body); } catch { r = null; }
    if (!r) return { ok: false, data: { error: "No connection. Adding or changing products needs the internet." } };
    return r;
  }
  async function changed(text) {
    notice = text ? msg(text) : null;
    editing = null;
    await onChanged();
    await refresh();
  }

  function render() {
    if (!cat) { box.replaceChildren(h("h2", { class: "section-title mp-title", id: "mp-h" }, "My Products"), msg("Your products load when you're online.")); return; }
    const list = cat.products || [];
    const put = (...nodes) => box.replaceChildren(...nodes.flat().filter((n) => n !== null && n !== undefined && n !== false)); // (replaceChildren would print "null")
    put(
      h("div", { class: "mp-head" }, h("h2", { class: "section-title mp-title", id: "mp-h" }, "My Products"), h("span", { class: "mp-count", id: "mp-count" }, `${list.length} product${list.length === 1 ? "" : "s"}`)),
      h("p", { class: "mp-note" }, cat.canEdit
        ? "Your company's own products, with photos. Shelf photo matches only these, and shows “Unknown product” for anything else. Only your company can see them."
        : `${readOnlyNote} Shelf photo matches only these products.`),
      notice,
      cat.canEdit && editing !== "new" ? h("button", { type: "button", class: "btn btn-primary btn-block mp-add", id: "mp-add", onclick: () => { editing = "new"; notice = null; render(); } }, "+ Add a product") : null,
      editing === "new" ? editor(null) : null,
      list.length ? h("ul", { class: "mp-list" }, list.map((p) => editing === p.id ? h("li", { class: "mp-item is-editing" }, editor(p)) : item(p)))
        : editing === "new" ? null : h("p", { class: "mp-empty" }, cat.canEdit ? "No products yet. Add your first one: its name, size, price and a photo." : "No company products yet."));
  }

  function item(p) {
    return h("li", { class: "mp-item", dataset: { id: p.id } },
      h("div", { class: "mp-thumbs" }, p.photos.length ? p.photos.map((ph) => h("button", { type: "button", class: "mp-thumb", "aria-label": `Photo of ${p.name}`, onclick: () => viewPhoto(ph.id, p) },
        h("img", { src: `data:image/jpeg;base64,${ph.thumb}`, alt: "" }))) : h("span", { class: "mp-nophoto", "aria-hidden": "true" }, "No photo")),
      h("div", { class: "mp-info" }, h("strong", { class: "mp-name" }, p.name), p.size ? h("span", { class: "mp-size" }, p.size) : null, h("span", { class: "mp-price" }, priceText(p))),
      cat.canEdit ? h("button", { type: "button", class: "btn btn-small mp-edit", "aria-label": `Edit ${p.name}`, onclick: () => { editing = p.id; notice = null; render(); } }, "Edit") : null);
  }

  function editor(p) {
    const isNew = !p;
    const name = h("input", { type: "text", class: "mp-in-name", maxlength: "80", autocapitalize: "words", placeholder: "e.g. Mango Juice", value: p?.name || "" });
    const size = h("input", { type: "text", class: "mp-in-size", maxlength: "40", placeholder: "e.g. 1 L, 500 g, 24-pack", value: p?.size || "" });
    const price = h("input", { type: "text", class: "mp-in-price", inputmode: "decimal", placeholder: "0.00", value: p?.price === null || p?.price === undefined ? "" : String(p.price.toFixed(2)) });
    const unit = h("select", { class: "mp-in-unit" }, UNITS.map(([v, l]) => h("option", { value: v }, l)));
    unit.value = p?.unit || "each";
    const err = h("p", { class: "mp-msg is-bad", role: "alert", hidden: true });
    const fail = (t) => { err.textContent = t; err.hidden = false; };
    const file = h("input", { type: "file", accept: "image/*", capture: "environment", class: "mp-file", hidden: true });
    const photos = p ? [...p.photos] : [];
    const pending = []; // photos taken before a new product is first saved
    const strip = h("div", { class: "mp-photos" });
    const drawPhotos = () => strip.replaceChildren(...[ // (nulls filtered: replaceChildren would print "null")
      ...photos.map((ph) => h("div", { class: "mp-ph" }, h("img", { src: `data:image/jpeg;base64,${ph.thumb}`, alt: "Product photo" }),
        h("button", { type: "button", class: "mp-ph-x", "aria-label": "Delete this photo", onclick: async () => {
          if (!confirm("Delete this photo?")) return;
          const r = await call("/photo-delete", { productId: p.id, photoId: ph.id });
          if (!r.ok) return fail(r.data.error || "That didn't work.");
          photos.splice(photos.indexOf(ph), 1); drawPhotos(); await onChanged();
        } }, "×"))),
      ...pending.map((ph, i) => h("div", { class: "mp-ph is-new" }, h("img", { src: `data:image/jpeg;base64,${ph.thumb}`, alt: "New photo (saved with the product)" }),
        h("button", { type: "button", class: "mp-ph-x", "aria-label": "Remove this photo", onclick: () => { pending.splice(i, 1); drawPhotos(); } }, "×"))),
      photos.length + pending.length < 3 ? h("button", { type: "button", class: "btn mp-photo-add", onclick: () => file.click() }, photos.length + pending.length ? "+ Another photo" : "+ Take a photo") : null].filter(Boolean));
    file.addEventListener("change", async () => {
      const f = file.files?.[0]; file.value = "";
      if (!f) return;
      err.hidden = true;
      let shot; try { shot = await shrinkPhoto(f); } catch (e) { return fail(e.message); }
      if (isNew) { pending.push(shot); drawPhotos(); return; }
      const r = await call("/photo", { productId: p.id, ...shot });
      if (!r.ok) return fail(r.data.error || "The photo couldn't be saved.");
      photos.push(r.data.photo); drawPhotos(); await onChanged();
    });
    drawPhotos();
    const save = h("button", { type: "button", class: "btn btn-primary mp-save", onclick: async () => {
      err.hidden = true;
      if (!name.value.trim()) return fail("Type the product's name.");
      if (price.value.trim() && !/^\$?\s*\d+(\.\d{1,2})?$/.test(price.value.trim().replace(/,/g, ""))) return fail("The price should be a number, like 2.50.");
      save.disabled = true; save.textContent = "Saving…";
      const r = await call("/save", { product: { id: p?.id, name: name.value, size: size.value, price: price.value.trim().replace(/[$,\s]/g, "") || null, unit: unit.value } });
      if (!r.ok) { save.disabled = false; save.textContent = "Save"; return fail(r.data.error || "That didn't work."); }
      for (const ph of pending) {
        const pr = await call("/photo", { productId: r.data.product.id, ...ph });
        if (!pr.ok) { await changed(`Saved ${r.data.product.name}, but a photo couldn't be saved: ${pr.data.error || "try again"}.`); return; }
      }
      await changed(`${isNew ? "Added" : "Saved"} ${r.data.product.name}${r.data.product.size ? ` (${r.data.product.size})` : ""}.`);
    } }, "Save");
    const del = isNew ? null : h("button", { type: "button", class: "btn btn-ghost mp-delete", onclick: async () => {
      if (!confirm(`Delete ${p.name}${p.size ? ` (${p.size})` : ""} from My Products? Its photos are deleted too. Invoices already made keep it.`)) return;
      const r = await call("/delete", { id: p.id });
      if (!r.ok) return fail(r.data.error || "That didn't work.");
      await changed(`Deleted ${p.name}.`);
    } }, "Delete product");
    const field = (label, input) => h("label", { class: "mp-field" }, h("span", {}, label), input);
    return h("div", { class: "mp-editor" },
      h("h3", { class: "mp-ed-title" }, isNew ? "New product" : `Edit ${p.name}`),
      field("Name", name), h("div", { class: "mp-row" }, field("Size", size), field("Price", price), field("Sold", unit)),
      h("div", { class: "mp-field" }, h("span", {}, "Photos (up to 3)"), strip, file),
      err,
      h("div", { class: "mp-actions" }, save, h("button", { type: "button", class: "btn mp-cancel", onclick: () => { editing = null; render(); } }, "Cancel"), del));
  }

  async function viewPhoto(photoId, p) {
    const dlg = h("dialog", { class: "mp-viewer", "aria-label": `Photo of ${p.name}` });
    const close = () => { dlg.close(); dlg.remove(); };
    dlg.append(h("p", {}, "Loading the photo…"));
    dlg.addEventListener("click", (e) => { if (e.target === dlg) close(); });
    document.body.append(dlg); dlg.showModal();
    const r = await call("/photo-get", { photoId });
    dlg.replaceChildren(
      r.ok ? h("img", { src: `data:image/jpeg;base64,${r.data.image}`, alt: `Photo of ${p.name}` }) : h("p", {}, r.data.error || "The photo couldn't be loaded."),
      h("p", { class: "mp-viewer-cap" }, `${p.name}${p.size ? ` · ${p.size}` : ""}`),
      h("button", { type: "button", class: "btn btn-block", onclick: close }, "Close"));
  }

  refresh();
  return box;
}
