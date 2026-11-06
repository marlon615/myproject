import type { Metadata } from "next";
import { requireChurch } from "@/lib/session";
import { appUrl } from "@/lib/config";
import { qrSvg } from "@/lib/qr";
import { CopyField } from "@/components/CopyField";

export const metadata: Metadata = { title: "QR & pew cards" };

export default async function SharePage({ searchParams }: { searchParams: Promise<{ welcome?: string }> }) {
  const church = await requireChurch();
  const { welcome } = await searchParams;
  const guestUrl = `${await appUrl()}/g/${church.slug}`;
  const svg = await qrSvg(guestUrl);

  return (
    <div className="stack-lg">
      {welcome && (
        <div className="alert alert-success">
          <strong>Welcome to ChurchFollow, {church.pastorName}!</strong> Your church is set up and your 7-day free trial has started.
          Print your pew cards below and you&apos;re ready for Sunday.
        </div>
      )}
      <div>
        <h1 style={{ marginBottom: 4 }}>Your QR code &amp; pew cards</h1>
        <p className="muted" style={{ margin: 0 }}>Guests scan this with their phone camera — no app needed.</p>
      </div>

      <div className="grid grid-2">
        <div className="card center">
          <div className="qr-box" dangerouslySetInnerHTML={{ __html: svg }} />
          <p className="small muted" style={{ marginTop: 12 }}>Unique to {church.name}</p>
          <div className="row" style={{ justifyContent: "center" }}>
            <a href="/api/pew-card" className="btn btn-primary">Download pew cards (PDF)</a>
            <a href={`/api/qr/${church.slug}?download=1`} className="btn btn-secondary">QR image (PNG)</a>
          </div>
        </div>

        <div className="stack">
          <div className="card">
            <h3>Your guest page link</h3>
            <p className="small muted">Share it anywhere — bulletin, slides, website, social media.</p>
            <CopyField value={guestUrl} />
            <p className="small" style={{ marginTop: 12, marginBottom: 0 }}>
              <a href={guestUrl} target="_blank" rel="noreferrer">Preview what guests see →</a>
            </p>
          </div>
          <div className="card">
            <h3>Printing tips</h3>
            <ul className="small muted" style={{ paddingLeft: 18, margin: 0 }}>
              <li>The PDF prints 4 cards per letter-size sheet — cut along the dotted lines.</li>
              <li>Cardstock (65–110 lb) holds up best in pew racks.</li>
              <li>Mention it from the stage: &ldquo;If you&apos;re new, scan the card in front of you to say hi!&rdquo;</li>
              <li>Put the QR on a welcome slide before and after the service.</li>
            </ul>
          </div>
        </div>
      </div>
    </div>
  );
}
