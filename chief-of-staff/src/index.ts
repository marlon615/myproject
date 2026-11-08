import { changePassword, checkPassword, clearCookie, clearLogins, isSignedIn, loginAllowed, recordFailedLogin, sessionCookie } from "./auth";
import { buildDailyDrafts } from "./draft";
import { sendEmail } from "./send";
import { getSettings, hasSecret, saveSettings, setSecret, DEFAULTS, type Settings } from "./settings";
import { DurableObject } from "cloudflare:workers";
import { migrate, sqliteDB, type Stmt } from "./db";
import SCHEMA from "../schema.sql";
import { PRODUCTS, type Draft, type Env, type Product, type Prospect, type WorkerEnv } from "./types";
import { approvePage, dashboardPage, loginPage, prospectsPage, settingsPage, voicePage } from "./views";
import { runCommand } from "./voice";
import { dashboard } from "./stats";

const SECURITY_HEADERS: Record<string, string> = {
  "Content-Security-Policy": "default-src 'none'; style-src 'unsafe-inline'; script-src 'unsafe-inline'; connect-src 'self'; form-action 'self' mailto:; img-src 'self' data:; base-uri 'none'; frame-ancestors 'none'",
  "X-Content-Type-Options": "nosniff",
  "X-Frame-Options": "DENY",
  "Referrer-Policy": "same-origin",
  "Strict-Transport-Security": "max-age=63072000; includeSubDomains",
  "X-Robots-Tag": "noindex, nofollow",
  "Cache-Control": "no-store",
};

function html(body: string, status = 200, extra: Record<string, string> = {}) {
  return new Response(body, { status, headers: { "Content-Type": "text/html; charset=utf-8", ...SECURITY_HEADERS, ...extra } });
}
function json(data: unknown, status = 200) {
  return new Response(JSON.stringify(data), { status, headers: { "Content-Type": "application/json", ...SECURITY_HEADERS } });
}
function redirect(to: string, extra: Record<string, string> = {}) {
  return new Response(null, { status: 303, headers: { Location: to, ...SECURITY_HEADERS, ...extra } });
}
const withMsg = (path: string, msg: string) => `${path}${path.includes("?") ? "&" : "?"}m=${encodeURIComponent(msg)}`;

