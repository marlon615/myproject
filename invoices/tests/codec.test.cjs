/** QR payload format (SPEC.md "C: js/codec.js"): exact encoding, round trips, strict rejection, capacity. Node only. */
(async () => {
  const { encodePayload, parseInvoiceHash, invoiceToUrl, invoiceToText } = await import("../public/js/codec.js");
  const { makeQr } = await import("../public/js/qr.js");
  const { DEFAULT_PRODUCTS } = await import("../public/js/util.js");
  let failures = 0;
  const check = (ok, name, extra = "") => { console.log(`${ok ? "PASS" : "FAIL"}  ${name}${extra ? "  — " + extra : ""}`); if (!ok) failures++; };
  const ORIGIN = "https://marlon-invoices.marlon615.workers.dev";

  const inv = { seller: "Marlon Williams", number: 7, date: "2026-11-10", store: "Rose Hall Grocery", address: "12 Main St\nMontego Bay",
    items: [{ name: "Beetroot Juice", qty: 12, price: 350 }, { name: "Mini Bammy", qty: 24, price: 150 }, { name: "Coconut Water", qty: 6, price: null }], signature: "data:x" };
  const url = invoiceToUrl(inv, ORIGIN);
  check(url === `${ORIGIN}/v#1~Marlon+Williams~7~20261110~Rose+Hall+Grocery~12+Main+St%0AMontego+Bay~@0,12,350*@4,24,150*Coconut+Water,6,~7800~s`, "exact example from SPEC.md", url);
  const back = parseInvoiceHash(url.slice(url.indexOf("#")));
  check(back && back.store === "Rose Hall Grocery" && back.address === "12 Main St\nMontego Bay" && back.items.length === 3 && back.items[2].price === null && back.total === 7800 && back.computedTotal === 7800 && back.signed, "round trip");

  const weird = { number: 1, date: "2026-01-02", store: "Café ~*!'(),@+ “Best” 😀", address: "", items: [{ name: "@0 tricky, name~*", qty: 1.5, price: 12.25 }, { name: "Okra", qty: 2, price: 100 }] };
  const w = parseInvoiceHash(encodePayload(weird));
  check(w && w.store === weird.store && w.items[0].name === "@0 tricky, name~*" && w.items[0].qty === 1.5 && w.items[0].price === 12.25 && w.items[1].name === "Okra" && w.total === 218.38 && !w.signed, "separator characters, unicode, emoji and decimals survive");
  check(parseInvoiceHash("#1~a~1~20261110~~~~0~").items.length === 0, "an invoice with no items is still valid");

  const bad = ["", "#", "#2~a~1~20261110~~~~0~", "#1~a~x~20261110~~~~0~", "#1~a~1~20261310~~~~0~", "#1~%E0%A4%A~1~20261110~~~~0~",
    "#1~a~1~20261110~~~@99,1,1~0~", "#1~a~1~20261110~~~a,1~0~", "#1~a~1~20261110~~~~0~x", "#1~a~1~20261110~~~~-1~", "#1" + "~a".repeat(5000),
    "#1~a~1~20261110~~~a,1e5,1~0~", "#1~" + "x".repeat(400) + "~1~20261110~~~~0~"];
  for (const b of bad) check(parseInvoiceHash(b) === null, `rejects malformed: ${JSON.stringify(b.slice(0, 36))}`);

  const big = { number: 9999, date: "2026-12-31", signature: "x", store: "Sunrise Wholesale and Retail Supermarket Ltd, Branch 2", address: "12 Long Road Name Avenue, Some District, Parish Name, Jamaica W.I. 12 Long Road Name Avenue, Some District, Pa",
    items: [...DEFAULT_PRODUCTS.map((n, i) => ({ name: n, qty: 100 + i, price: 1234.5 })), ...[1, 2, 3, 4].map((i) => ({ name: `Custom Product Number ${i}XY`.slice(0, 25), qty: 12.5, price: 99999.99 }))] };
  const q1 = makeQr(invoiceToUrl(big, ORIGIN), { ecc: "M" });
  check(q1.version <= 25, "worst-case link QR fits (ECC M ≤ version 25)", `version ${q1.version}`);
  const q2 = makeQr(invoiceToText(big), { ecc: "L" });
  check(q2.version <= 40, "worst-case text QR fits (ECC L ≤ version 40)", `version ${q2.version}`);
  check(makeQr(url, { ecc: "M" }).version <= 10, "a typical invoice makes a small, easy-to-scan QR", `version ${makeQr(url, { ecc: "M" }).version}`);
  let threw = ""; try { makeQr("x".repeat(4000)); } catch (e) { threw = e.message; }
  check(threw === "QR_TOO_LONG", "too-long text fails clearly");

  // Units travel in the QR (a letter after the amount); links made before units still read as "each".
  const withUnits = { number: 3, date: "2026-11-11", store: "Sarah Supermarket", address: "", items: [
    { name: "Beetroot Juice", qty: 2, unit: "dozen", price: 3800 }, { name: "Okra", qty: 50, unit: "lb", price: 250 }, { name: "Limes", qty: 3, unit: "bag", price: 1200 }, { name: "Lemons", qty: 6, price: 50 }] };
  const enc2 = encodePayload(withUnits);
  check(enc2.includes("@0,2d,3800") && enc2.includes("@13,50p,250") && enc2.includes("@11,3b,1200") && enc2.includes("@10,6,50"), "units encoded compactly", enc2);
  const back2 = parseInvoiceHash(enc2);
  check(back2 && back2.items.map((i) => i.unit).join(",") === "dozen,lb,bag,each" && back2.total === 24000, "units read back", JSON.stringify(back2 && back2.items.map((i) => [i.qty, i.unit])));
  check(parseInvoiceHash("#1~Marlon+Williams~7~20261110~Shop~~@0,12,350~4200~").items[0].unit === "each", "old links (no units) still read");
  check(parseInvoiceHash("#1~a~1~20261110~~~@0,2x,1~2~") === null, "an unknown unit letter is rejected");
  check(invoiceToText(withUnits).includes("  2 dozen x $3,800.00 = $7,600.00") && invoiceToText(withUnits).includes("  50 lb x $250.00") && invoiceToText(withUnits).includes("  3 bags x $1,200.00"), "plain-text QR shows units");

  const t = invoiceToText(inv);
  check(t.startsWith("INVOICE No. 0007\nMarlon Williams\nDate: 10 Nov 2026\nStore: Rose Hall Grocery\nAddress: 12 Main St, Montego Bay\n") && t.includes("  6 x (no price) = $0.00") && t.endsWith("TOTAL: $7,800.00\n3 items - Signed by customer: Yes"), "plain-text invoice layout");
  console.log(failures ? `\n${failures} check(s) failed` : "\nAll codec checks passed");
  process.exit(failures ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
