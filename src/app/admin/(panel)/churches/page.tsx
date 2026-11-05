import Link from "next/link";
import type { Metadata } from "next";
import { churchList, STATUS_FILTERS, STATUS_BADGE, timeAgo, type StatusFilter } from "@/lib/admin";
import { formatDate } from "@/lib/utils";

export const metadata: Metadata = { title: "Churches · Owner" };

type Search = { q?: string; status?: string };

export default async function ChurchesPage({ searchParams }: { searchParams: Promise<Search> }) {
  const sp = await searchParams;
  const q = (sp.q ?? "").slice(0, 100);
  const status: StatusFilter = STATUS_FILTERS.some((f) => f.key === sp.status) ? (sp.status as StatusFilter) : "all";
  const { rows, counts } = await churchList(q, status);

  const href = (s: StatusFilter) => {
    const p = new URLSearchParams();
    if (q) p.set("q", q);
    if (s !== "all") p.set("status", s);
    const qs = p.toString();
    return `/admin/churches${qs ? `?${qs}` : ""}`;
  };

  return (
    <div className="stack-lg">
      <div className="stack">
        <h1 style={{ margin: 0 }}>Churches</h1>
        <form className="searchbar" action="/admin/churches" role="search">
          {status !== "all" && <input type="hidden" name="status" value={status} />}
          <input type="search" name="q" defaultValue={q} placeholder="Search name, pastor, email, city…" aria-label="Search churches" enterKeyHint="search" />
          <button className="btn btn-secondary" type="submit">Search</button>
        </form>
        <nav className="chips" aria-label="Filter by status">
          {STATUS_FILTERS.map((f) => (
            <Link key={f.key} href={href(f.key)} className={`chip${status === f.key ? " active" : ""}`} aria-current={status === f.key ? "page" : undefined}>
              {f.label} <span className="count">{counts[f.key]}</span>
            </Link>
          ))}
        </nav>
      </div>

      <div className="card">
        <div className="row between" style={{ marginBottom: 4 }}>
          <span className="muted small">
            {rows.length} church{rows.length === 1 ? "" : "es"}
            {q && <> matching “{q}”</>}
          </span>
          {(q || status !== "all") && <Link href="/admin/churches" className="small">Clear</Link>}
        </div>
        {rows.length === 0 ? (
          <p className="muted" style={{ margin: "16px 0 4px" }}>No churches match.</p>
        ) : (
          <ul className="list">
            {rows.map((r) => {
              const badge = STATUS_BADGE[r.group];
              return (
                <li key={r.church.id}>
                  <div className="list-main">
                    <Link href={`/admin/churches/${r.church.id}`} className="list-title">{r.church.name}</Link>
                    <span className={`badge ${badge.cls}`} style={{ flex: "none" }}><span className="dot" />{badge.label}</span>
                  </div>
                  <div className="list-meta">
                    {r.church.pastorName}{r.church.city ? ` · ${r.church.city}` : ""} · {r.church.email}
                  </div>
                  <div className="metrics">
                    <span><strong>{r.visitors}</strong> visitor{r.visitors === 1 ? "" : "s"}</span>
                    <span><strong>{r.texts}</strong> text{r.texts === 1 ? "" : "s"} sent</span>
                    <span>Active <strong>{timeAgo(r.lastActivity)}</strong></span>
                    <span>Joined {formatDate(r.church.createdAt)}</span>
                    {r.plan.kind === "trial" && <span>Trial ends {formatDate(r.plan.endsAt)}</span>}
                  </div>
                </li>
              );
            })}
          </ul>
        )}
      </div>
    </div>
  );
}
