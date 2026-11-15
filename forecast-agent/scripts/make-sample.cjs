/**
 * Writes public/sample-sales.csv: 3 years of made-up daily sales for a small drinks-and-snacks distributor
 * (6 products with their own growth and seasons, plus noise). Fixed random seed, so it's the same every time.
 * Usage: node scripts/make-sample.cjs
 */
const fs = require("fs"), path = require("path");
let seed = 42;
const rnd = () => { seed = (seed * 1103515245 + 12345) % 2147483648; return seed / 2147483648; };
const products = [
  { name: "Mango Juice", price: 250, base: 18, growth: 0.012, season: [0.8, 0.8, 0.9, 1.0, 1.1, 1.3, 1.4, 1.4, 1.1, 0.9, 0.9, 1.4] },
  { name: "Coconut Water", price: 180, base: 22, growth: 0.006, season: [0.9, 0.9, 1.0, 1.1, 1.2, 1.3, 1.3, 1.2, 1.0, 0.9, 0.8, 0.9] },
  { name: "Ginger Beer", price: 150, base: 15, growth: 0.002, season: [0.9, 0.9, 1.0, 1.0, 1.0, 1.0, 1.0, 1.0, 1.0, 1.0, 1.1, 1.6] },
  { name: "Sweet Potato Pudding", price: 400, base: 6, growth: -0.004, season: [1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1.5] },
  { name: "Plantain Chips", price: 120, base: 25, growth: 0.015, season: [1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1] },
  { name: "Carrot Juice", price: 250, base: 10, growth: -0.01, season: [1.1, 1.1, 1.0, 1.0, 0.9, 0.9, 0.9, 0.9, 1.0, 1.0, 1.1, 1.1] },
];
const rows = ["Date,Product,Quantity,Sales"];
const end = new Date(Date.UTC(2026, 9, 1));
for (let d = new Date(Date.UTC(2023, 9, 1)); d < end; d.setUTCDate(d.getUTCDate() + 1)) {
  const t = (d.getUTCFullYear() - 2023) * 12 + d.getUTCMonth() - 9; // months since Oct 2023
  for (const p of products) {
    const mean = p.base * Math.pow(1 + p.growth, t) * p.season[d.getUTCMonth()];
    const qty = Math.max(0, Math.round(mean * (0.75 + rnd() * 0.5)));
    if (!qty) continue;
    const date = `${String(d.getUTCDate()).padStart(2, "0")}/${String(d.getUTCMonth() + 1).padStart(2, "0")}/${d.getUTCFullYear()}`;
    rows.push(`${date},${p.name},${qty},"$${(qty * p.price).toLocaleString("en-US", { minimumFractionDigits: 2 })}"`);
  }
}
fs.writeFileSync(path.join(__dirname, "..", "public", "sample-sales.csv"), rows.join("\n") + "\n");
console.log(`public/sample-sales.csv: ${rows.length - 1} rows, 36 months (Oct 2023 to Sep 2026), ${products.length} products`);
