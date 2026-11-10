/** Spoken invoice → store, address and lines. Node only. */
(async () => {
  const { parseSpokenInvoice, bestParse, _test } = await import("../public/js/voice-parse.js");
  const { DEFAULT_PRODUCTS, defaultProductId } = await import("../public/js/util.js");
  let failures = 0;
  const check = (ok, name, extra = "") => { console.log(`${ok ? "PASS" : "FAIL"}  ${name}${extra ? "  — " + extra : ""}`); if (!ok) failures++; };
  const products = DEFAULT_PRODUCTS.map((name, i) => ({ id: defaultProductId(i), name }));
  const P = Object.fromEntries(products.map((p) => [p.name, p]));
  P["Beetroot Juice"].lastPrice = 350;            // each
  P["Okra"].lastPrice = 240;                      // per lb (okra's usual unit)
  P["Cucumber Juice"].lastPrices = { dozen: 3800 };
  products.push({ id: "c_sorrel", name: "Sorrel Drink", custom: true });
  const ctx = { products, stores: [{ name: "Rose Hall Grocery", address: "12 Main Street, Montego Bay" }] };
  const brief = (l) => `${l.name || "?"}|${l.qty}|${l.unit}|${l.price}${l.issue ? "|!" + l.issue.kind : ""}`;
  const parse = (s) => parseSpokenInvoice(s, ctx);

  // The owner's own example, with dictation commas.
  let r = parse("Sarah Supermarket, 14 Wellington Street, Brownstone, two dozen beetroot juice, one dozen cucumber juice, five dozen large bammy, fifty pounds okra at two fifty");
  check(r.store === "Sarah Supermarket", "store", r.store);
  check(r.address === "14 Wellington Street, Brownstone", "address", r.address);
  check(r.lines.map(brief).join(" / ") === "Beetroot Juice|2|dozen|null|!noPrice / Cucumber Juice|1|dozen|3800 / Large Bammy|5|dozen|null|!noPrice / Okra|50|lb|250",
    "lines: dozens, pounds, spoken price, per-unit last price, no conversion", r.lines.map(brief).join(" / "));
  check(r.lines[1].priceFrom === "last time" && r.lines[3].priceFrom === "said", "price sources");

  // Same thing as speech recognition often returns it: no punctuation at all.
  r = parse("sarah supermarket 14 wellington street brownstone two dozen beetroot juice one dozen cucumber juice five dozen large bammy fifty pounds okra at two fifty");
  check(r.store === "Sarah Supermarket" && r.address === "14 Wellington Street, Brownstone" && r.lines.length === 4 && r.lines[3].price === 250, "no punctuation: same result", `${r.store} | ${r.address} | ${r.lines.map(brief).join(" / ")}`);

  // Number words in the address, "and", money forms, half, "a dozen", bags.
  r = parse("Lime Tree Wholesale fourteen Red Hills Road Kingston a dozen limes at twelve hundred and half a dozen lemons for 600 and 3 bags of grapefruit at $1,250 and two and a half pounds hot pepper");
  check(r.store === "Lime Tree Wholesale", "store containing a product word (Lime) stays the store", r.store);
  check(r.address === "14 Red Hills Road, Kingston", "number words in the address become digits", r.address);
  check(r.lines.map(brief).join(" / ") === "Limes|1|dozen|1200 / Lemons|0.5|dozen|600 / Grapefruit|3|bag|1250 / Hot Pepper|2.5|lb|null|!noPrice",
    "a dozen, half a dozen, bags, $1,250, hot pepper by weight", r.lines.map(brief).join(" / "));

  // Weight products default to pounds; amount after the product; "a pound".
  r = parse("Rose Hall Grocery okra 10 pounds at three hundred a pound hot pepper 4 pounds at 450");
  check(r.store === "Rose Hall Grocery" && r.address === "12 Main Street, Montego Bay" && r.addressFrom === "last time", "known store fills its address", `${r.store} | ${r.address}`);
  check(r.lines.map(brief).join(" / ") === "Okra|10|lb|300 / Hot Pepper|4|lb|450", "amount after the product, 'a pound'", r.lines.map(brief).join(" / "));

  // Mishearings that should still match; ambiguity that must not be guessed.
  r = parse("Halfway Tree Market, to dozen beet root juice, one dozen bammy, 6 kalaloo at 200, two dozen blorp");
  check(r.lines[0].name === "Beetroot Juice" && r.lines[0].qty === 2 && r.lines[0].unit === "dozen" && r.lines[0].issue?.kind === "noPrice", "'to dozen beet root juice' → 2 dozen Beetroot Juice (no dozen price known, so it asks)", brief(r.lines[0]));
  check(r.lines[1].issue && (r.lines[1].issue.kind === "product" || r.lines[1].issue.kind === "which") && r.lines[1].issue.choices.length === 2 && r.lines[1].issue.choices.every((id) => ["p05", "p06"].includes(id)),
    "'bammy' alone is not guessed: Mini or Large?", JSON.stringify(r.lines[1].issue));
  check(r.lines[2].name === "Shredded Callaloo" && r.lines[2].qty === 6 && r.lines[2].price === 200 && !r.lines[2].issue, "'kalaloo' → Shredded Callaloo", brief(r.lines[2]));
  check(r.lines[3].issue?.kind === "product" && /blorp/.test(r.lines[3].issue.message) && r.lines[3].qty === 2, "unknown word is highlighted, not guessed", JSON.stringify(r.lines[3]));

  // Custom product, juicify names, price shorthands.
  r = parse("Sunrise Mart 8 sorrel drink at one twenty, juicify fruit punch 24 at three seventy five, 12 grape at two oh five, 2 dozen pumpkin punch at 4200");
  check(r.lines.map(brief).join(" / ") === "Sorrel Drink|8|each|120 / Juicify Drink Fruit Punch|24|each|375 / Juicify Drink Grape|12|each|205 / Pumpkin Punch|2|dozen|4200",
    "custom product, Juicify names, 'one twenty', 'three seventy five', 'two oh five'", r.lines.map(brief).join(" / "));

  // Missing amount, unreadable price, and the same product twice.
  r = parse("Corner Shop, beetroot juice at banana, okra 5 pounds, okra 3 pounds");
  check(r.lines[0].name === "Beetroot Juice" && r.lines[0].issue && ["price", "quantity"].includes(r.lines[0].issue.kind), "unreadable price / missing amount is highlighted", JSON.stringify(r.lines[0].issue));
  const okra = r.lines.filter((l) => l.name === "Okra");
  check(okra.length === 1 && okra[0].qty === 8 && okra[0].price === 240, "same product twice in the same unit: one line, amounts added", okra.map(brief).join(" / "));

  // Nothing but products: no store heard.
  r = parse("2 dozen beetroot juice");
  check(r.store === "" && r.storeIssue && r.lines.length === 1, "no store said: flagged, products still read");

  // "and" between a price and the next product belongs to the next product.
  r = parse("Corner Shop 6 Hope Road three pounds hot pepper at four hundred and two bags limes at 1200 and okra at two hundred and fifty");
  check(r.store === "Corner Shop" && r.address === "6 Hope Road", "store and address before the products (no commas)", `${r.store} | ${r.address}`);
  check(r.lines.map(brief).join(" / ") === "Hot Pepper|3|lb|400 / Limes|2|bag|1200 / Okra|null|lb|250|!quantity",
    "'at four hundred and two bags limes' = 400, then 2 bags of limes; 'two hundred and fifty' = 250", r.lines.map(brief).join(" / "));

  // Numbers and prices.
  const N = (s) => _test.readNumber(_test.tokenize(s), 0)?.value;
  const PR = (s) => _test.readPrice(_test.tokenize(s), 0)?.value;
  check(N("two hundred and fifty") === 250 && N("one thousand two hundred") === 1200 && N("twenty five") === 25 && N("one and a half") === 1.5 && N("two point five") === 2.5, "number words");
  check(PR("two fifty") === 250 && PR("twelve fifty") === 1250 && PR("three hundred") === 300 && PR("two dollars fifty cents") === 2.5 && PR("$ 2.50") === 2.5 && PR("three seventy five") === 375, "spoken prices");

  // Best of several possible transcripts.
  const best = bestParse(["Market two dozen blorp juice", "Market two dozen beetroot juice"], ctx);
  check(best.lines[0].name === "Beetroot Juice" && best.lines[0].issue?.kind !== "product", "picks the clearer of two transcripts", brief(best.lines[0]));

  console.log(failures ? `\n${failures} check(s) failed` : "\nAll voice-parse checks passed");
  process.exit(failures ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
