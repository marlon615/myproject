import type { Metadata } from "next";
import { requireContractor } from "@/lib/session";
import { appUrl } from "@/lib/config";
import { formatPhone } from "@/lib/utils";
import { canProvisionNumbers } from "@/lib/twilio-numbers";
import { getNumber, rotateCalendarLink } from "@/app/actions/auth";
import { SubmitButton } from "@/components/SubmitButton";
import { CopyField } from "@/components/CopyField";

export const metadata: Metadata = { title: "Setup" };

type Search = { welcome?: string; number?: string; error?: string };
const ERRORS: Record<string, string> = {
  not_configured: "Number setup isn't switched on yet. The CallCairn team will assign your number shortly.",
  provision_failed: "We couldn't get a number just now. Please try again in a minute.",
};

export default async function SetupPage({ searchParams }: { searchParams: Promise<Search> }) {
  const c = await requireContractor();
  const q = await searchParams;
  const base = await appUrl();
  const ics = `${base}/api/calendar/${c.calendarToken}.ics`;
  const webcal = ics.replace(/^https?:/, "webcal:");
  const google = `https://calendar.google.com/calendar/r?cid=${encodeURIComponent(webcal)}`;
  const digits = c.aiNumber?.replace(/^\+1/, "") ?? "";

  return (
    <div className="stack-lg" style={{ maxWidth: 760 }}>
      <div>
        <h1 style={{ marginBottom: 4 }}>Setup</h1>
        <p className="muted" style={{ margin: 0 }}>Three steps and the assistant starts answering the calls you miss.</p>
      </div>
      {q.welcome && <div className="alert alert-success">Welcome to CallCairn! Your one-week free pilot has started.</div>}
      {q.number && <div className="alert alert-success">Your CallCairn number is ready: <strong>{formatPhone(c.aiNumber ?? "")}</strong>.</div>}
      {q.error && ERRORS[q.error] && <div className="alert alert-error">{ERRORS[q.error]}</div>}

      <section className="card">
        <h2 style={{ fontSize: "1.2rem" }}>1. Your CallCairn number</h2>
        {c.aiNumber ? (
          <>
            <div className="big-number">{formatPhone(c.aiNumber)}</div>
            <p className="muted small">Call or text it from your cell to try the assistant yourself. It always introduces itself as an automated assistant.</p>
          </>
        ) : (
          <>
            <p className="muted small">A local US number (in your area code when available) that answers with the AI assistant.</p>
            {canProvisionNumbers() ? (
              <form action={getNumber}><SubmitButton pendingText="Getting your number…">Get my CallCairn number</SubmitButton></form>
            ) : (
              <p className="small" style={{ margin: 0 }}>Your number will be assigned by the CallCairn team. You&apos;ll see it here.</p>
            )}
          </>
        )}
      </section>

      <section className="card">
        <h2 style={{ fontSize: "1.2rem" }}>2. Forward calls you can&apos;t answer</h2>
        <p className="muted small">Keep your business number. Turn on <strong>conditional call forwarding</strong> (no answer, busy, unreachable) to your CallCairn number. Your customers never see a different number.</p>
        <ul className="small" style={{ paddingLeft: 18 }}>
          <li><strong>Verizon, AT&amp;T, T-Mobile cell phones:</strong> dial <code className="inline">*71{digits || "XXXXXXXXXX"}</code> (Verizon) or <code className="inline">**004*1{digits || "XXXXXXXXXX"}#</code> (AT&amp;T / T-Mobile) and press call.</li>
          <li><strong>Office or VoIP line</strong> (RingCentral, Google Voice, Grasshopper, Comcast, Spectrum…): in its settings, set &ldquo;forward when unanswered&rdquo; and &ldquo;after hours&rdquo; to {c.aiNumber ? formatPhone(c.aiNumber) : "your CallCairn number"}.</li>
          <li>Want every call answered after hours? Forward <em>all</em> calls during closed hours (most VoIP systems have a schedule for this).</li>
        </ul>
        <p className="muted tiny" style={{ margin: 0 }}>Carrier codes vary; if one doesn&apos;t work, your carrier&apos;s support page for &ldquo;conditional call forwarding&rdquo; has the right code.</p>
      </section>

      <section className="card" id="calendar">
        <h2 style={{ fontSize: "1.2rem" }}>3. Put bookings on your calendar</h2>
        <p className="muted small">Your private calendar link. Anyone with it can see your bookings, so don&apos;t share it.</p>
        <CopyField value={ics} label="Calendar link" />
        <div className="row" style={{ marginTop: 12 }}>
          <a className="btn btn-secondary btn-sm" href={google} target="_blank" rel="noreferrer">Add to Google Calendar</a>
          <a className="btn btn-secondary btn-sm" href={webcal}>Add to Apple / Outlook</a>
        </div>
        <p className="muted tiny" style={{ marginTop: 12 }}>
          Google Calendar refreshes subscribed calendars every few hours, so for instant notice CallCairn also texts {formatPhone(c.alertPhone)} for every booking. Outlook: Add calendar → Subscribe from web → paste the link.
        </p>
        <form action={rotateCalendarLink}><button className="btn btn-ghost btn-sm">Reset link (old one stops working)</button></form>
      </section>
    </div>
  );
}
