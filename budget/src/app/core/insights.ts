// Small budget health metrics shown in the budget inspector.
import { Account, isCreditType, RTA, Txn } from './models';
import { addDays, dayDiff, today } from './util';

/** Age of money: average age (days) of the money spent in the last 10 outflows, FIFO. */
export function ageOfMoney(txns: Txn[], accounts: Map<string, Account>): number | null {
  const cash = (t: Txn) => {
    const a = accounts.get(t.accountId);
    return !!a && a.onBudget && !isCreditType(a.type);
  };
  const list = txns
    .filter((t) => cash(t) && !(t.transferAccountId && accounts.get(t.transferAccountId)?.onBudget && !isCreditType(accounts.get(t.transferAccountId)!.type)))
    .sort((a, b) => a.date.localeCompare(b.date));
  const buckets: { date: string; left: number }[] = [];
  const ages: number[] = [];
  let head = 0;
  for (const t of list) {
    if (t.amount > 0) { buckets.push({ date: t.date, left: t.amount }); continue; }
    let need = -t.amount, weighted = 0, covered = 0;
    while (need > 0 && head < buckets.length) {
      const b = buckets[head];
      const take = Math.min(b.left, need);
      weighted += take * dayDiff(b.date, t.date);
      covered += take; need -= take; b.left -= take;
      if (b.left === 0) head++;
    }
    if (covered) ages.push(weighted / covered);
  }
  if (!ages.length) return null;
  const last = ages.slice(-10);
  return Math.round(last.reduce((a, b) => a + b, 0) / last.length);
}

/** How many days your cash would last at the recent spending rate. */
export function daysOfBuffer(txns: Txn[], accounts: Map<string, Account>, cashBalance: number): number | null {
  const from = addDays(today(), -90);
  let spent = 0;
  for (const t of txns) {
    if (t.date < from || t.date > today() || t.amount >= 0) continue;
    const a = accounts.get(t.accountId);
    if (!a?.onBudget || t.categoryId === RTA) continue;
    if (t.transferAccountId && accounts.get(t.transferAccountId)?.onBudget) continue;
    spent += -t.amount;
  }
  if (!spent) return null;
  return Math.max(0, Math.floor(cashBalance / (spent / 90)));
}
