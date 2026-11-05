import Link from "next/link";
import { notFound } from "next/navigation";
import type { Metadata } from "next";
import { and, asc, eq } from "drizzle-orm";
import { db, visitors, messages } from "@/db";
import { requireChurch } from "@/lib/session";
import { formatDate, formatDateTime, formatPhone } from "@/lib/utils";
import { KIND_LABELS } from "@/lib/messaging";
import { MessageBadge } from "@/components/MessageBadge";
import { ReturnedButton } from "@/components/ReturnedButton";

export const metadata: Metadata = { title: "Guest" };

const UUID = /^[0-9a-f-]{36}$/i;

export default async function GuestDetail({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  if (!UUID.test(id)) notFound();
  const church = await requireChurch();
  const [guest] = await db.select().from(visitors).where(and(eq(visitors.id, id), eq(visitors.churchId, church.id))).limit(1);
  if (!guest) notFound();
  const thread = await db.select().from(messages).where(eq(messages.visitorId, guest.id)).orderBy(asc(messages.scheduledFor));

  return (
    <div className="stack-lg">
      <Link href="/dashboard" className="small">← All guests</Link>
      <div className="card row between">
        <div>
          <h1 style={{ marginBottom: 2 }}>{guest.firstName}</h1>
          <div className="muted small">
            <a href={`sms:${guest.phone}`}>{formatPhone(guest.phone)}</a> · First visit {formatDate(guest.createdAt)}
            {guest.returnedAt && <> · Returned {formatDate(guest.returnedAt)}</>}
            {guest.optedOut && <> · <strong>Opted out of texts</strong></>}
          </div>
        </div>
        <div className="row">
          <a href={`sms:${guest.phone}`} className="btn btn-secondary btn-sm">Text personally</a>
          <ReturnedButton visitorId={guest.id} returned={!!guest.returnedAt} />
        </div>
      </div>

      <div className="card">
        <h2>Messages</h2>
        <div className="thread" style={{ marginTop: 12 }}>
          {thread.map((m) =>
            m.direction === "inbound" ? (
              <div key={m.id} className="msg msg-in">
                {m.body}
                <div className="msg-meta">{m.kind === "reply" ? `${guest.firstName} replied` : KIND_LABELS[m.kind]} · {formatDateTime(m.createdAt)}</div>
              </div>
            ) : (
              <div key={m.id} className="msg msg-out" style={{ opacity: m.status === "scheduled" ? 0.7 : 1 }}>
                {m.body}
                <div className="msg-meta">
                  <MessageBadge m={m} />
                  {m.status === "sent" && <span>{formatDateTime(m.sentAt)}</span>}
                  {m.status === "scheduled" && <span>{formatDateTime(m.scheduledFor)}</span>}
                  {(m.status === "failed" || m.status === "skipped") && m.error && <span>{m.error}</span>}
                </div>
              </div>
            ),
          )}
        </div>
      </div>
    </div>
  );
}
