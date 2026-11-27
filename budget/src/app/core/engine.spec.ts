import { computeBudget } from './engine';
import { Account, Assign, Category, RTA, Txn } from './models';
import { parseMoney } from './money';
import { parseQuick } from './quick-parse';
import { parseDate } from './util';

const acct = (id: string, type: Account['type'], onBudget = true): Account => ({ id, kind: 'account', updatedAt: 1, name: id, type, onBudget, sort: 0 });
const cat = (id: string, extra: Partial<Category> = {}): Category => ({ id, kind: 'category', updatedAt: 1, groupId: 'g', name: id, sort: 0, ...extra });
let n = 0;
const txn = (accountId: string, date: string, amount: number, categoryId: string | null, extra: Partial<Txn> = {}): Txn =>
  ({ id: 't' + n++, kind: 'txn', updatedAt: 1, accountId, date, amount, categoryId, cleared: 'cleared', approved: true, ...extra });
const asg = (month: string, categoryId: string, amount: number): Assign => ({ id: `a:${month}:${categoryId}`, kind: 'assign', updatedAt: 1, month, categoryId, amount });

describe('budget engine', () => {
  const accounts = [acct('chk', 'checking'), acct('visa', 'creditCard'), acct('car', 'asset', false)];
  const categories = [cat('food'), cat('rent'), cat('ccvisa', { ccAccountId: 'visa' })];

  it('computes ready to assign, carryover and overspending', () => {
    const s = computeBudget({
      accounts, categories,
      txns: [txn('chk', '2026-01-01', 100000, RTA), txn('chk', '2026-01-10', -30000, 'food'), txn('chk', '2026-02-05', -50000, 'food')],
      assigns: [asg('2026-01', 'food', 40000), asg('2026-01', 'rent', 50000)],
    }, '2026-03');
    expect(s.month('2026-01').rta).toBe(10000);
    expect(s.cat('2026-01', 'food').available).toBe(10000);
    expect(s.cat('2026-02', 'food').carry).toBe(10000);
    expect(s.cat('2026-02', 'food').available).toBe(-40000);
    expect(s.cat('2026-02', 'food').cashOver).toBe(40000);
    // cash overspending carries forward as a negative balance
    expect(s.cat('2026-03', 'food').available).toBe(-40000);
    expect(s.cat('2026-03', 'rent').available).toBe(50000);
  });

  it('moves funded credit spending to the payment category', () => {
    const s = computeBudget({
      accounts, categories,
      txns: [
        txn('chk', '2026-01-01', 100000, RTA),
        txn('visa', '2026-01-05', -30000, 'food'),
        txn('visa', '2026-01-06', -20000, 'food'), // only 10000 of this is funded
        // payment of 25000 from checking to visa
        txn('chk', '2026-01-20', -25000, null, { transferAccountId: 'visa' }),
        txn('visa', '2026-01-20', 25000, null, { transferAccountId: 'chk' }),
      ],
      assigns: [asg('2026-01', 'food', 40000)],
    }, '2026-02');
    const food = s.cat('2026-01', 'food');
    expect(food.available).toBe(-10000);
    expect(food.creditOver).toBe(10000);
    expect(food.cashOver).toBe(0);
    const cc = s.cat('2026-01', 'ccvisa');
    expect(cc.activity).toBe(40000 - 25000);
    expect(cc.available).toBe(15000);
    // credit overspending resets next month
    expect(s.cat('2026-02', 'food').available).toBe(0);
    expect(s.cat('2026-02', 'ccvisa').available).toBe(15000);
    expect(s.balances.get('visa')!.working).toBe(-25000);
  });

  it('protects money assigned in future months', () => {
    const s = computeBudget({
      accounts, categories,
      txns: [txn('chk', '2026-01-01', 100000, RTA)],
      assigns: [asg('2026-01', 'food', 50000), asg('2026-02', 'food', 30000)],
    }, '2026-02');
    expect(s.month('2026-01').rta).toBe(20000);
    expect(s.month('2026-02').rta).toBe(20000);
    expect(s.month('2026-01').assignedInFuture).toBe(30000);
  });

  it('treats tracking-account transfers as spending', () => {
    const s = computeBudget({
      accounts, categories,
      txns: [txn('chk', '2026-01-01', 100000, RTA), txn('chk', '2026-01-02', -20000, 'rent', { transferAccountId: 'car' }), txn('car', '2026-01-02', 20000, null, { transferAccountId: 'chk' })],
      assigns: [],
    }, '2026-01');
    expect(s.cat('2026-01', 'rent').activity).toBe(-20000);
    expect(s.balances.get('car')!.working).toBe(20000);
  });

  it('computes targets', () => {
    const cats = [cat('trip', { target: { type: 'byDate', amount: 120000, date: '2026-06' } }), cat('bills', { target: { type: 'monthly', amount: 5000, mode: 'set' } })];
    const s = computeBudget({ accounts, categories: cats, txns: [], assigns: [asg('2026-01', 'bills', 2000)] }, '2026-01');
    expect(s.cat('2026-01', 'trip').target!.need).toBe(20000);
    expect(s.cat('2026-01', 'bills').target!.underfunded).toBe(3000);
    expect(s.month('2026-01').underfunded).toBe(23000);
  });
});

