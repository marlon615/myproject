/**
 * Chief: talk to your chief of staff inside the app, like a voice assistant.
 * Tap once and talk; Chief reads your important emails aloud one at a time, understands what you say in
 * plain words, and sends only what you approve. One calm screen, plus a hidden owner dashboard at /owner.
 */
import { DurableObject } from "cloudflare:workers";
import SCHEMA from "../schema.sql";
import { checkPassword, checkPin, clearCookie, clearLogins, hasPin, isSignedIn, loginAllowed, recordFailedLogin, sessionCookie, setPin } from "./auth";
import { resumeTalk, startTalk, talkTurn } from "./conversation";
import { b64url } from "./crypto";
import { migrate, sqliteDB } from "./db";
import { gmailCreds, syncInbox, testGmail } from "./inbox";
import { setPerm } from "./permissions";
import { pushCount, sendPush, vapidKeys } from "./push";
import { icon, MANIFEST, SERVICE_WORKER } from "./pwa";
import { getSettings, hasSecret, saveSettings, setSecret } from "./settings";
import type { Env, WorkerEnv } from "./types";
import { homePage, lockPage, ownerPage, passcodePage } from "./ui";
import { VOICE_PICK_JS } from "./voicepick";

const SECURITY_HEADERS: Record<string, string> = {
  "Content-Security-Policy": "default-src 'none'; style-src 'unsafe-inline'; script-src 'self' 'unsafe-inline'; worker-src 'self'; manifest-src 'self'; connect-src 'self'; form-action 'self'; img-src 'self' data:; base-uri 'none'; frame-ancestors 'none'",
  "X-Content-Type-Options": "nosniff",
  "X-Frame-Options": "DENY",
  "Referrer-Policy": "same-origin",
  "Strict-Transport-Security": "max-age=63072000; includeSubDomains",
  "X-Robots-Tag": "noindex, nofollow",
  "Cache-Control": "no-store",
};
const html = (body: string, status = 200, extra: Record<string, string> = {}) =>
  new Response(body, { status, headers: { "Content-Type": "text/html; charset=utf-8", ...SECURITY_HEADERS, ...extra } });
