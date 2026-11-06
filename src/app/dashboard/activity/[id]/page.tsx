import { Fragment } from "react";
import { notFound } from "next/navigation";
import Link from "next/link";
import { requireContractor } from "@/lib/session";
import { conversationDetail } from "@/lib/dashboard";
import { formatPhone, formatDateTime, windowLabel } from "@/lib/utils";
import { KIND_LABELS } from "@/lib/messaging";
import { OutcomeBadge, TextStatusBadge, UrgencyBadge } from "@/components/Badges";

export default async function ConversationPage({ params }: { params: Promise<{ id: string }> }) {
  const c = await requireContractor();
  const d = await conversationDetail(c, (await params).id);
  if (!d) notFound();
  const { conv } = d;
  return (
    <div className="stack-lg" style={{ maxWidth: 760 }}>
      <Link href="/dashboard/activity" className="small">← All calls &amp; texts</Link>
      <div className="card">
        <div className="row between">
          <h1 style={{ margin: 0, fontSize: "1.5rem" }}>{conv.customerName ?? formatPhone(conv.phone)}</h1>
          <UrgencyBadge urgency={conv.urgency} />
        </div>
        {conv.hazard && <div className="alert alert-error" style={{ marginTop: 12 }}>Caller reported a safety hazard ({conv.hazard.replace("_", " ")}). They were told to get out and call 911 / the gas company.</div>}
        <dl className="dl" style={{ marginTop: 14 }}>
          <dt>Phone</dt><dd><a href={`tel:${conv.phone}`}>{formatPhone(conv.phone)}</a></dd>
          <dt>Issue</dt><dd>{conv.issue ?? "—"}</dd>
          <dt>Address</dt><dd>{conv.address ?? "—"}</dd>
          <dt>Status</dt><dd>{conv.status === "handoff" ? "Wants a call back" : conv.status}</dd>
          {d.bookings.map((b) => (<Fragment key={b.id}><dt>Booked</dt><dd>{windowLabel(b.startsAt, b.endsAt, c.timezone)}{b.status === "canceled" ? " (canceled)" : ""}</dd></Fragment>))}
        </dl>
      </div>

      {d.calls.map((call) => (
        <section key={call.id} className="card">
          <div className="section-title">
            <h2 style={{ fontSize: "1.1rem" }}>Call · {formatDateTime(call.startedAt)}{call.durationSec ? ` · ${Math.round(call.durationSec / 60) || "<1"} min` : ""}</h2>
            <OutcomeBadge outcome={call.outcome} status={call.status} />
          </div>
          <div className="thread">
            {call.transcript.map((l, i) => (
              <div key={i} className={`msg ${l.role === "caller" ? "msg-in" : "msg-out"}`}>{l.text}</div>
            ))}
          </div>
        </section>
      ))}

      {d.texts.length > 0 && (
        <section className="card">
          <h2 style={{ fontSize: "1.1rem" }}>Texts</h2>
          <div className="thread">
            {d.texts.map((t) => (
              <div key={t.id} style={{ display: "flex", flexDirection: "column", alignItems: t.direction === "inbound" ? "flex-start" : "flex-end" }}>
                <div className={`msg ${t.direction === "inbound" ? "msg-in" : "msg-out"}`}>{t.body}</div>
                <div className="msg-meta">{KIND_LABELS[t.kind] ?? t.kind}{t.kind === "alert" ? ` to ${formatPhone(t.phone)}` : ""} · {formatDateTime(t.createdAt)} <TextStatusBadge status={t.status} /></div>
              </div>
            ))}
          </div>
        </section>
      )}
    </div>
  );
}
