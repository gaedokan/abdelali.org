import { describe, expect, it } from 'vitest';
import {
  adjustmentDelta, applyQuote, computePositions, dividendsInYear, firstOversell, isAdjustment, parsePastedPrices,
  todaysAdjustment, totals, tradeCash, TradeIn, valuePositions, valueSeries,
} from './portfolio-calc';

const t = (o: Partial<TradeIn>): TradeIn => ({ accountId: 'a', date: '2026-01-10', symbol: 'IAM', side: 'buy', quantity: 10, price: 10000, fees: 0, ...o });

describe('positions', () => {
  it('computes average cost including fees', () => {
    const p = computePositions([t({ fees: 600 }), t({ date: '2026-02-01', quantity: 10, price: 12000, fees: 0 })]).get('IAM')!;
    expect(p.quantity).toBe(20);
    expect(p.cost).toBe(100600 + 120000);
    expect(p.avgCost).toBeCloseTo(11030);
  });

  it('computes realised P/L on a partial sell and keeps average cost', () => {
    const p = computePositions([t({ fees: 600 }), t({ date: '2026-02-01', side: 'sell', quantity: 4, price: 12000, fees: 288 })]).get('IAM')!;
    expect(p.quantity).toBe(6);
    expect(p.avgCost).toBeCloseTo(10060);
    expect(p.cost).toBe(60360);
    expect(p.realised).toBe(47712 - 40240);
  });

  it('closes a position and tracks dividends net of fees', () => {
    const p = computePositions([
      t({}), t({ date: '2026-03-01', side: 'sell', quantity: 10, price: 9000 }),
      t({ date: '2026-02-01', side: 'dividend', quantity: 0, price: 5000, fees: 750 }),
    ]).get('IAM')!;
    expect(p.quantity).toBe(0);
    expect(p.cost).toBe(0);
    expect(p.realised).toBe(-10000);
    expect(p.dividends).toBe(4250);
  });

  it('orders same-day buys before sells', () => {
    expect(firstOversell([t({ side: 'sell', quantity: 5 }), t({ quantity: 5 })])).toBeNull();
  });

  it('detects overselling per account and symbol', () => {
    expect(firstOversell([t({}), t({ date: '2026-02-01', side: 'sell', quantity: 11 })])).toEqual({ symbol: 'IAM', date: '2026-02-01' });
    expect(firstOversell([t({}), t({ accountId: 'b', date: '2026-02-01', side: 'sell', quantity: 1 })])?.symbol).toBe('IAM');
  });
});

describe('valuation', () => {
  const trades = [t({ fees: 600 }), t({ symbol: 'ATW', quantity: 2, price: 50000 })];
  const prices = new Map([
    ['IAM', { price: 12000, date: '2026-03-02', history: [['2026-03-01', 11000], ['2026-03-02', 12000]] as [string, number][] }],
  ]);

  it('values positions, falling back to cost without a price', () => {
    const pos = computePositions(trades);
    const v = valuePositions([...pos.values()], prices);
    const iam = v.find((x) => x.symbol === 'IAM')!;
    expect(iam.marketValue).toBe(120000);
    expect(iam.unrealised).toBe(120000 - 100600);
    expect(iam.dayChange).toBe(10000);
    const atw = v.find((x) => x.symbol === 'ATW')!;
    expect(atw.priced).toBe(false);
    expect(atw.marketValue).toBe(100000);
    expect(atw.unrealised).toBe(0);
    const tot = totals(v, [...pos.values()]);
    expect(tot.marketValue).toBe(220000);
    expect(tot.unrealised).toBe(19400);
    expect(tot.dayChange).toBe(10000);
  });

  it('sums dividends for a year', () => {
    expect(dividendsInYear([t({ side: 'dividend', price: 1000, fees: 100, date: '2026-05-01' }), t({ side: 'dividend', price: 900, date: '2025-05-01' })], 2026)).toBe(900);
  });

  it('merges quotes and dedupes the same date', () => {
    const a = applyQuote(undefined, 10000, '2026-03-01');
    const b = applyQuote({ ...a }, 10500, '2026-03-01');
    expect(b.history).toEqual([['2026-03-01', 10500]]);
    const c = applyQuote(b, 11000, '2026-03-02');
    expect(c.price).toBe(11000);
    expect(c.history.length).toBe(2);
    expect(applyQuote(c, 9000, '2026-02-01').price).toBe(11000);
  });

  it('reconstructs value over time with cost fallback', () => {
    const s = valueSeries([t({ date: '2026-03-01', quantity: 10, price: 10000 })], prices, '2026-03-05');
    expect(s.map((p) => p.date)).toEqual(['2026-03-01', '2026-03-02', '2026-03-05']);
    expect(s[0].value).toBe(110000);
    expect(s[2].value).toBe(120000);
    const noPrice = valueSeries([t({ date: '2026-03-01' })], new Map(), '2026-03-05');
    expect(noPrice.every((p) => p.value === 100000)).toBe(true);
  });
});

describe('cash and adjustments', () => {
  it('computes trade cash', () => {
    expect(tradeCash('buy', 10, 12050, 723)).toBe(-(120500 + 723));
    expect(tradeCash('sell', 10, 12050, 723)).toBe(120500 - 723);
    expect(tradeCash('dividend', 0, 5000, 750)).toBe(4250);
  });

  it('computes the adjustment so working = cash + market value', () => {
    // cash 0 (funded 1 000, spent 1 000 on shares), stock worth 1 200, working 0 -> post +1 200 for the stock value
    expect(adjustmentDelta(0, 120000, 0)).toBe(120000);
    // that adjustment exists today; the stock rose by another 50
    expect(todaysAdjustment(0, 125000, 120000, 120000)).toBe(125000);
    // everything sold: market value 0 and cash 1 250 -> today's adjustment cancels out
    expect(todaysAdjustment(125000, 0, 125000 + 125000, 125000)).toBe(0);
  });

  it('identifies adjustment txns', () => {
    expect(isAdjustment({ payeeName: 'Market value change', memo: 'Unrealised gain/loss' })).toBe(true);
    expect(isAdjustment({ payeeName: 'IAM', memo: 'Buy' })).toBe(false);
  });

  it('parses pasted prices', () => {
    const r = parsePastedPrices('IAM 118,50\nATW;520\n\nbcp: 262.5\nnonsense');
    expect(r.rows).toEqual([{ symbol: 'IAM', price: 11850 }, { symbol: 'ATW', price: 52000 }, { symbol: 'BCP', price: 26250 }]);
    expect(r.bad).toBe(1);
  });
});
