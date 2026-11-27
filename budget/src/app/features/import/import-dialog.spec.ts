import { TestBed } from '@angular/core/testing';
import { Actions } from '../../core/actions';
import { Store } from '../../core/store';
import { ImportDialog } from './import-dialog';

describe('ImportDialog', () => {
  beforeAll(() => {
    // jsdom has no <dialog> modal support
    const p = HTMLDialogElement.prototype as any;
    p.showModal ??= function (this: HTMLDialogElement) { this.setAttribute('open', ''); };
    p.close ??= function (this: HTMLDialogElement) { this.removeAttribute('open'); };
  });

  it('compiles and renders the first step', async () => {
    const fixture = TestBed.createComponent(ImportDialog);
    fixture.componentRef.setInput('open', true);
    fixture.componentRef.setInput('accountId', null);
    await fixture.whenStable();
    expect(fixture.componentInstance).toBeTruthy();
    expect(fixture.nativeElement.textContent).toContain('Drop a bank file');
  });

  it('moves to review for OFX text', async () => {
    const fixture = TestBed.createComponent(ImportDialog);
    fixture.componentRef.setInput('open', true);
    await fixture.whenStable();
    fixture.componentInstance.loadText('<OFX><BANKTRANLIST><STMTTRN><DTPOSTED>20261101<TRNAMT>-5.00<FITID>1<NAME>Shop</STMTTRN></BANKTRANLIST></OFX>', 'a.ofx');
    await fixture.whenStable();
    expect(fixture.componentInstance.step()).toBe('review');
    expect(fixture.nativeElement.textContent).toContain('Shop');
    expect(fixture.componentInstance.counts().new).toBe(1);
  });

  it('maps pasted CSV', async () => {
    const fixture = TestBed.createComponent(ImportDialog);
    fixture.componentRef.setInput('open', true);
    await fixture.whenStable();
    fixture.componentInstance.loadText('Date;Libellé;Débit;Crédit\n25/11/2026;MARJANE;10,00;', 'pasted');
    await fixture.whenStable();
    expect(fixture.componentInstance.step()).toBe('map');
    expect(fixture.componentInstance.parsed()).toHaveLength(1);
  });

  it('imports rows, skips duplicates on re-import and undoes in one step', async () => {
    const acct = TestBed.inject(Actions).addAccount('Chk', 'checking', 0);
    const store = TestBed.inject(Store);
    const csv = 'Date,Payee,Amount\n25/11/2026,Cafe,-3.00\n26/11/2026,Bakery,-1.20';
    const run = async () => {
      const f = TestBed.createComponent(ImportDialog);
      f.componentRef.setInput('open', true);
      f.componentRef.setInput('accountId', acct.id);
      await f.whenStable();
      f.componentInstance.loadText(csv, 'x.csv');
      f.componentInstance.toReview();
      await f.whenStable();
      return f;
    };
    const f1 = await run();
    expect(f1.componentInstance.counts().new).toBe(2);
    f1.componentInstance.doImport();
    expect(store.txns().filter((t) => t.source === 'import')).toHaveLength(2);
    const f2 = await run();
    expect(f2.componentInstance.counts().dup).toBe(2);
    expect(f2.componentInstance.selected()).toBe(0);
    store.undo();
    expect(store.txns().filter((t) => t.source === 'import')).toHaveLength(0);
  });
});
