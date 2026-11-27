// Human sentences for targets, shared by the budget rows and the inspector.
import { Target } from './models';
import { monthLabel, monthName } from './util';

export const WEEKDAYS = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
export const ordinal = (d: number) => (d >= 31 ? 'last day' : d + (d % 10 === 1 && d !== 11 ? 'st' : d % 10 === 2 && d !== 12 ? 'nd' : d % 10 === 3 && d !== 13 ? 'rd' : 'th'));
const mName = (m: number) => monthName(`2000-${String(m).padStart(2, '0')}`);

export function repeatLabel(n: number): string {
  if (n === 12) return 'every year';
  if (n % 12 === 0) return `every ${n / 12} years`;
  return n === 1 ? 'every month' : `every ${n} months`;
}

/** e.g. "Set aside 450,00 MAD every month by the 3rd" */
export function describeTarget(t: Target, money: (c: number) => string): string {
  const a = money(t.amount);
  switch (t.type) {
    case 'weekly':
      return `${t.mode === 'refill' ? 'Refill up to' : 'Set aside'} ${a} every ${WEEKDAYS[t.weekday ?? 6]}`;
    case 'monthly':
      return `${t.mode === 'refill' ? 'Refill up to' : 'Set aside'} ${a} every month${t.day ? ` by the ${ordinal(t.day)}` : ''}`;
    case 'yearly':
      return `${a} every year by ${t.day ? `${ordinal(t.day)} ` : ''}${mName(t.month ?? 12)}`.replace(/by last day (\w+)/, 'by the end of $1');
    case 'byDate':
      return `${a} by ${monthLabel(t.date ?? '')}${t.repeatMonths ? `, then ${repeatLabel(t.repeatMonths)}` : ''}`;
    case 'balance':
      return `Save up to ${a}${t.date ? ` by ${monthLabel(t.date)}` : ''}`;
  }
}

/** Short due hint for the budget row, e.g. "by the 15th", "by Mar 2027" */
export function dueHint(t: Target, nextMonth: string | null): string {
  if (t.type === 'monthly' && t.day) return `by the ${ordinal(t.day)}`;
  if (t.type === 'weekly') return `every ${WEEKDAYS[t.weekday ?? 6].slice(0, 3)}`;
  if (nextMonth) return `by ${monthLabel(nextMonth, true)}`;
  return '';
}
