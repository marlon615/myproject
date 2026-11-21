/**
 * Marlon Pro · My Products on the phone: keeps this phone's product list in step with the company's saved products.
 *
 *   - Every Pro phone asks the server for the company's list (when it opens, when the signal comes back, every 5 minutes,
 *     and right after a change). The last list is kept on the phone (with photo thumbnails), so it works offline.
 *   - While the company has saved products, the phone uses exactly those for invoices, returns and orders: the phone's own
 *     products are hidden (not deleted) and come back if the company list is ever emptied. A product's name on the phone
 *     includes its size ("Mango Juice 1 L"), so two sizes are told apart on invoices.
 *   - A solo business's own list becomes its My Products once, the first time (so nothing is lost); a team rep's list
 *     stays until the boss saves the first company product.
 *
 *   startCatalogSync({ onChanged })   syncCatalog() → catalog | null   catalogApi(sub, body)   cachedCatalog()
 */
import { products, settings } from "./db.js";

const CACHE = "catalog";       // { version, canEdit, team, products } — the last list from the server
const SEEDED = "catalogSeeded"; // this solo phone has already offered its own list
let onChanged = () => {};
let running = null;

const license = () => settings.get("license", null);
export const cachedCatalog = () => settings.get(CACHE, null);

/** POST /api/pro/products…, signed with this phone's personal link. */
export async function catalogApi(sub, body = {}) {
  const lic = await license();
  const res = await fetch(`/api/pro/products${sub}`, { method: "POST", headers: { "content-type": "application/json" }, cache: "no-store",
    body: JSON.stringify({ key: lic?.key, device: lic?.device, ...body }) });
  return { ok: res.ok, status: res.status, data: await res.json().catch(() => ({})) };
}

export function syncCatalog() {
  if (running) return running;
  running = (async () => {
    const lic = await license();
    if (!lic?.pro || lic.state === "off" || navigator.onLine === false) return cachedCatalog();
    let r = await catalogApi("").catch(() => null);
    if (!r?.ok || !r.data.pro) return cachedCatalog();
    // A solo business: its own products become My Products the first time (nothing is lost).
    if (r.data.canEdit && !r.data.team && !r.data.products.length && !(await settings.get(SEEDED, false))) {
      const own = (await products.all()).filter((p) => !p.company).map((p) => ({ name: p.name, price: p.price ?? null, unit: p.unit || "each" }));
      if (own.length) {
        const s = await catalogApi("/seed", { products: own }).catch(() => null);
        if (s?.ok) { await settings.set(SEEDED, true); r = await catalogApi("").catch(() => r); }
      } else await settings.set(SEEDED, true);
    }
    const cat = { version: r.data.version, canEdit: r.data.canEdit, team: r.data.team, products: r.data.products, at: new Date().toISOString() };
    const before = await cachedCatalog();
    await settings.set(CACHE, cat);
    const changedList = await products.applyCompany(cat.products);
    if (changedList || before?.version !== cat.version) onChanged(cat);
    return cat;
  })().finally(() => { running = null; });
  return running;
}

export function startCatalogSync(o = {}) {
  onChanged = o.onChanged || onChanged;
  const kick = () => { syncCatalog().catch(() => {}); };
  kick();
  setInterval(kick, 5 * 60 * 1000);
  window.addEventListener("online", kick);
  document.addEventListener("visibilitychange", () => { if (document.visibilityState === "visible") kick(); });
  document.addEventListener("license:pro", kick);
  window.__catalogSync = () => syncCatalog(); // (used by the tests)
}
