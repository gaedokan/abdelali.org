// Pure helpers behind the Reports screen (no Angular, easy to test).
import { Account, isCreditType, RTA, Txn } from '../../core/models';
import { dayDiff, monthOf } from '../../core/util';

export const UNCAT = 'uncat';

export interface Line {
  date: string;
  month: string;
  /** spend lines: outflow as a positive number (refunds negative); income lines: inflow */
  amount: number;
  categoryId: string;
  payeeId: string | null;
  accountId: string;
}

const isInternalTransfer = (t: Txn, accounts: Map<string, Account>) => {
  const o = t.transferAccountId ? accounts.get(t.transferAccountId) : undefined;
  return !!o && o.onBudget;
};

function expand(t: Txn): { categoryId: string | null | undefined; amount: number }[] {
  if (t.splits?.length) return t.splits.map((s) => ({ categoryId: s.categoryId, amount: s.amount }));
  return [{ categoryId: t.categoryId, amount: t.amount }];
}

/** Spending and income lines on on-budget accounts. accountId = null means every budget account. */
export function buildLines(txns: Txn[], accounts: Map<string, Account>, accountId: string | null) {
  const spend: Line[] = [];
  const income: Line[] = [];
  for (const t of txns) {
    const acct = accounts.get(t.accountId);
    if (!acct || !acct.onBudget) continue;
    if (accountId && t.accountId !== accountId) continue;
    if (isInternalTransfer(t, accounts)) continue;
    const isTransfer = !!t.transferAccountId;
    for (const p of expand(t)) {
      const cat = p.categoryId && p.categoryId !== 'split' ? p.categoryId : UNCAT;
      if (cat === RTA) {
        if (p.amount !== 0) income.push({ date: t.date, month: monthOf(t.date), amount: p.amount, categoryId: RTA, payeeId: t.payeeId ?? null, accountId: t.accountId });
        continue;
      }
      if (isTransfer && cat === UNCAT) continue; // plain move to a tracking account
      if (cat === UNCAT && p.amount > 0) continue;
      if (p.amount === 0) continue;
      spend.push({ date: t.date, month: monthOf(t.date), amount: -p.amount, categoryId: cat, payeeId: t.payeeId ?? null, accountId: t.accountId });
    }
  }
  return { spend, income };
}

const isCash = (a: Account | undefined) => !!a && a.onBudget && !isCreditType(a.type);

/** FIFO age of money: average age (days) of the last 10 outflows from budget cash accounts. */
export function ageOfMoney(txns: Txn[], accounts: Map<string, Account>): number | null {
  const ev: { date: string; amount: number }[] = [];
  for (const t of txns) {
    if (!isCash(accounts.get(t.accountId))) continue;
    if (t.transferAccountId && isCash(accounts.get(t.transferAccountId))) continue;
    if (t.amount !== 0) ev.push({ date: t.date, amount: t.amount });
  }
  ev.sort((a, b) => a.date.localeCompare(b.date) || b.amount - a.amount); // inflows first within a day
  const queue: { date: string; left: number }[] = [];
  let head = 0;
  const ages: number[] = [];
  for (const e of ev) {
    if (e.amount > 0) { queue.push({ date: e.date, left: e.amount }); continue; }
    let need = -e.amount;
    const need0 = need;
    let weighted = 0;
    while (need > 0 && head < queue.length) {
      const q = queue[head];
      const take = Math.min(q.left, need);
      weighted += take * Math.max(0, dayDiff(q.date, e.date));
      q.left -= take;
      need -= take;
      if (q.left <= 0) head++;
    }
    const matched = need0 - need;
    if (matched > 0) ages.push(weighted / matched);
  }
  if (!ages.length) return null;
  const last = ages.slice(-10);
  return Math.round(last.reduce((a, b) => a + b, 0) / last.length);
}

/** Balance of each account at the end of `date` (inclusive). */
export function balancesAt(txns: Txn[], date: string): Map<string, number> {
  const m = new Map<string, number>();
  for (const t of txns) if (t.date <= date) m.set(t.accountId, (m.get(t.accountId) ?? 0) + t.amount);
  return m;
}

export function niceScale(min: number, max: number, n = 4) {
  let lo = Math.min(0, min), hi = Math.max(0, max);
  if (hi - lo <= 0) hi = 10000;
  const raw = (hi - lo) / n;
  const pow = Math.pow(10, Math.floor(Math.log10(raw)));
  const f = raw / pow;
  const step = Math.max(100, (f <= 1 ? 1 : f <= 2 ? 2 : f <= 5 ? 5 : 10) * pow);
  lo = Math.floor(lo / step) * step;
  hi = Math.ceil(hi / step) * step;
  const ticks: number[] = [];
  for (let v = lo; v <= hi + 1e-6; v += step) ticks.push(v);
  return { lo, hi, ticks };
}
