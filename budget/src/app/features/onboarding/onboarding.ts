import { ChangeDetectionStrategy, Component, computed, inject, signal } from '@angular/core';
import { Actions } from '../../core/actions';
import { AccountType } from '../../core/models';
import { parseMoney } from '../../core/money';
import { applyTemplate, loadDemo, TEMPLATE } from '../../core/seed';
import { Store } from '../../core/store';
import { Sync } from '../../core/sync';
import { Icon } from '../../ui/icon';

interface DraftAccount { name: string; type: AccountType; balance: string }

/** Two-minute setup: name → accounts → categories → done. Or load the demo, or connect to sync. */
@Component({
  selector: 'app-onboarding',
  imports: [Icon],
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <div class="wrap">
      <div class="card ob">
        <div class="steps">@for (s of [0,1,2]; track s) { <i [class.on]="step() >= s"></i> }</div>

        @switch (step()) {
          @case (0) {
            <div class="hero-icon"><app-icon name="wallet" [size]="28" /></div>
            <h1>Give every dirham a job.</h1>
            <p class="lead">Envelope is zero-based budgeting: you plan only the money you actually have, category by category, and adjust as life happens.</p>
            <label class="field"><span>What should we call this budget?</span><input class="input lg" [value]="name()" (input)="name.set($any($event.target).value)" (keydown.enter)="step.set(1)" /></label>
            <div class="row end">
              <button class="btn ghost" type="button" (click)="showSync.set(!showSync())"><app-icon name="cloud" [size]="15" /> I already use Envelope on another device</button>
              <button class="btn primary lg" type="button" (click)="step.set(1)">Get started</button>
            </div>
            @if (showSync()) {
              <div class="sync-box">
                <p class="muted">Enter the sync password set on your server to download your budget.</p>
                <div class="row"><input class="input" type="password" [value]="pw()" (input)="pw.set($any($event.target).value)" placeholder="Sync password" (keydown.enter)="connect()" /><button class="btn primary" type="button" (click)="connect()" [disabled]="busy()">Connect</button></div>
                @if (err()) { <p class="err">{{ err() }}</p> }
              </div>
            }
            <button class="link" type="button" (click)="demo()">Or explore a demo budget first →</button>
          }
          @case (1) {
            <h1>Where is your money?</h1>
            <p class="lead">Add the accounts you spend from. Use the balance you see in your banking app today. Cash counts too!</p>
            <div class="accts">
              @for (a of accounts(); track $index; let i = $index) {
                <div class="acct">
                  <select class="select" [value]="a.type" (change)="patch(i, { type: $any($event.target).value })">
                    <option value="checking">Bank account</option><option value="savings">Savings</option><option value="cash">Cash</option><option value="creditCard">Credit card</option>
                  </select>
                  <input class="input" [value]="a.name" (input)="patch(i, { name: $any($event.target).value })" placeholder="Name" />
                  <input class="input amount" [value]="a.balance" (input)="patch(i, { balance: $any($event.target).value })" [placeholder]="a.type === 'creditCard' ? 'Owed' : 'Balance'" inputmode="decimal" />
                  <button class="btn ghost icon sm" type="button" (click)="removeAcct(i)" aria-label="Remove"><app-icon name="x" [size]="15" /></button>
                </div>
              }
              <button class="btn sm ghost" type="button" (click)="addAcct()"><app-icon name="plus" [size]="15" /> Add another</button>
            </div>
            <div class="row end"><button class="btn ghost" type="button" (click)="step.set(0)">Back</button><button class="btn primary lg" type="button" (click)="step.set(2)" [disabled]="!validAccounts().length">Continue</button></div>
          }
          @case (2) {
            <h1>What do you spend on?</h1>
            <p class="lead">Start with these categories — you can rename, add or remove anything later.</p>
            <div class="tmpl">
              @for (g of template; track g.group) {
                <div class="tg">
                  <label class="gname"><input type="checkbox" [checked]="groupOn(g.group)" (change)="toggleGroup(g.group)" /> {{ g.group }}</label>
                  <div class="tags">@for (it of g.items; track it.name) {
                    <button type="button" class="tag" [class.off]="!itemOn(it.name)" (click)="toggleItem(it.name)">{{ it.emoji }} {{ it.name }}</button>
                  }</div>
                </div>
              }
            </div>
            <div class="row end"><button class="btn ghost" type="button" (click)="step.set(1)">Back</button><button class="btn primary lg" type="button" (click)="finish()">Start budgeting</button></div>
          }
        }
      </div>
    </div>`,
  styles: `
    .wrap { min-height: 100dvh; display: grid; place-items: center; padding: 24px 16px; background: radial-gradient(1200px 600px at 20% -10%, var(--accent-soft), transparent), var(--bg); }
    .ob { width: min(640px, 100%); padding: 32px; display: flex; flex-direction: column; gap: 18px; border-radius: 22px; }
    .steps { display: flex; gap: 6px; i { height: 4px; flex: 1; border-radius: 4px; background: var(--line); transition: background .3s; &.on { background: var(--accent); } } }
    .hero-icon { width: 54px; height: 54px; border-radius: 16px; background: var(--accent-soft); color: var(--accent); display: grid; place-items: center; }
    h1 { font-size: 30px; line-height: 1.1; }
    .lead { margin: -6px 0 0; color: var(--ink-2); font-size: 15.5px; line-height: 1.5; }
    .input.lg { height: 46px; font-size: 16px; }
    .end { justify-content: flex-end; flex-wrap: wrap; }
    .link { border: 0; background: none; color: var(--accent-ink); font-weight: 600; cursor: pointer; align-self: center; padding: 6px; }
    .sync-box { padding: 14px; border-radius: 12px; background: var(--surface-2); border: 1px solid var(--line); p { margin: 0 0 8px; font-size: 13.5px; } }
    .err { color: var(--neg) !important; margin-top: 8px !important; }
    .accts { display: flex; flex-direction: column; gap: 8px; }
    .acct { display: grid; grid-template-columns: 140px 1fr 130px 30px; gap: 8px; align-items: center; }
    .tmpl { display: flex; flex-direction: column; gap: 14px; max-height: 46dvh; overflow: auto; }
    .gname { display: flex; gap: 8px; align-items: center; font-weight: 650; margin-bottom: 6px; }
    .tags { display: flex; flex-wrap: wrap; gap: 6px; }
    .tag { border: 1px solid var(--accent); background: var(--accent-soft); color: var(--accent-ink); border-radius: 999px; padding: 5px 11px; cursor: pointer; font-size: 13px; font-weight: 550;
      &.off { background: var(--surface); border-color: var(--line); color: var(--ink-3); text-decoration: line-through; } }
    @media (max-width: 560px) { .ob { padding: 22px 18px; } h1 { font-size: 24px; } .acct { grid-template-columns: 1fr 1fr 30px; .select { grid-column: span 3; } } }`,
})
export class Onboarding {
  private store = inject(Store);
  private actions = inject(Actions);
  private sync = inject(Sync);
  readonly template = TEMPLATE;
  readonly step = signal(0);
  readonly name = signal('My budget');
  readonly showSync = signal(false);
  readonly pw = signal('');
  readonly err = signal<string | null>(null);
  readonly busy = signal(false);
  readonly accounts = signal<DraftAccount[]>([
    { name: 'Bank account', type: 'checking', balance: '' },
    { name: 'Cash wallet', type: 'cash', balance: '' },
  ]);
  readonly off = signal<Set<string>>(new Set(['Insurance', 'Education', 'New phone']));
  readonly validAccounts = computed(() => this.accounts().filter((a) => a.name.trim()));

  patch(i: number, p: Partial<DraftAccount>) { this.accounts.update((xs) => xs.map((x, j) => (j === i ? { ...x, ...p } : x))); }
  addAcct() { this.accounts.update((xs) => [...xs, { name: '', type: 'checking', balance: '' }]); }
  removeAcct(i: number) { this.accounts.update((xs) => xs.filter((_, j) => j !== i)); }
  itemOn(n: string) { return !this.off().has(n); }
  toggleItem(n: string) { const s = new Set(this.off()); if (s.has(n)) s.delete(n); else s.add(n); this.off.set(s); }
  groupOn(g: string) { return TEMPLATE.find((x) => x.group === g)!.items.some((i) => this.itemOn(i.name)); }
  toggleGroup(g: string) {
    const items = TEMPLATE.find((x) => x.group === g)!.items.map((i) => i.name);
    const s = new Set(this.off());
    const on = this.groupOn(g);
    for (const i of items) on ? s.add(i) : s.delete(i);
    this.off.set(s);
  }

  finish() {
    this.store.transact('Set up budget', () => {
      this.actions.updateSettings({ budgetName: this.name().trim() || 'My budget', onboarded: true });
      for (const a of this.validAccounts()) {
        let bal = parseMoney(a.balance || '0') ?? 0;
        if (a.type === 'creditCard') bal = -Math.abs(bal);
        this.actions.addAccount(a.name.trim(), a.type, bal);
      }
      const groups = TEMPLATE.map((g) => ({ group: g.group, items: g.items.filter((i) => this.itemOn(i.name)) })).filter((g) => g.items.length);
      applyTemplate(this.actions, this.store, groups);
    });
  }
  demo() { loadDemo(this.actions, this.store); }
  async connect() {
    this.busy.set(true);
    this.err.set(await this.sync.connect(this.pw()));
    this.busy.set(false);
  }
}
