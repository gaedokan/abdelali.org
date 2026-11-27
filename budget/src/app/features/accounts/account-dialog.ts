import { ChangeDetectionStrategy, Component, computed, effect, inject, signal, untracked } from '@angular/core';
import { Router } from '@angular/router';
import { Actions } from '../../core/actions';
import { Account, ACCOUNT_TYPES, AccountType, isCreditType } from '../../core/models';
import { parseMoney } from '../../core/money';
import { Store } from '../../core/store';
import { parseDate, today } from '../../core/util';
import { Icon } from '../../ui/icon';
import { MoneyPipe } from '../../ui/money.pipe';
import { Sheet } from '../../ui/sheet';
import { Toasts } from '../../ui/toast';
import { UiState } from '../../ui/ui-state';

const ICON: Record<string, string> = { checking: 'bank', savings: 'piggy', cash: 'cash', creditCard: 'card', lineOfCredit: 'card', investment: 'trend', asset: 'home', loan: 'scale', mortgage: 'home', liability: 'scale' };

/** Add a new account, or edit an existing one (ui.editAccountId). */
@Component({
  selector: 'app-account-dialog',
  imports: [Sheet, Icon],
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <app-sheet [open]="open()" [title]="editing() ? 'Edit account' : 'Add an account'" (closed)="close()">
      @if (open()) {
        <form class="stack" data-form (submit)="$event.preventDefault(); save()">
          @if (!editing()) {
            <div class="types">
              @for (t of types; track t.type) {
                <button type="button" class="type" [class.on]="type() === t.type" (click)="type.set(t.type)">
                  <app-icon [name]="icon[t.type]" [size]="18" /><span>{{ t.label.replace(' (tracking)', '') }}</span>
                  @if (!t.budget) { <small>Tracking</small> }
                </button>
              }
            </div>
            <p class="hint">{{ isBudget() ? 'Budget accounts hold money you spend; their balance flows into Ready to Assign.' : 'Tracking accounts count toward net worth but aren’t budgeted (stocks, car, loans).' }}</p>
          }
          <label class="field"><span>Name</span><input class="input" [value]="name()" (input)="name.set($any($event.target).value)" placeholder="e.g. CIH current account, Cash wallet" autofocus /></label>
          @if (!editing()) {
            <div class="two">
              <label class="field"><span>{{ isCredit() ? 'Amount you owe today' : 'Current balance' }}</span><input class="input amount" [value]="balance()" (input)="balance.set($any($event.target).value)" inputmode="decimal" placeholder="0,00" /></label>
              <label class="field"><span>As of</span><input class="input" [value]="date()" (input)="date.set($any($event.target).value)" placeholder="dd/mm/yyyy" /></label>
            </div>
          } @else {
            <label class="field"><span>Note</span><input class="input" [value]="note()" (input)="note.set($any($event.target).value)" placeholder="Account number, IBAN…" /></label>
            <label class="field"><span>iPhone Wallet card names</span>
              <input class="input" [value]="wallet()" (input)="wallet.set($any($event.target).value)" placeholder="e.g. CIH Visa, ••1234" />
              <small class="hint">Comma separated. Payments made with these cards in Apple Wallet are added to this account.</small></label>
          }
          <div class="row end">
            @if (editing(); as a) {
              <button class="btn ghost" type="button" (click)="toggleClosed(a)">{{ a.closed ? 'Reopen' : 'Close account' }}</button>
              <button class="btn ghost danger" type="button" (click)="remove(a)">Delete</button>
              <span class="grow"></span>
            }
            <button class="btn" type="button" (click)="close()">Cancel</button>
            <button class="btn primary" type="submit" [disabled]="!name().trim()">{{ editing() ? 'Save' : 'Add account' }}</button>
          </div>
        </form>
      }
    </app-sheet>`,
  styles: `
    .types { display: grid; grid-template-columns: repeat(3, 1fr); gap: 6px; }
    .type { display: flex; flex-direction: column; align-items: center; gap: 4px; padding: 12px 6px; border-radius: 12px; border: 1px solid var(--line); background: var(--surface); cursor: pointer; font-size: 12.5px; font-weight: 550; text-align: center;
      small { font-size: 10.5px; color: var(--ink-3); font-weight: 500; } app-icon { color: var(--ink-2); }
      &.on { border-color: var(--accent); background: var(--accent-soft); app-icon { color: var(--accent); } } }
    .hint { font-size: 12.5px; color: var(--ink-3); margin: 0; font-weight: 400; }
    .two { display: grid; grid-template-columns: 1fr 1fr; gap: 12px; }
    .end { justify-content: flex-end; }
    @media (max-width: 480px) { .types { grid-template-columns: repeat(2, 1fr); } }`,
})
export class AccountDialog {
  readonly ui = inject(UiState);
  private store = inject(Store);
  private actions = inject(Actions);
  private router = inject(Router);
  private toasts = inject(Toasts);
  readonly types = ACCOUNT_TYPES;
  readonly icon = ICON;

  readonly type = signal<AccountType>('checking');
  readonly name = signal('');
  readonly balance = signal('');
  readonly date = signal('');
  readonly note = signal('');
  readonly wallet = signal('');

  readonly editing = computed(() => (this.ui.editAccountId() ? this.store.accountMap().get(this.ui.editAccountId()!) ?? null : null));
  readonly open = computed(() => this.ui.addAccount() || !!this.editing());
  readonly isBudget = computed(() => ACCOUNT_TYPES.find((t) => t.type === this.type())!.budget);
  readonly isCredit = computed(() => isCreditType(this.type()) || ['loan', 'mortgage', 'liability'].includes(this.type()));

  constructor() {
    effect(() => {
      const a = this.editing();
      const adding = this.ui.addAccount();
      untracked(() => {
        if (a) { this.name.set(a.name); this.note.set(a.note ?? ''); this.wallet.set((a.walletNames ?? []).join(', ')); }
        else if (adding) { this.type.set('checking'); this.name.set(''); this.balance.set(''); this.date.set(''); }
      });
    });
  }

  close() { this.ui.addAccount.set(false); this.ui.editAccountId.set(null); }

  save() {
    const a = this.editing();
    if (a) {
      this.actions.updateAccount(a.id, {
        name: this.name().trim(), note: this.note(),
        walletNames: this.wallet().split(',').map((s) => s.trim().toLowerCase()).filter(Boolean),
      });
      this.close();
      return;
    }
    let bal = parseMoney(this.balance() || '0') ?? 0;
    if (this.isCredit()) bal = -Math.abs(bal);
    const date = parseDate(this.date(), this.store.settings().dateFormat) ?? today();
    const acct = this.actions.addAccount(this.name().trim(), this.type(), bal, date);
    this.close();
    this.router.navigate(['/accounts', acct.id]);
    this.toasts.show(`Added ${acct.name}`);
  }

  toggleClosed(a: Account) {
    const bal = this.store.budget().balances.get(a.id)?.working ?? 0;
    if (!a.closed && bal !== 0 && !confirm('This account still has a balance. Close it anyway?')) return;
    this.actions.updateAccount(a.id, { closed: !a.closed });
    this.close();
  }
  remove(a: Account) {
    if (!confirm(`Delete “${a.name}” and all of its transactions?`)) return;
    this.actions.deleteAccount(a.id);
    this.close();
    this.router.navigate(['/budget']);
    this.toasts.show(`Deleted ${a.name}`, { label: 'Undo', run: () => this.store.undo() });
  }
}
