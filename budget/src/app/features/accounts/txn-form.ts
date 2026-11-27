import { ChangeDetectionStrategy, Component, computed, effect, ElementRef, inject, input, output, signal, untracked } from '@angular/core';
import { Actions } from '../../core/actions';
import { Account, Flag, Frequency, RTA, SPLIT, Split, Txn } from '../../core/models';
import { formatMoney, parseMoney } from '../../core/money';
import { Store } from '../../core/store';
import { formatDate, parseDate, today, uid } from '../../core/util';
import { Combo, ComboItem } from '../../ui/combo';
import { Icon } from '../../ui/icon';
import { MoneyPipe } from '../../ui/money.pipe';
import { Pickers } from '../../ui/pickers';
import { Toasts } from '../../ui/toast';

interface SplitDraft { id: string; amount: string; categoryId: string | null; memo: string }

export const FLAGS: Flag[] = ['red', 'orange', 'yellow', 'green', 'blue', 'purple'];
export const FREQS: { id: Frequency | 'never'; label: string }[] = [
  { id: 'never', label: 'Never' }, { id: 'weekly', label: 'Every week' }, { id: 'every2weeks', label: 'Every 2 weeks' },
  { id: 'twiceMonthly', label: 'Twice a month' }, { id: 'monthly', label: 'Every month' }, { id: 'every2months', label: 'Every 2 months' },
  { id: 'every3months', label: 'Every 3 months' }, { id: 'every6months', label: 'Every 6 months' }, { id: 'yearly', label: 'Every year' },
];

/**
 * Transaction form. layout 'row' = one spreadsheet-like line for the desktop register;
 * layout 'stack' = mobile/sheet form with big amount and Out/In toggle.
 */
@Component({
  selector: 'app-txn-form',
  imports: [Combo, Icon, MoneyPipe],
  changeDetection: ChangeDetectionStrategy.OnPush,
  templateUrl: './txn-form.html',
  styleUrl: './txn-form.scss',
  host: { '[class]': 'layout()', '(keydown)': 'key($event)' },
})
export class TxnForm {
  private store = inject(Store);
  private actions = inject(Actions);
  private pickers = inject(Pickers);
  private toasts = inject(Toasts);
  private host = inject<ElementRef<HTMLElement>>(ElementRef);

  readonly txnId = input<string | null>(null);
  readonly accountId = input<string | null>(null);
  readonly layout = input<'row' | 'stack'>('stack');
  readonly showAccount = input(false);
  readonly prefill = input<Partial<{ amount: number; payee: string; categoryId: string | null; date: string; memo: string }> | null>(null);
  readonly saved = output<Txn>();
  readonly cancelled = output<void>();
  readonly saveAndNew = output<void>();

  readonly acct = signal<string | null>(null);
  readonly date = signal('');
  readonly payee = signal<string | null>(null);
  readonly payeeText = signal('');
  readonly category = signal<string | null>(null);
  readonly memo = signal('');
  readonly out = signal('');
  readonly inn = signal('');
  readonly amount = signal('');
  readonly dir = signal<'out' | 'in'>('out');
  readonly cleared = signal(false);
  readonly flag = signal<Flag | null>(null);
  readonly splits = signal<SplitDraft[]>([]);
  readonly repeat = signal<Frequency | 'never'>('never');
  readonly flagMenu = signal(false);
  readonly flags = FLAGS;
  readonly freqs = FREQS;

