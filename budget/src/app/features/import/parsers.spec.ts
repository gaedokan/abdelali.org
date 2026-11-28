import { guessMapping, looksLikeHeader, ofxToRows, parseCsv, parseCsvDate, parseOfx, rowsToTxns, toCentimes } from './parsers';

describe('parseCsv', () => {
  it('handles quotes, escaped quotes and embedded newlines', () => {
    expect(parseCsv('a,b\n"x, y","he said ""hi"""\n"l1\nl2",z')).toEqual([['a', 'b'], ['x, y', 'he said "hi"'], ['l1\nl2', 'z']]);
  });
  it('detects ; and tab delimiters, strips BOM and handles CRLF', () => {
    expect(parseCsv('﻿a;b;c\r\n1;2,5;3\r\n')).toEqual([['a', 'b', 'c'], ['1', '2,5', '3']]);
    expect(parseCsv('a\tb\n1\t2')).toEqual([['a', 'b'], ['1', '2']]);
  });
  it('ignores blank lines', () => {
    expect(parseCsv('a,b\n\n1,2\n')).toEqual([['a', 'b'], ['1', '2']]);
  });
});

describe('amounts and dates', () => {
  it('parses amounts', () => {
    expect(toCentimes('1 234,56')).toBe(123456);
    expect(toCentimes('(45.00)')).toBe(-4500);
    expect(toCentimes('45,00-')).toBe(-4500);
    expect(toCentimes('')).toBeNull();
    expect(toCentimes('abc')).toBeNull();
  });
  it('parses dates', () => {
    expect(parseCsvDate('05/11/2026', 'dd/mm/yyyy')).toBe('2026-11-05');
    expect(parseCsvDate('05/11/2026', 'mm/dd/yyyy')).toBe('2026-05-11');
    expect(parseCsvDate('2026-11-05 10:22:00', 'dd/mm/yyyy')).toBe('2026-11-05');
    expect(parseCsvDate('31/02/2026')).toBeNull();
  });
});

describe('guessMapping', () => {
  it('detects a Moroccan bank export with debit/credit', () => {
    const csv = 'Date opération;Date valeur;Libellé;Débit;Crédit\n25/11/2026;25/11/2026;CARTE MARJANE;350,50;\n26/11/2026;26/11/2026;VIREMENT SALAIRE;;12000,00\n13/11/2026;13/11/2026;RETRAIT GAB;200,00;';
    const [h, ...rows] = parseCsv(csv);
    const m = guessMapping(h, rows);
    expect(m).toMatchObject({ date: 0, payee: 2, outflow: 3, inflow: 4, amountMode: 'split', dateFormat: 'dd/mm/yyyy', kind: 'bank' });
    const t = rowsToTxns(rows, m);
    expect(t.map((x) => x.amount)).toEqual([-35050, 1200000, -20000]);
    expect(t[0]).toMatchObject({ date: '2026-11-25', payee: 'CARTE MARJANE' });
  });

  it('detects mm/dd/yyyy from data and single Amount column', () => {
    const [h, ...rows] = parseCsv('Date,Description,Amount\n11/25/2026,Coffee,-3.50\n11/26/2026,Pay,100.00');
    const m = guessMapping(h, rows);
    expect(m).toMatchObject({ date: 0, payee: 1, amount: 2, amountMode: 'single', dateFormat: 'mm/dd/yyyy' });
    expect(rowsToTxns(rows, m).map((x) => [x.date, x.amount])).toEqual([['2026-11-25', -350], ['2026-11-26', 10000]]);
  });

  it('detects ISO dates and flips sign', () => {
    const [h, ...rows] = parseCsv('Date,Payee,Amount\n2026-11-25,Shop,10.00');
    const m = guessMapping(h, rows);
    expect(m.dateFormat).toBe('yyyy-mm-dd');
    expect(rowsToTxns(rows, { ...m, amountMode: 'flip' })[0].amount).toBe(-1000);
  });

  it('detects a YNAB register export', () => {
    const csv = '"Account","Flag","Date","Payee","Category Group/Category","Category Group","Category","Memo","Outflow","Inflow","Cleared"\n' +
      '"Checking","","25/11/2026","Marjane","Food: Groceries","Food","Groceries","weekly","$35.00","$0.00","Cleared"\n' +
      '"Checking","","26/11/2026","Employer","Inflow: Ready to Assign","Inflow","Ready to Assign","","$0.00","$1,200.00","Cleared"\n' +
      '"Savings","","27/11/2026","Transfer : Checking","","","","","$0.00","$50.00","Cleared"';
    const [h, ...rows] = parseCsv(csv);
    const m = guessMapping(h, rows);
    expect(m.kind).toBe('ynab');
    expect(m.amountMode).toBe('split');
    const t = rowsToTxns(rows, m);
    expect(t).toHaveLength(3);
    expect(t[0]).toMatchObject({ account: 'Checking', group: 'Food', category: 'Groceries', amount: -3500, memo: 'weekly' });
    expect(t[1]).toMatchObject({ category: 'Ready to Assign', amount: 120000 });
    expect(t[2]).toMatchObject({ payee: 'Transfer : Checking', account: 'Savings', amount: 5000 });
  });

  it('falls back on content for headerless files', () => {
    const rows = parseCsv('25/11/2026,Coffee shop,-3.50\n26/11/2026,Bakery,-1.20');
    expect(looksLikeHeader(rows[0])).toBe(false);
    const m = guessMapping(rows[0].map((_, i) => 'Column ' + (i + 1)), rows);
    expect(m).toMatchObject({ date: 0, payee: 1, amount: 2 });
  });
});

