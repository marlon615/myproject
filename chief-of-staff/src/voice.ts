import Anthropic from "@anthropic-ai/sdk";
import { buildDailyDrafts, writeDraft } from "./draft";
import { getSecret, getSettings, hasSecret } from "./settings";
import { dashboard } from "./stats";
import { PRODUCT_NAME, type Draft, type Env, type Product, type Prospect, type ProspectStatus } from "./types";

/** One email waiting for a spoken yes or no. */
export interface QueueItem { id: number; say: string }
export interface VoiceReply { say: string; queue?: QueueItem[]; end?: boolean }

const HELP =
  "You can say: read my emails. Write an email to, and a name or church. Draft today's emails. Give me my dashboard. " +
  "Mark, a name, as replied, or not interested. Or say stop.";

const norm = (t: string) => t.toLowerCase().replace(/[^\p{L}\p{N}@.\s'-]/gu, " ").replace(/\s+/g, " ").trim();

function productHint(t: string): Product | null {
  if (/client ?pulse|clients pulse/.test(t)) return "clientpulse";
  if (/church ?follow|church fall?ow/.test(t)) return "churchfollow";
  return null;
}

function plural(n: number, one: string, many = one + "s") {
  return `${n} ${n === 1 ? one : many}`;
}

/** Turns a draft into what gets read aloud, ending with the question. */
export function draftSpeech(d: Draft, p: Pick<Prospect, "name" | "email" | "organization">, i?: number, of?: number) {
  const who = p.name || p.email.replace(/@.*/, "");
  const head = of && of > 1 ? `Email ${i} of ${of}. ` : "";
  const body = d.body
    .split(/\n+/)
    .map((l) => l.trim())
    .filter(Boolean)
    .map((l) => (/[.!?,:;]$/.test(l) ? l : l + "."))
    .join(" ");
  return `${head}${PRODUCT_NAME[d.product]} email to ${who}${p.organization ? ` at ${p.organization}` : ""}. Subject: ${d.subject}. ${body} Should I send it?`;
}

async function pendingQueue(env: Env): Promise<QueueItem[]> {
  const { results } = await env.DB.prepare(
    `select d.*, p.name, p.email, p.organization from drafts d join prospects p on p.id = d.prospect_id
     where d.status = 'pending' order by d.created_at, d.id limit 25`,
  ).all<Draft & { name: string; email: string; organization: string }>();
  return results.map((d, i) => ({ id: d.id, say: draftSpeech(d, d, i + 1, results.length) }));
}

async function dashboardSpeech(env: Env) {
  const d = await dashboard(env);
  const p = d.prospects;
  const total = Object.values(p).reduce((a, b) => a + b, 0);
  const parts = [
    d.pending ? `You have ${plural(d.pending, "email")} waiting for your yes or no.` : "Nothing is waiting for you.",
    `Today you sent ${d.sentToday} and skipped ${d.noToday}.`,
    `${plural(d.sentTotal, "email")} sent all time${d.approval30 === null ? "" : `, and you said yes to ${d.approval30} percent over the last 30 days`}.`,
    `${plural(p.replied ?? 0, "reply", "replies")} so far.`,
    total ? `You have ${plural(total, "prospect")}: ${p.new ?? 0} new, ${p.contacted ?? 0} contacted, ${p.not_interested ?? 0} not interested.` : "You have no prospects yet. Add some on the Prospects page.",
  ];
  for (const b of d.byProduct) if (b.sent || b.replied) parts.push(`${PRODUCT_NAME[b.product as Product]}: ${b.sent} sent, ${b.replied} replied.`);
  return parts.join(" ");
}

/** Finds the prospect a spoken name, church, company or email most likely means. */
async function findProspect(env: Env, spoken: string, product: Product | null): Promise<Prospect | null> {
  const words = norm(spoken)
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
  if (!p) return { say: `I couldn't find ${target} in your prospects. Add them on the Prospects page, then ask me again.` };
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
  return { say: "Here it is.", queue: [{ id: d.id, say: draftSpeech(d, p) }] };
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

const STATUS_WORDS: [RegExp, ProspectStatus][] = [
  [/not interested/, "not_interested"],
  [/do not contact|don'?t contact|unsubscribe/, "do_not_contact"],
  [/repl(ied|y)|responded|answered/, "replied"],
  [/contacted/, "contacted"],
  [/new/, "new"],
];

type Intent =
  | { intent: "help" | "dashboard" | "read" | "draft_today" | "stop" }
  | { intent: "write"; target: string; product: Product | null }
  | { intent: "mark"; target: string; status: ProspectStatus }
  | { intent: "unknown" };

/** Understands the everyday phrasings without needing any AI. */
function parseRules(raw: string): Intent {
  const t = norm(raw);
  if (!t) return { intent: "unknown" };
  if (/^(help|what can (you|i) (do|say)|commands|options)\b/.test(t)) return { intent: "help" };
  if (/^(stop|cancel|never ?mind|that'?s all|quiet|be quiet|goodbye|bye)\b/.test(t)) return { intent: "stop" };

  const m = t.match(/\b(?:mark|set|move|put)\s+(.+?)\s+(?:as|to)\s+(.+)$/);
  if (m) {
    const st = STATUS_WORDS.find(([re]) => re.test(m[2]));
    if (st) return { intent: "mark", target: m[1], status: st[1] };
  }
  const m2 = t.match(/^(.+?)\s+(?:replied|responded|is not interested|isn'?t interested|said no)$/);
  if (m2) return { intent: "mark", target: m2[1], status: /not interested|isn'?t|said no/.test(t) ? "not_interested" : "replied" };

  if (/\b(dashboard|stats|statistics|numbers|report|how (are|am) (we|i) doing|how'?s it going|status update|summary)\b/.test(t)) return { intent: "dashboard" };
  if (/\b(draft|prepare|make|create|write|generate)\b.*\b(today'?s|today|daily|morning|new) (emails|drafts|batch)\b|\bdraft (today|the emails)\b/.test(t)) return { intent: "draft_today" };

  const w = t.match(/\b(?:write|draft|compose|email|send|prepare)\b(?:\s+(?:an?|another|the))?(?:\s+(?:email|e-mail|note|message|follow[- ]?up|intro))?(?:\s+(?:for\s+(?:church ?follow|client ?pulse)))?\s+(?:to|for)\s+(.+)$/);
  if (w) return { intent: "write", target: w[1].replace(/\b(about|for) (church ?follow|client ?pulse)\b/, "").trim(), product: productHint(t) };

  if (/\b(read|go through|review|check|what'?s (waiting|pending)|any(thing)? (waiting|pending)|my (emails|drafts|queue)|pending)\b/.test(t)) return { intent: "read" };
  return { intent: "unknown" };
}

const AI_SCHEMA = {
  type: "object",
  properties: {
    intent: { type: "string", enum: ["help", "dashboard", "read", "draft_today", "stop", "write", "mark", "unknown"] },
    target: { type: "string" },
    product: { type: "string", enum: ["clientpulse", "churchfollow", "none"] },
    status: { type: "string", enum: ["new", "contacted", "replied", "not_interested", "do_not_contact", "none"] },
  },
  required: ["intent", "target", "product", "status"],
  additionalProperties: false,
} as const;

/** When the rules don't recognize a phrasing and an AI key is saved, ask Claude what was meant. */
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
        "You map one spoken command for an outreach assistant to an intent. Intents: help; dashboard (report stats); read (read pending email drafts aloud); " +
        "draft_today (make today's batch of drafts); stop; write (write an email to one prospect: put the person, church or company in target); " +
        "mark (change a prospect's status: target and status); unknown. Products are ClientPulse and ChurchFollow. The command is speech-to-text and may have mistakes. " +
        "Latency-sensitive; answer immediately.",
      messages: [{ role: "user", content: `<command>${text.slice(0, 500)}</command>` }],
    });
    if (res.stop_reason === "refusal") return { intent: "unknown" };
    const out = JSON.parse(res.content.filter((b) => b.type === "text").map((b) => b.text).join("")) as {
      intent: string; target: string; product: string; status: string;
    };
    const product = out.product === "none" ? null : (out.product as Product);
    if (out.intent === "write" && out.target) return { intent: "write", target: out.target, product };
    if (out.intent === "mark" && out.target && out.status !== "none") return { intent: "mark", target: out.target, status: out.status as ProspectStatus };
    if (["help", "dashboard", "read", "draft_today", "stop"].includes(out.intent)) return { intent: out.intent as "help" };
  } catch (e) {
    console.error("voice AI parse failed:", (e as Error).message);
  }
  return { intent: "unknown" };
}

export async function runCommand(env: Env, text: string): Promise<VoiceReply> {
  let it = parseRules(text);
  if (it.intent === "unknown") it = await parseWithAI(env, text);

  switch (it.intent) {
    case "help":
      return { say: HELP };
    case "stop":
      return { say: "Okay.", end: true };
    case "dashboard":
      return { say: await dashboardSpeech(env) };
    case "read": {
      const queue = await pendingQueue(env);
      if (!queue.length) return { say: "No emails are waiting. Say draft today's emails, or write an email to someone." };
      return { say: `You have ${plural(queue.length, "email")} waiting.`, queue };
    }
    case "draft_today": {
      const r = await buildDailyDrafts(env, "manual");
      const queue = r.created ? await pendingQueue(env) : [];
      return { say: queue.length ? `${r.note} Here's the first one.` : r.note, queue: queue.length ? queue : undefined };
    }
    case "write":
      return writeFor(env, it.target, it.product);
    case "mark":
      return mark(env, it.target, it.status);
    default:
      return { say: `Sorry, I didn't catch that.${(await hasSecret(env, "anthropic")) ? "" : " Say help to hear what I can do."}` };
  }
}
