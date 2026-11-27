// Entity types. Every entity is stored and synced as one row: { id, kind, updatedAt, deleted?, ...fields }.
// Money is always an integer number of centimes (1 MAD = 100).

export type Kind = 'settings' | 'account' | 'group' | 'category' | 'payee' | 'txn' | 'assign' | 'scheduled' | 'trade' | 'price';

export interface Base {
  id: string;
  kind: Kind;
  updatedAt: number;
  deleted?: boolean;
}

export type AccountType =
  | 'checking' | 'savings' | 'cash' | 'creditCard' | 'lineOfCredit'
  | 'asset' | 'liability' | 'loan' | 'mortgage' | 'investment';

export const ACCOUNT_TYPES: { type: AccountType; label: string; budget: boolean; credit?: boolean }[] = [
  { type: 'checking', label: 'Checking', budget: true },
  { type: 'savings', label: 'Savings', budget: true },
  { type: 'cash', label: 'Cash', budget: true },
  { type: 'creditCard', label: 'Credit card', budget: true, credit: true },
  { type: 'lineOfCredit', label: 'Line of credit', budget: true, credit: true },
  { type: 'investment', label: 'Stocks / brokerage (tracking)', budget: false },
  { type: 'asset', label: 'Asset (tracking)', budget: false },
  { type: 'loan', label: 'Loan (tracking)', budget: false },
  { type: 'mortgage', label: 'Mortgage (tracking)', budget: false },
  { type: 'liability', label: 'Other debt (tracking)', budget: false },
];

export const isCreditType = (t: AccountType) => t === 'creditCard' || t === 'lineOfCredit';

export interface Settings extends Base {
  kind: 'settings';
  budgetName: string;
  currency: string;          // shown after amounts, e.g. "MAD"
  symbolFirst: boolean;
  decimal: ',' | '.';
  group: ' ' | '.' | ',' | "'";
  dateFormat: 'dd/mm/yyyy' | 'mm/dd/yyyy' | 'yyyy-mm-dd';
  weekStart: 0 | 1;
  onboarded: boolean;
  lastAccountId?: string;
}

export interface Account extends Base {
  kind: 'account';
  name: string;
  type: AccountType;
  onBudget: boolean;
  closed?: boolean;
  note?: string;
  sort: number;
  /** Names the iOS Wallet automation may send for this account (card names), lower-cased. */
  walletNames?: string[];
}

export interface Group extends Base {
  kind: 'group';
  name: string;
  sort: number;
  hidden?: boolean;
  /** 'cc' = the Credit Card Payments group, managed by the app. */
  system?: 'cc';
  collapsed?: boolean;
}

export type TargetType = 'monthly' | 'weekly' | 'byDate' | 'yearly' | 'balance';

export interface Target {
  type: TargetType;
  amount: number;
  /** monthly/weekly: 'set' = assign this every month, 'refill' = top up to this amount */
  mode?: 'set' | 'refill';
  /** byDate / balance (optional deadline): 'YYYY-MM'; yearly: month number 1-12 */
  date?: string;
  month?: number;
  /** monthly / yearly: due day of month 1-31 (31 = last day) */
  day?: number;
  /** weekly: weekday 0-6 (Sun-Sat) */
  weekday?: number;
  /** byDate ("custom"): repeat every N months after the date passes (0/undefined = no repeat) */
  repeatMonths?: number;
}

export interface Category extends Base {
  kind: 'category';
  groupId: string;
  name: string;
  sort: number;
  hidden?: boolean;
  note?: string;
  target?: Target;
  /** set on Credit Card Payment categories */
  ccAccountId?: string;
  emoji?: string;
}

export interface Payee extends Base {
  kind: 'payee';
  name: string;
  /** remembered category for auto-categorisation */
  categoryId?: string;
  /** alternative spellings that map onto this payee (lower-cased, "contains" match) */
  aliases?: string[];
}

export type Cleared = 'uncleared' | 'cleared' | 'reconciled';
export type Flag = 'red' | 'orange' | 'yellow' | 'green' | 'blue' | 'purple';

/** Special category ids */
export const RTA = 'rta';          // "Ready to Assign" (income)
export const SPLIT = 'split';

export interface Split {
  id: string;
  amount: number;
  categoryId?: string | null;
  memo?: string;
}

export interface Txn extends Base {
  kind: 'txn';
  accountId: string;
  date: string;            // YYYY-MM-DD
  amount: number;          // + inflow, - outflow
  payeeId?: string | null;
  categoryId?: string | null; // RTA, SPLIT, category id, or null
  memo?: string;
  cleared: Cleared;
  approved: boolean;       // false for imported / wallet transactions until reviewed
  flag?: Flag | null;
  /** Transfers: the other account and the paired transaction */
  transferAccountId?: string | null;
  transferTxnId?: string | null;
  splits?: Split[];
  importId?: string;
  source?: 'manual' | 'import' | 'wallet' | 'scheduled' | 'reconcile' | 'start';
}

export interface Assign extends Base {
  kind: 'assign';
  month: string;           // YYYY-MM
  categoryId: string;
  amount: number;
}

export type Frequency = 'once' | 'weekly' | 'every2weeks' | 'twiceMonthly' | 'monthly' | 'every2months' | 'every3months' | 'every6months' | 'yearly';

export interface Scheduled extends Base {
  kind: 'scheduled';
  accountId: string;
  nextDate: string;
  frequency: Frequency;
  amount: number;
  payeeId?: string | null;
  categoryId?: string | null;
  transferAccountId?: string | null;
  memo?: string;
  flag?: Flag | null;
}

/** A stock trade in an investment account (Casablanca Stock Exchange etc.). */
export interface Trade extends Base {
  kind: 'trade';
  accountId: string;
  date: string;
  symbol: string;          // e.g. "IAM", "ATW"
  side: 'buy' | 'sell' | 'dividend';
  quantity: number;        // shares (dividend: 0)
  price: number;           // centimes per share (dividend: total amount)
  fees: number;            // centimes (brokerage + taxes)
  note?: string;
}

/** Latest known price for a symbol, with a short history for charts. id = `p:SYMBOL` */
export interface Price extends Base {
  kind: 'price';
  symbol: string;
  name?: string;
  price: number;           // centimes
  date: string;            // YYYY-MM-DD of the quote
  history?: [string, number][]; // [date, price] newest last, max ~400
}

export type Entity = Settings | Account | Group | Category | Payee | Txn | Assign | Scheduled | Trade | Price;

export const assignId = (month: string, categoryId: string) => `a:${month}:${categoryId}`;
