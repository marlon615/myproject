import Anthropic from "@anthropic-ai/sdk";
import { buildDailyDrafts, writeDraft } from "./draft";
import { gmailCreds, syncInbox, type InboxRow, type ReplyRow } from "./inbox";
import { getSecret, getSettings, hasSecret } from "./settings";
import { dashboard } from "./stats";
import { addTodo, completeTodo, findTodo, openTodos } from "./todos";
import { PRODUCT_NAME, type Draft, type Env, type Product, type Prospect, type ProspectStatus } from "./types";

import { addToCalendar, call, directions, emailPerson, makeProspect, readCalendar, remind, saveNumber, setupQueue, text as textPerson, togglePerm, type QueueItem, type VoiceReply } from "./phone";
import { allowed, isPerm, type Perm } from "./permissions";
import { agendaSpeech } from "./calendar";
import { findPerson } from "./contacts";
export type { QueueItem, VoiceReply };

const HELP =
  "You can say: brief me. Check my inbox. Email Dave saying, and your message. Call Dave. Text Dave saying, and your message. " +
  "What's on my calendar today. Add lunch with Dave tomorrow at noon to my calendar. Remind me to call Dave at 3. " +
  "Directions to Grace Church. Add Dave as a ChurchFollow prospect. Read my outreach. Draft today's emails. Give me my dashboard. Or say stop.";

