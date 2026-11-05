import { count, desc, eq, gte, sql, and } from "drizzle-orm";
import { db, churches, visitors, messages } from "@/db";
import { planState, planLabel } from "@/lib/billing";
import { PRICE_MONTHLY_USD } from "@/lib/config";
import { formatDate, startOfMonth } from "@/lib/utils";

export default async function AdminPage() {
  const monthStart = startOfMonth();
  const [list, visitorCounts, sentCounts, [{ total: totalVisitors }], [{ total: totalSent }], [{ total: newChurches }]] = await Promise.all([
    db.select().from(churches).orderBy(desc(churches.createdAt)),
    db.select({
      churchId: visitors.churchId,
      total: count(),
      thisMonth: sql<number>`count(*) filter (where ${visitors.createdAt} >= ${monthStart.toISOString()})`.mapWith(Number),
      returned: sql<number>`count(${visitors.returnedAt})`.mapWith(Number),
    }).from(visitors).groupBy(visitors.churchId),
    db.select({ churchId: messages.churchId, total: count() }).from(messages)
      .where(and(eq(messages.direction, "outbound"), eq(messages.status, "sent"))).groupBy(messages.churchId),
    db.select({ total: count() }).from(visitors),
    db.select({ total: count() }).from(messages).where(and(eq(messages.direction, "outbound"), eq(messages.status, "sent"))),
    db.select({ total: count() }).from(churches).where(gte(churches.createdAt, monthStart)),
  ]);

  const vMap = new Map(visitorCounts.map((v) => [v.churchId, v]));
  const sMap = new Map(sentCounts.map((s) => [s.churchId, s.total]));
  const rows = list.map((c) => ({ c, plan: planState(c), v: vMap.get(c.id), sent: sMap.get(c.id) ?? 0 }));
  const paying = rows.filter((r) => r.plan.kind === "active").length;
  const trialing = rows.filter((r) => r.plan.kind === "trial").length;

  return (
    <div className="stack-lg">
      <div>
        <h1 style={{ marginBottom: 4 }}>All churches</h1>
        <p className="muted" style={{ margin: 0 }}>Everything across ChurchFollow, at a glance.</p>
      </div>

      <div className="stats stats-4">
        <div className="card stat"><span className="stat-value">{list.length}</span><span className="stat-label">Churches · {newChurches} new this month</span></div>
        <div className="card stat"><span className="stat-value">{totalVisitors}</span><span className="stat-label">Total visitors</span></div>
        <div className="card stat"><span className="stat-value">{totalSent}</span><span className="stat-label">Texts sent</span></div>
        <div className="card stat"><span className="stat-value">${paying * PRICE_MONTHLY_USD}</span><span className="stat-label">MRR · {paying} paying · {trialing} on trial</span></div>
      </div>

      <div className="card">
        <h2>Churches</h2>
        {rows.length === 0 ? (
          <p className="muted">No signups yet.</p>
        ) : (
          <div className="table-wrap">
            <table>
              <thead>
                <tr>
                  <th>Church</th>
                  <th>Signed up</th>
                  <th>Status</th>
                  <th className="num">Visitors</th>
                  <th className="num">This month</th>
                  <th className="num">Returned</th>
                  <th className="num">Texts sent</th>
                </tr>
              </thead>
              <tbody>
                {rows.map(({ c, plan, v, sent }) => (
                  <tr key={c.id}>
                    <td>
                      <div style={{ fontWeight: 600 }}>{c.name}</div>
                      <div className="tiny muted">{c.pastorName} · <a href={`mailto:${c.email}`}>{c.email}</a>{c.city ? ` · ${c.city}` : ""}</div>
                      <div className="tiny"><a href={`/g/${c.slug}`} target="_blank" rel="noreferrer">/g/{c.slug}</a></div>
                    </td>
                    <td style={{ whiteSpace: "nowrap" }}>{formatDate(c.createdAt)}</td>
                    <td>
                      <span className={`badge ${plan.kind === "active" ? "badge-sent" : plan.kind === "trial" ? "badge-scheduled" : "badge-failed"}`}>
                        <span className="dot" />{planLabel(plan)}
                      </span>
                      {plan.kind === "trial" && <div className="tiny muted" style={{ marginTop: 4 }}>ends {formatDate(plan.endsAt)}</div>}
                    </td>
                    <td className="num">{v?.total ?? 0}</td>
                    <td className="num">{v?.thisMonth ?? 0}</td>
                    <td className="num">{v?.returned ?? 0}</td>
                    <td className="num">{sent}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>
    </div>
  );
}
