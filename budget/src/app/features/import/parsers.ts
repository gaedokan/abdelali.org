// Pure parsing helpers for bank / YNAB file import: CSV, OFX/QFX, column guessing and row conversion.
import { parseMoney } from '../../core/money';
import { norm } from '../../core/util';

export type DateFmt = 'dd/mm/yyyy' | 'mm/dd/yyyy' | 'yyyy-mm-dd';
/** single: one signed column · split: separate outflow/inflow · flip: one column, sign reversed. */
export type AmountMode = 'single' | 'split' | 'flip';

export interface Mapping {
  date: number;
  payee: number;
  memo: number;
  amount: number;
  outflow: number;
  inflow: number;
  /** YNAB register extras (-1 when absent) */
  account: number;
  group: number;
  category: number;
  dateFormat: DateFmt;
  amountMode: AmountMode;
  kind: 'generic' | 'ynab' | 'bank';
}

export interface ParsedRow {
  date: string;
  amount: number;
  payee: string;
  memo: string;
  importId: string;
  /** YNAB register extras */
  account?: string;
  group?: string;
  category?: string;
}

export interface OfxTxn { date: string; amount: number; payee: string; memo: string; fitid: string }
export interface OfxResult { accountId?: string; accountType?: string; currency?: string; txns: OfxTxn[] }

// ------------------------------------------------------------------ CSV

export function detectDelimiter(text: string): ',' | ';' | '\t' {
  // look at the first few lines, ignoring quoted sections
  const lines: string[] = [];
  let cur = '', q = false;
  for (const ch of text) {
    if (ch === '"') q = !q;
    if ((ch === '\n' || ch === '\r') && !q) {
      if (cur) lines.push(cur);
      cur = '';
      if (lines.length >= 5) break;
    } else if (!q) cur += ch;
  }
  if (cur && lines.length < 5) lines.push(cur);
  const score = (d: string) => lines.reduce((s, l) => s + l.split(d).length - 1, 0);
  const cands: Array<',' | ';' | '\t'> = ['\t', ';', ','];
  let best: ',' | ';' | '\t' = ',', bs = 0;
  for (const d of cands) { const s = score(d); if (s > bs) { best = d; bs = s; } }
  return best;
}

export function parseCsv(text: string, delimiter?: string): string[][] {
  if (text.charCodeAt(0) === 0xfeff) text = text.slice(1);
  const d = delimiter ?? detectDelimiter(text);
  const rows: string[][] = [];
  let row: string[] = [], field = '', q = false, i = 0;
  const endField = () => { row.push(field); field = ''; };
  const endRow = () => {
    endField();
    if (row.length > 1 || row[0].trim() !== '') rows.push(row);
    row = [];
  };
  while (i < text.length) {
    const ch = text[i];
    if (q) {
      if (ch === '"') {
        if (text[i + 1] === '"') { field += '"'; i++; } else q = false;
      } else field += ch;
    } else if (ch === '"' && field === '') q = true;
    else if (ch === d) endField();
    else if (ch === '\r') { if (text[i + 1] === '\n') i++; endRow(); }
    else if (ch === '\n') endRow();
    else field += ch;
    i++;
  }
  if (field !== '' || row.length) endRow();
  return rows;
}

// ------------------------------------------------------------------ dates & amounts

const pad = (n: number) => String(n).padStart(2, '0');

function iso(y: number, m: number, d: number): string | null {
  if (m < 1 || m > 12 || d < 1 || d > 31) return null;
  const dt = new Date(y, m - 1, d);
  if (dt.getFullYear() !== y || dt.getMonth() !== m - 1) return null;
  return `${y}-${pad(m)}-${pad(d)}`;
}

/** Parse one cell as a date in the given format; returns 'YYYY-MM-DD' or null. */
export function parseCsvDate(input: string, fmt: DateFmt = 'dd/mm/yyyy'): string | null {
  const s = input.trim().replace(/[T\s]+\d{1,2}:\d{2}.*$/, '');
  let m = s.match(/^(\d{4})[-/.](\d{1,2})[-/.](\d{1,2})$/);
  if (m) return iso(+m[1], +m[2], +m[3]);
  m = s.match(/^(\d{4})(\d{2})(\d{2})$/);
  if (m) return iso(+m[1], +m[2], +m[3]);
  m = s.match(/^(\d{1,2})[/.\-](\d{1,2})[/.\-](\d{2}|\d{4})$/);
  if (m) {
    let y = +m[3];
    if (m[3].length === 2) y += 2000;
    return fmt === 'mm/dd/yyyy' ? iso(y, +m[1], +m[2]) : iso(y, +m[2], +m[1]);
  }
  return null;
}

