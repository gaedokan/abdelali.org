import { computed, inject, Injectable } from '@angular/core';
import { UNCAT } from '../core/engine';
import { RTA, SPLIT } from '../core/models';
import { formatMoney } from '../core/money';
import { Store } from '../core/store';
import { thisMonth } from '../core/util';
import { ComboItem } from './combo';

/** Ready-made item lists for <app-combo>. */
@Injectable({ providedIn: 'root' })
export class Pickers {
  private store = inject(Store);

  categoryItems(month = thisMonth(), opts: { split?: boolean; income?: boolean } = { income: true }): ComboItem[] {
    const snap = this.store.budget();
    const f = this.store.format();
    const items: ComboItem[] = [];
    if (opts.income !== false) items.push({ id: RTA, label: 'Ready to Assign', group: 'Inflow', emoji: '💰', hint: formatMoney(snap.month(month).rta, f, { currency: false }), keywords: 'income salary inflow' });
    if (opts.split) items.push({ id: SPLIT, label: 'Split (several categories)', group: 'Inflow', emoji: '✂️' });
    const groups = this.store.groups().filter((g) => !g.system);
    for (const g of groups) {
      for (const c of this.store.categories().filter((c) => c.groupId === g.id && !c.hidden)) {
        const av = snap.cat(month, c.id).available;
        items.push({
          id: c.id, label: c.name, group: g.name, emoji: c.emoji,
          hint: formatMoney(av, f, { currency: false }), hintTone: av < 0 ? 'neg' : av > 0 ? 'pos' : '',
        });
      }
    }
    return items;
  }

  readonly categories = computed(() => this.categoryItems(thisMonth(), { income: true }));
  readonly categoriesWithSplit = computed(() => this.categoryItems(thisMonth(), { income: true, split: true }));

  readonly accounts = computed<ComboItem[]>(() =>
    this.store.accounts().filter((a) => !a.closed).map((a) => ({
      id: a.id, label: a.name, group: a.onBudget ? 'Budget accounts' : 'Tracking accounts',
      hint: formatMoney(this.store.budget().balances.get(a.id)?.working ?? 0, this.store.format(), { currency: false }),
    })),
  );

  /** Payees plus "Transfer: <account>" entries (id prefixed with "transfer:"). */
  payeeItems(excludeAccountId?: string): ComboItem[] {
    const items: ComboItem[] = this.store.accounts()
      .filter((a) => !a.closed && a.id !== excludeAccountId)
      .map((a) => ({ id: 'transfer:' + a.id, label: `Transfer: ${a.name}`, group: 'Transfers', keywords: 'transfer ' + a.name }));
    const payees = this.store.payees().filter((p) => p.name !== 'Starting balance' && p.name !== 'Reconciliation balance adjustment');
    // most used first
    const count = new Map<string, number>();
    for (const t of this.store.txns()) if (t.payeeId) count.set(t.payeeId, (count.get(t.payeeId) ?? 0) + 1);
    payees.sort((a, b) => (count.get(b.id) ?? 0) - (count.get(a.id) ?? 0) || a.name.localeCompare(b.name));
    return [...payees.map((p) => ({ id: p.id, label: p.name, group: 'Payees' })), ...items];
  }

  categoryLabel(id: string | null | undefined): string {
    if (!id) return '';
    if (id === RTA) return 'Ready to Assign';
    if (id === SPLIT) return 'Split';
    if (id === UNCAT) return 'Uncategorised';
    return this.store.categoryMap().get(id)?.name ?? '(deleted)';
  }
}
