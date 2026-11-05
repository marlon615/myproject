"use client";
import { useEffect, useRef, useState } from "react";

/*
 * Lightweight SVG charts for the owner dashboard (no chart library).
 * Rendered at the container's real pixel width so text stays 11–12px on phones.
 * Series colors live in src/lib/chart-colors.ts.
 */

const INK = { muted: "#74655a", grid: "#efe8de", axis: "#d8cdbf" };
const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
const shortDate = (iso: string) => `${MONTHS[Number(iso.slice(5, 7)) - 1]} ${Number(iso.slice(8, 10))}`;

function useWidth<T extends HTMLElement>() {
  const ref = useRef<T>(null);
  const [width, setWidth] = useState(0);
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const ro = new ResizeObserver(([e]) => setWidth(Math.floor(e.contentRect.width)));
    ro.observe(el);
    setWidth(Math.floor(el.getBoundingClientRect().width));
    return () => ro.disconnect();
  }, []);
  return [ref, width] as const;
}

/** Clean integer y-axis: 0 → max in 3–4 steps. */
function niceTicks(maxValue: number): number[] {
  const max = Math.max(maxValue, 4);
  const raw = max / 4;
  const mag = 10 ** Math.floor(Math.log10(raw));
  const step = [1, 2, 2.5, 5, 10].map((m) => m * mag).find((s) => s >= raw && Number.isInteger(s)) ?? Math.ceil(raw);
  const top = Math.ceil(max / step) * step;
  return Array.from({ length: Math.round(top / step) + 1 }, (_, i) => i * step);
}
const fmt = (n: number) => (n >= 10000 ? `${Math.round(n / 1000)}K` : n.toLocaleString("en-US"));

type Tip = { x: number; y: number; title: string; rows: { label: string; value: number; color: string }[] } | null;

function Tooltip({ tip, width }: { tip: Tip; width: number }) {
  if (!tip) return null;
  const left = Math.min(Math.max(tip.x - 70, 0), Math.max(width - 150, 0));
  return (
    <div className="chart-tip" style={{ left, top: Math.max(tip.y - 8, 0) }} role="status">
      <div className="chart-tip-title">{tip.title}</div>
      {tip.rows.map((r) => (
        <div key={r.label} className="chart-tip-row">
          <span className="chart-key-line" style={{ background: r.color }} />
          <strong>{r.value.toLocaleString("en-US")}</strong>
          <span className="muted">{r.label}</span>
        </div>
      ))}
    </div>
  );
}

// ───────────────────────── Line chart (daily, multi-series, one axis) ─────────────────────────

export type LineSeries = { key: string; label: string; color: string };

export function DailyLineChart({ data, series, height = 220 }: { data: ({ day: string } & Record<string, number | string>)[]; series: LineSeries[]; height?: number }) {
  const [ref, width] = useWidth<HTMLDivElement>();
  const [active, setActive] = useState<number | null>(null);
  const m = { top: 12, right: 12, bottom: 26, left: 34 };
  const w = Math.max(width - m.left - m.right, 10);
  const h = height - m.top - m.bottom;
  const values = data.flatMap((d) => series.map((s) => Number(d[s.key])));
  const ticks = niceTicks(Math.max(0, ...values));
  const top = ticks[ticks.length - 1];
  const x = (i: number) => (data.length <= 1 ? w / 2 : (i / (data.length - 1)) * w);
  const y = (v: number) => h - (v / top) * h;
  const labelEvery = w < 360 ? 10 : 7;

  const pick = (clientX: number) => {
    const rect = ref.current?.querySelector("svg")?.getBoundingClientRect();
    if (!rect) return;
    const px = clientX - rect.left - m.left;
    setActive(Math.min(data.length - 1, Math.max(0, Math.round((px / w) * (data.length - 1)))));
  };

  const tip: Tip =
    active === null
      ? null
      : {
          x: m.left + x(active),
          y: m.top,
          title: shortDate(data[active].day),
          rows: series.map((s) => ({ label: s.label, value: Number(data[active][s.key]), color: s.color })),
        };

  return (
    <div ref={ref} className="chart">
      <div className="chart-legend">
        {series.map((s) => (
          <span key={s.key}><span className="chart-key-line" style={{ background: s.color }} />{s.label}</span>
        ))}
      </div>
      {width > 0 && (
        <div style={{ position: "relative" }}>
          <svg
            width={width}
            height={height}
            role="img"
            aria-label={`${series.map((s) => s.label).join(" and ")} per day, last ${data.length} days`}
            tabIndex={0}
            onPointerMove={(e) => pick(e.clientX)}
            onPointerDown={(e) => pick(e.clientX)}
            onPointerLeave={(e) => e.pointerType === "mouse" && setActive(null)}
            onKeyDown={(e) => {
              if (e.key === "ArrowLeft") setActive((a) => Math.max(0, (a ?? data.length) - 1));
              if (e.key === "ArrowRight") setActive((a) => Math.min(data.length - 1, (a ?? -1) + 1));
              if (e.key === "Escape") setActive(null);
            }}
            onBlur={() => setActive(null)}
            style={{ touchAction: "pan-y", display: "block", outline: "none" }}
          >
            <g transform={`translate(${m.left},${m.top})`}>
              {ticks.map((t) => (
                <g key={t}>
                  <line x1={0} x2={w} y1={y(t)} y2={y(t)} stroke={t === 0 ? INK.axis : INK.grid} strokeWidth={1} />
                  <text x={-8} y={y(t)} dy="0.32em" textAnchor="end" fontSize={11} fill={INK.muted} style={{ fontVariantNumeric: "tabular-nums" }}>{fmt(t)}</text>
                </g>
              ))}
              {data.map((d, i) =>
                (data.length - 1 - i) % labelEvery === 0 ? (
                  <text key={d.day} x={x(i)} y={h + 18} textAnchor={i === data.length - 1 ? "end" : "middle"} fontSize={11} fill={INK.muted}>{shortDate(d.day)}</text>
                ) : null,
              )}
              {series.map((s) => (
                <path
                  key={s.key}
                  d={data.map((d, i) => `${i ? "L" : "M"}${x(i).toFixed(1)},${y(Number(d[s.key])).toFixed(1)}`).join("")}
                  fill="none"
                  stroke={s.color}
                  strokeWidth={2}
                  strokeLinejoin="round"
                  strokeLinecap="round"
                />
              ))}
              {active !== null && (
                <g pointerEvents="none">
                  <line x1={x(active)} x2={x(active)} y1={0} y2={h} stroke={INK.axis} strokeWidth={1} />
                  {series.map((s) => (
                    <circle key={s.key} cx={x(active)} cy={y(Number(data[active][s.key]))} r={4} fill={s.color} stroke="#fff" strokeWidth={2} />
                  ))}
                </g>
              )}
            </g>
          </svg>
          <Tooltip tip={tip} width={width} />
        </div>
      )}
    </div>
  );
}

