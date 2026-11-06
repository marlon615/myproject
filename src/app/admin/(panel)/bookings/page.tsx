import Link from "next/link";
import { bookingList, PAGE_SIZE } from "@/lib/admin";
import { formatDateTime, formatPhone, windowLabel } from "@/lib/utils";
import { UrgencyBadge, Pager } from "@/components/Badges";
import { ContractorFilter, uuidOrUndefined, pageNum, pageHref } from "@/components/admin/ContractorFilter";

export default async function Bookings({ searchParams }: { searchParams: Promise<{ c?: string; page?: string }> }) {
  const sp = await searchParams;
  const c = uuidOrUndefined(sp.c);
  const page = pageNum(sp.page);
  const { rows, total } = await bookingList(page, c);
  return (
    <div className="stack-lg">
      <div className="section-title"><h1 style={{ margin: 0 }}>Bookings</h1><span className="muted small">Every job booked, newest first</span></div>
      <ContractorFilter name={c ? rows[0]?.businessName ?? "This contractor" : null} base="/admin/bookings" />
      <div className="card">
        {rows.length === 0 ? <p className="muted" style={{ margin: 0 }}>No bookings yet.</p> : (
          <div className="table-wrap"><table>
            <thead><tr><th>Booked</th><th>Contractor</th><th>Window</th><th>Customer</th><th>Issue</th><th>Status</th></tr></thead>
            <tbody>
              {rows.map(({ booking: b, businessName, contractorId, timezone }) => (
                <tr key={b.id}>
                  <td>{formatDateTime(b.createdAt)}<div className="tiny muted">by {b.source === "voice" ? "call" : "text"}</div></td>
                  <td><Link href={`/admin/signups/${contractorId}`}>{businessName}</Link></td>
                  <td>{windowLabel(b.startsAt, b.endsAt, timezone)}</td>
                  <td>{b.customerName}<div className="tiny muted">{formatPhone(b.phone)} · {b.address}</div></td>
                  <td>{b.issue} <UrgencyBadge urgency={b.urgency} /></td>
                  <td><span className={`badge ${b.status === "booked" ? "badge-sent" : "badge-skipped"}`}>{b.status}</span></td>
                </tr>
              ))}
            </tbody>
          </table></div>
        )}
        <Pager page={page} total={total} size={PAGE_SIZE} href={(p) => pageHref("/admin/bookings", c, p)} />
      </div>
    </div>
  );
}
