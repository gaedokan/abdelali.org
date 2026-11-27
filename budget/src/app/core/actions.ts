import { inject, Injectable } from '@angular/core';
import { UNCAT } from './engine';
import {
  Account, AccountType, ACCOUNT_TYPES, Assign, assignId, Category, Cleared, Frequency, Group, isCreditType, Payee,
  RTA, Scheduled, Split, SPLIT, Target, Txn,
} from './models';
import { Store } from './store';
import { addDays, addMonths, addMonthsToDate, dayDiff, monthOf, norm, today, uid } from './util';

export interface TxnInput {
  id?: string;
  accountId: string;
  date: string;
  amount: number;
  payeeName?: string;
  payeeId?: string | null;
  categoryId?: string | null;
  transferAccountId?: string | null;
  memo?: string;
  cleared?: Cleared;
  approved?: boolean;
  flag?: Txn['flag'];
  splits?: Split[];
  source?: Txn['source'];
  importId?: string;
}

@Injectable({ providedIn: 'root' })
export class Actions {
  private store = inject(Store);

  // ------------------------------------------------------------- settings
  updateSettings(fields: Partial<import('./models').Settings>) {
    const cur = this.store.settings();
    this.store.put({ ...cur, ...fields, id: 'settings', kind: 'settings' });
  }

  // ------------------------------------------------------------- budget
  setAssigned(month: string, categoryId: string, amount: number) {
    const id = assignId(month, categoryId);
    const cur = this.store.get<Assign>(id);
    if ((cur?.amount ?? 0) === amount) return;
    this.store.put<Assign>({ id, kind: 'assign', month, categoryId, amount });
  }

  addAssigned(month: string, categoryId: string, delta: number) {
    const cur = this.store.get<Assign>(assignId(month, categoryId))?.amount ?? 0;
    this.setAssigned(month, categoryId, cur + delta);
  }

  /** Move money between categories (or to/from Ready to Assign when id is RTA). */
  moveMoney(month: string, fromId: string, toId: string, amount: number) {
    if (!amount || fromId === toId) return;
    this.store.transact('Move money', () => {
      if (fromId !== RTA) this.addAssigned(month, fromId, -amount);
      if (toId !== RTA) this.addAssigned(month, toId, amount);
    });
  }

  /** Assign many categories at once: map of categoryId -> new assigned amount. */
  bulkAssign(month: string, amounts: Map<string, number>, label: string) {
    this.store.transact(label, () => {
      for (const [cat, amt] of amounts) this.setAssigned(month, cat, amt);
    });
  }

  // ------------------------------------------------------------- categories
  addGroup(name: string): Group {
    const sort = Math.max(0, ...this.store.groups().map((g) => g.sort)) + 1;
    return this.store.put<Group>({ id: uid(), kind: 'group', name, sort });
  }

  addCategory(groupId: string, name: string, extra: Partial<Category> = {}): Category {
    const sort = Math.max(0, ...this.store.categories().filter((c) => c.groupId === groupId).map((c) => c.sort)) + 1;
    return this.store.put<Category>({ id: uid(), kind: 'category', groupId, name, sort, ...extra });
  }

  setTarget(categoryId: string, target: Target | undefined) {
    const c = this.store.get<Category>(categoryId);
    if (!c) return;
    const next = { ...c, target };
    if (!target) delete next.target;
    this.store.put(next);
  }

  /** Delete a category, moving its transactions and assigned money to `replacementId` (or uncategorised). */
  deleteCategory(categoryId: string, replacementId: string | null) {
    this.store.transact('Delete category', () => {
      for (const t of this.store.txns()) {
        if (t.categoryId === categoryId) this.store.put({ ...t, categoryId: replacementId });
        else if (t.categoryId === SPLIT && t.splits?.some((s) => s.categoryId === categoryId)) {
          this.store.put({ ...t, splits: t.splits.map((s) => (s.categoryId === categoryId ? { ...s, categoryId: replacementId } : s)) });
        }
      }
      for (const a of this.store.assigns().filter((a) => a.categoryId === categoryId)) {
        if (replacementId && replacementId !== UNCAT) this.addAssigned(a.month, replacementId, a.amount);
        this.store.remove(a.id);
      }
      for (const s of this.store.scheduled().filter((s) => s.categoryId === categoryId)) this.store.put({ ...s, categoryId: replacementId });
      for (const p of this.store.payees().filter((p) => p.categoryId === categoryId)) this.store.put({ ...p, categoryId: replacementId ?? undefined });
      this.store.remove(categoryId);
    });
  }

  deleteGroup(groupId: string, replacementId: string | null) {
    this.store.transact('Delete group', () => {
      for (const c of this.store.categories().filter((c) => c.groupId === groupId)) this.deleteCategory(c.id, replacementId);
      this.store.remove(groupId);
    });
  }

