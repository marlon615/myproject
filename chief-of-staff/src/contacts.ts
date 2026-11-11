import PostalMime from "postal-mime";
import { Imap } from "./mail/imap";
import { mailHosts } from "./mail/net";
import type { Env, Prospect } from "./types";

export interface Contact { id: number; name: string; email: string | null; phone: string | null; source: string; last_seen_at: string | null }

const AUTOMATED = /no-?reply|do-?not-?reply|notifications?@|mailer-daemon|bounce|news(letter)?@|marketing@|updates?@|support@|billing@|receipts?@|calendar-notification/i;

export function cleanPhone(raw: string): string | null {
  const digits = raw.replace(/[^\d+]/g, "");
  const n = digits.replace(/^\+?1(?=\d{10}$)/, "");
  if (/^\d{10}$/.test(n)) return `+1${n}`;
  if (/^\+\d{8,15}$/.test(digits)) return digits;
  return null;
}

/** Reads a phone number out of an email signature (the last lines of the message). */
export function phoneFromSignature(text: string): string | null {
  const tail = text.split(/\n/).slice(-15).join("\n");
  const m = tail.match(/(?:\+?1[\s.-]?)?\(?\b\d{3}\)?[\s.-]?\d{3}[\s.-]?\d{4}\b/);
  return m ? cleanPhone(m[0]) : null;
}

/** Adds or refreshes a contact. Never overwrites a name or number you gave it with a guess. */
export async function upsertContact(env: Env, c: { name?: string; email?: string | null; phone?: string | null; source: string }) {
  const email = c.email?.toLowerCase().trim() || null;
  if (email && AUTOMATED.test(email)) return;
  const name = (c.name ?? "").replace(/^["']|["']$/g, "").trim().slice(0, 120);
  const now = new Date().toISOString();
  if (email) {
    await env.DB.prepare(
      `insert into contacts (name, email, phone, source, last_seen_at) values (?, ?, ?, ?, ?)
       on conflict(email) do update set
         name = case when contacts.name = '' then excluded.name else contacts.name end,
         phone = coalesce(contacts.phone, excluded.phone),
         last_seen_at = excluded.last_seen_at`,
    ).bind(name, email, c.phone ?? null, c.source, now).run();
  } else if (c.phone && name) {
    await env.DB.prepare("insert into contacts (name, phone, source, last_seen_at) values (?, ?, ?, ?)").bind(name, c.phone, c.source, now).run();
  }
}

/** Learns everyone you've emailed in the last 6 months from your Gmail Sent folder (headers only). */
export async function harvestSent(env: Env, user: string, pass: string): Promise<number> {
  const im = await Imap.login(mailHosts(env).imap, user, pass);
  try {
    const sent = await im.sentMailbox();
    if (!sent) return 0;
    await im.examine(sent);
    const uids = (await im.searchGmail("newer_than:180d")).slice(-150);
    const heads = await im.fetchRecipients(uids);
    const seen = new Map<string, string>();
    for (const h of heads) {
      const parsed = await PostalMime.parse(new TextEncoder().encode(new TextDecoder().decode(h) + "\r\n\r\n"));
      for (const a of [...(parsed.to ?? []), ...(parsed.cc ?? [])]) {
        if ("address" in a && a.address && a.address.toLowerCase() !== user.toLowerCase()) seen.set(a.address.toLowerCase(), a.name ?? "");
      }
    }
    for (const [email, name] of seen) await upsertContact(env, { email, name, source: "gmail-sent" });
    return seen.size;
  } finally {
    await im.logout();
  }
}

const norm = (s: string) => s.toLowerCase().replace(/[^\p{L}\p{N}\s@.]/gu, " ").replace(/\s+/g, " ").trim();
const SKIP = new Set(["the", "a", "an", "at", "to", "for", "my", "from", "of", "pastor", "mr", "mrs", "ms", "dr"]);

export interface Person { name: string; email: string | null; phone: string | null; organization?: string; prospectId?: number }

/** Finds the person a spoken name means, across contacts and prospects. */
export async function findPerson(env: Env, spoken: string): Promise<Person | null> {
  const digits = cleanPhone(spoken);
  if (digits && /\d{7,}/.test(spoken.replace(/\D/g, ""))) return { name: spoken.trim(), email: null, phone: digits };
  const words = norm(spoken).split(" ").filter((w) => w.length > 1 && !SKIP.has(w));
  if (!words.length) return null;
  const [contacts, prospects] = await Promise.all([
    env.DB.prepare("select * from contacts order by coalesce(last_seen_at, created_at) desc limit 3000").all<Contact>(),
    env.DB.prepare("select * from prospects order by id desc limit 2000").all<Prospect>(),
  ]);
  type Cand = { p: Person; hay: string; recency: number };
  const cands: Cand[] = [
    ...contacts.results.map((c, i) => ({ p: { name: c.name || c.email || "", email: c.email, phone: c.phone }, hay: norm(`${c.name} ${c.email ?? ""}`), recency: 1 - i / 3000 })),
    ...prospects.results.map((p) => ({ p: { name: p.name || p.email, email: p.email, phone: null, organization: p.organization, prospectId: p.id }, hay: norm(`${p.name} ${p.organization} ${p.email}`), recency: 0.5 })),
  ];
  let best: Cand | null = null, bestScore = 0;
  for (const c of cands) {
    let score = 0;
    for (const w of words) if (new RegExp(`(^|\\s|@)${w.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}`).test(c.hay)) score += w.length;
    if (score > 0) score += c.recency;
    if (score > bestScore) { best = c; bestScore = score; }
  }
  if (!best || bestScore < 3) return null;
  // Fill a missing phone or email from another record of the same person.
  const same = cands.filter((c) => c !== best && c.p.email && c.p.email === best!.p.email);
  for (const s of same) {
    best.p.phone ??= s.p.phone;
    if (!best.p.organization && s.p.organization) best.p.organization = s.p.organization;
    if (!best.p.prospectId && s.p.prospectId) best.p.prospectId = s.p.prospectId;
  }
  return best.p;
}

export async function contactCount(env: Env) {
  return (await env.DB.prepare("select count(*) as n from contacts").first<{ n: number }>())?.n ?? 0;
}
