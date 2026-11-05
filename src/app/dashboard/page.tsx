import Link from "next/link";
import type { Metadata } from "next";
import { and, count, countDistinct, desc, eq, gte, inArray } from "drizzle-orm";
import { db, visitors, messages } from "@/db";
import { requireChurch } from "@/lib/session";
import { formatDate, formatPhone, startOfMonth } from "@/lib/utils";
import { MessageBadge } from "@/components/MessageBadge";
import { ReturnedButton } from "@/components/ReturnedButton";

export const metadata: Metadata = { title: "Guests" };

const STEP_ORDER = ["welcome", "checkin", "invite"];

export default async function DashboardPage() {
  const church = await requireChurch();
  const monthStart = startOfMonth();

  const [[{ visitorsThisMonth }], [{ repliesThisMonth }], [{ returnsThisMonth }], guests] = await Promise.all([
    db.select({ visitorsThisMonth: count() }).from(visitors)
      .where(and(eq(visitors.churchId, church.id), gte(visitors.createdAt, monthStart))),
    db.select({ repliesThisMonth: countDistinct(messages.visitorId) }).from(messages)
      .where(and(eq(messages.churchId, church.id), eq(messages.kind, "reply"), gte(messages.createdAt, monthStart))),
    db.select({ returnsThisMonth: count() }).from(visitors)
      .where(and(eq(visitors.churchId, church.id), gte(visitors.returnedAt, monthStart))),
    db.select().from(visitors).where(eq(visitors.churchId, church.id)).orderBy(desc(visitors.createdAt)).limit(200),
  ]);

  const msgs = guests.length
    ? await db.select().from(messages).where(inArray(messages.visitorId, guests.map((g) => g.id)))
    : [];
  const byVisitor = new Map<string, typeof msgs>();
  for (const m of msgs) {
    const list = byVisitor.get(m.visitorId) ?? [];
    list.push(m);
    byVisitor.set(m.visitorId, list);
  }

  const monthName = new Date().toLocaleDateString("en-US", { month: "long" });

  return (
    <div className="stack-lg">
      <div>
        <h1 style={{ marginBottom: 4 }}>{church.name}</h1>
        <p className="muted" style={{ margin: 0 }}>Here&apos;s how your guests are doing in {monthName}.</p>
      </div>

      <div className="stats">
        <div className="card stat"><span className="stat-value">{visitorsThisMonth}</span><span className="stat-label">New visitors</span></div>
        <div className="card stat"><span className="stat-value">{repliesThisMonth}</span><span className="stat-label">Replied</span></div>
        <div className="card stat"><span className="stat-value">{returnsThisMonth}</span><span className="stat-label">Returned</span></div>
      </div>

      <div className="card">
        <div className="row between" style={{ marginBottom: 4 }}>
          <h2 style={{ margin: 0 }}>Guests</h2>
          <span className="muted small">{guests.length} total{guests.length === 200 ? " (latest 200)" : ""}</span>
        </div>

        {guests.length === 0 ? (
          <div className="center" style={{ padding: "28px 0 12px" }}>
            <p className="muted">No guests yet. Print your pew cards and put them out this Sunday!</p>
            <Link href="/dashboard/share" className="btn btn-primary">Get your QR code</Link>
          </div>
        ) : (
          <ul className="guest-list">
            {guests.map((g) => {
              const gm = byVisitor.get(g.id) ?? [];
              const steps = STEP_ORDER.map((k) => gm.find((m) => m.kind === k)).filter((m) => m !== undefined);
              const replies = gm.filter((m) => m.kind === "reply").length;
              return (
                <li key={g.id} className="guest">
                  <div style={{ minWidth: 0 }}>
                    <Link href={`/dashboard/guests/${g.id}`} className="guest-name">{g.firstName}</Link>
                    <div className="guest-meta">
                      {formatPhone(g.phone)} · Visited {formatDate(g.createdAt)}
                      {g.optedOut && " · Opted out"}
                    </div>
                    <div className="guest-steps" style={{ marginTop: 8 }}>
                      {steps.map((m) => <MessageBadge key={m.id} m={m} />)}
                      {replies > 0 && (
                        <Link href={`/dashboard/guests/${g.id}`} className="badge badge-accent">💬 {replies} repl{replies === 1 ? "y" : "ies"}</Link>
                      )}
                    </div>
                  </div>
                  <ReturnedButton visitorId={g.id} returned={!!g.returnedAt} />
                </li>
              );
            })}
          </ul>
        )}
      </div>
    </div>
  );
}
