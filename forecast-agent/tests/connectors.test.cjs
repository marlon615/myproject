/**
 * The six direct connections and the nightly file pull, against a stand-in server on this machine that answers
 * like each vendor's API (paths, paging, field names and sign conventions as published / as in their official SDKs).
 * It checks what the Worker sends (auth headers, NetSuite's OAuth 1.0a signature re-computed, Square's filters,
 * QuickBooks' OAuth code exchange and refresh-token rotation) and that the numbers that come back are exact.
 * Not a test against the real vendors — those need real accounts (see the report).
 */
const { spawnSync } = require("child_process");
const fs = require("fs"), os = require("os"), path = require("path"), http = require("http");
const { checker, startWorker, api, until, sleep, APP } = require("./helpers.cjs");

const PORT = 8850, MOCK = 8851;
const { check, failures } = checker();
const seen = []; // every request the stand-in vendors received

// ── Shared fake sales: 14 months up to this month, 2 products × 2 locations, 3 sales each per month ──────────────
const now = new Date();
const monthsBack = (n) => { const d = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() - n, 1)); return d.toISOString().slice(0, 7); };
const MONTHS = Array.from({ length: 14 }, (_, i) => monthsBack(13 - i));
function salesFor(vendor) {
  const out = [];
  MONTHS.forEach((ym, mi) => ["Alpha Tea", "Beta Coffee"].forEach((p, pi) => ["North Shop", "South Shop"].forEach((l, li) => {
    for (let k = 0; k < 3; k++) {
      const qty = 2 + ((mi + pi * 3 + li * 5 + k) % 4), price = pi ? 12.5 : 8;
      out.push({ date: `${ym}-${String(3 + k * 9).padStart(2, "0")}`, product: p, location: l, region: li ? "South" : "North", qty, amount: qty * price, vendor });
    }
  })));
  return out;
}
const expectTotals = (rows) => {
  const last3 = MONTHS.slice(-3);
  return { last3: Math.round(rows.filter((r) => last3.includes(r.date.slice(0, 7))).reduce((a, r) => a + r.amount, 0) * 100) / 100, units: rows.filter((r) => last3.includes(r.date.slice(0, 7))).reduce((a, r) => a + r.qty, 0) };
};
const DATA = Object.fromEntries(["shopify", "square", "quickbooks", "dynamics", "netsuite", "sap", "httpfile"].map((v) => [v, salesFor(v)]));
const since = (url, key) => new URL(url, "http://x").searchParams.get(key);

