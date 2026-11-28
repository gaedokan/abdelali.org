import { ChangeDetectionStrategy, Component, computed, inject, signal } from '@angular/core';
import { Actions } from '../../core/actions';
import { Frequency, Scheduled } from '../../core/models';
import { formatMoney, parseMoney } from '../../core/money';
import { Store } from '../../core/store';
import { formatDate, parseDate, today } from '../../core/util';
import { Combo } from '../../ui/combo';
import { Icon } from '../../ui/icon';
import { DatePipe, MoneyPipe } from '../../ui/money.pipe';
import { Pickers } from '../../ui/pickers';
import { Sheet } from '../../ui/sheet';
import { Toasts } from '../../ui/toast';
import { FREQS } from '../accounts/txn-form';

@Component({
  selector: 'app-scheduled',
  imports: [Icon, MoneyPipe, DatePipe, Sheet, Combo],
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <div class="page">
      <header class="head">
        <div><h1>Scheduled</h1><p class="muted">Bills, salary and subscriptions are entered automatically on their date.</p></div>
        <button class="btn primary" type="button" (click)="open(null)"><app-icon name="plus" [size]="16" /> New</button>
      </header>
      <div class="summary card card-pad">
        <div><span>Next 30 days out</span><strong class="num amt-neg">{{ next30().out | money }}</strong></div>
        <div><span>Next 30 days in</span><strong class="num amt-pos">{{ next30().in | money }}</strong></div>
        <div><span>Monthly commitments</span><strong class="num">{{ monthly() | money }}</strong></div>
      </div>
      <div class="list card">
        @for (s of store.scheduled(); track s.id) {
          <button class="item" type="button" (click)="open(s)">
            <span class="when"><strong>{{ s.nextDate | date }}</strong><small>{{ freqLabel(s.frequency) }}</small></span>
            <span class="what"><strong>{{ s.transferAccountId ? 'Transfer to ' + acct(s.transferAccountId) : payee(s.payeeId) }}</strong><small>{{ cat(s.categoryId) }} · {{ acct(s.accountId) }}</small></span>
            <span class="num amt" [class.amt-pos]="s.amount > 0">{{ s.amount | money }}</span>
          </button>
        } @empty {
          <div class="empty"><h3>Nothing scheduled</h3><p>Add rent, salary, phone plans… They’ll appear in your accounts on time, and you can see what’s coming.</p></div>
        }
      </div>
    </div>

    <app-sheet [open]="editing() !== undefined" [title]="editing() ? 'Edit scheduled transaction' : 'New scheduled transaction'" (closed)="editing.set(undefined)">
      @if (editing() !== undefined) {
        <form class="stack" data-form (submit)="$event.preventDefault(); save()">
          <div class="seg block"><button type="button" [class.on]="dir() === 'out'" (click)="dir.set('out')">Outflow</button><button type="button" [class.on]="dir() === 'in'" (click)="dir.set('in')">Inflow</button></div>
          <div class="two">
            <label class="field"><span>Amount</span><input class="input amount" [value]="amount()" (input)="amount.set($any($event.target).value)" inputmode="decimal" /></label>
            <label class="field"><span>Next date</span><input class="input" [value]="date()" (input)="date.set($any($event.target).value)" placeholder="dd/mm/yyyy" /></label>
          </div>
          <label class="field"><span>Payee</span><app-combo [items]="payees()" [(value)]="payeeId" [(text)]="payeeText" [allowCreate]="true" placeholder="Payee or transfer" /></label>
          <label class="field"><span>Category</span><app-combo [items]="pickers.categories()" [(value)]="categoryId" placeholder="Category" /></label>
          <div class="two">
            <label class="field"><span>Account</span><app-combo [items]="pickers.accounts()" [(value)]="accountId" placeholder="Account" /></label>
            <label class="field"><span>Repeats</span><select class="select" [value]="freq()" (change)="freq.set($any($event.target).value)">
              <option value="once">Once</option>@for (f of freqs; track f.id) { @if (f.id !== 'never') {<option [value]="f.id">{{ f.label }}</option>} }</select></label>
          </div>
          <label class="field"><span>Memo</span><input class="input" [value]="memo()" (input)="memo.set($any($event.target).value)" /></label>
          <div class="row end">
            @if (editing(); as s) {
              <button class="btn ghost danger" type="button" (click)="remove(s)">Delete</button>
              <button class="btn ghost" type="button" (click)="enterNow(s)">Enter now</button>
              <span class="grow"></span>
            }
            <button class="btn primary" type="submit">Save</button>
          </div>
        </form>
      }
    </app-sheet>`,
  styles: `
    .page { padding: 20px 28px 120px; max-width: 900px; }
    .head { display: flex; justify-content: space-between; align-items: flex-end; gap: 12px; margin-bottom: 16px; h1 { font-size: 1.625rem; } p { margin: 4px 0 0; } }
    .summary { display: grid; grid-template-columns: repeat(3, 1fr); gap: 12px; margin-bottom: 14px; div { display: flex; flex-direction: column; } span { font-size: 0.75rem; color: var(--ink-3); font-weight: 600; } strong { font-size: 1.125rem; } }
    .list { overflow: hidden; }
    .item { display: grid; grid-template-columns: 130px 1fr auto; gap: 14px; align-items: center; width: 100%; padding: 12px 16px; border: 0; border-bottom: 1px solid var(--line); background: none; text-align: left; cursor: pointer;
      &:hover { background: var(--surface-2); } &:last-child { border-bottom: 0; }
      span { display: flex; flex-direction: column; min-width: 0; } small { color: var(--ink-3); font-size: 0.75rem; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; } .amt { font-weight: 650; } }
    .two { display: grid; grid-template-columns: 1fr 1fr; gap: 12px; }
    .end { justify-content: flex-end; }
    @media (max-width: 640px) { .page { padding: 14px 12px 110px; } .summary { grid-template-columns: 1fr 1fr; } .item { grid-template-columns: 1fr auto; .when { display: none; } } }`,
})
export class ScheduledPage {
  readonly store = inject(Store);
  readonly pickers = inject(Pickers);
  private actions = inject(Actions);
  private toasts = inject(Toasts);
  readonly freqs = FREQS;

  readonly editing = signal<Scheduled | null | undefined>(undefined);
  readonly dir = signal<'out' | 'in'>('out');
  readonly amount = signal('');
  readonly date = signal('');
  readonly payeeId = signal<string | null>(null);
  readonly payeeText = signal('');
  readonly categoryId = signal<string | null>(null);
  readonly accountId = signal<string | null>(null);
  readonly freq = signal<Frequency>('monthly');
  readonly memo = signal('');
  readonly payees = computed(() => this.pickers.payeeItems(this.accountId() ?? undefined));

  readonly next30 = computed(() => {
    const end = new Date(); end.setDate(end.getDate() + 30);
    const lim = end.toISOString().slice(0, 10);
    let out = 0, inn = 0;
    for (const s of this.store.scheduled()) {
      let d: string | null = s.nextDate, guard = 0;
      while (d && d <= lim && guard++ < 60) { if (s.amount < 0) out += s.amount; else inn += s.amount; d = Actions.nextOccurrence(d, s.frequency); }
    }
    return { out, in: inn };
  });
  readonly monthly = computed(() => {
    const per: Record<string, number> = { weekly: 52 / 12, every2weeks: 26 / 12, twiceMonthly: 2, monthly: 1, every2months: 0.5, every3months: 1 / 3, every6months: 1 / 6, yearly: 1 / 12, once: 0 };
    return Math.round(this.store.scheduled().filter((s) => s.amount < 0 && !s.transferAccountId).reduce((a, s) => a + s.amount * per[s.frequency], 0));
  });

  freqLabel(f: Frequency) { return f === 'once' ? 'Once' : FREQS.find((x) => x.id === f)?.label ?? f; }
  acct(id?: string | null) { return this.store.accountMap().get(id ?? '')?.name ?? ''; }
  payee(id?: string | null) { return this.store.payeeMap().get(id ?? '')?.name ?? 'No payee'; }
  cat(id?: string | null) { return this.pickers.categoryLabel(id) || 'No category'; }

  open(s: Scheduled | null) {
    const df = this.store.settings().dateFormat;
    this.dir.set(s && s.amount > 0 ? 'in' : 'out');
    this.amount.set(s ? formatMoney(Math.abs(s.amount), this.store.format(), { currency: false }) : '');
    this.date.set(formatDate(s?.nextDate ?? today(), df));
    this.payeeId.set(s?.transferAccountId ? 'transfer:' + s.transferAccountId : s?.payeeId ?? null);
    this.payeeText.set('');
    this.categoryId.set(s?.categoryId ?? null);
    this.accountId.set(s?.accountId ?? this.store.settings().lastAccountId ?? this.store.accounts()[0]?.id ?? null);
    this.freq.set(s?.frequency ?? 'monthly');
    this.memo.set(s?.memo ?? '');
    this.editing.set(s);
  }

  save() {
    const amt = parseMoney(this.amount());
    const date = parseDate(this.date(), this.store.settings().dateFormat);
    if (!amt || !date || !this.accountId()) { this.toasts.show('Amount, date and account are required', undefined, 3000, 'error'); return; }
    const p = this.payeeId();
    const transferAccountId = p?.startsWith('transfer:') ? p.slice(9) : null;
    const payeeId = transferAccountId ? null : p ?? (this.payeeText().trim() ? this.actions.payeeFor(this.payeeText()).id : null);
    this.actions.saveScheduled({
      id: this.editing()?.id, accountId: this.accountId()!, nextDate: date, frequency: this.freq(),
      amount: this.dir() === 'out' ? -Math.abs(amt) : Math.abs(amt), payeeId, categoryId: this.categoryId(), transferAccountId, memo: this.memo(),
    });
    this.editing.set(undefined);
    if (date <= today()) this.actions.enterDue();
  }
  remove(s: Scheduled) { this.store.remove(s.id); this.editing.set(undefined); this.toasts.show('Deleted', { label: 'Undo', run: () => this.store.undo() }); }
  enterNow(s: Scheduled) { this.actions.enterScheduled(s.id, today()); this.editing.set(undefined); this.toasts.show('Entered', { label: 'Undo', run: () => this.store.undo() }); }
}
