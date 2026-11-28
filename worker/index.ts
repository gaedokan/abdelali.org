// Cloudflare Worker for abdelali.org.
// The blog is static (assets). Every request under /budget runs this code first, so the whole
// budget app — page, code and data — is behind a login.
//
//   GET  /budget/login          login page
//   POST /budget/api/login      check the passphrase, set a signed session cookie
//   POST /budget/api/logout     end this device's session
//   POST /budget/api/logout-all end every session (all devices)
//   GET  /budget/api/status     is the server configured / is this browser signed in? (no auth)
//   POST /budget/api/sync       two-way sync of budget entities (session cookie)
//   POST /budget/api/wallet     add a transaction from an iOS Shortcut (Bearer token)
//   GET  /budget/*              the app itself (session cookie, otherwise redirect to login)
//
// Secrets (Cloudflare dashboard → Workers & Pages → abdelali-site → Settings → Variables and Secrets):
//   BUDGET_PASSWORD       required — your passphrase
//   BUDGET_SESSION_KEY    optional — signs session cookies (defaults to a key derived from the passphrase,
//                         so changing the passphrase also signs everyone out)
//   BUDGET_WALLET_TOKEN   optional — a token that can only add transactions (for the Shortcut)

interface Env {
  ASSETS: { fetch(req: Request): Promise<Response> };
  BUDGET_DB?: D1Database;
  BUDGET_PASSWORD?: string;
  BUDGET_SESSION_KEY?: string;
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

const NO_STORE = { 'cache-control': 'no-store' };
const json = (data: unknown, status = 200, headers: Record<string, string> = {}) =>
  new Response(JSON.stringify(data), { status, headers: { 'content-type': 'application/json; charset=utf-8', ...NO_STORE, ...headers } });

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
    db.prepare('CREATE TABLE IF NOT EXISTS budget_meta (key TEXT PRIMARY KEY, value INTEGER NOT NULL)'),
    db.prepare('CREATE TABLE IF NOT EXISTS budget_login_attempts (ip TEXT PRIMARY KEY, fails INTEGER NOT NULL, locked_until INTEGER NOT NULL, last INTEGER NOT NULL)'),
  ]);
  schemaReady = true;
}

// ------------------------------------------------------------------ crypto helpers

