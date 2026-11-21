/**
 * Direct connections that pull sales (and, where the system has it, stock on hand) every night.
 *
 * Each connector: { name, auth, fields, test(cfg, ctx), pull(cfg, state, ctx) → { rows, inventory, state | null } }
 * pull() fetches ONE page per call; the company's background job calls it again with the returned state until it
 * returns state null, so a big history never has to fit in one request.
 *   rows:      [{ date: "YYYY-MM-DD", product, location, region, units, amount }]
 *   inventory: [{ product, location, onHand }]   (optional)
 *
 * Built to each vendor's published API (Square and Shopify field names checked against their official SDKs:
 * square@46, @shopify/shopify-api@15; QuickBooks endpoints against intuit-oauth@4). Not yet run against a live
 * account of each system — use "Test connection" and a first sync with a real sandbox before relying on one.
 */
import { oauth1Header } from "./crypto.js";

const SHOPIFY_VERSION = "2026-10";
const SQUARE_VERSION = "2026-09-16";
export class ConnectorError extends Error { constructor(message, status) { super(message); this.status = status; } }

/** In tests only (CONNECTOR_TEST_BASE set), vendor hosts are sent to a local stand-in server instead. */
export function at(env, url) {
  if (!env.CONNECTOR_TEST_BASE) return url;
  const x = new URL(url);
  return `${env.CONNECTOR_TEST_BASE}/${x.host}${x.pathname}${x.search}`;
}
async function call(ctx, url, opts = {}, what = "request") {
  let res;
  try { res = await fetch(at(ctx.env, url), { ...opts, signal: AbortSignal.timeout(25000) }); }
  catch { throw new ConnectorError(`Couldn't reach the system (${what}). Check the address.`, 0); }
  if (res.status === 401 || res.status === 403) throw new ConnectorError(`The system refused the credentials (${res.status}) during ${what}. Check them, and that the user/app has read access.`, res.status);
  if (res.status === 429) throw new ConnectorError(`The system asked us to slow down (429) during ${what}. The next sync will continue.`, 429);
  if (!res.ok) {
    let detail = ""; try { detail = (await res.text()).replace(/\s+/g, " ").slice(0, 200); } catch { /* ignore */ }
    throw new ConnectorError(`The system answered ${res.status} during ${what}.${detail ? ` ${detail}` : ""}`, res.status);
  }
  return res;
}
const day = (s) => String(s || "").slice(0, 10);
const num = (v) => (Number.isFinite(Number(v)) ? Number(v) : 0);
const named = (base, variant) => (variant && !/^(regular|default title)$/i.test(variant) ? `${base} (${variant})` : base);

