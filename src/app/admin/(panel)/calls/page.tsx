import Link from "next/link";
import { callList, PAGE_SIZE } from "@/lib/admin";
import { formatDateTime, formatPhone } from "@/lib/utils";
import { OutcomeBadge, UrgencyBadge, Pager } from "@/components/Badges";
import { ContractorFilter, uuidOrUndefined, pageNum, pageHref } from "@/components/admin/ContractorFilter";

export default async function Calls({ searchParams }: { searchParams: Promise<{ c?: string; page?: string }> }) {
  const sp = await searchParams;
  const c = uuidOrUndefined(sp.c);
  const page = pageNum(sp.page);
  const { rows, total } = await callList(page, c);
  return (
    <div className="stack-lg">
      <div className="section-title"><h1 style={{ margin: 0 }}>Calls</h1><span className="muted small">Every call to every CallCairn line</span></div>
      <ContractorFilter name={c ? rows[0]?.businessName ?? "This contractor" : null} base="/admin/calls" />
      <div className="card">
        {rows.length === 0 ? <p className="muted" style={{ margin: 0 }}>No calls yet.</p> : (
          <div className="table-wrap"><table>
            <thead><tr><th>When</th><th>Contractor</th><th>Caller</th><th>Issue</th><th>Outcome</th><th className="num">Length</th></tr></thead>
            <tbody>
              {rows.map(({ call, businessName, contractorId, urgency, issue, customerName }) => (
                <tr key={call.id}>
                  <td>{formatDateTime(call.startedAt)}</td>
                  <td><Link href={`/admin/signups/${contractorId}`}>{businessName}</Link></td>
                  <td>{customerName ?? "—"}<div className="tiny muted">{formatPhone(call.fromPhone)}</div></td>
                  <td>{issue ?? "—"} <UrgencyBadge urgency={urgency} />
                    {call.transcript.length > 0 && (
                      <details className="table-view"><summary>Transcript</summary>
                        <div className="transcript" style={{ marginTop: 6 }}>{call.transcript.map((l, i) => <div key={i} className={`msg ${l.role === "caller" ? "msg-in" : "msg-out"}`} style={{ maxWidth: "100%" }}>{l.text}</div>)}</div>
                      </details>
                    )}
                  </td>
                  <td><OutcomeBadge outcome={call.outcome} status={call.status} /></td>
                  <td className="num">{call.durationSec != null ? `${Math.floor(call.durationSec / 60)}:${String(call.durationSec % 60).padStart(2, "0")}` : "—"}</td>
                </tr>
              ))}
            </tbody>
          </table></div>
        )}
        <Pager page={page} total={total} size={PAGE_SIZE} href={(p) => pageHref("/admin/calls", c, p)} />
      </div>
    </div>
  );
}