  readonly account = computed(() => this.store.accountMap().get(this.acct() ?? '') ?? null);
  readonly payeeItems = computed(() => { this.store.version(); return this.pickers.payeeItems(this.acct() ?? undefined); });
  readonly accountItems = this.pickers.accounts;
  readonly transferTo = computed(() => (this.payee()?.startsWith('transfer:') ? this.store.accountMap().get(this.payee()!.slice(9)) ?? null : null));
  /** does this transaction need a category? */
  readonly needsCategory = computed(() => {
    const a = this.account();
    if (!a?.onBudget) return false;
    const t = this.transferTo();
    return !t || !t.onBudget;
  });
  readonly categoryItems = computed(() => {
    const d = parseDate(this.date(), this.store.settings().dateFormat) ?? today();
    return this.pickers.categoryItems(d.slice(0, 7), { income: true, split: !this.transferTo() });
  });
  readonly isSplit = computed(() => this.category() === SPLIT);
  readonly signedAmount = computed(() => {
    if (this.layout() === 'row') {
      const o = parseMoney(this.out()) ?? 0, i = parseMoney(this.inn()) ?? 0;
      return i - o;
    }
    const v = Math.abs(parseMoney(this.amount()) ?? 0);
    return this.dir() === 'out' ? -v : v;
  });
  readonly splitTotal = computed(() => this.splits().reduce((s, x) => s + (parseMoney(x.amount) ?? 0), 0));
  readonly splitLeft = computed(() => this.signedAmount() - this.splitSigned());
  private splitSigned() { return this.splits().reduce((s, x) => s + this.splitValue(x), 0); }
  splitValue(x: SplitDraft) {
    const v = parseMoney(x.amount) ?? 0;
    // split amounts follow the transaction direction unless typed with an explicit sign
    return x.amount.trim().startsWith('-') || x.amount.trim().startsWith('+') ? v : this.signedAmount() < 0 ? -Math.abs(v) : Math.abs(v);
  }

  constructor() {
    effect(() => {
      const id = this.txnId();
      const acc = this.accountId();
      const pre = this.prefill();
      untracked(() => this.load(id, acc, pre));
    });
  }

  private load(id: string | null, accountId: string | null, pre: ReturnType<typeof this.prefill>) {
    const f = this.store.format();
    const fmt = (c: number) => (c ? formatMoney(Math.abs(c), f, { currency: false }) : '');
    const t = id ? this.store.get<Txn>(id) : undefined;
    const df = this.store.settings().dateFormat;
    if (t) {
      this.acct.set(t.accountId);
      this.date.set(formatDate(t.date, df));
      this.payee.set(t.transferAccountId ? 'transfer:' + t.transferAccountId : t.payeeId ?? null);
      this.payeeText.set('');
      this.category.set(t.categoryId ?? null);
      this.memo.set(t.memo ?? '');
      this.out.set(t.amount < 0 ? fmt(t.amount) : '');
      this.inn.set(t.amount > 0 ? fmt(t.amount) : '');
      this.amount.set(fmt(t.amount));
      this.dir.set(t.amount > 0 ? 'in' : 'out');
      this.cleared.set(t.cleared !== 'uncleared');
      this.flag.set(t.flag ?? null);
      this.splits.set((t.splits ?? []).map((s) => ({ id: s.id, amount: fmt(s.amount), categoryId: s.categoryId ?? null, memo: s.memo ?? '' })));
      this.repeat.set('never');
    } else {
      const s = this.store.settings();
      this.acct.set(accountId ?? s.lastAccountId ?? this.store.accounts().find((a) => a.onBudget && !a.closed)?.id ?? null);
      this.date.set(formatDate(pre?.date ?? today(), df));
      this.payee.set(null);
      this.payeeText.set(pre?.payee ?? '');
      this.category.set(pre?.categoryId ?? (pre?.payee ? this.actions.suggestCategory(pre.payee) : null));
      this.memo.set(pre?.memo ?? '');
      this.out.set(pre?.amount && pre.amount < 0 ? fmt(pre.amount) : '');
      this.inn.set(pre?.amount && pre.amount > 0 ? fmt(pre.amount) : '');
      this.amount.set(pre?.amount ? fmt(pre.amount) : '');
      this.dir.set(pre?.amount && pre.amount > 0 ? 'in' : 'out');
      this.cleared.set(false);
      this.flag.set(null);
      this.splits.set([]);
      this.repeat.set('never');
    }
  }

  focusFirst() {
    setTimeout(() => this.host.nativeElement.querySelector<HTMLInputElement>(this.layout() === 'stack' ? '.big-amount' : 'input')?.focus());
  }

