import Link from "next/link";
import { Brand } from "@/components/Brand";
import { PhoneIcon, MessageIcon, AlertIcon, CalendarIcon, MoonIcon, BotIcon } from "@/components/Icons";
import { PRICE_MONTHLY_USD, TRIAL_DAYS, TAGLINE, PUBLIC_PHONE_E164 } from "@/lib/config";
import { formatPhone } from "@/lib/utils";

export default function Home() {
  const phone = formatPhone(PUBLIC_PHONE_E164);
  return (
    <>
      <header className="site-header">
        <div className="container">
          <Brand />
          <nav className="nav">
            <a href="#pricing">Pricing</a>
            <Link href="/login">Log in</Link>
            <Link href="/signup" className="active">Start free pilot</Link>
          </nav>
        </div>
      </header>

      <main>
        <section className="hero hero-dark">
          <div className="container">
            <span className="tagline">For US heating &amp; cooling contractors</span>
            <h1>{TAGLINE}</h1>
            <p className="lead">
              CallCairn picks up the calls you can&apos;t: on a roof, under a house, or after hours. Its AI assistant answers, texts
              callers back, sorts emergencies from routine work, and books the job onto your calendar.
            </p>
            <div className="row" style={{ justifyContent: "center" }}>
              <Link href="/signup" className="btn btn-primary btn-lg">Start your {TRIAL_DAYS}-day free pilot</Link>
              <a href={`tel:${PUBLIC_PHONE_E164}`} className="hero-phone"><PhoneIcon /> Call us: {phone}</a>
            </div>
            <p className="tiny" style={{ marginTop: 14 }}>One week free, no payment details to start · then ${PRICE_MONTHLY_USD}/month in US dollars · cancel anytime</p>
          </div>
        </section>

        <section className="container" style={{ marginTop: 48 }}>
          <div className="grid grid-2" style={{ alignItems: "center" }}>
            <div className="stack">
              <h2>A missed call is a job for the next company on Google.</h2>
              <p className="muted">
                Homeowners with no heat don&apos;t leave voicemails. They call the next number. CallCairn answers every missed and
                after-hours call in seconds, gets the details, and puts the customer on your schedule before they hang up.
              </p>
              <ul className="check-list">
                <li>Answers calls your team misses, 24/7, including nights and weekends</li>
                <li>Texts back anyone who hangs up, so the lead isn&apos;t lost</li>
                <li>Flags emergencies (no heat, no AC with someone vulnerable, leaks) and texts your on-call tech right away</li>
                <li>Books routine work into open windows on your calendar</li>
                <li>Always tells callers it&apos;s an automated assistant, never pretends to be a person</li>
              </ul>
            </div>
            <div className="call-mock" aria-label="Example call">
              <div className="who">CallCairn · 9:47 PM</div>
              <div className="ai">Hi, thanks for calling Summit Heating &amp; Air. I&apos;m an automated assistant, not a person, and I can get you on the schedule. What&apos;s going on with your heating or cooling?</div>
              <div className="who" style={{ textAlign: "right" }}>Caller</div>
              <div className="caller">Furnace quit and it&apos;s 19 degrees out. I&apos;ve got a newborn at home.</div>
              <div className="who">CallCairn</div>
              <div className="ai">That sounds urgent, I&apos;ll get you in as fast as possible. What&apos;s your name?</div>
              <div className="who">…</div>
              <div className="ai">The soonest we can get a technician to you is tonight, between 10:30 PM and 12:30 AM. Should I book that?</div>
              <div className="caller">Yes please.</div>
              <div className="sys">✓ Emergency booked · on-call tech texted · confirmation texted to caller</div>
            </div>
          </div>
        </section>

        <section className="container" style={{ marginTop: 56 }}>
          <h2 className="center">What CallCairn does</h2>
          <div className="grid grid-3" style={{ marginTop: 20 }}>
            <div className="card"><div className="feature-icon"><PhoneIcon /></div><h3>Answers missed calls</h3><p className="muted small">Forward no-answer and busy calls from your business line. The assistant picks up on the first ring.</p></div>
            <div className="card"><div className="feature-icon"><MoonIcon /></div><h3>Covers after hours</h3><p className="muted small">Nights, weekends and holidays. Set your hours and whether you dispatch emergencies after hours.</p></div>
            <div className="card"><div className="feature-icon"><MessageIcon /></div><h3>Texts callers back</h3><p className="muted small">Hung up or got cut off? CallCairn texts them and finishes booking by text.</p></div>
            <div className="card"><div className="feature-icon"><AlertIcon /></div><h3>Emergency vs. routine</h3><p className="muted small">Emergencies get the soonest window and an instant text to your on-call phone. Gas or CO? Callers get safety steps and you get an alert.</p></div>
            <div className="card"><div className="feature-icon"><CalendarIcon /></div><h3>Books the job</h3><p className="muted small">Offers real open windows and books them. Jobs show up in Google Calendar, Outlook or Apple Calendar.</p></div>
            <div className="card"><div className="feature-icon"><BotIcon /></div><h3>Honest by design</h3><p className="muted small">Every call and every text says it&apos;s an automated assistant. Callers can ask for a person anytime and you&apos;ll get the callback request.</p></div>
          </div>
        </section>

        <section className="container" style={{ marginTop: 56 }}>
          <div className="card card-pad-lg">
            <h2>Live in 10 minutes</h2>
            <ol className="steps-list" style={{ marginTop: 16 }}>
              <li><strong>Sign up</strong> and tell us your hours, service area and on-call phone.</li>
              <li><strong>Get your CallCairn number</strong>: a local US number, set up in one click.</li>
              <li><strong>Turn on call forwarding</strong> on your business line for unanswered and busy calls. Your carrier&apos;s setting takes a minute; we show you how.</li>
              <li><strong>Add the calendar link</strong> to Google Calendar, Outlook or Apple Calendar. Done.</li>
            </ol>
          </div>
        </section>

        <section id="pricing" className="container" style={{ marginTop: 56 }}>
          <div className="card card-pad-lg narrow" style={{ margin: "0 auto", textAlign: "center" }}>
            <h2>One plan. US dollars.</h2>
            <div className="price" style={{ margin: "12px 0 4px" }}>${PRICE_MONTHLY_USD}<span className="muted" style={{ fontSize: "1rem", fontFamily: "var(--font-sans)" }}>/month</span></div>
            <p className="muted">after a one-week free pilot</p>
            <ul className="check-list" style={{ textAlign: "left", maxWidth: 340, margin: "0 auto 20px" }}>
              <li>Your own local CallCairn number</li>
              <li>Missed-call and after-hours answering</li>
              <li>Automatic text-back and booking by text</li>
              <li>Emergency triage with on-call alerts</li>
              <li>Calendar booking and next-day reminders</li>
              <li>Pay with PayPal. Cancel anytime.</li>
            </ul>
            <Link href="/signup" className="btn btn-primary btn-block btn-lg">Start the free pilot</Link>
            <p className="tiny muted" style={{ marginTop: 10, marginBottom: 0 }}>No payment details needed to start. Subscribe with PayPal any time during the pilot; your first charge is the day it ends.</p>
          </div>
        </section>

        <section className="container narrow faq" style={{ marginTop: 56, maxWidth: 720 }}>
          <h2 className="center">Questions</h2>
          <div className="card">
            <details><summary>Will callers think they&apos;re talking to a person?</summary><p>No. CallCairn always introduces itself as an automated assistant, answers truthfully if asked, and every text it sends says so. Callers can ask for a person and you&apos;ll get a callback request right away.</p></details>
            <details><summary>What counts as an emergency?</summary><p>No heat in cold weather, no cooling in dangerous heat or with someone vulnerable at home, water actively leaking, or a business that&apos;s down. If a caller mentions gas, carbon monoxide or smoke, they&apos;re told to get out and call 911 or the gas company, and your on-call phone is texted immediately.</p></details>
            <details><summary>Does my phone number change?</summary><p>No. Customers keep calling your number. You forward the calls you can&apos;t answer (and after-hours calls, if you like) to your CallCairn number.</p></details>
            <details><summary>Which calendars work?</summary><p>Google Calendar, Outlook and Apple Calendar, through a private calendar link. Every booking is also on your CallCairn dashboard the moment it&apos;s made, and you get a text for each one.</p></details>
            <details><summary>How does billing work?</summary><p>You get one week free. After that it&apos;s ${PRICE_MONTHLY_USD}/month in US dollars, billed through PayPal (PayPal balance, bank or card). Cancel anytime from your dashboard.</p></details>
            <details><summary>Are calls recorded?</summary><p>Calls aren&apos;t audio-recorded. What callers say is transcribed so the details can be booked, and callers are told that at the start of the call.</p></details>
          </div>
        </section>

        <section className="container center" style={{ marginTop: 48 }}>
          <h2>{TAGLINE}</h2>
          <div className="row" style={{ justifyContent: "center", marginTop: 12 }}>
            <Link href="/signup" className="btn btn-primary btn-lg">Start your free pilot</Link>
            <a href={`tel:${PUBLIC_PHONE_E164}`} className="btn btn-secondary btn-lg"><PhoneIcon /> {phone}</a>
          </div>
        </section>
      </main>

      <footer className="site-footer">
        <div className="container row between">
          <span>© {new Date().getFullYear()} CallCairn · Built for US HVAC contractors</span>
          <span><a href={`tel:${PUBLIC_PHONE_E164}`}>{phone}</a> · <Link href="/login">Log in</Link></span>
        </div>
      </footer>
    </>
  );
}
