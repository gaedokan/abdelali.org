import { ChangeDetectionStrategy, Component, ElementRef, effect, input, output, viewChild } from '@angular/core';
import { Icon } from './icon';

/** Modal dialog on desktop, bottom sheet on phones. Uses the native <dialog> element (focus trap, Esc). */
@Component({
  selector: 'app-sheet',
  imports: [Icon],
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <dialog #dlg (cancel)="$event.preventDefault(); closed.emit()" (click)="backdrop($event)" [class.wide]="wide()" [attr.aria-labelledby]="title() ? id + '-t' : null" [attr.aria-label]="title() ? null : 'Details'">
      <div class="sheet">
        <div class="grab" aria-hidden="true"></div>
        @if (title()) {
          <header>
            <h2 [id]="id + '-t'">{{ title() }}</h2>
            <button class="btn ghost icon sm" type="button" (click)="closed.emit()" aria-label="Close"><app-icon name="x" [size]="16" /></button>
          </header>
        }
        <div class="body"><ng-content /></div>
        <ng-content select="[footer]" />
      </div>
    </dialog>`,
  styles: `
    dialog { border: 0; padding: 0; background: transparent; max-width: min(520px, calc(100vw - 32px)); width: 100%; color: var(--ink); overflow: visible; }
    dialog.wide { max-width: min(860px, calc(100vw - 32px)); }
    dialog::backdrop { background: rgba(15, 18, 16, .42); backdrop-filter: blur(2px); }
    dialog[open] { animation: pop .22s var(--ease); }
    @keyframes pop { from { opacity: 0; transform: translateY(8px) scale(.98); } }
    .sheet { background: var(--surface); border-radius: 18px; box-shadow: var(--shadow-2); max-height: calc(100dvh - 48px); display: flex; flex-direction: column; border: 1px solid var(--line); }
    header { display: flex; align-items: center; justify-content: space-between; padding: 18px 20px 6px; }
    h2 { font-size: 1.125rem; }
    .body { padding: 12px 20px 20px; overflow: auto; }
    .grab { display: none; }
    @media (max-width: 640px) {
      dialog, dialog.wide { max-width: 100vw; margin: auto 0 0; width: 100vw; }
      dialog[open] { animation: up .28s var(--ease); }
      @keyframes up { from { transform: translateY(40px); opacity: .4; } }
      .sheet { border-radius: 20px 20px 0 0; max-height: calc(100dvh - env(safe-area-inset-top) - 12px); padding-bottom: var(--safe-bottom); }
      .grab { display: block; width: 38px; height: 5px; border-radius: 9px; background: var(--line-2); margin: 8px auto 0; }
    }
  `,
})
export class Sheet {
  readonly open = input(false);
  readonly title = input('');
  readonly wide = input(false);
  readonly closed = output<void>();
  readonly id = 'sheet-' + Math.random().toString(36).slice(2, 8);
  private dlg = viewChild.required<ElementRef<HTMLDialogElement>>('dlg');

  constructor() {
    effect(() => {
      const d = this.dlg().nativeElement;
      if (this.open() && !d.open) d.showModal();
      else if (!this.open() && d.open) d.close();
    });
  }
  backdrop(e: MouseEvent) {
    if (e.target === this.dlg().nativeElement) this.closed.emit();
  }
}