  onPayeePicked(it: ComboItem) {
    if (it.id.startsWith('transfer:')) {
      const other = this.store.accountMap().get(it.id.slice(9));
      if (other?.onBudget && this.account()?.onBudget) this.category.set(null);
      return;
    }
    const p = this.store.payeeMap().get(it.id);
    if (p?.categoryId && !this.category()) this.category.set(p.categoryId);
  }
  onPayeeCreated(text: string) {
    if (!this.category()) {
      const s = this.actions.suggestCategory(text);
      if (s) this.category.set(s);
    }
  }
  onCategoryPicked(it: ComboItem) {
    if (it.id === SPLIT && !this.splits().length) {
      const amt = this.layout() === 'row' ? this.out() || this.inn() : this.amount();
      this.splits.set([{ id: uid(), amount: amt, categoryId: null, memo: '' }, { id: uid(), amount: '', categoryId: null, memo: '' }]);
    }
    if (it.id === RTA && this.layout() === 'stack') this.dir.set('in');
  }
  addSplit() { this.splits.update((s) => [...s, { id: uid(), amount: '', categoryId: null, memo: '' }]); }
  removeSplit(id: string) { this.splits.update((s) => s.filter((x) => x.id !== id)); }
  updateSplit(id: string, patch: Partial<SplitDraft>) { this.splits.update((s) => s.map((x) => (x.id === id ? { ...x, ...patch } : x))); }
  fillRemaining(id: string) {
    const left = this.splitLeft();
    const cur = this.splits().find((x) => x.id === id);
    if (!cur) return;
    const v = this.splitValue(cur) + left;
    this.updateSplit(id, { amount: formatMoney(Math.abs(v), this.store.format(), { currency: false }) });
  }

  setOut(v: string) { this.out.set(v); if (v) this.inn.set(''); }
  setIn(v: string) { this.inn.set(v); if (v) this.out.set(''); }

  key(e: KeyboardEvent) {
    if (e.key === 'Escape' && !(e.target as HTMLElement).closest('app-combo')) { e.preventDefault(); this.cancelled.emit(); }
    if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) { e.preventDefault(); this.save(true); }
  }

  save(andNew = false): Txn | null {
    const acct = this.account();
    if (!acct) { this.toasts.show('Choose an account', undefined, 2500, 'error'); return null; }
    const date = parseDate(this.date(), this.store.settings().dateFormat);
    if (!date) { this.toasts.show('That date doesn’t look right', undefined, 2500, 'error'); return null; }
    const amount = this.signedAmount();
    const p = this.payee();
    const transferAccountId = p?.startsWith('transfer:') ? p.slice(9) : null;
    let splits: Split[] | undefined;
    let categoryId = this.needsCategory() ? this.category() : (transferAccountId ? null : this.category());
    if (categoryId === SPLIT) {
      splits = this.splits().filter((s) => s.amount.trim() || s.categoryId).map((s) => ({ id: s.id, amount: this.splitValue(s), categoryId: s.categoryId, memo: s.memo }));
      if (splits.reduce((a, s) => a + s.amount, 0) !== amount && amount !== 0) {
        this.toasts.show(`Splits don’t add up — ${formatMoney(this.splitLeft(), this.store.format())} left to assign`, undefined, 3500, 'error');
        return null;
      }
      if (splits.length < 2) { categoryId = splits[0]?.categoryId ?? null; splits = undefined; }
    }
    if (!amount && !splits) { this.toasts.show('Enter an amount', undefined, 2500, 'error'); return null; }

    if (this.repeat() !== 'never' && !this.txnId()) {
      // a repeating transaction: first occurrence goes to the schedule (entered when due)
      const payeeId = transferAccountId ? null : p ?? (this.payeeText().trim() ? this.actions.payeeFor(this.payeeText()).id : null);
      this.actions.saveScheduled({ accountId: acct.id, nextDate: date, frequency: this.repeat() as Frequency, amount, payeeId, categoryId, transferAccountId, memo: this.memo(), flag: this.flag() });
      const entered = date <= today() ? this.actions.enterDue() : 0;
      this.toasts.show(entered ? 'Scheduled and entered the first one' : 'Scheduled', { label: 'Undo', run: () => this.store.undo() });
      this.cancelled.emit();
      return null;
    }

    const t = this.actions.saveTxn({
      id: this.txnId() ?? undefined, accountId: acct.id, date, amount,
      payeeId: transferAccountId ? null : p, payeeName: transferAccountId || p ? undefined : this.payeeText(),
      categoryId, splits, transferAccountId, memo: this.memo(),
      cleared: this.cleared() ? (this.store.get<Txn>(this.txnId())?.cleared === 'reconciled' ? 'reconciled' : 'cleared') : 'uncleared',
      flag: this.flag(), approved: true,
    });
    this.saved.emit(t);
    if (andNew) { this.load(null, acct.id, null); this.saveAndNew.emit(); this.focusFirst(); }
    return t;
  }

  readonly accountOf = (a: Account | null) => a;
  readonly store_currency = computed(() => this.store.settings().currency);
}
