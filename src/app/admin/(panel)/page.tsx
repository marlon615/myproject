import Link from "next/link";
import { overviewData, usd, timeAgo, OWNER_TZ, STATUS_BADGE, statusGroup } from "@/lib/admin";
import { PRICE_MONTHLY_USD } from "@/lib/config";
import { formatDate, formatDateTime } from "@/lib/utils";
import { DailyLineChart, WeeklyColumnChart } from "@/components/admin/Charts";
import { SERIES } from "@/lib/chart-colors";

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
const shortDate = (iso: string) => `${MONTHS[Number(iso.slice(5, 7)) - 1]} ${Number(iso.slice(8, 10))}`;

export default async function AdminOverview() {
  const d = await overviewData();
  const s12 = d.weekly.reduce((a, x) => a + x.signups, 0);

  return (
    <div className="stack-lg">
      <section>
        <div className="section-title"><h2>Revenue</h2><Link href="/admin/payments" className="small">All payments →</Link></div>
        <div className="rev-grid">
          <div className="card">
            <div className="kpi-label">Monthly recurring revenue</div>
            <div className="hero-figure" style={{ margin: "6px 0 4px" }}>${d.revenue.mrr.toLocaleString("en-US")}</div>
            <div className="stat-sub">{d.revenue.paying} paying × ${PRICE_MONTHLY_USD}/mo · collected {usd(d.revenue.collected30)} in 30 days · {usd(d.revenue.collectedAllTime)} all time</div>
            <div className="kpis" style={{ marginTop: 16 }}>
              <div className="card card-flat"><div className="kpi-value">{d.revenue.totalSignups}</div><div className="kpi-label">Signups</div></div>
              <div className="card card-flat"><div className="kpi-value">{d.revenue.trials}</div><div className="kpi-label">On pilot</div></div>
              <div className="card card-flat"><div className="kpi-value">{d.revenue.paying}</div><div className="kpi-label">Paying</div></div>
              <div className="card card-flat"><div className="kpi-value">{d.revenue.pastDue}</div><div className="kpi-label">{d.revenue.pastDue > 0 ? "⚠ " : ""}Past due</div></div>
            </div>
          </div>
          <div className="card">
            <div className="section-title"><h3 style={{ margin: 0 }}>Pilots ending in 3 days</h3><span className="badge badge-scheduled">{d.pilotsEnding.length}</span></div>
            {d.pilotsEnding.length === 0 ? <p className="muted small" style={{ margin: 0 }}>No pilots ending soon.</p> : (
              <ul className="list">
                {d.pilotsEnding.map((c) => (
                  <li key={c.id}>
                    <div className="list-main"><Link href={`/admin/signups/${c.id}`} className="list-title">{c.businessName}</Link><span className="badge badge-scheduled">ends {formatDate(c.trialEndsAt)}</span></div>
                    <div className="list-meta">{c.ownerName} · <a href={`mailto:${c.email}`}>{c.email}</a> · seen {timeAgo(c.lastSeenAt)}</div>
                  </li>
                ))}
              </ul>
            )}
          </div>
        </div>
      </section>

      <section>
        <div className="section-title"><h2>Last 30 days</h2></div>
        <div className="kpis">
          <Link href="/admin/calls" className="card card-flat"><div className="kpi-value">{d.totals30.calls}</div><div className="kpi-label">Calls</div></Link>
          <Link href="/admin/texts" className="card card-flat"><div className="kpi-value">{d.totals30.texts}</div><div className="kpi-label">Texts</div></Link>
          <Link href="/admin/bookings" className="card card-flat"><div className="kpi-value">{d.totals30.bookings}</div><div className="kpi-label">Bookings</div></Link>
          <Link href="/admin/bookings" className="card card-flat"><div className="kpi-value">{d.totals30.emergencies}</div><div className="kpi-label">Emergency bookings</div></Link>
        </div>
        <div className="chart-grid" style={{ marginTop: 16 }}>
          <div className="card">
            <h3 style={{ marginBottom: 10 }}>Calls, texts &amp; bookings per day</h3>
            <DailyLineChart
              data={d.daily}
              series={[
                { key: "calls", label: "Calls", color: SERIES.orange },
                { key: "texts", label: "Texts", color: SERIES.blue },
                { key: "bookings", label: "Bookings", color: SERIES.green },
              ]}
            />
            <details className="table-view">
              <summary>Show table</summary>
              <div className="table-wrap"><table>
                <thead><tr><th>Day</th><th className="num">Calls</th><th className="num">Texts</th><th className="num">Bookings</th></tr></thead>
                <tbody>{[...d.daily].reverse().map((x) => <tr key={x.day}><td>{shortDate(x.day)}</td><td className="num">{x.calls}</td><td className="num">{x.texts}</td><td className="num">{x.bookings}</td></tr>)}</tbody>
              </table></div>
            </details>
          </div>
          <div className="card">
            <h3 style={{ marginBottom: 2 }}>New signups per week</h3>
            <p className="muted small" style={{ marginBottom: 10 }}>Last 12 weeks · {s12} signups</p>
            <WeeklyColumnChart data={d.weekly.map((w) => ({ week: w.week, value: w.signups }))} label="Signups" color={SERIES.orange} />
          </div>
        </div>
      </section>

      <div className="grid grid-2" style={{ alignItems: "start" }}>
        <section className="card">
          <div className="section-title"><h3 style={{ margin: 0 }}>Latest signups</h3><Link href="/admin/signups" className="small">All →</Link></div>
          {d.recentSignups.length === 0 ? <p className="muted small" style={{ margin: 0 }}>No signups yet.</p> : (
            <ul className="list">{d.recentSignups.map((c) => { const g = STATUS_BADGE[statusGroup(c)]; return (
              <li key={c.id}><div className="list-main"><Link href={`/admin/signups/${c.id}`} className="list-title">{c.businessName}</Link><span className={`badge ${g.cls}`}>{g.label}</span></div>
                <div className="list-meta">{c.email} · {timeAgo(c.createdAt)}</div></li>); })}</ul>
          )}
        </section>
        <section className="card">
          <div className="section-title"><h3 style={{ margin: 0 }}>Latest payments</h3><Link href="/admin/payments" className="small">All →</Link></div>
          {d.recentPayments.length === 0 ? <p className="muted small" style={{ margin: 0 }}>No payments yet.</p> : (
            <ul className="list">{d.recentPayments.map(({ payment: p, businessName }) => (
              <li key={p.id}><div className="list-main"><span className="list-title">{usd(p.amountCents)} {p.currency !== "USD" ? p.currency : ""}</span><span className={`badge ${p.status === "completed" ? "badge-sent" : p.status === "failed" ? "badge-failed" : "badge-skipped"}`}>{p.status}</span></div>
                <div className="list-meta">{businessName ?? "Unmatched"} · {formatDateTime(p.occurredAt)}</div></li>))}</ul>
          )}
        </section>
      </div>

      <p className="tiny muted center">Days and weeks are in {OWNER_TZ.replace("America/Chicago", "US Central").replace(/_/g, " ")} time · updated {formatDate(new Date())}</p>
    </div>
  );
}
