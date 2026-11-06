import { OUTCOME_LABEL } from "@/lib/outcomes";

export function UrgencyBadge({ urgency }: { urgency: string | null | undefined }) {
  if (urgency === "emergency") return <span className="badge badge-emergency">Emergency</span>;
  if (urgency === "routine") return <span className="badge">Routine</span>;
  return null;
}

export function OutcomeBadge({ outcome, status }: { outcome: string | null; status?: string }) {
  const o = outcome ? OUTCOME_LABEL[outcome] : null;
  if (!o) return <span className="badge badge-scheduled">{status === "in-progress" ? "In progress" : "Open"}</span>;
  return <span className={`badge ${o.cls}`}>{o.label}</span>;
}

export function TextStatusBadge({ status }: { status: string }) {
  const cls = status === "sent" ? "badge-sent" : status === "failed" ? "badge-failed" : status === "received" ? "badge-accent" : "badge-skipped";
  return <span className={`badge ${cls}`}><span className="dot" />{status[0].toUpperCase() + status.slice(1)}</span>;
}

export function Pager({ page, total, size, href }: { page: number; total: number; size: number; href: (p: number) => string }) {
  const pages = Math.max(1, Math.ceil(total / size));
  return (
    <div className="pager">
      <span>{total.toLocaleString("en-US")} total · page {page} of {pages}</span>
      <span className="row" style={{ gap: 6 }}>
        {page > 1 && <a className="btn btn-secondary btn-sm" href={href(page - 1)}>← Newer</a>}
        {page < pages && <a className="btn btn-secondary btn-sm" href={href(page + 1)}>Older →</a>}
      </span>
    </div>
  );
}
