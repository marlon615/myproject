import type { Metadata } from "next";
import { redirect } from "next/navigation";
import { isOwner } from "@/lib/auth";
import { APP_TZ } from "@/lib/config";
import { ownerStats, type DayRow } from "@/lib/stats";
import { ownerLogout } from "./actions";

export const dynamic = "force-dynamic";
export const metadata: Metadata = { title: "Owner dashboard", robots: { index: false, follow: false } };

const nf = new Intl.NumberFormat("en-US");

function Tile({ label, value, sub }: { label: string; value: number; sub?: string }) {
  return (
    <div className="owner-tile">
      <div className="owner-tile-label">{label}</div>
      <div className="owner-tile-value">{nf.format(value)}</div>
      {sub && <div className="owner-tile-sub">{sub}</div>}
    </div>
  );
}

const SERIES: { key: keyof Omit<DayRow, "day">; label: string; cls: string }[] = [
  { key: "chats", label: "Chats", cls: "s-chats" },
  { key: "checkins", label: "Check-ins", cls: "s-checkins" },
  { key: "wins", label: "Wins", cls: "s-wins" },
  { key: "signups", label: "Sign-ups", cls: "s-signups" },
];

function Daily({ days }: { days: DayRow[] }) {
  const max = Math.max(1, ...days.map((d) => d.chats + d.checkins));
  const label = (day: string) => new Date(`${day}T12:00:00Z`).toLocaleDateString("en-US", { month: "short", day: "numeric", timeZone: "UTC" });
  return (
    <div className="owner-card">
      <div className="owner-card-head">
        <h2>Last 14 days</h2>
        <div className="owner-legend">
          <span><i className="s-chats" />Chats</span>
          <span><i className="s-checkins" />Check-ins</span>
        </div>
      </div>
      <div className="owner-bars" role="img" aria-label="Chats and check-ins per day for the last 14 days">
        {days.map((d) => (
          <div key={d.day} className="owner-bar-col" title={`${label(d.day)}: ${d.chats} chats, ${d.checkins} check-ins`}>
            <div className="owner-bar-stack">
              <div className="owner-bar s-checkins" style={{ height: `${(d.checkins / max) * 100}%` }} />
              <div className="owner-bar s-chats" style={{ height: `${(d.chats / max) * 100}%` }} />
            </div>
            <div className="owner-bar-x">{new Date(`${d.day}T12:00:00Z`).getUTCDate()}</div>
          </div>
        ))}
      </div>
      <div className="owner-table-wrap">
        <table className="owner-table">
          <thead>
            <tr><th>Day</th>{SERIES.map((s) => <th key={s.key}>{s.label}</th>)}</tr>
          </thead>
          <tbody>
            {[...days].reverse().map((d) => (
              <tr key={d.day}>
                <td>{label(d.day)}</td>
                {SERIES.map((s) => <td key={s.key}>{nf.format(d[s.key])}</td>)}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}

export default async function OwnerPage() {
  if (!(await isOwner())) redirect("/owner/login");

  let stats: Awaited<ReturnType<typeof ownerStats>> = null;
  let dbError: string | null = null;
  try {
    stats = await ownerStats();
  } catch (e) {
    dbError = (e as Error).message;
  }

  return (
    <main className="owner-wrap owner-wide">
      <header className="owner-top">
        <div>
          <h1>Future Self · Owner</h1>
          <p className="muted">Private dashboard. Times in {APP_TZ.replace("_", " ")}.</p>
        </div>
        <form action={ownerLogout}><button className="btn btn-ghost">Sign out</button></form>
      </header>

      {!stats && !dbError && (
        <div className="owner-card">
          <h2>Connect a database to see your numbers</h2>
          <p className="muted">Add <code>DATABASE_URL</code> (any Postgres, for example Neon or Supabase) to the server settings and redeploy. Tables are created automatically.</p>
        </div>
      )}
      {dbError && (
        <div className="owner-card">
          <h2>Couldn&apos;t reach the database</h2>
          <p className="owner-error">{dbError}</p>
        </div>
      )}

      {stats && (
        <>
          <section className="owner-tiles">
            <Tile label="Total users" value={stats.totalUsers} sub={`${nf.format(stats.activeToday)} opened the app today`} />
            <Tile label="Sign-ups today" value={stats.signups.today} sub={`${nf.format(stats.signups.week)} this week · ${nf.format(stats.signups.month)} in 30 days`} />
            <Tile label="Chats today" value={stats.chats.today} sub={`${nf.format(stats.chats.total)} all time`} />
            <Tile label="Check-ins today" value={stats.checkins.today} sub={`${nf.format(stats.checkins.total)} completed all time`} />
            <Tile label="Wins today" value={stats.wins.today} sub={`${nf.format(stats.wins.total)} logged all time`} />
          </section>
          <Daily days={stats.days} />
          <p className="muted owner-note">Only anonymous counts are stored. People&apos;s goals, conversations and wins stay on their own phones.</p>
        </>
      )}
    </main>
  );
}
