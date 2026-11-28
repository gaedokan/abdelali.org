import { Injectable, signal } from '@angular/core';
import { thisMonth } from '../core/util';

/** App-wide UI state (which dialogs are open, selected budget month). */
@Injectable({ providedIn: 'root' })
export class UiState {
  readonly month = signal(thisMonth());
  readonly quickAdd = signal(false);
  readonly quickAddText = signal('');
  readonly palette = signal(false);
  readonly addAccount = signal(false);
  readonly editAccountId = signal<string | null>(null);
  readonly importFor = signal<string | null | undefined>(undefined); // undefined = closed
  readonly txnEditor = signal<{ id?: string; accountId?: string } | null>(null);
  readonly sidebarOpen = signal(false);
  readonly theme = signal<'system' | 'light' | 'dark'>(load('theme', 'system'));

  setTheme(t: 'system' | 'light' | 'dark') {
    this.theme.set(t);
    save('theme', t);
    applyTheme(t);
  }
}

export function applyTheme(t: string) {
  const el = document.documentElement;
  if (t === 'system') el.removeAttribute('data-theme'); else el.setAttribute('data-theme', t);
}

function load<T extends string>(k: string, d: T): T {
  try { return (localStorage.getItem('envelope.' + k) as T) || d; } catch { return d; }
}
function save(k: string, v: string) {
  try { localStorage.setItem('envelope.' + k, v); } catch { /* private mode */ }
}
