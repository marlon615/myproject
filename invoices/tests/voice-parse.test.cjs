/** Spoken invoice → store, address and lines. Node only. */
(async () => {
  const { parseSpokenInvoice, bestParse, _test } = await import("../public/js/voice-parse.js");
  const { DEFAULT_PRODUCTS, defaultProductId } = await import("../public/js/util.js");
  let failures = 0;
  const check = (ok, name, extra = "") => { console.log(`${ok ? "PASS" : "FAIL"}  ${name}${extra ? "  — " + extra : ""}`); if (!ok) failures++; };
  const products = DEFAULT_PRODUCTS.map((name, i) => ({ id: defaultProductId(i), name }));
  const P = Object.fromEntries(products.map((p) => [p.name, p]));
  // Old saved prices (from before prices became per-invoice) must be ignored completely.
  P["Beetroot Juice"].lastPrice = 350;
  P["Okra"].lastPrice = 240;
  P["Cucumber Juice"].lastPrices = { dozen: 3800 };
  products.push({ id: "c_sorrel", name: "Sorrel Drink", custom: true });
  const ctx = { products, stores: [{ name: "Rose Hall Grocery", address: "12 Main Street, Montego Bay" }], today: "2026-11-10" };
  const { sumTotals } = await import("../public/js/util.js");
  const brief = (l) => `${l.name || "?"}|${l.qty}|${l.unit}|${l.price}${l.issue ? "|!" + l.issue.kind : ""}`;
  const parse = (s) => parseSpokenInvoice(s, ctx);

  // The owner's own example, with dictation commas.
  let r = parse("Sarah Supermarket, 14 Wellington Street, Brownstone, two dozen beetroot juice, one dozen cucumber juice, five dozen large bammy, fifty pounds okra at two fifty");
  check(r.store === "Sarah Supermarket", "store", r.store);
  check(r.address === "14 Wellington Street, Brownstone", "address", r.address);
  check(r.lines.map(brief).join(" / ") === "Beetroot Juice|24|each|null|!noPrice / Cucumber Juice|12|each|null|!noPrice / Large Bammy|60|each|null|!noPrice / Okra|50|lb|250",
    "lines: a dozen is 12, pounds, the spoken price; nothing filled in from earlier invoices", r.lines.map(brief).join(" / "));
  check(r.lines.slice(0, 3).map((l) => l.saidAs).join(",") === "2 dozen,1 dozen,5 dozen", "what was said in dozens is kept as a hint", r.lines.map((l) => l.saidAs).join(","));
  check(r.lines[3].priceFrom === "said" && r.lines.every((l) => l.priceFrom === "said" || l.price === null), "prices only ever come from what was said");

  // Same thing as speech recognition often returns it: no punctuation at all.
  r = parse("sarah supermarket 14 wellington street brownstone two dozen beetroot juice one dozen cucumber juice five dozen large bammy fifty pounds okra at two fifty");
  check(r.store === "Sarah Supermarket" && r.address === "14 Wellington Street, Brownstone" && r.lines.length === 4 && r.lines[3].price === 250, "no punctuation: same result", `${r.store} | ${r.address} | ${r.lines.map(brief).join(" / ")}`);

  // Number words in the address, "and", money forms, half, "a dozen", bags.
  r = parse("Lime Tree Wholesale fourteen Red Hills Road Kingston a dozen limes at twelve hundred a dozen and half a dozen lemons for 60 and 3 bags of grapefruit at $1,250 and two and a half pounds hot pepper");
  check(r.store === "Lime Tree Wholesale", "store containing a product word (Lime) stays the store", r.store);
  check(r.address === "14 Red Hills Road, Kingston", "number words in the address become digits", r.address);
  check(r.lines.map(brief).join(" / ") === "Limes|12|each|100 / Lemons|6|each|60 / Grapefruit|3|bag|1250 / Hot Pepper|2.5|lb|null|!noPrice",
    "a dozen (price a dozen → per item), half a dozen, bags, $1,250, hot pepper by weight", r.lines.map(brief).join(" / "));

  // Weight products default to pounds; amount after the product; "a pound".
  r = parse("Rose Hall Grocery okra 10 pounds at three hundred a pound hot pepper 4 pounds at 450");
  check(r.store === "Rose Hall Grocery" && r.address === "12 Main Street, Montego Bay" && r.addressFrom === "last time", "known store fills its address", `${r.store} | ${r.address}`);
  check(r.lines.map(brief).join(" / ") === "Okra|10|lb|300 / Hot Pepper|4|lb|450", "amount after the product, 'a pound'", r.lines.map(brief).join(" / "));

  // Mishearings that should still match; ambiguity that must not be guessed.
  r = parse("Halfway Tree Market, to dozen beet root juice, one dozen bammy, 6 kalaloo at 200, two dozen blorp");
  check(r.lines[0].name === "Beetroot Juice" && r.lines[0].qty === 24 && r.lines[0].unit === "each" && r.lines[0].issue?.kind === "noPrice", "'to dozen beet root juice' → 24 Beetroot Juice (no price said)", brief(r.lines[0]));
  check(r.lines[1].issue && (r.lines[1].issue.kind === "product" || r.lines[1].issue.kind === "which") && r.lines[1].issue.choices.length === 2 && r.lines[1].issue.choices.every((id) => ["p05", "p06"].includes(id)),
    "'bammy' alone is not guessed: Mini or Large?", JSON.stringify(r.lines[1].issue));
  check(r.lines[2].name === "Shredded Callaloo" && r.lines[2].qty === 6 && r.lines[2].price === 200 && !r.lines[2].issue, "'kalaloo' → Shredded Callaloo", brief(r.lines[2]));
  check(r.lines[3].issue?.kind === "product" && /blorp/.test(r.lines[3].issue.message) && r.lines[3].qty === 24, "an amount said for a word that matches no product is highlighted, not guessed", JSON.stringify(r.lines[3]));

  // Custom product, juicify names, price shorthands.
  r = parse("Sunrise Mart 8 sorrel drink at one twenty, juicify fruit punch 24 at three seventy five, 12 grape at two oh five, 2 dozen pumpkin punch at 4200 a dozen");
  check(r.lines.map(brief).join(" / ") === "Sorrel Drink|8|each|120 / Juicify Drink Fruit Punch|24|each|375 / Juicify Drink Grape|12|each|205 / Pumpkin Punch|24|each|350",
    "custom product, Juicify names, 'one twenty', 'three seventy five', 'two oh five'", r.lines.map(brief).join(" / "));

  // Missing amount, unreadable price, and the same product twice.
  r = parse("Corner Shop, beetroot juice at banana, okra 5 pounds, okra 3 pounds");
  check(r.lines[0].name === "Beetroot Juice" && r.lines[0].issue && ["price", "quantity"].includes(r.lines[0].issue.kind), "unreadable price / missing amount is highlighted", JSON.stringify(r.lines[0].issue));
  const okra = r.lines.filter((l) => l.name === "Okra");
  check(okra.length === 1 && okra[0].qty === 8 && okra[0].price === null, "same product twice in the same unit: one line, amounts added (no old price)", okra.map(brief).join(" / "));

  // Nothing but products: no store heard.
  r = parse("2 dozen beetroot juice");
  check(r.store === "" && r.storeIssue && r.lines.length === 1, "no store said: flagged, products still read");

  // "and" between a price and the next product belongs to the next product.
  r = parse("Corner Shop 6 Hope Road three pounds hot pepper at four hundred and two bags limes at 1200 and okra at two hundred and fifty");
  check(r.store === "Corner Shop" && r.address === "6 Hope Road", "store and address before the products (no commas)", `${r.store} | ${r.address}`);
  check(r.lines.map(brief).join(" / ") === "Hot Pepper|3|lb|400 / Limes|2|bag|1200 / Okra|null|lb|250|!quantity",
    "'at four hundred and two bags limes' = 400, then 2 bags of limes; 'two hundred and fifty' = 250", r.lines.map(brief).join(" / "));

  // The owner's test: prices said after each product, "per unit".
  r = parse("Sarah Supermarket, 14 Wellington Street, Brownstone, 24 beetroot juice 315 per unit, 16 green juice 230 per unit, 12 pumpkin punch 250 per unit");
  check(r.store === "Sarah Supermarket" && r.address === "14 Wellington Street, Brownstone", "test sentence: store and address", `${r.store} | ${r.address}`);
  check(r.lines.map(brief).join(" / ") === "Beetroot Juice|24|each|315 / Green Juice|16|each|230 / Pumpkin Punch|12|each|250", "test sentence: three clean lines, no warnings", r.lines.map(brief).join(" / "));
  check(sumTotals(r.lines) === 14240, "test sentence: 24×315 + 16×230 + 12×250 = $14,240", String(sumTotals(r.lines)));
  check(!r.lines.some((l) => /per|unit|each/i.test(l.name + l.heard)), "'per unit' never becomes a product line");

  // Every way of saying a unit price after the product.
  const one = (s) => parse(`Shop, ${s}`).lines.map(brief).join(" / ");
  check(one("24 beetroot, 315 per unit") === "Beetroot Juice|24|each|315", "'24 beetroot, 315 per unit'", one("24 beetroot, 315 per unit"));
  check(one("16 green juice at 230") === "Green Juice|16|each|230", "'16 green juice at 230'", one("16 green juice at 230"));
  check(one("12 pumpkin punch 250 each") === "Pumpkin Punch|12|each|250", "'250 each'", one("12 pumpkin punch 250 each"));
  check(one("2 dozen pumpkin punch 4200 per dozen") === "Pumpkin Punch|24|each|350", "'2 dozen … 4200 per dozen' = 24 at 350", one("2 dozen pumpkin punch 4200 per dozen"));
  check(one("2 dozen pumpkin punch at 250") === "Pumpkin Punch|24|each|250", "a price after dozens is per item unless 'per dozen' is said", one("2 dozen pumpkin punch at 250"));
  check(one("3 dozen lemons at 100 per dozen") === "Lemons|3|dozen|100", "a price per dozen that doesn't split to the cent keeps the line in dozens", one("3 dozen lemons at 100 per dozen"));
  check(one("5 okra 300 per pound") === "Okra|5|lb|300", "'300 per pound'", one("5 okra 300 per pound"));
  check(one("24 beetroot juice three fifteen per unit, 16 green juice at two thirty") === "Beetroot Juice|24|each|315 / Green Juice|16|each|230", "spoken-word prices with 'per unit' and 'at'", one("24 beetroot juice three fifteen per unit, 16 green juice at two thirty"));
  check(one("24 beetroot juice 315, 16 green juice 230") === "Beetroot Juice|24|each|315 / Green Juice|16|each|230", "a bare price after each product", one("24 beetroot juice 315, 16 green juice 230"));
  check(one("24 beetroot juice 16 green juice") === "Beetroot Juice|24|each|null|!noPrice / Green Juice|16|each|null|!noPrice", "the next product's amount is never taken as a price", one("24 beetroot juice 16 green juice"));
  check(one("24 beetroot juice at 315 per unit each") === "Beetroot Juice|24|each|315", "extra price words are absorbed, never a line", one("24 beetroot juice at 315 per unit each"));

  // Loose matching (the owner's latest test): case, plurals, extra words, close sounds; "dozen" = 12.
  r = parse("Sarah Supermarket, 14 Wellington Street, two dozen beetroot, one dozen cucumber, five dozen large bammy, fifty pounds okra at two fifty");
  check(r.store === "Sarah Supermarket" && r.address === "14 Wellington Street", "latest test: store and address", `${r.store} | ${r.address}`);
  check(r.lines.map(brief).join(" / ") === "Beetroot Juice|24|each|null|!noPrice / Cucumber Juice|12|each|null|!noPrice / Large Bammy|60|each|null|!noPrice / Okra|50|lb|250",
    "latest test: 24 beetroot, 12 cucumber, 60 large bammy, 50 lb okra at 250", r.lines.map(brief).join(" / "));
  check(!r.lines.some((l) => ["product", "which", "quantity", "price"].includes(l.issue?.kind)), "latest test: no red lines, no 'which product?'");
  check(sumTotals(r.lines) === 12500, "latest test: priced so far = 50 × 250 = $12,500", String(sumTotals(r.lines)));
  const names = (s) => parse(`Mega Mart, ${s}`).lines.map((l) => l.name || `?${l.issue?.kind}`).join(" / ");
  check(names("4 BEET ROOT, 5 Beetroot Juices, 6 cucumbers, 7 Large Bammies, 8 callaloo, 9 kalaloo") === "Beetroot Juice / Cucumber Juice / Large Bammy / Shredded Callaloo",
    "case, plurals, split words and close sounds all match (same product merged)", names("4 BEET ROOT, 5 Beetroot Juices, 6 cucumbers, 7 Large Bammies, 8 callaloo, 9 kalaloo"));
  check(names("3 nice fresh beetroot juice please, 2 dozen of the large bammy okay, 5 grape fruit, 4 juicify grape, 6 scotch bonnets") === "Beetroot Juice / Large Bammy / Grapefruit / Juicify Drink Grape / Hot Pepper",
    "extra words are ignored; 'grape fruit' is Grapefruit, not Juicify Grape", names("3 nice fresh beetroot juice please, 2 dozen of the large bammy okay, 5 grape fruit, 4 juicify grape, 6 scotch bonnets"));
  check(names("3 beat root, 4 bambi large, 5 mini bammie, 6 oprah, 7 cue cumber") === "Beetroot Juice / Large Bammy / Mini Bammy / Okra / Cucumber Juice",
    "common mishearings still match", names("3 beat root, 4 bambi large, 5 mini bammie, 6 oprah, 7 cue cumber"));
  r = parse("Mega Mart, 3 bammy, 2 punch, okay thank you very much");
  check(r.lines.length === 2 && r.lines.every((l) => l.issue?.kind === "which" && l.issue.choices.length === 2), "asks only when two products are equally close (bammy: Mini/Large; punch: Pumpkin/Fruit Punch)", r.lines.map((l) => JSON.stringify(l.issue)).join(" "));
  check(!parse("Mega Mart, 2 okra, please, thanks, that's everything").lines.some((l) => l.issue && l.issue.kind !== "noPrice"), "extra words with no amount never make a red line");
  check(names("a dozen lemon, 4 juice") === "Lemons / ?product" && parse("Mega Mart, a dozen lemon, 4 juice").lines[0].price === null, "a number before a word is the next line's amount, not a price", names("a dozen lemon, 4 juice"));

  // Dates: set the invoice date, and stay out of the address.
  r = parse("Sarah Supermarket, 12th of the 11th 2026, 14 Wellington Street, Brownstone, 24 beetroot juice 315 per unit");
  check(r.date === "2026-11-12" && r.address === "14 Wellington Street, Brownstone" && r.store === "Sarah Supermarket", "'12th of the 11th 2026' sets the date and stays out of the address", `${r.date} | ${r.store} | ${r.address}`);
  r = parse("Sarah Supermarket 14 Wellington Street Brownstone 12th of the 11th 2026 24 beetroot juice 315 per unit");
  check(r.date === "2026-11-12" && r.address === "14 Wellington Street, Brownstone" && r.lines.length === 1, "date with no commas, after the address", `${r.date} | ${r.address}`);
  const D = (s) => parse(`Shop ${s} 2 okra`).date;
  check(D("the twelfth of the eleventh twenty twenty six") === "2026-11-12" && D("12th November 2026") === "2026-11-12" && D("November 12th") === "2026-11-12" && D("12/11/2026") === "2026-11-12" && D("dated 3rd of March") === "2026-03-03", "other ways of saying a date (day first)");
  check(parse("Shop 31st of the 2nd 2026 2 okra").date === null, "an impossible date (31 Feb) is not used");

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
