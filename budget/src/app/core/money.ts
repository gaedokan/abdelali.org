// Money helpers. Amounts are integer centimes.

export interface MoneyFormat {
  currency: string;
  symbolFirst: boolean;
  decimal: ',' | '.';
  group: ' ' | '.' | ',' | "'";
}

export const DEFAULT_FORMAT: MoneyFormat = { currency: 'MAD', symbolFirst: false, decimal: ',', group: ' ' };

export function formatNumber(c: number, f: MoneyFormat = DEFAULT_FORMAT, decimals = true): string {
  const neg = c < 0;
  const abs = Math.abs(Math.round(c));
  const int = Math.floor(abs / 100).toString();
  const grp = f.group === ' ' ? ' ' : f.group;
  const intStr = int.replace(/\B(?=(\d{3})+(?!\d))/g, grp);
  const dec = (abs % 100).toString().padStart(2, '0');
  return (neg ? '−' : '') + intStr + (decimals ? f.decimal + dec : '');
}

export function formatMoney(c: number, f: MoneyFormat = DEFAULT_FORMAT, opts: { currency?: boolean; sign?: boolean; decimals?: boolean } = {}): string {
  const n = formatNumber(c, f, opts.decimals !== false);
  const withSign = opts.sign && c > 0 ? '+' + n : n;
  if (opts.currency === false || !f.currency) return withSign;
  return f.symbolFirst ? `${f.currency} ${withSign}` : `${withSign} ${f.currency}`;
}

/** Compact form for charts: 12,3k */
export function formatCompact(c: number, f: MoneyFormat = DEFAULT_FORMAT): string {
  const v = Math.abs(c / 100);
  const s = c < 0 ? '−' : '';
  if (v >= 1e6) return s + (v / 1e6).toFixed(1).replace('.', f.decimal) + 'M';
  if (v >= 1e3) return s + (v / 1e3).toFixed(v >= 1e4 ? 0 : 1).replace('.', f.decimal) + 'k';
  return s + Math.round(v).toString();
}

/**
 * Parse user input into centimes. Accepts "1 234,56", "1,234.56", "1.234,56", "45", "-12,5",
 * "MAD 45.00", "45,00 DH", and simple arithmetic like "120/3", "45+12,5", "=3*40".
 * Returns null when the input is not a number.
 */
export function parseMoney(input: string | number | null | undefined): number | null {
  if (input === null || input === undefined) return null;
  if (typeof input === 'number') return Math.round(input * 100);
  let s = input.trim().replace(/^=/, '').replace(/[−–]/g, '-');
  s = s.replace(/(mad|dhs?|dirhams?|eur|usd|€|\$|£)/gi, '').replace(/[\s  ']/g, '');
  if (!s) return null;
  // Tokenise numbers and operators.
  const tokens = s.match(/(\d[\d.,]*|[-+*/()x×])/g);
  if (!tokens || tokens.join('') !== s) return null;
  const nums = tokens.map((t) => (/^\d/.test(t) ? String(parseNum(t)) : t === 'x' || t === '×' ? '*' : t));
  if (nums.some((n) => n === 'NaN')) return null;
  const expr = nums.join('');
  if (!/^[-+*/().\d]+$/.test(expr)) return null;
  try {
    const v = evalArith(expr);
    if (!isFinite(v)) return null;
    return Math.round(v * 100);
  } catch {
    return null;
  }
}

function parseNum(t: string): number {
  const lastDot = t.lastIndexOf('.'), lastComma = t.lastIndexOf(',');
  let s = t;
  if (lastDot >= 0 && lastComma >= 0) {
    const decSep = lastDot > lastComma ? '.' : ',';
    const grpSep = decSep === '.' ? ',' : '.';
    s = s.split(grpSep).join('').replace(decSep, '.');
  } else if (lastComma >= 0) {
    const parts = s.split(',');
    // "1,234,567" (several commas, 3-digit groups) is grouping; otherwise comma is the decimal separator
    s = parts.length > 2 && parts.slice(1).every((p) => p.length === 3) ? parts.join('') : parts.join('.');
  } else if (lastDot >= 0) {
    const parts = s.split('.');
    s = parts.length > 2 && parts.slice(1).every((p) => p.length === 3) ? parts.join('') : s;
  }
  return Number(s);
}

/** Tiny recursive-descent evaluator for + - * / and parentheses. */
function evalArith(expr: string): number {
  let i = 0;
  const peek = () => expr[i];
  const num = (): number => {
    if (peek() === '(') { i++; const v = add(); if (expr[i] !== ')') throw new Error('paren'); i++; return v; }
    if (peek() === '-') { i++; return -num(); }
    if (peek() === '+') { i++; return num(); }
    const m = expr.slice(i).match(/^\d+(\.\d+)?/);
    if (!m) throw new Error('num');
    i += m[0].length;
    return Number(m[0]);
  };
  const mul = (): number => {
    let v = num();
    while (peek() === '*' || peek() === '/') { const op = expr[i++]; const r = num(); v = op === '*' ? v * r : v / r; }
    return v;
  };
  const add = (): number => {
    let v = mul();
    while (peek() === '+' || peek() === '-') { const op = expr[i++]; const r = mul(); v = op === '+' ? v + r : v - r; }
    return v;
  };
  const v = add();
  if (i !== expr.length) throw new Error('trailing');
  return v;
}
