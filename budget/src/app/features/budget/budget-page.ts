import { ChangeDetectionStrategy, Component, computed, effect, ElementRef, inject, input, signal } from '@angular/core';
import { Router } from '@angular/router';
import { Actions } from '../../core/actions';
import { STRATEGIES, Strategy, strategyAmount } from '../../core/autoassign';
import { CatMonth, UNCAT } from '../../core/engine';
import { Category, Group, RTA } from '../../core/models';
import { parseMoney } from '../../core/money';
import { Store } from '../../core/store';
import { addMonths, monthLabel, monthName, thisMonth } from '../../core/util';
import { Icon } from '../../ui/icon';
import { MoneyPipe } from '../../ui/money.pipe';
import { Ring } from '../../ui/ring';
import { Sheet } from '../../ui/sheet';
import { Toasts } from '../../ui/toast';
import { UiState } from '../../ui/ui-state';
import { Inspector } from './inspector';
import { MoveMoney } from './move-money';

type Filter = 'all' | 'underfunded' | 'overspent' | 'available';

export interface Row { cat: Category; cm: CatMonth }
export interface GroupRow { group: Group; rows: Row[]; assigned: number; activity: number; available: number }

@Component({
  selector: 'app-budget-page',
  imports: [Icon, MoneyPipe, Ring, Sheet, Inspector, MoveMoney],
  changeDetection: ChangeDetectionStrategy.OnPush,
  templateUrl: './budget-page.html',
  styleUrl: './budget-page.scss',
})
export class BudgetPage {
  readonly store = inject(Store);
  readonly ui = inject(UiState);
  private actions = inject(Actions);
  private toasts = inject(Toasts);
  private router = inject(Router);
  private host = inject<ElementRef<HTMLElement>>(ElementRef);

  /** route param */
  readonly monthParam = input<string | undefined>(undefined, { alias: 'month' });

  readonly month = this.ui.month;
  readonly filter = signal<Filter>('all');
  readonly selectedId = signal<string | null>(null);
  readonly editingId = signal<string | null>(null);
  readonly move = signal<{ from: string; to?: string; amount?: number } | null>(null);
  readonly fundPreview = signal(false);
  readonly assignMenu = signal(false);
  readonly newGroup = signal<string | null>(null);
  readonly newCatFor = signal<string | null>(null);
  readonly renaming = signal<string | null>(null);
  readonly dragId = signal<string | null>(null);
  readonly dropTarget = signal<string | null>(null);
  readonly mobileSheet = signal(false);
  readonly strategies = STRATEGIES;
  readonly UNCAT = UNCAT;

  readonly label = computed(() => monthLabel(this.month()));
  readonly isCurrent = computed(() => this.month() === thisMonth());
  readonly md = computed(() => this.store.budget().month(this.month()));
  readonly rta = computed(() => this.md().rta);
  readonly prevMonthName = computed(() => monthName(addMonths(this.month(), -1)));

  readonly groups = computed<GroupRow[]>(() => {
    const snap = this.store.budget();
    const m = this.month();
    const f = this.filter();
    const cats = this.store.categories();
    const out: GroupRow[] = [];
    for (const g of this.store.groups()) {
      if (g.hidden) continue;
      const rows: Row[] = [];
      for (const c of cats) {
        if (c.groupId !== g.id || c.hidden) continue;
        const cm = snap.cat(m, c.id);
        if (f === 'underfunded' && !(cm.target && cm.target.underfunded > 0)) continue;
        if (f === 'overspent' && cm.available >= 0) continue;
        if (f === 'available' && cm.available <= 0) continue;
        rows.push({ cat: c, cm });
      }
      if (g.system && !rows.length) continue;
      if (f !== 'all' && !rows.length) continue;
      out.push({
        group: g, rows,
        assigned: rows.reduce((s, r) => s + r.cm.assigned, 0),
        activity: rows.reduce((s, r) => s + r.cm.activity, 0),
        available: rows.reduce((s, r) => s + r.cm.available, 0),
      });
    }
    return out;
  });

