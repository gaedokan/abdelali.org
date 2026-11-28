import { ChangeDetectionStrategy, Component, computed, effect, inject, input, output, signal } from '@angular/core';
import { Actions } from '../../core/actions';
import { RTA } from '../../core/models';
import { parseMoney } from '../../core/money';
import { Store } from '../../core/store';
import { Combo, ComboItem } from '../../ui/combo';
import { MoneyPipe } from '../../ui/money.pipe';
import { Sheet } from '../../ui/sheet';
import { formatMoney } from '../../core/money';

/** Move money between two categories (or from/to Ready to Assign). */
@Component({
  selector: 'app-move-money',
  imports: [Sheet, Combo, MoneyPipe],
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <app-sheet [open]="!!request()" [title]="title()" (closed)="closed.emit()">
      @if (request(); as r) {
        <form class="stack" (submit)="$event.preventDefault(); save()" data-form>
          <label class="field"><span>Amount</span>
            <input class="input amount big" [value]="amount()" (input)="amount.set($any($event.target).value)" inputmode="decimal" autofocus />
          </label>
          <label class="field"><span>From</span><app-combo [items]="items()" [(value)]="from" placeholder="Category" /></label>
          <label class="field"><span>To</span><app-combo [items]="items()" [(value)]="to" placeholder="Category" /></label>
          <p class="muted small">Tip: you can also drag an Available amount onto another category.</p>
          <div class="row end">
            <button class="btn" type="button" (click)="closed.emit()">Cancel</button>
            <button class="btn primary" type="submit" [disabled]="!valid()">Move {{ parsed() ?? 0 | money }}</button>
          </div>
        </form>
      }
    </app-sheet>`,
  styles: `.big { height: 46px; font: 650 1.25rem/1 var(--display); } .end { justify-content: flex-end; } .small { font-size: 0.7812rem; margin: 0; }`,
})
export class MoveMoney {
  private store = inject(Store);
  private actions = inject(Actions);
  readonly request = input<{ from: string; to?: string; amount?: number } | null>(null);
  readonly month = input.required<string>();
  readonly closed = output<void>();

  readonly amount = signal('');
  readonly from = signal<string | null>(null);
  readonly to = signal<string | null>(null);
  readonly parsed = computed(() => { const v = parseMoney(this.amount()); return v && v > 0 ? v : null; });
  readonly valid = computed(() => !!this.parsed() && !!this.from() && !!this.to() && this.from() !== this.to());

  readonly title = computed(() => {
    const r = this.request();
    if (!r) return '';
    const av = this.store.budget().cat(this.month(), r.from).available;
    return av < 0 ? 'Cover overspending' : 'Move money';
  });

  readonly items = computed<ComboItem[]>(() => {
    const snap = this.store.budget();
    const f = this.store.format();
    const m = this.month();
    const out: ComboItem[] = [{ id: RTA, label: 'Ready to Assign', emoji: '💰', group: 'Budget', hint: formatMoney(snap.month(m).rta, f, { currency: false }) }];
    for (const g of this.store.groups()) {
      for (const c of this.store.categories().filter((c) => c.groupId === g.id && !c.hidden)) {
        const av = snap.cat(m, c.id).available;
        out.push({ id: c.id, label: c.name, emoji: c.emoji, group: g.name, hint: formatMoney(av, f, { currency: false }), hintTone: av < 0 ? 'neg' : av > 0 ? 'pos' : '' });
      }
    }
    return out;
  });

  constructor() {
    effect(() => {
      const r = this.request();
      if (!r) return;
      const av = this.store.budget().cat(this.month(), r.from).available;
      if (av < 0) {
        // covering overspending: money comes from somewhere else into this category
        this.to.set(r.from);
        this.from.set(r.to ?? (this.store.budget().month(this.month()).rta > 0 ? RTA : null));
        this.amount.set(this.fmt(r.amount ?? -av));
      } else {
        this.from.set(r.from);
        this.to.set(r.to ?? null);
        this.amount.set(this.fmt(r.amount ?? av));
      }
    });
  }
  private fmt(c: number) { return c > 0 ? (c / 100).toFixed(2).replace('.', ',') : ''; }

  save() {
    if (!this.valid()) return;
    this.actions.moveMoney(this.month(), this.from()!, this.to()!, this.parsed()!);
    this.closed.emit();
  }
}
