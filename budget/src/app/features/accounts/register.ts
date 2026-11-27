import { ChangeDetectionStrategy, Component, computed, effect, inject, input, signal, untracked } from '@angular/core';
import { Router, RouterLink } from '@angular/router';
import { Actions } from '../../core/actions';
import { ACCOUNT_TYPES, Flag, isCreditType, RTA, SPLIT, Txn } from '../../core/models';
import { parseMoney } from '../../core/money';
import { Store } from '../../core/store';
import { fuzzy, today } from '../../core/util';
import { Combo } from '../../ui/combo';
import { Icon } from '../../ui/icon';
import { DatePipe, MoneyPipe } from '../../ui/money.pipe';
import { Pickers } from '../../ui/pickers';
import { Sheet } from '../../ui/sheet';
import { Toasts } from '../../ui/toast';
import { UiState } from '../../ui/ui-state';
import { FLAGS, TxnForm } from './txn-form';

type View = 'all' | 'review' | 'uncleared' | 'flagged';

interface Line {
  t: Txn;
  payee: string;
  category: string;
  account: string;
  balance: number | null;
  transfer: boolean;
}

const PAGE = 150;

@Component({
  selector: 'app-register',
  imports: [Icon, MoneyPipe, DatePipe, TxnForm, Sheet, Combo, RouterLink],
  changeDetection: ChangeDetectionStrategy.OnPush,
  templateUrl: './register.html',
  styleUrl: './register.scss',
})
export class Register {
  readonly store = inject(Store);
  readonly ui = inject(UiState);
  private actions = inject(Actions);
  private pickers = inject(Pickers);
  private toasts = inject(Toasts);
  private router = inject(Router);

  /** route params */
  readonly id = input<string | undefined>(undefined);
  readonly q = input<string | undefined>(undefined);

  readonly search = signal('');
  readonly view = signal<View>('all');
  readonly editing = signal<string | null>(null);   // txn id or 'new'
  readonly selected = signal<Set<string>>(new Set());
  readonly limit = signal(PAGE);
  readonly reconcileOpen = signal(false);
  readonly reconcileStep = signal<'ask' | 'enter'>('ask');
  readonly bankBalance = signal('');
  readonly bulkCategory = signal<string | null>(null);
  readonly atmOpen = signal(false);
  readonly atmFrom = signal<string | null>(null);
  readonly atmAmount = signal('');
  readonly wide = signal(typeof window === 'undefined' || window.matchMedia('(min-width: 900px)').matches);
  readonly flags = FLAGS;
  readonly today = today();
  readonly Set = Set;

  readonly account = computed(() => (this.id() ? this.store.accountMap().get(this.id()!) ?? null : null));
  readonly typeLabel = computed(() => ACCOUNT_TYPES.find((t) => t.type === this.account()?.type)?.label ?? '');
  readonly balance = computed(() => {
    const b = this.store.budget().balances;
    const a = this.account();
    if (a) return b.get(a.id) ?? { cleared: 0, uncleared: 0, working: 0 };
    const tot = { cleared: 0, uncleared: 0, working: 0 };
    for (const acc of this.store.accounts()) {
      if (!acc.onBudget) continue;
      const x = b.get(acc.id);
      if (x) { tot.cleared += x.cleared; tot.uncleared += x.uncleared; tot.working += x.working; }
    }
    return tot;
  });
  readonly cardInfo = computed(() => {
    const a = this.account();
    if (!a || !a.onBudget || !isCreditType(a.type)) return null;
    const cat = this.store.categories().find((c) => c.ccAccountId === a.id);
    const avail = cat ? this.store.budget().cat(this.ui.month(), cat.id).available : 0;
    return { available: avail, categoryId: cat?.id };
  });

  readonly allLines = computed<Line[]>(() => {
    const a = this.account();
    const pm = this.store.payeeMap();
    const am = this.store.accountMap();
    const txns = this.store.txns().filter((t) => (a ? t.accountId === a.id : am.get(t.accountId)?.onBudget));
    // running balance for a single account (txns are newest first)
    let running = a ? this.balance().working : 0;
    return txns.map((t) => {
      const line: Line = {
        t,
        payee: t.transferAccountId ? `Transfer ${t.amount < 0 ? 'to' : 'from'} ${am.get(t.transferAccountId)?.name ?? '?'}` : pm.get(t.payeeId ?? '')?.name ?? '',
        category: this.categoryText(t),
        account: am.get(t.accountId)?.name ?? '',
        balance: a ? running : null,
        transfer: !!t.transferAccountId,
      };
      if (a) running -= t.amount;
      return line;
    });
  });

