// Starter category templates and a demo budget.
import { Actions } from './actions';
import { AccountType, RTA } from './models';
import { Store } from './store';
import { addDays, addMonths, monthOf, thisMonth, today } from './util';

export const TEMPLATE: { group: string; items: { name: string; emoji: string }[] }[] = [
  { group: 'Bills', items: [
    { name: 'Rent', emoji: '🏠' }, { name: 'Electricity & water', emoji: '💡' }, { name: 'Phone & internet', emoji: '📶' },
    { name: 'Subscriptions', emoji: '🔁' }, { name: 'Insurance', emoji: '🛡️' },
  ] },
  { group: 'Everyday', items: [
    { name: 'Groceries', emoji: '🛒' }, { name: 'Eating out', emoji: '🍽️' }, { name: 'Transport', emoji: '🚕' },
    { name: 'Fuel', emoji: '⛽' }, { name: 'Health', emoji: '💊' }, { name: 'Personal care', emoji: '🧴' },
  ] },
  { group: 'Life', items: [
    { name: 'Shopping', emoji: '🛍️' }, { name: 'Fun', emoji: '🎉' }, { name: 'Gifts & family', emoji: '🎁' },
    { name: 'Travel', emoji: '✈️' }, { name: 'Education', emoji: '📚' },
  ] },
  { group: 'Savings & goals', items: [
    { name: 'Emergency fund', emoji: '🧯' }, { name: 'Eid & holidays', emoji: '🐑' }, { name: 'Car maintenance', emoji: '🔧' },
    { name: 'New phone', emoji: '📱' },
  ] },
];

export function applyTemplate(actions: Actions, store: Store, groups = TEMPLATE) {
  store.transact('Create categories', () => {
    for (const g of groups) {
      const grp = actions.addGroup(g.group);
      for (const it of g.items) actions.addCategory(grp.id, it.name, { emoji: it.emoji });
    }
  });
}

