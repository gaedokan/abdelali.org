import { ChangeDetectionStrategy, Component, computed, effect, inject, input, output, signal, untracked } from '@angular/core';
import { Actions } from '../../core/actions';
import { RTA } from '../../core/models';
import { Store } from '../../core/store';
import { norm } from '../../core/util';
import { Combo } from '../../ui/combo';
import { Icon } from '../../ui/icon';
import { DatePipe, MoneyPipe } from '../../ui/money.pipe';
import { Pickers } from '../../ui/pickers';
import { Sheet } from '../../ui/sheet';
import { Toasts } from '../../ui/toast';
import {
  AmountMode, DateFmt, guessMapping, looksLikeHeader, looksLikeOfx, Mapping, ofxToRows, parseCsv, parseOfx,
  ParsedRow, rowsToTxns,
} from './parsers';

type Step = 'file' | 'map' | 'review';
type Status = 'new' | 'dup' | 'match';
type RoleKey = 'date' | 'payee' | 'memo' | 'amount' | 'outflow' | 'inflow';

interface Item { row: ParsedRow; accountId: string | null; accountName: string; status: Status; matchId?: string; catId: string | null; newCat: string }

@Component({
  selector: 'app-import-dialog',
  imports: [Sheet, Combo, Icon, MoneyPipe, DatePipe],
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <app-sheet [open]="open()" title="Import transactions" [wide]="true" (closed)="close()">
      @switch (step()) {
        @case ('file') {
          <div class="drop" [class.over]="over()" (dragover)="$event.preventDefault(); over.set(true)" (dragleave)="over.set(false)" (drop)="onDrop($event)">
            <app-icon name="upload" [size]="28" />
            <p><strong>Drop a bank file here</strong><br /><span class="muted">CSV, OFX, QFX or a YNAB register export</span></p>
            <label class="btn primary">
              Choose file
              <input type="file" accept=".csv,.ofx,.qfx,.txt,text/csv" hidden (change)="onPick($event)" />
            </label>
          </div>
          <div class="or muted">or paste CSV</div>
          <textarea class="input paste" rows="5" placeholder="Date;Libellé;Débit;Crédit&#10;25/11/2026;CARTE MARJANE;350,50;" [value]="pasted()" (input)="pasted.set($any($event.target).value)"></textarea>
          @if (error()) { <p class="err">{{ error() }}</p> }
        }
        @case ('map') {
          <p class="muted file">{{ fileName() }} · {{ table().length }} rows</p>
          <label class="check"><input type="checkbox" [checked]="hasHeader()" (change)="setHeader($any($event.target).checked)" /> First row is a header</label>
          @if (map().kind === 'ynab' && map().account >= 0) {
            <label class="check ynab"><input type="checkbox" [checked]="byAccount()" (change)="byAccount.set($any($event.target).checked)" />
              <span>Create missing accounts and import into each account by name<br /><span class="muted">Also maps Category Group / Category to your categories by name, creating missing ones.</span></span></label>
          }
          <div class="grid">
            @for (r of roles(); track r.key) {
              <label class="field"><span>{{ r.label }}</span>
                <select class="select" [value]="map()[r.key]" (change)="setCol(r.key, $any($event.target).value)">
                  <option value="-1" [selected]="map()[r.key] === -1">None</option>
                  @for (h of headers(); track $index) { <option [value]="$index" [selected]="map()[r.key] === $index">{{ h }}</option> }
                </select>
              </label>
            }
            <label class="field"><span>Date format</span>
              <select class="select" (change)="patch({ dateFormat: $any($event.target).value })">
                @for (f of dateFormats; track f) { <option [value]="f" [selected]="map().dateFormat === f">{{ f }}</option> }
              </select>
            </label>
            <label class="field"><span>Amounts are</span>
              <select class="select" (change)="patch({ amountMode: $any($event.target).value })">
                <option value="single" [selected]="map().amountMode === 'single'">Single column (negative = outflow)</option>
                <option value="split" [selected]="map().amountMode === 'split'">Separate outflow / inflow columns</option>
                <option value="flip" [selected]="map().amountMode === 'flip'">Single column, flip sign</option>
              </select>
            </label>
          </div>
          <h3>Preview</h3>
          @if (parsed().length) {
            <div class="preview card">
              @for (r of parsed().slice(0, 8); track $index) {
                <div class="prow">
                  <span class="d">{{ r.date | date }}</span>
                  <span class="p">{{ r.payee || '—' }}@if (r.memo) { <span class="muted"> · {{ r.memo }}</span> }</span>
                  <span class="a" [class.amt-neg]="r.amount < 0" [class.amt-pos]="r.amount > 0">{{ r.amount | money:'sign' }}</span>
                </div>
              }
            </div>
            <p class="muted small">{{ parsed().length }} of {{ rowsOnly().length }} rows can be read.</p>
          } @else {
            <p class="empty">No readable rows yet. Check the date and amount columns.</p>
          }
        }
        @case ('review') {
          <div class="bar">
            @if (!usingAccountCol()) {
              <label class="field inline"><span>Into account</span>
                <select class="select" (change)="target.set($any($event.target).value)">
                  <option value="" [selected]="!target()">Choose…</option>
                  @for (a of accounts(); track a.id) { <option [value]="a.id" [selected]="a.id === target()">{{ a.name }}</option> }
                </select>
              </label>
            } @else {
              <span class="muted">Importing into each account by name</span>
            }
            <label class="check"><input type="checkbox" [checked]="allSelected()" (change)="selectAll($any($event.target).checked)" /> Select all</label>
          </div>
          <p class="summary"><strong>{{ counts().new }} new</strong> · {{ counts().dup }} duplicates@if (counts().match) { · {{ counts().match }} matched }
            <span class="muted"> · {{ selected() }} selected</span></p>
          @if (usingAccountCol() && missingAccounts().length) {
            <p class="note">Will create account@if (missingAccounts().length > 1) {s}: {{ missingAccounts().join(', ') }}</p>
          }
          <div class="list" role="list">
            @for (it of items(); track $index; let i = $index) {
              <div class="item" role="listitem" [class.off]="!included(i)">
                <input class="ck" type="checkbox" [checked]="included(i)" (change)="toggle(i, $any($event.target).checked)" [attr.aria-label]="'Include row ' + (i + 1)" />
                <span class="d">{{ it.row.date | date }}</span>
                <span class="pm"><span class="pn">{{ it.row.payee || '—' }}</span>@if (it.row.memo) { <span class="mm muted">{{ it.row.memo }}</span> }
                  @if (usingAccountCol() && it.accountName) { <span class="mm muted">{{ it.accountName }}</span> }</span>
                <span class="cat">
                  <app-combo [compact]="true" placeholder="Category" [items]="pickers.categories()" [value]="it.catId" (picked)="setCat(i, $event.id)" />
                  @if (!it.catId && it.newCat) { <span class="mm muted">New: {{ it.newCat }}</span> }
                </span>
                <span class="am" [class.amt-neg]="it.row.amount < 0" [class.amt-pos]="it.row.amount > 0">{{ it.row.amount | money:'sign' }}</span>
                <span class="st">
                  @switch (it.status) {
                    @case ('new') { <span class="chip s-new">New</span> }
                    @case ('dup') { <span class="chip s-dup">Duplicate</span> }
                    @case ('match') { <span class="chip s-match" title="Matches an existing transaction; it will be marked cleared">Matched</span> }
                  }
                </span>
              </div>
            }
          </div>
          @if (error()) { <p class="err">{{ error() }}</p> }
        }
      }
      @switch (step()) {
        @case ('file') {
          <div footer class="foot">
            <button class="btn" type="button" (click)="close()">Cancel</button>
            <button class="btn primary" type="button" [disabled]="!pasted().trim()" (click)="loadText(pasted(), 'pasted')">Continue</button>
          </div>
        }
        @case ('map') {
          <div footer class="foot">
            <button class="btn" type="button" (click)="step.set('file')">Back</button>
            <button class="btn primary" type="button" [disabled]="!parsed().length" (click)="toReview()">Review {{ parsed().length }} rows</button>
          </div>
        }
        @case ('review') {
          <div footer class="foot">
            <button class="btn" type="button" (click)="back()">Back</button>
            <button class="btn primary" type="button" [disabled]="!canImport()" (click)="doImport()">Import {{ selected() }} transactions</button>
          </div>
        }
      }
    </app-sheet>`,
  styles: `
    :host { display: contents; }
    .foot { display: flex; justify-content: flex-end; gap: 8px; padding: 12px 20px; border-top: 1px solid var(--line); }
    .drop { display: flex; flex-direction: column; align-items: center; gap: 10px; text-align: center; padding: 32px 16px; border: 2px dashed var(--line-2); border-radius: var(--radius); color: var(--ink-2); transition: border-color .15s, background .15s; }
    .drop.over { border-color: var(--accent); background: var(--accent-soft); }
    .drop p { margin: 0; }
    .or { text-align: center; margin: 14px 0 8px; font-size: 13px; }
    .paste { font-family: var(--mono); font-size: 12.5px; }
    .err { color: var(--neg); font-size: 13px; margin: 10px 0 0; }
    .note { color: var(--warn); font-size: 13px; margin: 0 0 8px; }
    .file { margin: 0 0 8px; }
    .small { font-size: 12.5px; }
    .check { display: flex; align-items: flex-start; gap: 8px; font-size: 14px; margin: 6px 0; cursor: pointer; }
    .check input { margin-top: 3px; accent-color: var(--accent); }
    .ynab { padding: 10px 12px; border-radius: var(--radius-sm); background: var(--accent-soft); margin: 10px 0; }
    .grid { display: grid; grid-template-columns: repeat(auto-fill, minmax(190px, 1fr)); gap: 12px; margin: 12px 0; }
    h3 { font-size: 14px; margin: 14px 0 8px; }
    .preview { overflow: hidden; }
    .prow { display: grid; grid-template-columns: 96px 1fr auto; gap: 10px; padding: 8px 12px; border-bottom: 1px solid var(--line); font-size: 13.5px; }
    .prow:last-child { border-bottom: 0; }
    .prow .p { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
    .a, .am { font-variant-numeric: tabular-nums; font-weight: 600; text-align: right; white-space: nowrap; }
    .bar { display: flex; flex-wrap: wrap; align-items: end; justify-content: space-between; gap: 12px; margin-bottom: 8px; }
    .field.inline { min-width: 220px; }
    .summary { margin: 4px 0 10px; font-size: 14px; }
    .list { border: 1px solid var(--line); border-radius: var(--radius); }
    .item { display: grid; grid-template-columns: 24px 88px minmax(0, 1.4fr) minmax(0, 1.1fr) 108px 92px; gap: 10px; align-items: center; padding: 8px 12px; border-bottom: 1px solid var(--line); font-size: 13.5px; }
    .item:last-child { border-bottom: 0; }
    .item.off { opacity: .5; }
    .ck { accent-color: var(--accent); width: 16px; height: 16px; }
    .pm { display: flex; flex-direction: column; min-width: 0; }
    .pn { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; font-weight: 550; }
    .mm { font-size: 12px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
    .cat { min-width: 0; }
    .chip { cursor: default; height: 24px; padding: 0 10px; font-size: 12px; }
    .s-new { background: var(--pos-soft); color: var(--pos); border-color: transparent; }
    .s-dup { background: var(--zero-soft); color: var(--zero); border-color: transparent; }
    .s-match { background: var(--warn-soft); color: var(--warn); border-color: transparent; }
    @media (max-width: 640px) {
      .foot { padding-bottom: calc(12px + var(--safe-bottom)); }
      .item { grid-template-columns: 24px 1fr auto; grid-template-areas: 'ck pm am' 'ck d st' '. cat cat'; row-gap: 6px; padding: 12px; }
      .ck { grid-area: ck; align-self: start; margin-top: 2px; }
      .pm { grid-area: pm; } .am { grid-area: am; } .d { grid-area: d; color: var(--ink-2); font-size: 12.5px; }
      .st { grid-area: st; justify-self: end; } .cat { grid-area: cat; }
      .prow { grid-template-columns: 1fr auto; } .prow .d { grid-column: 1 / -1; color: var(--ink-2); font-size: 12px; }
      .field.inline { width: 100%; }
    }
  `,
})
export class ImportDialog {
  readonly open = input(false);
  readonly accountId = input<string | null>(null);
  readonly closed = output<void>();

  private store = inject(Store);
  private actions = inject(Actions);
  private toasts = inject(Toasts);
  protected pickers = inject(Pickers);
  readonly accounts = computed(() => this.store.accounts().filter((a) => !a.closed));
  protected readonly dateFormats: DateFmt[] = ['dd/mm/yyyy', 'mm/dd/yyyy', 'yyyy-mm-dd'];

  readonly step = signal<Step>('file');
  readonly over = signal(false);
  readonly pasted = signal('');
  readonly error = signal('');
  readonly fileName = signal('');
  readonly table = signal<string[][]>([]);
  readonly hasHeader = signal(true);
  readonly map = signal<Mapping>(guessMapping([], []));
  readonly ofxRows = signal<ParsedRow[] | null>(null);
  readonly byAccount = signal(false);
  readonly target = signal<string>('');
  /** per-row user overrides (row index -> value) */
  readonly catOverride = signal<Map<number, string | null>>(new Map());
  readonly incOverride = signal<Map<number, boolean>>(new Map());

  readonly headers = computed(() => {
    const t = this.table();
    if (!t.length) return [];
    const width = Math.max(...t.slice(0, 50).map((r) => r.length));
    return Array.from({ length: width }, (_, i) => (this.hasHeader() ? t[0][i]?.trim() : '') || `Column ${i + 1}`);
  });
  readonly rowsOnly = computed(() => (this.hasHeader() ? this.table().slice(1) : this.table()));
  readonly roles = computed<{ key: RoleKey; label: string }[]>(() => {
    const base: { key: RoleKey; label: string }[] = [{ key: 'date', label: 'Date' }, { key: 'payee', label: 'Payee' }, { key: 'memo', label: 'Memo' }];
    return this.map().amountMode === 'split'
      ? [...base, { key: 'outflow', label: 'Outflow' }, { key: 'inflow', label: 'Inflow' }]
      : [...base, { key: 'amount', label: 'Amount' }];
  });
  readonly parsed = computed<ParsedRow[]>(() => this.ofxRows() ?? rowsToTxns(this.rowsOnly(), this.map()));
  readonly usingAccountCol = computed(() => this.byAccount() && this.map().kind === 'ynab' && this.map().account >= 0 && !this.ofxRows());

  private accountByName = computed(() => new Map(this.accounts().map((a) => [norm(a.name), a])));

  readonly items = computed<Item[]>(() => {
    if (this.step() !== 'review') return [];
    const rows = this.parsed();
    const byName = this.accountByName();
    const useCol = this.usingAccountCol();
    const target = this.target();
    const cats = this.store.categories();
    const groups = this.store.groups();
    const override = this.catOverride();
    const used = new Set<string>();
    return rows.map((row, i): Item => {
      const accountName = useCol ? row.account ?? '' : '';
      const acct = useCol && accountName ? byName.get(norm(accountName)) : undefined;
      const accountId = useCol && accountName ? acct?.id ?? null : target || null;
      let status: Status = 'new';
      let matchId: string | undefined;
      if (accountId) {
        const m = this.actions.findMatch(accountId, row.date, row.amount, row.importId);
        if (m && !used.has(m.id)) {
          used.add(m.id);
          matchId = m.id;
          status = m.importId === row.importId ? 'dup' : 'match';
        }
      }
      let catId: string | null = null;
      let newCat = '';
      if (override.has(i)) catId = override.get(i) ?? null;
      else if (row.category !== undefined || row.group !== undefined) {
        const cn = norm(row.category ?? '');
        if (cn === 'ready to assign') catId = RTA;
        else if (cn) {
          const gn = norm(row.group ?? '');
          const g = groups.find((x) => norm(x.name) === gn);
          const found = cats.find((c) => norm(c.name) === cn && (!g || c.groupId === g.id)) ?? cats.find((c) => norm(c.name) === cn);
          if (found) catId = found.id;
          else newCat = `${row.group ? row.group + ' / ' : ''}${row.category}`;
        }
      }
      if (!catId && !newCat && !override.has(i)) catId = this.actions.suggestCategory(row.payee);
      return { row, accountId, accountName, status, matchId, catId, newCat };
    });
  });

  readonly counts = computed(() => {
    const c = { new: 0, dup: 0, match: 0 };
    for (const it of this.items()) c[it.status]++;
    return c;
  });
  readonly missingAccounts = computed(() => {
    if (!this.usingAccountCol()) return [];
    return [...new Set(this.items().filter((i) => i.accountName && !i.accountId).map((i) => i.accountName))];
  });
  readonly selected = computed(() => this.items().filter((_, i) => this.included(i)).length);
  readonly allSelected = computed(() => this.items().length > 0 && this.selected() === this.items().length);
  readonly canImport = computed(() => this.selected() > 0 && (this.usingAccountCol() ? true : !!this.target()));

  constructor() {
    effect(() => {
      if (this.open()) {
        const id = this.accountId();
        untracked(() => this.reset(id));
      }
    });
  }

  private reset(accountId: string | null) {
    this.step.set('file');
    this.pasted.set('');
    this.error.set('');
    this.fileName.set('');
    this.table.set([]);
    this.ofxRows.set(null);
    this.byAccount.set(false);
    this.target.set(accountId ?? '');
    this.catOverride.set(new Map());
    this.incOverride.set(new Map());
  }

  close() { this.closed.emit(); }

  // ---------------------------------------------------------------- step 1
  onDrop(e: DragEvent) {
    e.preventDefault();
    this.over.set(false);
    const f = e.dataTransfer?.files?.[0];
    if (f) void this.readFile(f);
  }
  onPick(e: Event) {
    const input = e.target as HTMLInputElement;
    const f = input.files?.[0];
    if (f) void this.readFile(f);
    input.value = '';
  }
  private async readFile(f: File) {
    try {
      const buf = await f.arrayBuffer();
      let text = new TextDecoder('utf-8').decode(buf);
      if (text.includes('�')) text = new TextDecoder('windows-1252').decode(buf);
      this.loadText(text, f.name);
    } catch {
      this.error.set('Could not read that file.');
    }
  }

  loadText(text: string, name: string) {
    this.error.set('');
    this.catOverride.set(new Map());
    this.incOverride.set(new Map());
    this.fileName.set(name);
    if (looksLikeOfx(text)) {
      const o = parseOfx(text);
      if (!o.txns.length) { this.error.set('No transactions found in this OFX file.'); return; }
      this.ofxRows.set(ofxToRows(o));
      this.table.set([]);
      this.step.set('review');
      return;
    }
    const t = parseCsv(text);
    if (t.length < 2 && !(t.length === 1 && t[0].length > 1)) { this.error.set('This does not look like a CSV file with data.'); return; }
    this.ofxRows.set(null);
    this.table.set(t);
    const header = looksLikeHeader(t[0]);
    this.hasHeader.set(header);
    this.guess();
    this.byAccount.set(this.map().kind === 'ynab');
    this.step.set('map');
  }

  // ---------------------------------------------------------------- step 2
  private guess() {
    const t = this.table();
    const heads = this.headers();
    this.map.set(guessMapping(heads, this.hasHeader() ? t.slice(1) : t));
  }
  setHeader(v: boolean) { this.hasHeader.set(v); this.guess(); }
  patch(p: Partial<Mapping>) { this.map.update((m) => ({ ...m, ...p, amountMode: (p.amountMode ?? m.amountMode) as AmountMode })); }
  setCol(key: RoleKey, v: string) { this.patch({ [key]: Number(v) } as Partial<Mapping>); }

  toReview() {
    this.catOverride.set(new Map());
    this.incOverride.set(new Map());
    this.step.set('review');
  }
  back() { this.step.set(this.ofxRows() ? 'file' : 'map'); }

  // ---------------------------------------------------------------- step 3
  included(i: number): boolean {
    const o = this.incOverride().get(i);
    if (o !== undefined) return o;
    return this.items()[i]?.status !== 'dup';
  }
  toggle(i: number, v: boolean) { this.incOverride.update((m) => new Map(m).set(i, v)); }
  selectAll(v: boolean) { this.incOverride.set(new Map(this.items().map((_, i) => [i, v]))); }
  setCat(i: number, id: string) { this.catOverride.update((m) => new Map(m).set(i, id)); }

  doImport() {
    const items = this.items();
    const chosen = items.map((it, i) => ({ it, i })).filter((x) => this.included(x.i));
    if (!chosen.length) return;
    const fallback = this.target();
    let added = 0, matched = 0;
    try {
      this.store.transact(`Import ${chosen.length} transactions`, () => {
        const acctIds = new Map<string, string>();
        const groupIds = new Map<string, string>();
        const catIds = new Map<string, string>();
        for (const { it } of chosen) {
          let accountId = it.accountId ?? '';
          if (!accountId && this.usingAccountCol() && it.accountName) {
            const key = norm(it.accountName);
            let id = acctIds.get(key);
            if (!id) {
              id = this.actions.addAccount(it.accountName, 'checking', 0).id;
              acctIds.set(key, id);
            }
            accountId = id;
          }
          if (!accountId) accountId = fallback;
          if (!accountId) continue;

          let categoryId = it.catId;
          if (!categoryId && it.newCat && it.row.category) {
            const gName = it.row.group || 'Imported';
            const gKey = norm(gName);
            let gid = groupIds.get(gKey) ?? this.store.groups().find((g) => norm(g.name) === gKey && !g.system)?.id;
            if (!gid) gid = this.actions.addGroup(gName).id;
            groupIds.set(gKey, gid);
            const cKey = gKey + '/' + norm(it.row.category);
            let cid = catIds.get(cKey);
            if (!cid) { cid = this.actions.addCategory(gid, it.row.category).id; catIds.set(cKey, cid); }
            categoryId = cid;
          }

          // re-check against the live store so identical rows pair with distinct existing transactions
          const m = this.actions.findMatch(accountId, it.row.date, it.row.amount, it.row.importId);
          if (m && m.importId !== it.row.importId && it.status === 'match') {
            this.actions.patchTxns([m.id], { cleared: 'cleared', importId: it.row.importId }, 'Match transaction');
            matched++;
            continue;
          }
          this.actions.saveTxn({
            accountId, date: it.row.date, amount: it.row.amount, payeeName: it.row.payee,
            categoryId, memo: it.row.memo, cleared: 'cleared', approved: false, source: 'import', importId: it.row.importId,
          });
          added++;
        }
      });
    } catch (e) {
      this.error.set('Import failed: ' + (e as Error).message);
      return;
    }
    const total = added + matched;
    this.toasts.show(
      `Imported ${added} transaction${added === 1 ? '' : 's'}${matched ? ` · matched ${matched}` : ''}`,
      total ? { label: 'Undo', run: () => this.store.undo() } : undefined,
    );
    this.close();
  }
}