  readonly lines = computed(() => {
    const q = this.search().trim();
    const v = this.view();
    let ls = this.allLines();
    if (v === 'review') ls = ls.filter((l) => !l.t.approved || (!l.t.categoryId && !l.transfer && this.needsCat(l.t)));
    if (v === 'uncleared') ls = ls.filter((l) => l.t.cleared === 'uncleared');
    if (v === 'flagged') ls = ls.filter((l) => !!l.t.flag);
    if (q) {
      const amt = parseMoney(q);
      ls = ls.filter((l) => fuzzy(q, `${l.payee} ${l.category} ${l.t.memo ?? ''} ${l.account}`) >= 40 || (amt !== null && Math.abs(l.t.amount) === Math.abs(amt)));
    }
    return ls;
  });
  readonly shown = computed(() => this.lines().slice(0, this.limit()));
  readonly reviewCount = computed(() => this.allLines().filter((l) => !l.t.approved || (!l.t.categoryId && !l.transfer && this.needsCat(l.t))).length);
  readonly unapprovedIds = computed(() => this.allLines().filter((l) => !l.t.approved).map((l) => l.t.id));
  readonly upcoming = computed(() => {
    const a = this.account();
    return this.store.scheduled().filter((s) => (a ? s.accountId === a.id || s.transferAccountId === a.id : true)).slice(0, 5);
  });
  readonly selCount = computed(() => this.selected().size);
  readonly allSelected = computed(() => this.shown().length > 0 && this.shown().every((l) => this.selected().has(l.t.id)));
  readonly selTotal = computed(() => this.allLines().filter((l) => this.selected().has(l.t.id)).reduce((s, l) => s + l.t.amount, 0));
  readonly categoryItems = computed(() => this.pickers.categoryItems(undefined, { income: true }));
  readonly bankAccounts = computed(() => this.store.accounts().filter((a) => !a.closed && a.onBudget && a.id !== this.account()?.id && (a.type === 'checking' || a.type === 'savings')));
  readonly cols = computed(() =>
    this.account()
      ? '[sel] 28px [flag] 14px [date] 96px [payee] minmax(120px, 1.3fr) [cat] minmax(120px, 1.2fr) [memo] minmax(80px, 1fr) [out] 104px [in] 104px [bal] 112px [clr] 30px'
      : '[sel] 28px [flag] 14px [date] 96px [acct] minmax(90px, .8fr) [payee] minmax(120px, 1.2fr) [cat] minmax(120px, 1.1fr) [memo] minmax(80px, 1fr) [out] 104px [in] 104px [clr] 30px',
  );

  constructor() {
    effect(() => {
      this.id();
      untracked(() => { this.editing.set(null); this.selected.set(new Set()); this.limit.set(PAGE); this.view.set('all'); });
    });
    effect(() => { const q = this.q(); if (q !== undefined) untracked(() => this.search.set(q)); });
    if (typeof window !== 'undefined') {
      const mq = window.matchMedia('(min-width: 900px)');
      mq.addEventListener('change', (e) => this.wide.set(e.matches));
    }
  }

  private needsCat(t: Txn) {
    const a = this.store.accountMap().get(t.accountId);
    return !!a?.onBudget && t.source !== 'start';
  }

  categoryText(t: Txn): string {
    if (t.transferAccountId) {
      const other = this.store.accountMap().get(t.transferAccountId);
      const me = this.store.accountMap().get(t.accountId);
      if (other?.onBudget && me?.onBudget) return '';
    }
    if (t.categoryId === SPLIT) return `Split (${t.splits?.length ?? 0})`;
    if (t.categoryId === RTA) return 'Ready to Assign';
    if (!t.categoryId) return this.needsCat(t) && !(t.transferAccountId && this.store.accountMap().get(t.transferAccountId)?.onBudget) ? '' : '';
    return this.pickers.categoryLabel(t.categoryId);
  }

