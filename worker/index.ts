// Cloudflare Worker for abdelali.org.
// Static files are served straight from dist/ (assets). Only /budget/api/* reaches this code.
//
//   POST /budget/api/sync     two-way sync of budget entities (app ↔ D1)
//   POST /budget/api/wallet   add a transaction from an iOS Shortcut (Wallet "Transaction" automation)
//   GET  /budget/api/status   is sync configured? (no auth)
//
// Secrets (set with `npx wrangler secret put NAME` or in the Cloudflare dashboard):
//   BUDGET_PASSWORD       required — the app and the Shortcut authenticate with it
//   BUDGET_WALLET_TOKEN   optional — a separate token that can only add transactions (for the Shortcut)

interface Env {
  ASSETS: { fetch(req: Request): Promise<Response> };
  BUDGET_DB?: D1Database;
  BUDGET_PASSWORD?: string;
  BUDGET_WALLET_TOKEN?: string;
  BUDGET_TIMEZONE?: string;
}

// Minimal D1 typings (avoids a dependency on @cloudflare/workers-types).
interface D1Result<T> { results: T[] }
interface D1PreparedStatement {
  bind(...values: unknown[]): D1PreparedStatement;
  all<T = Record<string, unknown>>(): Promise<D1Result<T>>;
  first<T = Record<string, unknown>>(): Promise<T | null>;
  run(): Promise<unknown>;
}
interface D1Database {
  prepare(sql: string): D1PreparedStatement;
  batch(statements: D1PreparedStatement[]): Promise<unknown[]>;
  exec(sql: string): Promise<unknown>;
}

interface Item { id: string; kind: string; updatedAt: number; deleted?: boolean; [k: string]: unknown }

const json = (data: unknown, status = 200) =>
  new Response(JSON.stringify(data), {
    status,
    headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' },
  });

let schemaReady = false;
async function ensureSchema(db: D1Database) {
  if (schemaReady) return;
  await db.batch([
    db.prepare(`CREATE TABLE IF NOT EXISTS budget_items (
      id TEXT PRIMARY KEY,
      kind TEXT NOT NULL,
      updated_at INTEGER NOT NULL,
      deleted INTEGER NOT NULL DEFAULT 0,
      seq INTEGER NOT NULL,
      data TEXT NOT NULL
    )`),
    db.prepare('CREATE INDEX IF NOT EXISTS budget_items_seq ON budget_items(seq)'),
    db.prepare('CREATE INDEX IF NOT EXISTS budget_items_kind ON budget_items(kind)'),
  ]);
  schemaReady = true;
}

async function sha(s: string) {
  return new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(s)));
}
async function safeEqual(a: string, b: string) {
  const [x, y] = await Promise.all([sha(a), sha(b)]);
  let diff = 0;
  for (let i = 0; i < x.length; i++) diff |= x[i] ^ y[i];
  return diff === 0;
}
async function authorised(req: Request, ...secrets: (string | undefined)[]) {
  const token = (req.headers.get('authorization') ?? '').replace(/^Bearer\s+/i, '').trim();
  if (!token) return false;
  for (const s of secrets) if (s && (await safeEqual(token, s))) return true;
  return false;
}

export default {
  async fetch(req: Request, env: Env): Promise<Response> {
    const url = new URL(req.url);
    if (!url.pathname.startsWith('/budget/api/')) return env.ASSETS.fetch(req);
    const route = url.pathname.slice('/budget/api/'.length).replace(/\/$/, '');

    if (route === 'status') {
      return json({ configured: !!(env.BUDGET_DB && env.BUDGET_PASSWORD), database: !!env.BUDGET_DB, password: !!env.BUDGET_PASSWORD });
    }
    if (!env.BUDGET_DB || !env.BUDGET_PASSWORD) {
      return json({ error: 'Sync is not configured on the server (missing D1 binding BUDGET_DB or secret BUDGET_PASSWORD).' }, 503);
    }
    try {
      await ensureSchema(env.BUDGET_DB);
      if (route === 'sync' && req.method === 'POST') {
        if (!(await authorised(req, env.BUDGET_PASSWORD))) return json({ error: 'Wrong password' }, 401);
        return await sync(req, env.BUDGET_DB);
      }
      if (route === 'wallet' && req.method === 'POST') {
        if (!(await authorised(req, env.BUDGET_PASSWORD, env.BUDGET_WALLET_TOKEN))) return json({ error: 'Wrong token' }, 401);
        return await wallet(req, env);
      }
      return json({ error: 'Not found' }, 404);
    } catch (e) {
      console.error(e);
      return json({ error: 'Server error' }, 500);
    }
  },
};

