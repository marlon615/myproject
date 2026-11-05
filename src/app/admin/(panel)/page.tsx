import Link from "next/link";
import { overviewData, timeAgo, OWNER_TZ } from "@/lib/admin";
import { PRICE_MONTHLY_USD } from "@/lib/config";
import { FailedList } from "@/components/admin/FailedList";
import { formatDate } from "@/lib/utils";
import { DailyLineChart, WeeklyColumnChart } from "@/components/admin/Charts";
import { SERIES } from "@/lib/chart-colors";

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
const shortDate = (iso: string) => `${MONTHS[Number(iso.slice(5, 7)) - 1]} ${Number(iso.slice(8, 10))}`;

function endsIn(d: Date) {
  const hours = (d.getTime() - Date.now()) / 3600000;
  if (hours < 24) return `ends in ${Math.max(1, Math.round(hours))} h`;
  const days = Math.ceil(hours / 24);
  return `ends in ${days} day${days === 1 ? "" : "s"}`;
}

export default async function AdminOverview() {
  const d = await overviewData();
  const v30 = d.daily.reduce((a, x) => a + x.visitors, 0);
  const t30 = d.daily.reduce((a, x) => a + x.texts, 0);
  const c12 = d.weekly.reduce((a, x) => a + x.churches, 0);

  return (
    <div className="stack-lg">
      {/* ─────────── Revenue ─────────── */}
      <section>
        <div className="section-title"><h2>Revenue</h2><Link href="/admin/churches?status=paying" className="small">Paying churches →</Link></div>
        <div className="rev-grid">
          <div className="card">
            <div className="kpi-label">Monthly recurring revenue</div>
            <div className="hero-figure" style={{ margin: "6px 0 4px" }}>${d.revenue.mrr.toLocaleString("en-US")}</div>
            <div className="stat-sub">{d.revenue.paying} paying × ${PRICE_MONTHLY_USD}/mo</div>
            <div className="kpis" style={{ marginTop: 16 }}>
              <div className="card card-flat"><div className="kpi-value">{d.revenue.paying}</div><div className="kpi-label">Paying</div></div>
              <div className="card card-flat"><div className="kpi-value">{d.revenue.trials}</div><div className="kpi-label">On trial</div></div>
              <div className="card card-flat">
                <div className="kpi-value">{d.revenue.pastDue}</div>
                <div className="kpi-label">{d.revenue.pastDue > 0 ? "⚠ " : ""}Past due</div>
              </div>
              <div className="card card-flat"><div className="kpi-value">{d.revenue.canceling}</div><div className="kpi-label">Canceling</div></div>
            </div>
          </div>

          <div className="card">
            <div className="section-title">
              <h3 style={{ margin: 0 }}>Trials ending in 3 days</h3>
              <span className="badge badge-scheduled">{d.trialsEnding.length}</span>
            </div>
            {d.trialsEnding.length === 0 ? (
              <p className="muted small" style={{ margin: 0 }}>No trials ending soon.</p>
            ) : (
              <ul className="list">
                {d.trialsEnding.map(({ church, endsAt, visitors }) => (
                  <li key={church.id}>
                    <div className="list-main">
                      <Link href={`/admin/churches/${church.id}`} className="list-title">{church.name}</Link>
                      <span className="badge badge-scheduled" style={{ flex: "none" }}>{endsIn(endsAt)}</span>
                    </div>
                    <div className="list-meta">
                      {church.pastorName} · <a href={`mailto:${church.email}`}>{church.email}</a>
                    </div>
                    <div className="metrics">
                      <span><strong>{visitors}</strong> visitor{visitors === 1 ? "" : "s"}</span>
                      <span>Pastor seen <strong>{timeAgo(church.lastSeenAt)}</strong></span>
                    </div>
                  </li>
                ))}
              </ul>
            )}
          </div>
        </div>
      </section>

      {/* ─────────── Activity charts ─────────── */}
      <section>
        <div className="section-title"><h2>Activity</h2></div>
        <div className="chart-grid">
          <div className="card">
            <h3 style={{ marginBottom: 2 }}>Visitors &amp; texts sent per day</h3>
            <p className="muted small" style={{ marginBottom: 10 }}>Last 30 days · {v30.toLocaleString("en-US")} visitors · {t30.toLocaleString("en-US")} texts sent</p>
            <DailyLineChart
              data={d.daily}
              series={[
                { key: "visitors", label: "Visitors", color: SERIES.terracotta },
                { key: "texts", label: "Texts sent", color: SERIES.blue },
              ]}
            />
            <details className="table-view">
              <summary>Show table</summary>
              <div className="table-wrap">
                <table>
                  <thead><tr><th>Day</th><th className="num">Visitors</th><th className="num">Texts sent</th></tr></thead>
                  <tbody>
                    {[...d.daily].reverse().map((x) => (
                      <tr key={x.day}><td>{shortDate(x.day)}</td><td className="num">{x.visitors}</td><td className="num">{x.texts}</td></tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </details>
          </div>

          <div className="card">
            <h3 style={{ marginBottom: 2 }}>New churches per week</h3>
            <p className="muted small" style={{ marginBottom: 10 }}>Last 12 weeks · {c12} signups · {d.revenue.totalChurches} churches total</p>
            <WeeklyColumnChart data={d.weekly.map((w) => ({ week: w.week, value: w.churches }))} label="New churches" color={SERIES.terracotta} />
            <details className="table-view">
              <summary>Show table</summary>
              <div className="table-wrap">
                <table>
                  <thead><tr><th>Week of</th><th className="num">New churches</th></tr></thead>
                  <tbody>
                    {[...d.weekly].reverse().map((x) => (
                      <tr key={x.week}><td>{shortDate(x.week)}</td><td className="num">{x.churches}</td></tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </details>
          </div>
        </div>
      </section>

      {/* ─────────── Failed texts ─────────── */}
      <section>
        <div className="section-title">
          <h2>Failed texts</h2>
          <Link href="/admin/failed" className="small">{d.failed30} in last 30 days →</Link>
        </div>
        <div className="card">
          <FailedList rows={d.failed} />
          {(d.failed.length >= 5 || d.failed30 > d.failed.length) && (
            <Link href="/admin/failed" className="btn btn-secondary btn-block btn-sm" style={{ marginTop: 12 }}>See all failed texts &amp; reasons</Link>
          )}
        </div>
      </section>

      <p className="tiny muted center">Days and weeks are counted in {OWNER_TZ} time · updated {formatDate(new Date())}</p>
    </div>
  );
}
