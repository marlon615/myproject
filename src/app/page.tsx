import Link from "next/link";
import { Brand } from "@/components/Brand";
import { PRICE_MONTHLY_USD, TRIAL_DAYS } from "@/lib/config";

export default function Home() {
  return (
    <>
      <header className="site-header">
        <div className="container">
          <Brand />
          <nav className="nav">
            <Link href="/login">Log in</Link>
            <Link href="/signup" className="active">Start free trial</Link>
          </nav>
        </div>
      </header>

      <main>
        <section className="hero container">
          <span className="badge badge-accent" style={{ marginBottom: 16 }}>For small churches · Set up in 5 minutes</span>
          <h1>Every first-time guest gets a warm follow-up. You don&apos;t lift a finger.</h1>
          <p className="lead">
            Guests scan a QR code on a pew card, type their first name and phone number, and ChurchFollow takes it from there —
            a thank-you text within a minute, a check-in on day 3, and an invitation back on day 7.
          </p>
          <div className="row" style={{ justifyContent: "center" }}>
            <Link href="/signup" className="btn btn-primary btn-lg">Start your {TRIAL_DAYS}-day free trial</Link>
          </div>
          <p className="tiny muted" style={{ marginTop: 12 }}>No credit card to start · ${PRICE_MONTHLY_USD}/month after</p>
        </section>

        <section className="container" style={{ marginTop: 32 }}>
          <div className="grid grid-2" style={{ alignItems: "center" }}>
            <div className="stack">
              <h2>What your guests receive</h2>
              <ul className="timeline">
                <li><span className="when">1 minute</span><span><strong>Thank-you &amp; welcome pack.</strong> Your personal welcome, service times, and what to expect.</span></li>
                <li><span className="when">Day 3</span><span><strong>A gentle check-in.</strong> &ldquo;How was your visit? Anything we can pray about?&rdquo;</span></li>
                <li><span className="when">Day 7</span><span><strong>An invitation back.</strong> Service times and a link to save their seat.</span></li>
              </ul>
              <p className="muted small">Replies come straight to your dashboard so you can follow up personally.</p>
            </div>
            <div className="phone-mock" aria-label="Example text conversation">
              <div className="bubble">Hi Sarah! Thank you so much for visiting Grace Community Church today. We&apos;re really glad you came. 💛</div>
              <div className="bubble">&ldquo;We&apos;d love to get to know you. Coffee&apos;s on me next Sunday!&rdquo; – Pastor Mike</div>
              <div className="bubble-me bubble">Thank you! The kids loved it.</div>
              <div className="bubble">So glad to hear it! See you Sunday? ☀️</div>
            </div>
          </div>
        </section>

        <section className="container steps" style={{ marginTop: 56 }}>
          <h2 className="center">How it works</h2>
          <div className="grid grid-3" style={{ marginTop: 20 }}>
            <div className="card">
              <div className="step-num">1</div>
              <h3>Tell us about your church</h3>
              <p className="muted small">Service times, what to expect, and a personal welcome from you.</p>
            </div>
            <div className="card">
              <div className="step-num">2</div>
              <h3>Print your pew cards</h3>
              <p className="muted small">We generate your unique QR code and a ready-to-print card. Put them in the pews or the bulletin.</p>
            </div>
            <div className="card">
              <div className="step-num">3</div>
              <h3>Watch guests come back</h3>
              <p className="muted small">See visitors, replies, and returns on a simple dashboard. Mark guests as returned with one tap.</p>
            </div>
          </div>
        </section>

        <section className="container" style={{ marginTop: 56 }}>
          <div className="card card-pad-lg narrow" style={{ margin: "0 auto", textAlign: "center" }}>
            <h2>Simple pricing</h2>
            <div className="price" style={{ margin: "12px 0 4px" }}>${PRICE_MONTHLY_USD}<span className="muted" style={{ fontSize: "1rem", fontFamily: "var(--font-sans)" }}>/month</span></div>
            <p className="muted">after your {TRIAL_DAYS}-day free trial</p>
            <ul className="check-list" style={{ textAlign: "left", maxWidth: 320, margin: "0 auto 20px" }}>
              <li>Unlimited guests &amp; texts</li>
              <li>Custom QR code &amp; printable pew cards</li>
              <li>Automatic 3-step follow-up</li>
              <li>Pastor dashboard with replies &amp; returns</li>
              <li>Cancel anytime</li>
            </ul>
            <Link href="/signup" className="btn btn-primary btn-block">Start free trial</Link>
          </div>
        </section>
      </main>

      <footer className="site-footer">
        <div className="container row between">
          <span>© {new Date().getFullYear()} ChurchFollow</span>
          <span>Made with care for small churches.</span>
        </div>
      </footer>
    </>
  );
}
