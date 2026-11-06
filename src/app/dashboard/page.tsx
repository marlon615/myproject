import Link from "next/link";
import { requireContractor } from "@/lib/session";
import { overview } from "@/lib/dashboard";
import { BookingRow } from "@/components/BookingRow";
import { ConversationItem } from "@/components/ConversationItem";
import { monthName } from "@/lib/utils";

export default async function Dashboard() {
  const c = await requireContractor();
  const d = await overview(c);
  return (
    <div className="stack-lg">
      <div>
        <h1 style={{ marginBottom: 4 }}>{c.businessName}</h1>
        <p className="muted" style={{ margin: 0 }}>{monthName()} so far</p>
      </div>
      <div className="stats stats-4">
        <div className="card stat"><span className="stat-value">{d.stats.calls}</span><span className="stat-label">Calls answered</span></div>
        <div className="card stat"><span className="stat-value">{d.stats.textBacks}</span><span className="stat-label">Callers texted back</span></div>
        <div className="card stat"><span className="stat-value">{d.stats.booked}</span><span className="stat-label">Jobs booked</span></div>
        <div className="card stat"><span className="stat-value">{d.stats.emergencies}</span><span className="stat-label">Emergencies</span></div>
      </div>
      <div className="grid grid-2" style={{ alignItems: "start" }}>
        <section className="card">
          <div className="section-title"><h2 style={{ fontSize: "1.2rem" }}>Upcoming jobs</h2><Link href="/dashboard/bookings" className="small">All bookings →</Link></div>
          {d.upcoming.length === 0 ? <p className="muted small" style={{ margin: 0 }}>No upcoming bookings yet.</p> : (
            <ul className="list">{d.upcoming.map((b) => <BookingRow key={b.id} b={b} tz={c.timezone} />)}</ul>
          )}
        </section>
        <section className="card">
          <div className="section-title"><h2 style={{ fontSize: "1.2rem" }}>Latest callers</h2><Link href="/dashboard/activity" className="small">All calls &amp; texts →</Link></div>
          {d.recent.length === 0 ? <p className="muted small" style={{ margin: 0 }}>Nobody has called your CallCairn line yet.</p> : (
            <ul className="list">{d.recent.map((r) => <ConversationItem key={r.conv.id} {...r} />)}</ul>
          )}
        </section>
      </div>
    </div>
  );
}
