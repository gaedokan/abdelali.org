import { TestBed } from '@angular/core/testing';
import { describe, expect, it } from 'vitest';
import { Store } from '../../core/store';
import { Portfolio } from './portfolio';

describe('Portfolio', () => {
  it('renders the empty state without an investment account', () => {
    TestBed.configureTestingModule({ imports: [Portfolio] });
    const f = TestBed.createComponent(Portfolio);
    f.detectChanges();
    const el = f.nativeElement as HTMLElement;
    expect(el.querySelector('.empty')?.textContent).toContain('brokerage account');
    expect(el.querySelector('.empty .btn.primary')?.textContent).toContain('Add a brokerage account');
  });

  it('records a trade, adjusts account value and shows the holding', () => {
    TestBed.configureTestingModule({ imports: [Portfolio] });
    const s = TestBed.inject(Store);
    s.put({ id: 'inv', kind: 'account', name: 'Broker', type: 'investment', onBudget: false, sort: 1 });
    const f = TestBed.createComponent(Portfolio);
    f.detectChanges();
    const cmp = f.componentInstance as unknown as Record<string, any>;
    cmp['openTrade']();
    cmp['tSym'].set('IAM'); cmp['tQty'].set('10'); cmp['tPrice'].set('100'); cmp['tFees'].set('0'); cmp['feesTouched'].set(true);
    cmp['saveTrade']();
    expect(s.trades().length).toBe(1);
    expect(s.txns().find((t) => t.amount === -100000)).toBeTruthy();
    s.put({ id: 'p:IAM', kind: 'price', symbol: 'IAM', price: 12000, date: new Date().toISOString().slice(0, 10) });
    cmp['updateValue']();
    // cash -1 000 + market value 1 200 = +200 working balance
    expect(s.budget().balances.get('inv')?.working).toBe(20000);
    cmp['updateValue']();
    expect(s.txns().filter((t) => t.memo === 'Unrealised gain/loss').length).toBe(1);
    f.detectChanges();
    expect((f.nativeElement as HTMLElement).querySelectorAll('.hrow').length).toBe(1);
  });
});
