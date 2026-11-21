/**
 * The job-ad database on Cloudflare: one SQLite-backed Durable Object (free plan), named "all". Each call runs alone
 * and is written to disk before it returns, so a saved ad is never lost or overwritten by a later step.
 * The SQL lives in jobstore.js and ideastore.js (no DELETE anywhere).
 */
import { DurableObject } from "cloudflare:workers";
import { JobAdsStore } from "./jobstore.js";
import { IdeasStore } from "./ideastore.js";

export class JobAdsDB extends DurableObject {
  constructor(ctx, env) {
    super(ctx, env);
    const tx = (fn) => ctx.storage.transactionSync(fn);
    this.store = new JobAdsStore(ctx.storage.sql, tx);
    this.ideas = new IdeasStore(ctx.storage.sql, tx); // every idea ever reported (ideastore.js)
  }
  save(ads, opts) { return this.store.save(ads, opts); }
  qualify(items, opts) { return this.store.qualify(items, opts); }
  stats() { return this.store.stats(); }
  list(opts) { return this.store.list(opts); }
  forRun(run) { return this.store.forRun(run); }
  ideasRecord(list) { return this.ideas.record(list); }
  ideasUpdate(list) { return this.ideas.update(list); }
  ideasList() { return this.ideas.list(); }
  ideasCount() { return this.ideas.count(); }
  ideasFlag(k) { return this.ideas.getFlag(k); }
  ideasSetFlag(k, v) { return this.ideas.setFlag(k, v); }
}
