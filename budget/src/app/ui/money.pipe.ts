import { inject, Pipe, PipeTransform } from '@angular/core';
import { formatMoney } from '../core/money';
import { Store } from '../core/store';

/** {{ amount | money }} → "1 234,56 MAD"; {{ amount | money:'plain' }} → "1 234,56"; 'sign' adds + for inflows. */
@Pipe({ name: 'money', pure: false })
export class MoneyPipe implements PipeTransform {
  private store = inject(Store);
  transform(value: number | null | undefined, mode: 'full' | 'plain' | 'sign' | 'short' = 'full'): string {
    if (value === null || value === undefined) return '';
    const f = this.store.format();
    return formatMoney(value, f, {
      currency: mode === 'full' || mode === 'sign',
      sign: mode === 'sign',
      decimals: mode !== 'short',
    });
  }
}

@Pipe({ name: 'date' })
export class DatePipe implements PipeTransform {
  private store = inject(Store);
  transform(value: string | null | undefined): string {
    if (!value) return '';
    const fmt = this.store.settings().dateFormat;
    const [y, m, d] = value.split('-');
    return fmt === 'yyyy-mm-dd' ? value : fmt === 'dd/mm/yyyy' ? `${d}/${m}/${y}` : `${m}/${d}/${y}`;
  }
}
