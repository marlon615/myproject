import { changePassword, checkPassword, clearCookie, clearLogins, isSignedIn, loginAllowed, recordFailedLogin, sessionCookie } from "./auth";
import { buildDailyDrafts } from "./draft";
import { sendEmail } from "./send";
import { getSecret, getSettings, hasSecret, saveSettings, setSecret, DEFAULTS, type Settings } from "./settings";
import { DurableObject } from "cloudflare:workers";
import { migrate, sqliteDB, type Stmt } from "./db";
import SCHEMA from "../schema.sql";
import { PRODUCTS, type Draft, type Env, type Product, type Prospect, type WorkerEnv } from "./types";
import { approvePage, dashboardPage, loginPage, prospectsPage, settingsPage, voicePage } from "./views";
import { runCommand } from "./voice";
import { decideReply, gmailCreds, gmailSend, syncInbox, testGmail, type ReplyRow } from "./inbox";
import { allowed, isPerm, setupDone } from "./permissions";
import { answerPermission } from "./phone";
import { testIcs } from "./calendar";
import { harvestSent } from "./contacts";
import { findApproval, morningRun, notify, notifyNewReplies, rememberOrigin, runApproval } from "./agent";
import { pushCount, sendPush, vapidKeys } from "./push";
import { b64url } from "./crypto";
import { icon, MANIFEST, SERVICE_WORKER } from "./pwa";
import { approvalDonePage, approvalPage } from "./approve-view";
import { addTodo, completeTodo, dueToNotify, markNotified, openTodos, takeDueToSpeak } from "./todos";
import { dashboard } from "./stats";

