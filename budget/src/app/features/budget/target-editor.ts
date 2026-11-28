import { ChangeDetectionStrategy, Component, computed, effect, inject, input, output, signal, untracked } from '@angular/core';
import { Actions } from '../../core/actions';
import { Category, Target } from '../../core/models';
import { formatMoney, parseMoney } from '../../core/money';
import { Store } from '../../core/store';
import { describeTarget, ordinal, WEEKDAYS } from '../../core/target-text';
import { addMonths, monthName } from '../../core/util';
import { targetStatus } from '../../core/engine';
import { MoneyPipe } from '../../ui/money.pipe';

type Kind = 'weekly' | 'monthly' | 'yearly' | 'custom' | 'savings';

/**
 * Target editor following the familiar pattern:
 *   I need [amount]  [Weekly | Monthly | Yearly | Custom]  every/by …  →  Next period: set aside another / refill up to.
 * plus a savings-balance goal with an optional deadline.
 */
@Component({
  selector: 'app-target-editor',
  imports: [MoneyPipe],
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <div class="te" data-form>
      <div class="tabs" role="tablist">
        @for (k of kinds; track k.id) {
          <button type="button" role="tab" [class.on]="tab() === k.id" [attr.aria-selected]="tab() === k.id" (click)="setTab(k.id)">{{ k.label }}</button>
        }
      </div>

      <div class="rows">
        <label class="r"><span>{{ kind() === 'savings' ? 'Have a balance of' : 'I need' }}</span>
          <input class="input amount" [value]="amount()" (input)="amount.set($any($event.target).value)" inputmode="decimal" placeholder="0,00" /></label>

        @switch (kind()) {
          @case ('weekly') {
            <label class="r"><span>Every</span>
              <select class="select" [value]="weekday()" (change)="weekday.set(+$any($event.target).value)">@for (d of weekdays; track $index) {<option [value]="$index">{{ d }}</option>}</select></label>
          }
          @case ('monthly') {
            <label class="r"><span>By</span>
              <select class="select" [value]="day()" (change)="day.set(+$any($event.target).value)">
                <option [value]="0">Any day of the month</option>@for (d of days; track d) {<option [value]="d">{{ d >= 31 ? 'Last day of the month' : 'The ' + ordinal(d) }}</option>}</select></label>
          }
          @case ('yearly') {
            <div class="r"><span>By</span>
              <div class="pair">
                <select class="select" [value]="month()" (change)="month.set(+$any($event.target).value)" aria-label="Month">@for (m of monthNames; track $index) {<option [value]="$index + 1">{{ m }}</option>}</select>
                <select class="select" [value]="day()" (change)="day.set(+$any($event.target).value)" aria-label="Day"><option [value]="0">Any day</option>@for (d of days; track d) {<option [value]="d">{{ ordinal(d) }}</option>}</select>
              </div></div>
          }
          @default {
            @if (kind() === 'custom') {
              <label class="r"><span>By</span><input class="input" type="month" [value]="date()" (change)="date.set($any($event.target).value)" /></label>
              <div class="r"><span>Repeat</span>
                <button type="button" class="switch" role="switch" [attr.aria-checked]="repeat()" [class.on]="repeat()" (click)="repeat.set(!repeat())"><i></i></button></div>
              @if (repeat()) {
                <div class="r"><span>Every</span>
                  <div class="pair">
                    <input class="input" type="number" min="1" max="60" [value]="every()" (input)="every.set(+$any($event.target).value || 1)" aria-label="Interval" />
                    <select class="select" [value]="unit()" (change)="unit.set($any($event.target).value)" aria-label="Unit"><option value="m">{{ every() === 1 ? 'Month' : 'Months' }}</option><option value="y">{{ every() === 1 ? 'Year' : 'Years' }}</option></select>
                  </div></div>
              }
            } @else {
              <div class="r"><span>Due date</span>
                <button type="button" class="switch" role="switch" [attr.aria-checked]="hasDeadline()" [class.on]="hasDeadline()" (click)="hasDeadline.set(!hasDeadline())"><i></i></button></div>
              @if (hasDeadline()) { <label class="r"><span>By</span><input class="input" type="month" [value]="date()" (change)="date.set($any($event.target).value)" /></label> }
            }
            <label class="r"><span>Goal</span>
              <select class="select" [value]="kind()" (change)="setCustomKind($any($event.target).value)">
                <option value="custom">Need it by a date</option><option value="savings">Just build up a balance</option></select></label>
          }
        }

        @if (kind() === 'weekly' || kind() === 'monthly') {
          <label class="r"><span>Next {{ kind() === 'weekly' ? 'week' : 'month' }} I want to</span>
            <select class="select" [value]="mode()" (change)="mode.set($any($event.target).value)">
              <option value="set">Set aside another {{ (parsed() ?? 0) | money }}</option>
              <option value="refill">Refill up to {{ (parsed() ?? 0) | money }}</option>
            </select></label>
          <p class="hint">{{ mode() === 'set' ? 'Adds the full amount every ' + (kind() === 'weekly' ? 'week' : 'month') + ', even if some is left over.' : 'Tops the category up to this amount; anything left over counts.' }}</p>
        }
      </div>

      @if (preview(); as p) {
        <p class="sentence">{{ p.sentence }}@if (p.perMonth !== null) {<span> · {{ p.perMonth | money }} needed in {{ monthLabel() }}</span>}</p>
      }

      <div class="foot">
        <button class="btn sm primary" type="button" [disabled]="!parsed()" (click)="save()">Save target</button>
        <button class="btn sm ghost" type="button" (click)="done.emit()">Cancel</button>
        <span class="grow"></span>
        @if (category().target) { <button class="del" type="button" (click)="remove()">Delete</button> }
      </div>
    </div>`,
  styles: `
    .te { container-type: inline-size; display: flex; flex-direction: column; border: 1px solid var(--line); border-radius: 14px; background: var(--surface); overflow: hidden; }
    .tabs { display: grid; grid-template-columns: repeat(4, 1fr); border-bottom: 1px solid var(--line); background: var(--surface-2);
      button { height: 40px; border: 0; background: none; font-weight: 600; font-size: 0.8125rem; color: var(--ink-2); cursor: pointer; position: relative;
        &:hover { color: var(--ink); }
        &.on { color: var(--accent-ink); background: var(--surface); }
        &.on::after { content: ''; position: absolute; left: 12px; right: 12px; bottom: -1px; height: 2px; border-radius: 2px; background: var(--accent); } } }
    .rows { display: flex; flex-direction: column; gap: 10px; padding: 14px 14px 4px; }
    .r { display: grid; grid-template-columns: 118px minmax(0, 1fr); align-items: center; gap: 10px;
      > span { font-size: 0.8125rem; font-weight: 600; color: var(--ink-2); }
      .input, .select { height: 36px; } }
    .pair { display: grid; grid-template-columns: 1fr 1fr; gap: 6px; }
    .switch { width: 40px; height: 24px; border-radius: 999px; border: 0; background: var(--line-2); position: relative; cursor: pointer; transition: background .2s;
      i { position: absolute; top: 3px; left: 3px; width: 18px; height: 18px; border-radius: 50%; background: #fff; box-shadow: 0 1px 2px rgba(0,0,0,.2); transition: transform .2s var(--ease); }
      &.on { background: var(--accent); i { transform: translateX(16px); } } }
    .hint { margin: -2px 0 0 128px; font-size: 0.75rem; color: var(--ink-3); }
    .sentence { margin: 8px 14px 0; padding: 10px 12px; border-radius: 10px; background: var(--surface-2); font-size: 0.8125rem; font-weight: 600; span { font-weight: 450; color: var(--ink-2); } }
    .foot { display: flex; align-items: center; gap: 6px; padding: 12px 14px 14px; }
    .del { border: 0; background: none; color: var(--neg); font-weight: 600; font-size: 0.8125rem; cursor: pointer; padding: 4px 6px; border-radius: 6px; &:hover { background: var(--neg-soft); } }
    @container (max-width: 440px) { .r { grid-template-columns: 1fr; gap: 5px; } .hint { margin-left: 0; } }`,
})
export class TargetEditor {
  private store = inject(Store);
  private actions = inject(Actions);
  readonly category = input.required<Category>();
  readonly forMonth = input.required<string>();
  readonly done = output<void>();

  readonly kinds: { id: 'weekly' | 'monthly' | 'yearly' | 'custom'; label: string }[] = [
    { id: 'weekly', label: 'Weekly' }, { id: 'monthly', label: 'Monthly' }, { id: 'yearly', label: 'Yearly' }, { id: 'custom', label: 'Custom' },
  ];
  /** "Savings balance" lives inside the Custom tab */
  readonly tab = computed(() => (this.kind() === 'savings' ? 'custom' : this.kind()));
  setTab(k: Kind) { if (this.tab() !== k) this.kind.set(k); }
  setCustomKind(k: Kind) { this.kind.set(k); }
  readonly weekdays = WEEKDAYS;
  readonly days = Array.from({ length: 31 }, (_, i) => i + 1);
  readonly monthNames = Array.from({ length: 12 }, (_, i) => monthName(`2000-${String(i + 1).padStart(2, '0')}`));
  readonly ordinal = (d: number) => (d >= 31 ? 'last day' : ordinal(d));

  readonly kind = signal<Kind>('monthly');
  readonly amount = signal('');
  readonly mode = signal<'set' | 'refill'>('set');
  readonly weekday = signal(6);
  readonly day = signal(0);
  readonly month = signal(12);
  readonly date = signal('');
  readonly repeat = signal(false);
  readonly every = signal(1);
  readonly unit = signal<'m' | 'y'>('y');
  readonly hasDeadline = signal(false);

  readonly parsed = computed(() => { const v = parseMoney(this.amount()); return v && v > 0 ? v : null; });
  readonly monthLabel = computed(() => monthName(this.forMonth()));

  constructor() {
    effect(() => {
      const c = this.category();
      const m = this.forMonth();
      untracked(() => this.load(c.target, m));
    });
  }

  private load(t: Target | undefined, m: string) {
    this.amount.set(t ? formatMoney(t.amount, this.store.format(), { currency: false }) : '');
    this.mode.set(t?.mode ?? 'set');
    this.weekday.set(t?.weekday ?? 6);
    this.day.set(t?.day ?? 0);
    this.month.set(t?.month ?? 12);
    this.date.set(t?.date ?? addMonths(m, 6));
    this.repeat.set(!!t?.repeatMonths);
    const r = t?.repeatMonths ?? 12;
    this.unit.set(r % 12 === 0 ? 'y' : 'm');
    this.every.set(r % 12 === 0 ? r / 12 : r);
    this.hasDeadline.set(t?.type === 'balance' && !!t.date);
    this.kind.set(!t ? 'monthly' : t.type === 'byDate' ? 'custom' : t.type === 'balance' ? 'savings' : t.type);
  }

  readonly draft = computed<Target | null>(() => {
    const amount = this.parsed();
    if (!amount) return null;
    switch (this.kind()) {
      case 'weekly': return { type: 'weekly', amount, mode: this.mode(), weekday: this.weekday() };
      case 'monthly': return { type: 'monthly', amount, mode: this.mode(), ...(this.day() ? { day: this.day() } : {}) };
      case 'yearly': return { type: 'yearly', amount, month: this.month(), ...(this.day() ? { day: this.day() } : {}) };
      case 'custom': return { type: 'byDate', amount, date: this.date(), ...(this.repeat() ? { repeatMonths: this.every() * (this.unit() === 'y' ? 12 : 1) } : {}) };
      case 'savings': return { type: 'balance', amount, ...(this.hasDeadline() && this.date() ? { date: this.date() } : {}) };
    }
  });

  readonly preview = computed(() => {
    const t = this.draft();
    if (!t) return null;
    const money = (c: number) => formatMoney(c, this.store.format());
    const cm = this.store.budget().cat(this.forMonth(), this.category().id);
    const st = targetStatus(t, this.forMonth(), cm);
    return { sentence: describeTarget(t, money), perMonth: st.need || null };
  });

  save() {
    const t = this.draft();
    if (!t) return;
    this.actions.setTarget(this.category().id, t);
    this.done.emit();
  }
  remove() {
    this.actions.setTarget(this.category().id, undefined);
    this.done.emit();
  }
}
