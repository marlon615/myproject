import Link from "next/link";
import { notFound } from "next/navigation";
import type { Metadata } from "next";
import { churchDetail, STATUS_BADGE, timeAgo } from "@/lib/admin";
import { planLabel } from "@/lib/billing";
import { KIND_LABELS } from "@/lib/messaging";
import { formatDate, formatDateTime, formatPhone } from "@/lib/utils";

export const metadata: Metadata = { title: "Church · Owner" };

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export default async function ChurchDetailPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  if (!UUID.test(id)) notFound();
  const d = await churchDetail(id);
  if (!d) notFound();
  const { church, plan, stats, activity } = d;
  const badge = STATUS_BADGE[d.group];

  return (
    <div className="stack-lg">
      <Link href="/admin/churches" className="small">← All churches</Link>

      <div className="card">
        <div className="list-main">
          <h1 style={{ margin: 0, fontSize: "clamp(1.4rem, 5vw, 2rem)" }}>{church.name}</h1>
          <span className={`badge ${badge.cls}`} style={{ flex: "none", marginTop: 6 }}><span className="dot" />{badge.label}</span>
        </div>
        <div className="list-meta" style={{ marginTop: 6 }}>
          {church.pastorName}{church.city ? ` · ${church.city}` : ""}
        </div>
        <div className="row" style={{ marginTop: 12 }}>
          <a href={`mailto:${church.email}`} className="btn btn-secondary btn-sm">Email {church.email}</a>
          <a href={`/g/${church.slug}`} target="_blank" rel="noreferrer" className="btn btn-ghost btn-sm">Guest page ↗</a>
        </div>
      </div>

      <div className="kpis">
        <div className="card"><div className="kpi-value">{stats.visitors}</div><div className="kpi-label">Visitor{stats.visitors === 1 ? "" : "s"}</div><div className="stat-sub">{stats.visitors30} in last 30 days</div></div>
        <div className="card"><div className="kpi-value">{stats.textsSent}</div><div className="kpi-label">Text{stats.textsSent === 1 ? "" : "s"} sent</div><div className="stat-sub">{stats.scheduled} scheduled</div></div>
        <div className="card"><div className="kpi-value">{stats.replies}</div><div className="kpi-label">Repl{stats.replies === 1 ? "y" : "ies"}</div><div className="stat-sub">{stats.returned} returned</div></div>
        <div className="card"><div className="kpi-value">{stats.failed}</div><div className="kpi-label">{stats.failed > 0 ? "⚠ " : ""}Failed text{stats.failed === 1 ? "" : "s"}</div><div className="stat-sub">{stats.optedOut} opted out</div></div>
      </div>

      <div className="grid grid-2">
        <div className="card">
          <h3>Plan</h3>
          <dl className="dl">
            <dt>Status</dt><dd><strong>{planLabel(plan)}</strong></dd>
            <dt>Signed up</dt><dd>{formatDate(church.createdAt)}</dd>
            <dt>Trial {plan.kind === "trial" ? "ends" : "ended"}</dt><dd>{formatDate(church.trialEndsAt)}</dd>
            {plan.kind === "active" && plan.renewsAt && (<><dt>Next payment</dt><dd>{formatDate(plan.renewsAt)}</dd></>)}
            {plan.kind === "active" && plan.cancelsAt && (<><dt>Access until</dt><dd>{formatDate(plan.cancelsAt)}</dd></>)}
            {plan.kind === "expired" && (<><dt>Inactive since</dt><dd>{formatDate(plan.endedAt)}</dd></>)}
            <dt>PayPal sub</dt><dd className="small">{church.paypalSubscriptionId ?? "—"}</dd>
          </dl>
        </div>
        <div className="card">
          <h3>Last activity</h3>
          <p style={{ margin: "0 0 12px", fontSize: "1.1rem", fontWeight: 600 }}>{timeAgo(activity.last)}</p>
          <dl className="dl">
            <dt>Pastor seen</dt><dd>{timeAgo(activity.pastorSeen)}</dd>
            <dt>Last guest</dt><dd>{timeAgo(activity.lastGuest)}</dd>
            <dt>Last text</dt><dd>{timeAgo(activity.lastText)}</dd>
          </dl>
        </div>
      </div>

      <div className="card">
        <h3>Recent visitors</h3>
        {d.recentGuests.length === 0 ? (
          <p className="muted small" style={{ margin: 0 }}>No visitors yet.</p>
        ) : (
          <ul className="list">
            {d.recentGuests.map((g) => (
              <li key={g.id}>
                <div className="list-main">
                  <span className="list-title">{g.firstName}</span>
                  <span className="tiny muted" style={{ flex: "none" }}>{formatDate(g.createdAt)}</span>
                </div>
                <div className="list-meta">
                  {formatPhone(g.phone)}
                  {g.returnedAt && " · ✓ Returned"}
                  {g.lastReplyAt && " · Replied"}
                  {g.optedOut && " · Opted out"}
                </div>
              </li>
            ))}
          </ul>
        )}
      </div>

      <div className="card">
        <h3>Failed texts</h3>
        {d.failed.length === 0 ? (
          <p className="muted small" style={{ margin: 0 }}>None.</p>
        ) : (
          <ul className="list">
            {d.failed.map((f) => (
              <li key={f.id}>
                <div className="list-main">
                  <span className="list-title">{KIND_LABELS[f.kind] ?? f.kind} to {f.guest}</span>
                  <span className="tiny muted" style={{ flex: "none" }}>{formatDateTime(f.at)}</span>
                </div>
                <div className="reason">{f.error ?? "No reason given"}</div>
              </li>
            ))}
          </ul>
        )}
      </div>
    </div>
  );
}