  /** Reorder: place `id` before `beforeId` (or at the end) inside group `groupId`. */
  moveCategory(id: string, groupId: string, beforeId: string | null) {
    const list = this.store.categories().filter((c) => c.groupId === groupId && c.id !== id);
    const idx = beforeId ? list.findIndex((c) => c.id === beforeId) : list.length;
    const cat = this.store.get<Category>(id);
    if (!cat) return;
    list.splice(idx < 0 ? list.length : idx, 0, cat);
    this.store.transact('Reorder', () => list.forEach((c, i) => {
      if (c.sort !== i + 1 || c.groupId !== groupId) this.store.put({ ...c, groupId, sort: i + 1 });
    }));
  }

  moveGroup(id: string, beforeId: string | null) {
    const list = this.store.groups().filter((g) => !g.system && g.id !== id);
    const g = this.store.get<Group>(id);
    if (!g) return;
    const idx = beforeId ? list.findIndex((x) => x.id === beforeId) : list.length;
    list.splice(idx < 0 ? list.length : idx, 0, g);
    this.store.transact('Reorder', () => list.forEach((x, i) => x.sort !== i + 1 && this.store.put({ ...x, sort: i + 1 })));
  }

  // ------------------------------------------------------------- accounts
  addAccount(name: string, type: AccountType, balance: number, date = today(), onBudget?: boolean): Account {
    return this.store.transact('Add account', () => {
      const budget = onBudget ?? ACCOUNT_TYPES.find((t) => t.type === type)!.budget;
      const sort = Math.max(0, ...this.store.accounts().map((a) => a.sort)) + 1;
      const acct = this.store.put<Account>({ id: uid(), kind: 'account', name, type, onBudget: budget, sort });
      if (budget && isCreditType(type)) this.ensureCardCategory(acct);
      if (balance) {
        const payee = this.payeeFor('Starting balance');
        this.store.put<Txn>({
          id: uid(), kind: 'txn', accountId: acct.id, date, amount: balance, payeeId: payee.id,
          // cash goes to Ready to Assign; card debt is existing debt (not this month's spending)
          categoryId: budget && (balance > 0 || !isCreditType(type)) ? RTA : null,
          cleared: 'cleared', approved: true, source: 'start',
        });
      }
      return acct;
    });
  }

  ensureCardCategory(acct: Account) {
    let group = this.store.groups().find((g) => g.system === 'cc');
    if (!group) group = this.store.put<Group>({ id: uid(), kind: 'group', name: 'Credit card payments', sort: 0, system: 'cc' });
    const existing = this.store.categories().find((c) => c.ccAccountId === acct.id);
    if (existing) {
      if (existing.name !== acct.name) this.store.put({ ...existing, name: acct.name });
      return existing;
    }
    return this.addCategory(group.id, acct.name, { ccAccountId: acct.id });
  }

  updateAccount(id: string, fields: Partial<Account>) {
    this.store.transact('Edit account', () => {
      const a = this.store.patch<Account>(id, fields);
      if (a && a.onBudget && isCreditType(a.type) && !a.closed) this.ensureCardCategory(a);
    });
  }

  deleteAccount(id: string) {
    this.store.transact('Delete account', () => {
      for (const t of this.store.txns().filter((t) => t.accountId === id || t.transferAccountId === id)) {
        if (t.accountId === id) this.store.remove(t.id);
        else this.store.put({ ...t, transferAccountId: null, transferTxnId: null });
      }
      for (const s of this.store.scheduled().filter((s) => s.accountId === id)) this.store.remove(s.id);
      const cc = this.store.categories().find((c) => c.ccAccountId === id);
      if (cc) this.deleteCategory(cc.id, null);
      this.store.remove(id);
    });
  }

  // ------------------------------------------------------------- payees
  payeeFor(name: string): Payee {
    const n = norm(name);
    const found = this.store.payees().find((p) => norm(p.name) === n)
      ?? this.store.payees().find((p) => p.aliases?.some((a) => a && n.includes(a)));
    if (found) return found;
    return this.store.put<Payee>({ id: uid(), kind: 'payee', name: name.trim() });
  }

  /** Best category guess for a payee name (remembered category). */
  suggestCategory(payeeName: string): string | null {
    const n = norm(payeeName);
    if (!n) return null;
    const p = this.store.payees().find((p) => norm(p.name) === n)
      ?? this.store.payees().find((p) => p.aliases?.some((a) => a && n.includes(a)));
    return p?.categoryId ?? null;
  }