  readonly uncategorised = computed(() => {
    const cm = this.store.budget().cat(this.month(), UNCAT);
    return cm.activity || cm.available ? cm : null;
  });

  readonly counts = computed(() => {
    const snap = this.store.budget();
    const m = this.month();
    let under = 0, over = 0, avail = 0;
    for (const c of this.store.categories()) {
      if (c.hidden) continue;
      const cm = snap.cat(m, c.id);
      if (cm.target && cm.target.underfunded > 0) under++;
      if (cm.available < 0) over++;
      if (cm.available > 0) avail++;
    }
    return { under, over, avail };
  });

  readonly hiddenCount = computed(() => this.store.categories().filter((c) => c.hidden && !c.ccAccountId).length);
  readonly hasCategories = computed(() => this.store.categories().some((c) => !c.ccAccountId));

  /** Fund-targets preview: in budget order until Ready to Assign runs out */
  readonly fundPlan = computed(() => {
    const snap = this.store.budget();
    const m = this.month();
    let left = Math.max(0, this.rta());
    const items: { cat: Category; need: number; give: number }[] = [];
    for (const g of this.store.groups()) {
      for (const c of this.store.categories().filter((c) => c.groupId === g.id && !c.hidden)) {
        const need = snap.cat(m, c.id).target?.underfunded ?? 0;
        if (need <= 0) continue;
        const give = Math.min(need, left);
        left -= give;
        items.push({ cat: c, need, give });
      }
    }
    const total = items.reduce((s, i) => s + i.need, 0);
    const giving = items.reduce((s, i) => s + i.give, 0);
    return { items, total, giving, short: total - giving };
  });

  constructor() {
    effect(() => {
      const p = this.monthParam();
      if (p && /^\d{4}-\d{2}$/.test(p) && p !== this.month()) this.month.set(p);
    });
  }

  go(delta: number) {
    const m = delta === 0 ? thisMonth() : addMonths(this.month(), delta);
    this.month.set(m);
    this.router.navigate(m === thisMonth() ? ['/budget'] : ['/budget', m], { replaceUrl: true });
  }

  select(id: string) {
    this.selectedId.set(this.selectedId() === id ? null : id);
    if (window.matchMedia('(max-width: 1180px)').matches) this.mobileSheet.set(!!this.selectedId());
  }

  // ------------------------------------------------------------ assigning
  startEdit(id: string, e?: Event) {
    e?.stopPropagation();
    // phones: tapping a row opens the category sheet, which has its own assign field
    if (e && window.matchMedia('(max-width: 720px)').matches) { this.select(id); return; }
    this.editingId.set(id);
    setTimeout(() => {
      const el = this.host.nativeElement.querySelector<HTMLInputElement>(`input[data-assign="${id}"]`);
      el?.focus();
      el?.select();
    });
  }

  commitAssign(cat: Category, raw: string, current: number) {
    this.editingId.set(null);
    const t = raw.trim();
    if (!t) return;
    let v: number | null;
    // "+50" / "-50" adjust the current amount
    if (/^[+-]/.test(t) && current !== 0) {
      const d = parseMoney(t.slice(1));
      v = d === null ? null : current + (t[0] === '+' ? d : -d);
    } else v = parseMoney(t);
    if (v === null) { this.toasts.show('That isn’t a number', undefined, 2500, 'error'); return; }
    this.actions.setAssigned(this.month(), cat.id, v);
  }

