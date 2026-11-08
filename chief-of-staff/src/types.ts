import type { DB } from "./db";

/** What Cloudflare gives the Worker. */
export interface WorkerEnv {
  APP: DurableObjectNamespace;
  OWNER_PASSWORD: string;
  SESSION_SECRET: string;
  APP_TIMEZONE?: string;
}

/** What the app code uses: the same, plus the database. */
export interface Env {
  DB: DB;
  OWNER_PASSWORD: string;
  SESSION_SECRET: string;
  APP_TIMEZONE?: string;
}

export type Product = "clientpulse" | "churchfollow";
export const PRODUCTS: Product[] = ["clientpulse", "churchfollow"];
export const PRODUCT_NAME: Record<Product, string> = { clientpulse: "ClientPulse", churchfollow: "ChurchFollow" };

export type ProspectStatus = "new" | "contacted" | "replied" | "not_interested" | "do_not_contact";

export interface Prospect {
  id: number;
  product: Product;
  name: string;
  email: string;
  organization: string;
  notes: string;
  status: ProspectStatus;
  touches: number;
  last_sent_at: string | null;
  created_at: string;
}

export interface Draft {
  id: number;
  prospect_id: number;
  product: Product;
  touch: number;
  subject: string;
  body: string;
  source: "ai" | "template";
  status: "pending" | "approved" | "rejected" | "sent" | "failed";
  error: string | null;
  created_at: string;
  decided_at: string | null;
  sent_at: string | null;
}
