import {
  ChangeDetectionStrategy, Component, computed, ElementRef, inject, input, model, output, signal, viewChild,
} from '@angular/core';
import { fuzzy } from '../core/util';

export interface ComboItem {
  id: string;
  label: string;
  group?: string;
  hint?: string;       // right-aligned (e.g. available amount)
  hintTone?: 'pos' | 'neg' | 'warn' | '';
  emoji?: string;
  keywords?: string;
}

/**
 * Searchable dropdown. Type to filter, arrows + Enter to choose, Esc to cancel.
 * With `allowCreate`, free text is accepted (emits `created`).
 */
@Component({
  selector: 'app-combo',
  changeDetection: ChangeDetectionStrategy.OnPush,
  host: { '(focusout)': 'blur($event)' },
  template: `
    <input #inp class="input" [class.compact]="compact()" [placeholder]="placeholder()" [value]="open() ? query() : selectedLabel()"
      (focus)="onFocus()" (input)="query.set(inp.value); open.set(true); active.set(0)"
      (keydown)="key($event)" [attr.aria-expanded]="open()" role="combobox" autocomplete="off" [attr.aria-label]="placeholder()" />
    @if (open()) {
      <div class="pop" role="listbox">
        @for (it of filtered(); track it.id; let i = $index) {
          @if (it.group && (i === 0 || filtered()[i - 1].group !== it.group)) { <div class="grp">{{ it.group }}</div> }
          <button type="button" class="opt" [class.active]="i === active()" (mousedown)="$event.preventDefault()" (click)="choose(it)" (mouseenter)="active.set(i)" role="option">
            @if (it.emoji) { <span class="emo">{{ it.emoji }}</span> }
            <span class="lbl">{{ it.label }}</span>
            @if (it.hint) { <span class="hint" [class]="it.hintTone || ''">{{ it.hint }}</span> }
          </button>
        }
        @if (allowCreate() && query().trim() && !exact()) {
          <button type="button" class="opt create" [class.active]="active() === filtered().length" (mousedown)="$event.preventDefault()" (click)="create()">
            <span class="lbl">Create “{{ query().trim() }}”</span>
          </button>
        }
        @if (!filtered().length && !(allowCreate() && query().trim())) { <div class="none">No matches</div> }
      </div>
    }`,
  styles: `
    :host { position: relative; display: block; min-width: 0; }
    .input.compact { height: 32px; padding: 0 8px; border-radius: 6px; }
    .pop { position: absolute; z-index: 50; top: calc(100% + 4px); left: 0; min-width: 100%; width: max(100%, 280px); max-height: 320px; overflow: auto;
      background: var(--surface); border: 1px solid var(--line-2); border-radius: 10px; box-shadow: var(--shadow-2); padding: 4px; animation: f .12s ease-out; }
    @keyframes f { from { opacity: 0; transform: translateY(-4px); } }
    .grp { font: 650 10.5px/1 var(--font); text-transform: uppercase; letter-spacing: .07em; color: var(--ink-3); padding: 10px 10px 4px; }
    .opt { display: flex; align-items: center; gap: 8px; width: 100%; border: 0; background: none; padding: 7px 10px; border-radius: 7px; cursor: pointer; text-align: left; font-size: 14px; }
    .opt.active { background: var(--accent-soft); }
    .lbl { flex: 1; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
    .hint { font-variant-numeric: tabular-nums; font-size: 12.5px; color: var(--ink-2); font-weight: 550; }
    .hint.pos { color: var(--pos); } .hint.neg { color: var(--neg); } .hint.warn { color: var(--warn); }
    .create .lbl { color: var(--accent-ink); font-weight: 550; }
    .none { padding: 12px; color: var(--ink-3); font-size: 13px; }
    .emo { width: 18px; text-align: center; }
  `,
})
export class Combo {
  readonly items = input<ComboItem[]>([]);
  readonly value = model<string | null>(null);
  readonly placeholder = input('');
  readonly allowCreate = input(false);
  /** free text currently shown when allowCreate and no id selected */
  readonly text = model('');
  readonly compact = input(false);
  readonly created = output<string>();
  readonly picked = output<ComboItem>();