/** Decide dd/mm vs mm/dd vs ISO from a column of date strings (defaults to dd/mm/yyyy). */
export function detectDateFormat(values: string[]): DateFmt {
  let isoN = 0, firstGt12 = 0, secondGt12 = 0, other = 0;
  for (const v of values) {
    const s = v.trim().replace(/[T\s]+\d{1,2}:\d{2}.*$/, '');
    if (/^\d{4}[-/.]\d{1,2}[-/.]\d{1,2}$|^\d{8}$/.test(s)) { isoN++; continue; }
    const m = s.match(/^(\d{1,2})[/.\-](\d{1,2})[/.\-](\d{2}|\d{4})$/);
    if (!m) continue;
    other++;
    if (+m[1] > 12) firstGt12++;
    if (+m[2] > 12) secondGt12++;
  }
  if (isoN > other) return 'yyyy-mm-dd';
  if (secondGt12 > 0 && firstGt12 === 0) return 'mm/dd/yyyy';
  return 'dd/mm/yyyy';
}

/** Cell text to centimes; null when it is not a number. Handles (45.00), 45.00-, +12, "1 234,56". */
export function toCentimes(input: string | undefined): number | null {
  if (input === undefined) return null;
  let s = input.trim();
  if (!s) return null;
  let neg = false;
  const p = s.match(/^\((.*)\)$/);
  if (p) { neg = true; s = p[1]; }
  if (/-$/.test(s)) { neg = true; s = s.slice(0, -1); }
  s = s.replace(/^\+/, '');
  if (!/\d/.test(s)) return null;
  const v = parseMoney(s);
  if (v === null || !Number.isFinite(v)) return null;
  return neg ? -Math.abs(v) : v;
}

// ------------------------------------------------------------------ mapping guesses

const H = {
  date: ['date operation', 'date opération', 'date transaction', 'date', 'date comptable', 'posted', 'posting date', 'transaction date', 'date valeur'],
  payee: ['payee', 'libelle', 'libellé', 'description', 'intitule', 'designation', 'beneficiaire', 'name', 'nom', 'merchant', 'tiers', 'operation'],
  memo: ['memo', 'note', 'notes', 'reference', 'details', 'detail', 'commentaire', 'motif', 'remarks', 'narrative'],
  amount: ['montant', 'amount', 'valeur', 'value', 'somme'],
  outflow: ['outflow', 'debit', 'debits', 'withdrawal', 'withdrawals', 'retrait', 'sortie', 'paid out', 'money out'],
  inflow: ['inflow', 'credit', 'credits', 'deposit', 'deposits', 'depot', 'entree', 'paid in', 'money in'],
};

function findCol(heads: string[], names: string[], used: Set<number>): number {
  const ns = names.map(norm);
  for (const n of ns) { const i = heads.findIndex((h, j) => h === n && !used.has(j)); if (i >= 0) return i; }
  for (const n of ns) { const i = heads.findIndex((h, j) => !used.has(j) && h.length > 0 && (h.startsWith(n + ' ') || h.endsWith(' ' + n))); if (i >= 0) return i; }
  return -1;
}

const column = (rows: string[][], i: number, n = 200) => rows.slice(0, n).map((r) => r[i] ?? '').filter((v) => v.trim() !== '');

function dateScore(vals: string[]): number {
  if (!vals.length) return 0;
  const fmt = detectDateFormat(vals);
  return vals.filter((v) => parseCsvDate(v, fmt)).length / vals.length;
}
function numScore(vals: string[]): number {
  if (!vals.length) return 0;
  return vals.filter((v) => toCentimes(v) !== null && !parseCsvDate(v)).length / vals.length;
}

/** True when the first row looks like a header (no cell is a date or a plain amount). */
export function looksLikeHeader(first: string[]): boolean {
  return !first.some((c) => parseCsvDate(c) !== null || (toCentimes(c) !== null && /^[-+(]?\d[\d\s.,]*\)?$/.test(c.trim()) && c.trim().length > 0));
}

