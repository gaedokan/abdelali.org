// The budget engine: a pure function from entities to every month's numbers.
//
// Rules (zero-based / envelope budgeting):
//  * Income is any on-budget inflow categorised as Ready to Assign (RTA).
//  * Each month, available = carried over + assigned + activity.
//  * Positive balances roll over. Cash overspending (negative balance) also rolls over, so it
//    stays visible in its category until you cover it.
//  * Credit-card spending moves the funded part of the purchase from the category into that card's
//    payment category. The unfunded part becomes new card debt: the category is shown as
//    "overspent on credit" and resets to zero next month.
//  * Transfers between budget accounts are not spending. A payment to a card reduces its payment category.
//  * Ready to Assign for month m = min over k >= m of (income through k − assigned through k),
//    so money already promised to future months is never offered again.

import { Account, Assign, Category, isCreditType, RTA, SPLIT, Target, Txn } from './models';
import { addMonths, countWeekdayInMonth, monthDiff, monthOf, thisMonth } from './util';

export const UNCAT = 'uncat';

export interface TargetStatus {
  type: Target['type'];
  /** what should be assigned this month in total */
  need: number;
  /** still missing this month */
  underfunded: number;
  /** 0..1 */
  progress: number;
  /** goal total for byDate / yearly / balance */
  goal?: number;
  /** months left including this one (byDate / yearly) */
  monthsLeft?: number;
  done: boolean;
}

export interface CatMonth {
  carry: number;
  assigned: number;
  activity: number;
  available: number;
  /** amount overspent with cash / debit (must be covered) */
  cashOver: number;
  /** amount overspent with a credit card (became debt) */
  creditOver: number;
  /** credit card spending moved to payment categories this month */
  movedToCards: number;
  target?: TargetStatus;
}

export interface MonthData {
  month: string;
  cats: Map<string, CatMonth>;
  income: number;
  assigned: number;
  activity: number;
  available: number;
  rta: number;
  /** cumulative (income − assigned) through this month, before future-month protection */
  cumulative: number;
  assignedInFuture: number;
  underfunded: number;
  overspent: number;
}

export interface Balance { cleared: number; uncleared: number; working: number }

export interface Snapshot {
  first: string;
  last: string;
  months: Map<string, MonthData>;
  balances: Map<string, Balance>;
  month(m: string): MonthData;
  cat(m: string, categoryId: string): CatMonth;
}

export interface EngineInput {
  accounts: Account[];
  categories: Category[];
  txns: Txn[];
  assigns: Assign[];
}

const EMPTY_CAT: CatMonth = { carry: 0, assigned: 0, activity: 0, available: 0, cashOver: 0, creditOver: 0, movedToCards: 0 };

interface Line { date: string; amount: number; credit: boolean; card: string }