const str = (v: unknown, max: number) => (typeof v === "string" ? v.trim().slice(0, max) : "");
const isProduct = (v: string): v is Product => (PRODUCTS as string[]).includes(v);
const EMAIL = /^[^\s@<>(),;:"]+@[^\s@<>(),;:"]+\.[^\s@<>(),;:"]{2,}$/;

/** Blocks form posts from other websites. */
function sameOrigin(req: Request) {
  const origin = req.headers.get("origin");
  if (!origin || origin === "null") return req.headers.get("sec-fetch-site") === "same-origin";
  return origin === new URL(req.url).origin;
}

async function decide(req: Request, env: Env, id: number) {
  const wantsJson = (req.headers.get("accept") ?? "").includes("application/json");
  const reply = (ok: boolean, data: Record<string, unknown>) => (wantsJson ? json({ ok, ...data }, ok ? 200 : 400) : redirect(withMsg("/review", String(data.error ?? data.label ?? "Done"))));

  const form = await req.formData();
  const decision = str(form.get("decision"), 5);
  const draft = await env.DB.prepare("select * from drafts where id = ?").bind(id).first<Draft>();
  if (!draft || draft.status !== "pending") return reply(false, { error: "This draft was already handled." });
  const now = new Date().toISOString();

  if (decision === "no") {
    await env.DB.prepare("update drafts set status = 'rejected', decided_at = ? where id = ? and status = 'pending'").bind(now, id).run();
    return reply(true, { label: "Skipped" });
  }
  if (decision !== "yes") return reply(false, { error: "Tap Yes or No." });

  const subject = str(form.get("subject"), 200) || draft.subject;
  const body = str(form.get("body"), 5000) || draft.body;
  const p = await env.DB.prepare("select * from prospects where id = ?").bind(draft.prospect_id).first<Prospect>();
  if (!p) return reply(false, { error: "That prospect was deleted." });
  if (p.status === "do_not_contact" || p.status === "not_interested") {
    await env.DB.prepare("update drafts set status = 'rejected', decided_at = ?, error = 'Prospect opted out' where id = ?").bind(now, id).run();
    return reply(false, { error: `${p.name || p.email} is marked "${p.status.replace(/_/g, " ")}", so nothing was sent.` });
  }

  // Claim the draft first so a double tap can never send twice.
  const claim = await env.DB.prepare("update drafts set status = 'approved', subject = ?, body = ?, decided_at = ? where id = ? and status = 'pending'").bind(subject, body, now, id).run();
  if (!claim.meta.changes) return reply(false, { error: "This draft was already handled." });

  const s = await getSettings(env);
  const result = await sendEmail(env, s, p.email, subject, body);
  if (!result.ok) {
    await env.DB.prepare("update drafts set status = 'pending', error = ? where id = ?").bind(result.error, id).run();
    return reply(false, { error: `Not sent. ${result.error}` });
  }
  await env.DB.batch([
    env.DB.prepare("update drafts set status = 'sent', sent_at = ?, error = null where id = ?").bind(now, id),
    env.DB.prepare("update prospects set touches = touches + 1, last_sent_at = ?, status = case when status = 'new' then 'contacted' else status end where id = ?").bind(now, p.id),
  ]);
  return result.via === "mailto" ? reply(true, { label: "Opening Mail…", href: result.href }) : reply(true, { label: "Sent ✓" });
}

async function handle(req: Request, env: Env): Promise<Response> {
  const url = new URL(req.url);
  const path = url.pathname;
  const method = req.method;
  const ip = req.headers.get("cf-connecting-ip") ?? "unknown";

  if (!env.SESSION_SECRET || env.SESSION_SECRET.length < 32 || !env.OWNER_PASSWORD) {
    return html("<h1>Not configured</h1><p>OWNER_PASSWORD and SESSION_SECRET must be set.</p>", 500);
  }
  if (path === "/robots.txt") return new Response("User-agent: *\nDisallow: /\n", { headers: { "Content-Type": "text/plain" } });
  if (method === "POST" && !sameOrigin(req)) return html("Forbidden", 403);

  if (path === "/login") {
    if (method === "POST") {
      if (!(await loginAllowed(env, ip))) return html(loginPage("Too many tries. Wait 15 minutes."), 429);
      const pw = str((await req.formData()).get("password"), 200);
      if (!(await checkPassword(env, pw))) {
        await recordFailedLogin(env, ip);
        return html(loginPage("Wrong password."), 401);
      }
      await clearLogins(env, ip);
      return redirect("/", { "Set-Cookie": await sessionCookie(env) });
    }
    return (await isSignedIn(req, env)) ? redirect("/") : html(loginPage());
  }

  if (!(await isSignedIn(req, env))) return method === "GET" ? redirect("/login") : html("Sign in first.", 401);
  const msg = url.searchParams.get("m")?.slice(0, 200) || undefined;

  if (path === "/logout" && method === "POST") return redirect("/login", { "Set-Cookie": clearCookie });

  if (path === "/" && method === "GET") {
    const [s, resend] = await Promise.all([getSettings(env), hasSecret(env, "resend")]);
    return html(voicePage(resend && s.senderEmail ? "resend" : "mailto"));
  }

  if (path === "/api/command" && method === "POST") {
    const text = str((await req.formData()).get("text"), 500);
    if (!text) return json({ say: "I didn't hear a command." });
    return json(await runCommand(env, text));
  }

  if (path === "/review" && method === "GET") {
    const [{ results }, s, resend] = await Promise.all([
      env.DB.prepare(`select d.*, p.name, p.email, p.organization from drafts d join prospects p on p.id = d.prospect_id
                      where d.status = 'pending' order by d.created_at, d.id limit 50`).all<Draft & { name: string; email: string; organization: string }>(),
      getSettings(env),
      hasSecret(env, "resend"),
    ]);
    return html(approvePage(results, s, resend && s.senderEmail ? "resend" : "mailto", msg));
  }

  const decideMatch = path.match(/^\/drafts\/(\d+)\/decide$/);
  if (decideMatch && method === "POST") return decide(req, env, Number(decideMatch[1]));

  if (path === "/draft-now" && method === "POST") {
    const r = await buildDailyDrafts(env, "manual");
    return redirect(withMsg("/review", r.note));
  }

  if (path === "/prospects" && method === "GET") {
    const product = url.searchParams.get("product") ?? "";
    const status = url.searchParams.get("status") ?? "";
    const where: string[] = [], binds: string[] = [];
    if (isProduct(product)) { where.push("product = ?"); binds.push(product); }
    if (["new", "contacted", "replied", "not_interested", "do_not_contact"].includes(status)) { where.push("status = ?"); binds.push(status); }
    const { results } = await env.DB.prepare(`select * from prospects ${where.length ? "where " + where.join(" and ") : ""} order by id desc limit 500`).bind(...binds).all<Prospect>();
    return html(prospectsPage(results, { product, status }, msg));
  }

  if (path === "/prospects" && method === "POST") {
    const f = await req.formData();
    const product = str(f.get("product"), 20);
    const email = str(f.get("email"), 200).toLowerCase();
    if (!isProduct(product) || !EMAIL.test(email)) return redirect(withMsg("/prospects", "That email address doesn't look right."));
    const r = await env.DB.prepare("insert into prospects (product, name, email, organization, notes) values (?, ?, ?, ?, ?) on conflict(product, email) do nothing")
      .bind(product, str(f.get("name"), 120), email, str(f.get("organization"), 160), str(f.get("notes"), 800)).run();
    return redirect(withMsg("/prospects", r.meta.changes ? "Added. They'll get a draft in the next run." : "Already on the list."));
  }

  if (path === "/prospects/bulk" && method === "POST") {
    const f = await req.formData();
    const product = str(f.get("product"), 20);
    if (!isProduct(product)) return redirect("/prospects");
    const lines = str(f.get("lines"), 100_000).split(/\r?\n/).map((l) => l.trim()).filter(Boolean).slice(0, 1000);
    let added = 0, skipped = 0;
    const stmts: Stmt[] = [];
    for (const line of lines) {
      const parts = line.split(/\t|,/).map((x) => x.trim());
      const ei = parts.findIndex((x) => EMAIL.test(x));
      if (ei < 0) { skipped++; continue; }
      const email = parts[ei].toLowerCase();
      const rest = parts.filter((_, i) => i !== ei);
      const name = ei === 0 ? "" : rest.shift() ?? "";
      const org = rest.shift() ?? "";
      const notes = rest.join(", ");
      stmts.push(env.DB.prepare("insert into prospects (product, name, email, organization, notes) values (?, ?, ?, ?, ?) on conflict(product, email) do nothing")
        .bind(product, name.slice(0, 120), email, org.slice(0, 160), notes.slice(0, 800)));
    }
    if (stmts.length) {
      const res = await env.DB.batch(stmts);
      added = res.reduce((a, r) => a + (r.meta.changes ?? 0), 0);
    }
    const dup = stmts.length - added;
    return redirect(withMsg("/prospects", `Added ${added}.${dup ? ` ${dup} already on the list.` : ""}${skipped ? ` ${skipped} lines had no email.` : ""}`));
  }

  const statusMatch = path.match(/^\/prospects\/(\d+)\/status$/);
  if (statusMatch && method === "POST") {
    const status = str((await req.formData()).get("status"), 20);
    if (["new", "contacted", "replied", "not_interested", "do_not_contact"].includes(status)) {
      const id = Number(statusMatch[1]);
      const stmts = [env.DB.prepare("update prospects set status = ? where id = ?").bind(status, id)];
      if (status !== "new" && status !== "contacted") {
        stmts.push(env.DB.prepare("update drafts set status = 'rejected', decided_at = ?, error = 'Prospect status changed' where prospect_id = ? and status = 'pending'").bind(new Date().toISOString(), id));
      }
      await env.DB.batch(stmts);
    }
    return redirect(withMsg("/prospects", "Saved."));
  }

  const delMatch = path.match(/^\/prospects\/(\d+)\/delete$/);
  if (delMatch && method === "POST") {
    const id = Number(delMatch[1]);
    await env.DB.batch([
      env.DB.prepare("delete from drafts where prospect_id = ?").bind(id),
      env.DB.prepare("delete from prospects where id = ?").bind(id),
    ]);
    return redirect(withMsg("/prospects", "Deleted."));
  }

  if (path === "/dashboard" && method === "GET") return html(dashboardPage(await dashboard(env)));

  if (path === "/settings" && method === "GET") {
    const [s, anthropic, resend] = await Promise.all([getSettings(env), hasSecret(env, "anthropic"), hasSecret(env, "resend")]);
    return html(settingsPage(s, { anthropic, resend }, msg));
  }

  if (path === "/settings" && method === "POST") {
    const f = await req.formData();
    const next: Partial<Settings> = {};
    for (const k of Object.keys(DEFAULTS) as (keyof Settings)[]) {
      const v = f.get(k);
      if (v === null) continue;
      if (k === "dailyLimit") next[k] = Math.min(50, Math.max(1, Number(v) || DEFAULTS[k]));
      else if (k === "followUpDays") next[k] = Math.min(30, Math.max(1, Number(v) || DEFAULTS[k]));
      else if (k === "maxTouches") next[k] = Math.min(5, Math.max(1, Number(v) || DEFAULTS[k]));
      else (next as Record<string, string>)[k] = str(v, 1200);
    }
    if (next.senderEmail && !EMAIL.test(next.senderEmail)) return redirect(withMsg("/settings", "The sending address doesn't look right."));
    if (next.replyTo && !EMAIL.test(next.replyTo)) return redirect(withMsg("/settings", "The reply-to address doesn't look right."));
    await saveSettings(env, next);
    return redirect(withMsg("/settings", "Settings saved."));
  }

  if (path === "/settings/keys" && method === "POST") {
    const f = await req.formData();
    const remove = str(f.get("remove"), 20);
    if (remove === "anthropic" || remove === "resend") {
      await setSecret(env, remove, null);
      return redirect(withMsg("/settings", "Key removed."));
    }
    const a = str(f.get("anthropic"), 400), r = str(f.get("resend"), 400);
    if (a && !a.startsWith("sk-ant-")) return redirect(withMsg("/settings", "That doesn't look like an Anthropic key (it should start with sk-ant-)."));
    if (r && !r.startsWith("re_")) return redirect(withMsg("/settings", "That doesn't look like a Resend key (it should start with re_)."));
    if (a) await setSecret(env, "anthropic", a);
    if (r) await setSecret(env, "resend", r);
    return redirect(withMsg("/settings", a || r ? "Key saved." : "Nothing to save."));
  }

  if (path === "/settings/password" && method === "POST") {
    const f = await req.formData();
    if (!(await loginAllowed(env, ip))) return redirect(withMsg("/settings", "Too many tries. Wait 15 minutes."));
    if (!(await checkPassword(env, str(f.get("current"), 200)))) {
      await recordFailedLogin(env, ip);
      return redirect(withMsg("/settings", "Current password is wrong."));
    }
    const next = str(f.get("next"), 200);
    if (next.length < 12) return redirect(withMsg("/settings", "New password needs 12+ characters."));
    await changePassword(env, next);
    return redirect("/", { "Set-Cookie": await sessionCookie(env) });
  }

  return html("<h1>Not found</h1><p><a href=\"/\">Back</a></p>", 404);
}

/**
 * The whole app runs inside one Durable Object, which holds the SQLite database.
 * There is only one owner, so one instance ("main") is all that's needed.
 */
export class ChiefOfStaff extends DurableObject<WorkerEnv> {
  private app: Env;
  constructor(ctx: DurableObjectState, env: WorkerEnv) {
    super(ctx, env);
    ctx.blockConcurrencyWhile(async () => migrate(ctx.storage, SCHEMA));
    this.app = { DB: sqliteDB(ctx.storage), OWNER_PASSWORD: env.OWNER_PASSWORD, SESSION_SECRET: env.SESSION_SECRET, APP_TIMEZONE: env.APP_TIMEZONE };
  }
  async fetch(req: Request): Promise<Response> {
    try {
      return await handle(req, this.app);
    } catch (e) {
      console.error("request failed:", (e as Error).stack ?? e);
      return html("<h1>Something went wrong</h1><p>Try again in a moment. <a href=\"/\">Back</a></p>", 500);
    }
  }
  async morning(): Promise<string> {
    return (await buildDailyDrafts(this.app, "cron")).note;
  }
}

const main = (env: WorkerEnv) => env.APP.get(env.APP.idFromName("main")) as DurableObjectStub<ChiefOfStaff>;

export default {
  async fetch(req: Request, env: WorkerEnv): Promise<Response> {
    return main(env).fetch(req);
  },
  async scheduled(_ctrl: ScheduledController, env: WorkerEnv, ctx: ExecutionContext) {
    ctx.waitUntil(main(env).morning().then((note) => console.log("morning drafts:", note)));
  },
} satisfies ExportedHandler<WorkerEnv>;
