import { ChangeDetectionStrategy, Component, computed, effect, ElementRef, inject, signal, viewChild } from '@angular/core';
import { Actions } from '../../core/actions';
import { RTA } from '../../core/models';
import { parseQuick } from '../../core/quick-parse';
import { Store } from '../../core/store';
import { today } from '../../core/util';
import { Icon } from '../../ui/icon';
import { DatePipe, MoneyPipe } from '../../ui/money.pipe';
import { Pickers } from '../../ui/pickers';
import { Sheet } from '../../ui/sheet';
import { Toasts } from '../../ui/toast';
import { UiState } from '../../ui/ui-state';

/**
 * One-line entry: "carrefour 245 groceries", "+12000 salary", "taxi 30 @cash yesterday".
 * Shows a live preview; Enter saves. "More options" opens the full form.
 */
@Component({
  selector: 'app-quick-add',
  imports: [Sheet, Icon, MoneyPipe, DatePipe],
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <app-sheet [open]="ui.quickAdd()" title="Quick add" (closed)="close()">
      @if (ui.quickAdd()) {
        <form (submit)="$event.preventDefault(); save()">
          <div class="qbox">
            <app-icon name="sparkles" [size]="18" />
            <input #q class="qinput" [value]="text()" (input)="text.set($any($event.target).value)" placeholder="Carrefour 245 groceries" autocomplete="off" autocapitalize="off" enterkeyhint="done" aria-label="Describe the transaction" />
          </div>
          <div class="examples">
            @for (ex of examples; track ex) { <button type="button" class="chip" (click)="text.set(ex); focus()">{{ ex }}</button> }
          </div>

          <div class="preview" [class.ready]="ready()" aria-live="polite">
            <div class="amt num" [class.in]="(r().amount ?? 0) > 0">{{ r().amount !== null ? (r().amount | money:'sign') : '—' }}</div>
            <dl>
              <div><dt>Payee</dt><dd>{{ r().payee || '—' }}</dd></div>
              <div><dt>Category</dt><dd [class.warn]="!r().categoryId && needsCat()">{{ catLabel() }}@if (r().categoryGuessed) { <small>remembered</small> }</dd></div>
              <div><dt>Account</dt><dd>
                <select class="select sm" aria-label="Account" [value]="accountId()" (change)="accountOverride.set($any($event.target).value)">
                  @for (a of accounts(); track a.id) { <option [value]="a.id">{{ a.name }}</option> }
                </select></dd></div>
              <div><dt>Date</dt><dd>{{ r().date | date }}</dd></div>
            </dl>
          </div>
          <p class="tips">Tips: start with <b>+</b> for income · <b>&#64;cash</b> picks an account · <b>#rent</b> picks a category · “yesterday”, “25/11” set the date.</p>
          <div class="row end">
            <button class="btn ghost" type="button" (click)="more()">More options</button>
            <button class="btn primary lg" type="submit" [disabled]="!ready()">Add</button>
          </div>
        </form>
      }
    </app-sheet>`,
  styles: `
    .qbox { display: flex; align-items: center; gap: 10px; padding: 0 14px; height: 54px; border-radius: 14px; border: 1.5px solid var(--accent); background: var(--surface); box-shadow: 0 0 0 4px var(--accent-soft); color: var(--accent); }
    .qinput { flex: 1; border: 0; background: none; font: 550 1.125rem/1 var(--font); color: var(--ink); min-width: 0; &:focus { outline: none; } &::placeholder { color: var(--ink-3); font-weight: 450; } }
    .examples { display: flex; gap: 6px; overflow-x: auto; padding: 10px 0 2px; .chip { flex: none; } }
    .preview { margin-top: 14px; display: grid; grid-template-columns: auto 1fr; gap: 18px; align-items: center; padding: 14px 16px; border-radius: 14px; background: var(--surface-2); border: 1px solid var(--line); }
    .amt { font: 700 1.625rem/1 var(--display); color: var(--neg); min-width: 110px; &.in { color: var(--pos); } }
    dl { margin: 0; display: grid; grid-template-columns: 1fr 1fr; gap: 8px 16px;
      div { min-width: 0; } dt { font-size: 0.6875rem; color: var(--ink-3); font-weight: 600; text-transform: uppercase; letter-spacing: .06em; }
      dd { margin: 2px 0 0; font-weight: 550; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; small { color: var(--ink-3); font-weight: 500; margin-left: 4px; } }
      dd.warn { color: var(--warn); } }
    .select.sm { height: 28px; font-size: 0.8125rem; padding-left: 8px; }
    .tips { font-size: 0.75rem; color: var(--ink-3); margin: 12px 0; }
    .end { justify-content: flex-end; } .lg { min-width: 120px; }
    @media (max-width: 520px) { .preview { grid-template-columns: 1fr; gap: 10px; } }`,
})
export class QuickAdd {
  readonly ui = inject(UiState);
  private store = inject(Store);
  private actions = inject(Actions);
  private pickers = inject(Pickers);
  private toasts = inject(Toasts);
  private q = viewChild<ElementRef<HTMLInputElement>>('q');

  readonly text = signal('');
  readonly accountOverride = signal<string | null>(null);
  readonly examples = ['Café 18', 'Marjane 420 groceries', 'Taxi 30 @cash', '+15000 salary', 'Inwi 99 #phone'];

  readonly accounts = computed(() => this.store.accounts().filter((a) => !a.closed));
  readonly r = computed(() => parseQuick(this.text(), {
    categories: this.store.categories(), accounts: this.accounts(), payees: this.store.payees(),
    defaultAccountId: this.store.settings().lastAccountId, dateFormat: this.store.settings().dateFormat,
  }));
  readonly accountId = computed(() => this.accountOverride() ?? this.r().accountId ?? '');
  readonly needsCat = computed(() => !!this.store.accountMap().get(this.accountId())?.onBudget);
  readonly catLabel = computed(() => {
    const id = this.r().categoryId ?? (this.r().amount && this.r().amount! > 0 ? RTA : null);
    return id ? this.pickers.categoryLabel(id) : this.needsCat() ? 'Needs a category' : '—';
  });
  readonly ready = computed(() => !!this.r().amount && !!this.accountId());

  constructor() {
    effect(() => {
      if (this.ui.quickAdd()) {
        this.text.set(this.ui.quickAddText());
        this.accountOverride.set(null);
        this.focus();
      }
    });
  }
  focus() { setTimeout(() => this.q()?.nativeElement.focus(), 30); }
  close() { this.ui.quickAdd.set(false); this.ui.quickAddText.set(''); }

  save() {
    if (!this.ready()) return;
    const r = this.r();
    const amount = r.amount!;
    const categoryId = r.categoryId ?? (amount > 0 ? RTA : null);
    this.actions.saveTxn({
      accountId: this.accountId(), date: r.date ?? today(), amount, payeeId: r.payeeId ?? null,
      payeeName: r.payeeId ? undefined : r.payee, categoryId, memo: r.memo, approved: true,
    });
    this.close();
    this.toasts.show(`Added ${r.payee || 'transaction'}`, { label: 'Undo', run: () => this.store.undo() });
  }
  more() {
    this.close();
    this.ui.txnEditor.set({ accountId: this.accountId() || undefined });
  }
}
