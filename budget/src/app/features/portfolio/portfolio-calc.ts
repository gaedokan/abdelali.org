// Pure portfolio maths: average-cost positions, P/L, value series, account-value adjustment, chart helpers.
// Amounts are integer centimes; prices are centimes per share. No Angular imports so it is trivially testable.

import { parseMoney } from '../../core/money';
import { dayDiff } from '../../core/util';

export const ADJ_PAYEE = 'Market value change';
export const ADJ_MEMO = 'Unrealised gain/loss';
const EPS = 1e-9;

export type Side = 'buy' | 'sell' | 'dividend';

export interface TradeIn {
  id?: string;
  accountId: string;
  date: string;
  symbol: string;
  side: Side;
  quantity: number;
  price: number;
  fees: number;
}

export interface Position {
  symbol: string;
  quantity: number;
  /** remaining cost basis (centimes) */
  cost: number;
  /** average cost per share (centimes, fractional) */
  avgCost: number;
  realised: number;
  /** net dividends received */
  dividends: number;
}

export interface PriceIn {
  price: number;
  date: string;
  name?: string;
  history?: [string, number][];
}

export interface Valued extends Position {
  last: number | null;
  lastDate: string | null;
  priced: boolean;
  marketValue: number;
  unrealised: number;
  unrealisedPct: number;
  /** change since the previous price point, null when unknown */
  dayChange: number | null;
}

const sideOrder = (s: Side) => (s === 'buy' ? 0 : s === 'dividend' ? 1 : 2);

export function sortTrades<T extends TradeIn>(trades: T[]): T[] {
  return trades
    .map((t, i) => ({ t, i }))
    .sort((a, b) => a.t.date.localeCompare(b.t.date) || sideOrder(a.t.side) - sideOrder(b.t.side) || a.i - b.i)
    .map((x) => x.t);
}

/** Cash effect of a trade on the brokerage account. */
export function tradeCash(side: Side, quantity: number, price: number, fees: number): number {
  if (side === 'buy') return -(Math.round(quantity * price) + fees);
  if (side === 'sell') return Math.round(quantity * price) - fees;
  return price - fees;
}

export const suggestFee = (amount: number, rate = 0.006) => Math.round(Math.max(0, amount) * rate);

class Ledger {
  readonly pos = new Map<string, { quantity: number; cost: number; realised: number; dividends: number }>();
  /** quantity that could not be sold because it was not held (should not happen after validation) */
  oversold: { symbol: string; date: string } | null = null;

  private get(symbol: string) {
    let p = this.pos.get(symbol);
    if (!p) this.pos.set(symbol, (p = { quantity: 0, cost: 0, realised: 0, dividends: 0 }));
    return p;
  }

  apply(t: TradeIn) {
    const p = this.get(t.symbol);
    if (t.side === 'buy') {
      p.cost += t.quantity * t.price + t.fees;
      p.quantity += t.quantity;
    } else if (t.side === 'sell') {
      if (t.quantity > p.quantity + EPS) this.oversold ??= { symbol: t.symbol, date: t.date };
      const q = Math.min(t.quantity, p.quantity);
      const avg = p.quantity > EPS ? p.cost / p.quantity : 0;
      const removed = avg * q;
      p.realised += t.quantity * t.price - t.fees - removed;
      p.cost -= removed;
      p.quantity -= q;
      if (p.quantity < EPS) { p.quantity = 0; p.cost = 0; }
    } else {
      p.dividends += t.price - t.fees;
    }
  }
}

function toPosition(symbol: string, p: { quantity: number; cost: number; realised: number; dividends: number }): Position {
  return {
    symbol,
    quantity: p.quantity,
    cost: Math.round(p.cost),
    avgCost: p.quantity > EPS ? p.cost / p.quantity : 0,
    realised: Math.round(p.realised),
    dividends: Math.round(p.dividends),
  };
}