  readonly open = signal(false);
  readonly query = signal('');
  readonly active = signal(0);
  private inp = viewChild.required<ElementRef<HTMLInputElement>>('inp');
  private host = inject<ElementRef<HTMLElement>>(ElementRef);

  readonly selectedLabel = computed(() => {
    const it = this.items().find((i) => i.id === this.value());
    return it ? it.label : this.text();
  });

  readonly filtered = computed(() => {
    const q = this.query().trim();
    const items = this.items();
    if (!q) return items;
    return items
      .map((it) => ({ it, s: Math.max(fuzzy(q, it.label), it.keywords ? fuzzy(q, it.keywords) - 5 : 0, it.group ? fuzzy(q, it.group) - 30 : 0) }))
      .filter((x) => x.s > 0)
      .sort((a, b) => b.s - a.s)
      .map((x) => x.it)
      .slice(0, 60);
  });
  readonly exact = computed(() => this.items().some((i) => i.label.toLowerCase() === this.query().trim().toLowerCase()));

  focus() { this.inp().nativeElement.focus(); }

  onFocus() {
    this.query.set('');
    this.open.set(true);
    const idx = this.items().findIndex((i) => i.id === this.value());
    this.active.set(Math.max(0, idx));
    setTimeout(() => this.inp().nativeElement.select());
  }

  key(e: KeyboardEvent) {
    const n = this.filtered().length + (this.allowCreate() && this.query().trim() && !this.exact() ? 1 : 0);
    if (e.key === 'ArrowDown') { e.preventDefault(); this.open.set(true); this.active.update((a) => Math.min(n - 1, a + 1)); this.scroll(); }
    else if (e.key === 'ArrowUp') { e.preventDefault(); this.active.update((a) => Math.max(0, a - 1)); this.scroll(); }
    else if (e.key === 'Enter') {
      if (!this.open()) return;
      e.preventDefault();
      const it = this.filtered()[this.active()];
      if (it) this.choose(it);
      else if (this.allowCreate() && this.query().trim()) this.create();
    } else if (e.key === 'Escape') {
      if (this.open()) { e.stopPropagation(); this.open.set(false); }
    } else if (e.key === 'Tab' && this.open()) {
      const it = this.query().trim() ? this.filtered()[this.active()] : undefined;
      if (it) this.choose(it, false);
      else if (this.allowCreate() && this.query().trim()) this.create(false);
      this.open.set(false);
    }
  }

  private scroll() {
    setTimeout(() => this.host.nativeElement.querySelector('.opt.active')?.scrollIntoView({ block: 'nearest' }));
  }

  choose(it: ComboItem, blur = true) {
    this.value.set(it.id);
    this.text.set('');
    this.open.set(false);
    this.picked.emit(it);
    if (blur) this.focusNext();
  }

  create(blur = true) {
    const t = this.query().trim();
    this.value.set(null);
    this.text.set(t);
    this.open.set(false);
    this.created.emit(t);
    if (blur) this.focusNext();
  }

  /** move focus to the next field, like a spreadsheet */
  private focusNext() {
    const el = this.inp().nativeElement;
    const form = el.closest('form, [data-form]');
    if (!form) return;
    const fields = [...form.querySelectorAll<HTMLElement>('input, select, textarea, button.primary')].filter((f) => !f.hasAttribute('disabled') && f.offsetParent !== null);
    const i = fields.indexOf(el);
    setTimeout(() => fields[i + 1]?.focus());
  }

  blur(e: FocusEvent) {
    if (!this.host.nativeElement.contains(e.relatedTarget as Node)) {
      // free text typed but not confirmed: keep it as text when creation is allowed
      if (this.open() && this.allowCreate() && this.query().trim() && !this.exact()) {
        this.value.set(null);
        this.text.set(this.query().trim());
        this.created.emit(this.query().trim());
      } else if (this.open() && this.query().trim()) {
        const it = this.filtered()[0];
        if (it && this.exact()) this.choose(it, false);
      }
      this.open.set(false);
    }
  }
}
