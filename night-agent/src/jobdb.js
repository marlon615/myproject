/**
 * The job-ad database on Cloudflare: one SQLite-backed Durable Object (free plan), named "all". Each call runs alone
 * and is written to disk before it returns, so a saved ad is never lost or overwritten by a later step.
 * The SQL lives in jobstore.js (no DELETE anywhere).
 */
import { DurableObject } from "cloudflare:workers";
import { JobAdsStore } from "./jobstore.js";

export class JobAdsDB extends DurableObject {
  constructor(ctx, env) {
    super(ctx, env);
    this.store = new JobAdsStore(ctx.storage.sql, (fn) => ctx.storage.transactionSync(fn));
  }
  save(ads, opts) { return this.store.save(ads, opts); }
  qualify(items, opts) { return this.store.qualify(items, opts); }
  stats() { return this.store.stats(); }
  list(opts) { return this.store.list(opts); }
  forRun(run) { return this.store.forRun(run); }
}