/** Average-cost positions per symbol, including closed ones (quantity 0, realised/dividends kept). */
export function computePositions(trades: TradeIn[]): Map<string, Position> {
  const l = new Ledger();
  for (const t of sortTrades(trades)) l.apply(t);
  const out = new Map<string, Position>();
  for (const [s, p] of l.pos) out.set(s, toPosition(s, p));
  return out;
}

/** First point where a sell exceeds the shares held (per account + symbol), or null. */
export function firstOversell(trades: TradeIn[]): { symbol: string; date: string } | null {
  const byKey = new Map<string, TradeIn[]>();
  for (const t of trades) {
    if (t.side === 'dividend') continue;
    const k = t.accountId + '|' + t.symbol;
    (byKey.get(k) ?? byKey.set(k, []).get(k)!).push(t);
  }
  for (const list of byKey.values()) {
    const l = new Ledger();
    for (const t of sortTrades(list)) l.apply(t);
    if (l.oversold) return l.oversold;
  }
  return null;
}

export const sharesHeld = (trades: TradeIn[], symbol: string): number =>
  computePositions(trades.filter((t) => t.symbol === symbol)).get(symbol)?.quantity ?? 0;

// ------------------------------------------------------------------ prices

const dayKey = (d: string) => d;

/** Price points of a symbol, oldest first, always including the latest quote. */
export function pricePoints(p: PriceIn | undefined): [string, number][] {
  if (!p) return [];
  const pts = new Map<string, number>();
  for (const [d, v] of p.history ?? []) pts.set(d, v);
  pts.set(p.date, p.price);
  return [...pts.entries()].sort((a, b) => dayKey(a[0]).localeCompare(dayKey(b[0])));
}

/** Latest price point on or before `date`, or null. */
export function priceOnOrBefore(points: [string, number][], date: string): number | null {
  let lo = 0, hi = points.length - 1, ans = -1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    if (points[mid][0] <= date) { ans = mid; lo = mid + 1; } else hi = mid - 1;
  }
  return ans < 0 ? null : points[ans][1];
}

/** Merge a quote into a Price entity's fields (dedupes the same date, keeps <= 400 points). */
export function applyQuote(existing: PriceIn | undefined, price: number, date: string): { price: number; date: string; history: [string, number][] } {
  const pts = pricePoints(existing).filter(([d]) => d !== date);
  pts.push([date, price]);
  pts.sort((a, b) => a[0].localeCompare(b[0]));
  const history = pts.slice(-400);
  const last = history[history.length - 1];
  return { price: last[1], date: last[0], history };
}

export function valuePositions(positions: Position[], prices: Map<string, PriceIn>): Valued[] {
  return positions
    .filter((p) => p.quantity > EPS)
    .map((p) => {
      const pr = prices.get(p.symbol);
      const last = pr ? pr.price : null;
      const marketValue = last !== null ? Math.round(p.quantity * last) : p.cost;
      const unrealised = last !== null ? marketValue - p.cost : 0;
      let dayChange: number | null = null;
      if (pr) {
        const pts = pricePoints(pr);
        if (pts.length >= 2) dayChange = Math.round(p.quantity * (pts[pts.length - 1][1] - pts[pts.length - 2][1]));
      }
      return {
        ...p, last, lastDate: pr?.date ?? null, priced: last !== null, marketValue, unrealised,
        unrealisedPct: p.cost > 0 ? unrealised / p.cost : 0, dayChange,
      };
    })
    .sort((a, b) => b.marketValue - a.marketValue);
}

export interface Totals {
  marketValue: number;
  cost: number;
  unrealised: number;
  unrealisedPct: number;
  realised: number;
  dividends: number;
  /** realised + unrealised + dividends */
  totalReturn: number;
  dayChange: number | null;
  dayChangePct: number;
}

