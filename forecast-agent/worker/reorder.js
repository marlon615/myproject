/**
 * Reorder suggestions from forecast demand and stock on hand (standard reorder-point method):
 *   daily demand d      = forecast units for the next 3 months ÷ days in those months
 *   safety stock        = z(service level) × forecast error (monthly, from the backtest) × √(lead time ÷ 30.4)
 *   reorder point       = d × lead time + safety stock
 *   when stock on hand + on order ≤ reorder point → order up to (reorder point + d × review period),
 *   rounded up to the case pack and at least the minimum order.
 */
const Z = { 0.9: 1.2816, 0.95: 1.6449, 0.975: 1.96, 0.99: 2.3263 };
export const DEFAULT_SETTINGS = { serviceLevel: 0.95, reviewDays: 14, leadDays: 14 };

/** item: { product, location, onHand, onOrder, leadDays, casePack, minOrder, unitCost }
 *  demand: { forecast: [m1, m2, m3] (units), months: ["2026-12", …], rmse (monthly units error, or null) } | null */
export function suggest(item, demand, settings = DEFAULT_SETTINGS) {
  const lead = num(item.leadDays) || settings.leadDays, review = settings.reviewDays;
  const onHand = num(item.onHand), onOrder = num(item.onOrder), position = onHand + onOrder;
  const base = { product: item.product, location: item.location || "", onHand, onOrder, leadDays: lead, unitCost: num(item.unitCost) || null };
  if (!demand) return { ...base, status: "nodata", note: "No sales history in units for this item yet." };
  const days = demand.months.reduce((s, ym) => s + daysIn(ym), 0) || 91.3;
  const d = demand.forecast.reduce((s, v) => s + v, 0) / days;
  const z = Z[settings.serviceLevel] ?? 1.6449;
  const sigma = demand.rmse ?? 0.25 * (demand.forecast[0] || 0); // no backtest yet: assume 25% error
  const safety = z * sigma * Math.sqrt(lead / 30.4);
  const rop = d * lead + safety, upTo = rop + d * review;
  let qty = 0;
  if (d > 0 && position <= rop) {
    qty = Math.max(upTo - position, num(item.minOrder) || 0);
    const pack = Math.max(1, num(item.casePack) || 1);
    qty = Math.ceil(qty / pack) * pack;
  }
  const cover = d > 0 ? onHand / d : null;
  const status = d > 0 && onHand <= 0 ? "out" : d > 0 && position <= rop ? "low" : "ok";
  return { ...base, status, dailyDemand: r1(d), daysOfCover: cover === null ? null : Math.round(cover), safetyStock: Math.ceil(safety), reorderPoint: Math.ceil(rop),
    orderUpTo: Math.ceil(upTo), suggestedQty: qty, orderValue: item.unitCost ? Math.round(qty * num(item.unitCost) * 100) / 100 : null, next3: Math.round(demand.forecast.reduce((s, v) => s + v, 0)) };
}
const RANK = { out: 0, low: 1, ok: 2, nodata: 3 };
export const sortSuggestions = (list) => list.sort((a, b) => RANK[a.status] - RANK[b.status] || (a.daysOfCover ?? 1e9) - (b.daysOfCover ?? 1e9) || b.suggestedQty - a.suggestedQty);
const num = (v) => (Number.isFinite(Number(v)) ? Number(v) : 0);
const r1 = (v) => Math.round(v * 10) / 10;
const daysIn = (ym) => new Date(Date.UTC(+ym.slice(0, 4), +ym.slice(5, 7), 0)).getUTCDate();
