import Link from "next/link";
import { notFound } from "next/navigation";
import { signupDetail, STATUS_BADGE, usd, timeAgo } from "@/lib/admin";
import { planLabel } from "@/lib/billing";
import { formatDate, formatDateTime, formatPhone, windowLabel } from "@/lib/utils";
import { adminSetNumber } from "@/app/actions/admin";
import { OutcomeBadge, UrgencyBadge } from "@/components/Badges";

const MSG: Record<string, string> = { number: "That isn't a valid US number.", taken: "That number is already assigned to another contractor." };

export default async function SignupDetail({ params, searchParams }: { params: Promise<{ id: string }>; searchParams: Promise<{ saved?: string; error?: string }> }) {
  const { id } = await params;
  const sp = await searchParams;
  if (!/^[0-9a-f-]{36}$/i.test(id)) notFound();
  const d = await signupDetail(id);
  if (!d) notFound();
  const { c } = d;
  const tab = (path: string) => `${path}?c=${c.id}`;
  return (
    <div className="stack-lg">
      <Link href="/admin/signups" className="small">← All signups</Link>
      <div className="row between">
        <h1 style={{ margin: 0 }}>{c.businessName}</h1>
        <span className={`badge ${STATUS_BADGE[d.group].cls}`}>{STATUS_BADGE[d.group].label}</span>
      </div>
      {sp.saved && <div className="alert alert-success">Saved.</div>}
      {sp.error && MSG[sp.error] && <div className="alert alert-error">{MSG[sp.error]}</div>}
      <div className="kpis">
        <Link href={tab("/admin/calls")} className="card card-flat"><div className="kpi-value">{d.stats.calls}</div><div className="kpi-label">Calls</div></Link>
        <Link href={tab("/admin/texts")} className="card card-flat"><div className="kpi-value">{d.stats.texts}</div><div className="kpi-label">Texts</div></Link>
        <Link href={tab("/admin/bookings")} className="card card-flat"><div className="kpi-value">{d.stats.bookings}</div><div className="kpi-label">Bookings</div></Link>
        <Link href={tab("/admin/payments")} className="card card-flat"><div className="kpi-value">{usd(d.stats.paidCents)}</div><div className="kpi-label">Paid</div></Link>
      </div>
      <div className="grid grid-2" style={{ alignItems: "start" }}>
        <section className="card">
          <h3>Account</h3>
          <dl className="dl">
            <dt>Owner</dt><dd>{c.ownerName}</dd>
            <dt>Email</dt><dd><a href={`mailto:${c.email}`}>{c.email}</a></dd>
            <dt>Business phone</dt><dd>{formatPhone(c.businessPhone)}</dd>
            <dt>On-call phone</dt><dd>{formatPhone(c.alertPhone)}</dd>
            <dt>Service area</dt><dd>{c.serviceArea ?? "—"}</dd>
            <dt>Hours</dt><dd>{c.hoursStart}:00–{c.hoursEnd}:00 · days {c.workDays} · {c.timezone}</dd>
            <dt>Plan</dt><dd>{planLabel(d.plan)}</dd>
            <dt>Pilot ends</dt><dd>{formatDate(c.trialEndsAt)}</dd>
            <dt>PayPal sub</dt><dd>{c.paypalSubscriptionId ?? "—"}</dd>
            <dt>Signed up</dt><dd>{formatDateTime(c.createdAt)}</dd>
            <dt>Last seen</dt><dd>{timeAgo(c.lastSeenAt)}</dd>
          </dl>
        </section>
        <section className="card">
          <h3>CallCairn number</h3>
          <p className="muted small">Bought from the dashboard, or set by hand if you bought it in Twilio (point its voice URL at /api/voice/incoming, status callback at /api/voice/status, and messaging at /api/sms/inbound).</p>
          <form action={adminSetNumber} className="searchbar">
            <input type="hidden" name="id" value={c.id} />
            <input type="tel" name="aiNumber" defaultValue={c.aiNumber ? formatPhone(c.aiNumber) : ""} placeholder="(555) 555-0123" />
            <button className="btn btn-secondary btn-sm">Save</button>
          </form>
        </section>
      </div>
      <section className="card">
        <div className="section-title"><h3 style={{ margin: 0 }}>Recent calls</h3><Link href={tab("/admin/calls")} className="small">All →</Link></div>
        {d.recentCalls.length === 0 ? <p className="muted small" style={{ margin: 0 }}>No calls yet.</p> : (
          <ul className="list">{d.recentCalls.map(({ call, urgency, issue, customerName }) => (
            <li key={call.id}><div className="list-main"><span className="list-title">{customerName ?? formatPhone(call.fromPhone)}</span><span className="row" style={{ gap: 6 }}><UrgencyBadge urgency={urgency} /><OutcomeBadge outcome={call.outcome} status={call.status} /></span></div>
              <div className="list-meta">{issue ?? "—"} · {formatDateTime(call.startedAt)}</div></li>))}</ul>
        )}
      </section>
      <section className="card">
        <div className="section-title"><h3 style={{ margin: 0 }}>Recent bookings</h3><Link href={tab("/admin/bookings")} className="small">All →</Link></div>
        {d.recentBookings.length === 0 ? <p className="muted small" style={{ margin: 0 }}>No bookings yet.</p> : (
          <ul className="list">{d.recentBookings.map(({ booking: b }) => (
            <li key={b.id}><div className="list-main"><span className="list-title">{windowLabel(b.startsAt, b.endsAt, c.timezone)}</span><UrgencyBadge urgency={b.urgency} /></div>
              <div className="list-meta">{b.customerName} · {b.issue} · {b.status}</div></li>))}</ul>
        )}
      </section>
    </div>
  );
}