export function totals(valued: Valued[], all: Position[]): Totals {
  let marketValue = 0, cost = 0, unrealised = 0, day = 0, hasDay = false;
  for (const v of valued) {
    marketValue += v.marketValue; cost += v.cost; unrealised += v.unrealised;
    if (v.dayChange !== null) { day += v.dayChange; hasDay = true; }
  }
  const realised = all.reduce((s, p) => s + p.realised, 0);
  const dividends = all.reduce((s, p) => s + p.dividends, 0);
  return {
    marketValue, cost, unrealised, unrealisedPct: cost > 0 ? unrealised / cost : 0, realised, dividends,
    totalReturn: realised + unrealised + dividends,
    dayChange: hasDay ? day : null,
    dayChangePct: hasDay && marketValue - day > 0 ? day / (marketValue - day) : 0,
  };
}

/** Net dividends received in a calendar year. */
export const dividendsInYear = (trades: TradeIn[], year: number): number =>
  trades.filter((t) => t.side === 'dividend' && t.date.startsWith(String(year))).reduce((s, t) => s + t.price - t.fees, 0);

export interface SeriesPt { date: string; value: number; cost: number }

/** Portfolio value per date, reconstructed from trades x price history (falls back to cost when no price is known). */
export function valueSeries(trades: TradeIn[], prices: Map<string, PriceIn>, to: string): SeriesPt[] {
  const sorted = sortTrades(trades.filter((t) => t.side !== 'dividend'));
  if (!sorted.length) return [];
  const symbols = new Set(sorted.map((t) => t.symbol));
  const pts = new Map<string, [string, number][]>();
  const first = sorted[0].date;
  const dates = new Set<string>([to, ...sorted.map((t) => t.date)]);
  for (const s of symbols) {
    const p = pricePoints(prices.get(s));
    pts.set(s, p);
    for (const [d] of p) if (d >= first && d <= to) dates.add(d);
  }
  const ledger = new Ledger();
  let i = 0;
  const out: SeriesPt[] = [];
  for (const d of [...dates].filter((d) => d >= first && d <= to).sort()) {
    while (i < sorted.length && sorted[i].date <= d) ledger.apply(sorted[i++]);
    let value = 0, cost = 0;
    for (const [s, p] of ledger.pos) {
      if (p.quantity < EPS) continue;
      const px = priceOnOrBefore(pts.get(s) ?? [], d);
      value += px !== null ? p.quantity * px : p.cost;
      cost += p.cost;
    }
    out.push({ date: d, value: Math.round(value), cost: Math.round(cost) });
  }
  return out;
}

// ------------------------------------------------------------------ account value adjustment

export interface AdjTxn { payeeName: string | null | undefined; memo?: string | null }
export const isAdjustment = (t: AdjTxn) => t.payeeName === ADJ_PAYEE && t.memo === ADJ_MEMO;

/**
 * Amount to post so that the account's working balance becomes cash + market value.
 * `cash` excludes adjustment txns; `working` includes everything (also past adjustments).
 */
export const adjustmentDelta = (cash: number, marketValue: number, working: number) => cash + marketValue - working;

/** New amount for today's adjustment txn: previous amount (if any) plus the delta still missing. */
export const todaysAdjustment = (cash: number, marketValue: number, working: number, existingToday = 0) =>
  existingToday + adjustmentDelta(cash, marketValue, working);

// ------------------------------------------------------------------ pasted prices

/** Lines like "IAM 118,50", "ATW;520", "BCP: 262.5". */
export function parsePastedPrices(text: string): { rows: { symbol: string; price: number }[]; bad: number } {
  const rows: { symbol: string; price: number }[] = [];
  let bad = 0;
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    if (!line) continue;
    const m = line.match(/^([A-Za-z][A-Za-z0-9.]{0,9})\s*[;:=\t ]\s*(.+)$/);
    const v = m ? parseMoney(m[2].replace(/(mad|dh|dhs)\b/i, '')) : null;
    if (m && v !== null && v > 0) rows.push({ symbol: m[1].toUpperCase(), price: v });
    else bad++;
  }
  return { rows, bad };
}

// ------------------------------------------------------------------ chart helpers

