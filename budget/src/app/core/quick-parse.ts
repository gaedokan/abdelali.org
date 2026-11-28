// Natural-language quick entry: "coffee 18", "carrefour 245,50 groceries", "+12000 salary @cih",
// "taxi 40 yesterday", "rent 4500 bills 01/12". Pure function so it is easy to test.

import { Account, Category, Payee } from './models';
import { parseMoney } from './money';
import { DateFormat, fuzzy, norm, parseDate, today } from './util';

export interface QuickResult {
  amount: number | null;     // signed centimes (outflow negative)
  payee: string;
  payeeId?: string;
  categoryId?: string | null;
  categoryGuessed?: boolean;
  accountId?: string;
  date: string;
  memo?: string;
}

export function parseQuick(
  text: string,
  ctx: { categories: Category[]; accounts: Account[]; payees: Payee[]; defaultAccountId?: string; dateFormat?: DateFormat },
): QuickResult {
  let s = ` ${text.trim()} `;
  const res: QuickResult = { amount: null, payee: '', date: today() };

  // memo in quotes
  const memo = s.match(/"([^"]*)"/);
  if (memo) { res.memo = memo[1]; s = s.replace(memo[0], ' '); }

  // @account
  const acc = s.match(/\s@(\S+)/);
  if (acc) {
    const best = bestBy(ctx.accounts.filter((a) => !a.closed), (a) => a.name, acc[1]);
    if (best) res.accountId = best.id;
    s = s.replace(acc[0], ' ');
  }

  // #category (explicit)
  const hash = s.match(/\s#(\S+)/);
  let explicitCategory: string | undefined;
  if (hash) { explicitCategory = hash[1]; s = s.replace(hash[0], ' '); }

  let tokens = s.trim().split(/\s+/).filter(Boolean);

  // date words / numbers
  tokens = tokens.filter((t) => {
    if (/^(today|yesterday|hier|aujourd'hui)$/i.test(t) || /^\d{1,2}[/.]\d{1,2}([/.]\d{2,4})?$/.test(t) || /^\d{4}-\d{2}-\d{2}$/.test(t)) {
      const d = parseDate(t, ctx.dateFormat);
      if (d) { res.date = d; return false; }
    }
    return true;
  });

  // amount: first numeric token (may carry + for inflow)
  const ai = tokens.findIndex((t) => /^[+-]?\d[\d.,]*(dh|mad)?$/i.test(t) || /^[+-]?\d[\d.,]*[+\-*/]\d/.test(t));
  if (ai >= 0) {
    const raw = tokens[ai];
    const v = parseMoney(raw.replace(/^\+/, ''));
    if (v !== null) res.amount = raw.startsWith('+') ? Math.abs(v) : -Math.abs(v);
    tokens.splice(ai, 1);
    // words after the amount are the category hint, words before are the payee
    const before = tokens.slice(0, ai), after = tokens.slice(ai);
    if (!explicitCategory && after.length) {
      const hint = after.join(' ');
      const cat = bestCategory(ctx.categories, hint);
      if (cat) { res.categoryId = cat.id; tokens = before; }
      else tokens = [...before, ...after];
    } else tokens = before.concat(after);
  }

  if (explicitCategory) {
    const cat = bestCategory(ctx.categories, explicitCategory);
    if (cat) res.categoryId = cat.id;
  }

  res.payee = tokens.join(' ').trim();
  if (res.payee) {
    const n = norm(res.payee);
    const p = ctx.payees.find((p) => norm(p.name) === n) ?? ctx.payees.find((p) => p.aliases?.some((a) => a && n.includes(a)));
    if (p) {
      res.payeeId = p.id;
      res.payee = p.name;
      if (!res.categoryId && p.categoryId) { res.categoryId = p.categoryId; res.categoryGuessed = true; }
    }
  }
  if (!res.accountId) res.accountId = ctx.defaultAccountId ?? ctx.accounts.find((a) => a.onBudget && !a.closed)?.id;
  return res;
}

function bestBy<T>(items: T[], name: (t: T) => string, q: string): T | undefined {
  let best: T | undefined, score = 0;
  for (const it of items) {
    const sc = fuzzy(q, name(it));
    if (sc > score) { score = sc; best = it; }
  }
  return score >= 20 ? best : undefined;
}

function bestCategory(cats: Category[], q: string) {
  return bestBy(cats.filter((c) => !c.ccAccountId && !c.hidden), (c) => c.name, q);
}
