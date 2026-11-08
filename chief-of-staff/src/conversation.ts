/**
 * The conversation with Chief, inside the app. The phone turns your speech into text, sends it here,
 * and speaks Chief's answer back. Works through your important emails one at a time.
 */
import { blockSender, dontReply, unsubscribe } from "./actions";
import { decide, hasBrain } from "./brain";
import { decideReply, syncInbox, type InboxRow } from "./inbox";
import { getSettings } from "./settings";
import type { Env } from "./types";

interface State {
  stage: "email" | "confirm" | "done";
  queue: number[];
  idx: number;
  replyId?: number;
  draft?: string;
  silent: number;
  hinted?: boolean;
}

/** What Chief says, plus the draft to show on screen while it waits for your yes. */
export interface Say { say: string; end?: boolean; draft?: { to: string; subject: string; body: string } | null; waiting?: number }

/** Makes text pleasant to hear: no web links, no symbol clutter. */
function speakable(s: string) {
  return s.replace(/https?:\/\/\S+/g, "a link").replace(/[*_#>|~`]+/g, " ").replace(/\s+/g, " ").trim();
}

async function loadState(env: Env, sid: string): Promise<State | null> {
  const r = await env.DB.prepare("select state from calls where call_sid = ?").bind(sid).first<{ state: string }>();
  return r ? (JSON.parse(r.state) as State) : null;
}
async function saveState(env: Env, sid: string, st: State) {
  await env.DB.prepare("insert into calls (call_sid, state, updated_at) values (?, ?, ?) on conflict(call_sid) do update set state = excluded.state, updated_at = excluded.updated_at")
    .bind(sid, JSON.stringify(st), new Date().toISOString()).run();
  await env.DB.prepare("delete from calls where updated_at < ?").bind(new Date(Date.now() - 8 * 86400_000).toISOString()).run();
}

/** Important = from a person waiting on you, or marked high priority. Newest first, important first. */
async function importantQueue(env: Env): Promise<number[]> {
  const { results } = await env.DB.prepare(
    `select id from inbox where status = 'new' and (needs_reply = 1 or priority = 'high')
     order by case when needs_reply = 1 and priority = 'high' then 0 when needs_reply = 1 then 1 else 2 end, coalesce(received_at, created_at) desc limit 20`,
  ).all<{ id: number }>();
  return results.map((r) => r.id);
}

function firstName(n: string) {
  const w = n.replace(/"/g, "").trim().split(/\s+/).filter(Boolean);
  if (!w.length) return "";
  if (/^(pastor|father|bishop|elder)$/i.test(w[0]) && w[1]) return `${w[0]} ${w[1]}`;
  return /^(dr|mr|mrs|ms|rev)\.?$/i.test(w[0]) && w[1] ? w[1] : w[0];
}

const ORG = /\b(team|inc|llc|ltd|co|corp|company|billing|support|weekly|daily|news|deals|store|shop|bank|service|services|notifications?|alerts?|google|apple|amazon|cloudflare|paypal|stripe)\b/i;

/** "Pastor Dave says", or "It says" for a company or an automated sender. */
function speaker(m: InboxRow) {
  const n = (m.from_name || "").replace(/"/g, "").trim();
  if (!n || !m.needs_reply || ORG.test(n) || n.split(/\s+/).length > 4) return "It says";
  return `${firstName(n)} says`;
}

/** The message itself: no greeting, no signature, no quoted history. */
function mainText(m: InboxRow) {
  const lines = (m.body_text || m.summary || "").split(/\r?\n/).map((l) => l.trim());
  // Cut at the sign-off ("Thanks,", "Blessings,", "Best regards,") so names, titles and phone numbers aren't read.
  for (let i = lines.length - 1; i >= Math.max(1, lines.length - 10); i--) {
    if (/^(thanks|thank you|many thanks|best|best regards|regards|kind regards|warm regards|blessings|sincerely|cheers|warmly|in christ|god bless|talk soon|-- ?)[\s,!.]*$/i.test(lines[i])) { lines.length = i; break; }
  }
  if (lines.length && /^(hi|hello|hey|dear|good (morning|afternoon|evening))\b[^.!?]{0,40}[,!]?$/i.test(lines[0])) lines.shift();
  return lines.filter(Boolean).map((l) => (/[.!?,:;]$/.test(l) ? l : l + ".")).join(" ");
}

/** A reply, read aloud with natural pauses between its lines. */
export function spokenReply(body: string) {
  return body.split(/\n+/).map((l) => l.trim()).filter(Boolean).map((l) => (/[.!?,:;]$/.test(l) ? l : l + ".")).join(" ");
}

/** The email, as Chief reads it: who, what about, and what they actually wrote. */
function readEmail(m: InboxRow, n: number, of: number) {
  const who = m.from_name || m.from_email;
  let body = mainText(m).replace(/\s+/g, " ").trim();
  if (body.length > 900) body = body.slice(0, 900).replace(/[^.!?]*$/, "") + " That's the main part.";
  const lead = of > 1 ? (n === 1 ? "First email" : n === of ? "Last one" : `Email ${n} of ${of}`) : "Here it is";
  return `${lead}, from ${who}.${m.subject ? ` Subject: ${m.subject}.` : ""} ${speaker(m)}: ${body || "There's no text in it."}`;
}

async function current(env: Env, st: State): Promise<InboxRow | null> {
  const id = st.queue[st.idx];
  return id ? env.DB.prepare("select * from inbox where id = ?").bind(id).first<InboxRow>() : null;
}

/** Moves to the next email and reads it, or wraps up. */
async function nextEmail(env: Env, st: State, prefix: string): Promise<string> {
  st.idx++;
  st.replyId = undefined;
  st.draft = undefined;
  // Skip anything handled meanwhile (for example, a reply sent from somewhere else).
  while (st.idx < st.queue.length) {
    const m = await current(env, st);
    if (m && m.status === "new") break;
    st.idx++;
  }
  if (st.idx >= st.queue.length) {
    st.stage = "done";
    return `${prefix} That's all your important emails. Anything else? You can say check again, or goodbye.`.trim();
  }
  st.stage = "email";
  const m = (await current(env, st))!;
  return `${prefix} ${readEmail(m, st.idx + 1, st.queue.length)} What would you like to do?`.trim();
}

async function greeting(env: Env, st: State): Promise<string> {
  const s = await getSettings(env);
  const name = (s.senderName || "").split(/\s+/)[0];
  st.queue = await importantQueue(env);
  st.idx = -1;
  const hi = `Hi${name ? ` ${name}` : ""}.`;
  if (!st.queue.length) { st.stage = "done"; return `${hi} You're all caught up. No important emails right now. Anything else? You can say check again, or goodbye.`; }
  const count = st.queue.length === 1 ? "one important email" : `${st.queue.length} important emails`;
  const tip = (await hasBrain(env)) ? "Just tell me what to do in your own words." : "You can say reply, skip, don't reply, unsubscribe, or block.";
  st.hinted = true;
  return nextEmail(env, st, `${hi} You have ${count}. ${tip}`);
}


// ── The conversation, turn by turn ──

const ID = /^[A-Za-z0-9_-]{16,64}$/;

async function view(env: Env, st: State, say: string, end = false): Promise<Say> {
  let draft: Say["draft"] = null;
  if (st.stage === "confirm" && st.draft) {
    const m = await current(env, st);
    if (m) draft = { to: m.from_name || m.from_email, subject: /^re:/i.test(m.subject) ? m.subject : `Re: ${m.subject}`, body: st.draft };
  }
  return { say: speakable(say), end, draft, waiting: Math.max(0, st.queue.length - Math.max(st.idx, 0) - (st.stage === "done" ? 0 : 1)) };
}

/** You tapped to talk: Chief greets you and starts on your important emails. */
export async function startTalk(env: Env, id: string): Promise<Say> {
  if (!ID.test(id)) return { say: "Something went wrong. Tap to try again.", end: true };
  const st: State = { stage: "email", queue: [], idx: -1, silent: 0 };
  const say = await greeting(env, st);
  await saveState(env, id, st);
  return view(env, st, say);
}

/** You came back to the app: pick up exactly where you left off. */
export async function resumeTalk(env: Env, id: string): Promise<Say> {
  const st = ID.test(id) ? await loadState(env, id) : null;
  if (!st) return startTalk(env, id);
  if (st.stage === "confirm" && st.draft) return view(env, st, `Welcome back. Here's the reply we were on. ${spokenReply(st.draft)} Should I send this?`);
  const m = st.stage === "email" ? await current(env, st) : null;
  if (m) return view(env, st, `Welcome back. We were on this one. ${readEmail(m, st.idx + 1, st.queue.length)} What would you like to do?`);
  return view(env, st, "Welcome back. You're caught up. Anything else? You can say check again, or goodbye.");
}

/** One thing you said, and Chief's answer. */
export async function talkTurn(env: Env, id: string, heard: string): Promise<Say> {
  const st = ID.test(id) ? await loadState(env, id) : null;
  if (!st) return startTalk(env, id);
  const done = async (say: string, end = false) => { await saveState(env, id, st); return view(env, st, say, end); };

  heard = heard.trim().slice(0, 600);
  if (!heard) {
    st.silent++;
    return done(st.stage === "confirm" ? "Should I send this? Say yes, or tell me what to change." : "I'm here. What would you like to do?");
  }
  st.silent = 0;

  const m = st.stage === "done" ? null : await current(env, st);
  const d = await decide(env, {
    stage: st.stage,
    email: m ? { from: m.from_name || m.from_email, fromEmail: m.from_email, subject: m.subject, body: m.body_text || m.summary } : undefined,
    draft: st.stage === "confirm" ? st.draft : undefined,
    heard,
  });

  switch (d.action) {
    case "stop":
      return done("Okay. Talk soon.", true);
    case "check_again": {
      const r = await syncInbox(env);
      const say = await greeting(env, st);
      return done(r.error ? `I couldn't reach Gmail just now. ${say}` : say.replace(/^Hi[^.]*\. /, ""));
    }
    case "answer":
    case "unclear":
      return done(d.say || "Sorry, could you say that another way?");
    case "repeat":
      if (st.stage === "confirm" && st.draft) return done(`Here's the reply again. ${spokenReply(st.draft)} Should I send this?`);
      if (m) return done(`${readEmail(m, st.idx + 1, st.queue.length)} What would you like to do?`);
      return done("There's nothing to repeat. Anything else?");
  }

  if (!m) return done("There's no email open right now. Say check again, or goodbye.");

  switch (d.action) {
    case "reply":
    case "revise": {
      const body = d.reply.trim();
      const subj = /^re:/i.test(m.subject) ? m.subject : `Re: ${m.subject}`;
      if (st.replyId) {
        await env.DB.prepare("update replies set body = ? where id = ? and status = 'pending'").bind(body.slice(0, 5000), st.replyId).run();
      } else {
        await env.DB.prepare("update replies set status = 'rejected', decided_at = ? where inbox_id = ? and status = 'pending'").bind(new Date().toISOString(), m.id).run();
        const r = await env.DB.prepare("insert into replies (inbox_id, to_email, to_name, subject, body) values (?, ?, ?, ?, ?) returning id")
          .bind(m.id, m.from_email, m.from_name, subj.slice(0, 300), body.slice(0, 5000)).first<{ id: number }>();
        st.replyId = r!.id;
      }
      st.draft = body;
      st.stage = "confirm";
      return done(`${d.action === "revise" ? "Okay, here's the new version." : "Here's the reply."} ${spokenReply(body)} Should I send this?`);
    }
    case "send": {
      if (!st.replyId) return done("There's no reply ready yet. What should it say?");
      const r = await decideReply(env, st.replyId, "yes");
      if (!r.ok) return done(`I couldn't send it. ${r.error} Should I try again?`);
      return done(await nextEmail(env, st, "Sent."));
    }
    case "dont_reply":
      await dontReply(env, m);
      return done(await nextEmail(env, st, "Okay, no reply."));
    case "unsubscribe":
      return done(await nextEmail(env, st, await unsubscribe(env, m)));
    case "block":
      await blockSender(env, m);
      return done(await nextEmail(env, st, `Blocked. Emails from ${m.from_name || m.from_email} will go to Spam.`));
    case "next":
      return done(await nextEmail(env, st, "Okay, I'll keep that one for later."));
  }
  return done("Sorry, could you say that another way?");
}
