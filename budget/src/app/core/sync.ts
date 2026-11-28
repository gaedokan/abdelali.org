import { inject, Injectable, signal } from '@angular/core';
import { getMeta, setMeta } from './idb';
import { Entity } from './models';
import { Store } from './store';

export type SyncState = 'off' | 'idle' | 'syncing' | 'offline' | 'error';

interface SyncConfig { password: string }

const API = 'api/';           // relative to <base href="/budget/">
const PUSH_CHUNK = 400;

/**
 * Keeps the local database in step with Cloudflare D1.
 * Local writes are pushed shortly after they happen; remote changes are pulled every 30 s,
 * when the app comes back to the foreground, and when the network returns.
 */
@Injectable({ providedIn: 'root' })
export class Sync {
  private store = inject(Store);
  readonly state = signal<SyncState>('off');
  readonly error = signal<string | null>(null);
  readonly lastSync = signal<number | null>(null);
  readonly serverConfigured = signal<boolean | null>(null);

  private config: SyncConfig | null = null;
  private cursor = 0;
  private timer: ReturnType<typeof setTimeout> | null = null;
  private running: Promise<void> | null = null;
  private again = false;

  async init() {
    this.config = (await getMeta<SyncConfig>('sync')) ?? null;
    this.cursor = (await getMeta<number>('cursor')) ?? 0;
    this.store.onLocalChange = () => this.schedule(1500);
    if (typeof window !== 'undefined') {
      document.addEventListener('visibilitychange', () => document.visibilityState === 'visible' && this.schedule(200));
      window.addEventListener('online', () => this.schedule(200));
      setInterval(() => document.visibilityState === 'visible' && this.schedule(0), 30_000);
    }
    this.checkServer();
    if (this.config) {
      this.state.set('idle');
      await this.syncNow();
    }
  }

  get enabled() { return !!this.config; }

  async checkServer() {
    try {
      const r = await fetch(API + 'status', { cache: 'no-store' });
      const j = await r.json();
      this.serverConfigured.set(!!j.configured);
    } catch {
      this.serverConfigured.set(null);
    }
  }

  /** Connect with the server password. Returns an error message or null. */
  async connect(password: string): Promise<string | null> {
    this.config = { password };
    this.cursor = 0;
    this.error.set(null);
    // everything local should go up once
    for (const e of this.store.allRaw()) this.store.dirty.add(e.id);
    await this.syncNow();
    if (this.state() === 'error') {
      const msg = this.error();
      this.config = null;
      this.state.set('off');
      return msg;
    }
    await setMeta('sync', this.config);
    return null;
  }

  async disconnect() {
    this.config = null;
    this.cursor = 0;
    await setMeta('sync', null);
    await setMeta('cursor', 0);
    this.state.set('off');
  }

  schedule(ms: number) {
    if (!this.config) return;
    if (this.timer) clearTimeout(this.timer);
    this.timer = setTimeout(() => this.syncNow(), ms);
  }

  async syncNow(): Promise<void> {
    if (!this.config) return;
    if (this.running) { this.again = true; return this.running; }
    this.running = this.run().finally(() => {
      this.running = null;
      if (this.again) { this.again = false; this.schedule(100); }
    });
    return this.running;
  }

  private async run() {
    if (typeof navigator !== 'undefined' && navigator.onLine === false) { this.state.set('offline'); return; }
    this.state.set('syncing');
    try {
      let more = true, guard = 0;
      while (more && guard++ < 200) {
        const ids = [...this.store.dirty].slice(0, PUSH_CHUNK);
        const items = ids.map((id) => this.store.getRaw(id)).filter((e): e is Entity => !!e);
        const pushed = new Map(items.map((e) => [e.id, e.updatedAt]));
        const res = await fetch(API + 'sync', {
          method: 'POST',
          headers: { 'content-type': 'application/json', authorization: `Bearer ${this.config!.password}` },
          body: JSON.stringify({ cursor: this.cursor, items }),
        });
        if (res.status === 401) throw new Error('Wrong password');
        if (res.status === 503) { this.serverConfigured.set(false); throw new Error((await res.json()).error); }
        if (!res.ok) throw new Error(`Server error (${res.status})`);
        const j = (await res.json()) as { items: Entity[]; cursor: number; hasMore: boolean };
        this.store.markClean(ids, pushed);
        this.store.applyRemote(j.items);
        this.cursor = j.cursor;
        await setMeta('cursor', this.cursor);
        more = j.hasMore || this.store.dirty.size > 0 && ids.length === PUSH_CHUNK;
      }
      this.error.set(null);
      this.lastSync.set(Date.now());
      this.state.set('idle');
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      this.error.set(msg === 'Failed to fetch' ? 'Offline' : msg);
      this.state.set(msg === 'Failed to fetch' ? 'offline' : 'error');
    }
  }
}