describe('parsing', () => {
  it('parses money', () => {
    expect(parseMoney('1 234,56')).toBe(123456);
    expect(parseMoney('1,234.56')).toBe(123456);
    expect(parseMoney('1.234,56')).toBe(123456);
    expect(parseMoney('45')).toBe(4500);
    expect(parseMoney('12,5')).toBe(1250);
    expect(parseMoney('MAD 45.00')).toBe(4500);
    expect(parseMoney('120/3')).toBe(4000);
    expect(parseMoney('-20+5')).toBe(-1500);
    expect(parseMoney('abc')).toBeNull();
  });
  it('parses dates', () => {
    expect(parseDate('27/11/2026')).toBe('2026-11-27');
    expect(parseDate('3/2', 'dd/mm/yyyy', '2026-05-01')).toBe('2026-02-03');
    expect(parseDate('yesterday', 'dd/mm/yyyy', '2026-03-01')).toBe('2026-02-28');
    expect(parseDate('31/02/2026')).toBeNull();
  });
  it('parses quick entries', () => {
    const categories = [cat('groceries', { name: 'Groceries' }), cat('eat', { name: 'Eating out' })];
    const accounts = [acct('chk', 'checking'), { ...acct('cih', 'checking'), name: 'CIH Visa' }];
    const r = parseQuick('Marjane 245,50 groceries @cih', { categories, accounts, payees: [] });
    expect(r.amount).toBe(-24550);
    expect(r.payee).toBe('Marjane');
    expect(r.categoryId).toBe('groceries');
    expect(r.accountId).toBe('cih');
    const r2 = parseQuick('+12000 salary', { categories, accounts, payees: [] });
    expect(r2.amount).toBe(1200000);
    expect(r2.payee).toBe('salary');
  });
});

import { TestBed } from '@angular/core/testing';
import { Actions } from './actions';
import { Store } from './store';
import { loadDemo } from './seed';

describe('store transactions', () => {
  it('sees its own writes inside a transaction and undoes as one step', () => {
    const store = TestBed.inject(Store);
    const actions = TestBed.inject(Actions);
    loadDemo(actions, store);
    expect(store.groups().filter((g) => g.system === 'cc').length).toBe(1);
    expect(store.categories().filter((c) => c.ccAccountId).length).toBe(1);
    expect(store.txns().length).toBeGreaterThan(10);
    store.undo();
    expect(store.txns().length).toBe(0);
    expect(store.categories().length).toBe(0);
  });
});