const norm = (t: string) => t.toLowerCase().replace(/[^\p{L}\p{N}@.\s'-]/gu, " ").replace(/\s+/g, " ").trim();

function productHint(t: string): Product | null {
  if (/client ?pulse|clients pulse/.test(t)) return "clientpulse";
  if (/church ?follow|church fall?ow/.test(t)) return "churchfollow";
  return null;
}

function plural(n: number, one: string, many = one + "s") {
  return `${n} ${n === 1 ? one : many}`;
}

/** Joins email lines into something that reads naturally aloud. */
function spoken(body: string) {
  return body
    .split(/\n+/)
    .map((l) => l.trim())
    .filter(Boolean)
    .map((l) => (/[.!?,:;]$/.test(l) ? l : l + "."))
    .join(" ");
}

function listOut(items: string[]) {
  if (items.length <= 1) return items.join("");
  return items.slice(0, -1).join(", ") + ", and " + items[items.length - 1];
}

// ── Outreach drafts ──

export function draftSpeech(d: Draft, p: Pick<Prospect, "name" | "email" | "organization">, i?: number, of?: number) {
  const who = p.name || p.email.replace(/@.*/, "");
  const head = of && of > 1 ? `Outreach ${i} of ${of}. ` : "";
  return `${head}${PRODUCT_NAME[d.product]} email to ${who}${p.organization ? ` at ${p.organization}` : ""}. Subject: ${d.subject}. ${spoken(d.body)} Should I send it?`;
}

async function outreachQueue(env: Env): Promise<QueueItem[]> {
  const { results } = await env.DB.prepare(
    `select d.*, p.name, p.email, p.organization from drafts d join prospects p on p.id = d.prospect_id
     where d.status = 'pending' order by d.created_at, d.id limit 25`,
  ).all<Draft & { name: string; email: string; organization: string }>();
  return results.map((d, i) => ({ say: draftSpeech(d, d, i + 1, results.length), decideUrl: `/drafts/${d.id}/decide` }));
}

// ── Inbox ──

async function inboxQueue(env: Env): Promise<QueueItem[]> {
  const { results } = await env.DB.prepare(
    `select i.*, r.id as reply_id, r.body as reply_body from inbox i
     left join replies r on r.inbox_id = i.id and r.status = 'pending'
     where i.status = 'new'
     order by case i.priority when 'high' then 0 when 'normal' then 1 else 2 end, coalesce(i.received_at, i.created_at) desc
     limit 20`,
  ).all<InboxRow & { reply_id: number | null; reply_body: string | null }>();
  return results.map((m, i) => {
    const who = m.from_name || m.from_email;
    const head = `${results.length > 1 ? `Email ${i + 1} of ${results.length}. ` : ""}From ${who}${m.priority === "high" ? ", marked important" : ""}. ${m.subject ? `Subject: ${m.subject}. ` : ""}${m.summary}`;
    if (m.reply_id && m.reply_body) {
      return { say: `${head} Here's a reply: ${spoken(m.reply_body)} Should I send it?`, decideUrl: `/replies/${m.reply_id}/decide` };
    }
    return { say: `${head} No reply needed.`, ackUrl: `/inbox/${m.id}/heard` };
  });
}

async function inboxCounts(env: Env) {
  const row = await env.DB.prepare(
    `select count(*) as n, sum(case when exists (select 1 from replies r where r.inbox_id = inbox.id and r.status = 'pending') then 1 else 0 end) as replies,
            sum(case when priority = 'high' then 1 else 0 end) as high
     from inbox where status = 'new'`,
  ).first<{ n: number; replies: number | null; high: number | null }>();
  return { n: row?.n ?? 0, replies: row?.replies ?? 0, high: row?.high ?? 0 };
}

async function checkInbox(env: Env): Promise<VoiceReply> {
  if (!(await gmailCreds(env))) {
    return { say: "Gmail isn't connected yet. Open Manage, then Settings, and paste your Gmail app password. Then I can read your inbox." };
  }
  const sync = await syncInbox(env);
  const queue = await inboxQueue(env);
  if (sync.error && !queue.length) return { say: `I couldn't check Gmail. ${sync.error}` };
  if (!queue.length) return { say: "No new emails in your Primary inbox." };
  const c = await inboxCounts(env);
  const more = sync.more ? " There are more after these; ask me again when we're done." : "";
  return { say: `You have ${plural(c.n, "new email")}${c.replies ? `, and I drafted ${plural(c.replies, "reply", "replies")}` : ""}.${more}`, queue };
}

// ── Dashboard and briefing ──

async function dashboardSpeech(env: Env) {
  const d = await dashboard(env);
  const p = d.prospects;
  const total = Object.values(p).reduce((a, b) => a + b, 0);
  const inbox = await inboxCounts(env);
  const todos = await openTodos(env);
  const parts = [
    (await gmailCreds(env)) ? `Inbox: ${plural(inbox.n, "new email")}, ${plural(inbox.replies, "reply", "replies")} waiting for your yes.` : "Gmail isn't connected yet.",
    d.pending ? `Outreach: ${plural(d.pending, "email")} waiting for your yes or no.` : "No outreach is waiting.",
    `Today you sent ${d.sentToday} and skipped ${d.noToday}. ${plural(d.sentTotal, "outreach email")} sent all time${d.approval30 === null ? "" : `, and you said yes to ${d.approval30} percent over the last 30 days`}.`,
    `${plural(p.replied ?? 0, "prospect")} replied so far.`,
    total ? `You have ${plural(total, "prospect")}: ${p.new ?? 0} new, ${p.contacted ?? 0} contacted.` : "You have no prospects yet.",
    todos.length ? `${plural(todos.length, "item")} on your list.` : "Your list is clear.",
  ];
  for (const b of d.byProduct) if (b.sent || b.replied) parts.push(`${PRODUCT_NAME[b.product as Product]}: ${b.sent} sent, ${b.replied} replied.`);
  return parts.join(" ");
}

async function brief(env: Env): Promise<VoiceReply> {
  const gmail = await gmailCreds(env);
  let syncNote = "";
  if (gmail) {
    const r = await syncInbox(env);
    if (r.error) syncNote = ` I couldn't check Gmail: ${r.error}`;
  }
  const [inbox, inboxQ, outQ, todos] = await Promise.all([inboxCounts(env), gmail ? inboxQueue(env) : Promise.resolve([]), outreachQueue(env), openTodos(env)]);
  const lines: string[] = [];
  if (gmail) lines.push(inbox.n ? `You have ${plural(inbox.n, "new email")}${inbox.high ? `, ${inbox.high} important` : ""}, and ${plural(inbox.replies, "reply", "replies")} ready for your yes.` : "Your inbox is clear.");
  else lines.push("Gmail isn't connected yet, so I can't check your inbox.");
  lines.push(outQ.length ? `${plural(outQ.length, "outreach email")} waiting.` : "No outreach waiting.");
  if ((await allowed(env, "calendar")) && (await getSecret(env, "calendar"))) {
    try { lines.push(await agendaSpeech(env, 0)); } catch {}
  }
  if (todos.length) lines.push(`On your list: ${listOut(todos.slice(0, 5).map((t) => t.text))}${todos.length > 5 ? `, and ${todos.length - 5} more` : ""}.`);
  const queue = [...inboxQ, ...outQ];
  if (queue.length) lines.push("Let's go through them.");
  return { say: lines.join(" ") + syncNote, queue: queue.length ? queue : undefined };
}

// ── Writing to a prospect ──

async function findProspect(env: Env, spokenName: string, product: Product | null): Promise<Prospect | null> {
  const words = norm(spokenName)
    .replace(/\b(church ?follow|client ?pulse|for|about|the|at|from|email|an?)\b/g, " ")
    .split(" ")
    .filter((w) => w.length > 1);
  if (!words.length) return null;
  const { results } = await env.DB.prepare("select * from prospects order by id desc limit 2000").all<Prospect>();
  let best: Prospect | null = null, bestScore = 0;
  for (const p of results) {
    const hay = norm(`${p.name} ${p.organization} ${p.email.replace(/[@.]/g, " ")}`);
    let score = 0;
    for (const w of words) if (new RegExp(`\\b${w.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}`).test(hay)) score += w.length;
    if (product && p.product === product) score += 2;
    if (score > bestScore) { best = p; bestScore = score; }
  }
  return bestScore >= 3 ? best : null;
}

async function writeFor(env: Env, target: string, product: Product | null): Promise<VoiceReply> {
  const p = await findProspect(env, target, product);
  if (!p) return { say: `I couldn't find ${target} in your prospects. Add them under Manage, then Prospects, and ask me again.` };
  if (p.status === "do_not_contact" || p.status === "not_interested") {
    return { say: `${p.name || p.email} is marked ${p.status.replace(/_/g, " ")}, so I won't write to them.` };
  }
  const s = await getSettings(env);
  if (p.product === "clientpulse" && s.product_clientpulse.includes("(edit this in Settings)")) {
    return { say: "I don't know what ClientPulse does yet. Describe it in Settings, under Products, and then I can write ClientPulse emails." };
  }
  let d = await env.DB.prepare("select * from drafts where prospect_id = ? and status = 'pending' order by id desc limit 1").bind(p.id).first<Draft>();
  if (!d) {
    const touch = p.touches + 1;
    const text = await writeDraft(env, s, p, touch);
    await env.DB.prepare("insert into drafts (prospect_id, product, touch, subject, body, source) values (?, ?, ?, ?, ?, ?)")
      .bind(p.id, p.product, touch, text.subject, text.body, text.source).run();
    d = await env.DB.prepare("select * from drafts where prospect_id = ? and status = 'pending' order by id desc limit 1").bind(p.id).first<Draft>();
  }
  if (!d) return { say: "Something went wrong writing that one. Try again." };
  return { say: "Here it is.", queue: [{ say: draftSpeech(d, p), decideUrl: `/drafts/${d.id}/decide` }] };
}

async function mark(env: Env, target: string, status: ProspectStatus): Promise<VoiceReply> {
  const p = await findProspect(env, target, null);
  if (!p) return { say: `I couldn't find ${target} in your prospects.` };
  const stmts = [env.DB.prepare("update prospects set status = ? where id = ?").bind(status, p.id)];
  if (status !== "new" && status !== "contacted") {
    stmts.push(env.DB.prepare("update drafts set status = 'rejected', decided_at = ?, error = 'Prospect status changed' where prospect_id = ? and status = 'pending'").bind(new Date().toISOString(), p.id));
  }
  await env.DB.batch(stmts);
  return { say: `Done. ${p.name || p.email} is now marked ${status.replace(/_/g, " ")}.` };
}

// ── Understanding the command ──

const STATUS_WORDS: [RegExp, ProspectStatus][] = [
  [/not interested/, "not_interested"],
  [/do not contact|don'?t contact|unsubscribe/, "do_not_contact"],
  [/repl(ied|y)|responded|answered/, "replied"],
  [/contacted/, "contacted"],
  [/\bnew\b/, "new"],
];

type Intent =
  | { intent: "help" | "dashboard" | "inbox" | "outreach" | "brief" | "draft_today" | "stop" | "list" | "setup" }
  | { intent: "toggle"; perm: Perm; on: boolean }
  | { intent: "call"; target: string }
  | { intent: "text"; target: string; message: string }
  | { intent: "text_loose"; rest: string }
  | { intent: "email_person"; target: string; message: string }
  | { intent: "save_number"; target: string; number: string }
  | { intent: "directions"; place: string }
  | { intent: "calendar_read"; day: number }
  | { intent: "calendar_add"; what: string }
  | { intent: "prospect"; target: string; product: Product | null }
  | { intent: "write"; target: string; product: Product | null }
  | { intent: "mark"; target: string; status: ProspectStatus }
  | { intent: "remember"; text: string }
  | { intent: "done"; text: string }
  | { intent: "unknown" };

function parseRules(raw: string): Intent {
  const t = norm(raw);
  if (!t) return { intent: "unknown" };
  if (/^(help|what can (you|i) (do|say)|commands|options)\b/.test(t)) return { intent: "help" };
  if (/^(stop|cancel|never ?mind|that'?s all|quiet|be quiet|goodbye|bye)\b/.test(t)) return { intent: "stop" };
  if (/^(set ?up|setup|start (the )?set ?up|(set up|ask me) (the |my )?permissions|permissions)\b/.test(t)) return { intent: "setup" };
  const tg = t.match(/^(turn on|enable|allow|start using|turn off|disable|stop using|don'?t use)\s+(?:my\s+)?(email|e-mail|contacts|calls|phone calls|texts|text messages|texting|calendar|reminders|maps|directions)\b/);
  if (tg) {
    const word = tg[2].replace(/^e-mail$/, "email").replace(/^phone calls$/, "calls").replace(/^(text messages|texting)$/, "texts").replace(/^directions$/, "maps");
    if (isPerm(word)) return { intent: "toggle", perm: word, on: /^(turn on|enable|allow|start using)/.test(tg[1]) };
  }

  // "Save Dave's number as ..." comes before "remember ..." so it isn't mistaken for a reminder.
  const sv0 = t.match(/^(?:save|add|store|remember)\s+(.+?)(?:'s|s)?\s+(?:number|phone(?: number)?|cell(?: number)?|mobile)\s+(?:as|is|to)?\s*([+\d][\d\s().-]{6,})$/);
  if (sv0) return { intent: "save_number", target: sv0[1], number: sv0[2] };

  // Remembering things (matched on the original words, so names keep their capitals)
  const r0 = raw.trim().replace(/[.!?]+$/, "");
  const rem = r0.match(/^(?:please )?(?:remember|remind me|don'?t let me forget|make a note|note|add a reminder)(?: that| to)?\s+(?:to\s+)?(.+)$/i) ||
    r0.match(/^add (.+?) to (?:my )?(?:list|to ?do(?: list)?|waiting(?: items| list)?|reminders)$/i);
  if (rem) return { intent: "remember", text: rem[1].charAt(0).toUpperCase() + rem[1].slice(1) };
  if (/\b(what'?s on my list|read my list|my (to ?do|todo)( list)?|my (waiting items|reminders)|what do i need to do|what am i waiting on)\b/.test(t)) return { intent: "list" };

  // People → prospects, by voice
  const pr = t.match(/^(?:add|make|save|put)\s+(.+?)\s+(?:as|in|into|on)\s+(?:a\s+|my\s+)?(church ?follow|client ?pulse)?\s*(?:prospects?|leads?|pipeline)\b/);
  if (pr) return { intent: "prospect", target: pr[1], product: productHint(pr[2] ?? "") ?? productHint(t) };

  // Prospect status
  const m = t.match(/\b(?:mark|set|move|put)\s+(.+?)\s+(?:as|to)\s+(.+)$/);
  if (m) {
    const st = STATUS_WORDS.find(([re]) => re.test(m[2]));
    if (st) return { intent: "mark", target: m[1], status: st[1] };
    if (/\b(done|complete|completed|finished)\b/.test(m[2])) return { intent: "done", text: m[1] };
  }
  const m2 = t.match(/^(.+?)\s+(?:replied|responded|is not interested|isn'?t interested|said no)$/);
  if (m2) return { intent: "mark", target: m2[1], status: /not interested|isn'?t|said no/.test(t) ? "not_interested" : "replied" };

  // Finishing items
  const dn = t.match(/^(?:i )?(?:finished|did|completed|handled|took care of|done with)\s+(.+)$/) ||
    t.match(/^(?:cross off|check off|tick off|remove)\s+(.+?)(?: from (?:my )?list)?$/) || t.match(/^(.+?) is done$/);
  if (dn) return { intent: "done", text: dn[1] };

  const sv = t.match(/^(?:save|add|store|remember)\s+(.+?)(?:'s|s)?\s+(?:number|phone(?: number)?|cell(?: number)?|mobile)\s+(?:as|is|to)?\s*([+\d][\d\s().-]{6,})$/);
  if (sv) return { intent: "save_number", target: sv[1], number: sv[2] };
  const cl = t.match(/^(?:call|phone|ring|dial|give)\s+(.+?)(?:\s+a call)?$/);
  if (cl && !/^(me|back)\b/.test(cl[1])) return { intent: "call", target: cl[1] };
  const tx = raw.trim().match(/^(?:text|message|send a text to|send a message to|send a text message to)\s+(.+?)\s*(?:,|:)?\s+(?:saying|that says|to say|and say|telling (?:him|her|them)|asking (?:him|her|them))\s+(.+)$/i);
  if (tx) return { intent: "text", target: tx[1], message: tx[2] };
  const tl = raw.trim().match(/^(?:text|message)\s+(.+)$/i);
  if (tl) return { intent: "text_loose", rest: tl[1] };
  const em = raw.trim().match(/^(?:email|e-mail|send an email to|send an e-mail to|send a note to|write to|shoot)\s+(.+?)\s*(?:,|:)?\s+(saying|that says|to say|about|telling (?:him|her|them)|asking (?:him|her|them)|an email (?:saying|about))\s+(.+)$/i);
  if (em) return { intent: "email_person", target: em[1], message: (/^(about|asking)/i.test(em[2]) ? em[2] + " " : "") + em[3] };
  const dr = t.match(/^(?:give me |get me |show me )?(?:directions|navigate|take me|drive|route|get me|how do i get|how to get|the way)\s+(?:to|for)\s+(.+)$/);
  if (dr) return { intent: "directions", place: raw.trim().replace(/^.*?\b(?:to|for)\s+/i, "") };
  if (/\b(calendar|schedule|agenda)\b/.test(t) && /\b(what|read|check|what'?s|how'?s|tell me)\b/.test(t) && !/^(add|put|schedule|book|create)/.test(t)) {
    return { intent: "calendar_read", day: /tomorrow/.test(t) ? 1 : 0 };
  }
  if (/^what do i have (today|tomorrow|on)\b/.test(t)) return { intent: "calendar_read", day: /tomorrow/.test(t) ? 1 : 0 };
  const ca = raw.trim().match(/^(?:add|put|schedule|book|create|set up|block(?: off)?)\s+(.+?)\s+(?:on|to|in|into)\s+(?:my\s+)?calendar\b(.*)$/i) || raw.trim().match(/^(?:schedule|book)\s+(.+)$/i);
  if (ca) return { intent: "calendar_add", what: `${ca[1]} ${ca[2] ?? ""}`.trim() };

  if (/\b(brief me|briefing|catch me up|what'?s (waiting|on my plate|new)|good morning|anything (waiting|for me)|what did i miss|report back)\b/.test(t)) return { intent: "brief" };
  if (/\b(dashboards?|stats|statistics|numbers|report|how (are|am) (we|i) doing|how'?s it going|status update|summary)\b/.test(t)) return { intent: "dashboard" };
  if (/\b(draft|prepare|make|create|write|generate)\b.*\b(today'?s|today|daily|morning|new) (emails|drafts|batch|outreach)\b|\bdraft (today|the emails)\b/.test(t)) return { intent: "draft_today" };

  const w = t.match(/\b(?:write|draft|compose|email|prepare)\b(?:\s+(?:an?|another|the))?(?:\s+(?:email|e-mail|note|message|follow[- ]?up|intro))?(?:\s+(?:for\s+(?:church ?follow|client ?pulse)))?\s+(?:to|for)\s+(.+)$/);
  if (w) return { intent: "write", target: w[1].replace(/\b(about|for) (church ?follow|client ?pulse)\b/, "").trim(), product: productHint(t) };

  if (/\b(outreach|approvals?|my drafts|prospect emails|sales emails)\b/.test(t)) return { intent: "outreach" };
  if (/\b(inbox|gmail|new (emails|mail|messages)|my (emails|email|mail|messages)|read (my )?(emails|mail)|check (my )?(email|mail)|who emailed)\b/.test(t)) return { intent: "inbox" };
  return { intent: "unknown" };
}

const AI_SCHEMA = {
  type: "object",
  properties: {
    intent: { type: "string", enum: ["help", "dashboard", "inbox", "outreach", "brief", "draft_today", "stop", "list", "write", "mark", "remember", "done", "call", "directions", "calendar_today", "calendar_tomorrow", "unknown"] },
    target: { type: "string" },
    product: { type: "string", enum: ["clientpulse", "churchfollow", "none"] },
    status: { type: "string", enum: ["new", "contacted", "replied", "not_interested", "do_not_contact", "none"] },
  },
  required: ["intent", "target", "product", "status"],
  additionalProperties: false,
} as const;

async function parseWithAI(env: Env, text: string): Promise<Intent> {
  const key = await getSecret(env, "anthropic");
  if (!key) return { intent: "unknown" };
  try {
    const client = new Anthropic({ apiKey: key });
    const res = await client.beta.messages.create({
      model: "claude-opus-5-5",
      max_tokens: 2000,
      betas: ["server-side-fallback-2026-07-01"],
      fallbacks: "default",
      output_config: { effort: "low", format: { type: "json_schema", schema: AI_SCHEMA } },
      system:
        "You map one spoken command for a voice chief-of-staff assistant to an intent. Intents: help; dashboard (stats); inbox (read new Gmail emails aloud); " +
        "outreach (read pending sales outreach drafts); brief (everything waiting: inbox, outreach, list); draft_today (make today's outreach drafts); stop; " +
        "list (read the owner's remembered to-do items); write (write an outreach email to one prospect: person, church or company in target); " +
        "mark (change a prospect's status: target and status); remember (save a to-do or timed reminder: the whole item with its time in target); done (finish a to-do: the item in target); " +
        "call (phone a person: name in target); directions (maps: place in target); calendar_today; calendar_tomorrow; unknown. " +
        "Products are ClientPulse and ChurchFollow. The command is speech-to-text and may have mistakes. Latency-sensitive; answer immediately.",
      messages: [{ role: "user", content: `<command>${text.slice(0, 500)}</command>` }],
    });
    if (res.stop_reason === "refusal") return { intent: "unknown" };
    const o = JSON.parse(res.content.filter((b) => b.type === "text").map((b) => b.text).join("")) as { intent: string; target: string; product: string; status: string };
    const product = o.product === "none" ? null : (o.product as Product);
    if (o.intent === "write" && o.target) return { intent: "write", target: o.target, product };
    if (o.intent === "mark" && o.target && o.status !== "none") return { intent: "mark", target: o.target, status: o.status as ProspectStatus };
    if (o.intent === "remember" && o.target) return { intent: "remember", text: o.target };
    if (o.intent === "done" && o.target) return { intent: "done", text: o.target };
    if (o.intent === "call" && o.target) return { intent: "call", target: o.target };
    if (o.intent === "directions" && o.target) return { intent: "directions", place: o.target };
    if (o.intent === "calendar_today" || o.intent === "calendar_tomorrow") return { intent: "calendar_read", day: o.intent === "calendar_today" ? 0 : 1 };
    if (["help", "dashboard", "inbox", "outreach", "brief", "draft_today", "stop", "list"].includes(o.intent)) return { intent: o.intent as "help" };
  } catch (e) {
    console.error("voice AI parse failed:", (e as Error).message);
  }
  return { intent: "unknown" };
}

/** "text Dave I'm running late": works out where the name ends and the message starts. */
async function splitNameMessage(env: Env, rest: string): Promise<{ target: string; message: string } | null> {
  const words = rest.trim().split(/\s+/);
  for (let n = Math.min(3, words.length - 1); n >= 1; n--) {
    const name = words.slice(0, n).join(" ");
    const p = await findPerson(env, name);
    if (p && words.slice(0, n).every((w) => p.name.toLowerCase().includes(w.toLowerCase().replace(/'s$/, "")))) return { target: name, message: words.slice(n).join(" ") };
  }
  return null;
}

export async function runCommand(env: Env, text: string, ua = ""): Promise<VoiceReply> {
  let it = parseRules(text);
  if (it.intent === "unknown") it = await parseWithAI(env, text);

  switch (it.intent) {
    case "setup":
      return setupQueue();
    case "toggle":
      return togglePerm(env, it.perm, it.on);
    case "call":
      return call(env, it.target, ua);
    case "text":
      return textPerson(env, it.target, it.message, ua);
    case "text_loose": {
      const sp = await splitNameMessage(env, it.rest);
      return sp ? textPerson(env, sp.target, sp.message, ua) : { say: "Who should I text? Say: text, a name, saying, and your message." };
    }
    case "email_person":
      return emailPerson(env, it.target, it.message);
    case "save_number":
      return saveNumber(env, it.target, it.number);
    case "directions":
      return directions(env, it.place, ua);
    case "calendar_read":
      return readCalendar(env, it.day);
    case "calendar_add":
      return addToCalendar(env, it.what);
    case "prospect":
      return makeProspect(env, it.target, it.product);
    case "help":
      return { say: HELP };
    case "stop":
      return { say: "Okay.", end: true };
    case "dashboard":
      return { say: await dashboardSpeech(env) };
    case "brief":
      return brief(env);
    case "inbox":
      return checkInbox(env);
    case "outreach": {
      const queue = await outreachQueue(env);
      if (!queue.length) return { say: "No outreach is waiting. Say draft today's emails, or write an email to someone." };
      return { say: `You have ${plural(queue.length, "outreach email")} waiting.`, queue };
    }
    case "draft_today": {
      const r = await buildDailyDrafts(env, "manual");
      const queue = r.created ? await outreachQueue(env) : [];
      return { say: queue.length ? `${r.note} Here's the first one.` : r.note, queue: queue.length ? queue : undefined };
    }
    case "write":
      return writeFor(env, it.target, it.product);
    case "mark":
      return mark(env, it.target, it.status);
    case "remember":
      return remind(env, it.text);
    case "list": {
      const todos = await openTodos(env);
      return { say: todos.length ? `You have ${plural(todos.length, "item")}: ${listOut(todos.map((t) => t.text))}.` : "Your list is clear." };
    }
    case "done": {
      const t = await findTodo(env, it.text);
      if (!t) return { say: `I couldn't find ${it.text} on your list.` };
      await completeTodo(env, t.id);
      const left = (await openTodos(env)).length;
      return { say: `Nice. Crossed off: ${t.text}. ${left ? `${plural(left, "item")} left.` : "Your list is clear."}` };
    }
    default:
      return { say: `Sorry, I didn't catch that.${(await hasSecret(env, "anthropic")) ? "" : " Say help to hear what I can do."}` };
  }
}

export type { ReplyRow };
