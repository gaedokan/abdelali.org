import { inject, Injectable, signal } from '@angular/core';
import { clearAll, getMeta, setMeta } from './idb';
import { Entity } from './models';
import { Store } from './store';

export type SyncState = 'off' | 'idle' | 'syncing' | 'offline' | 'error';

const API = 'api/';           // relative to <base href="/budget/">
const PUSH_CHUNK = 400;

/**
 * Keeps the local database in step with Cloudflare D1.
 * The whole app sits behind the Worker's login, so the browser already holds a session cookie:
 * sync turns itself on whenever the server is configured and this browser is signed in.
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
  /** true once the first sync attempt has finished (or sync is unavailable) */
  readonly settled = signal(false);

  private on = false;
  private cursor = 0;
  private timer: ReturnType<typeof setTimeout> | null = null;
  private running: Promise<void> | null = null;
  private again = false;

  async init() {
    this.cursor = (await getMeta<number>('cursor')) ?? 0;
    this.store.onLocalChange = () => this.schedule(1500);
    if (typeof window !== 'undefined') {
      document.addEventListener('visibilitychange', () => document.visibilityState === 'visible' && this.schedule(200));
      window.addEventListener('online', () => this.schedule(200));
      setInterval(() => document.visibilityState === 'visible' && this.schedule(0), 30_000);
    }
    try {
      const r = await fetch(API + 'status', { cache: 'no-store', credentials: 'same-origin' });
      const j = await r.json();
      this.serverConfigured.set(!!j.configured);
      if (j.configured && j.authenticated) {
        this.on = true;
        // first sync on this device: send everything we have
        if (!this.cursor) for (const e of this.store.allRaw()) this.store.dirty.add(e.id);
        await this.syncNow();
      } else if (j.configured && !j.authenticated) {
        this.toLogin();
      }
    } catch {
      // offline (or local development without the Worker): keep working on this device
      this.serverConfigured.set(null);
      this.state.set(navigator.onLine === false ? 'offline' : 'off');
      this.on = (await getMeta<boolean>('syncOn')) ?? false;
    }
    if (this.on) await setMeta('syncOn', true);
    this.settled.set(true);
  }

  get enabled() { return this.on; }

  schedule(ms: number) {
    if (!this.on) return;
    if (this.timer) clearTimeout(this.timer);
    this.timer = setTimeout(() => this.syncNow(), ms);
  }

  async syncNow(): Promise<void> {
    if (!this.on) return;
    if (this.running) { this.again = true; return this.running; }
    this.running = this.run().finally(() => {
      this.running = null;
      if (this.again) { this.again = false; this.schedule(100); }
    });
    return this.running;
  }

  /** Sign out on this device: push pending changes, end the session, remove the local copy. */
  async signOut(everywhere = false): Promise<string | null> {
    if (this.on && this.store.dirty.size) await this.syncNow();
    if (this.store.dirty.size && !confirm(`${this.store.dirty.size} change(s) haven’t synced yet and will be lost. Sign out anyway?`)) return 'cancelled';
    try {
      const r = await fetch(API + (everywhere ? 'logout-all' : 'logout'), { method: 'POST', credentials: 'same-origin' });
      if (!r.ok && r.status !== 401) return `Could not sign out (${r.status})`;
    } catch {
      return 'You’re offline. Try again when connected.';
    }
    await clearAll();
    await this.dropOfflineCopy();
    location.href = 'login';
    return null;
  }

  /** Remove the service worker and its caches so the app can’t open without signing in again. */
  private async dropOfflineCopy() {
    try {
      const regs = (await navigator.serviceWorker?.getRegistrations()) ?? [];
      await Promise.all(regs.map((r) => r.unregister()));
      const keys = (await caches?.keys()) ?? [];
      await Promise.all(keys.map((k) => caches.delete(k)));
    } catch { /* not supported */ }
  }

  private toLogin() {
    location.href = 'login?next=' + encodeURIComponent(location.pathname);
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
          credentials: 'same-origin',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ cursor: this.cursor, items }),
        });
        if (res.status === 401) { this.on = false; this.state.set('off'); this.toLogin(); return; }
        if (res.status === 503) { this.serverConfigured.set(false); throw new Error((await res.json()).error); }
        if (!res.ok) throw new Error(`Server error (${res.status})`);
        const j = (await res.json()) as { items: Entity[]; cursor: number; hasMore: boolean };
        this.store.markClean(ids, pushed);
        this.store.applyRemote(j.items);
        this.cursor = j.cursor;
        await setMeta('cursor', this.cursor);
        more = j.hasMore || (this.store.dirty.size > 0 && ids.length === PUSH_CHUNK);
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