  // ------------------------------------------------------------ editing
  add() {
    if (this.wide()) { this.editing.set('new'); }
    else this.ui.txnEditor.set({ accountId: this.account()?.id });
  }
  edit(l: Line, e: MouseEvent) {
    if ((e.target as HTMLElement).closest('button, input, a')) return;
    if (this.wide()) this.editing.set(l.t.id);
    else this.ui.txnEditor.set({ id: l.t.id });
  }
  toggleSel(id: string, e?: Event) {
    e?.stopPropagation();
    const s = new Set(this.selected());
    if (s.has(id)) s.delete(id); else s.add(id);
    this.selected.set(s);
  }
  toggleAll() {
    this.selected.set(this.allSelected() ? new Set() : new Set(this.shown().map((l) => l.t.id)));
  }
  approve(id: string, e?: Event) {
    e?.stopPropagation();
    this.actions.patchTxns([id], { approved: true }, 'Approve');
  }
  approveAll() {
    const ids = this.unapprovedIds();
    this.actions.patchTxns(ids, { approved: true }, `Approve ${ids.length}`);
    this.toasts.show(`Approved ${ids.length} transaction${ids.length > 1 ? 's' : ''}`, { label: 'Undo', run: () => this.store.undo() });
  }
  toggleCleared(id: string, e: Event) {
    e.stopPropagation();
    this.actions.toggleCleared(id);
  }

  // ------------------------------------------------------------ bulk
  bulk(kind: 'delete' | 'clear' | 'unclear' | 'approve' | 'category' | 'flag', flag?: Flag | null) {
    const ids = [...this.selected()];
    if (!ids.length) return;
    switch (kind) {
      case 'delete': this.actions.deleteTxns(ids); break;
      case 'clear': this.actions.patchTxns(ids.filter((id) => this.store.get<Txn>(id)?.cleared !== 'reconciled'), { cleared: 'cleared' }, 'Mark cleared'); break;
      case 'unclear': this.actions.patchTxns(ids.filter((id) => this.store.get<Txn>(id)?.cleared !== 'reconciled'), { cleared: 'uncleared' }, 'Mark uncleared'); break;
      case 'approve': this.actions.patchTxns(ids, { approved: true }, 'Approve'); break;
      case 'category': if (this.bulkCategory()) this.actions.patchTxns(ids, { categoryId: this.bulkCategory(), approved: true }, 'Categorise'); this.bulkCategory.set(null); break;
      case 'flag': this.actions.patchTxns(ids, { flag: flag ?? null }, 'Flag'); break;
    }
    this.toasts.show(`${ids.length} transaction${ids.length > 1 ? 's' : ''} updated`, { label: 'Undo', run: () => this.store.undo() });
    this.selected.set(new Set());
  }

  // ------------------------------------------------------------ reconcile
  openReconcile() { this.reconcileStep.set('ask'); this.bankBalance.set(''); this.reconcileOpen.set(true); }
  reconcile(useCleared: boolean) {
    const a = this.account();
    if (!a) return;
    const v = useCleared ? this.balance().cleared : parseMoney(this.bankBalance());
    if (v === null) return;
    this.actions.reconcile(a.id, v);
    this.reconcileOpen.set(false);
    this.toasts.show('Account reconciled', { label: 'Undo', run: () => this.store.undo() });
  }
  readonly reconcileDiff = computed(() => {
    const v = parseMoney(this.bankBalance());
    return v === null ? null : v - this.balance().cleared;
  });

  // ------------------------------------------------------------ cash: ATM withdrawal
  openAtm() {
    this.atmFrom.set(this.bankAccounts()[0]?.id ?? null);
    this.atmAmount.set('');
    this.atmOpen.set(true);
  }
  saveAtm() {
    const a = this.account();
    const v = parseMoney(this.atmAmount());
    if (!a || !v || !this.atmFrom()) return;
    this.actions.saveTxn({ accountId: this.atmFrom()!, date: today(), amount: -Math.abs(v), transferAccountId: a.id, memo: 'ATM withdrawal' });
    this.atmOpen.set(false);
    this.toasts.show('Withdrawal recorded', { label: 'Undo', run: () => this.store.undo() });
  }
  readonly atmItems = computed(() => this.bankAccounts().map((a) => ({ id: a.id, label: a.name })));

  enterScheduled(id: string) { this.actions.enterScheduled(id, today()); this.toasts.show('Entered', { label: 'Undo', run: () => this.store.undo() }); }
  skipScheduled(id: string) { this.actions.skipScheduled(id); this.toasts.show('Skipped', { label: 'Undo', run: () => this.store.undo() }); }

  payeeOf(id: string | null | undefined) { return this.store.payeeMap().get(id ?? '')?.name ?? ''; }
  accountName(id: string | null | undefined) { return this.store.accountMap().get(id ?? '')?.name ?? ''; }
  clearSel() { this.selected.set(new Set()); }
  goBudget() { this.router.navigate(['/budget']); }
}
