// "Quick budget" strategies. Each returns the new assigned amount for a category in a month.
import { Snapshot } from './engine';
import { addMonths } from './util';

export type Strategy = 'underfunded' | 'lastAssigned' | 'lastSpent' | 'avgAssigned' | 'avgSpent' | 'resetAvailable' | 'resetAssigned';

export const STRATEGIES: { id: Strategy; label: string; hint: string }[] = [
  { id: 'underfunded', label: 'Fund targets', hint: 'Assign what each target still needs' },
  { id: 'lastAssigned', label: 'Assigned last month', hint: 'Repeat last month’s plan' },
  { id: 'lastSpent', label: 'Spent last month', hint: 'Plan for what you actually spent' },
  { id: 'avgAssigned', label: 'Average assigned', hint: 'Last 3 months' },
  { id: 'avgSpent', label: 'Average spent', hint: 'Last 3 months' },
  { id: 'resetAvailable', label: 'Reset available to zero', hint: 'Return unused money' },
  { id: 'resetAssigned', label: 'Reset assigned to zero', hint: 'Start the month over' },
];

export function strategyAmount(s: Strategy, snap: Snapshot, month: string, catId: string): number {
  const cm = snap.cat(month, catId);
  const prev = (n: number) => snap.cat(addMonths(month, -n), catId);
  switch (s) {
    case 'underfunded': return cm.assigned + (cm.target?.underfunded ?? 0);
    case 'lastAssigned': return prev(1).assigned;
    case 'lastSpent': return Math.max(0, -prev(1).activity);
    case 'avgAssigned': return Math.round((prev(1).assigned + prev(2).assigned + prev(3).assigned) / 3);
    case 'avgSpent': return Math.max(0, Math.round(-(prev(1).activity + prev(2).activity + prev(3).activity) / 3));
    case 'resetAvailable': return cm.assigned - cm.available;
    case 'resetAssigned': return 0;
  }
}