  assignKey(e: KeyboardEvent, cat: Category, current: number) {
    const el = e.target as HTMLInputElement;
    if (e.key === 'Enter' || e.key === 'Tab' || e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      e.preventDefault();
      this.commitAssign(cat, el.value, current);
      // move to next/previous row like a spreadsheet
      const ids = this.groups().flatMap((g) => (g.group.collapsed ? [] : g.rows.map((r) => r.cat.id)));
      const i = ids.indexOf(cat.id);
      const next = e.key === 'ArrowUp' || (e.key === 'Tab' && e.shiftKey) ? ids[i - 1] : ids[i + 1];
      if (next && e.key !== 'Enter') this.startEdit(next);
    } else if (e.key === 'Escape') {
      this.editingId.set(null);
    }
  }

  applyStrategy(s: Strategy, catId?: string) {
    const snap = this.store.budget();
    const m = this.month();
    const ids = catId ? [catId] : this.store.categories().filter((c) => !c.hidden).map((c) => c.id);
    const amounts = new Map<string, number>();
    for (const id of ids) {
      const v = strategyAmount(s, snap, m, id);
      if (v !== snap.cat(m, id).assigned) amounts.set(id, v);
    }
    this.assignMenu.set(false);
    if (!amounts.size) { this.toasts.show('Nothing to change'); return; }
    const label = STRATEGIES.find((x) => x.id === s)!.label;
    this.actions.bulkAssign(m, amounts, label);
    this.toasts.show(`${label}: ${amounts.size} categor${amounts.size === 1 ? 'y' : 'ies'} updated`, { label: 'Undo', run: () => this.store.undo() });
  }

  fundTargets() {
    const plan = this.fundPlan();
    const m = this.month();
    const amounts = new Map<string, number>();
    for (const it of plan.items) if (it.give) amounts.set(it.cat.id, this.store.budget().cat(m, it.cat.id).assigned + it.give);
    this.fundPreview.set(false);
    if (!amounts.size) return;
    this.actions.bulkAssign(m, amounts, 'Fund targets');
    this.toasts.show(`Funded ${amounts.size} target${amounts.size > 1 ? 's' : ''}`, { label: 'Undo', run: () => this.store.undo() });
  }

  // ------------------------------------------------------------ groups & categories
  toggleGroup(g: Group) { this.store.put({ ...g, collapsed: !g.collapsed }); }
  collapseAll(collapsed: boolean) {
    this.store.transact(collapsed ? 'Collapse all' : 'Expand all', () => {
      for (const g of this.store.groups()) if (!!g.collapsed !== collapsed) this.store.put({ ...g, collapsed });
    });
  }

  addGroup(name: string) {
    this.newGroup.set(null);
    if (name.trim()) this.actions.addGroup(name.trim());
  }
  addCategory(groupId: string, name: string) {
    this.newCatFor.set(null);
    if (!name.trim()) return;
    const c = this.actions.addCategory(groupId, name.trim());
    this.selectedId.set(c.id);
  }
  rename(id: string, name: string) {
    this.renaming.set(null);
    const e = this.store.get<Group | Category>(id);
    if (e && name.trim() && name.trim() !== e.name) this.store.put({ ...e, name: name.trim() });
  }
  pickStrategy(s: Strategy) {
    if (s === 'underfunded') { this.fundPreview.set(true); this.assignMenu.set(false); } else this.applyStrategy(s);
  }
  startRename(g: Group) { if (g.system) return; this.renaming.set(g.id); this.focusSoon('.rename'); }
  focusSoon(sel: string) { setTimeout(() => this.host.nativeElement.querySelector<HTMLInputElement>(sel)?.focus()); }

  hideGroup(g: Group) {
    this.store.put({ ...g, hidden: true });
    this.toasts.show(`Hid “${g.name}”`, { label: 'Undo', run: () => this.store.undo() });
  }
  showHidden() {
    this.store.transact('Show hidden', () => {
      for (const c of this.store.categories()) if (c.hidden) this.store.put({ ...c, hidden: false });
      for (const g of this.store.groups()) if (g.hidden) this.store.put({ ...g, hidden: false });
    });
  }
  deleteGroup(g: Group) {
    const n = this.store.categories().filter((c) => c.groupId === g.id).length;
    if (n && !confirm(`Delete “${g.name}” and its ${n} categories? Their transactions become uncategorised.`)) return;
    this.actions.deleteGroup(g.id, null);
    this.toasts.show(`Deleted “${g.name}”`, { label: 'Undo', run: () => this.store.undo() });
  }