// ── Shopify (Admin API, custom-app access token) ─────────────────────────────────────────────────────────────────
const shopHost = (cfg) => String(cfg.shop || "").trim().toLowerCase().replace(/^https?:\/\//, "").replace(/\/.*$/, "");
const shopify = {
  name: "Shopify", auth: "token",
  fields: [{ k: "shop", label: "Store address (yourstore.myshopify.com)" }, { k: "token", label: "Admin API access token", secret: true }],
  help: "In Shopify admin: Settings → Apps and sales channels → Develop apps → create an app with read_orders, read_all_orders, read_products, read_inventory and read_locations, install it, and copy the Admin API access token.",
  hdr: (cfg) => ({ "X-Shopify-Access-Token": cfg.token, Accept: "application/json" }),
  base: (cfg) => `https://${shopHost(cfg)}/admin/api/${SHOPIFY_VERSION}`,
  validate(cfg) { if (!/^[a-z0-9-]+\.myshopify\.com$/.test(shopHost(cfg))) return "The store address should look like yourstore.myshopify.com."; if (!cfg.token) return "Paste the Admin API access token."; return null; },
  async test(cfg, ctx) { const r = await (await call(ctx, `${this.base(cfg)}/shop.json`, { headers: this.hdr(cfg) }, "checking the store")).json(); return `Connected to ${r.shop?.name || shopHost(cfg)}.`; },
  async pull(cfg, st, ctx) {
    st = st || { phase: "locations" };
    const next = (link) => { const m = /<([^>]+)>;\s*rel="next"/.exec(link || ""); return m ? m[1] : null; };
    if (st.phase === "locations") {
      const r = await (await call(ctx, `${this.base(cfg)}/locations.json`, { headers: this.hdr(cfg) }, "reading locations")).json();
      const locs = Object.fromEntries((r.locations || []).map((l) => [String(l.id), { name: l.name, region: l.province || l.country || "" }]));
      return { rows: [], state: { phase: "orders", locs, url: `${this.base(cfg)}/orders.json?status=any&limit=250&created_at_min=${ctx.since}T00:00:00Z&fields=id,created_at,cancelled_at,location_id,line_items` } };
    }
    if (st.phase === "orders") {
      const res = await call(ctx, st.url, { headers: this.hdr(cfg) }, "reading orders");
      const r = await res.json();
      const rows = [];
      for (const o of r.orders || []) {
        if (o.cancelled_at) continue;
        const loc = st.locs[String(o.location_id)] || { name: "Online store", region: "" };
        for (const li of o.line_items || []) {
          const q = num(li.quantity);
          rows.push({ date: day(o.created_at), product: named(li.title || li.name || "Item", li.variant_title), location: loc.name, region: loc.region, units: q, amount: num(li.price) * q - num(li.total_discount) });
        }
      }
      const url = next(res.headers.get("Link"));
      return { rows, state: url ? { ...st, url } : ctx.wantInventory ? { phase: "products", locs: st.locs, url: `${this.base(cfg)}/products.json?limit=250&fields=id,title,variants`, items: {} } : null };
    }
    if (st.phase === "products") {
      const res = await call(ctx, st.url, { headers: this.hdr(cfg) }, "reading products");
      const r = await res.json();
      for (const p of r.products || []) for (const v of p.variants || []) st.items[String(v.inventory_item_id)] = named(p.title, v.title);
      const url = next(res.headers.get("Link"));
      const ids = Object.keys(st.locs).join(",");
      return { rows: [], state: url ? { ...st, url } : { phase: "levels", locs: st.locs, items: st.items, url: `${this.base(cfg)}/inventory_levels.json?limit=250&location_ids=${ids}` } };
    }
    const res = await call(ctx, st.url, { headers: this.hdr(cfg) }, "reading stock levels");
    const r = await res.json();
    const inventory = (r.inventory_levels || []).filter((l) => st.items[String(l.inventory_item_id)]).map((l) => ({ product: st.items[String(l.inventory_item_id)], location: st.locs[String(l.location_id)]?.name || "", onHand: num(l.available) }));
    const url = next(res.headers.get("Link"));
    return { rows: [], inventory, state: url ? { ...st, url } : null };
  },
};

// ── Square (personal or OAuth access token) ──────────────────────────────────────────────────────────────────────
const square = {
  name: "Square", auth: "token",
  fields: [{ k: "token", label: "Access token", secret: true }, { k: "sandbox", label: "Sandbox account", type: "checkbox" }],
  help: "In the Square Developer Dashboard: open your application → Credentials → copy the Production access token (it needs ORDERS_READ, ITEMS_READ, INVENTORY_READ and MERCHANT_PROFILE_READ).",
  base: (cfg) => (cfg.sandbox ? "https://connect.squareupsandbox.com" : "https://connect.squareup.com"),
  hdr: (cfg) => ({ Authorization: `Bearer ${cfg.token}`, "Square-Version": SQUARE_VERSION, "Content-Type": "application/json", Accept: "application/json" }),
  validate(cfg) { return cfg.token ? null : "Paste the access token."; },
  async test(cfg, ctx) { const r = await (await call(ctx, `${this.base(cfg)}/v2/locations`, { headers: this.hdr(cfg) }, "checking the account")).json(); return `Connected: ${(r.locations || []).length} location(s).`; },
  async pull(cfg, st, ctx) {
    st = st || { phase: "locations" };
    if (st.phase === "locations") {
      const r = await (await call(ctx, `${this.base(cfg)}/v2/locations`, { headers: this.hdr(cfg) }, "reading locations")).json();
      const locs = Object.fromEntries((r.locations || []).map((l) => [l.id, { name: l.name, region: l.address?.administrative_district_level_1 || l.address?.country || "" }]));
      return { rows: [], state: { phase: "orders", locs, ids: Object.keys(locs), batch: 0, cursor: null } };
    }
    if (st.phase === "orders") {
      const ids = st.ids.slice(st.batch * 10, st.batch * 10 + 10); // Square allows up to 10 locations per search
      if (!ids.length) return { rows: [], state: ctx.wantInventory ? { phase: "counts", locs: st.locs, cursor: null } : null };
      const body = { location_ids: ids, limit: 500, return_entries: false, ...(st.cursor ? { cursor: st.cursor } : {}),
        query: { filter: { date_time_filter: { closed_at: { start_at: `${ctx.since}T00:00:00Z`, end_at: new Date().toISOString() } }, state_filter: { states: ["COMPLETED"] } }, sort: { sort_field: "CLOSED_AT", sort_order: "ASC" } } };
      const r = await (await call(ctx, `${this.base(cfg)}/v2/orders/search`, { method: "POST", headers: this.hdr(cfg), body: JSON.stringify(body) }, "reading orders")).json();
      const rows = [];
      for (const o of r.orders || []) {
        const loc = st.locs[o.location_id] || { name: o.location_id, region: "" };
        for (const li of o.line_items || []) rows.push({ date: day(o.closed_at || o.created_at), product: named(li.name || "Item", li.variation_name), location: loc.name, region: loc.region, units: num(li.quantity), amount: num(li.total_money?.amount) / 100 });
      }
      return { rows, state: r.cursor ? { ...st, cursor: r.cursor } : { ...st, batch: st.batch + 1, cursor: null } };
    }
    // Stock: counts, then the item names for them.
    const body = { location_ids: Object.keys(st.locs), states: ["IN_STOCK"], ...(st.cursor ? { cursor: st.cursor } : {}) };
    const r = await (await call(ctx, `${this.base(cfg)}/v2/inventory/counts/batch-retrieve`, { method: "POST", headers: this.hdr(cfg), body: JSON.stringify(body) }, "reading stock")).json();
    const counts = r.counts || [];
    const names = {};
    const objIds = [...new Set(counts.map((c) => c.catalog_object_id))];
    for (let i = 0; i < objIds.length; i += 1000) {
      const c = await (await call(ctx, `${this.base(cfg)}/v2/catalog/batch-retrieve`, { method: "POST", headers: this.hdr(cfg), body: JSON.stringify({ object_ids: objIds.slice(i, i + 1000), include_related_objects: true }) }, "reading item names")).json();
      const items = Object.fromEntries((c.related_objects || []).filter((o) => o.type === "ITEM").map((o) => [o.id, o.item_data?.name]));
      for (const o of c.objects || []) names[o.id] = named(items[o.item_variation_data?.item_id] || o.item_variation_data?.name || o.id, o.item_variation_data?.name);
    }
    const inventory = counts.map((c) => ({ product: names[c.catalog_object_id] || c.catalog_object_id, location: st.locs[c.location_id]?.name || "", onHand: num(c.quantity) }));
    return { rows: [], inventory, state: r.cursor ? { ...st, cursor: r.cursor } : null };
  },
};

// ── QuickBooks Online (OAuth 2 through the owner's Intuit app) ──────────────────────────────────────────────────
export const QB = { authorize: "https://appcenter.intuit.com/connect/oauth2", token: "https://oauth.platform.intuit.com/oauth2/v1/tokens/bearer", api: "https://quickbooks.api.intuit.com", scope: "com.intuit.quickbooks.accounting" };
const quickbooks = {
  name: "QuickBooks Online", auth: "oauth",
  fields: [],
  help: "Click “Connect to QuickBooks” and approve access as a QuickBooks admin. (The platform owner sets up the Intuit app once.)",
  validate(cfg) { return cfg.refreshToken && cfg.realmId ? null : "Connect to QuickBooks first."; },
  async token(cfg, ctx) {
    if (cfg.accessToken && cfg.accessExpires > Date.now() + 60_000) return cfg.accessToken;
    const id = await ctx.platformSecret("qbClientId"), secret = await ctx.platformSecret("qbSecret");
    if (!id || !secret) throw new ConnectorError("The QuickBooks app isn't set up on the owner dashboard.", 0);
    const r = await (await call(ctx, QB.token, { method: "POST", headers: { Authorization: `Basic ${btoa(`${id}:${secret}`)}`, "Content-Type": "application/x-www-form-urlencoded", Accept: "application/json" },
      body: new URLSearchParams({ grant_type: "refresh_token", refresh_token: cfg.refreshToken }) }, "refreshing access")).json();
    Object.assign(cfg, { accessToken: r.access_token, accessExpires: Date.now() + num(r.expires_in) * 1000, refreshToken: r.refresh_token || cfg.refreshToken });
    await ctx.saveCreds(cfg); // QuickBooks rotates refresh tokens; the new one must be kept
    return cfg.accessToken;
  },
  async q(cfg, ctx, query, what) {
    const url = `${QB.api}/v3/company/${encodeURIComponent(cfg.realmId)}/query?minorversion=75&query=${encodeURIComponent(query)}`;
    return (await call(ctx, url, { headers: { Authorization: `Bearer ${await this.token(cfg, ctx)}`, Accept: "application/json" } }, what)).json();
  },
  async test(cfg, ctx) {
    const r = await (await call(ctx, `${QB.api}/v3/company/${encodeURIComponent(cfg.realmId)}/companyinfo/${encodeURIComponent(cfg.realmId)}?minorversion=75`, { headers: { Authorization: `Bearer ${await this.token(cfg, ctx)}`, Accept: "application/json" } }, "checking the company")).json();
    return `Connected to ${r.CompanyInfo?.CompanyName || "QuickBooks"}.`;
  },
  async pull(cfg, st, ctx) {
    const kinds = ["SalesReceipt", "Invoice", "RefundReceipt", "CreditMemo"];
    st = st || { k: 0, pos: 1 };
    if (st.k < kinds.length) {
      const kind = kinds[st.k], sign = kind === "RefundReceipt" || kind === "CreditMemo" ? -1 : 1;
      const r = await this.q(cfg, ctx, `SELECT * FROM ${kind} WHERE TxnDate >= '${ctx.since}' STARTPOSITION ${st.pos} MAXRESULTS 1000`, `reading ${kind}s`);
      const list = r.QueryResponse?.[kind] || [];
      const rows = [];
      for (const t of list) for (const l of t.Line || []) {
        if (l.DetailType !== "SalesItemLineDetail") continue;
        const d = l.SalesItemLineDetail || {};
        rows.push({ date: day(t.TxnDate), product: d.ItemRef?.name || "Item", location: t.DepartmentRef?.name || "", region: d.ClassRef?.name || t.ClassRef?.name || "", units: sign * num(d.Qty), amount: sign * num(l.Amount) });
      }
      return { rows, state: list.length === 1000 ? { k: st.k, pos: st.pos + 1000 } : { k: st.k + 1, pos: 1 } };
    }
    if (!ctx.wantInventory) return { rows: [], state: null };
    const r = await this.q(cfg, ctx, `SELECT * FROM Item WHERE Type = 'Inventory' STARTPOSITION ${st.pos} MAXRESULTS 1000`, "reading stock");
    const items = r.QueryResponse?.Item || [];
    return { rows: [], inventory: items.map((i) => ({ product: i.Name, location: "", onHand: num(i.QtyOnHand) })), state: items.length === 1000 ? { k: st.k, pos: st.pos + 1000 } : null };
  },
};

// ── Microsoft Dynamics 365 Business Central (API v2.0, Entra app with client credentials) ───────────────────────
const dynamics = {
  name: "Microsoft Dynamics 365 Business Central", auth: "credentials",
  fields: [{ k: "tenant", label: "Microsoft Entra tenant ID" }, { k: "clientId", label: "App (client) ID" }, { k: "clientSecret", label: "Client secret", secret: true },
    { k: "environment", label: "Environment name (e.g. production)" }, { k: "companyId", label: "Company ID (GUID)" }],
  help: "Your IT team registers an app in Microsoft Entra, gives it Business Central API.ReadWrite.All (application) permission, adds it in Business Central under “Microsoft Entra Applications” with read access to sales, and shares the IDs and a client secret.",
  validate(cfg) { for (const f of this.fields) if (!cfg[f.k]) return `Fill in “${f.label}”.`; return null; },
  async token(cfg, ctx) {
    if (cfg.accessToken && cfg.accessExpires > Date.now() + 60_000) return cfg.accessToken;
    const r = await (await call(ctx, `https://login.microsoftonline.com/${encodeURIComponent(cfg.tenant)}/oauth2/v2.0/token`, { method: "POST", headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ grant_type: "client_credentials", client_id: cfg.clientId, client_secret: cfg.clientSecret, scope: "https://api.businesscentral.dynamics.com/.default" }) }, "signing in to Microsoft")).json();
    cfg.accessToken = r.access_token; cfg.accessExpires = Date.now() + num(r.expires_in) * 1000;
    return cfg.accessToken;
  },
  base: (cfg) => `https://api.businesscentral.dynamics.com/v2.0/${encodeURIComponent(cfg.tenant)}/${encodeURIComponent(cfg.environment)}/api/v2.0/companies(${cfg.companyId})`,
  async get(cfg, ctx, url, what) { return (await call(ctx, url, { headers: { Authorization: `Bearer ${await this.token(cfg, ctx)}`, Accept: "application/json" } }, what)).json(); },
  async test(cfg, ctx) { const r = await this.get(cfg, ctx, `${this.base(cfg)}?$select=displayName`, "checking the company"); return `Connected to ${r.displayName || "Business Central"}.`; },
  async pull(cfg, st, ctx) {
    if (!st) {
      const r = await this.get(cfg, ctx, `${this.base(cfg)}/locations?$select=id,code,displayName`, "reading locations");
      const locs = Object.fromEntries((r.value || []).map((l) => [l.id, l.displayName || l.code]));
      return { rows: [], state: { locs, url: `${this.base(cfg)}/salesInvoices?$filter=invoiceDate ge ${ctx.since}&$expand=salesInvoiceLines&$select=id,invoiceDate,shipToState,status` } };
    }
    const r = await this.get(cfg, ctx, st.url, "reading sales invoices");
    const rows = [];
    for (const inv of r.value || []) {
      if (inv.status === "Cancelled") continue;
      for (const l of inv.salesInvoiceLines || []) {
        if (l.lineType && l.lineType !== "Item") continue;
        rows.push({ date: day(inv.invoiceDate), product: l.description || l.lineObjectNumber || "Item", location: st.locs[l.locationId] || "", region: inv.shipToState || "", units: num(l.quantity), amount: num(l.amountExcludingTax ?? l.netAmount) });
      }
    }
    return { rows, state: r["@odata.nextLink"] ? { ...st, url: r["@odata.nextLink"] } : null };
  },
};

