import { ChangeDetectionStrategy, Component, computed, effect, inject, input, output, signal } from '@angular/core';
import { RouterLink } from '@angular/router';
import { Actions } from '../../core/actions';
import { STRATEGIES, Strategy, strategyAmount } from '../../core/autoassign';
import { UNCAT } from '../../core/engine';
import { ageOfMoney, daysOfBuffer } from '../../core/insights';
import { Category, isCreditType, RTA, SPLIT, Target, TargetType } from '../../core/models';
import { parseMoney } from '../../core/money';
import { Store } from '../../core/store';
import { addMonths, monthLabel, monthName, monthOf } from '../../core/util';
import { Combo, ComboItem } from '../../ui/combo';
import { Icon } from '../../ui/icon';
import { DatePipe, MoneyPipe } from '../../ui/money.pipe';
import { Ring } from '../../ui/ring';
import { TargetEditor } from './target-editor';
import { describeTarget } from '../../core/target-text';
import { formatMoney } from '../../core/money';
import { Toasts } from '../../ui/toast';

const EMOJIS = ['🏠', '💡', '📶', '🔁', '🛡️', '🛒', '🍽️', '☕', '🚕', '⛽', '💊', '🧴', '🛍️', '🎉', '🎁', '✈️', '📚', '🧯', '🐑', '🔧', '📱', '👶', '🐾', '💪', '🎮', '🕌', '💳', '🏦', '🚗', '👕', '💼', '🧾'];

@Component({
  selector: 'app-inspector',
  imports: [Icon, MoneyPipe, DatePipe, Ring, Combo, RouterLink, TargetEditor],
  changeDetection: ChangeDetectionStrategy.OnPush,
  templateUrl: './inspector.html',
  styleUrl: './inspector.scss',
})
export class Inspector {
  readonly store = inject(Store);
  private actions = inject(Actions);
  private toasts = inject(Toasts);

  readonly month = input.required<string>();
  readonly categoryId = input<string | null>(null);
  readonly embedded = input(false);
  readonly closed = output<void>();
  readonly moveMoney = output<{ from: string; to?: string; amount?: number }>();
  readonly strategy = output<{ s: Strategy; id?: string }>();
  readonly fund = output<void>();

  readonly strategies = STRATEGIES.filter((s) => s.id !== 'resetAssigned');
  readonly emojis = EMOJIS;
  readonly showEmoji = signal(false);
  readonly editingTarget = signal(false);
  readonly confirmDelete = signal(false);
  readonly replacement = signal<string | null>(null);

  // target draft
  readonly tType = signal<TargetType>('monthly');
  readonly tAmount = signal('');
  readonly tMode = signal<'set' | 'refill'>('set');
  readonly tDate = signal('');
  readonly tMonth = signal(12);
  readonly tWeekday = signal(6);
  readonly weekdays = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
  readonly monthNames = Array.from({ length: 12 }, (_, i) => monthName(`2000-${String(i + 1).padStart(2, '0')}`));

  readonly cat = computed(() => {
    const id = this.categoryId();
    return id && id !== RTA && id !== UNCAT ? this.store.categoryMap().get(id) ?? null : null;
  });
  readonly cm = computed(() => this.store.budget().cat(this.month(), this.categoryId() ?? ''));
  readonly md = computed(() => this.store.budget().month(this.month()));
  readonly label = computed(() => monthLabel(this.month()));
  readonly prevName = computed(() => monthName(addMonths(this.month(), -1)));
  readonly isCard = computed(() => !!this.cat()?.ccAccountId);
  readonly cardBalance = computed(() => {
    const c = this.cat();
    return c?.ccAccountId ? this.store.budget().balances.get(c.ccAccountId)?.working ?? 0 : 0;
  });

  readonly strategyValues = computed(() => {
    const snap = this.store.budget();
    const m = this.month();
    const id = this.categoryId();
    const ids = id && id !== RTA ? [id] : this.store.categories().filter((c) => !c.hidden).map((c) => c.id);
    return this.strategies.map((s) => {
      let total = 0, delta = 0;
      for (const c of ids) {
        const v = strategyAmount(s.id, snap, m, c);
        total += v;
        delta += v - snap.cat(m, c).assigned;
      }
      return { ...s, total, delta };
    });
  });