describe('rowsToTxns import ids', () => {
  it('is stable and distinguishes identical rows', () => {
    const [h, ...rows] = parseCsv('Date,Payee,Amount\n25/11/2026,Cafe,-3.00\n25/11/2026,Cafe,-3.00\n26/11/2026,Cafe,-3.00');
    const m = guessMapping(h, rows);
    const a = rowsToTxns(rows, m), b = rowsToTxns(rows, m);
    expect(a.map((x) => x.importId)).toEqual(b.map((x) => x.importId));
    expect(new Set(a.map((x) => x.importId)).size).toBe(3);
  });
  it('drops unparseable rows', () => {
    const [h, ...rows] = parseCsv('Date,Payee,Amount\nTotal,,5\n25/11/2026,A,1');
    expect(rowsToTxns(rows, guessMapping(h, rows))).toHaveLength(1);
  });
});

describe('parseOfx', () => {
  const sgml = `OFXHEADER:100\nDATA:OFXSGML\n\n<OFX><BANKMSGSRSV1><STMTTRNRS><STMTRS><CURDEF>MAD
<BANKACCTFROM><BANKID>1<ACCTID>00123<ACCTTYPE>CHECKING</BANKACCTFROM>
<BANKTRANLIST>
<STMTTRN><TRNTYPE>DEBIT<DTPOSTED>20261125120000[0:GMT]<TRNAMT>-350.50<FITID>A1<NAME>MARJANE<MEMO>CARTE 1234
<STMTTRN><TRNTYPE>CREDIT<DTPOSTED>20261126<TRNAMT>12000.00<FITID>A2<MEMO>SALAIRE &amp; PRIME
</BANKTRANLIST></STMTRS></STMTTRNRS></BANKMSGSRSV1></OFX>`;
  it('parses SGML', () => {
    const r = parseOfx(sgml);
    expect(r.accountId).toBe('00123');
    expect(r.accountType).toBe('CHECKING');
    expect(r.txns).toEqual([
      { date: '2026-11-25', amount: -35050, payee: 'MARJANE', memo: 'CARTE 1234', fitid: 'A1' },
      { date: '2026-11-26', amount: 1200000, payee: 'SALAIRE & PRIME', memo: '', fitid: 'A2' },
    ]);
    expect(ofxToRows(r)[0].importId).toBe('A1');
  });
  it('parses XML', () => {
    const xml = `<?xml version="1.0"?><OFX><CCSTMTRS><CCACCTFROM><ACCTID>4111</ACCTID></CCACCTFROM><BANKTRANLIST>
<STMTTRN><DTPOSTED>20261101</DTPOSTED><TRNAMT>-10,25</TRNAMT><FITID>X</FITID><NAME>Shop</NAME></STMTTRN></BANKTRANLIST></CCSTMTRS></OFX>`;
    const r = parseOfx(xml);
    expect(r.accountId).toBe('4111');
    expect(r.accountType).toBe('CREDITCARD');
    expect(r.txns[0]).toMatchObject({ date: '2026-11-01', amount: -1025, payee: 'Shop', fitid: 'X' });
  });
});