const json = (data: unknown, status = 200) => new Response(JSON.stringify(data), { status, headers: { "Content-Type": "application/json", ...SECURITY_HEADERS } });
const redirect = (to: string, extra: Record<string, string> = {}) => new Response(null, { status: 303, headers: { Location: to, ...SECURITY_HEADERS, ...extra } });
const str = (v: unknown, max: number) => (typeof v === "string" ? v.trim().slice(0, max) : "");
const EMAIL = /^[^\s@<>(),;:"]+@[^\s@<>(),;:"]+\.[^\s@<>(),;:"]{2,}$/;

function safeNext(n: string | null) {
  return n && /^\/(?!\/)[\w\-/?=&%.]*$/.test(n) ? n : "/";
}
function sameOrigin(req: Request) {
  const origin = req.headers.get("origin");
  if (!origin || origin === "null") return req.headers.get("sec-fetch-site") === "same-origin";
  return origin === new URL(req.url).origin;
}
async function setting(env: Env, key: string) {
  return (await env.DB.prepare("select value from settings where key = ?").bind(key).first<{ value: string }>())?.value ?? null;
}
const IMPORTANT_COUNT = "select count(*) as n from inbox where status = 'new' and (needs_reply = 1 or priority = 'high')";

async function handle(req: Request, env: Env): Promise<Response> {
  const url = new URL(req.url);
  const path = url.pathname;
  const method = req.method;
  const ip = req.headers.get("cf-connecting-ip") ?? "unknown";

  if (!env.SESSION_SECRET || env.SESSION_SECRET.length < 32 || !env.OWNER_PASSWORD) return html("Not configured", 500);

  // Public files the phone needs for the Home Screen app.
  if (path === "/robots.txt") return new Response("User-agent: *\nDisallow: /\n", { headers: { "Content-Type": "text/plain" } });
  if (path === "/manifest.webmanifest") return new Response(MANIFEST, { headers: { "Content-Type": "application/manifest+json" } });
  if (path === "/sw.js") return new Response(SERVICE_WORKER, { headers: { "Content-Type": "text/javascript; charset=utf-8", "Cache-Control": "no-cache" } });
  if (path === "/icon-192.png") return icon(192);
  if (path === "/icon-512.png") return icon(512);

  if (method === "POST" && !sameOrigin(req)) return html("Forbidden", 403);

  // ── Unlock ──
  if (path === "/login") {
    const pinMode = (await hasPin(env)) && url.searchParams.get("use") !== "password";
    if (method === "POST") {
      const f = await req.formData();
      const next = safeNext(str(f.get("next"), 300) || null);
      const pin = str(f.get("pin"), 10);
      if (!(await loginAllowed(env, ip))) return html(lockPage("Too many tries. Wait 15 minutes.", pin ? "pin" : "password", next), 429);
      const ok = pin ? await checkPin(env, pin) : await checkPassword(env, str(f.get("password"), 200));
      if (!ok) { await recordFailedLogin(env, ip); return html(lockPage(pin ? "Wrong passcode. Try again." : "Wrong password.", pin ? "pin" : "password", next), 401); }
      await clearLogins(env, ip);
      return redirect((await hasPin(env)) ? next : "/passcode", { "Set-Cookie": await sessionCookie(env) });
    }
    if (await isSignedIn(req, env)) return redirect("/");
    const n = safeNext(url.searchParams.get("next"));
    return html(lockPage(undefined, pinMode ? "pin" : "password", n === "/" ? "" : n));
  }

  if (!(await isSignedIn(req, env))) return method === "GET" ? redirect(path === "/" ? "/login" : `/login?next=${encodeURIComponent(path)}`) : html("Sign in first.", 401);

  if (path === "/logout" && method === "POST") return redirect("/login", { "Set-Cookie": clearCookie });

  if (path === "/passcode") {
    if (method === "GET") return html(passcodePage());
    const f = await req.formData();
    const pin = str(f.get("pin"), 10), pin2 = str(f.get("pin2"), 10);
    if (!/^\d{6}$/.test(pin)) return html(passcodePage("Use exactly 6 digits."), 400);
    if (pin !== pin2) return html(passcodePage("The two don't match."), 400);
    if (/^(\d)\1{5}$|^(123456|654321|012345)$/.test(pin)) return html(passcodePage("Too easy to guess. Pick another."), 400);
    await setPin(env, pin);
    return redirect("/");
  }

  // ── The one screen: talk to Chief ──
  if (path === "/" && method === "GET") {
    const waiting = (await env.DB.prepare(IMPORTANT_COUNT).first<{ n: number }>())?.n ?? 0;
    await env.DB.prepare("insert into settings (key, value) values ('app:origin', ?) on conflict(key) do update set value = excluded.value").bind(url.origin).run();
    return html(homePage({ waiting, canNotify: (await pushCount(env)) === 0, voiceJs: VOICE_PICK_JS }));
  }

  // The conversation: the phone sends what you said; Chief answers with what to say next.
  if (path.startsWith("/api/talk") && method === "POST") {
    const b = (await req.json().catch(() => ({}))) as { id?: string; text?: string };
    const id = str(b.id, 64);
    if (path === "/api/talk/start") return json(await startTalk(env, id));
    if (path === "/api/talk/resume") return json(await resumeTalk(env, id));
    if (path === "/api/talk") return json(await talkTurn(env, id, str(b.text, 600)));
  }

  if (path === "/api/push-key" && method === "GET") return json({ key: b64url((await vapidKeys(env)).publicRaw) });
  if (path === "/api/push-subscribe" && method === "POST") {
    const sub = (await req.json().catch(() => null)) as { endpoint?: string; keys?: { p256dh?: string; auth?: string } } | null;
    if (!sub?.endpoint || !/^https:\/\//.test(sub.endpoint) || !sub.keys?.p256dh || !sub.keys.auth) return json({ ok: false }, 400);
    await env.DB.prepare("insert into push_subs (endpoint, p256dh, auth) values (?, ?, ?) on conflict(endpoint) do update set p256dh = excluded.p256dh, auth = excluded.auth")
      .bind(sub.endpoint.slice(0, 1000), sub.keys.p256dh.slice(0, 200), sub.keys.auth.slice(0, 100)).run();
    return json({ ok: true });
  }

  // ── Hidden owner dashboard (never linked from the app) ──
  if (path === "/owner" && method === "GET") return html(ownerPage(await ownerData(env, url.searchParams.get("m"))));

  if (path === "/owner/connect" && method === "POST") {
    const f = await req.formData();
    const notes: string[] = [];
    const ai = str(f.get("anthropic"), 400);
    if (ai) {
      if (!ai.startsWith("sk-ant-")) notes.push("That Anthropic key should start with sk-ant-.");
      else { await setSecret(env, "anthropic", ai); notes.push("Anthropic key saved."); }
    }
    const gAddr = str(f.get("gmailAddress"), 200).toLowerCase() || (await getSettings(env)).gmailAddress;
    const gPass = str(f.get("gmailPassword"), 100).replace(/\s+/g, "");
    if (gPass) {
      if (!EMAIL.test(gAddr)) notes.push("Add your Gmail address too.");
      else {
        const err = await testGmail(env, gAddr, gPass);
        if (err) notes.push(`Gmail didn't connect: ${err}`);
        else { await saveSettings(env, { gmailAddress: gAddr }); await setSecret(env, "gmail", gPass); await setPerm(env, "email", true); notes.push("Gmail connected."); }
      }
    }
    return redirect(`/owner?m=${encodeURIComponent(notes.join(" ") || "Nothing to save.")}`);
  }

  if (path === "/owner/unblock" && method === "POST") {
    const email = str((await req.formData()).get("email"), 200).toLowerCase();
    await env.DB.prepare("delete from blocked where email = ?").bind(email).run();
    return redirect(`/owner?m=${encodeURIComponent(`Unblocked ${email}.`)}`);
  }

  return html("Not found", 404);
}

async function ownerData(env: Env, flash: string | null) {
  const tz = env.APP_TIMEZONE || "America/Chicago";
  const fmt = (iso: string) => new Date(iso).toLocaleString("en-US", { timeZone: tz, month: "short", day: "numeric", hour: "numeric", minute: "2-digit" });
  const week = new Date(Date.now() - 7 * 86400_000).toISOString();
  const [s, gmail, ai, pin, waiting, sent7, talks7, blocked, last, recent] = await Promise.all([
    getSettings(env), hasSecret(env, "gmail"), hasSecret(env, "anthropic"), hasPin(env),
    env.DB.prepare(IMPORTANT_COUNT).first<{ n: number }>(),
    env.DB.prepare("select count(*) as n from replies where status = 'sent' and sent_at > ?").bind(week).first<{ n: number }>(),
    env.DB.prepare("select count(*) as n from calls where updated_at > ?").bind(week).first<{ n: number }>(),
    env.DB.prepare("select email from blocked order by created_at desc").all<{ email: string }>(),
    setting(env, "agent:last_tick"),
    env.DB.prepare(`select * from (
        select coalesce(sent_at, decided_at) as at, case status when 'sent' then 'Replied to ' else 'Skipped reply to ' end || coalesce(nullif(to_name, ''), to_email) as text from replies where status in ('sent', 'rejected')
        union all select created_at, 'Blocked ' || email from blocked
        union all select created_at, 'Read email from ' || coalesce(nullif(from_name, ''), from_email) from inbox
      ) where at is not null order by at desc limit 12`).all<{ at: string; text: string }>(),
  ]);
  const lt = last ? (JSON.parse(last) as { at: string; note: string }) : null;
  return {
    flash: flash ?? undefined,
    gmail: { connected: gmail, address: s.gmailAddress },
    ai, pin,
    waiting: waiting?.n ?? 0, repliesSent7: sent7?.n ?? 0, talks7: talks7?.n ?? 0,
    blocked: blocked.results.map((b) => b.email),
    lastCheck: lt ? `Last Gmail check ${fmt(lt.at)}: ${lt.note}.` : "",
    recent: recent.results.map((r) => ({ at: fmt(r.at), text: r.text })),
  };
}

/** The whole app runs in one Durable Object that holds the SQLite database. */
export class ChiefOfStaff extends DurableObject<WorkerEnv> {
  private app: Env;
  constructor(ctx: DurableObjectState, env: WorkerEnv) {
    super(ctx, env);
    ctx.blockConcurrencyWhile(async () => migrate(ctx.storage, SCHEMA));
    this.app = { DB: sqliteDB(ctx.storage), OWNER_PASSWORD: env.OWNER_PASSWORD, SESSION_SECRET: env.SESSION_SECRET, APP_TIMEZONE: env.APP_TIMEZONE, MAIL_TEST_HOST: env.MAIL_TEST_HOST, MAIL_TEST_IMAP_PORT: env.MAIL_TEST_IMAP_PORT, MAIL_TEST_SMTP_PORT: env.MAIL_TEST_SMTP_PORT, VOICE_TEST_SECRET: env.VOICE_TEST_SECRET };
  }
  async fetch(req: Request): Promise<Response> {
    try {
      return await handle(req, this.app);
    } catch (e) {
      console.error("request failed:", (e as Error).stack ?? e);
      return html("Something went wrong. Try again in a moment.", 500);
    }
  }
  /** Every 5 minutes, phone closed or not: check Gmail, and nudge you when something important arrives. */
  async tick(): Promise<string> {
    let note = "Gmail not connected";
    if (await gmailCreds(this.app)) {
      const r = await syncInbox(this.app);
      const fresh = r.newReplies.length + r.important.length;
      if (fresh && (await pushCount(this.app)) > 0) {
        const total = (await this.app.DB.prepare(IMPORTANT_COUNT).first<{ n: number }>())?.n ?? fresh;
        const who = r.newReplies[0]?.fromName || r.important[0]?.fromName || r.newReplies[0]?.fromEmail || r.important[0]?.fromEmail || "";
        await sendPush(this.app, { title: "Chief", body: `${total} important email${total === 1 ? "" : "s"}${who ? `, including one from ${who}` : ""}. Call Chief to go through them.`, url: "/", tag: "inbox" });
      }
      note = r.error ?? `${r.added} new, ${fresh} important`;
    }
    await this.app.DB.prepare("insert into settings (key, value) values ('agent:last_tick', ?) on conflict(key) do update set value = excluded.value")
      .bind(JSON.stringify({ at: new Date().toISOString(), note })).run();
    return note;
  }
}

const main = (env: WorkerEnv) => env.APP.get(env.APP.idFromName("main")) as DurableObjectStub<ChiefOfStaff>;

export default {
  async fetch(req: Request, env: WorkerEnv): Promise<Response> {
    return main(env).fetch(req);
  },
  async scheduled(_ctrl: ScheduledController, env: WorkerEnv, ctx: ExecutionContext) {
    ctx.waitUntil(main(env).tick().then((n) => console.log("tick:", n)));
  },
} satisfies ExportedHandler<WorkerEnv>;