export function guessMapping(header: string[], rows: string[][]): Mapping {
  const heads = header.map(norm);
  const m: Mapping = {
    date: -1, payee: -1, memo: -1, amount: -1, outflow: -1, inflow: -1, account: -1, group: -1, category: -1,
    dateFormat: 'dd/mm/yyyy', amountMode: 'single', kind: 'generic',
  };
  const used = new Set<number>();
  const take = (k: 'date' | 'payee' | 'memo' | 'amount' | 'outflow' | 'inflow', names: string[]) => {
    const i = findCol(heads, names, used);
    if (i >= 0) { m[k] = i; used.add(i); }
  };

  // YNAB register export
  const has = (h: string) => heads.includes(h);
  const ynab = has('account') && has('date') && has('payee') && has('outflow') && has('inflow');
  if (ynab) {
    m.kind = 'ynab';
    m.account = heads.indexOf('account');
    m.date = heads.indexOf('date');
    m.payee = heads.indexOf('payee');
    m.memo = heads.indexOf('memo');
    m.outflow = heads.indexOf('outflow');
    m.inflow = heads.indexOf('inflow');
    m.group = heads.indexOf('category group');
    m.category = heads.indexOf('category');
    m.amountMode = 'split';
    m.dateFormat = detectDateFormat(column(rows, m.date));
    return m;
  }

  take('date', H.date);
  take('payee', H.payee);
  take('memo', H.memo);
  take('outflow', H.outflow);
  take('inflow', H.inflow);
  take('amount', H.amount);

  // Content-based fallbacks for headerless / unusual files
  const width = Math.max(header.length, ...rows.slice(0, 20).map((r) => r.length));
  const free = () => Array.from({ length: width }, (_, i) => i).filter((i) => !used.has(i));
  if (m.date < 0) {
    const best = free().map((i) => ({ i, s: dateScore(column(rows, i)) })).sort((a, b) => b.s - a.s)[0];
    if (best && best.s >= 0.7) { m.date = best.i; used.add(best.i); }
  }
  if (m.amount < 0 && (m.outflow >= 0 || m.inflow >= 0)) {
    // keep the explicit pair
  } else if (m.amount < 0) {
    const best = free().map((i) => ({ i, s: numScore(column(rows, i)) })).sort((a, b) => b.s - a.s || b.i - a.i)[0];
    if (best && best.s >= 0.7) { m.amount = best.i; used.add(best.i); }
  }
  if (m.payee < 0) {
    const best = free()
      .map((i) => ({ i, len: column(rows, i, 50).reduce((s, v) => s + v.length, 0), n: numScore(column(rows, i)), d: dateScore(column(rows, i)) }))
      .filter((x) => x.n < 0.5 && x.d < 0.5 && x.len > 0)
      .sort((a, b) => b.len - a.len)[0];
    if (best) { m.payee = best.i; used.add(best.i); }
  }

  if (m.outflow >= 0 && m.inflow >= 0) m.amountMode = 'split';
  else if (m.amount >= 0) m.amountMode = 'single';
  else if (m.outflow >= 0 || m.inflow >= 0) { m.amount = Math.max(m.outflow, m.inflow); m.outflow = m.inflow = -1; }

  const frenchBank = heads.some((h) => ['date operation', 'libelle', 'debit', 'credit'].includes(h)) && heads.includes('libelle');
  m.kind = frenchBank ? 'bank' : 'generic';
  m.dateFormat = m.date >= 0 ? detectDateFormat(column(rows, m.date)) : 'dd/mm/yyyy';
  return m;
}

// ------------------------------------------------------------------ rows -> transactions

function hash(s: string): string {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 0x01000193) >>> 0; }
  return h.toString(36);
}

export const stableImportId = (date: string, amount: number, payee: string, occurrence: number) =>
  'csv-' + hash(`${date}|${amount}|${payee}|${occurrence}`) + hash(`${occurrence}|${payee}|${amount}|${date}`);

export function rowToAmount(r: string[], m: Mapping): number | null {
  if (m.amountMode === 'split') {
    const o = m.outflow >= 0 ? toCentimes(r[m.outflow]) : null;
    const i = m.inflow >= 0 ? toCentimes(r[m.inflow]) : null;
    if (o === null && i === null) return null;
    return -Math.abs(o ?? 0) + Math.abs(i ?? 0);
  }
  if (m.amount < 0) return null;
  const a = toCentimes(r[m.amount]);
  if (a === null) return null;
  return m.amountMode === 'flip' ? -a : a;
}

