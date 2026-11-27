import { ChangeDetectionStrategy, Component, computed, input } from '@angular/core';

/** Small progress ring for targets. */
@Component({
  selector: 'app-ring',
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <svg [attr.width]="size()" [attr.height]="size()" viewBox="0 0 36 36" aria-hidden="true">
      <circle cx="18" cy="18" r="15" fill="none" stroke="var(--line)" stroke-width="4" />
      <circle cx="18" cy="18" r="15" fill="none" [attr.stroke]="color()" stroke-width="4" stroke-linecap="round"
        [attr.stroke-dasharray]="dash()" transform="rotate(-90 18 18)" />
      @if (value() >= 1) { <path d="m12.5 18.5 3.5 3.5 7-7.5" fill="none" [attr.stroke]="color()" stroke-width="3.2" stroke-linecap="round" stroke-linejoin="round"/> }
    </svg>`,
  styles: `:host { display: inline-flex; line-height: 0; } circle { transition: stroke-dasharray .4s var(--ease); }`,
})
export class Ring {
  readonly value = input(0);
  readonly size = input(16);
  readonly tone = input<'pos' | 'warn' | 'neg' | 'accent'>('pos');
  readonly color = computed(() => `var(--${this.tone()})`);
  readonly dash = computed(() => {
    const c = 2 * Math.PI * 15;
    const v = Math.max(0, Math.min(1, this.value()));
    return `${v * c} ${c}`;
  });
}
