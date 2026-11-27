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
      <div class="seg block kinds" role="tablist">
        @for (k of kinds; track k.id) { <button type="button" [class.on]="kind() === k.id" (click)="kind.set(k.id)">{{ k.label }}</button> }
      </div>

      <label class="field"><span>{{ kind() === 'savings' ? 'Have a balance of' : 'I need' }}</span>
        <input class="input amount big" [value]="amount()" (input)="amount.set($any($event.target).value)" inputmode="decimal" placeholder="0,00" /></label>

      @switch (kind()) {
        @case ('weekly') {
          <label class="field"><span>Every</span>
            <select class="select" [value]="weekday()" (change)="weekday.set(+$any($event.target).value)">@for (d of weekdays; track $index) {<option [value]="$index">{{ d }}</option>}</select></label>
        }
        @case ('monthly') {
          <label class="field"><span>By</span>
            <select class="select" [value]="day()" (change)="day.set(+$any($event.target).value)">
              <option [value]="0">Any time in the month</option>@for (d of days; track d) {<option [value]="d">The {{ ordinal(d) }}</option>}</select></label>
        }
        @case ('yearly') {
          <div class="two">
            <label class="field"><span>Due in</span>
              <select class="select" [value]="month()" (change)="month.set(+$any($event.target).value)">@for (m of monthNames; track $index) {<option [value]="$index + 1">{{ m }}</option>}</select></label>
            <label class="field"><span>Day</span>
              <select class="select" [value]="day()" (change)="day.set(+$any($event.target).value)"><option [value]="0">Any</option>@for (d of days; track d) {<option [value]="d">{{ ordinal(d) }}</option>}</select></label>
          </div>
        }
        @case ('custom') {
          <label class="field"><span>By</span><input class="input" type="month" [value]="date()" (change)="date.set($any($event.target).value)" /></label>
          <label class="check"><input type="checkbox" [checked]="repeat()" (change)="repeat.set($any($event.target).checked)" /> Repeat</label>
          @if (repeat()) {
            <div class="two">
              <label class="field"><span>Every</span><input class="input" type="number" min="1" max="60" [value]="every()" (input)="every.set(+$any($event.target).value || 1)" /></label>
              <label class="field"><span>&nbsp;</span>
                <div class="seg block"><button type="button" [class.on]="unit() === 'm'" (click)="unit.set('m')">Months</button><button type="button" [class.on]="unit() === 'y'" (click)="unit.set('y')">Years</button></div></label>
            </div>
          }
        }
        @case ('savings') {
          <label class="check"><input type="checkbox" [checked]="hasDeadline()" (change)="hasDeadline.set($any($event.target).checked)" /> By a specific date</label>
          @if (hasDeadline()) { <label class="field"><span>By</span><input class="input" type="month" [value]="date()" (change)="date.set($any($event.target).value)" /></label> }
        }
      }

      @if (kind() === 'weekly' || kind() === 'monthly') {
        <div class="field"><span>Next {{ kind() === 'weekly' ? 'week' : 'month' }} I want to</span>
          <div class="modes">
            <button type="button" class="mode" [class.on]="mode() === 'set'" (click)="mode.set('set')">
              <strong>Set aside another {{ (parsed() ?? 0) | money }}</strong><small>Keep adding, even if some is left over. Good for bills and saving.</small></button>
            <button type="button" class="mode" [class.on]="mode() === 'refill'" (click)="mode.set('refill')">
              <strong>Refill up to {{ (parsed() ?? 0) | money }}</strong><small>Top up to this amount; leftovers count. Good for spending like groceries.</small></button>
          </div>
        </div>
      }

      @if (preview(); as p) {
        <div class="preview">
          <strong>{{ p.sentence }}</strong>
          @if (p.perMonth !== null) { <span>That’s {{ p.perMonth | money }} to assign in {{ monthLabel() }}.</span> }
        </div>
      }

      <div class="row">
        <button class="btn sm primary" type="button" [disabled]="!parsed()" (click)="save()">Save target</button>
        <button class="btn sm ghost" type="button" (click)="done.emit()">Cancel</button>
        <span class="grow"></span>
        @if (category().target) { <button class="btn sm danger" type="button" (click)="remove()">Remove</button> }
      </div>
    </div>`,
  styles: `
    .te { display: flex; flex-direction: column; gap: 12px; padding: 14px; border: 1px solid var(--line); border-radius: 14px; background: var(--surface); }
    .kinds { flex-wrap: wrap; border-radius: 12px; button { padding: 0 8px; font-size: 12.5px; flex: 1 1 auto; } }
    .big { height: 44px; font: 650 18px/1 var(--display); }
    .two { display: grid; grid-template-columns: 1fr 1fr; gap: 10px; }
    .check { display: flex; gap: 8px; align-items: center; font-size: 13.5px; color: var(--ink-2); }
    .modes { display: flex; flex-direction: column; gap: 6px; }
    .mode { text-align: left; border: 1px solid var(--line-2); background: var(--surface); border-radius: 10px; padding: 10px 12px; cursor: pointer; display: flex; flex-direction: column; gap: 2px;
      strong { font-size: 13.5px; color: var(--ink); } small { font-size: 12px; color: var(--ink-3); font-weight: 450; }
      &.on { border-color: var(--accent); background: var(--accent-soft); box-shadow: inset 0 0 0 1px var(--accent); } }
    .preview { display: flex; flex-direction: column; gap: 2px; padding: 10px 12px; border-radius: 10px; background: var(--surface-2); font-size: 13px; color: var(--ink-2); strong { color: var(--ink); } }`,
})
export class TargetEditor {
  private store = inject(Store);
  private actions = inject(Actions);
  readonly category = input.required<Category>();
  readonly forMonth = input.required<string>();
  readonly done = output<void>();

  readonly kinds: { id: Kind; label: string }[] = [
    { id: 'weekly', label: 'Weekly' }, { id: 'monthly', label: 'Monthly' }, { id: 'yearly', label: 'Yearly' },
    { id: 'custom', label: 'Custom' }, { id: 'savings', label: 'Savings' },
  ];
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