  mergePayees(keepId: string, mergeIds: string[]) {
    this.store.transact('Merge payees', () => {
      const keep = this.store.get<Payee>(keepId)!;
      const aliases = new Set(keep.aliases ?? []);
      for (const id of mergeIds) {
        const p = this.store.get<Payee>(id);
        if (!p || id === keepId) continue;
        aliases.add(norm(p.name));
        for (const t of this.store.txns().filter((t) => t.payeeId === id)) this.store.put({ ...t, payeeId: keepId });
        for (const s of this.store.scheduled().filter((s) => s.payeeId === id)) this.store.put({ ...s, payeeId: keepId });
        this.store.remove(id);
      }
      this.store.put({ ...keep, aliases: [...aliases] });
    });
  }

  // ------------------------------------------------------------- transactions
  /** Create or update a transaction, keeping transfer pairs in sync and remembering payee categories. */
  saveTxn(input: TxnInput): Txn {
    return this.store.transact(input.id ? 'Edit transaction' : 'Add transaction', () => {
      const prev = input.id ? this.store.get<Txn>(input.id) : undefined;
      const acct = this.store.get<Account>(input.accountId)!;
      const other = input.transferAccountId ? this.store.get<Account>(input.transferAccountId) : undefined;

      let payeeId = input.payeeId ?? null;
      if (!other && input.payeeName !== undefined) payeeId = input.payeeName.trim() ? this.payeeFor(input.payeeName).id : null;
      if (other) payeeId = null;

      // categories only make sense when money leaves/enters the budget
      let categoryId = input.categoryId ?? null;
      let splits = input.splits;
      if (other && acct.onBudget === other.onBudget) { categoryId = null; splits = undefined; }
      if (!acct.onBudget) { categoryId = null; splits = undefined; }
      if (categoryId !== SPLIT) splits = undefined;

      const txn: Txn = {
        ...(prev ?? {}),
        id: prev?.id ?? uid(),
        kind: 'txn',
        accountId: acct.id,
        date: input.date,
        amount: splits ? splits.reduce((s, x) => s + x.amount, 0) : input.amount,
        payeeId,
        categoryId,
        splits,
        memo: input.memo ?? prev?.memo ?? '',
        cleared: input.cleared ?? prev?.cleared ?? 'uncleared',
        approved: input.approved ?? true,
        flag: input.flag === undefined ? prev?.flag ?? null : input.flag,
        transferAccountId: other?.id ?? null,
        transferTxnId: prev?.transferTxnId ?? null,
        source: prev?.source ?? input.source ?? 'manual',
        importId: prev?.importId ?? input.importId,
        updatedAt: 0,
      };

      // transfer bookkeeping
      const prevPair = prev?.transferTxnId ? this.store.get<Txn>(prev.transferTxnId) : undefined;
      if (other) {
        const pairId = prevPair && prevPair.accountId === other.id ? prevPair.id : uid();
        if (prevPair && prevPair.id !== pairId) this.store.remove(prevPair.id);
        txn.transferTxnId = pairId;
        // the on-budget side of a budget↔tracking transfer carries the category
        const pairCategory = other.onBudget && !acct.onBudget ? input.categoryId ?? null : null;
        const pair: Txn = {
          ...(prevPair && prevPair.id === pairId ? prevPair : { cleared: 'uncleared' as Cleared, flag: null, memo: '' }),
          id: pairId, kind: 'txn', accountId: other.id, date: txn.date, amount: -txn.amount, payeeId: null,
          categoryId: pairCategory, memo: txn.memo, approved: true, transferAccountId: acct.id, transferTxnId: txn.id,
          source: txn.source, updatedAt: 0,
        } as Txn;
        this.store.put<Txn>(pair);
      } else if (prevPair) {
        this.store.remove(prevPair.id);
        txn.transferTxnId = null;
      }

      const saved = this.store.put<Txn>(txn);
      if (payeeId && categoryId && categoryId !== SPLIT && categoryId !== RTA) {
        const p = this.store.get<Payee>(payeeId);
        if (p && p.categoryId !== categoryId) this.store.put({ ...p, categoryId });
      }
      if (this.store.settings().lastAccountId !== acct.id && acct.onBudget) {
        const s = this.store.settings();
        this.store.put({ ...s, lastAccountId: acct.id });
      }
      return saved;
    });
  }

  deleteTxns(ids: string[]) {
    this.store.transact(ids.length > 1 ? `Delete ${ids.length} transactions` : 'Delete transaction', () => {
      for (const id of ids) {
        const t = this.store.get<Txn>(id);
        if (!t) continue;
        if (t.transferTxnId) this.store.remove(t.transferTxnId);
        this.store.remove(id);
      }
    });
  }