// ───────────────────────── Column chart (weekly, single series) ─────────────────────────

export function WeeklyColumnChart({ data, label, color, height = 200 }: { data: { week: string; value: number }[]; label: string; color: string; height?: number }) {
  const [ref, width] = useWidth<HTMLDivElement>();
  const [active, setActive] = useState<number | null>(null);
  const m = { top: 18, right: 8, bottom: 26, left: 30 };
  const w = Math.max(width - m.left - m.right, 10);
  const h = height - m.top - m.bottom;
  const ticks = niceTicks(Math.max(0, ...data.map((d) => d.value)));
  const top = ticks[ticks.length - 1];
  const band = w / data.length;
  const barW = Math.min(24, band - 6);
  const y = (v: number) => h - (v / top) * h;
  const labelEvery = band < 30 ? 3 : 2;
  const r = Math.min(4, barW / 2);

  // Rounded data-end, square at the baseline.
  const bar = (bx: number, v: number) => {
    const by = y(v);
    const bh = h - by;
    if (bh <= 0) return "";
    const rr = Math.min(r, bh);
    return `M${bx},${h}V${by + rr}Q${bx},${by} ${bx + rr},${by}H${bx + barW - rr}Q${bx + barW},${by} ${bx + barW},${by + rr}V${h}Z`;
  };

  const last = data.length - 1;
  const tip: Tip =
    active === null
      ? null
      : {
          x: m.left + active * band + band / 2,
          y: 0,
          title: `Week of ${shortDate(data[active].week)}`,
          rows: [{ label, value: data[active].value, color }],
        };

  return (
    <div ref={ref} className="chart">
      {width > 0 && (
        <div style={{ position: "relative" }}>
          <svg width={width} height={height} role="img" aria-label={`${label} per week, last ${data.length} weeks`} style={{ display: "block" }}>
            <g transform={`translate(${m.left},${m.top})`}>
              {ticks.map((t) => (
                <g key={t}>
                  <line x1={0} x2={w} y1={y(t)} y2={y(t)} stroke={t === 0 ? INK.axis : INK.grid} strokeWidth={1} />
                  <text x={-8} y={y(t)} dy="0.32em" textAnchor="end" fontSize={11} fill={INK.muted} style={{ fontVariantNumeric: "tabular-nums" }}>{fmt(t)}</text>
                </g>
              ))}
              {data.map((d, i) => {
                const bx = i * band + (band - barW) / 2;
                return (
                  <g key={d.week}>
                    <path d={bar(bx, d.value)} fill={color} opacity={active === null || active === i ? 1 : 0.55} />
                    {i === last && d.value > 0 && (
                      <text x={bx + barW / 2} y={y(d.value) - 6} textAnchor="middle" fontSize={11} fontWeight={600} fill="#2b2118">{d.value}</text>
                    )}
                    {(last - i) % labelEvery === 0 && (
                      <text x={bx + barW / 2} y={h + 18} textAnchor={i === last ? "end" : "middle"} fontSize={11} fill={INK.muted}>
                        {i === last ? "This wk" : shortDate(d.week)}
                      </text>
                    )}
                    {/* Hit target: the whole band, not just the painted bar. */}
                    <rect
                      x={i * band}
                      y={0}
                      width={band}
                      height={h}
                      fill="transparent"
                      tabIndex={0}
                      aria-label={`Week of ${shortDate(d.week)}: ${d.value} ${label.toLowerCase()}`}
                      onPointerEnter={() => setActive(i)}
                      onPointerDown={() => setActive(i)}
                      onPointerLeave={(e) => e.pointerType === "mouse" && setActive(null)}
                      onFocus={() => setActive(i)}
                      onBlur={() => setActive(null)}
                      style={{ outline: "none" }}
                    />
                  </g>
                );
              })}
            </g>
          </svg>
          <Tooltip tip={tip} width={width} />
        </div>
      )}
    </div>
  );
}
