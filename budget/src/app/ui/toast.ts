import { Injectable, signal } from '@angular/core';

export interface Toast { id: number; text: string; action?: { label: string; run: () => void }; tone?: 'default' | 'error' }

@Injectable({ providedIn: 'root' })
export class Toasts {
  readonly items = signal<Toast[]>([]);
  private n = 0;
  show(text: string, action?: Toast['action'], ms = 4500, tone: Toast['tone'] = 'default') {
    const t: Toast = { id: ++this.n, text, action, tone };
    this.items.update((xs) => [...xs.slice(-2), t]);
    setTimeout(() => this.dismiss(t.id), ms);
  }
  dismiss(id: number) { this.items.update((xs) => xs.filter((x) => x.id !== id)); }
}