const enc = new TextEncoder();
async function sha(s: string) {
  return new Uint8Array(await crypto.subtle.digest('SHA-256', enc.encode(s)));
}
async function safeEqual(a: string, b: string) {
  const [x, y] = await Promise.all([sha(a), sha(b)]);
  let diff = 0;
  for (let i = 0; i < x.length; i++) diff |= x[i] ^ y[i];
  return diff === 0;
}
const b64url = (buf: ArrayBuffer) => btoa(String.fromCharCode(...new Uint8Array(buf))).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
async function hmac(key: string, data: string) {
  const k = await crypto.subtle.importKey('raw', enc.encode(key), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  return b64url(await crypto.subtle.sign('HMAC', k, enc.encode(data)));
}
const sessionKey = (env: Env) => env.BUDGET_SESSION_KEY || `session-v1:${env.BUDGET_PASSWORD}`;

async function bearerOk(req: Request, ...secrets: (string | undefined)[]) {
  const token = (req.headers.get('authorization') ?? '').replace(/^Bearer\s+/i, '').trim();
  if (!token) return false;
  for (const s of secrets) if (s && (await safeEqual(token, s))) return true;
  return false;
}

// ------------------------------------------------------------------ sessions

const COOKIE = '__Host-budget_session';
const SESSION_DAYS = 30;
let epochCache: { value: number; at: number } | null = null;

async function getEpoch(db: D1Database): Promise<number> {
  if (epochCache && Date.now() - epochCache.at < 15_000) return epochCache.value;
  const row = await db.prepare("SELECT value FROM budget_meta WHERE key = 'session_epoch'").first<{ value: number }>();
  epochCache = { value: row?.value ?? 1, at: Date.now() };
  return epochCache.value;
}

async function newSession(env: Env): Promise<string> {
  const epoch = await getEpoch(env.BUDGET_DB!);
  const exp = Date.now() + SESSION_DAYS * 86400_000;
  const payload = `${epoch}.${exp}`;
  return `v1.${payload}.${await hmac(sessionKey(env), payload)}`;
}

async function hasSession(req: Request, env: Env): Promise<boolean> {
  const m = (req.headers.get('cookie') ?? '').match(new RegExp(`(?:^|;\\s*)${COOKIE}=([^;]+)`));
  if (!m) return false;
  const [v, epoch, exp, sig] = m[1].split('.');
  if (v !== 'v1' || !epoch || !exp || !sig) return false;
  if (Number(exp) < Date.now()) return false;
  if (!(await safeEqual(sig, await hmac(sessionKey(env), `${epoch}.${exp}`)))) return false;
  return Number(epoch) === (await getEpoch(env.BUDGET_DB!));
}

const sessionCookie = (value: string, maxAge: number) =>
  `${COOKIE}=${value}; Path=/; Max-Age=${maxAge}; HttpOnly; Secure; SameSite=Lax`;

/** Cookie-authenticated writes must come from our own pages (CSRF protection on top of SameSite). */
function sameOrigin(req: Request, url: URL) {
  const origin = req.headers.get('origin');
  if (origin) return origin === url.origin;
  const site = req.headers.get('sec-fetch-site');
  return !site || site === 'same-origin' || site === 'none';
}

// ------------------------------------------------------------------ brute-force protection

const MAX_FAILS = 5;
const clientIp = (req: Request) => req.headers.get('cf-connecting-ip') || req.headers.get('x-forwarded-for') || 'local';

/** Seconds until this IP may try again, or 0. */
async function lockedFor(db: D1Database, key: string): Promise<number> {
  const row = await db.prepare('SELECT locked_until FROM budget_login_attempts WHERE ip = ?').bind(key).first<{ locked_until: number }>();
  return row && row.locked_until > Date.now() ? Math.ceil((row.locked_until - Date.now()) / 1000) : 0;
}

/** Record a failure; every 5th failure locks the IP: 15 min, then 30, 60… up to 24 h. */
async function recordFail(db: D1Database, key: string): Promise<number> {
  const row = await db.prepare('SELECT fails FROM budget_login_attempts WHERE ip = ?').bind(key).first<{ fails: number }>();
  const fails = (row?.fails ?? 0) + 1;
  let lockedUntil = 0;
  if (fails % MAX_FAILS === 0) {
    const minutes = Math.min(24 * 60, 15 * 2 ** (fails / MAX_FAILS - 1));
    lockedUntil = Date.now() + minutes * 60_000;
  }
  await db.prepare(`INSERT INTO budget_login_attempts (ip, fails, locked_until, last) VALUES (?1, ?2, ?3, ?4)
    ON CONFLICT(ip) DO UPDATE SET fails = ?2, locked_until = ?3, last = ?4`).bind(key, fails, lockedUntil, Date.now()).run();
  return lockedUntil ? Math.ceil((lockedUntil - Date.now()) / 1000) : 0;
}
const clearFails = (db: D1Database, key: string) => db.prepare('DELETE FROM budget_login_attempts WHERE ip = ?').bind(key).run();

// ------------------------------------------------------------------ router

export default {
  async fetch(req: Request, env: Env): Promise<Response> {
    const url = new URL(req.url);
    const path = url.pathname;
    if (path !== '/budget' && !path.startsWith('/budget/')) return env.ASSETS.fetch(req);

    const configured = !!(env.BUDGET_DB && env.BUDGET_PASSWORD);
    if (!configured) {
      // fail closed: nothing under /budget is served until a passphrase exists
      if (path === '/budget/api/status') return json({ configured: false, authenticated: false });
      return path.startsWith('/budget/api/')
        ? json({ error: 'The budget app is not configured yet (BUDGET_DB binding and BUDGET_PASSWORD secret).' }, 503)
        : html(setupPage(), 503);
    }

    try {
      const db = env.BUDGET_DB!;
      await ensureSchema(db);

      if (path === '/budget/login' || path === '/budget/login/') {
        if (req.method === 'GET') return (await hasSession(req, env)) ? redirect(safeNext(url.searchParams.get('next'))) : html(loginPage({ next: url.searchParams.get('next') }));
        return login(req, env, url);
      }

      if (path.startsWith('/budget/api/')) {
        const route = path.slice('/budget/api/'.length).replace(/\/$/, '');
        if (route === 'status') return json({ configured: true, authenticated: await hasSession(req, env) });
        if (route === 'login' && req.method === 'POST') return login(req, env, url);
        if (route === 'wallet' && req.method === 'POST') {
          const key = 'wallet:' + clientIp(req);
          const wait = await lockedFor(db, key);
          if (wait) return json({ error: 'Too many attempts', message: `Locked for ${Math.ceil(wait / 60)} min` }, 429, { 'retry-after': String(wait) });
          if (!(await bearerOk(req, env.BUDGET_PASSWORD, env.BUDGET_WALLET_TOKEN))) {
            await recordFail(db, key);
            return json({ error: 'Wrong token', message: 'Wrong token' }, 401);
          }
          await clearFails(db, key);
          return await wallet(req, env);
        }
        if (route === 'logout' && req.method === 'POST') {
          return json({ ok: true }, 200, { 'set-cookie': sessionCookie('', 0) });
        }

        // everything else needs a session (or the passphrase as a Bearer token, for scripts)
        const viaCookie = await hasSession(req, env);
        if (!viaCookie && !(await bearerOk(req, env.BUDGET_PASSWORD))) return json({ error: 'Signed out' }, 401);
        if (viaCookie && req.method !== 'GET' && !sameOrigin(req, url)) return json({ error: 'Cross-site request refused' }, 403);

        if (route === 'logout-all' && req.method === 'POST') {
          await db.prepare(`INSERT INTO budget_meta (key, value) VALUES ('session_epoch', 2)
            ON CONFLICT(key) DO UPDATE SET value = value + 1`).run();
          epochCache = null;
          return json({ ok: true }, 200, { 'set-cookie': sessionCookie('', 0) });
        }
        if (route === 'sync' && req.method === 'POST') return await sync(req, db);
        return json({ error: 'Not found' }, 404);
      }

      // the app itself
      if (!(await hasSession(req, env))) {
        const wantsHtml = req.method === 'GET' && (req.headers.get('accept') ?? '').includes('text/html');
        if (wantsHtml) return redirect('/budget/login?next=' + encodeURIComponent(path + url.search));
        return new Response('Sign in required', { status: 401, headers: NO_STORE });
      }
      const res = await env.ASSETS.fetch(req);
      const out = new Response(res.body, res);
      out.headers.set('cache-control', out.headers.get('content-type')?.includes('text/html') ? 'no-store' : out.headers.get('cache-control') ?? 'private');
      out.headers.set('x-robots-tag', 'noindex, nofollow');
      out.headers.set('referrer-policy', 'same-origin');
      out.headers.set('x-frame-options', 'DENY');
      return out;
    } catch (e) {
      console.error(e);
      return json({ error: 'Server error' }, 500);
    }
  },
};

function safeNext(n: string | null): string {
  return n && /^\/budget(\/[^\s]*)?$/.test(n) && !n.startsWith('//') ? n : '/budget/';
}
const redirect = (to: string, headers: Record<string, string> = {}) => new Response(null, { status: 303, headers: { location: to, ...NO_STORE, ...headers } });

async function login(req: Request, env: Env, url: URL): Promise<Response> {
  const db = env.BUDGET_DB!;
  const isForm = (req.headers.get('content-type') ?? '').includes('form');
  let password = '', next: string | null = null;
  if (isForm) {
    const f = await req.formData();
    password = String(f.get('password') ?? '');
    next = f.get('next') ? String(f.get('next')) : null;
  } else {
    try { const j = (await req.json()) as { password?: string }; password = String(j.password ?? ''); } catch { /* empty */ }
  }
  if (!sameOrigin(req, url)) return isForm ? html(loginPage({ next, error: 'Please try again.' }), 403) : json({ error: 'Cross-site request refused' }, 403);

  const key = 'login:' + clientIp(req);
  let wait = await lockedFor(db, key);
  if (!wait) {
    if (password && (await safeEqual(password, env.BUDGET_PASSWORD!))) {
      await clearFails(db, key);
      const cookie = sessionCookie(await newSession(env), SESSION_DAYS * 86400);
      return isForm ? redirect(safeNext(next), { 'set-cookie': cookie }) : json({ ok: true }, 200, { 'set-cookie': cookie });
    }
    wait = await recordFail(db, key);
    // slow down guessing a little even before the lockout
    await new Promise((r) => setTimeout(r, 600));
  }
  const error = wait ? `Too many attempts. Try again in ${Math.ceil(wait / 60)} minute${wait > 60 ? 's' : ''}.` : 'That passphrase isn’t right.';
  return isForm ? html(loginPage({ next, error }), wait ? 429 : 401) : json({ error }, wait ? 429 : 401);
}

// ------------------------------------------------------------------ pages

const html = (body: string, status = 200) =>
  new Response(body, { status, headers: { 'content-type': 'text/html; charset=utf-8', ...NO_STORE, 'x-robots-tag': 'noindex, nofollow', 'x-frame-options': 'DENY', 'referrer-policy': 'same-origin' } });
const escHtml = (s: string) => s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!);

