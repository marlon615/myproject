import type { Metadata } from "next";
import Link from "next/link";
import { requireContractor } from "@/lib/session";
import { bookingsFor } from "@/lib/dashboard";
import { BookingRow } from "@/components/BookingRow";

export const metadata: Metadata = { title: "Bookings" };

export default async function BookingsPage({ searchParams }: { searchParams: Promise<{ past?: string }> }) {
  const c = await requireContractor();
  const past = (await searchParams).past === "1";
  const rows = await bookingsFor(c, past ? "past" : "upcoming");
  return (
    <div className="stack-lg">
      <div className="row between">
        <h1 style={{ margin: 0 }}>Bookings</h1>
        <div className="chips">
          <Link href="/dashboard/bookings" className={`chip ${past ? "" : "active"}`}>Upcoming</Link>
          <Link href="/dashboard/bookings?past=1" className={`chip ${past ? "active" : ""}`}>Past</Link>
        </div>
      </div>
      <p className="muted small" style={{ margin: 0 }}>Every job the assistant books. These also appear in your calendar app through your <Link href="/dashboard/setup#calendar">calendar link</Link>. Canceling here frees the window; let the customer know.</p>
      <div className="card">
        {rows.length === 0 ? <p className="muted" style={{ margin: 0 }}>{past ? "No past bookings." : "No upcoming bookings."}</p> : (
          <ul className="list">{rows.map((b) => <BookingRow key={b.id} b={b} tz={c.timezone} canCancel={!past} />)}</ul>
        )}
      </div>
    </div>
  );
}