// ── Oracle NetSuite (SuiteQL over REST, token-based authentication) ─────────────────────────────────────────────
const netsuite = {
  name: "Oracle NetSuite", auth: "credentials",
  fields: [{ k: "account", label: "Account ID (e.g. 1234567 or 1234567_SB1)" }, { k: "consumerKey", label: "Consumer key", secret: true }, { k: "consumerSecret", label: "Consumer secret", secret: true },
    { k: "tokenId", label: "Token ID", secret: true }, { k: "tokenSecret", label: "Token secret", secret: true }],
  help: "In NetSuite: enable Token-Based Authentication and REST Web Services (Setup → Company → Enable Features → SuiteCloud), create an integration record (TBA on), a role with SuiteAnalytics Workbook, REST Web Services, Transactions (view) and Lists → Items/Locations (view), then an access token for a user with that role.",
  validate(cfg) { for (const f of this.fields) if (!cfg[f.k]) return `Fill in “${f.label}”.`; if (!/^[0-9A-Za-z_]+$/.test(cfg.account)) return "The account ID looks wrong."; return null; },
  host: (cfg) => `https://${cfg.account.toLowerCase().replace(/_/g, "-")}.suitetalk.api.netsuite.com`,
  async ql(cfg, ctx, q, offset, what) {
    const url = `${this.host(cfg)}/services/rest/query/v1/suiteql?limit=1000&offset=${offset}`;
    const auth = await oauth1Header({ method: "POST", url, realm: cfg.account.toUpperCase(), consumerKey: cfg.consumerKey, consumerSecret: cfg.consumerSecret, token: cfg.tokenId, tokenSecret: cfg.tokenSecret });
    return (await call(ctx, url, { method: "POST", headers: { Authorization: auth, "Content-Type": "application/json", Prefer: "transient" }, body: JSON.stringify({ q }) }, what)).json();
  },
  async test(cfg, ctx) { await this.ql(cfg, ctx, "SELECT id FROM location WHERE ROWNUM <= 1", 0, "checking the account"); return "Connected to NetSuite."; },
  async pull(cfg, st, ctx) {
    st = st || { offset: 0 };
    const q = `SELECT TO_CHAR(t.trandate, 'YYYY-MM-DD') AS d, BUILTIN.DISPLAY(tl.item) AS item, BUILTIN.DISPLAY(tl.location) AS loc, BUILTIN.DISPLAY(t.subsidiary) AS sub, tl.quantity AS qty, tl.netamount AS amt
FROM transaction t INNER JOIN transactionline tl ON tl.transaction = t.id
WHERE t.type IN ('CashSale', 'CustInvc', 'CashRfnd', 'CustCred') AND tl.mainline = 'F' AND tl.taxline = 'F' AND tl.item IS NOT NULL AND t.trandate >= TO_DATE('${ctx.since}', 'YYYY-MM-DD')
ORDER BY t.id, tl.id`;
    const r = await this.ql(cfg, ctx, q, st.offset, "reading sales");
    // NetSuite stores sales lines as negative quantities and amounts (credits); refunds come out positive. Flip both.
    const rows = (r.items || []).map((x) => ({ date: x.d, product: x.item || "Item", location: x.loc || "", region: x.sub || "", units: -num(x.qty), amount: -num(x.amt) }));
    return { rows, state: r.hasMore ? { offset: st.offset + (r.count || rows.length) } : null };
  },
};

