import Link from "next/link";
import { paymentList, PAGE_SIZE, usd } from "@/lib/admin";
import { formatDateTime } from "@/lib/utils";
import { Pager } from "@/components/Badges";
import { ContractorFilter, uuidOrUndefined, pageNum, pageHref } from "@/components/admin/ContractorFilter";

const CLS: Record<string, string> = { completed: "badge-sent", failed: "badge-failed", refunded: "badge-skipped", reversed: "badge-failed" };

export default async function Payments({ searchParams }: { searchParams: Promise<{ c?: string; page?: string }> }) {
  const sp = await searchParams;
  const c = uuidOrUndefined(sp.c);
  const page = pageNum(sp.page);
  const { rows, total } = await paymentList(page, c);
  return (
    <div className="stack-lg">
      <div className="section-title"><h1 style={{ margin: 0 }}>Payments</h1><span className="muted small">Every PayPal payment, refund, reversal and failed charge</span></div>
      <ContractorFilter name={c ? rows[0]?.businessName ?? "This contractor" : null} base="/admin/payments" />
      <div className="card">
        {rows.length === 0 ? <p className="muted" style={{ margin: 0 }}>No payments yet. They appear here as PayPal sends webhooks.</p> : (
          <div className="table-wrap"><table>
            <thead><tr><th>When</th><th>Contractor</th><th className="num">Amount</th><th>Status</th><th>PayPal id</th><th>Subscription</th></tr></thead>
            <tbody>
              {rows.map(({ payment: p, businessName, contractorId }) => (
                <tr key={p.id}>
                  <td>{formatDateTime(p.occurredAt)}</td>
                  <td>{contractorId ? <Link href={`/admin/signups/${contractorId}`}>{businessName}</Link> : <span className="muted">Unmatched</span>}</td>
                  <td className="num">{usd(p.amountCents)}{p.currency !== "USD" ? ` ${p.currency}` : ""}</td>
                  <td><span className={`badge ${CLS[p.status] ?? "badge-skipped"}`}>{p.status}</span></td>
                  <td className="tiny">{p.paypalId}</td>
                  <td className="tiny">{p.subscriptionId ?? "—"}</td>
                </tr>
              ))}
            </tbody>
          </table></div>
        )}
        <Pager page={page} total={total} size={PAGE_SIZE} href={(p) => pageHref("/admin/payments", c, p)} />
      </div>
    </div>
  );
}
