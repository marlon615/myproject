import Link from "next/link";
import { KIND_LABELS } from "@/lib/messaging";
import { formatDateTime, formatPhone } from "@/lib/utils";

type Row = { id: string; kind: string; error: string | null; at: Date; churchId: string; churchName: string; guest: string; phone: string };

export function FailedList({ rows }: { rows: Row[] }) {
  if (rows.length === 0) return <p className="muted small" style={{ margin: 0 }}>No failed texts. 🎉</p>;
  return (
    <ul className="list">
      {rows.map((f) => (
        <li key={f.id}>
          <div className="list-main">
            <Link href={`/admin/churches/${f.churchId}`} className="list-title">{f.churchName}</Link>
            <span className="tiny muted" style={{ flex: "none" }}>{formatDateTime(f.at)}</span>
          </div>
          <div className="list-meta">{KIND_LABELS[f.kind] ?? f.kind} to {f.guest} · {formatPhone(f.phone)}</div>
          <div className="reason">{f.error ?? "No reason given"}</div>
        </li>
      ))}
    </ul>
  );
}