// ── SAP S/4HANA (OData v2: billing documents) ───────────────────────────────────────────────────────────────────
const sap = {
  name: "SAP S/4HANA", auth: "credentials",
  fields: [{ k: "host", label: "API host (e.g. https://my123456-api.s4hana.cloud.sap)" }, { k: "user", label: "Communication user" }, { k: "password", label: "Password", secret: true }],
  help: "Your SAP team creates a communication arrangement for the Billing Document integration scenario (SAP_COM_0120 in S/4HANA Cloud) with a communication user, and shares the API host, user and password.",
  validate(cfg) { if (!/^https:\/\/[a-z0-9.-]+(:\d+)?$/i.test(String(cfg.host || "").replace(/\/$/, ""))) return "The API host should start with https://"; if (!cfg.user || !cfg.password) return "Fill in the user and password."; return null; },
  base: (cfg) => `${String(cfg.host).replace(/\/$/, "")}/sap/opu/odata/sap/API_BILLING_DOCUMENT_SRV`,
  hdr: (cfg) => ({ Authorization: `Basic ${btoa(`${cfg.user}:${cfg.password}`)}`, Accept: "application/json" }),
  async test(cfg, ctx) { await call(ctx, `${this.base(cfg)}/A_BillingDocument?$top=1&$format=json&$select=BillingDocument`, { headers: this.hdr(cfg) }, "checking access"); return "Connected to SAP."; },
  async pull(cfg, st, ctx) {
    st = st || { skip: 0 };
    const top = 200;
    const filter = encodeURIComponent(`BillingDocumentDate ge datetime'${ctx.since}T00:00:00' and BillingDocumentIsCancelled eq false`);
    const select = "BillingDocument,BillingDocumentDate,SalesOrganization,to_Item/Material,to_Item/BillingDocumentItemText,to_Item/BillingQuantity,to_Item/NetAmount,to_Item/Plant";
    const url = `${this.base(cfg)}/A_BillingDocument?$format=json&$filter=${filter}&$expand=to_Item&$select=${select}&$orderby=BillingDocument&$top=${top}&$skip=${st.skip}`;
    const r = await (await call(ctx, url, { headers: this.hdr(cfg) }, "reading billing documents")).json();
    const docs = r.d?.results || [];
    const rows = [];
    for (const d of docs) {
      const ms = Number(/\/Date\((-?\d+)/.exec(d.BillingDocumentDate || "")?.[1]);
      const date = Number.isFinite(ms) ? new Date(ms).toISOString().slice(0, 10) : day(d.BillingDocumentDate);
      for (const i of d.to_Item?.results || []) rows.push({ date, product: i.BillingDocumentItemText || i.Material || "Item", location: i.Plant || "", region: d.SalesOrganization || "", units: num(i.BillingQuantity), amount: num(i.NetAmount) });
    }
    return { rows, state: docs.length === top ? { skip: st.skip + top } : null };
  },
};

// ── Any other system: a CSV file at a web address, fetched every night ──────────────────────────────────────────
const httpfile = {
  name: "File from a web address (any system)", auth: "credentials",
  fields: [{ k: "url", label: "File address (https://…)" }, { k: "header", label: "Optional header, e.g. Authorization: Bearer …", secret: true }],
  help: "Any system that can save a CSV export to a web address (a SharePoint/OneDrive/S3/Azure link with a token, or your own server) can be pulled every night. The columns are recognised the same way as an upload.",
  validate(cfg) { try { const u = new URL(cfg.url); if (u.protocol !== "https:") return "The address must start with https://"; } catch { return "That doesn't look like a web address."; } return null; },
  hdr(cfg) { const m = /^([A-Za-z0-9-]+):\s*(.+)$/.exec(cfg.header || ""); return m ? { [m[1]]: m[2] } : {}; },
  async test(cfg, ctx) { const res = await call(ctx, cfg.url, { headers: { ...this.hdr(cfg), Range: "bytes=0-2047" } }, "fetching the file"); const t = await res.text(); return `Reached the file. First line: ${t.split(/\r\n|\r|\n/)[0].slice(0, 120)}`; },
  file: true,
};

export const CONNECTORS = { netsuite, sap, dynamics, quickbooks, shopify, square, httpfile };
export const connectorList = () => Object.entries(CONNECTORS).map(([kind, c]) => ({ kind, name: c.name, auth: c.auth, fields: c.fields, help: c.help }));
