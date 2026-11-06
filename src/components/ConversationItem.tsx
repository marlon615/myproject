import Link from "next/link";
import type { Conversation } from "@/db";
import { formatPhone, formatDateTime } from "@/lib/utils";
import { UrgencyBadge } from "@/components/Badges";

const STATUS: Record<string, { label: string; cls: string }> = {
  open: { label: "In progress", cls: "badge-scheduled" },
  booked: { label: "Booked", cls: "badge-sent" },
  handoff: { label: "Call them back", cls: "badge-failed" },
  closed: { label: "Closed", cls: "badge-skipped" },
};

export function ConversationItem({ conv, calls, texts }: { conv: Conversation; calls: number; texts: number }) {
  const s = STATUS[conv.status] ?? STATUS.open;
  return (
    <li>
      <div className="list-main">
        <Link href={`/dashboard/activity/${conv.id}`} className="list-title">{conv.customerName ?? formatPhone(conv.phone)}</Link>
        <span className="row" style={{ gap: 6, flex: "none" }}>
          <UrgencyBadge urgency={conv.urgency} />
          <span className={`badge ${s.cls}`}>{conv.hazard ? "Safety alert" : s.label}</span>
        </span>
      </div>
      <div className="list-meta">{conv.issue ?? "No details yet"}</div>
      <div className="metrics">
        <span>{formatPhone(conv.phone)}</span>
        <span>{calls} call{calls === 1 ? "" : "s"} · {texts} text{texts === 1 ? "" : "s"}</span>
        <span>{formatDateTime(conv.lastActivityAt)}</span>
      </div>
    </li>
  );
}