function shell(title: string, inner: string) {
  return `<!doctype html><html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover">
<meta name="robots" content="noindex, nofollow"><meta name="theme-color" content="#1c2b27">
<meta name="apple-mobile-web-app-capable" content="yes"><meta name="apple-mobile-web-app-title" content="Envelope">
<title>${title}</title>
<style>
:root{--bg:#f6f4ef;--card:#fff;--ink:#1d1b18;--ink2:#5f5a52;--line:#d9d2c6;--accent:#0f6b5c;--accent2:#0b5649;--soft:#dcefe9;--neg:#ad2a20;--negsoft:#f9dedb;color-scheme:light}
@media (prefers-color-scheme:dark){:root{--bg:#121412;--card:#1a1d1b;--ink:#ecefeb;--ink2:#a9b0aa;--line:#363c38;--accent:#4cc2a8;--accent2:#7ad6c1;--soft:#173a33;--neg:#f27a6f;--negsoft:#401f1c;color-scheme:dark}}
@supports (font:-apple-system-body){html{font:-apple-system-body}}
*{box-sizing:border-box}
body{margin:0;min-height:100dvh;display:grid;place-items:center;background:var(--bg);color:var(--ink);font-family:ui-sans-serif,system-ui,-apple-system,"Segoe UI",sans-serif;
  padding:max(24px,env(safe-area-inset-top)) max(16px,env(safe-area-inset-right)) max(24px,env(safe-area-inset-bottom)) max(16px,env(safe-area-inset-left))}
main{width:min(400px,100%);background:var(--card);border:1px solid var(--line);border-radius:20px;padding:28px 24px}
.logo{width:52px;height:52px;border-radius:15px;background:#1c2b27;display:grid;place-items:center;margin-bottom:18px}
h1{font-size:1.6rem;margin:0 0 6px;letter-spacing:-.02em}
p{margin:0 0 20px;color:var(--ink2);line-height:1.5}
label{display:block;font-weight:600;font-size:.95rem;margin-bottom:8px}
input{width:100%;min-height:50px;font-size:max(16px,1.05rem);padding:10px 14px;border-radius:12px;border:1.5px solid var(--line);background:var(--card);color:var(--ink)}
input:focus{outline:none;border-color:var(--accent);box-shadow:0 0 0 4px var(--soft)}
button{width:100%;min-height:50px;margin-top:16px;border:0;border-radius:999px;background:var(--accent);color:#fff;font-size:1.05rem;font-weight:650;cursor:pointer}
@media (prefers-color-scheme:dark){button{color:#08201b}}
button:hover{background:var(--accent2)}
:focus-visible{outline:3px solid var(--accent);outline-offset:3px}
.err{background:var(--negsoft);color:var(--neg);border-radius:12px;padding:10px 14px;margin:0 0 16px;font-weight:600}
.show{display:flex;gap:8px;align-items:center;margin-top:12px;font-weight:500;color:var(--ink2)}
.show input{width:22px;min-height:22px;height:22px}
@media (prefers-contrast:more){:root{--ink2:var(--ink);--line:var(--ink)}}
</style></head><body><main>
<div class="logo" aria-hidden="true"><svg viewBox="0 0 32 32" width="30" height="30"><rect x="3" y="7" width="26" height="19" rx="5" fill="none" stroke="#7fd8c2" stroke-width="2.4"/><path d="M3 12l13 8 13-8" fill="none" stroke="#7fd8c2" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round"/></svg></div>
${inner}</main></body></html>`;
}

function loginPage(o: { next?: string | null; error?: string }) {
  return shell('Sign in · Envelope', `
<h1>Envelope</h1>
<p>This budget is private. Enter your passphrase to continue.</p>
${o.error ? `<div class="err" role="alert">${escHtml(o.error)}</div>` : ''}
<form method="post" action="/budget/login">
  <input type="hidden" name="next" value="${escHtml(safeNext(o.next ?? null))}">
  <label for="pw">Passphrase</label>
  <input id="pw" name="password" type="password" autocomplete="current-password" autocapitalize="off" autocorrect="off" spellcheck="false" enterkeyhint="go" required autofocus>
  <label class="show"><input type="checkbox" onclick="document.getElementById('pw').type=this.checked?'text':'password'"> Show passphrase</label>
  <button type="submit">Sign in</button>
</form>`);
}

function setupPage() {
  return shell('Envelope', `<h1>Not set up yet</h1><p>Add the <b>BUDGET_PASSWORD</b> secret to the Worker in Cloudflare (Workers &amp; Pages → abdelali-site → Settings → Variables and Secrets), then reload.</p>`);
}

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
