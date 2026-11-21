/**
 * A made-up business for the tests (the app itself ships blank: each business types its own on first open).
 *   const { BUSINESS, setUp } = require("./fixture.cjs");
 *   await page.goto(url); await setUp(page);          // fills the first-run setup screen and taps "Start invoicing"
 * Products cover: list prices per item, per pound, per dozen and per bag; no price; a Small/Large pair.
 */
const BUSINESS = Object.freeze({
  name: "Island Fresh Distributors",
  address: "8 Harbour Street\nKingston",
  phone: "876 555 0123",
  products: Object.freeze([
    { name: "Mango Juice", price: "250", unit: "each" },
    { name: "Carrot Juice", price: "250", unit: "each" },
    { name: "Coconut Water", price: "180", unit: "each" },
    { name: "Ginger Beer", price: "150", unit: "each" },
    { name: "Small Patty", price: "", unit: "each" },
    { name: "Large Patty", price: "", unit: "each" },
    { name: "Sweet Potato", price: "120", unit: "lb" },
    { name: "Yellow Yam", price: "", unit: "lb" },
    { name: "Eggs", price: "480", unit: "dozen" },
    { name: "Hard Dough Bread", price: "320", unit: "each" },
    { name: "Rice", price: "1500", unit: "bag" },
    { name: "Scallion", price: "", unit: "each" },
  ]),
});

/** Completes the first-run setup screen with `b` and waits for the invoice screen. */
async function setUp(page, b = BUSINESS) {
  await page.waitForFunction(() => window.__appReady === true, null, { timeout: 15000 });
  await page.waitForSelector("#setup-name", { timeout: 15000 });
  if (await page.getAttribute("#setup-name", "readonly") === null) await page.fill("#setup-name", b.name); // a team rep's company is filled in and locked
  await page.fill("#setup-address", b.address || "");
  await page.fill("#setup-phone", b.phone || "");
  const rows = () => page.locator(".setup-prow");
  for (let i = 0; i < b.products.length; i++) {
    if (i >= await rows().count()) await page.click(".setup-add");
    const r = rows().nth(i), p = b.products[i];
    await r.locator(".setup-pname").fill(p.name);
    await r.locator(".setup-pprice").fill(p.price || "");
    await r.locator(".setup-punit").selectOption(p.unit || "each");
  }
  await page.click(".setup-start");
  await page.waitForSelector("#invoice-screen:not([hidden])", { timeout: 10000 });
  await page.waitForFunction((n) => document.getElementById("company-name")?.textContent === n, b.name, { timeout: 5000 });
}

/** A personal link's key for the tests (the local test server lets any well-formed key work on up to 100 phones). */
const TEST_KEY = "0123456789abcdef0123456789abcdef";
/** The app's address as a buyer first opens it: their personal link. */
const appUrl = (srv, extra = "") => `${srv.url}/?${extra ? extra + "&" : ""}k=${TEST_KEY}`;

module.exports = { BUSINESS, setUp, TEST_KEY, appUrl };
