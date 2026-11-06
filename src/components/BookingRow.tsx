import Link from "next/link";
import type { Booking } from "@/db";
import { formatPhone, windowLabel } from "@/lib/utils";
import { UrgencyBadge } from "@/components/Badges";
import { cancelBooking } from "@/app/actions/auth";

export function BookingRow({ b, tz, canCancel = false }: { b: Booking; tz: string; canCancel?: boolean }) {
  return (
    <li>
      <div className="list-main">
        <div>
          <div className="list-title">{windowLabel(b.startsAt, b.endsAt, tz)}</div>
          <div className="list-meta">{b.customerName} · <a href={`tel:${b.phone}`}>{formatPhone(b.phone)}</a> · {b.address}</div>
        </div>
        <span className="row" style={{ gap: 6, flex: "none" }}>
          <UrgencyBadge urgency={b.urgency} />
          {b.status === "canceled" && <span className="badge badge-skipped">Canceled</span>}
        </span>
      </div>
      <div className="metrics">
        <span>{b.issue}</span>
        <span>Booked by {b.source === "voice" ? "phone" : "text"}</span>
        {b.conversationId && <Link href={`/dashboard/activity/${b.conversationId}`}>Conversation →</Link>}
        {canCancel && b.status === "booked" && (
          <form action={cancelBooking} style={{ display: "inline" }}>
            <input type="hidden" name="id" value={b.id} />
            <button className="btn btn-ghost btn-sm" style={{ minHeight: 0, padding: "0 6px" }}>Cancel</button>
          </form>
        )}
      </div>
    </li>
  );
}
