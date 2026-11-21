/** QR payload format v2 (js/codec.js): exact encoding, the business's name and phone, round trips, strict rejection, capacity. Node only. */
(async () => {
  const { encodePayload, parseInvoiceHash, invoiceToUrl, invoiceToText } = await import("../public/js/codec.js");
  const { makeQr } = await import("../public/js/qr.js");
  const { setBusiness } = await import("../public/js/util.js");
  const { BUSINESS } = require("./fixture.cjs");
  let failures = 0;
  const check = (ok, name, extra = "") => { console.log(`${ok ? "PASS" : "FAIL"}  ${name}${extra ? "  — " + extra : ""}`); if (!ok) failures++; };
  const ORIGIN = "https://marlon-app.marlon615.workers.dev";

  const inv = { seller: "Island Fresh Distributors", sellerPhone: "876 555 0123", number: 7, date: "2026-11-10", store: "Hill Top Grocery", address: "5 Hope Rd\nKingston",
    items: [{ name: "Mango Juice", qty: 12, price: 350 }, { name: "Small Patty", qty: 24, price: 150 }, { name: "Coconut Water", qty: 6, price: null }], signature: "data:x" };
  const url = invoiceToUrl(inv, ORIGIN);
  check(url === `${ORIGIN}/v#2~Island+Fresh+Distributors~876+555+0123~7~20261110~Hill+Top+Grocery~5+Hope+Rd%0AKingston~Mango+Juice,12,350*Small+Patty,24,150*Coconut+Water,6,~7800~s`, "exact v2 link: business name and phone, then the invoice; products by name", url);
  const back = parseInvoiceHash(url.slice(url.indexOf("#")));
  check(back && back.v === 2 && back.seller === "Island Fresh Distributors" && back.sellerPhone === "876 555 0123" && back.store === "Hill Top Grocery" && back.address === "5 Hope Rd\nKingston"
    && back.items.length === 3 && back.items[0].name === "Mango Juice" && back.items[2].price === null && back.total === 7800 && back.computedTotal === 7800 && back.signed, "round trip");

  // The business's own details fill in when the invoice doesn't carry them (from setup).
  setBusiness({ name: BUSINESS.name, address: BUSINESS.address, phone: BUSINESS.phone });
  const plain = { number: 2, date: "2026-11-11", store: "Bay Market", address: "", items: [{ name: "Eggs", qty: 24, unit: "each", price: 40 }] };
  check(encodePayload(plain).startsWith("2~Island+Fresh+Distributors~876+555+0123~2~20261111~Bay+Market~~Eggs,24,40~960~"), "an invoice without its own seller details uses the business set up on this phone", encodePayload(plain));
  setBusiness({ name: "", address: "", phone: "" });
  check(encodePayload(plain).startsWith("2~~~2~"), "with no business set up, the seller fields are simply empty (never someone else's)", encodePayload(plain).slice(0, 12));

  // Links made in the old format (version 1, no phone) still open.
  const v1 = parseInvoiceHash("#1~Some+Shop~7~20261110~Bay+Market~~Mango+Juice,12,350~4200~s");
  check(v1 && v1.seller === "Some Shop" && v1.sellerPhone === "" && v1.items[0].name === "Mango Juice" && v1.total === 4200 && v1.signed, "a version-1 link (no phone) still reads", JSON.stringify(v1 && { seller: v1.seller, phone: v1.sellerPhone }));
  check(parseInvoiceHash("#1~Some+Shop~7~20261110~Shop~~@0,12,350~4200~") === null, "a version-1 link with another app's built-in product codes is refused (its products aren't this app's)");

  const weird = { seller: "Café ~*!'()", sellerPhone: "+1 (876) 555-0123", number: 1, date: "2026-01-02", store: "Café ~*!'(),@+ “Best” 😀", address: "", items: [{ name: "@0 tricky, name~*", qty: 1.5, price: 12.25 }, { name: "Sweet Potato", qty: 2, price: 100 }] };
  const w = parseInvoiceHash(encodePayload(weird));
  check(w && w.seller === weird.seller && w.sellerPhone === weird.sellerPhone && w.store === weird.store && w.items[0].name === "@0 tricky, name~*" && w.items[0].qty === 1.5 && w.items[0].price === 12.25
    && w.items[1].name === "Sweet Potato" && w.total === 218.38 && !w.signed, "separator characters, unicode, emoji, a phone with brackets and decimals survive");
  check(parseInvoiceHash("#2~a~~1~20261110~~~~0~").items.length === 0, "an invoice with no items is still valid");

  const bad = ["", "#", "#3~a~~1~20261110~~~~0~", "#2~a~~x~20261110~~~~0~", "#2~a~~1~20261310~~~~0~", "#2~%E0%A4%A~~1~20261110~~~~0~", "#2~a~%E0%A4%A~1~20261110~~~~0~",
    "#2~a~~1~20261110~~~@1,1,1~0~", "#2~a~~1~20261110~~~a,1~0~", "#2~a~~1~20261110~~~~0~x", "#2~a~~1~20261110~~~~-1~", "#2" + "~a".repeat(5000),
    "#2~a~~1~20261110~~~a,1e5,1~0~", "#2~" + "x".repeat(400) + "~~1~20261110~~~~0~", "#2~a~1~20261110~~~~0~", "#1~a~~1~20261110~~~~0~"];
  for (const b of bad) check(parseInvoiceHash(b) === null, `rejects malformed: ${JSON.stringify(b.slice(0, 36))}`);

  const big = { seller: "Sunrise Wholesale Distributors Limited", sellerPhone: "+1 876 555 0123 ext 204", number: 9999, date: "2026-12-31", signature: "x", store: "Sunrise Wholesale and Retail Supermarket Ltd, Branch 2",
    address: "12 Long Road Name Avenue, Some District, Parish Name, Jamaica W.I. 12 Long Road Name Avenue, Some District, Pa",
    items: Array.from({ length: 18 }, (_, i) => ({ name: `Product Name Number ${i + 1} Big`.slice(0, 25), qty: 100 + i, price: 1234.5 })) };
  const q1 = makeQr(invoiceToUrl(big, ORIGIN), { ecc: "M" });
  check(q1.version <= 25, "worst-case link QR (18 long product names) fits (ECC M ≤ version 25)", `version ${q1.version}`);
  const q2 = makeQr(invoiceToText(big), { ecc: "L" });
  check(q2.version <= 40, "worst-case text QR fits (ECC L ≤ version 40)", `version ${q2.version}`);
  check(makeQr(url, { ecc: "M" }).version <= 10, "a typical invoice makes a small, easy-to-scan QR", `version ${makeQr(url, { ecc: "M" }).version}`);
  let threw = ""; try { makeQr("x".repeat(4000)); } catch (e) { threw = e.message; }
  check(threw === "QR_TOO_LONG", "too-long text fails clearly");

  // Units travel in the QR (a letter after the amount).
  const withUnits = { seller: "Island Fresh Distributors", sellerPhone: "", number: 3, date: "2026-11-11", store: "Bay Market", address: "", items: [
    { name: "Eggs", qty: 2, unit: "dozen", price: 480 }, { name: "Sweet Potato", qty: 50, unit: "lb", price: 120 }, { name: "Rice", qty: 3, unit: "bag", price: 1500 }, { name: "Ginger Beer", qty: 6, price: 150 }] };
  const enc2 = encodePayload(withUnits);
  check(enc2.includes("Eggs,2d,480") && enc2.includes("Sweet+Potato,50p,120") && enc2.includes("Rice,3b,1500") && enc2.includes("Ginger+Beer,6,150"), "units encoded compactly", enc2);
  const back2 = parseInvoiceHash(enc2);
  check(back2 && back2.items.map((i) => i.unit).join(",") === "dozen,lb,bag,each" && back2.total === 960 + 6000 + 4500 + 900, "units read back", JSON.stringify(back2 && back2.items.map((i) => [i.qty, i.unit])));
  check(parseInvoiceHash("#2~a~~1~20261110~~~x,2x,1~2~") === null, "an unknown unit letter is rejected");
  const tu = invoiceToText(withUnits);
  check(tu.includes("  2 dozen x $480.00 = $960.00") && tu.includes("  50 lb x $120.00") && tu.includes("  3 bags x $1,500.00"), "plain-text QR shows units");

  const t = invoiceToText(inv);
  check(t.startsWith("INVOICE No. 0007\nIsland Fresh Distributors\nTel: 876 555 0123\nDate: 10 Nov 2026\nStore: Hill Top Grocery\nAddress: 5 Hope Rd, Kingston\n") && t.includes("  6 x (no price) = $0.00")
    && t.endsWith("TOTAL: $7,800.00\n3 items - Signed by customer: Yes"), "plain-text invoice layout (with the business's phone)", t.split("\n").slice(0, 3).join(" / "));
  console.log(failures ? `\n${failures} check(s) failed` : "\nAll codec checks passed");
  process.exit(failures ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