// ------------------------------------------------------------------ sync

const MAX_PUSH = 500;
const PULL_PAGE = 1000;

async function sync(req: Request, db: D1Database) {
  const body = (await req.json()) as { cursor?: number; items?: Item[] };
  const cursor = Number(body.cursor) || 0;
  const items = (body.items ?? []).slice(0, MAX_PUSH).filter(validItem);
  if (items.length) await upsert(db, items);
  const rows = await db
    .prepare('SELECT seq, data FROM budget_items WHERE seq > ? ORDER BY seq LIMIT ?')
    .bind(cursor, PULL_PAGE + 1)
    .all<{ seq: number; data: string }>();
  const page = rows.results.slice(0, PULL_PAGE);
  return json({
    items: page.map((r) => JSON.parse(r.data)),
    cursor: page.length ? page[page.length - 1].seq : cursor,
    hasMore: rows.results.length > PULL_PAGE,
    accepted: items.map((i) => i.id),
  });
}

function validItem(i: Item) {
  return i && typeof i.id === 'string' && i.id.length <= 200 && typeof i.kind === 'string' && typeof i.updatedAt === 'number';
}

/** Insert or update; the newer updatedAt wins. Each write gets the next sequence number. */
async function upsert(db: D1Database, items: Item[]) {
  const stmt = db.prepare(`
    INSERT INTO budget_items (id, kind, updated_at, deleted, seq, data)
    VALUES (?1, ?2, ?3, ?4, (SELECT COALESCE(MAX(seq), 0) + 1 FROM budget_items), ?5)
    ON CONFLICT(id) DO UPDATE SET
      kind = excluded.kind, updated_at = excluded.updated_at, deleted = excluded.deleted,
      seq = (SELECT COALESCE(MAX(seq), 0) + 1 FROM budget_items), data = excluded.data
    WHERE excluded.updated_at > budget_items.updated_at`);
  await db.batch(items.map((i) => stmt.bind(i.id, i.kind, i.updatedAt, i.deleted ? 1 : 0, JSON.stringify(i))));
}

// ------------------------------------------------------------------ wallet (iOS Shortcuts)

const norm = (s: string) =>
  s.toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/[^\p{L}\p{N}\s]/gu, ' ').replace(/\s+/g, ' ').trim();

/** "MAD 1 234,50", "1.234,50 DH", "45.00", 45 → centimes (always positive) */
export function parseAmount(v: unknown): number | null {
  if (typeof v === 'number') return Math.round(Math.abs(v) * 100);
  if (typeof v !== 'string') return null;
  const s = v.replace(/[^\d.,]/g, '');
  if (!s) return null;
  const lastDot = s.lastIndexOf('.'), lastComma = s.lastIndexOf(',');
  const decPos = Math.max(lastDot, lastComma);
  let n: number;
  if (decPos >= 0 && s.length - decPos - 1 <= 2) {
    n = Number(s.slice(0, decPos).replace(/[.,]/g, '') + '.' + s.slice(decPos + 1));
  } else {
    n = Number(s.replace(/[.,]/g, ''));
  }
  return isFinite(n) ? Math.round(n * 100) : null;
}

