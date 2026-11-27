import { computed, Injectable, signal } from '@angular/core';
import { computeBudget, Snapshot } from './engine';
import { clearAll, getMeta, loadAll, saveItems, setMeta } from './idb';
import { Account, Assign, Category, Entity, Group, Kind, Payee, Price, Scheduled, Settings, Trade, Txn } from './models';
import { MoneyFormat } from './money';

type Draft<T extends Entity> = T extends Entity ? Omit<T, 'updatedAt'> & { updatedAt?: number } : never;

interface Change { id: string; before?: Entity; after?: Entity }
interface UndoEntry { label: string; changes: Change[] }

export const DEFAULT_SETTINGS: Settings = {
  id: 'settings', kind: 'settings', updatedAt: 0,
  budgetName: 'My budget', currency: 'MAD', symbolFirst: false, decimal: ',', group: ' ',
  dateFormat: 'dd/mm/yyyy', weekStart: 1, onboarded: false,
};

/**
 * Single source of truth. Entities live in memory (Map), are persisted to IndexedDB and marked dirty
 * for the sync service. Every change goes through `transact`, which records undo history.
 */
@Injectable({ providedIn: 'root' })
export class Store {
  private items = new Map<string, Entity>();
  private batch: Change[] | null = null;
  private undoStack: UndoEntry[] = [];
  private redoStack: UndoEntry[] = [];
  /** ids changed locally and not yet pushed */
  readonly dirty = new Set<string>();

  readonly version = signal(0);
  readonly ready = signal(false);
  readonly canUndo = signal<string | null>(null);
  readonly canRedo = signal<string | null>(null);

  // ------------------------------------------------------------- derived
  private list<T extends Entity>(kind: Kind) {
    return computed(() => {
      this.version();
      const out: T[] = [];
      for (const e of this.items.values()) if (e.kind === kind && !e.deleted) out.push(e as T);
      return out;
    });
  }
  readonly settings = computed<Settings>(() => {
    this.version();
    return { ...DEFAULT_SETTINGS, ...((this.items.get('settings') as Settings) ?? {}) };
  });
  readonly format = computed<MoneyFormat>(() => {
    const s = this.settings();
    return { currency: s.currency, symbolFirst: s.symbolFirst, decimal: s.decimal, group: s.group };
  });
  readonly accounts = computed(() => this.list<Account>('account')().sort((a, b) => a.sort - b.sort || a.name.localeCompare(b.name)));
  readonly groups = computed(() => this.list<Group>('group')().sort((a, b) => (a.system ? -1 : 0) - (b.system ? -1 : 0) || a.sort - b.sort));
  readonly categories = computed(() => this.list<Category>('category')().sort((a, b) => a.sort - b.sort));
  readonly payees = computed(() => this.list<Payee>('payee')().sort((a, b) => a.name.localeCompare(b.name)));
  readonly txns = computed(() => this.list<Txn>('txn')().sort((a, b) => b.date.localeCompare(a.date) || b.updatedAt - a.updatedAt));
  readonly assigns = this.list<Assign>('assign');
  readonly scheduled = computed(() => this.list<Scheduled>('scheduled')().sort((a, b) => a.nextDate.localeCompare(b.nextDate)));

  readonly trades = computed(() => this.list<Trade>('trade')().sort((a, b) => a.date.localeCompare(b.date)));
  readonly prices = computed(() => new Map(this.list<Price>('price')().map((p) => [p.symbol, p])));

  readonly accountMap = computed(() => new Map(this.accounts().map((a) => [a.id, a])));
  readonly categoryMap = computed(() => new Map(this.categories().map((c) => [c.id, c])));
  readonly groupMap = computed(() => new Map(this.groups().map((g) => [g.id, g])));
  readonly payeeMap = computed(() => new Map(this.payees().map((p) => [p.id, p])));

  readonly budget = computed<Snapshot>(() =>
    computeBudget({ accounts: this.accounts(), categories: this.categories(), txns: this.txns(), assigns: this.assigns() }),
  );

  // ------------------------------------------------------------- lifecycle
  async init() {
    try {
      const all = await loadAll();
      for (const e of all) this.items.set(e.id, e);
      const d = (await getMeta<string[]>('dirty')) ?? [];
      d.forEach((id) => this.dirty.add(id));
    } catch (e) {
      console.error('Could not open local database', e);
    }
    this.version.update((v) => v + 1);
    this.ready.set(true);
  }

  // ------------------------------------------------------------- reads
  get<T extends Entity>(id: string | null | undefined): T | undefined {
    if (!id) return undefined;
    const e = this.items.get(id);
    return e && !e.deleted ? (e as T) : undefined;
  }
  getRaw(id: string) { return this.items.get(id); }
  allRaw() { return [...this.items.values()]; }

