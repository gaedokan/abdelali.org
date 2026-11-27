import { ChangeDetectionStrategy, Component, computed, effect, ElementRef, inject, signal, viewChild } from '@angular/core';
import { Router } from '@angular/router';
import { Store } from '../../core/store';
import { fuzzy } from '../../core/util';
import { Icon } from '../../ui/icon';
import { MoneyPipe } from '../../ui/money.pipe';
import { UiState } from '../../ui/ui-state';

interface Cmd { id: string; label: string; hint?: string; icon: string; group: string; run: () => void; keywords?: string }

/** ⌘K: jump anywhere, run any action. */
@Component({
  selector: 'app-palette',
  imports: [Icon],
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    @if (ui.palette()) {
      <div class="scrim" (click)="close()">
        <div class="pal" (click)="$event.stopPropagation()" role="dialog" aria-label="Search">
          <div class="pin"><app-icon name="search" [size]="18" />
            <input #inp [value]="q()" (input)="q.set($any($event.target).value); active.set(0)" (keydown)="key($event)" placeholder="Search accounts, categories, payees, actions…" autocomplete="off" />
            <span class="kbd">Esc</span></div>
          <div class="list">
            @for (c of results(); track c.id; let i = $index) {
              @if (i === 0 || results()[i - 1].group !== c.group) { <div class="grp">{{ c.group }}</div> }
              <button type="button" class="item" [class.on]="i === active()" (mouseenter)="active.set(i)" (click)="run(c)">
                <app-icon [name]="c.icon" [size]="16" /><span class="lbl">{{ c.label }}</span>@if (c.hint) {<span class="hint">{{ c.hint }}</span>}
              </button>
            } @empty { <div class="none">No results. Press Enter to quick-add “{{ q() }}”.</div> }
          </div>
        </div>
      </div>
    }`,
  styles: `
    .scrim { position: fixed; inset: 0; z-index: 200; background: rgba(15,18,16,.4); backdrop-filter: blur(2px); display: flex; justify-content: center; align-items: flex-start; padding: 12vh 16px 16px; animation: f .15s; }
    @keyframes f { from { opacity: 0; } }
    .pal { width: min(620px, 100%); background: var(--surface); border-radius: 16px; box-shadow: var(--shadow-2); border: 1px solid var(--line); overflow: hidden; animation: p .18s var(--ease); }
    @keyframes p { from { transform: translateY(-8px) scale(.98); opacity: 0; } }
    .pin { display: flex; align-items: center; gap: 10px; padding: 0 16px; height: 56px; border-bottom: 1px solid var(--line); color: var(--ink-3);
      input { flex: 1; border: 0; background: none; font-size: 16px; color: var(--ink); &:focus { outline: none; } } }
    .list { max-height: 56vh; overflow: auto; padding: 6px; }
    .grp { font: 650 10.5px/1 var(--font); text-transform: uppercase; letter-spacing: .07em; color: var(--ink-3); padding: 10px 10px 4px; }
    .item { display: flex; align-items: center; gap: 10px; width: 100%; border: 0; background: none; padding: 9px 10px; border-radius: 9px; cursor: pointer; text-align: left; color: var(--ink-2);
      .lbl { flex: 1; color: var(--ink); } .hint { font-size: 12.5px; font-variant-numeric: tabular-nums; }
      &.on { background: var(--accent-soft); color: var(--accent-ink); } }
    .none { padding: 18px; color: var(--ink-3); font-size: 13.5px; }`,
})
export class Palette {
  readonly ui = inject(UiState);
  private store = inject(Store);
  private router = inject(Router);
  private inp = viewChild<ElementRef<HTMLInputElement>>('inp');
  private money = new MoneyPipe();
  readonly q = signal('');
  readonly active = signal(0);

  constructor() {
    effect(() => { if (this.ui.palette()) { this.q.set(''); this.active.set(0); setTimeout(() => this.inp()?.nativeElement.focus()); } });
  }

  readonly commands = computed<Cmd[]>(() => {
    const go = (path: unknown[], q?: Record<string, string>) => () => this.router.navigate(path, q ? { queryParams: q } : {});
    const snap = this.store.budget();
    const m = this.ui.month();
    const out: Cmd[] = [
      { id: 'a:add', label: 'Add transaction', icon: 'plus', group: 'Actions', hint: 'N', run: () => this.ui.quickAdd.set(true), keywords: 'new spend expense' },
      { id: 'a:acct', label: 'Add account', icon: 'bank', group: 'Actions', run: () => this.ui.addAccount.set(true) },
      { id: 'a:import', label: 'Import bank file (CSV, OFX)', icon: 'import', group: 'Actions', run: () => this.ui.importFor.set(null) },
      { id: 'a:undo', label: 'Undo ' + (this.store.canUndo() ?? ''), icon: 'undo', group: 'Actions', hint: '⌘Z', run: () => this.store.undo() },
      { id: 'a:theme', label: 'Toggle dark mode', icon: 'moon', group: 'Actions', run: () => this.ui.setTheme(document.documentElement.getAttribute('data-theme') === 'dark' || (this.ui.theme() === 'system' && matchMedia('(prefers-color-scheme: dark)').matches) ? 'light' : 'dark') },
      { id: 'n:budget', label: 'Budget', icon: 'grid', group: 'Go to', hint: 'G B', run: go(['/budget']) },
      { id: 'n:all', label: 'All accounts', icon: 'bank', group: 'Go to', hint: 'G T', run: go(['/accounts']) },
      { id: 'n:reports', label: 'Reports', icon: 'chart', group: 'Go to', hint: 'G R', run: go(['/reports']) },
      { id: 'n:invest', label: 'Investments (Bourse de Casablanca)', icon: 'trend', group: 'Go to', run: go(['/portfolio']), keywords: 'stocks portfolio bourse masi' },
      { id: 'n:sched', label: 'Scheduled transactions', icon: 'repeat', group: 'Go to', run: go(['/scheduled']) },
      { id: 'n:settings', label: 'Settings', icon: 'settings', group: 'Go to', hint: 'G S', run: go(['/settings']), keywords: 'sync backup wallet shortcut' },
    ];
    for (const a of this.store.accounts()) out.push({ id: 'acc:' + a.id, label: a.name, icon: 'wallet', group: 'Accounts', hint: this.money.transform(snap.balances.get(a.id)?.working ?? 0, 'plain'), run: go(['/accounts', a.id]) });
    for (const c of this.store.categories()) if (!c.hidden) out.push({ id: 'cat:' + c.id, label: `${c.emoji ? c.emoji + ' ' : ''}${c.name}`, icon: 'target', group: 'Categories', hint: this.money.transform(snap.cat(m, c.id).available, 'plain'), run: go(['/budget']) });
    for (const p of this.store.payees()) out.push({ id: 'p:' + p.id, label: p.name, icon: 'search', group: 'Payees', hint: 'transactions', run: go(['/accounts'], { q: p.name }) });
    return out;
  });

  readonly results = computed(() => {
    const q = this.q().trim();
    const cmds = this.commands();
    if (!q) return cmds.filter((c) => c.group === 'Actions' || c.group === 'Go to');
    return cmds
      .map((c) => ({ c, s: Math.max(fuzzy(q, c.label), c.keywords ? fuzzy(q, c.keywords) - 10 : 0) - (c.group === 'Payees' ? 15 : 0) }))
      .filter((x) => x.s > 0)
      .sort((a, b) => b.s - a.s)
      .slice(0, 30)
      .sort((a, b) => order(a.c.group) - order(b.c.group) || b.s - a.s)
      .map((x) => x.c);
  });

  key(e: KeyboardEvent) {
    const n = this.results().length;
    if (e.key === 'ArrowDown') { e.preventDefault(); this.active.set(Math.min(n - 1, this.active() + 1)); }
    else if (e.key === 'ArrowUp') { e.preventDefault(); this.active.set(Math.max(0, this.active() - 1)); }
    else if (e.key === 'Escape') { this.close(); }
    else if (e.key === 'Enter') {
      e.preventDefault();
      const c = this.results()[this.active()];
      if (c) this.run(c);
      else if (this.q().trim()) { this.ui.quickAddText.set(this.q()); this.close(); this.ui.quickAdd.set(true); }
    }
  }
  run(c: Cmd) { this.close(); c.run(); }
  close() { this.ui.palette.set(false); }
}

function order(g: string) { return ['Actions', 'Go to', 'Accounts', 'Categories', 'Payees'].indexOf(g); }