export function computeBudget(input: EngineInput, upto = thisMonth()): Snapshot {
  const accounts = new Map(input.accounts.filter((a) => !a.deleted).map((a) => [a.id, a]));
  const categories = input.categories.filter((c) => !c.deleted);
  const catIds = new Set(categories.map((c) => c.id));
  const ccCatByAccount = new Map<string, Category>();
  for (const c of categories) if (c.ccAccountId) ccCatByAccount.set(c.ccAccountId, c);

  // ---------------------------------------------------------------- balances + lines
  const balances = new Map<string, Balance>();
  for (const a of accounts.values()) balances.set(a.id, { cleared: 0, uncleared: 0, working: 0 });

  const lines = new Map<string, Map<string, Line[]>>(); // month -> categoryId -> lines
  const income = new Map<string, number>();
  const payments = new Map<string, Map<string, number>>(); // month -> card account -> amount (to add to payment activity)
  let first = thisMonth();
  let last = upto > thisMonth() ? upto : thisMonth();

  const addLine = (month: string, cat: string, l: Line) => {
    let m = lines.get(month);
    if (!m) lines.set(month, (m = new Map()));
    const arr = m.get(cat);
    if (arr) arr.push(l); else m.set(cat, [l]);
  };
  const add = <K>(map: Map<K, number>, k: K, v: number) => map.set(k, (map.get(k) ?? 0) + v);

  for (const t of input.txns) {
    if (t.deleted) continue;
    const acct = accounts.get(t.accountId);
    if (!acct) continue;
    const b = balances.get(acct.id)!;
    if (t.cleared === 'uncleared') b.uncleared += t.amount; else b.cleared += t.amount;
    b.working += t.amount;
    if (!acct.onBudget) continue;

    const month = monthOf(t.date);
    if (month < first) first = month;
    if (month > last) last = month;
    const credit = isCreditType(acct.type);

    const other = t.transferAccountId ? accounts.get(t.transferAccountId) : undefined;
    if (other && other.onBudget) {
      // budget-to-budget transfer: only card payments matter
      if (credit && ccCatByAccount.has(acct.id)) {
        let pm = payments.get(month);
        if (!pm) payments.set(month, (pm = new Map()));
        add(pm, acct.id, -t.amount);
      }
      continue;
    }

    const parts = t.categoryId === SPLIT && t.splits?.length
      ? t.splits.map((s) => ({ amount: s.amount, categoryId: s.categoryId }))
      : [{ amount: t.amount, categoryId: t.categoryId }];
    for (const p of parts) {
      if (p.categoryId === RTA) { add(income, month, p.amount); continue; }
      // a transaction with no category that is the starting balance of a card is just existing debt
      if (!p.categoryId && t.source === 'start') continue;
      const cat = p.categoryId && catIds.has(p.categoryId) ? p.categoryId : UNCAT;
      addLine(month, cat, { date: t.date, amount: p.amount, credit, card: acct.id });
    }
  }

  for (const a of input.assigns) {
    if (a.deleted || !a.amount) continue;
    if (a.month < first) first = a.month;
    if (a.month > last) last = a.month;
  }
  const assignMap = new Map<string, Map<string, number>>(); // month -> cat -> amount
  for (const a of input.assigns) {
    if (a.deleted || !a.amount || !catIds.has(a.categoryId)) continue;
    let m = assignMap.get(a.month);
    if (!m) assignMap.set(a.month, (m = new Map()));
    add(m, a.categoryId, a.amount);
  }

  // ---------------------------------------------------------------- month by month
  const normal = categories.filter((c) => !c.ccAccountId);
  const cards = categories.filter((c) => c.ccAccountId);
  const months = new Map<string, MonthData>();
  let carry = new Map<string, number>();
  let cumulative = 0;

  for (let m = first; m <= last; m = addMonths(m, 1)) {
    const cats = new Map<string, CatMonth>();
    const mLines = lines.get(m);
    const mAssign = assignMap.get(m);
    const fund = new Map<string, number>(); // card -> funded spending moved in
    const nextCarry = new Map<string, number>();
    let monthAssigned = 0, monthActivity = 0, monthAvailable = 0, underfunded = 0, overspent = 0;

    const doCategory = (id: string, cat: Category | null) => {
      const c0 = carry.get(id) ?? 0;
      const assigned = mAssign?.get(id) ?? 0;
      const ls = mLines?.get(id) ?? [];
      let cashAct = 0;
      const creditLines: Line[] = [];
      for (const l of ls) (l.credit ? creditLines.push(l) : (cashAct += l.amount));
      const a0 = c0 + assigned + cashAct;
      let remaining = Math.max(0, a0), creditAct = 0, unfunded = 0, moved = 0;
      creditLines.sort((x, y) => x.date.localeCompare(y.date));
      for (const l of creditLines) {
        creditAct += l.amount;
        if (l.amount < 0) {
          const f = Math.min(remaining, -l.amount);
          remaining -= f;
          unfunded += -l.amount - f;
          if (f) { add(fund, l.card, f); moved += f; }
        } else {
          // refund on a card: money goes back from the payment category to this category
          add(fund, l.card, -l.amount);
          moved -= l.amount;
          remaining += l.amount;
        }
      }
      // card payment categories also receive funded spending + payments
      let extra = 0;
      if (cat?.ccAccountId) extra = (fund.get(cat.ccAccountId) ?? 0) + (payments.get(m)?.get(cat.ccAccountId) ?? 0);
      const activity = cashAct + creditAct + extra;
      const available = c0 + assigned + activity;
      let cashOver = 0, creditOver = 0;
      if (available < 0) {
        creditOver = Math.min(-available, unfunded);
        cashOver = -available - creditOver;
      }
      const cm: CatMonth = { carry: c0, assigned, activity, available, cashOver, creditOver, movedToCards: moved };
      if (cat?.target) cm.target = targetStatus(cat.target, m, cm);
      cats.set(id, cm);
      nextCarry.set(id, available < 0 ? -cashOver : available);
      monthAssigned += assigned;
      monthActivity += activity;
      monthAvailable += available;
      if (cm.target && !cat?.hidden) underfunded += cm.target.underfunded;
      if (available < 0) overspent++;
    };

    for (const c of normal) doCategory(c.id, c);
    doCategory(UNCAT, null);
    for (const c of cards) doCategory(c.id, c);

    cumulative += (income.get(m) ?? 0) - monthAssigned;
    months.set(m, {
      month: m, cats, income: income.get(m) ?? 0, assigned: monthAssigned, activity: monthActivity,
      available: monthAvailable, rta: 0, cumulative, assignedInFuture: 0, underfunded, overspent,
    });
    carry = nextCarry;
  }

  // Ready to Assign: protect money assigned in future months.
  const order = [...months.keys()];
  let minAhead = Infinity, futureAssigned = 0;
  for (let i = order.length - 1; i >= 0; i--) {
    const md = months.get(order[i])!;
    minAhead = Math.min(minAhead, md.cumulative);
    md.rta = minAhead;
    md.assignedInFuture = futureAssigned;
    futureAssigned += md.assigned;
  }

  const lastMonth = order[order.length - 1];
  const snapshot: Snapshot = {
    first, last, months, balances,
    month(m: string) {
      const md = months.get(m);
      if (md) return md;
      // months after the last computed one: balances carry forward, nothing assigned
      if (m > lastMonth) return projectMonth(months.get(lastMonth)!, m, categories);
      return { month: m, cats: new Map(), income: 0, assigned: 0, activity: 0, available: 0, rta: 0, cumulative: 0, assignedInFuture: 0, underfunded: 0, overspent: 0 };
    },
    cat(m: string, id: string) {
      return snapshot.month(m).cats.get(id) ?? EMPTY_CAT;
    },
  };
  return snapshot;
}