  patchTxns(ids: string[], fields: Partial<Txn>, label = 'Edit transactions') {
    this.store.transact(label, () => {
      for (const id of ids) {
        const t = this.store.get<Txn>(id);
        if (!t) continue;
        const next = { ...t, ...fields };
        if ('categoryId' in fields && (t.transferAccountId && this.store.get<Account>(t.transferAccountId)?.onBudget)) next.categoryId = null;
        if ('categoryId' in fields && fields.categoryId !== SPLIT) delete next.splits;
        this.store.put(next);
        if ('categoryId' in fields && t.payeeId && fields.categoryId && fields.categoryId !== RTA && fields.categoryId !== SPLIT) {
          const p = this.store.get<Payee>(t.payeeId);
          if (p && p.categoryId !== fields.categoryId) this.store.put({ ...p, categoryId: fields.categoryId });
        }
      }
    });
  }

  toggleCleared(id: string) {
    const t = this.store.get<Txn>(id);
    if (!t || t.cleared === 'reconciled') return;
    this.store.patch<Txn>(id, { cleared: t.cleared === 'cleared' ? 'uncleared' : 'cleared' });
  }

  /** Reconcile: mark cleared as reconciled; add an adjustment if the bank balance differs. */
  reconcile(accountId: string, bankBalance: number) {
    this.store.transact('Reconcile', () => {
      const bal = this.store.budget().balances.get(accountId)!;
      const diff = bankBalance - bal.cleared;
      if (diff) {
        const acct = this.store.get<Account>(accountId)!;
        const payee = this.payeeFor('Reconciliation balance adjustment');
        this.store.put<Txn>({
          id: uid(), kind: 'txn', accountId, date: today(), amount: diff, payeeId: payee.id,
          categoryId: acct.onBudget ? RTA : null, cleared: 'reconciled', approved: true, source: 'reconcile',
        });
      }
      for (const t of this.store.txns()) if (t.accountId === accountId && t.cleared === 'cleared') this.store.put({ ...t, cleared: 'reconciled' });
    });
  }

  // ------------------------------------------------------------- scheduled
  saveScheduled(s: Omit<Scheduled, 'kind' | 'updatedAt' | 'id'> & { id?: string }) {
    return this.store.put<Scheduled>({ ...s, id: s.id ?? uid(), kind: 'scheduled' });
  }

  static nextOccurrence(date: string, f: Frequency): string | null {
    switch (f) {
      case 'once': return null;
      case 'weekly': return addDays(date, 7);
      case 'every2weeks': return addDays(date, 14);
      case 'twiceMonthly': {
        const d = Number(date.slice(8, 10));
        return d < 15 ? `${monthOf(date)}-15` : `${addMonths(monthOf(date), 1)}-01`;
      }
      case 'monthly': return addMonthsToDate(date, 1);
      case 'every2months': return addMonthsToDate(date, 2);
      case 'every3months': return addMonthsToDate(date, 3);
      case 'every6months': return addMonthsToDate(date, 6);
      case 'yearly': return addMonthsToDate(date, 12);
    }
  }

  /** Enter one occurrence of a scheduled transaction now and advance it. */
  enterScheduled(id: string, date?: string) {
    const s = this.store.get<Scheduled>(id);
    if (!s) return;
    this.store.transact('Enter scheduled transaction', () => {
      this.saveTxn({
        accountId: s.accountId, date: date ?? s.nextDate, amount: s.amount, payeeId: s.payeeId,
        categoryId: s.categoryId, transferAccountId: s.transferAccountId, memo: s.memo, flag: s.flag, source: 'scheduled',
      });
      this.skipScheduled(id);
    });
  }

  skipScheduled(id: string) {
    const s = this.store.get<Scheduled>(id);
    if (!s) return;
    const next = Actions.nextOccurrence(s.nextDate, s.frequency);
    if (next) this.store.put({ ...s, nextDate: next });
    else this.store.remove(id);
  }

  /** Enter every scheduled transaction that is due (called on start-up and once a day). */
  enterDue() {
    const t = today();
    const due = this.store.scheduled().filter((s) => s.nextDate <= t);
    if (!due.length) return 0;
    let n = 0;
    this.store.transact('Enter due transactions', () => {
      for (const s0 of due) {
        let guard = 0;
        let s = this.store.get<Scheduled>(s0.id);
        while (s && s.nextDate <= t && guard++ < 60) {
          this.enterScheduled(s.id);
          n++;
          s = this.store.get<Scheduled>(s0.id);
        }
      }
    });
    return n;
  }

  // ------------------------------------------------------------- import helpers
  /** Is there already a transaction that looks like this one (same amount, close date)? */
  findMatch(accountId: string, date: string, amount: number, importId?: string): Txn | undefined {
    const txns = this.store.txns().filter((t) => t.accountId === accountId);
    if (importId) {
      const byId = txns.find((t) => t.importId === importId);
      if (byId) return byId;
    }
    return txns.find((t) => !t.importId && t.amount === amount && Math.abs(dayDiff(t.date, date)) <= 4 && t.source !== 'start');
  }
}
