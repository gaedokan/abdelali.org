# Envelope — personal budget app

Zero-based budgeting (every dirham gets a job), built with Angular 22 as an installable, offline-first PWA.
It is served at **`/budget/`** on abdelali.org and syncs through the site's Cloudflare Worker + D1.

## What's inside

| Area | Features |
| --- | --- |
| Budget | Ready to Assign, assigned / activity / available per category, rollover, cash vs credit overspending, move money (dialog or drag & drop), targets (monthly, weekly, by date, yearly, balance) with progress rings, **Fund targets** preview, quick-assign strategies, hidden categories, reorder by drag, notes, emoji icons, age of money & days of buffer |
| Accounts | Checking, savings, cash, credit cards (automatic payment categories), tracking accounts (assets, loans, stocks); register with running balance, inline editing, splits, transfers, cleared/reconciled, flags, bulk actions, search, reconcile with adjustment, ATM withdrawal for cash |
| Entry | Quick add in plain words (`Marjane 245 groceries`, `+15000 salary`, `taxi 30 @cash yesterday`), ⌘K command palette, scheduled/recurring transactions, payee memory (auto-category), payee rename/merge |
| iPhone | Apple Wallet automation → `POST /budget/api/wallet` logs each card payment automatically; `#/add?amount=…&payee=…` deep link for cash |
| Import / export | CSV (any bank, French headers, YNAB register export), OFX/QFX, duplicate detection & matching; JSON backup/restore, CSV export |
| Investments | Casablanca Stock Exchange portfolio: trades, dividends, average cost, realised/unrealised P/L, prices (manual or pasted), allocation & value charts, net worth kept in sync |
| Reports | Spending breakdown, income vs expense, net worth, insights |

## Develop

```sh
cd budget
npm install
npm start          # http://localhost:4300 (data stays in the browser; sync needs the worker)
npm test           # unit tests (vitest)
```

From the repo root, `npm run build` builds the blog **and** this app into `dist/`, and `npm run dev` serves both with the Worker (`wrangler dev`).

## Turn on sync (one time)

1. In `wrangler.jsonc`, uncomment `d1_databases` and fill in your existing database's `database_name` and `database_id`
   (Cloudflare dashboard → Storage & Databases → D1). The worker creates one table, `budget_items`, and touches nothing else.
2. Set the password: `npx wrangler secret put BUDGET_PASSWORD` (or Workers & Pages → abdelali-site → Settings → Variables and Secrets).
   Use a long random passphrase: it protects all budget data.
3. Optional: `npx wrangler secret put BUDGET_WALLET_TOKEN` — a second token that can only *add* transactions, for the iPhone shortcut.
4. Deploy, open `/budget/` → Settings → *Sync across devices*, enter the password. Do the same on your phone.

## iPhone: log Apple Wallet payments automatically

Shortcuts → Automation → **+** → **Transaction** → pick cards → *Run Immediately* → add **Get Contents of URL**:

- URL `https://abdelali.org/budget/api/wallet`, method **POST**
- Header `Authorization: Bearer <BUDGET_WALLET_TOKEN or BUDGET_PASSWORD>`
- JSON body: `amount` = Amount, `merchant` = Merchant, `card` = Card name (optional: `memo`, `date` as YYYY-MM-DD, `inflow: true` for refunds)

The response has a `message` (e.g. “Spent 45,00 MAD at Carrefour → Groceries · CIH Visa”) you can show with **Show Notification**.
Transactions arrive unapproved with a *Wallet* badge, categorised from the payee's last category. Map cards to accounts in *Edit account → iPhone Wallet card names*.
