import { ChangeDetectionStrategy, Component, computed, inject, signal } from '@angular/core';
import { Actions } from '../../core/actions';
import { Entity, Payee, Settings } from '../../core/models';
import { Store } from '../../core/store';
import { Sync } from '../../core/sync';
import { today } from '../../core/util';
import { Combo } from '../../ui/combo';
import { Icon } from '../../ui/icon';
import { Pickers } from '../../ui/pickers';
import { Toasts } from '../../ui/toast';
import { UiState } from '../../ui/ui-state';

@Component({
  selector: 'app-settings',
  imports: [Icon, Combo],
  changeDetection: ChangeDetectionStrategy.OnPush,
  templateUrl: './settings.html',
  styleUrl: './settings.scss',
})
export class SettingsPage {
  readonly store = inject(Store);
  readonly sync = inject(Sync);
  readonly ui = inject(UiState);
  readonly pickers = inject(Pickers);
  private actions = inject(Actions);
  private toasts = inject(Toasts);

  readonly pw = signal('');
  readonly busy = signal(false);
  readonly syncErr = signal<string | null>(null);
  readonly payeeQuery = signal('');
  readonly mergeInto = signal<Record<string, string | null>>({});
  readonly endpoint = typeof location !== 'undefined' ? `${location.origin}/budget/api/wallet` : '/budget/api/wallet';
  readonly addLink = typeof location !== 'undefined' ? `${location.origin}/budget/#/add?amount=45&payee=Café` : '';

  readonly s = this.store.settings;
  readonly payees = computed(() => {
    const q = this.payeeQuery().toLowerCase();
    const count = new Map<string, number>();
    for (const t of this.store.txns()) if (t.payeeId) count.set(t.payeeId, (count.get(t.payeeId) ?? 0) + 1);
    return this.store.payees().filter((p) => !q || p.name.toLowerCase().includes(q)).map((p) => ({ p, n: count.get(p.id) ?? 0 })).slice(0, 80);
  });
  readonly payeeItems = computed(() => this.store.payees().map((p) => ({ id: p.id, label: p.name })));
  readonly lastSync = computed(() => {
    const t = this.sync.lastSync();
    return t ? new Date(t).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }) : null;
  });

  set<K extends keyof Settings>(k: K, v: Settings[K]) { this.actions.updateSettings({ [k]: v } as Partial<Settings>); }

  async connect() {
    this.busy.set(true);
    const err = await this.sync.connect(this.pw());
    this.syncErr.set(err);
    this.busy.set(false);
    if (!err) { this.pw.set(''); this.toasts.show('Sync connected'); }
  }
  async disconnect() {
    await this.sync.disconnect();
    this.toasts.show('Sync turned off on this device. Your data stays here.');
  }

  // ------------------------------------------------------------ backup
  exportJson() {
    const data = { app: 'envelope', version: 1, exportedAt: new Date().toISOString(), items: this.store.allRaw() };
    this.download(`envelope-backup-${today()}.json`, JSON.stringify(data), 'application/json');
  }
  exportCsv() {
    const am = this.store.accountMap(), pm = this.store.payeeMap();
    const rows = [['Account', 'Date', 'Payee', 'Category', 'Memo', 'Outflow', 'Inflow', 'Cleared']];
    for (const t of [...this.store.txns()].reverse()) {
      const payee = t.transferAccountId ? `Transfer : ${am.get(t.transferAccountId)?.name ?? ''}` : pm.get(t.payeeId ?? '')?.name ?? '';
      const amt = (Math.abs(t.amount) / 100).toFixed(2);
      rows.push([am.get(t.accountId)?.name ?? '', t.date, payee, this.pickers.categoryLabel(t.categoryId), t.memo ?? '', t.amount < 0 ? amt : '', t.amount > 0 ? amt : '', t.cleared]);
    }
    const csv = rows.map((r) => r.map((c) => (/[",;\n]/.test(c) ? `"${c.replace(/"/g, '""')}"` : c)).join(',')).join('\n');
    this.download(`envelope-transactions-${today()}.csv`, '﻿' + csv, 'text/csv');
  }
  private download(name: string, content: string, type: string) {
    const url = URL.createObjectURL(new Blob([content], { type }));
    const a = document.createElement('a');
    a.href = url; a.download = name; a.click();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  }
  async restore(file: File | undefined) {
    if (!file) return;
    try {
      const data = JSON.parse(await file.text());
      if (data.app !== 'envelope' || !Array.isArray(data.items)) throw new Error('Not an Envelope backup');
      if (!confirm(`Replace everything on this device with the backup from ${data.exportedAt?.slice(0, 10) ?? 'unknown date'}?${this.sync.enabled ? ' It will also be synced to your other devices.' : ''}`)) return;
      // fresh timestamps so the restore wins over older synced copies
      const now = Date.now();
      const items = (data.items as Entity[]).map((e, i) => ({ ...e, updatedAt: now + i }));
      // tombstones for anything not in the backup, so other devices drop it too
      const keep = new Set(items.map((e) => e.id));
      const tomb = this.store.allRaw().filter((e) => !keep.has(e.id)).map((e, i) => ({ id: e.id, kind: e.kind, updatedAt: now + items.length + i, deleted: true }) as Entity);
      await this.store.replaceAll([...items, ...tomb], this.sync.enabled);
      this.toasts.show(`Restored ${items.length} items`);
    } catch (e) {
      this.toasts.show(e instanceof Error ? e.message : 'Could not read that file', undefined, 4000, 'error');
    }
  }
  async reset() {
    if (!confirm('Delete ALL budget data on this device? This cannot be undone. (Export a backup first!)')) return;
    if (this.sync.enabled && !confirm('Sync is on: this also deletes the data on your other devices. Continue?')) return;
    const now = Date.now();
    const tomb = this.store.allRaw().map((e, i) => ({ id: e.id, kind: e.kind, updatedAt: now + i, deleted: true }) as Entity);
    await this.store.replaceAll(tomb, this.sync.enabled);
    location.reload();
  }

  // ------------------------------------------------------------ payees
  renamePayee(p: Payee, name: string) { if (name.trim() && name.trim() !== p.name) this.store.put({ ...p, name: name.trim() }); }
  setPayeeCategory(p: Payee, id: string | null) { const n = { ...p, categoryId: id ?? undefined }; if (!id) delete n.categoryId; this.store.put(n); }
  merge(p: Payee) {
    const into = this.mergeInto()[p.id];
    if (!into || into === p.id) return;
    this.actions.mergePayees(into, [p.id]);
    this.toasts.show(`Merged “${p.name}”`, { label: 'Undo', run: () => this.store.undo() });
  }
  setMerge(id: string, v: string | null) { this.mergeInto.update((m) => ({ ...m, [id]: v })); }

  copy(text: string) {
    navigator.clipboard?.writeText(text).then(() => this.toasts.show('Copied'), () => {});
  }
}