function projectMonth(prev: MonthData, m: string, categories: Category[]): MonthData {
  const cats = new Map<string, CatMonth>();
  let available = 0, underfunded = 0;
  const catById = new Map(categories.map((c) => [c.id, c]));
  for (const [id, cm] of prev.cats) {
    const c0 = cm.available < 0 ? -cm.cashOver : cm.available;
    const next: CatMonth = { carry: c0, assigned: 0, activity: 0, available: c0, cashOver: c0 < 0 ? -c0 : 0, creditOver: 0, movedToCards: 0 };
    const cat = catById.get(id);
    if (cat?.target) {
      next.target = targetStatus(cat.target, m, next);
      if (!cat.hidden) underfunded += next.target.underfunded;
    }
    available += c0;
    cats.set(id, next);
  }
  return { month: m, cats, income: 0, assigned: 0, activity: 0, available, rta: prev.rta, cumulative: prev.cumulative, assignedInFuture: 0, underfunded, overspent: 0 };
}

// ------------------------------------------------------------------ targets

export function targetMonth(t: Target, month: string): string | null {
  if (t.type === 'byDate') return t.date ?? null;
  if (t.type === 'yearly') {
    const mm = String(t.month ?? 12).padStart(2, '0');
    const y = Number(month.slice(0, 4));
    const candidate = `${y}-${mm}`;
    return candidate >= month ? candidate : `${y + 1}-${mm}`;
  }
  return null;
}

export function targetStatus(t: Target, month: string, cm: Pick<CatMonth, 'carry' | 'assigned' | 'activity' | 'available'>): TargetStatus {
  const clamp = (x: number) => Math.max(0, Math.min(1, x));
  switch (t.type) {
    case 'monthly':
    case 'weekly': {
      const need = t.type === 'weekly' ? t.amount * countWeekdayInMonth(month, t.weekday ?? 1) : t.amount;
      if (t.mode === 'refill') {
        const have = Math.max(0, cm.carry) + cm.assigned;
        const under = Math.max(0, need - have);
        return { type: t.type, need, underfunded: under, progress: need ? clamp(have / need) : 1, done: under === 0 };
      }
      const under = Math.max(0, need - cm.assigned);
      return { type: t.type, need, underfunded: under, progress: need ? clamp(cm.assigned / need) : 1, done: under === 0 };
    }
    case 'byDate':
    case 'yearly': {
      const tm = targetMonth(t, month);
      const goal = t.amount;
      if (!tm || month > tm) {
        return { type: t.type, need: 0, underfunded: 0, progress: clamp(cm.available / (goal || 1)), goal, monthsLeft: 0, done: cm.available >= goal };
      }
      const monthsLeft = monthDiff(month, tm) + 1;
      const start = Math.max(0, cm.carry);
      const perMonth = Math.max(0, Math.ceil((goal - start) / monthsLeft));
      const under = Math.max(0, perMonth - cm.assigned);
      const have = start + cm.assigned;
      return { type: t.type, need: perMonth, underfunded: under, progress: goal ? clamp(have / goal) : 1, goal, monthsLeft, done: have >= goal };
    }
    case 'balance': {
      const goal = t.amount;
      return { type: 'balance', need: 0, underfunded: 0, progress: goal ? clamp(cm.available / goal) : 1, goal, done: cm.available >= goal };
    }
  }
}
