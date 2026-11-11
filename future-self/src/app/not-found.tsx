import Link from "next/link";

export default function NotFound() {
  return (
    <main className="owner-wrap">
      <div className="owner-card center">
        <h1>Nothing here</h1>
        <p className="muted">Let&apos;s get you back on track.</p>
        <Link className="btn btn-primary" href="/">Open Future Self</Link>
      </div>
    </main>
  );
}
