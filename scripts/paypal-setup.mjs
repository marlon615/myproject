// One-time PayPal setup: creates the ChurchFollow product, the $39/month plan, and the webhook.
//
//   PAYPAL_ENV=sandbox PAYPAL_CLIENT_ID=... PAYPAL_CLIENT_SECRET=... \
//   APP_URL=https://your-domain.com npm run paypal:setup
//
// Prints PAYPAL_PLAN_ID and PAYPAL_WEBHOOK_ID to paste into Vercel's environment variables.
// Run it once for sandbox and once for live (they're separate PayPal accounts).
import { config } from "dotenv";

config({ path: [".env.local", ".env"], quiet: true });

const env = process.env.PAYPAL_ENV === "live" ? "live" : "sandbox";
const base = env === "live" ? "https://api-m.paypal.com" : "https://api-m.sandbox.paypal.com";
const { PAYPAL_CLIENT_ID: id, PAYPAL_CLIENT_SECRET: secret } = process.env;
const appUrl = (process.env.APP_URL ?? "").replace(/\/$/, "");
const PRICE = process.env.PRICE_MONTHLY_USD ?? "39";

if (!id || !secret) {
  console.error("Set PAYPAL_CLIENT_ID and PAYPAL_CLIENT_SECRET first (developer.paypal.com → Apps & Credentials).");
  process.exit(1);
}

async function call(path, { method = "GET", body, token } = {}) {
  const res = await fetch(base + path, {
    method,
    headers: token
      ? { Authorization: `Bearer ${token}`, "Content-Type": "application/json", Prefer: "return=representation" }
      : { Authorization: "Basic " + Buffer.from(`${id}:${secret}`).toString("base64"), "Content-Type": "application/x-www-form-urlencoded" },
    body,
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(`${method} ${path} → HTTP ${res.status}: ${JSON.stringify(data)}`);
  return data;
}

const { access_token: token } = await call("/v1/oauth2/token", { method: "POST", body: "grant_type=client_credentials" });
console.log(`Connected to PayPal (${env}).`);

let planId = process.env.PAYPAL_PLAN_ID;
if (planId) {
  console.log(`Using existing plan ${planId}.`);
} else {
  const product = await call("/v1/catalogs/products", {
    method: "POST",
    token,
    body: JSON.stringify({ name: "ChurchFollow", description: "First-time visitor follow-up for churches", type: "SERVICE", category: "SOFTWARE" }),
  });
  const plan = await call("/v1/billing/plans", {
    method: "POST",
    token,
    body: JSON.stringify({
      product_id: product.id,
      name: `ChurchFollow Monthly ($${PRICE}/mo)`,
      status: "ACTIVE",
      billing_cycles: [
        {
          frequency: { interval_unit: "MONTH", interval_count: 1 },
          tenure_type: "REGULAR",
          sequence: 1,
          total_cycles: 0,
          pricing_scheme: { fixed_price: { value: PRICE, currency_code: "USD" } },
        },
      ],
      payment_preferences: { auto_bill_outstanding: true, payment_failure_threshold: 3 },
    }),
  });
  planId = plan.id;
  console.log(`Created plan ${planId} ($${PRICE}/month).`);
}

let webhookId = process.env.PAYPAL_WEBHOOK_ID;
if (webhookId) {
  console.log(`Using existing webhook ${webhookId}.`);
} else if (!appUrl.startsWith("https://")) {
  console.log("\nSkipped webhook: set APP_URL to your public https:// address and run this again to create it.");
} else {
  const url = `${appUrl}/api/paypal/webhook`;
  const existing = await call("/v1/notifications/webhooks", { token });
  const found = (existing.webhooks ?? []).find((w) => w.url === url);
  if (found) {
    webhookId = found.id;
    console.log(`Webhook already exists for ${url}.`);
  } else {
    const hook = await call("/v1/notifications/webhooks", {
      method: "POST",
      token,
      body: JSON.stringify({
        url,
        event_types: [
          "BILLING.SUBSCRIPTION.ACTIVATED",
          "BILLING.SUBSCRIPTION.UPDATED",
          "BILLING.SUBSCRIPTION.RE-ACTIVATED",
          "BILLING.SUBSCRIPTION.SUSPENDED",
          "BILLING.SUBSCRIPTION.CANCELLED",
          "BILLING.SUBSCRIPTION.EXPIRED",
          "BILLING.SUBSCRIPTION.PAYMENT.FAILED",
          "PAYMENT.SALE.COMPLETED",
        ].map((name) => ({ name })),
      }),
    });
    webhookId = hook.id;
    console.log(`Created webhook → ${url}`);
  }
}

console.log("\nAdd these to Vercel → Settings → Environment Variables, then redeploy:\n");
console.log(`  PAYPAL_ENV=${env}`);
console.log(`  PAYPAL_PLAN_ID=${planId}`);
if (webhookId) console.log(`  PAYPAL_WEBHOOK_ID=${webhookId}`);
console.log("  (plus PAYPAL_CLIENT_ID and PAYPAL_CLIENT_SECRET)\n");
