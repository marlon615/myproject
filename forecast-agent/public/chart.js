/**
 * One small SVG line chart, shared by the backtest and the forecast:
 *   lineChart(el, { labels, series: [{ name, values (null = no point), dashed, color: 1|2 }], format, caption })
 * Series 1 = actual sales (blue), series 2 = predicted / forecast (orange, dashed). Legend always (2 series),
 * hover tooltip with every series' value for that month, thin 2px lines, recessive grid, one y-axis from 0.
 */
const NS = "http://www.w3.org/2000/svg";
const el = (tag, attrs = {}, parent) => {
  const n = document.createElementNS(NS, tag);
  for (const [k, v] of Object.entries(attrs)) n.setAttribute(k, v);
  if (parent) parent.appendChild(n);
  return n;
};

function niceMax(v) {
  if (!(v > 0)) return 1;
  const p = Math.pow(10, Math.floor(Math.log10(v)));
  for (const m of [1, 1.2, 1.5, 2, 2.5, 3, 4, 5, 6, 8, 10]) if (m * p >= v) return m * p;
  return 10 * p;
}
export const short = (v, kind) => {
  const a = Math.abs(v), pre = kind === "money" ? "$" : "";
  if (a >= 1e9) return `${pre}${+(v / 1e9).toFixed(1)}B`;
  if (a >= 1e6) return `${pre}${+(v / 1e6).toFixed(1)}M`;
  if (a >= 1e3) return `${pre}${+(v / 1e3).toFixed(a >= 1e4 ? 0 : 1)}k`;
  return `${pre}${Math.round(v)}`;
};

export function lineChart(host, { labels, series, format, kind, caption }) {
  host.innerHTML = "";
  host.classList.add("chart");
  const legend = document.createElement("div");
  legend.className = "legend";
  for (const s of series) {
    const item = document.createElement("span");
    item.className = "legend-item";
    item.innerHTML = `<svg width="22" height="10" aria-hidden="true"><line x1="1" y1="5" x2="21" y2="5" class="s${s.color}" stroke-width="2" ${s.dashed ? 'stroke-dasharray="5 3"' : ""}/></svg>`;
    item.append(document.createTextNode(s.name));
    legend.appendChild(item);
  }
  host.appendChild(legend);

  // Drawn at the space it really has, so labels stay a readable size on a phone.
  const W = Math.round(Math.max(300, Math.min(760, host.clientWidth || 640))), H = W < 480 ? 220 : 260, L = 48, R = 12, T = 12, B = 30;
  const svg = el("svg", { viewBox: `0 0 ${W} ${H}`, role: "img", "aria-label": caption || series.map((s) => s.name).join(" and ") });
  host.appendChild(svg);
  const all = series.flatMap((s) => s.values.filter((v) => v !== null && v !== undefined));
  const max = niceMax(Math.max(0, ...all));
  const n = labels.length;
  const x = (i) => L + (n === 1 ? (W - L - R) / 2 : (i * (W - L - R)) / (n - 1));
  const y = (v) => T + (H - T - B) * (1 - v / max);

  for (let k = 0; k <= 4; k++) {
    const v = (max * k) / 4;
    el("line", { x1: L, x2: W - R, y1: y(v), y2: y(v), class: k === 0 ? "axis" : "grid" }, svg);
    el("text", { x: L - 6, y: y(v) + 4, "text-anchor": "end", class: "tick" }, svg).textContent = short(v, kind);
  }
  const every = Math.max(1, Math.ceil(n / Math.max(3, Math.floor(W / 80))));
  labels.forEach((lab, i) => {
    // Every few months, plus the last one; skip a regular label that would crowd the last.
    if (i !== n - 1 && (i % every !== 0 || n - 1 - i < Math.max(2, every * 0.75))) return;
    el("text", { x: x(i), y: H - 8, "text-anchor": i === 0 ? "start" : i === n - 1 ? "end" : "middle", class: "tick" }, svg).textContent = lab;
  });

  for (const s of series) {
    let d = "", pen = false;
    s.values.forEach((v, i) => {
      if (v === null || v === undefined) { pen = false; return; }
      d += `${pen ? "L" : "M"}${x(i).toFixed(1)},${y(v).toFixed(1)}`;
      pen = true;
    });
    el("path", { d, class: `line s${s.color}`, fill: "none", "stroke-width": 2, "stroke-linejoin": "round", "stroke-linecap": "round", ...(s.dashed ? { "stroke-dasharray": "6 4" } : {}) }, svg);
    // Points only where a series has few values (the 3 predicted months), so short lines stay visible.
    const count = s.values.filter((v) => v !== null && v !== undefined).length;
    if (count <= 4) s.values.forEach((v, i) => { if (v !== null && v !== undefined) el("circle", { cx: x(i), cy: y(v), r: 4, class: `dot s${s.color}` }, svg); });
  }

  // Hover: a crosshair and a tooltip listing every series for the nearest month.
  const cross = el("line", { y1: T, y2: H - B, class: "cross", visibility: "hidden" }, svg);
  const marks = series.map((s) => el("circle", { r: 5, class: `hover s${s.color}`, visibility: "hidden" }, svg));
  const tip = document.createElement("div");
  tip.className = "tip";
  tip.hidden = true;
  host.appendChild(tip);
  const hit = el("rect", { x: L, y: T, width: W - L - R, height: H - T - B, fill: "transparent" }, svg);
  const show = (evt) => {
    const box = svg.getBoundingClientRect();
    const px = ((evt.clientX - box.left) / box.width) * W;
    const i = Math.max(0, Math.min(n - 1, Math.round(((px - L) / (W - L - R)) * (n - 1))));
    cross.setAttribute("x1", x(i)); cross.setAttribute("x2", x(i)); cross.setAttribute("visibility", "visible");
    let rows = "";
    series.forEach((s, k) => {
      const v = s.values[i];
      if (v === null || v === undefined) { marks[k].setAttribute("visibility", "hidden"); return; }
      marks[k].setAttribute("cx", x(i)); marks[k].setAttribute("cy", y(v)); marks[k].setAttribute("visibility", "visible");
      rows += `<div><span class="key s${s.color}"></span>${s.name}: <b>${format(v)}</b></div>`;
    });
    tip.innerHTML = `<div class="tip-title">${labels[i]}</div>${rows}`;
    tip.hidden = false;
    const left = (x(i) / W) * box.width;
    tip.style.left = `${Math.min(Math.max(left, 70), box.width - 70)}px`;
  };
  const hide = () => { tip.hidden = true; cross.setAttribute("visibility", "hidden"); marks.forEach((m) => m.setAttribute("visibility", "hidden")); };
  hit.addEventListener("pointermove", show);
  hit.addEventListener("pointerdown", show);
  hit.addEventListener("pointerleave", hide);
}
