import Link from "next/link";
import { textList, PAGE_SIZE } from "@/lib/admin";
import { formatDateTime, formatPhone } from "@/lib/utils";
import { KIND_LABELS } from "@/lib/messaging";
import { TextStatusBadge, Pager } from "@/components/Badges";
import { ContractorFilter, uuidOrUndefined, pageNum, pageHref } from "@/components/admin/ContractorFilter";

export default async function Texts({ searchParams }: { searchParams: Promise<{ c?: string; page?: string }> }) {
  const sp = await searchParams;
  const c = uuidOrUndefined(sp.c);
  const page = pageNum(sp.page);
  const { rows, total } = await textList(page, c);
  return (
    <div className="stack-lg">
      <div className="section-title"><h1 style={{ margin: 0 }}>Texts</h1><span className="muted small">Every text in and out, including alerts to contractors</span></div>
      <ContractorFilter name={c ? rows[0]?.businessName ?? "This contractor" : null} base="/admin/texts" />
      <div className="card">
        {rows.length === 0 ? <p className="muted" style={{ margin: 0 }}>No texts yet.</p> : (
          <div className="table-wrap"><table>
            <thead><tr><th>When</th><th>Contractor</th><th>Direction</th><th>Type</th><th>Message</th><th>Status</th></tr></thead>
            <tbody>
              {rows.map(({ text: t, businessName, contractorId }) => (
                <tr key={t.id}>
                  <td>{formatDateTime(t.createdAt)}</td>
                  <td><Link href={`/admin/signups/${contractorId}`}>{businessName}</Link></td>
                  <td>{t.direction === "inbound" ? "From" : "To"} {formatPhone(t.phone)}</td>
                  <td>{KIND_LABELS[t.kind] ?? t.kind}</td>
                  <td style={{ minWidth: 260, whiteSpace: "pre-line" }}>{t.body}{t.error && <div className="reason">{t.error}</div>}</td>
                  <td><TextStatusBadge status={t.status} /></td>
                </tr>
              ))}
            </tbody>
          </table></div>
        )}
        <Pager page={page} total={total} size={PAGE_SIZE} href={(p) => pageHref("/admin/texts", c, p)} />
      </div>
    </div>
  );
}
