export const uid = (): string =>
  typeof crypto !== 'undefined' && 'randomUUID' in crypto
    ? crypto.randomUUID()
    : 'id-' + Date.now().toString(36) + Math.random().toString(36).slice(2, 10);

// ----------------------------------------------------------------- dates
// Dates are 'YYYY-MM-DD' strings, months are 'YYYY-MM'. All local time.

const pad = (n: number) => String(n).padStart(2, '0');

export const isoDate = (d: Date) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
export const today = () => isoDate(new Date());
export const monthOf = (date: string) => date.slice(0, 7);
export const thisMonth = () => monthOf(today());

export function addMonths(month: string, n: number): string {
  const [y, m] = month.split('-').map(Number);
  const t = y * 12 + (m - 1) + n;
  return `${Math.floor(t / 12)}-${pad((t % 12) + 1)}`;
}
export function monthDiff(a: string, b: string): number {
  const [ya, ma] = a.split('-').map(Number);
  const [yb, mb] = b.split('-').map(Number);
  return (yb - ya) * 12 + (mb - ma);
}
export const daysInMonth = (month: string) => {
  const [y, m] = month.split('-').map(Number);
  return new Date(y, m, 0).getDate();
};
export function addDays(date: string, n: number): string {
  const [y, m, d] = date.split('-').map(Number);
  return isoDate(new Date(y, m - 1, d + n));
}
export function dayDiff(a: string, b: string): number {
  const [ya, ma, da] = a.split('-').map(Number);
  const [yb, mb, db] = b.split('-').map(Number);
  return Math.round((Date.UTC(yb, mb - 1, db) - Date.UTC(ya, ma - 1, da)) / 86400000);
}
/** Same day-of-month n months later, clamped to the month's length. */
export function addMonthsToDate(date: string, n: number, anchorDay?: number): string {
  const month = addMonths(monthOf(date), n);
  const day = Math.min(anchorDay ?? Number(date.slice(8, 10)), daysInMonth(month));
  return `${month}-${pad(day)}`;
}
export function countWeekdayInMonth(month: string, weekday: number): number {
  const [y, m] = month.split('-').map(Number);
  let c = 0;
  for (let d = 1; d <= daysInMonth(month); d++) if (new Date(y, m - 1, d).getDay() === weekday) c++;
  return c;
}

const MONTHS = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];
export const monthName = (month: string, short = false) => {
  const n = MONTHS[Number(month.slice(5, 7)) - 1];
  return short ? n.slice(0, 3) : n;
};
export const monthLabel = (month: string, short = false) => `${monthName(month, short)} ${month.slice(0, 4)}`;

export type DateFormat = 'dd/mm/yyyy' | 'mm/dd/yyyy' | 'yyyy-mm-dd';

export function formatDate(date: string, fmt: DateFormat = 'dd/mm/yyyy'): string {
  if (!date) return '';
  const [y, m, d] = date.split('-');
  if (fmt === 'yyyy-mm-dd') return date;
  return fmt === 'dd/mm/yyyy' ? `${d}/${m}/${y}` : `${m}/${d}/${y}`;
}

/** Forgiving date input: "27/11", "27/11/26", "27.11.2026", "2026-11-27", "today", "yesterday", "-2" (days ago). */
export function parseDate(input: string, fmt: DateFormat = 'dd/mm/yyyy', base = today()): string | null {
  const s = input.trim().toLowerCase();
  if (!s) return null;
  if (s === 'today' || s === 't' || s === "aujourd'hui") return base;
  if (s === 'yesterday' || s === 'y' || s === 'hier') return addDays(base, -1);
  if (s === 'tomorrow') return addDays(base, 1);
  if (/^[-+]\d{1,3}$/.test(s)) return addDays(base, Number(s));
  let m = s.match(/^(\d{4})-(\d{1,2})-(\d{1,2})$/);
  if (m) return valid(+m[1], +m[2], +m[3]);
  m = s.match(/^(\d{1,2})[/.\- ](\d{1,2})(?:[/.\- ](\d{2,4}))?$/);
  if (m) {
    let [a, b] = [+m[1], +m[2]];
    if (fmt === 'mm/dd/yyyy') [a, b] = [b, a];
    let y = m[3] ? +m[3] : +base.slice(0, 4);
    if (y < 100) y += 2000;
    return valid(y, b, a);
  }
  m = s.match(/^(\d{1,2})$/);
  if (m) return valid(+base.slice(0, 4), +base.slice(5, 7), +m[1]);
  return null;
}
function valid(y: number, m: number, d: number): string | null {
  if (m < 1 || m > 12 || d < 1 || d > 31) return null;
  const dt = new Date(y, m - 1, d);
  if (dt.getMonth() !== m - 1) return null;
  return isoDate(dt);
}

// ---------------------------------------------------------------- search

/** Simple fuzzy score: 0 = no match, higher = better. */
export function fuzzy(query: string, text: string): number {
  const q = norm(query), t = norm(text);
  if (!q) return 1;
  if (t === q) return 100;
  if (t.startsWith(q)) return 80;
  const wi = t.split(/\s+/).findIndex((w) => w.startsWith(q));
  if (wi >= 0) return 60 - wi;
  if (t.includes(q)) return 40;
  let i = 0, gaps = 0, last = -1;
  for (const ch of t) {
    if (ch === q[i]) { if (last >= 0) gaps += 0; i++; }
    if (i === q.length) break;
    last++;
  }
  return i === q.length ? Math.max(1, 20 - gaps) : 0;
}
export const norm = (s: string) =>
  s.toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/[^\p{L}\p{N}\s]/gu, ' ').replace(/\s+/g, ' ').trim();

export function groupBy<T, K>(items: T[], key: (t: T) => K): Map<K, T[]> {
  const m = new Map<K, T[]>();
  for (const it of items) {
    const k = key(it);
    const arr = m.get(k);
    if (arr) arr.push(it); else m.set(k, [it]);
  }
  return m;
}

export const sum = (xs: number[]) => xs.reduce((a, b) => a + b, 0);