let C, qbRefresh = "qb-refresh-1";
const mock = http.createServer(async (rq, rs) => {
  let body = ""; for await (const c of rq) body += c;
  const [, host, ...rest] = rq.url.split("/");
  const u = new URL("http://x/" + rest.join("/"));
  const p = u.pathname, q = u.searchParams, h = rq.headers;
  seen.push({ host, method: rq.method, path: p, query: u.search, headers: h, body });
  const send = (code, obj, extra = {}) => { rs.writeHead(code, { "content-type": "application/json", ...extra }); rs.end(typeof obj === "string" ? obj : JSON.stringify(obj)); };
  try {
    // Shopify
    if (host === "teststore.myshopify.com") {
      if (h["x-shopify-access-token"] !== "shpat_test_secret") return send(401, { errors: "Invalid API key or access token" });
      if (p === "/admin/api/2026-10/shop.json") return send(200, { shop: { name: "Test Store" } });
      if (p === "/admin/api/2026-10/locations.json") return send(200, { locations: [{ id: 11, name: "North Shop", province: "North" }, { id: 22, name: "South Shop", province: "South" }] });
      if (p === "/admin/api/2026-10/orders.json") {
        const from = since(rq.url, "created_at_min") || q.get("page_info")?.split("|")[1];
        const rows = DATA.shopify.filter((r) => `${r.date}T00:00:00Z` >= (from || ""));
        const page = q.get("page_info") ? +q.get("page_info").split("|")[0] : 0, size = 100;
        const slice = rows.slice(page * size, page * size + size);
        const orders = slice.map((r, i) => ({ id: page * size + i, created_at: `${r.date}T10:00:00-05:00`, cancelled_at: null, location_id: r.location === "North Shop" ? 11 : 22, line_items: [{ title: r.product, variant_title: null, quantity: r.qty, price: (r.amount / r.qty).toFixed(2), total_discount: "0.00" }] }));
        if (page === 0) orders.push({ id: 9999, created_at: `${MONTHS[13]}-05T10:00:00Z`, cancelled_at: `${MONTHS[13]}-06T10:00:00Z`, location_id: 11, line_items: [{ title: "Alpha Tea", quantity: 1000, price: "8.00" }] });
        const more = (page + 1) * size < rows.length;
        return send(200, { orders }, more ? { Link: `<https://teststore.myshopify.com/admin/api/2026-10/orders.json?limit=250&page_info=${page + 1}|${from}>; rel="next"` } : {});
      }
      if (p === "/admin/api/2026-10/products.json") return send(200, { products: [{ id: 1, title: "Alpha Tea", variants: [{ id: 5, title: "Default Title", inventory_item_id: 501 }] }, { id: 2, title: "Beta Coffee", variants: [{ id: 6, title: "Default Title", inventory_item_id: 502 }] }] });
      if (p === "/admin/api/2026-10/inventory_levels.json") return send(200, { inventory_levels: [{ inventory_item_id: 501, location_id: 11, available: 7 }, { inventory_item_id: 502, location_id: 22, available: 40 }] });
    }
    // Square
    if (host === "connect.squareup.com") {
      if (h.authorization !== "Bearer sq_test_secret" || !h["square-version"]) return send(401, { errors: [{ category: "AUTHENTICATION_ERROR", code: "UNAUTHORIZED" }] });
      if (p === "/v2/locations") return send(200, { locations: [{ id: "L1", name: "North Shop", address: { administrative_district_level_1: "North" } }, { id: "L2", name: "South Shop", address: { administrative_district_level_1: "South" } }] });
      if (p === "/v2/orders/search") {
        const b = JSON.parse(body);
        const okReq = b.location_ids.length <= 10 && b.query.filter.state_filter.states[0] === "COMPLETED" && b.query.sort.sort_field === "CLOSED_AT" && b.query.filter.date_time_filter.closed_at.start_at;
        if (!okReq) return send(400, { errors: [{ code: "BAD_REQUEST" }] });
        const rows = DATA.square.filter((r) => b.location_ids.includes(r.location === "North Shop" ? "L1" : "L2") && `${r.date}T00:00:00Z` >= b.query.filter.date_time_filter.closed_at.start_at);
        const start = b.cursor ? +b.cursor : 0, slice = rows.slice(start, start + 50);
        return send(200, { orders: slice.map((r, i) => ({ id: `o${start + i}`, location_id: r.location === "North Shop" ? "L1" : "L2", closed_at: `${r.date}T15:00:00Z`, line_items: [{ name: r.product, variation_name: "Regular", quantity: String(r.qty), total_money: { amount: Math.round(r.amount * 100), currency: "USD" } }] })), ...(start + 50 < rows.length ? { cursor: String(start + 50) } : {}) });
      }
      if (p === "/v2/inventory/counts/batch-retrieve") return send(200, { counts: [{ catalog_object_id: "V1", location_id: "L1", quantity: "3", state: "IN_STOCK" }] });
      if (p === "/v2/catalog/batch-retrieve") return send(200, { objects: [{ id: "V1", type: "ITEM_VARIATION", item_variation_data: { item_id: "I1", name: "Regular" } }], related_objects: [{ id: "I1", type: "ITEM", item_data: { name: "Alpha Tea" } }] });
    }
    // QuickBooks
    if (host === "oauth.platform.intuit.com" && p === "/oauth2/v1/tokens/bearer") {
      if (h.authorization !== `Basic ${Buffer.from("qb-client-id:qb-client-secret").toString("base64")}`) return send(401, { error: "invalid_client" });
      const f = new URLSearchParams(body);
      if (f.get("grant_type") === "authorization_code" && f.get("code") === "auth-code-1") return send(200, { access_token: "qb-access-1", refresh_token: qbRefresh, expires_in: 1, token_type: "bearer" });
      if (f.get("grant_type") === "refresh_token" && f.get("refresh_token") === qbRefresh) { qbRefresh = `qb-refresh-${Number(qbRefresh.split("-").pop()) + 1}`; return send(200, { access_token: "qb-access-2", refresh_token: qbRefresh, expires_in: 1 }); }
      return send(400, { error: "invalid_grant" });
    }
    if (host === "quickbooks.api.intuit.com") {
      if (!/^Bearer qb-access-\d$/.test(h.authorization || "")) return send(401, { fault: "AuthenticationFailed" });
      if (/\/companyinfo\//.test(p)) return send(200, { CompanyInfo: { CompanyName: "QB Test Co" } });
      const query = q.get("query"), kind = /FROM (\w+)/.exec(query)[1], from = /TxnDate >= '([\d-]+)'/.exec(query)?.[1], start = +/STARTPOSITION (\d+)/.exec(query)[1];
      if (kind === "Item") return send(200, { QueryResponse: { Item: [{ Name: "Beta Coffee", QtyOnHand: 12 }] } });
      const list = kind === "SalesReceipt" ? DATA.quickbooks.filter((r) => r.date >= from).map((r, i) => ({ Id: String(i), TxnDate: r.date, DepartmentRef: { name: r.location }, Line: [{ DetailType: "SalesItemLineDetail", Amount: r.amount, SalesItemLineDetail: { ItemRef: { name: r.product }, Qty: r.qty, ClassRef: { name: r.region } } }, { DetailType: "SubTotalLineDetail", Amount: r.amount }] })) : [];
      const page = list.slice(start - 1, start - 1 + 1000);
      return send(200, { QueryResponse: { [kind]: page, startPosition: start, maxResults: page.length } });
    }
    // Dynamics 365 Business Central
    if (host === "login.microsoftonline.com" && p === "/tenant-123/oauth2/v2.0/token") {
      const f = new URLSearchParams(body);
      return f.get("client_secret") === "bc-secret" && f.get("scope") === "https://api.businesscentral.dynamics.com/.default" ? send(200, { access_token: "bc-token", expires_in: 3599 }) : send(401, { error: "invalid_client" });
    }
    if (host === "api.businesscentral.dynamics.com") {
      if (h.authorization !== "Bearer bc-token") return send(401, { error: { code: "Unauthorized" } });
      const baseP = "/v2.0/tenant-123/production/api/v2.0/companies(c0ffee00-0000-0000-0000-000000000001)";
      if (p === baseP) return send(200, { displayName: "BC Test Co" });
      if (p === `${baseP}/locations`) return send(200, { value: [{ id: "loc-n", code: "N", displayName: "North Shop" }, { id: "loc-s", code: "S", displayName: "South Shop" }] });
      if (p === `${baseP}/salesInvoices`) {
        const from = /invoiceDate ge ([\d-]+)/.exec(q.get("$filter"))[1], skip = +(q.get("$skiptoken") || 0);
        const rows = DATA.dynamics.filter((r) => r.date >= from), slice = rows.slice(skip, skip + 60);
        return send(200, { value: slice.map((r, i) => ({ id: `inv${skip + i}`, invoiceDate: r.date, shipToState: r.region, status: "Paid", salesInvoiceLines: [{ lineType: "Item", description: r.product, quantity: r.qty, amountExcludingTax: r.amount, locationId: r.location === "North Shop" ? "loc-n" : "loc-s" }, { lineType: "Comment", description: "Thanks" }] })),
          ...(skip + 60 < rows.length ? { "@odata.nextLink": `https://api.businesscentral.dynamics.com${baseP}/salesInvoices?$skiptoken=${skip + 60}&$filter=${encodeURIComponent(q.get("$filter"))}` } : {}) });
      }
    }
    // NetSuite (OAuth 1.0a signature re-computed here)
    if (host === "1234567-sb1.suitetalk.api.netsuite.com" && p === "/services/rest/query/v1/suiteql") {
      const auth = h.authorization || "", get = (k) => decodeURIComponent((new RegExp(`${k}="([^"]*)"`).exec(auth) || [])[1] || "");
      const expected = await C.oauth1Header({ method: "POST", url: `https://1234567-sb1.suitetalk.api.netsuite.com${p}${u.search}`, realm: "1234567_SB1", consumerKey: "ns-ck", consumerSecret: "ns-cs", token: "ns-tk", tokenSecret: "ns-ts", nonce: get("oauth_nonce"), timestamp: Number(get("oauth_timestamp")) });
      if (auth !== expected || h.prefer !== "transient") return send(401, { "o:errorDetails": [{ detail: "Invalid login attempt." }] });
      const sql = JSON.parse(body).q;
      if (/FROM location/.test(sql)) return send(200, { items: [{ id: "1" }], hasMore: false, count: 1 });
      const from = /TO_DATE\('([\d-]+)'/.exec(sql)[1], offset = +q.get("offset");
      const rows = DATA.netsuite.filter((r) => r.date >= from), slice = rows.slice(offset, offset + 1000);
      return send(200, { items: slice.map((r) => ({ d: r.date, item: r.product, loc: r.location, sub: r.region, qty: String(-r.qty), amt: String(-r.amount) })), hasMore: offset + 1000 < rows.length, count: slice.length, offset });
    }
    // SAP S/4HANA
    if (host === "my123-api.s4hana.cloud.sap") {
      if (h.authorization !== `Basic ${Buffer.from("COMM_USER:sap-pass").toString("base64")}`) return send(401, "<error>Unauthorized</error>");
      const top = +(q.get("$top") || 1), skip = +(q.get("$skip") || 0);
      const from = /datetime'([\d-]+)T/.exec(q.get("$filter") || "")?.[1] || "0000";
      const docs = DATA.sap.filter((r) => r.date >= from).map((r, i) => ({ BillingDocument: String(90000000 + i), BillingDocumentDate: `/Date(${Date.parse(`${r.date}T00:00:00Z`)})/`, SalesOrganization: r.region, to_Item: { results: [{ Material: `MAT-${r.product}`, BillingDocumentItemText: r.product, BillingQuantity: String(r.qty), NetAmount: String(r.amount), Plant: r.location }] } }));
      return send(200, { d: { results: docs.slice(skip, skip + top) } });
    }
    // File at a web address
    if (host === "files.example.com" && p === "/export.csv") {
      if (h.authorization !== "Bearer file-token") return send(403, "no");
      rs.writeHead(200, { "content-type": "text/csv" });
      return rs.end("Date,Item,Store,Region,Qty,Revenue\n" + DATA.httpfile.map((r) => `${r.date},${r.product},${r.location},${r.region},${r.qty},${r.amount}`).join("\n") + "\n");
    }
    send(404, { error: `stand-in has no ${host}${p}` });
  } catch (e) { send(500, { error: String(e) }); }
});

(async () => {
  C = await import("../worker/crypto.js");
  check(spawnSync(process.execPath, [path.join(APP, "scripts", "build-worker.cjs")], { cwd: APP }).status === 0, "the app packs into the Worker");
  await new Promise((ok) => mock.listen(MOCK, ok));
  const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), "forecast-conn-"));
  const w = startWorker(PORT, stateDir, { CONNECTOR_TEST_BASE: `http://localhost:${MOCK}` });
  const req = api(w.base);
  try {
    await w.ready;
    const owner = (await req("/api/owner/claim", { method: "POST", body: { passcode: "owner-pass-123" } })).data.token;
    const A = await req("/api/signup", { method: "POST", body: { company: "Connected Co", email: "it@connected.test", password: "admin-pass-1" } });
    const admin = A.data.token, aid = A.data.me.id;
    await req("/api/owner/contract", { method: "POST", token: owner, body: { id: aid, plan: "Enterprise", contract: 60000, allFeatures: true } });
    await req("/api/owner/platform", { method: "POST", token: owner, body: { qbClientId: "qb-client-id", qbSecret: "qb-client-secret" } });

    const connect = async (kind, creds, name) => req("/api/connections", { method: "POST", token: admin, body: { kind, name, creds, historyMonths: 24 } });
    const waitOk = async (id) => until(async () => { const c = (await req("/api/connections", { token: admin })).data.connections.find((x) => x.id === id); return c && (c.status === "ok" || c.status === "error") ? c : null; }, 60000, 400);
    const readyUpload = async (uid) => until(async () => { const u = (await req(`/api/uploads/${uid}`, { token: admin })).data.upload; return u && u.status === "ready" && u.backtest?.ok ? u : null; }, 60000, 400);
    const last3 = async (uid) => {
      const u = (await req(`/api/uploads/${uid}`, { token: admin })).data.upload;
      const rows = (await req(`/api/uploads/${uid}/drill?mode=backtest`, { token: admin })).data.rows;
      const units = (await req(`/api/uploads/${uid}/drill?mode=backtest&measure=units`, { token: admin })).data.rows;
      return { u, amount: Math.round(rows.reduce((a, r) => a + r.last3, 0) * 100) / 100, units: units.reduce((a, r) => a + r.last3, 0) };
    };
    const verify = async (vendor, conn, label) => {
      const c = await waitOk(conn.id);
      const up = c?.status === "ok" ? await readyUpload(c.upload) : null;
      const got = up ? await last3(c.upload) : null, want = expectTotals(DATA[vendor]);
      check(c?.status === "ok" && up && got.u.products === 2 && got.u.locations === 2 && got.u.regions === 2 && got.u.months === 14 && Math.abs(got.amount - want.last3) < 0.01 && got.units === want.units,
        `${label}: synced — 2 products, 2 locations, 2 regions, 14 months; last 3 months exact`, c?.status === "ok" ? `$${got?.amount} vs $${want.last3}, ${got?.units} vs ${want.units} units` : c?.lastError);
      return c;
    };

    // Shopify (with stock levels)
    const sh = await connect("shopify", { shop: "https://TestStore.myshopify.com/", token: "shpat_test_secret" }, "Shopify store");
    check(sh.status === 200 && sh.data.test.ok && /Test Store/.test(sh.data.test.message), "Shopify: saved, test passes", sh.data.test?.message);
    const shc = await verify("shopify", sh.data.connection, "Shopify");
    check(seen.some((r) => r.host === "teststore.myshopify.com" && /page_info=1/.test(r.query)) && !seen.some((r) => /cancelled/.test(r.body)), "Shopify: follows the Link-header pages; the cancelled order (1,000 units) is left out (totals above are exact)");
    const stock = await until(async () => { const s = (await req("/api/stock", { token: admin })).data; return s.items?.some((i) => i.source?.startsWith("connection")) ? s : null; }, 20000);
    check(stock && stock.items.find((i) => i.product === "Alpha Tea" && i.location === "North Shop")?.onHand === 7, "Shopify: stock levels come in too (Alpha Tea at North Shop: 7)");
    // Square
    const bad = await connect("square", { token: "wrong-token" }, "Square (wrong token)");
    check(bad.data.test && !bad.data.test.ok && /refused the credentials \(401\)/.test(bad.data.test.message), "Square with a wrong token: the test says the credentials were refused", bad.data.test?.message);
    await req(`/api/connections/${bad.data.connection.id}`, { method: "DELETE", token: admin });
    const sq = await connect("square", { token: "sq_test_secret" }, "Square POS");
    await verify("square", sq.data.connection, "Square");
    check(seen.some((r) => r.host === "connect.squareup.com" && /"cursor":"50"/.test(r.body)) && seen.filter((r) => r.host === "connect.squareup.com").every((r) => r.headers["square-version"] === "2026-09-16"), "Square: pages with the cursor; every call sends Square-Version 2026-09-16");
    // QuickBooks (OAuth)
    const qb = await connect("quickbooks", {}, "QuickBooks");
    check(qb.data.connection.status === "needs-auth", "QuickBooks: saved, waiting for the customer to approve access");
    const az = await req(`/api/connections/${qb.data.connection.id}/authorize`, { token: admin });
    const au = new URL(az.data.url);
    check(au.origin + au.pathname === "https://appcenter.intuit.com/connect/oauth2" && au.searchParams.get("client_id") === "qb-client-id" && au.searchParams.get("scope") === "com.intuit.quickbooks.accounting" && au.searchParams.get("redirect_uri") === `${w.base}/api/oauth/quickbooks`, "QuickBooks: 'Connect' sends the customer to Intuit with the right app, scope and return address");
    const cb = await req(`/api/oauth/quickbooks?code=auth-code-1&state=${au.searchParams.get("state")}&realmId=9130355`);
    check(cb.status === 302 && /qb=connected/.test(cb.headers.get("location")), "QuickBooks: coming back from Intuit exchanges the code and starts the first sync");
    check((await req(`/api/oauth/quickbooks?code=auth-code-1&state=${au.searchParams.get("state")}&realmId=9130355`)).headers.get("location").includes("qb=expired"), "QuickBooks: the same return link can't be used twice");
    await verify("quickbooks", qb.data.connection, "QuickBooks");
    const rotate = qbRefresh;
    await req(`/api/connections/${qb.data.connection.id}/sync`, { method: "POST", token: admin });
    await sleep(500);
    await waitOk(qb.data.connection.id);
    const qbc = (await req("/api/connections", { token: admin })).data.connections.find((x) => x.id === qb.data.connection.id);
    check(Number(qbRefresh.split("-").pop()) > Number(rotate.split("-").pop()) && Number(rotate.split("-").pop()) > 1 && qbc.status === "ok", "QuickBooks: short-lived access is refreshed on each sync, and the rotated refresh token is saved (the stand-in only accepts the newest one)", `${rotate} → ${qbRefresh}, ${qbc.status}`);
    // Dynamics 365 Business Central
    const bc = await connect("dynamics", { tenant: "tenant-123", clientId: "bc-client", clientSecret: "bc-secret", environment: "production", companyId: "c0ffee00-0000-0000-0000-000000000001" }, "Dynamics 365");
    check(bc.data.test?.ok && /BC Test Co/.test(bc.data.test.message), "Dynamics 365: signs in to Microsoft (client credentials) and finds the company");
    await verify("dynamics", bc.data.connection, "Dynamics 365 Business Central");
    // NetSuite
    const ns = await connect("netsuite", { account: "1234567_SB1", consumerKey: "ns-ck", consumerSecret: "ns-cs", tokenId: "ns-tk", tokenSecret: "ns-ts" }, "NetSuite");
    check(ns.data.test?.ok, "NetSuite: the stand-in re-computed the OAuth 1.0a signature and it matched");
    await verify("netsuite", ns.data.connection, "NetSuite (negative quantities flipped)");
    // SAP
    const sp = await connect("sap", { host: "https://my123-api.s4hana.cloud.sap", user: "COMM_USER", password: "sap-pass" }, "SAP");
    await verify("sap", sp.data.connection, "SAP S/4HANA (OData dates, $skip pages)");
    // File at a web address
    const hf = await connect("httpfile", { url: "https://files.example.com/export.csv", header: "Authorization: Bearer file-token" }, "Warehouse export");
    check(hf.data.test?.ok && /Date,Item,Store/.test(hf.data.test.message), "file at a web address: reachable (test shows the first line)");
    await verify("httpfile", hf.data.connection, "Nightly file from a web address");

    // Schedule, second sync window, secrets
    const list = (await req("/api/connections", { token: admin })).data.connections;
    const nexts = list.map((c) => new Date(c.nextRun));
    check(list.length === 7 && nexts.every((d) => d > now && d - now < 26 * 3600e3 && d.getUTCHours() === 2), "all 7 connections are scheduled for about 2am (company time zone UTC) tonight", nexts.map((d) => d.toISOString().slice(11, 16)).join(" "));
    const before = seen.length;
    await req(`/api/connections/${shc.id}/sync`, { method: "POST", token: admin });
    await waitOk(shc.id); await sleep(800);
    const firstAgain = seen.slice(before).find((r) => r.host === "teststore.myshopify.com" && /created_at_min/.test(r.query));
    const from2 = since(firstAgain?.query || "?", "created_at_min");
    check(from2 && new Date(from2) > new Date(Date.now() - 80 * 864e5) && /-01T00:00:00Z$/.test(from2), "later syncs re-read only the last ~2 months (from the 1st of a month)", from2);
    const after2 = await last3(shc.upload);
    check(Math.abs(after2.amount - expectTotals(DATA.shopify).last3) < 0.01, "re-syncing the same months doesn't double count");
    const shown = JSON.stringify((await req("/api/connections", { token: admin })).data);
    check(!/shpat_test_secret|sq_test_secret|ns-cs|sap-pass|bc-secret|qb-refresh/.test(shown), "saved credentials are never sent back to the browser");
    const files = []; const walk = (d) => { for (const e of fs.readdirSync(d, { withFileTypes: true })) { const p = path.join(d, e.name); e.isDirectory() ? walk(p) : files.push(p); } }; walk(stateDir);
    const blob = Buffer.concat(files.map((f) => fs.readFileSync(f)));
    check(!["shpat_test_secret", "sq_test_secret", "sap-pass", "bc-secret", "ns-ts", "file-token"].some((s) => blob.includes(Buffer.from(s))), "saved credentials are encrypted in the stored files");
    const oc = (await req("/api/owner/customers", { token: owner })).data.customers.find((c) => c.id === aid);
    check(oc.connections.length === 7 && oc.connections.every((c) => c.status === "ok"), "owner dashboard sees the company's 7 connections and their sync status");
    const log = (await req("/api/audit?limit=500", { token: admin })).data.events.map((e) => e.action);
    check(log.filter((a) => a === "sync finished").length >= 8 && log.includes("added a connection") && log.includes("connection authorized"), "every sync and connection change is in the activity log");
  } finally {
    await w.stop();
    mock.close();
    if (failures()) console.log(w.log.join("").slice(-3000));
    fs.rmSync(stateDir, { recursive: true, force: true });
  }
  console.log(failures() ? `\n${failures()} check(s) failed` : "\nAll connector checks passed");
  process.exit(failures() ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