function localDate(tz: string) {
  const parts = new Intl.DateTimeFormat('en-CA', { timeZone: tz, year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date());
  return parts; // YYYY-MM-DD
}

async function loadKind(db: D1Database, kind: string): Promise<Item[]> {
  const rows = await db.prepare('SELECT data FROM budget_items WHERE kind = ? AND deleted = 0').bind(kind).all<{ data: string }>();
  return rows.results.map((r) => JSON.parse(r.data));
}

async function wallet(req: Request, env: Env) {
  const db = env.BUDGET_DB!;
  const ct = req.headers.get('content-type') ?? '';
  let body: Record<string, unknown> = {};
  if (ct.includes('application/json')) body = (await req.json()) as Record<string, unknown>;
  else if (ct.includes('form')) body = Object.fromEntries((await req.formData()).entries());
  else { try { body = JSON.parse(await req.text()); } catch { body = {}; } }

  const amount = parseAmount(body['amount']);
  if (!amount) return json({ error: 'Missing or invalid "amount"', message: 'Could not read the amount' }, 400);
  const merchant = String(body['merchant'] ?? body['payee'] ?? body['name'] ?? '').trim() || 'Card payment';
  const card = String(body['card'] ?? body['account'] ?? '').trim();
  const inflow = body['inflow'] === true || body['inflow'] === 'true' || /refund|credit|remboursement/i.test(String(body['type'] ?? ''));
  const tz = env.BUDGET_TIMEZONE || 'Africa/Casablanca';
  const date = /^\d{4}-\d{2}-\d{2}$/.test(String(body['date'] ?? '')) ? String(body['date']) : localDate(tz);

  const [accounts, payees, categories, settingsRow] = await Promise.all([
    loadKind(db, 'account'), loadKind(db, 'payee'), loadKind(db, 'category'),
    db.prepare("SELECT data FROM budget_items WHERE id = 'settings'").first<{ data: string }>(),
  ]);
  const settings = settingsRow ? JSON.parse(settingsRow.data) : {};
  const open = accounts.filter((a) => !a['closed']);
  if (!open.length) return json({ error: 'No accounts yet', message: 'Create an account in the app first' }, 409);

  // account: explicit wallet names, then name match, then the last account used in the app
  const c = norm(card);
  const account =
    (c && open.find((a) => ((a['walletNames'] as string[] | undefined) ?? []).some((w) => w && (c.includes(norm(w)) || norm(w).includes(c))))) ||
    (c && open.find((a) => norm(String(a['name'])) === c)) ||
    (c && open.find((a) => c.includes(norm(String(a['name']))) || norm(String(a['name'])).includes(c))) ||
    open.find((a) => a.id === settings['lastAccountId']) ||
    open.find((a) => a['onBudget']) || open[0];

  // payee: exact name, then alias "contains" match, else a new payee
  const m = norm(merchant);
  let payee = payees.find((p) => norm(String(p['name'])) === m)
    ?? payees.find((p) => ((p['aliases'] as string[] | undefined) ?? []).some((a) => a && m.includes(a)));
  const now = Date.now();
  const writes: Item[] = [];
  if (!payee) {
    payee = { id: crypto.randomUUID(), kind: 'payee', updatedAt: now, name: merchant };
    writes.push(payee);
  }
  const categoryId = account['onBudget'] && payee['categoryId'] && categories.some((x) => x.id === payee!['categoryId'])
    ? (payee['categoryId'] as string) : null;
  const txn: Item = {
    id: crypto.randomUUID(), kind: 'txn', updatedAt: now, accountId: account.id, date,
    amount: inflow ? amount : -amount, payeeId: payee.id, categoryId,
    memo: String(body['memo'] ?? ''), cleared: 'uncleared', approved: false, flag: null,
    transferAccountId: null, transferTxnId: null, source: 'wallet',
  };
  writes.push(txn);
  await upsert(db, writes);

  const category = categories.find((x) => x.id === categoryId);
  const fmt = (n: number) => (n / 100).toFixed(2).replace('.', ',') + ' ' + (settings['currency'] || 'MAD');
  return json({
    ok: true,
    id: txn.id,
    message: `${inflow ? 'Received' : 'Spent'} ${fmt(amount)} at ${payee['name']}${category ? ` → ${category['name']}` : ' (needs a category)'} · ${account['name']}`,
  });
}
