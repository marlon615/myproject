/**
 * The public demo's data: "Harbor & Vine Provisions", a made-up food and drink distributor with three distribution
 * centres in two regions and 12 products, 36 months of sales ending last month (seasons: cold drinks peak in summer,
 * cocoa and baking lines in winter, steady staples), plus stock levels where a few items are deliberately low.
 * Fixed random seed, so every demo shows the same story.
 */
export const DEMO_COMPANY = "Harbor & Vine Provisions (demo)";
export const DEMO_UPLOAD = "Harbor & Vine — sales by distribution centre";

const PRODUCTS = [
  // name, unit price, base units/month per DC, monthly growth, season shape (Jan..Dec), case pack, unit cost, lead days
  ["Sparkling Water 12-pack", 7.5, 900, 0.006, [0.75, 0.75, 0.85, 0.95, 1.1, 1.3, 1.45, 1.4, 1.1, 0.9, 0.8, 0.85], 12, 4.2, 10],
  ["Cold Brew Coffee 4-pack", 11.0, 520, 0.012, [0.8, 0.8, 0.9, 1.0, 1.1, 1.25, 1.35, 1.3, 1.1, 0.95, 0.8, 0.8], 6, 6.1, 14],
  ["Ginger Kombucha 16oz", 3.75, 1300, 0.015, [0.85, 0.85, 0.95, 1.0, 1.1, 1.2, 1.25, 1.2, 1.05, 0.95, 0.85, 0.85], 12, 1.9, 12],
  ["Craft Lager 24-pack", 32.0, 260, 0.002, [0.7, 0.75, 0.85, 0.95, 1.15, 1.35, 1.5, 1.4, 1.05, 0.9, 0.85, 1.25], 1, 21.0, 21],
  ["Orange Juice 1L", 4.25, 1500, -0.002, [1.15, 1.1, 1.05, 1.0, 0.95, 0.9, 0.9, 0.9, 0.95, 1.0, 1.05, 1.15], 12, 2.4, 7],
  ["Oat Milk 1L", 3.95, 1700, 0.01, [1.0, 1.0, 1.0, 1.0, 1.0, 0.95, 0.95, 0.95, 1.0, 1.05, 1.05, 1.05], 12, 2.1, 10],
  ["Sea Salt Kettle Chips", 3.25, 1100, 0.004, [0.9, 1.15, 0.95, 0.95, 1.0, 1.1, 1.15, 1.1, 1.0, 0.95, 0.9, 1.05], 24, 1.6, 14],
  ["Honey Oat Granola Bars", 5.5, 800, 0.008, [1.05, 1.0, 1.0, 0.95, 0.95, 0.9, 0.9, 1.15, 1.2, 1.0, 0.95, 0.95], 12, 2.9, 14],
  ["Dark Chocolate 72%", 3.5, 950, 0.005, [0.9, 1.35, 0.9, 1.0, 0.85, 0.8, 0.75, 0.8, 0.9, 1.1, 1.2, 1.5], 20, 1.7, 21],
  ["Marinara Sauce 24oz", 4.75, 700, 0.001, [1.1, 1.05, 1.0, 0.95, 0.9, 0.9, 0.9, 0.95, 1.0, 1.05, 1.1, 1.1], 12, 2.6, 10],
  ["Extra Virgin Olive Oil 500ml", 9.5, 420, 0.007, [1.0, 0.95, 0.95, 1.0, 1.0, 1.0, 1.0, 1.0, 1.0, 1.05, 1.05, 1.15], 6, 5.8, 28],
  ["Hot Cocoa Mix 12-pack", 6.25, 380, 0.004, [1.6, 1.3, 0.9, 0.6, 0.4, 0.3, 0.3, 0.35, 0.6, 1.0, 1.5, 1.9], 12, 3.1, 14],
];
const CENTRES = [["Seattle DC", "Pacific Northwest", 1.0], ["Portland DC", "Pacific Northwest", 0.7], ["Denver DC", "Mountain West", 0.85]];

export function demoData(now = new Date()) {
  let seed = 20261115;
  const rnd = () => { seed = (seed * 1664525 + 1013904223) % 4294967296; return seed / 4294967296; };
  const end = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() - 1, 1)); // last full month
  const months = Array.from({ length: 36 }, (_, i) => { const d = new Date(Date.UTC(end.getUTCFullYear(), end.getUTCMonth() - 35 + i, 1)); return d.toISOString().slice(0, 7); });
  const series = [], inventory = [];
  for (const [name, price, base, growth, season, pack, cost, lead] of PRODUCTS) {
    for (const [dc, region, size] of CENTRES) {
      const units = months.map((ym, t) => Math.max(0, Math.round(base * size * Math.pow(1 + growth, t) * season[+ym.slice(5, 7) - 1] * (0.92 + rnd() * 0.16))));
      series.push({ product: name, location: dc, region, units, amount: units.map((u) => Math.round(u * price * 100) / 100) });
      // Stock: most items have 3–6 weeks of cover; a few are low or out (so reorder alerts show).
      const daily = units[units.length - 1] / 30;
      const pick = rnd();
      const cover = name === "Cold Brew Coffee 4-pack" && dc === "Seattle DC" ? 0 : name === "Sparkling Water 12-pack" && dc === "Denver DC" ? 4 : name === "Dark Chocolate 72%" && dc === "Portland DC" ? 6 : pick < 0.12 ? 9 : 21 + Math.round(rnd() * 25);
      inventory.push({ product: name, location: dc, onHand: Math.round(daily * cover), onOrder: cover < 10 && rnd() < 0.3 ? pack * 10 : 0, leadDays: lead, casePack: pack, unitCost: cost });
    }
  }
  return { name: DEMO_UPLOAD, months, series, inventory };
}
