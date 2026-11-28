import { ChangeDetectionStrategy, Component, computed, effect, inject, OnInit } from '@angular/core';
import { Router, RouterLink, RouterLinkActive, RouterOutlet } from '@angular/router';
import { Actions } from './core/actions';
import { Store } from './core/store';
import { Sync } from './core/sync';
import { AccountDialog } from './features/accounts/account-dialog';
import { TxnEditor } from './features/accounts/txn-editor';
import { ImportDialog } from './features/import/import-dialog';
import { Onboarding } from './features/onboarding/onboarding';
import { Palette } from './features/palette/palette';
import { QuickAdd } from './features/quick-add/quick-add';
import { Icon } from './ui/icon';
import { MoneyPipe } from './ui/money.pipe';
import { Toasts } from './ui/toast';
import { applyTheme, UiState } from './ui/ui-state';

@Component({
  selector: 'app-root',
  imports: [RouterOutlet, RouterLink, RouterLinkActive, Icon, MoneyPipe, QuickAdd, Palette, AccountDialog, ImportDialog, TxnEditor, Onboarding],
  changeDetection: ChangeDetectionStrategy.OnPush,
  templateUrl: './app.html',
  styleUrl: './app.scss',
  host: { '(document:keydown)': 'keys($event)' },
})
export class App implements OnInit {
  readonly store = inject(Store);
  readonly sync = inject(Sync);
  readonly ui = inject(UiState);
  readonly toasts = inject(Toasts);
  private actions = inject(Actions);
  private router = inject(Router);

  readonly budgetAccounts = computed(() => this.store.accounts().filter((a) => a.onBudget && !a.closed));
  readonly trackingAccounts = computed(() => this.store.accounts().filter((a) => !a.onBudget && !a.closed));
  readonly closedAccounts = computed(() => this.store.accounts().filter((a) => a.closed));
  readonly balances = computed(() => this.store.budget().balances);
  readonly sum = (ids: { id: string }[]) => ids.reduce((s, a) => s + (this.balances().get(a.id)?.working ?? 0), 0);
  readonly needsReview = computed(() => {
    const m = new Map<string, number>();
    for (const t of this.store.txns()) if (!t.approved) m.set(t.accountId, (m.get(t.accountId) ?? 0) + 1);
    return m;
  });
  readonly totalReview = computed(() => [...this.needsReview().values()].reduce((a, b) => a + b, 0));
  readonly rta = computed(() => this.store.budget().month(this.ui.month()).rta);
  readonly isMac = typeof navigator !== 'undefined' && /Mac|iPhone|iPad/.test(navigator.platform);

  constructor() {
    applyTheme(this.ui.theme());
    // keep the browser tab title informative
    effect(() => {
      const name = this.store.settings().budgetName;
      document.title = name ? `${name} · Envelope` : 'Envelope';
    });
  }

  async ngOnInit() {
    await this.store.init();
    await this.sync.init();
    const n = this.actions.enterDue();
    if (n) this.toasts.show(`Entered ${n} scheduled transaction${n > 1 ? 's' : ''}`);
  }

  keys(e: KeyboardEvent) {
    const mod = e.metaKey || e.ctrlKey;
    const target = e.target as HTMLElement;
    const typing = target.closest('input, textarea, select, [contenteditable]');
    if (mod && e.key.toLowerCase() === 'k') { e.preventDefault(); this.ui.palette.update((v) => !v); return; }
    if (mod && e.key.toLowerCase() === 'z' && !typing) {
      e.preventDefault();
      if (e.shiftKey) this.redo(); else this.undo();
      return;
    }
    if (mod && e.key.toLowerCase() === 'y' && !typing) { e.preventDefault(); this.redo(); return; }
    if (typing || mod || e.altKey || document.querySelector('dialog[open]')) return;
    switch (e.key) {
      case 'n': case 'a': e.preventDefault(); this.ui.quickAdd.set(true); break;
      case '/': e.preventDefault(); this.ui.palette.set(true); break;
      case 'g': this.pendingG = true; setTimeout(() => (this.pendingG = false), 800); break;
      case 'b': if (this.pendingG) this.router.navigate(['/budget']); break;
      case 'r': if (this.pendingG) this.router.navigate(['/reports']); break;
      case 't': if (this.pendingG) this.router.navigate(['/accounts']); break;
      case 's': if (this.pendingG) this.router.navigate(['/settings']); break;
    }
  }
  private pendingG = false;

  undo() {
    const label = this.store.canUndo();
    if (!label) return;
    this.store.undo();
    this.toasts.show(`Undone: ${label}`, { label: 'Redo', run: () => this.store.redo() });
  }
  redo() {
    const label = this.store.canRedo();
    if (!label) return;
    this.store.redo();
    this.toasts.show(`Redone: ${label}`);
  }

  closeNav() { this.ui.sidebarOpen.set(false); }
}
