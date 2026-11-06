import Link from "next/link";
import { signupList, STATUS_FILTERS, STATUS_BADGE, timeAgo, type StatusFilter } from "@/lib/admin";
import { formatDate, formatPhone } from "@/lib/utils";

export default async function Signups({ searchParams }: { searchParams: Promise<{ q?: string; status?: string }> }) {
  const sp = await searchParams;
  const q = sp.q ?? "";
  const filter = (STATUS_FILTERS.some((f) => f.key === sp.status) ? sp.status : "all") as StatusFilter;
  const { rows, counts } = await signupList(q, filter);
  const href = (status: string) => `/admin/signups?${new URLSearchParams({ ...(q && { q }), ...(status !== "all" && { status }) })}`;
  return (
    <div className="stack-lg">
      <div className="section-title"><h1 style={{ margin: 0 }}>Signups</h1><span className="muted small">{counts.all} total</span></div>
      <form className="searchbar" action="/admin/signups">
        <input type="search" name="q" defaultValue={q} placeholder="Search company, owner, email, phone, area" />
        {filter !== "all" && <input type="hidden" name="status" value={filter} />}
        <button className="btn btn-secondary btn-sm">Search</button>
      </form>
      <div className="chips">
        {STATUS_FILTERS.map((f) => (
          <Link key={f.key} href={href(f.key)} className={`chip ${filter === f.key ? "active" : ""}`}>{f.label} <span className="count">{counts[f.key]}</span></Link>
        ))}
      </div>
      <div className="card">
        {rows.length === 0 ? <p className="muted" style={{ margin: 0 }}>No signups match.</p> : (
          <div className="table-wrap"><table>
            <thead><tr><th>Company</th><th>Contact</th><th>Status</th><th>CallCairn #</th><th className="num">Calls</th><th className="num">Bookings</th><th>Signed up</th><th>Last call</th></tr></thead>
            <tbody>
              {rows.map(({ c, group, calls, bookings, lastCall }) => (
                <tr key={c.id}>
                  <td><Link href={`/admin/signups/${c.id}`} className="list-title">{c.businessName}</Link><div className="tiny muted">{c.serviceArea ?? ""}</div></td>
                  <td>{c.ownerName}<div className="tiny"><a href={`mailto:${c.email}`}>{c.email}</a></div><div className="tiny muted">{formatPhone(c.businessPhone)}</div></td>
                  <td><span className={`badge ${STATUS_BADGE[group].cls}`}>{STATUS_BADGE[group].label}</span></td>
                  <td>{c.aiNumber ? formatPhone(c.aiNumber) : <span className="muted">—</span>}</td>
                  <td className="num">{calls}</td>
                  <td className="num">{bookings}</td>
                  <td>{formatDate(c.createdAt)}</td>
                  <td>{timeAgo(lastCall)}</td>
                </tr>
              ))}
            </tbody>
          </table></div>
        )}
      </div>
    </div>
  );
}