const SECURITY_HEADERS: Record<string, string> = {
  "Content-Security-Policy": "default-src 'none'; style-src 'unsafe-inline'; script-src 'self' 'unsafe-inline'; worker-src 'self'; manifest-src 'self'; connect-src 'self'; form-action 'self' mailto:; img-src 'self' data:; base-uri 'none'; frame-ancestors 'none'",
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
  if (path === "/manifest.webmanifest") return new Response(MANIFEST, { headers: { "Content-Type": "application/manifest+json", "Cache-Control": "public, max-age=3600" } });
  if (path === "/sw.js") return new Response(SERVICE_WORKER, { headers: { "Content-Type": "text/javascript; charset=utf-8", "Cache-Control": "no-cache", "Service-Worker-Allowed": "/" } });
  if (path === "/icon-192.png") return icon(192);
  if (path === "/icon-512.png") return icon(512);

  // One-tap approvals from a notification or email. The secret token in the link is the permission
  // for that single item; opening the link (GET) never sends anything, only the Yes button (POST) does.
  const apMatch = path.match(/^\/approve\/([A-Za-z0-9_-]{20,64})$/);
  if (apMatch) {
    const a = await findApproval(env, apMatch[1]);
    if (method === "GET") {
      if (!a) return html(approvalDonePage("This link has expired or was already used.", false), 410);
      if (a.used_at) return html(approvalDonePage("Already handled.", true));
      return html(await approvalPage(env, a));
    }
    if (method === "POST") {
      if (!sameOrigin(req)) return html("Forbidden", 403);
      const wantsJson = (req.headers.get("accept") ?? "").includes("application/json");
      const d = str((await req.formData()).get("decision"), 5);
      const r = !a ? { ok: false, error: "This link has expired." } : d === "yes" || d === "no" ? await runApproval(env, a, d) : { ok: false, error: "Tap Yes or No." };
      return wantsJson ? json(r, r.ok ? 200 : 400) : html(approvalDonePage(r.ok ? (r.label ?? "Done") : (r.error ?? "That didn't work."), r.ok));
    }
  }
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
  if (method === "GET" && path === "/") await rememberOrigin(env, url.origin);

  if (path === "/api/push-key" && method === "GET") {
    const { publicRaw } = await vapidKeys(env);
    return json({ key: b64url(publicRaw) });
  }
  if (path === "/api/push-subscribe" && method === "POST") {
    const sub = (await req.json().catch(() => null)) as { endpoint?: string; keys?: { p256dh?: string; auth?: string } } | null;
    const ep = sub?.endpoint ?? "";
    const testEp = Boolean(env.MAIL_TEST_HOST) && /^http:\/\/127\.0\.0\.1:\d+\//.test(ep); // local tests only
    if ((!/^https:\/\//.test(ep) && !testEp) || !sub?.keys?.p256dh || !sub.keys.auth || ep.length > 1000) return json({ ok: false, error: "Bad subscription" }, 400);
    await env.DB.prepare("insert into push_subs (endpoint, p256dh, auth) values (?, ?, ?) on conflict(endpoint) do update set p256dh = excluded.p256dh, auth = excluded.auth")
      .bind(ep, sub.keys.p256dh.slice(0, 200), sub.keys.auth.slice(0, 100)).run();
    const n = await sendPush(env, { title: "Notifications are on", body: "I'll let you know when a reply is ready for your yes.", url: "/", tag: "welcome" });
    return json({ ok: true, delivered: n });
  }
  const msg = url.searchParams.get("m")?.slice(0, 200) || undefined;

  if (path === "/logout" && method === "POST") return redirect("/login", { "Set-Cookie": clearCookie });

  if (path === "/" && method === "GET") {
    const [s, resend, gmail] = await Promise.all([getSettings(env), hasSecret(env, "resend"), gmailCreds(env)]);
    return html(voicePage(gmail ? "gmail" : resend && s.senderEmail ? "resend" : "mailto"));
  }

  if (path === "/api/command" && method === "POST") {
    const text = str((await req.formData()).get("text"), 500);
    if (!text) return json({ say: "I didn't hear a command." });
    return json(await runCommand(env, text, req.headers.get("user-agent") ?? ""));
  }

  if (path === "/api/state" && method === "GET") {
    return json({ setupDone: await setupDone(env) });
  }

  if (path === "/api/due" && method === "GET") {
    if (!(await allowed(env, "reminders"))) return json({ say: null });
    const due = await takeDueToSpeak(env);
    return json({ say: due.length ? `Reminder: ${due.map((t) => t.text).join(". Also: ")}.` : null });
  }

  const permMatch = path.match(/^\/api\/permission\/([a-z]+)$/);
  if (permMatch && method === "POST" && isPerm(permMatch[1])) {
    const d = str((await req.formData()).get("decision"), 5);
    if (d !== "yes" && d !== "no") return json({ ok: false, error: "Say yes or no." }, 400);
    return json({ ok: true, say: await answerPermission(env, permMatch[1], d === "yes") });
  }

  const outMatch = path.match(/^\/outbox\/(\d+)\/decide$/);
  if (outMatch && method === "POST") {
    const id = Number(outMatch[1]);
    const d = str((await req.formData()).get("decision"), 5);
    const row = await env.DB.prepare("select * from outbox where id = ?").bind(id).first<{ id: number; to_email: string; to_name: string; subject: string; body: string; status: string }>();
    if (!row || row.status !== "pending") return json({ ok: false, error: "That email was already handled." }, 400);
    const now = new Date().toISOString();
    if (d === "no") {
      await env.DB.prepare("update outbox set status = 'rejected', decided_at = ? where id = ?").bind(now, id).run();
      return json({ ok: true, label: "Skipped" });
    }
    if (d !== "yes") return json({ ok: false, error: "Say yes or no." }, 400);
    const claim = await env.DB.prepare("update outbox set status = 'approved', decided_at = ? where id = ? and status = 'pending'").bind(now, id).run();
    if (!claim.meta.changes) return json({ ok: false, error: "That email was already handled." }, 400);
    const r = await gmailSend(env, { to: row.to_email, toName: row.to_name, subject: row.subject, text: row.body });
    if (!r.ok) {
      await env.DB.prepare("update outbox set status = 'pending', error = ? where id = ?").bind(r.error, id).run();
      return json({ ok: false, error: `Not sent. ${r.error}` }, 400);
    }
    await env.DB.prepare("update outbox set status = 'sent', sent_at = ? where id = ?").bind(now, id).run();
    return json({ ok: true, label: "Sent ✓" });
  }

  if (path === "/review" && method === "GET") {
    const [{ results }, s, resend, gmail, replies, todos] = await Promise.all([
      env.DB.prepare(`select d.*, p.name, p.email, p.organization from drafts d join prospects p on p.id = d.prospect_id
                      where d.status = 'pending' order by d.created_at, d.id limit 50`).all<Draft & { name: string; email: string; organization: string }>(),
      getSettings(env),
      hasSecret(env, "resend"),
      gmailCreds(env),
      env.DB.prepare(`select r.*, i.summary, i.subject as orig_subject, i.from_name, i.from_email from replies r join inbox i on i.id = r.inbox_id
                      where r.status = 'pending' order by r.created_at desc limit 30`).all<ReplyRow & { summary: string; orig_subject: string; from_name: string; from_email: string }>(),
      openTodos(env),
    ]);
    return html(approvePage(results, s, gmail ? "gmail" : resend && s.senderEmail ? "resend" : "mailto", msg, replies.results, todos));
  }

  const replyMatch = path.match(/^\/replies\/(\d+)\/decide$/);
  if (replyMatch && method === "POST") {
    const f = await req.formData();
    const d = str(f.get("decision"), 5);
    const wantsJson = (req.headers.get("accept") ?? "").includes("application/json");
    const r = d === "yes" || d === "no"
      ? await decideReply(env, Number(replyMatch[1]), d, { subject: str(f.get("subject"), 300), body: str(f.get("body"), 5000) })
      : { ok: false as const, error: "Tap Yes or No." };
    if (wantsJson) return json(r, r.ok ? 200 : 400);
    return redirect(withMsg("/review", r.ok ? r.label : r.error));
  }

  const heardMatch = path.match(/^\/inbox\/(\d+)\/heard$/);
  if (heardMatch && method === "POST") {
    await env.DB.prepare("update inbox set status = 'heard' where id = ? and status = 'new'").bind(Number(heardMatch[1])).run();
    return json({ ok: true });
  }

  if (path === "/inbox/sync" && method === "POST") {
    const r = await syncInbox(env);
    return redirect(withMsg("/review", r.error ? `Gmail: ${r.error}` : `Checked Gmail: ${r.added} new.${r.more ? " More waiting; check again." : ""}`));
  }

  if (path === "/todos" && method === "POST") {
    const f = await req.formData();
    const done = Number(f.get("done"));
    if (done) await completeTodo(env, done);
    else await addTodo(env, str(f.get("text"), 300));
    return redirect(withMsg("/review", done ? "Crossed off." : "Added to your list."));
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
    const [s, anthropic, resend, gmail, calendar, phones] = await Promise.all([getSettings(env), hasSecret(env, "anthropic"), hasSecret(env, "resend"), hasSecret(env, "gmail"), hasSecret(env, "calendar"), pushCount(env)]);
    return html(settingsPage(s, { anthropic, resend, gmail, calendar, phones }, msg));
  }

  if (path === "/settings/calendar" && method === "POST") {
    const f = await req.formData();
    if (str(f.get("remove"), 10) === "calendar") {
      await setSecret(env, "calendar", null);
      return redirect(withMsg("/settings", "Calendar disconnected."));
    }
    const url = str(f.get("calendarUrl"), 1000);
    const err = await testIcs(url, Boolean(env.MAIL_TEST_HOST));
    if (err) return redirect(withMsg("/settings", `Calendar didn't connect: ${err}`));
    await setSecret(env, "calendar", url);
    return redirect(withMsg("/settings", "Calendar connected. Say “Hey Chief, what's on my calendar today?”"));
  }

  if (path === "/settings/gmail" && method === "POST") {
    const f = await req.formData();
    if (str(f.get("remove"), 10) === "gmail") {
      await setSecret(env, "gmail", null);
      return redirect(withMsg("/settings", "Gmail disconnected."));
    }
    const address = str(f.get("gmailAddress"), 200).toLowerCase();
    const pass = str(f.get("gmailPassword"), 100).replace(/\s+/g, "");
    if (!EMAIL.test(address)) return redirect(withMsg("/settings", "Enter your Gmail address."));
    const usePass = pass || (await getSecret(env, "gmail"));
    if (!usePass) return redirect(withMsg("/settings", "Paste your 16-letter Gmail app password."));
    if (pass && !/^[a-z]{16}$/i.test(pass)) return redirect(withMsg("/settings", "A Gmail app password is 16 letters. Copy it again from Google."));
    const err = await testGmail(env, address, usePass);
    if (err) return redirect(withMsg("/settings", `Gmail didn't connect: ${err}`));
    await saveSettings(env, { gmailAddress: address });
    if (pass) await setSecret(env, "gmail", pass);
    if (await allowed(env, "contacts")) await harvestSent(env, address, usePass).catch(() => 0);
    return redirect(withMsg("/settings", "Gmail connected. Say “Hey Chief, check my inbox.”"));
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
    this.app = { DB: sqliteDB(ctx.storage), OWNER_PASSWORD: env.OWNER_PASSWORD, SESSION_SECRET: env.SESSION_SECRET, APP_TIMEZONE: env.APP_TIMEZONE, MAIL_TEST_HOST: env.MAIL_TEST_HOST, MAIL_TEST_IMAP_PORT: env.MAIL_TEST_IMAP_PORT, MAIL_TEST_SMTP_PORT: env.MAIL_TEST_SMTP_PORT };
  }
  async fetch(req: Request): Promise<Response> {
    try {
      return await handle(req, this.app);
    } catch (e) {
      console.error("request failed:", (e as Error).stack ?? e);
      return html("<h1>Something went wrong</h1><p>Try again in a moment. <a href=\"/\">Back</a></p>", 500);
    }
  }
  /** Morning: draft outreach, ask for one yes, report yesterday; refresh contacts. */
  async morning(): Promise<string> {
    const note = await morningRun(this.app);
    const g = await gmailCreds(this.app);
    if (g && (await allowed(this.app, "contacts"))) await harvestSent(this.app, g.user, g.pass).catch(() => 0);
    return note;
  }
  /** Every 5 minutes, phone open or not: check Gmail, write replies, notify; send due reminders. */
  async tick(): Promise<string> {
    let note = "";
    if (await allowed(this.app, "reminders")) {
      for (const t of await dueToNotify(this.app)) {
        const via = await notify(this.app, { title: "Reminder", body: t.text, url: "/", tag: `todo${t.id}` });
        if (via === "none" && (await pushCount(this.app)) === 0 && !(await gmailCreds(this.app))) continue; // nowhere to send yet; try later
        await markNotified(this.app, t.id);
        note += ` reminded: ${t.text};`;
      }
    }
    if (await gmailCreds(this.app)) {
      const r = await syncInbox(this.app);
      if (r.newReplies.length) await notifyNewReplies(this.app, r.newReplies);
      for (const who of r.prospectReplies) {
        await notify(this.app, { title: `${who} replied`, body: "I stopped their follow-ups. Their email is in your inbox.", url: "/", tag: `prospect-${who}`.slice(0, 30) });
      }
      note += ` inbox: ${r.error ?? `${r.added} new, ${r.newReplies.length} replies drafted`}`;
    }
    const result = note.trim() || "nothing to do";
    await this.app.DB.prepare("insert into settings (key, value) values ('agent:last_tick', ?) on conflict(key) do update set value = excluded.value")
      .bind(JSON.stringify({ at: new Date().toISOString(), note: result })).run();
    return result;
  }
}

const main = (env: WorkerEnv) => env.APP.get(env.APP.idFromName("main")) as DurableObjectStub<ChiefOfStaff>;

export default {
  async fetch(req: Request, env: WorkerEnv): Promise<Response> {
    return main(env).fetch(req);
  },
  async scheduled(ctrl: ScheduledController, env: WorkerEnv, ctx: ExecutionContext) {
    // The morning run drafts outreach; the 5-minute runs watch Gmail and send reminders.
    if (ctrl.cron === "0 13 * * *") ctx.waitUntil(main(env).morning().then((n) => console.log("morning:", n)));
    else ctx.waitUntil(main(env).tick().then((n) => console.log("tick:", n)));
  },
} satisfies ExportedHandler<WorkerEnv>;
