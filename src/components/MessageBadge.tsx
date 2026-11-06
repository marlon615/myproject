import { KIND_LABELS } from "@/lib/messaging";
import { formatDate, formatDateTime } from "@/lib/utils";

type M = { kind: string; status: string; scheduledFor: Date; sentAt: Date | null; error: string | null };

const STATUS_TEXT: Record<string, string> = {
  scheduled: "Scheduled",
  sending: "Sending",
  sent: "Sent",
  failed: "Failed",
  skipped: "Skipped",
};

export function MessageBadge({ m, showKind = true }: { m: M; showKind?: boolean }) {
  const cls = m.status === "sending" ? "badge-scheduled" : `badge-${m.status}`;
  const title =
    m.status === "sent" ? `Sent ${formatDateTime(m.sentAt)}`
    : m.status === "scheduled" ? `Scheduled for ${formatDateTime(m.scheduledFor)}`
    : m.error ?? STATUS_TEXT[m.status];
  const suffix = m.status === "scheduled" ? ` ${formatDate(m.scheduledFor).replace(/, \d{4}$/, "")}` : "";
  return (
    <span className={`badge ${cls}`} title={title}>
      <span className="dot" />
      {showKind ? `${KIND_LABELS[m.kind] ?? m.kind}: ` : ""}
      {STATUS_TEXT[m.status] ?? m.status}
      {suffix}
    </span>
  );
}