/** Convert data rows (header already removed) to transactions. Unparseable rows are dropped. */
export function rowsToTxns(rows: string[][], m: Mapping): ParsedRow[] {
  const out: ParsedRow[] = [];
  const seen = new Map<string, number>();
  for (const r of rows) {
    if (m.date < 0) break;
    const date = parseCsvDate(r[m.date] ?? '', m.dateFormat);
    const amount = rowToAmount(r, m);
    if (!date || amount === null) continue;
    const payee = (m.payee >= 0 ? r[m.payee] ?? '' : '').replace(/\s+/g, ' ').trim();
    const memo = (m.memo >= 0 ? r[m.memo] ?? '' : '').replace(/\s+/g, ' ').trim();
    const key = `${date}|${amount}|${payee}`;
    const n = seen.get(key) ?? 0;
    seen.set(key, n + 1);
    const row: ParsedRow = { date, amount, payee, memo, importId: stableImportId(date, amount, payee, n) };
    if (m.kind === 'ynab') {
      row.account = (r[m.account] ?? '').trim();
      let group = m.group >= 0 ? (r[m.group] ?? '').trim() : '';
      let category = m.category >= 0 ? (r[m.category] ?? '').trim() : '';
      if (!category && m.group < 0) category = '';
      if (group || category) { row.group = group; row.category = category; }
      if (!row.group && !row.category) { delete row.group; delete row.category; }
    }
    out.push(row);
  }
  return out;
}

// ------------------------------------------------------------------ OFX / QFX

const decode = (s: string) =>
  s.replace(/&lt;/gi, '<').replace(/&gt;/gi, '>').replace(/&quot;/gi, '"').replace(/&apos;/gi, "'").replace(/&#(\d+);/g, (_, n) => String.fromCharCode(+n)).replace(/&amp;/gi, '&').trim();

function tag(block: string, name: string): string | undefined {
  const m = block.match(new RegExp(`<${name}>([^<\\r\\n]*)`, 'i'));
  return m ? decode(m[1]) : undefined;
}

export function looksLikeOfx(text: string): boolean {
  return /OFXHEADER|<OFX[>\s]/i.test(text.slice(0, 4000));
}

export function parseOfx(text: string): OfxResult {
  const res: OfxResult = { txns: [] };
  const acct = text.match(/<(?:BANKACCTFROM|CCACCTFROM)>([\s\S]*?)(?:<\/(?:BANKACCTFROM|CCACCTFROM)>|<\/?(?:STMTTRNRS|BANKTRANLIST)>|<STMTTRN>)/i);
  if (acct) {
    res.accountId = tag(acct[1], 'ACCTID');
    res.accountType = tag(acct[1], 'ACCTTYPE') ?? (/<CCACCTFROM>/i.test(text) ? 'CREDITCARD' : undefined);
  }
  res.currency = tag(text, 'CURDEF');
  const re = /<STMTTRN>([\s\S]*?)(?=<\/STMTTRN>|<STMTTRN>|<\/BANKTRANLIST>|<\/CCSTMTRS>|<\/STMTRS>|$)/gi;
  let mt: RegExpExecArray | null;
  while ((mt = re.exec(text))) {
    const b = mt[1];
    const dt = tag(b, 'DTPOSTED') ?? tag(b, 'DTUSER');
    const amt = tag(b, 'TRNAMT');
    if (!dt || !amt) continue;
    const d = dt.match(/^(\d{4})(\d{2})(\d{2})/);
    if (!d) continue;
    const date = iso(+d[1], +d[2], +d[3]);
    if (!date) continue;
    let s = amt.replace(/\s/g, '');
    if (s.includes(',') && !s.includes('.')) s = s.replace(',', '.');
    else s = s.replace(/,/g, '');
    const n = parseFloat(s);
    if (!Number.isFinite(n)) continue;
    const name = tag(b, 'NAME');
    const memo = tag(b, 'MEMO') ?? '';
    res.txns.push({
      date, amount: Math.round(n * 100),
      payee: (name || memo).replace(/\s+/g, ' '),
      memo: name ? memo : '',
      fitid: tag(b, 'FITID') ?? '',
    });
  }
  return res;
}

/** OFX transactions in the common row shape (importId = FITID when present, else stable hash). */
export function ofxToRows(o: OfxResult): ParsedRow[] {
  const seen = new Map<string, number>();
  return o.txns.map((t) => {
    const key = `${t.date}|${t.amount}|${t.payee}`;
    const n = seen.get(key) ?? 0;
    seen.set(key, n + 1);
    return { date: t.date, amount: t.amount, payee: t.payee, memo: t.memo, importId: t.fitid || stableImportId(t.date, t.amount, t.payee, n) };
  });
}