/** A realistic two-month demo so every screen has something to show. */
export function loadDemo(actions: Actions, store: Store) {
  store.transact('Load demo budget', () => {
    actions.updateSettings({ budgetName: 'Demo budget', onboarded: true });
    applyTemplate(actions, store);
    const cat = (name: string) => store.categories().find((c) => c.name === name)!.id;
    const m0 = addMonths(thisMonth(), -1), m1 = thisMonth();
    const d = (m: string, day: number) => `${m}-${String(day).padStart(2, '0')}`;
    const start = d(m0, 1);
    const acct = (name: string, type: AccountType, bal: number) => actions.addAccount(name, type, bal, start);
    const checking = acct('CIH Current', 'checking', 1_250_000);
    const savings = acct('Savings', 'savings', 3_000_000);
    const cash = acct('Cash wallet', 'cash', 80_000);
    const card = acct('Visa Card', 'creditCard', -120_000);
    acct('Car', 'asset', 9_500_000);

    for (const m of [m0, m1]) {
      const plan: [string, number][] = [
        ['Rent', 450_000], ['Electricity & water', 60_000], ['Phone & internet', 35_000], ['Subscriptions', 12_000],
        ['Groceries', 250_000], ['Eating out', 80_000], ['Transport', 50_000], ['Fuel', 60_000], ['Health', 30_000],
        ['Shopping', 60_000], ['Fun', 40_000], ['Gifts & family', 50_000], ['Emergency fund', 150_000], ['Eid & holidays', 50_000],
      ];
      for (const [n, a] of plan) actions.setAssigned(m, cat(n), a);
      actions.saveTxn({ accountId: checking.id, date: d(m, 1), amount: 1_400_000, payeeName: 'Employer', categoryId: RTA, cleared: 'cleared' });
      actions.saveTxn({ accountId: checking.id, date: d(m, 3), amount: -450_000, payeeName: 'Landlord', categoryId: cat('Rent'), cleared: 'cleared' });
      actions.saveTxn({ accountId: checking.id, date: d(m, 5), amount: -58_340, payeeName: 'Lydec', categoryId: cat('Electricity & water'), cleared: 'cleared' });
      actions.saveTxn({ accountId: checking.id, date: d(m, 6), amount: -34_900, payeeName: 'Maroc Telecom', categoryId: cat('Phone & internet'), cleared: 'cleared' });
      actions.saveTxn({ accountId: card.id, date: d(m, 7), amount: -11_900, payeeName: 'Netflix', categoryId: cat('Subscriptions'), cleared: 'cleared' });
    }
    const spend: [number, string, string, number, string][] = [
      // [day offset from today (negative), account, payee, amount, category]
      [-40, 'card', 'Marjane', -84_250, 'Groceries'], [-36, 'cash', 'Café Clock', -4_500, 'Eating out'],
      [-33, 'checking', 'Afriquia', -50_000, 'Fuel'], [-31, 'card', 'Carrefour', -61_320, 'Groceries'],
      [-29, 'cash', 'Petit taxi', -3_000, 'Transport'], [-27, 'card', 'Zara', -45_900, 'Shopping'],
      [-25, 'checking', 'Pharmacie Atlas', -12_870, 'Health'], [-22, 'card', 'Glovo', -15_600, 'Eating out'],
      [-18, 'card', 'Marjane', -92_110, 'Groceries'], [-15, 'cash', 'Hanout', -6_200, 'Groceries'],
      [-12, 'checking', 'Shell', -45_000, 'Fuel'], [-9, 'card', 'Glovo', -21_400, 'Eating out'],
      [-7, 'cash', 'Careem', -4_800, 'Transport'], [-5, 'card', 'Carrefour', -73_640, 'Groceries'],
      [-3, 'card', 'Cinéma Pathé', -14_000, 'Fun'], [-2, 'cash', 'Café Clock', -3_800, 'Eating out'],
      [-1, 'card', 'Decathlon', -32_900, 'Shopping'],
    ];
    const ids: Record<string, string> = { card: card.id, cash: cash.id, checking: checking.id };
    for (const [off, a, p, amt, c] of spend) {
      const date = addDays(today(), off);
      if (date < start) continue;
      actions.saveTxn({ accountId: ids[a], date, amount: amt, payeeName: p, categoryId: cat(c), cleared: off < -3 ? 'cleared' : 'uncleared' });
    }
    // card payment and a savings transfer
    actions.saveTxn({ accountId: checking.id, date: d(m0, 25), amount: -120_000, transferAccountId: card.id, cleared: 'cleared' });
    actions.saveTxn({ accountId: checking.id, date: d(m0, 26), amount: -150_000, transferAccountId: savings.id, cleared: 'cleared' });
    // targets
    actions.setTarget(cat('Rent'), { type: 'monthly', amount: 450_000, mode: 'set' });
    actions.setTarget(cat('Groceries'), { type: 'monthly', amount: 250_000, mode: 'refill' });
    actions.setTarget(cat('Eating out'), { type: 'weekly', amount: 20_000, weekday: 6, mode: 'set' });
    actions.setTarget(cat('Emergency fund'), { type: 'balance', amount: 3_000_000 });
    actions.setTarget(cat('Eid & holidays'), { type: 'byDate', amount: 600_000, date: addMonths(m1, 5) });
    actions.setTarget(cat('Car maintenance'), { type: 'yearly', amount: 240_000, month: Number(addMonths(m1, 3).slice(5)) });
    actions.setTarget(cat('New phone'), { type: 'byDate', amount: 900_000, date: addMonths(m1, 8) });
    // a scheduled bill
    const landlord = actions.payeeFor('Landlord');
    actions.saveScheduled({ accountId: checking.id, nextDate: `${addMonths(m1, 1)}-03`, frequency: 'monthly', amount: -450_000, payeeId: landlord.id, categoryId: cat('Rent') });
    void monthOf;
  });
}
