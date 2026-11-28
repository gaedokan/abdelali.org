import { TestBed } from '@angular/core/testing';
import { describe, expect, it } from 'vitest';
import { Store } from '../../core/store';
import { Reports } from './reports';
import { addMonths, thisMonth } from '../../core/util';

describe('Reports', () => {
  it('renders the empty state without transactions', () => {
    TestBed.configureTestingModule({ imports: [Reports] });
    const f = TestBed.createComponent(Reports);
    f.detectChanges();
    const el = f.nativeElement as HTMLElement;
    expect(el.querySelector('.empty')?.textContent).toContain('No data');
    expect(el.querySelectorAll('.chips .chip').length).toBe(6);
  });

  it('renders every tab with data', () => {
    TestBed.configureTestingModule({ imports: [Reports] });
    const s = TestBed.inject(Store) as unknown as { put(e: object): void };
    const m = thisMonth();
    s.put({ id: 'a1', kind: 'account', name: 'Bank', type: 'checking', onBudget: true, sort: 1 });
    s.put({ id: 'g1', kind: 'group', name: 'Bills', sort: 1 });
    s.put({ id: 'c1', kind: 'category', groupId: 'g1', name: 'Rent', sort: 1 });
    s.put({ id: 'p1', kind: 'payee', name: 'Boss' });
    const base = { kind: 'txn' as const, accountId: 'a1', cleared: 'cleared' as const, approved: true };
    s.put({ ...base, id: 't1', date: addMonths(m, -1) + '-02', amount: 500000, categoryId: 'rta', payeeId: 'p1' });
    s.put({ ...base, id: 't2', date: m + '-01', amount: -120000, categoryId: 'c1' });
    const f = TestBed.createComponent(Reports);
    f.detectChanges();
    const el = f.nativeElement as HTMLElement;
    const tabs = Array.from(el.querySelectorAll<HTMLButtonElement>('.tabs button'));
    expect(el.querySelectorAll('.slice').length).toBe(1);
    for (const t of tabs) { t.click(); f.detectChanges(); }
    expect(el.querySelector('.pr, .stat')).toBeTruthy();
    tabs[1].click(); f.detectChanges();
    expect(el.querySelectorAll('table.ie tbody tr').length).toBeGreaterThan(4);
    tabs[2].click(); f.detectChanges();
    expect(el.querySelectorAll('.bar.pos').length).toBe(6);
  });
});
