/**
 * Spoken invoice → store, address and lines, with a business's OWN products (the app ships with none: matching
 * works by sound for whatever products a business types in). Node only. Also the usual-price rules.
 */
(async () => {
  const { parseSpokenInvoice, bestParse, bestParseSegments, _test } = await import("../public/js/voice-parse.js");
  const { fillUsualPrice, qtyWithUnit, money, parseAmount } = await import("../public/js/util.js");
  const { BUSINESS } = require("./fixture.cjs");
  let failures = 0;
  const check = (ok, name, extra = "") => { console.log(`${ok ? "PASS" : "FAIL"}  ${name}${extra ? "  — " + extra : ""}`); if (!ok) failures++; };
  // The products as the app stores them after setup (id, name, usual price, unit).
  const products = BUSINESS.products.map((p, i) => ({ id: `prod_${i}`, name: p.name, price: parseAmount(p.price), unit: p.unit }));
  const byName = Object.fromEntries(products.map((p) => [p.name, p]));
  const ctx = { products, stores: [{ name: "Hill Top Grocery", address: "5 Hope Road\nKingston" }], today: "2026-11-11" };
  const parse = (s) => parseSpokenInvoice(s, ctx);
  const brief = (l) => `${l.name || "?"}|${l.qty}|${l.unit}|${l.price}${l.issue ? "|!" + l.issue.kind : ""}`;
  const nameOf = (id) => products.find((p) => p.id === id)?.name;
  const show = (l) => (l.productId ? l.name : `?(${(l.issue?.choices || []).map(nameOf).join("/")})`) + ` ${l.qty === null ? "?" : qtyWithUnit(l.qty, l.unit)}` + (l.price === null ? "" : ` @${l.price}`);

  // ── The basics ───────────────────────────────────────────────────────────────────────────────────────────────
  let r = parse("Bay Market, 12 King Street, Riverside, two dozen mango juice, one dozen carrot juice, five dozen large patty, fifty pounds sweet potato at two fifty");
  check(r.store === "Bay Market" && r.address === "12 King Street, Riverside", "store and address", `${r.store} | ${r.address}`);
  check(r.lines.map(brief).join(" / ") === "Mango Juice|24|each|null|!noPrice / Carrot Juice|12|each|null|!noPrice / Large Patty|60|each|null|!noPrice / Sweet Potato|50|lb|250",
    "a dozen is 12, pounds, the spoken price (usual prices are added after, on the review screen)", r.lines.map(brief).join(" / "));
  r = parse("bay market 12 king street riverside two dozen mango juice one dozen carrot juice five dozen large patty fifty pounds sweet potato at two fifty");
  check(r.store === "Bay Market" && r.address === "12 King Street, Riverside" && r.lines.length === 4 && r.lines[3].price === 250, "no punctuation: same result", `${r.store} | ${r.address} | ${r.lines.map(brief).join(" / ")}`);

  // The address is never taken from a product line; "today" sets the date.
  r = parse("Bay Market, today, two dozen mango juice, one dozen carrot juice, thirteen ginger beer at 300");
  check(r.address === "" && r.date === "2026-11-11" && r.lines.map(brief).join(" / ") === "Mango Juice|24|each|null|!noPrice / Carrot Juice|12|each|null|!noPrice / Ginger Beer|13|each|300",
    "store, 'today', three products: three lines and an empty address", `${r.address} | ${r.date} | ${r.lines.map(brief).join(" / ")}`);
  r = parse("Hill Top Grocery, 3 coconut water");
  check(r.address === "" && r.savedAddress === "5 Hope Road\nKingston", "a store used before: its address is offered, not filled in", JSON.stringify({ a: r.address, saved: r.savedAddress }));

  // Each business's units: pounds and bags by default for products sold that way; a bare count for dozens.
  r = parse("Bay Market, 5 sweet potato, 3 rice, 30 eggs, 4 yellow yam");
  check(r.lines.map(brief).join(" / ") === "Sweet Potato|5|lb|null|!noPrice / Rice|3|bag|null|!noPrice / Eggs|30|each|null|!noPrice / Yellow Yam|4|lb|null|!noPrice",
    "sold by the pound or the bag: a bare amount is pounds or bags; sold by the dozen: '30 eggs' is 30 eggs", r.lines.map(brief).join(" / "));
  r = parse("Bay Market, two dozen eggs, 2 bags of rice at 1500");
  check(r.lines.map(brief).join(" / ") === "Eggs|24|each|null|!noPrice / Rice|2|bag|1500", "'two dozen eggs' is 24 eggs; bags said", r.lines.map(brief).join(" / "));
  r = parse("Bay Market, 3 rice, 2 bags of rice at 1500");
  check(r.lines.map(brief).join(" / ") === "Rice|5|bag|1500", "the same product said twice is added up on one line", r.lines.map(brief).join(" / "));

  // A true tie asks, with both as one-tap choices.
  r = parse("Bay Market, 6 patty, 2 small patty");
  check(r.lines[0].issue?.kind === "which" && (r.lines[0].issue.choices || []).map(nameOf).sort().join(",") === "Large Patty,Small Patty" && r.lines[1].name === "Small Patty",
    "'patty' alone: Small or Large? (asked, not guessed)", r.lines.map(show).join(" | "));

  // ── Messy speech, as phones really write it ──────────────────────────────────────────────────────────────────
  const MESSY = [
    ["bay market 24 mango juice at 3:15 per unit 16 carrot juices 2:30 per unit 12 ginger beer to 50 per unit",
      "Bay Market", "Mango Juice 24 @315 | Carrot Juice 16 @230 | Ginger Beer 12 @250"],
    ["uh bay market today um two dozen mangoes juice one dozen of the carrot juices and thirteen ginger beers at 300 dollars each please",
      "Bay Market", "Mango Juice 24 | Carrot Juice 12 | Ginger Beer 13 @300"],
    ["Bay market. Twelfth of the 11th 20 26. 12 King Street. 24 mango juice, $315 per unit. 16 coconut water, $230 per unit.",
      "Bay Market", "Mango Juice 24 @315 | Coconut Water 16 @230"],
    ["hope store 2 dozen large patties 1 dozen small pattys 3 dozen patty and 6 scallions",
      "Hope Store", "Large Patty 24 | Small Patty 12 | ?(Small Patty/Large Patty) 36 | Scallion 6"],
    ["corner shop 10 pound sweet potatoes at 120 a pound 5 pounds of yellow yams 140 a pound six bags of rice 2 hard dough bred",
      "Corner Shop", "Sweet Potato 10 lb @120 | Yellow Yam 5 lb @140 | Rice 6 bags | Hard Dough Bread 2"],
    ["hill top grocery twenty 4 coconut water 20 4 mango juice 250 each 2 dozen eggs 1 dozen ginger beer",
      "Hill Top Grocery", "Coconut Water 24 | Mango Juice 24 @250 | Eggs 24 | Ginger Beer 12"],
    ["mega mart three coco nut water six ginger bear 4 hard dough breads two lbs of sweet potato",
      "Mega Mart", "Coconut Water 3 | Ginger Beer 6 | Hard Dough Bread 4 | Sweet Potato 2 lb"],
    ["general foods yeah so give me like 24 of the mango juice and um 16 carrot juice yeah at 230 and a dozen eggs",
      "General Foods", "Mango Juice 24 | Carrot Juice 16 @230 | Eggs 12"],
    ["bay market 2 doz mango 1 doz carrots 5 doz large patty 50 lb sweet potato at 1:20",
      "Bay Market", "Mango Juice 24 | Carrot Juice 12 | Large Patty 60 | Sweet Potato 50 lb @120"],
    ["best foods twenty-four mango juice three fifteen per unit sixteen carrot juices two thirty per unit twelve ginger beers two fifty per unit",
      "Best Foods", "Mango Juice 24 @315 | Carrot Juice 16 @230 | Ginger Beer 12 @250"],
    ["the order for bay market is 24 mango juice at three fifteen and sixteen coconut water at two thirty and twelve ginger beer at two fifty thank you",
      "Bay Market", "Mango Juice 24 @315 | Coconut Water 16 @230 | Ginger Beer 12 @250"],
    ["Bay market 24 mango juice 315 per unit 16 carrot juice 230 per unit 12 King Street Riverside",
      "Bay Market", "Mango Juice 24 @315 | Carrot Juice 16 @230"],
    ["island mart 3 bags rice at fifteen hundred 4 dozen egg 2 skallion",
      "Island Mart", "Rice 3 bags @1500 | Eggs 48 | Scallion 2"],
    ["corner store 5 yello yam 3 sweet potato 2 small pattie",
      "Corner Store", "Yellow Yam 5 lb | Sweet Potato 3 lb | Small Patty 2"],
    ["Bay Market, 6 mango juice, 7 widgets, 3 coconut water",
      "Bay Market", "Mango Juice 6 | ?(…) 7 | Coconut Water 3"],
  ];
  const report = ["# Messy speech with a business's own products: what the phone wrote → what the review shows", ""];
  MESSY.forEach(([said, wantStore, want], k) => {
    const x = parseSpokenInvoice(said, { products, today: "2026-11-11" });
    let got = x.lines.map(show).join(" | ");
    const gotCmp = got.replace(/\?\((?!Small Patty\/Large Patty)[^)]*\)/g, "?(…)"); // which products are offered for "widgets" doesn't matter here
    check(x.store === wantStore && gotCmp === want, `messy ${k + 1}: ${said.slice(0, 60)}…`, gotCmp === want ? "" : `${x.store} | ${got}`);
    check(x.lines.every((l) => l.productId || (l.issue?.choices || []).length > 0), `messy ${k + 1}: every unclear line offers a product to tap`);
    report.push(`${k + 1}. **Heard:** ${said}`, `   **Store:** ${x.store}${x.address ? ` · **Address:** ${x.address}` : ""}${x.date ? ` · **Date:** ${x.date}` : ""}`,
      `   **Lines:** ${x.lines.map((l) => (l.productId ? `${l.name} ${qtyWithUnit(l.qty, l.unit)}${l.price === null ? "" : ` × ${money(l.price)}`}` : `“${l.heard || l.said}” ${l.qty === null ? "" : qtyWithUnit(l.qty, l.unit)} (tap: ${(l.issue?.choices || []).map(nameOf).join(" or ")})`)).join("; ")}`, "");
  });
  require("fs").mkdirSync(require("path").join(__dirname, "output"), { recursive: true });
  require("fs").writeFileSync(require("path").join(__dirname, "output", "voice-messy-results.md"), report.join("\n"));

  // Everyday words never become a product.
  for (const w of ["money", "time", "line", "paper", "cream", "many", "honey", "big up", "street", "lunch", "fine", "my friend", "water"]) {
    const x = parseSpokenInvoice(`Hope Store, 2 mango juice, ${w}, 3 rice`, { products });
    const named = x.lines.filter((l) => l.productId).map((l) => l.name).join(",");
    check(named === "Mango Juice,Rice" || (w === "water" && named === "Mango Juice,Coconut Water,Rice"), `'${w}' is never taken as a product on its own`, x.lines.map(show).join(" | "));
  }

  // Several guesses from the phone: the one matching the most products wins; nothing said is dropped.
  let b = bestParse(["Bay Market two dozen mango", "Bay Market two dozen mango one dozen carrot juice"], ctx);
  check(b.lines.map((l) => l.name).join(",") === "Mango Juice,Carrot Juice", "a guess that lost a line is never preferred", b.lines.map(brief).join(" / "));
  b = bestParseSegments([["Bay Market today"], ["two dozen man go juice", "two dozen mango juice"], ["one dozen carrot juice"], ["13 ginger bee at 300", "13 ginger beer at 300"]], ctx);
  check(b.lines.map(brief).join(" / ") === "Mango Juice|24|each|null|!noPrice / Carrot Juice|12|each|null|!noPrice / Ginger Beer|13|each|300" && b.address === "",
    "phrase by phrase: misheard phrases put right from the phone's other guesses", b.lines.map(brief).join(" / "));
  b = bestParseSegments([["Bay Market"], ["two dozen mango juice"], ["three blorps", "three blorbs"], ["one dozen carrot juice"]], ctx);
  check(b.lines.length === 3 && b.lines[1].issue?.kind === "product" && b.lines[1].qty === 3, "a phrase no guess can match still stays, highlighted", b.lines.map(brief).join(" / "));

  // Dates and numbers (same rules for every business).
  r = parse("Bay Market, 12th of the 11th 2026, 12 King Street, Riverside, 24 mango juice 315 per unit");
  check(r.date === "2026-11-12" && r.address === "12 King Street, Riverside", "a spoken date sets the date and stays out of the address", `${r.date} | ${r.address}`);
  const N = (s) => _test.readNumber(_test.tokenize(s), 0)?.value;
  const PR = (s) => _test.readPrice(_test.tokenize(s), 0)?.value;
  check(N("two hundred and fifty") === 250 && N("one thousand two hundred") === 1200 && N("one and a half") === 1.5, "number words");
  check(PR("two fifty") === 250 && PR("twelve fifty") === 1250 && PR("two dollars fifty cents") === 2.5 && PR("three seventy five") === 375, "spoken prices");

  // ── Usual prices (from setup), filled in only when no price was said ─────────────────────────────────────────
  const L = (qty, unit, price = null) => ({ qty, unit, price, priceFrom: price === null ? null : "said", saidAs: "" });
  let l = L(24, "each");
  check(fillUsualPrice(l, byName["Mango Juice"]) && l.price === 250 && l.priceFrom === "list", "no price said: the usual price ($250 each)");
  l = L(24, "each", 315);
  check(!fillUsualPrice(l, byName["Mango Juice"]) && l.price === 315, "a price that was said always wins");
  l = L(50, "lb");
  check(fillUsualPrice(l, byName["Sweet Potato"]) && l.price === 120, "per pound: $120 a pound");
  l = L(5, "each");
  check(!fillUsualPrice(l, byName["Sweet Potato"]) && l.price === null, "said in a different unit than the usual price: left for the owner to price");
  l = L(24, "each");
  check(fillUsualPrice(l, byName.Eggs) && l.qty === 2 && l.unit === "dozen" && l.price === 480, "eggs at $480 a dozen: 24 eggs → 2 dozen × $480", JSON.stringify(l));
  l = L(30, "each");
  check(fillUsualPrice(l, byName.Eggs) && l.qty === 30 && l.unit === "each" && l.price === 40, "30 eggs at $480 a dozen → 30 × $40.00 ($1,200)", JSON.stringify(l));
  l = L(30, "each");
  check(fillUsualPrice(l, { ...byName.Eggs, price: 500 }) && l.price === 41.67, "30 eggs at $500 a dozen → 30 × $41.67 (to the cent)", JSON.stringify(l));
  l = L(3, "bag");
  check(fillUsualPrice(l, byName.Rice) && l.price === 1500, "per bag: $1,500 a bag");
  l = L(6, "each");
  check(!fillUsualPrice(l, byName["Small Patty"]) && l.price === null, "a product with no usual price stays unpriced");

  console.log(failures ? `\n${failures} check(s) failed` : "\nAll voice-parse checks passed");
  process.exit(failures ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
