import { and, eq, gte } from "drizzle-orm";
import { db, bookings, contractors } from "@/db";
import { formatPhone } from "@/lib/utils";

/**
 * Read-only iCalendar feed of a contractor's bookings. Subscribe to it from Google Calendar,
 * Outlook or Apple Calendar ("add calendar from URL"); the URL's token is the only key.
 */
export async function GET(_req: Request, { params }: { params: Promise<{ token: string }> }) {
  const { token } = await params;
  const name = token.replace(/\.ics$/, "");
  if (!/^[A-Za-z0-9]{32}$/.test(name)) return new Response("Not found", { status: 404 });
  const [c] = await db.select().from(contractors).where(eq(contractors.calendarToken, name)).limit(1);
  if (!c) return new Response("Not found", { status: 404 });

  const rows = await db
    .select()
    .from(bookings)
    .where(and(eq(bookings.contractorId, c.id), gte(bookings.startsAt, new Date(Date.now() - 60 * 86400000))));

  const stamp = (d: Date) => d.toISOString().replace(/[-:]/g, "").replace(/\.\d{3}/, "");
  const esc = (s: string) => s.replace(/\\/g, "\\\\").replace(/;/g, "\;").replace(/,/g, "\\,").replace(/\r?\n/g, "\\n");
  // Lines over 75 octets must be folded (RFC 5545).
  const fold = (line: string) => line.match(/.{1,73}/g)!.join("\r\n ");

  const lines = [
    "BEGIN:VCALENDAR",
    "VERSION:2.0",
    "PRODID:-//CallCairn//Bookings//EN",
    "CALSCALE:GREGORIAN",
    "METHOD:PUBLISH",
    `X-WR-CALNAME:${esc(`${c.businessName} · CallCairn bookings`)}`,
    "X-PUBLISHED-TTL:PT15M",
    "REFRESH-INTERVAL;VALUE=DURATION:PT15M",
  ];
  for (const b of rows) {
    lines.push(
      "BEGIN:VEVENT",
      `UID:${b.id}@callcairn`,
      `DTSTAMP:${stamp(b.updatedAt)}`,
      `DTSTART:${stamp(b.startsAt)}`,
      `DTEND:${stamp(b.endsAt)}`,
      `SUMMARY:${esc(`${b.urgency === "emergency" ? "🚨 EMERGENCY · " : ""}${b.customerName} · ${b.issue}`)}`,
      `LOCATION:${esc(b.address)}`,
      `DESCRIPTION:${esc(`Caller: ${b.customerName} ${formatPhone(b.phone)}\nIssue: ${b.issue}\nBooked by CallCairn (${b.source === "voice" ? "phone call" : "text"}).`)}`,
      `STATUS:${b.status === "canceled" ? "CANCELLED" : "CONFIRMED"}`,
      "END:VEVENT",
    );
  }
  lines.push("END:VCALENDAR");
  return new Response(lines.map(fold).join("\r\n") + "\r\n", {
    headers: { "Content-Type": "text/calendar; charset=utf-8", "Cache-Control": "no-store" },
  });
}