  readonly recent = computed(() => {
    const id = this.categoryId();
    if (!id || id === RTA) return [];
    const m = this.month();
    const accounts = this.store.accountMap();
    return this.store.txns()
      .filter((t) => monthOf(t.date) === m && (id === UNCAT
        ? !t.categoryId && accounts.get(t.accountId)?.onBudget && !(t.transferAccountId && accounts.get(t.transferAccountId)?.onBudget) && t.source !== 'start'
        : t.categoryId === id || (t.categoryId === SPLIT && t.splits?.some((s) => s.categoryId === id))))
      .slice(0, 8)
      .map((t) => ({
        t,
        amount: t.categoryId === SPLIT ? t.splits!.filter((s) => s.categoryId === id).reduce((a, s) => a + s.amount, 0) : t.amount,
        payee: this.store.payeeMap().get(t.payeeId ?? '')?.name ?? '',
        account: accounts.get(t.accountId)?.name ?? '',
      }));
  });

  readonly insights = computed(() => {
    const accounts = this.store.accountMap();
    const txns = this.store.txns();
    const cash = this.store.accounts().filter((a) => a.onBudget && !isCreditType(a.type))
      .reduce((s, a) => s + (this.store.budget().balances.get(a.id)?.working ?? 0), 0);
    return { age: ageOfMoney(txns, accounts), buffer: daysOfBuffer(txns, accounts, cash) };
  });

  readonly replacementItems = computed<ComboItem[]>(() =>
    this.store.categories().filter((c) => c.id !== this.categoryId() && !c.ccAccountId).map((c) => ({ id: c.id, label: c.name, emoji: c.emoji, group: this.store.groupMap().get(c.groupId)?.name })),
  );

  constructor() {
    effect(() => {
      this.categoryId();
      this.editingTarget.set(false);
      this.confirmDelete.set(false);
      this.showEmoji.set(false);
    });
  }

  // ------------------------------------------------------------ edits
  rename(name: string) {
    const c = this.cat();
    if (c && name.trim() && name.trim() !== c.name) this.store.put({ ...c, name: name.trim() });
  }
  setEmoji(e: string | undefined) {
    const c = this.cat();
    if (!c) return;
    const next = { ...c, emoji: e };
    if (!e) delete next.emoji;
    this.store.put(next);
    this.showEmoji.set(false);
  }
  saveNote(note: string) {
    const c = this.cat();
    if (c && (c.note ?? '') !== note) this.store.put({ ...c, note });
  }
  assign(raw: string) {
    const c = this.cat();
    if (!c) return;
    const v = parseMoney(raw);
    if (v === null) return;
    this.actions.setAssigned(this.month(), c.id, v);
  }
  hide() {
    const c = this.cat();
    if (!c) return;
    this.store.put({ ...c, hidden: true });
    this.closed.emit();
    this.toasts.show(`Hid “${c.name}”`, { label: 'Undo', run: () => this.store.undo() });
  }
  remove() {
    const c = this.cat();
    if (!c) return;
    this.actions.deleteCategory(c.id, this.replacement());
    this.closed.emit();
    this.toasts.show(`Deleted “${c.name}”`, { label: 'Undo', run: () => this.store.undo() });
  }

  // ------------------------------------------------------------ targets
  targetSummary(t: Target): string {
    return describeTarget(t, (c) => formatMoney(c, this.store.format()));
  }
  readonly cmTarget = computed(() => this.cm().target);
  ringValue() {
    const t = this.cmTarget();
    if (!t) return 0;
    if (t.type === 'monthly' || t.type === 'weekly') return t.need ? 1 - t.underfunded / t.need : 1;
    return t.progress;
  }
  readonly cat_ = (c: Category | null) => c;
  max0(v: number) { return Math.max(0, v); }
}