  // ------------------------------------------------------------- writes
  /** Group several writes into one undoable step. */
  transact<R>(label: string, fn: () => R): R {
    if (this.batch) return fn();
    this.batch = [];
    let result: R;
    try {
      result = fn();
    } catch (e) {
      // roll back
      for (const c of this.batch.reverse()) c.before ? this.items.set(c.id, c.before) : this.items.delete(c.id);
      this.batch = null;
      this.version.update((v) => v + 1);
      throw e;
    }
    const changes = this.batch;
    this.batch = null;
    if (changes.length) {
      this.undoStack.push({ label, changes });
      if (this.undoStack.length > 200) this.undoStack.shift();
      this.redoStack = [];
      this.commit(changes.map((c) => c.id));
    }
    return result;
  }

  put<T extends Entity>(draft: Draft<T>): T {
    if (!this.batch) return this.transact('Edit', () => this.put<T>(draft));
    const before = this.items.get(draft.id);
    const after = { ...(before && !before.deleted ? before : {}), ...draft, updatedAt: this.stamp(before) } as T;
    delete (after as Partial<Entity>).deleted;
    this.record(draft.id, before, after);
    return after;
  }

  patch<T extends Entity>(id: string, fields: Partial<T>): T | undefined {
    const cur = this.get<T>(id);
    if (!cur) return undefined;
    return this.put<T>({ ...cur, ...fields } as unknown as Draft<T>);
  }

  remove(id: string): void {
    if (!this.batch) return this.transact('Delete', () => this.remove(id));
    const before = this.items.get(id);
    if (!before || before.deleted) return;
    // keep a tombstone so the deletion syncs; drop the payload except identity
    const after = { id, kind: before.kind, updatedAt: this.stamp(before), deleted: true } as Entity;
    this.record(id, before, after);
  }

  private stamp(before?: Entity) {
    // strictly increasing per entity, even if the clock goes backwards
    return Math.max(Date.now(), (before?.updatedAt ?? 0) + 1);
  }

  private record(id: string, before: Entity | undefined, after: Entity) {
    this.items.set(id, after);
    // derived lists must see writes made earlier in the same transaction
    this.version.update((v) => v + 1);
    const existing = this.batch!.find((c) => c.id === id);
    if (existing) existing.after = after;
    else this.batch!.push({ id, before, after });
  }

  private commit(ids: string[]) {
    ids.forEach((id) => this.dirty.add(id));
    this.version.update((v) => v + 1);
    this.canUndo.set(this.undoStack.at(-1)?.label ?? null);
    this.canRedo.set(this.redoStack.at(-1)?.label ?? null);
    const items = ids.map((id) => this.items.get(id)!).filter(Boolean);
    saveItems(items).catch((e) => console.error(e));
    setMeta('dirty', [...this.dirty]).catch(() => {});
    this.onLocalChange?.();
  }

  /** set by the sync service */
  onLocalChange?: () => void;

  undo() { this.step(this.undoStack, this.redoStack, 'before'); }
  redo() { this.step(this.redoStack, this.undoStack, 'after'); }

  private step(from: UndoEntry[], to: UndoEntry[], side: 'before' | 'after') {
    const entry = from.pop();
    if (!entry) return;
    const ids: string[] = [];
    for (const c of side === 'before' ? [...entry.changes].reverse() : entry.changes) {
      const target = c[side];
      const cur = this.items.get(c.id);
      const stamp = Math.max(Date.now(), (cur?.updatedAt ?? 0) + 1);
      const next = target
        ? ({ ...target, updatedAt: stamp } as Entity)
        : ({ id: c.id, kind: (c.after ?? c.before)!.kind, updatedAt: stamp, deleted: true } as Entity);
      this.items.set(c.id, next);
      ids.push(c.id);
    }
    to.push(entry);
    this.commit(ids);
  }

  // ------------------------------------------------------------- sync support
  /** Apply entities that came from the server. Last write wins per entity. */
  applyRemote(items: Entity[]): number {
    const changed: Entity[] = [];
    for (const r of items) {
      const local = this.items.get(r.id);
      if (local && local.updatedAt >= r.updatedAt) continue;
      this.items.set(r.id, r);
      this.dirty.delete(r.id);
      changed.push(r);
    }
    if (changed.length) {
      this.version.update((v) => v + 1);
      saveItems(changed).catch((e) => console.error(e));
      setMeta('dirty', [...this.dirty]).catch(() => {});
    }
    return changed.length;
  }

  markClean(ids: string[], pushed: Map<string, number>) {
    for (const id of ids) {
      // only clean if it was not edited again while the push was in flight
      if (this.items.get(id)?.updatedAt === pushed.get(id)) this.dirty.delete(id);
    }
    setMeta('dirty', [...this.dirty]).catch(() => {});
  }

  /** Replace everything (restore from backup / reset). */
  async replaceAll(items: Entity[], markDirty: boolean) {
    await clearAll();
    this.items.clear();
    this.dirty.clear();
    for (const e of items) {
      this.items.set(e.id, e);
      if (markDirty) this.dirty.add(e.id);
    }
    await saveItems(items);
    await setMeta('dirty', [...this.dirty]);
    this.undoStack = [];
    this.redoStack = [];
    this.canUndo.set(null);
    this.canRedo.set(null);
    this.version.update((v) => v + 1);
    this.onLocalChange?.();
  }
}