  // ------------------------------------------------------------ drag & drop
  dragStart(e: DragEvent, id: string, kind: 'row' | 'money' | 'group') {
    this.dragId.set(id);
    e.dataTransfer!.effectAllowed = 'move';
    e.dataTransfer!.setData('text/plain', `${kind}:${id}`);
  }
  dragOver(e: DragEvent, id: string) {
    e.preventDefault();
    this.dropTarget.set(id);
  }
  dragEnd() { this.dragId.set(null); this.dropTarget.set(null); }
  drop(e: DragEvent, target: Category | null, group: Group) {
    e.preventDefault();
    const [kind, id] = (e.dataTransfer?.getData('text/plain') ?? '').split(':');
    this.dragEnd();
    if (!id) return;
    if (kind === 'money' && target && id !== target.id) {
      const from = this.store.budget().cat(this.month(), id).available;
      this.move.set({ from: id, to: target.id, amount: Math.max(0, from) });
    } else if (kind === 'row' && id !== target?.id && !group.system) {
      const cat = this.store.get<Category>(id);
      if (cat?.ccAccountId) return;
      this.actions.moveCategory(id, group.id, target?.id ?? null);
    } else if (kind === 'group' && id !== group.id && !group.system) {
      this.actions.moveGroup(id, group.id);
    }
  }

  // ------------------------------------------------------------ helpers
  tone(cm: CatMonth): string {
    if (cm.available < 0) return cm.cashOver > 0 ? 'neg' : 'credit';
    if (cm.target && cm.target.underfunded > 0) return 'warn';
    if (cm.available > 0) return 'pos';
    return '';
  }
  ringTone(cm: CatMonth): 'pos' | 'warn' | 'neg' | 'accent' {
    if (cm.available < 0) return 'neg';
    if (cm.target && cm.target.underfunded > 0) return 'warn';
    return 'pos';
  }
  ringValue(cm: CatMonth) {
    if (!cm.target) return 0;
    if (cm.target.type === 'monthly' || cm.target.type === 'weekly') return cm.target.need ? 1 - cm.target.underfunded / cm.target.need : 1;
    return cm.target.progress;
  }
  barWidth(cm: CatMonth) {
    // spending bar: how much of the money for this month has been used
    const funded = cm.carry + cm.assigned;
    if (funded <= 0) return cm.activity < 0 ? 100 : 0;
    return Math.min(100, Math.round((-Math.min(0, cm.activity) / funded) * 100));
  }
  status(r: Row): string {
    const cm = r.cm;
    if (cm.available < 0) return cm.cashOver > 0 ? 'Overspent — cover it from another category' : 'Overspent on credit — this became card debt';
    if (r.cat.ccAccountId) return cm.available > 0 ? 'Set aside for your card payment' : '';
    const t = cm.target;
    if (!t) return '';
    if (t.underfunded > 0) {
      if (t.type === 'byDate' || t.type === 'yearly') return `${this.fmt(t.underfunded)} more this month · ${t.monthsLeft} month${t.monthsLeft === 1 ? '' : 's'} left`;
      return `${this.fmt(t.underfunded)} more needed`;
    }
    if (t.type === 'balance') return t.done ? 'Goal reached' : `${Math.round(t.progress * 100)}% of ${this.fmt(t.goal ?? 0)}`;
    if (t.type === 'byDate' || t.type === 'yearly') return t.done ? 'Fully funded' : `On track · ${Math.round(t.progress * 100)}% saved`;
    return 'Funded';
  }
  private money = new MoneyPipe();
  fmt(v: number) { return this.money.transform(v, 'full'); }
  readonly RTA = RTA;
}
