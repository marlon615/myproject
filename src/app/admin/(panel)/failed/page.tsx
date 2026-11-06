import type { Metadata } from "next";
import { failedTexts, failureReasons } from "@/lib/admin";
import { FailedList } from "@/components/admin/FailedList";

export const metadata: Metadata = { title: "Failed texts · Owner" };

export default async function FailedPage() {
  const [rows, reasons] = await Promise.all([failedTexts(100), failureReasons(30)]);
  const total = reasons.reduce((a, r) => a + r.n, 0);
  return (
    <div className="stack-lg">
      <div>
        <h1 style={{ marginBottom: 4 }}>Failed texts</h1>
        <p className="muted" style={{ margin: 0 }}>Texts the provider rejected or that were cut off mid-send. They are not retried automatically.</p>
      </div>

      <div className="card">
        <div className="section-title"><h3 style={{ margin: 0 }}>By reason</h3><span className="muted small">{total} in the last 30 days</span></div>
        {reasons.length === 0 ? (
          <p className="muted small" style={{ margin: 0 }}>None in the last 30 days.</p>
        ) : (
          <ul className="list">
            {reasons.map((r) => (
              <li key={r.reason} className="list-main">
                <span className="small" style={{ overflowWrap: "anywhere" }}>{r.reason}</span>
                <strong style={{ flex: "none", fontVariantNumeric: "tabular-nums" }}>{r.n}</strong>
              </li>
            ))}
          </ul>
        )}
      </div>

      <div className="card">
        <div className="section-title"><h3 style={{ margin: 0 }}>Most recent</h3>{rows.length === 100 && <span className="muted small">latest 100</span>}</div>
        <FailedList rows={rows} />
      </div>
    </div>
  );
}