export function niceTicks(min: number, max: number, n = 4): number[] {
  if (max - min <= 0) { const pad = Math.max(1, Math.abs(max) * 0.05); min -= pad; max += pad; }
  const raw = (max - min) / n;
  const pow = Math.pow(10, Math.floor(Math.log10(raw)));
  const f = raw / pow;
  const step = (f <= 1 ? 1 : f <= 2 ? 2 : f <= 5 ? 5 : 10) * pow;
  const out: number[] = [];
  for (let v = Math.ceil(min / step) * step; v <= max + 1e-6; v += step) out.push(v);
  return out;
}

export interface ChartPt { date: string; v: number; c?: number; x: number; y: number; cy?: number }
export interface LineChart {
  pts: ChartPt[];
  path: string;
  area: string;
  costPath: string;
  yTicks: { y: number; v: number }[];
  xTicks: { x: number; date: string }[];
}
export interface ChartBox { w: number; h: number; pl: number; pr: number; pt: number; pb: number }

export function lineChart(points: { date: string; v: number; c?: number }[], box: ChartBox): LineChart {
  const empty: LineChart = { pts: [], path: '', area: '', costPath: '', yTicks: [], xTicks: [] };
  if (!points.length) return empty;
  const vals = points.flatMap((p) => (p.c !== undefined ? [p.v, p.c] : [p.v]));
  let lo = Math.min(...vals), hi = Math.max(...vals);
  const padV = (hi - lo) * 0.08 || Math.max(100, Math.abs(hi) * 0.05);
  lo -= padV; hi += padV;
  const t0 = points[0].date, span = dayDiff(t0, points[points.length - 1].date);
  const iw = box.w - box.pl - box.pr, ih = box.h - box.pt - box.pb;
  const X = (d: string) => (span > 0 ? box.pl + (dayDiff(t0, d) / span) * iw : box.pl + iw / 2);
  const Y = (v: number) => box.pt + (1 - (v - lo) / (hi - lo)) * ih;
  const pts = points.map((p) => ({ ...p, x: X(p.date), y: Y(p.v), cy: p.c !== undefined ? Y(p.c) : undefined }));
  const f = (n: number) => n.toFixed(1);
  const path = pts.map((p, i) => `${i ? 'L' : 'M'}${f(p.x)} ${f(p.y)}`).join(' ');
  const costPath = pts[0].cy !== undefined ? pts.map((p, i) => `${i ? 'L' : 'M'}${f(p.x)} ${f(p.cy!)}`).join(' ') : '';
  const base = box.pt + ih;
  const area = pts.length > 1 ? `${path} L${f(pts[pts.length - 1].x)} ${f(base)} L${f(pts[0].x)} ${f(base)} Z` : '';
  const yTicks = niceTicks(lo, hi, 4).map((v) => ({ v, y: Y(v) }));
  const k = Math.min(4, pts.length);
  const xTicks: { x: number; date: string }[] = [];
  for (let i = 0; i < k; i++) {
    const p = pts[k === 1 ? 0 : Math.round((i * (pts.length - 1)) / (k - 1))];
    if (!xTicks.some((t) => t.date === p.date)) xTicks.push({ x: p.x, date: p.date });
  }
  return { pts, path, area, costPath, yTicks, xTicks };
}

/** Stroke arc for a donut slice between two fractions (0..1) of the circle, starting at 12 o'clock. */
export function arcPath(from: number, to: number, cx: number, cy: number, r: number): string {
  const frac = to - from;
  const pt = (f: number) => {
    const a = f * 2 * Math.PI - Math.PI / 2;
    return `${(cx + r * Math.cos(a)).toFixed(2)} ${(cy + r * Math.sin(a)).toFixed(2)}`;
  };
  if (frac >= 0.9999) return `M${pt(0)} A${r} ${r} 0 1 1 ${pt(0.5)} A${r} ${r} 0 1 1 ${pt(0)}`;
  return `M${pt(from)} A${r} ${r} 0 ${frac > 0.5 ? 1 : 0} 1 ${pt(to)}`;
}
