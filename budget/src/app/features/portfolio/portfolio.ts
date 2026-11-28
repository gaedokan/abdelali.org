import { NgTemplateOutlet } from '@angular/common';
import { ChangeDetectionStrategy, Component, computed, inject, signal } from '@angular/core';
import { Actions } from '../../core/actions';
import { Account, Payee, Price, Trade, Txn } from '../../core/models';
import { formatCompact, formatMoney, formatNumber, parseMoney } from '../../core/money';
import { Store } from '../../core/store';
import { dayDiff, formatDate, parseDate, today, uid } from '../../core/util';
import { Combo, ComboItem } from '../../ui/combo';
import { Icon } from '../../ui/icon';
import { DatePipe, MoneyPipe } from '../../ui/money.pipe';
import { Sheet } from '../../ui/sheet';
import { Toasts } from '../../ui/toast';
import {
  ADJ_MEMO, ADJ_PAYEE, applyQuote, arcPath, ChartBox, computePositions, dividendsInYear, firstOversell, isAdjustment, lineChart,
  parsePastedPrices, pricePoints, Side, sharesHeld, suggestFee, todaysAdjustment, totals, tradeCash, TradeIn, valuePositions, valueSeries,
} from './portfolio-calc';
import { CASABLANCA_TICKERS, TICKER_NAMES } from './tickers';

/** Trade plus the id of its linked cash transaction. */
interface TradeX extends Trade { txnId?: string }

interface PriceRow { symbol: string; name: string; price: string; date: string }
interface Tip { x: number; y: number; title: string; rows: { label: string; value: string; color?: string }[]; sheet: boolean }

const BOX: ChartBox = { w: 640, h: 230, pl: 52, pr: 12, pt: 12, pb: 26 };
const CHART_RANGES = [{ key: '1m', label: '1M', days: 31 }, { key: '6m', label: '6M', days: 183 }, { key: '1y', label: '1Y', days: 366 }, { key: 'all', label: 'All', days: 0 }];

@Component({
  selector: 'app-portfolio',
  imports: [NgTemplateOutlet, Icon, MoneyPipe, DatePipe, Sheet, Combo],
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <div class="page">
      <header class="head">
        <h1>Investments</h1>
        @if (invAccounts().length) {
          <div class="actions">
            @if (invAccounts().length > 1) {
              <select class="select acct" aria-label="Account" [value]="filter()" (change)="filter.set($any($event.target).value)">
                <option value="" [selected]="filter() === ''">All brokerage accounts</option>
                @for (a of invAccounts(); track a.id) { <option [value]="a.id" [selected]="filter() === a.id">{{ a.name }}</option> }
              </select>
            }
            <button type="button" class="btn sm" (click)="openPrices()"><app-icon name="sync" [size]="14" /> Update prices</button>
            <button type="button" class="btn sm" (click)="updateValue()" title="Post one adjustment so the account balance equals cash + market value"><app-icon name="trend" [size]="14" /> Update account value</button>
            <button type="button" class="btn sm primary" (click)="openTrade()"><app-icon name="plus" [size]="14" /> Add trade</button>
          </div>
        }
      </header>

      @if (!invAccounts().length) {
        <div class="card empty">
          <app-icon name="trend" [size]="32" />
          <h2>Track your Casablanca Stock Exchange portfolio</h2>
          <p>Create a brokerage account to record trades, dividends and prices. It is a tracking account: it counts towards net worth but stays outside your budget.</p>
          <form class="inline" (submit)="$event.preventDefault(); createAccount()">
            <input class="input" aria-label="Account name" placeholder="Brokerage account name" [value]="newName()" (input)="newName.set($any($event.target).value)" />
            <button type="submit" class="btn primary"><app-icon name="plus" [size]="14" /> Add a brokerage account</button>
          </form>
        </div>
      } @else {
        <section class="card card-pad summary">
          <div class="hero">
            <div class="section-title">Market value</div>
            <div class="big num">{{ tot().marketValue | money }}</div>
            @if (tot().dayChange !== null) {
              <div class="sub num" [class.amt-pos]="tot().dayChange! > 0" [class.amt-neg]="tot().dayChange! < 0">
                {{ tot().dayChange! | money:'sign' }} ({{ pct(tot().dayChangePct) }}) <span class="muted">since previous price</span>
              </div>
            }
          </div>
          <div class="stats">
            <div class="stat">
              <div class="section-title">Unrealised P/L</div>
              <div class="v num" [class.amt-pos]="tot().unrealised > 0" [class.amt-neg]="tot().unrealised < 0">{{ tot().unrealised | money:'sign' }}</div>
              <div class="sub muted num">{{ pct(tot().unrealisedPct) }} on {{ tot().cost | money:'short' }} cost</div>
            </div>
            <div class="stat">
              <div class="section-title">Total return</div>
              <div class="v num" [class.amt-pos]="tot().totalReturn > 0" [class.amt-neg]="tot().totalReturn < 0">{{ tot().totalReturn | money:'sign' }}</div>
              <div class="sub muted num">incl. {{ tot().realised | money:'sign' }} realised and {{ tot().dividends | money }} dividends</div>
            </div>
            <div class="stat">
              <div class="section-title">Dividends {{ year }}</div>
              <div class="v num">{{ dividendsYear() | money }}</div>
              <div class="sub muted">net of fees</div>
            </div>
            <div class="stat">
              <div class="section-title">Cash available</div>
              <div class="v num">{{ cash() | money }}</div>
              <div class="sub muted">in brokerage accounts</div>
            </div>
          </div>
        </section>

        @if (!rows().length) {
          <div class="card empty">
            <app-icon name="chart" [size]="32" />
            <h2>No holdings yet</h2>
            <p>Record your first buy to see positions, profit and allocation. Funding: record a transfer from your bank to this account in the register first.</p>
            <button type="button" class="btn primary" (click)="openTrade()"><app-icon name="plus" [size]="14" /> Add trade</button>
          </div>
        } @else {
          <section class="card holdings" aria-label="Holdings">
            <div class="thead" aria-hidden="true">
              <span>Holding</span><span class="r">Shares</span><span class="r">Avg cost</span><span class="r">Last price</span>
              <span class="r">Value</span><span class="r">P/L</span><span>Weight</span>
            </div>
            @for (r of rows(); track r.symbol) {
              <div class="hrow" role="button" tabindex="0" [attr.aria-label]="'Open ' + r.symbol" (click)="detailSym.set(r.symbol)" (keydown.enter)="detailSym.set(r.symbol)">
                <div class="c-name">
                  <b class="sym">{{ r.symbol }}</b>
                  <span class="cname muted">{{ r.name }}</span>
                </div>
                <div class="c-sh num r"><span class="lbl">Shares</span>{{ qty(r.quantity) }}</div>
                <div class="c-avg num r"><span class="lbl">Avg cost</span>{{ r.avgCost | money:'plain' }}</div>
                <div class="c-last num r">
                  <span class="lbl">Last</span>
                  @if (r.priced) {
                    {{ r.last! | money:'plain' }}
                    <small class="muted">{{ r.lastDate! | date }}</small>
                    @if (r.stale) { <span class="stale">stale</span> }
                  } @else { <span class="stale">no price</span> }
                </div>
                <div class="c-val num r">{{ r.marketValue | money }}</div>
                <div class="c-pl num r" [class.amt-pos]="r.unrealised > 0" [class.amt-neg]="r.unrealised < 0">
                  {{ r.unrealised | money:'sign' }}<small>{{ r.priced ? pct(r.unrealisedPct) : '–' }}</small>
                </div>
                <div class="c-w"><span class="bar"><i [style.width.%]="r.weight * 100" [style.background]="r.color"></i></span><span class="num wp">{{ pct0(r.weight) }}</span></div>
              </div>
            }
          </section>

          <div class="grid2">
            <section class="card card-pad">
              <h2 class="section-title">Allocation</h2>
              <div class="donut-wrap">
                <svg viewBox="0 0 200 200" class="donut" role="img" [attr.aria-label]="'Allocation of ' + fmt(tot().marketValue)">
                  <circle class="track" cx="100" cy="100" r="76" />
                  @for (s of slices(); track s.key) {
                    <path class="slice" [class.dim]="hover() !== null && hover() !== s.key" [attr.d]="s.d" [style.stroke]="s.color"
                      (pointerenter)="hover.set(s.key); showTip($event, s.label, [{ label: pct(s.pct, false), value: fmt(s.value), color: s.color }], false)"
                      (pointermove)="moveTip($event)" (pointerleave)="hover.set(null); hideTip()" />
                  }
                  <text x="100" y="97" text-anchor="middle" class="d-total">{{ compact(tot().marketValue) }}</text>
                  <text x="100" y="115" text-anchor="middle" class="d-sub">MAD</text>
                </svg>
                <ul class="legend">
                  @for (s of slices(); track s.key) {
                    <li class="lg-row" [class.dim]="hover() !== null && hover() !== s.key" (pointerenter)="hover.set(s.key)" (pointerleave)="hover.set(null)">
                      <i class="dot" [style.background]="s.color"></i><span class="lg-name">{{ s.label }}</span>
                      <span class="muted num">{{ pct(s.pct, false) }}</span>
                    </li>
                  }
                </ul>
              </div>
            </section>

            <section class="card card-pad">
              <div class="card-head">
                <h2 class="section-title">Value over time</h2>
                <div class="chips" role="group" aria-label="Range">
                  @for (r of chartRanges; track r.key) { <button type="button" class="chip" [class.on]="range() === r.key" (click)="range.set(r.key)">{{ r.label }}</button> }
                </div>
              </div>
              @if (valueChart().pts.length < 2) {
                <p class="muted pad">Not enough history yet. Update prices over time to build the chart.</p>
              } @else {
                <div class="key"><span><i class="sw"></i>Market value</span><span><i class="sw dash"></i>Cost</span></div>
                <svg viewBox="0 0 640 230" class="chart" role="img" aria-label="Portfolio value over time">
                  @for (t of valueChart().yTicks; track t.y) {
                    <line class="grid" [attr.x1]="52" [attr.x2]="628" [attr.y1]="t.y" [attr.y2]="t.y" />
                    <text class="ax" x="46" [attr.y]="t.y + 3.5" text-anchor="end">{{ compact(t.v) }}</text>
                  }
                  @for (t of valueChart().xTicks; track t.date) { <text class="ax" [attr.x]="t.x" y="224" text-anchor="middle">{{ t.date | date }}</text> }
                  <path class="area" [attr.d]="valueChart().area" />
                  <path class="cost" [attr.d]="valueChart().costPath" />
                  <path class="line" [attr.d]="valueChart().path" />
                  @if (valueHover() !== null) {
                    <line class="guide" [attr.x1]="valueChart().pts[valueHover()!].x" [attr.x2]="valueChart().pts[valueHover()!].x" y1="12" y2="204" />
                    <circle class="dotp" [attr.cx]="valueChart().pts[valueHover()!].x" [attr.cy]="valueChart().pts[valueHover()!].y" r="4" />
                  }
                  <rect class="hit" x="0" y="0" width="640" height="230" (pointermove)="chartMove($event, valueChart(), 'value', false)" (pointerleave)="valueHover.set(null); hideTip()" />
                </svg>
              }
            </section>
          </div>
        }
      }

      @if (tip(); as t) {
        @if (!t.sheet) { <ng-container *ngTemplateOutlet="tipTpl; context: { $implicit: t }" /> }
      }
    </div>

    <ng-template #tipTpl let-t>
      <div class="tip" [style.left.px]="t.x" [style.top.px]="t.y" role="tooltip">
        <div class="tip-title">{{ t.title }}</div>
        @for (r of t.rows; track r.label) {
          <div class="tip-row">@if (r.color) { <i class="dot" [style.background]="r.color"></i> }<span>{{ r.label }}</span><b class="num">{{ r.value }}</b></div>
        }
      </div>
    </ng-template>

    <!-- ===================================================== holding detail -->
    <app-sheet [open]="detailSym() !== null" [title]="detail() ? detail()!.symbol + (detail()!.name ? ' · ' + detail()!.name : '') : ''" [wide]="true" (closed)="detailSym.set(null); hideTip()">
      @if (detail(); as d) {
        <div class="d-stats">
          <div><span class="muted">Shares</span><b class="num">{{ qty(d.quantity) }}</b></div>
          <div><span class="muted">Avg cost</span><b class="num">{{ d.avgCost | money }}</b></div>
          <div><span class="muted">Last price</span><b class="num">{{ d.priced ? (d.last! | money) : '–' }}</b></div>
          <div><span class="muted">Value</span><b class="num">{{ d.marketValue | money }}</b></div>
          <div><span class="muted">Unrealised</span><b class="num" [class.amt-pos]="d.unrealised > 0" [class.amt-neg]="d.unrealised < 0">{{ d.unrealised | money:'sign' }}</b></div>
          <div><span class="muted">Realised</span><b class="num" [class.amt-pos]="d.realised > 0" [class.amt-neg]="d.realised < 0">{{ d.realised | money:'sign' }}</b></div>
          <div><span class="muted">Dividends</span><b class="num">{{ d.dividends | money }}</b></div>
        </div>
        <h2 class="section-title">Price history</h2>
        @if (priceChart().pts.length < 2) {
          <p class="muted pad">No price history yet. Each time you update prices a point is added.</p>
        } @else {
          <svg viewBox="0 0 640 230" class="chart" role="img" [attr.aria-label]="d.symbol + ' price history'">
            @for (t of priceChart().yTicks; track t.y) {
              <line class="grid" [attr.x1]="52" [attr.x2]="628" [attr.y1]="t.y" [attr.y2]="t.y" />
              <text class="ax" x="46" [attr.y]="t.y + 3.5" text-anchor="end">{{ priceTick(t.v) }}</text>
            }
            @for (t of priceChart().xTicks; track t.date) { <text class="ax" [attr.x]="t.x" y="224" text-anchor="middle">{{ t.date | date }}</text> }
            <path class="area" [attr.d]="priceChart().area" />
            <path class="line" [attr.d]="priceChart().path" />
            @if (priceHover() !== null) {
              <line class="guide" [attr.x1]="priceChart().pts[priceHover()!].x" [attr.x2]="priceChart().pts[priceHover()!].x" y1="12" y2="204" />
              <circle class="dotp" [attr.cx]="priceChart().pts[priceHover()!].x" [attr.cy]="priceChart().pts[priceHover()!].y" r="4" />
            }
            <rect class="hit" x="0" y="0" width="640" height="230" (pointermove)="chartMove($event, priceChart(), 'price', true)" (pointerleave)="priceHover.set(null); hideTip()" />
          </svg>
        }
        @if (tip(); as t) { @if (t.sheet) { <ng-container *ngTemplateOutlet="tipTpl; context: { $implicit: t }" /> } }
        <div class="card-head">
          <h2 class="section-title">Trades</h2>
          <button type="button" class="btn sm" (click)="openTrade({ symbol: d.symbol })"><app-icon name="plus" [size]="14" /> Add trade</button>
        </div>
        <ul class="trades">
          @for (t of detailTrades(); track t.id) {
            <li>
              <span class="td num">{{ t.date | date }}</span>
              <span class="ts" [class]="'side ' + t.side">{{ t.side }}</span>
              <span class="tq num">@if (t.side !== 'dividend') { {{ qty(t.quantity) }} × {{ t.price | money:'plain' }} } @else { {{ t.price | money }} }</span>
              <span class="tf num muted">@if (t.fees) { fees {{ t.fees | money:'plain' }} }</span>
              <span class="tb">
                <button type="button" class="btn ghost icon sm" aria-label="Edit trade" (click)="openTrade({ edit: t })"><app-icon name="edit" [size]="14" /></button>
                <button type="button" class="btn ghost icon sm" aria-label="Delete trade" (click)="deleteTrade(t)"><app-icon name="trash" [size]="14" /></button>
              </span>
            </li>
          }
        </ul>
      }
    </app-sheet>

    <!-- ===================================================== add / edit trade -->
    <app-sheet [open]="tradeOpen()" [title]="editingId() ? 'Edit trade' : 'Add trade'" (closed)="tradeOpen.set(false)">
      <form class="form" data-form (submit)="$event.preventDefault(); saveTrade()">
        <div class="seg block" role="group" aria-label="Type">
          @for (s of sides; track s.key) { <button type="button" [class.on]="tSide() === s.key" (click)="setSide(s.key)">{{ s.label }}</button> }
        </div>
        <div class="row2">
          @if (invAccounts().length > 1) {
            <label class="field"><span>Account</span>
              <select class="select" [value]="tAccount()" (change)="tAccount.set($any($event.target).value)">
                @for (a of invAccounts(); track a.id) { <option [value]="a.id" [selected]="tAccount() === a.id">{{ a.name }}</option> }
              </select>
            </label>
          }
          <label class="field"><span>Date ({{ store.settings().dateFormat }})</span>
            <input class="input" [value]="tDate()" (input)="tDate.set($any($event.target).value)" [class.bad]="tDate().trim() && !tDateIso()" inputmode="numeric" />
          </label>
        </div>
        <div class="field"><span>Symbol</span>
          <app-combo [items]="symbolItems()" [(value)]="tSym" [(text)]="tSymText" [allowCreate]="true" placeholder="IAM, ATW… or type any symbol" (picked)="onPicked($event)" />
        </div>
        <div class="row2">
          @if (tSide() !== 'dividend') {
            <label class="field"><span>Shares</span>
              <input class="input amount" inputmode="decimal" [value]="tQty()" (input)="tQty.set($any($event.target).value); recalcFee()" placeholder="10" />
            </label>
          }
          <label class="field"><span>{{ tSide() === 'dividend' ? 'Total dividend (MAD)' : 'Price per share (MAD)' }}</span>
            <input class="input amount" inputmode="decimal" [value]="tPrice()" (input)="tPrice.set($any($event.target).value); recalcFee()" placeholder="120,50" />
          </label>
        </div>
        <label class="field"><span>{{ tSide() === 'dividend' ? 'Fees / withholding tax (MAD)' : 'Fees (MAD)' }}</span>
          <input class="input amount" inputmode="decimal" [value]="tFees()" (input)="tFees.set($any($event.target).value); feesTouched.set(true)" placeholder="0" />
          @if (tSide() !== 'dividend') { <small class="hint">Suggested 0,6% of the amount (typical brokerage + exchange + VAT); edit as needed.</small> }
        </label>
        @if (tSide() === 'sell' && tSymbol()) { <small class="hint">You hold {{ qty(heldShares()) }} {{ tSymbol() }} in this account.</small> }
        @if (tradeCashValue() !== null) {
          <div class="preview">
            <span>{{ tSide() === 'buy' ? 'Total cost' : tSide() === 'sell' ? 'Net proceeds' : 'Net dividend' }}</span>
            <b class="num">{{ abs(tradeCashValue()!) | money }}</b>
          </div>
        }
        @if (tradeError(); as e) { <p class="error" role="alert">{{ e }}</p> }
        <p class="hint">Cash moves in this brokerage account automatically. Funding: record a transfer from your bank to this account in the register.</p>
        <button type="submit" hidden></button>
      </form>
      <div footer class="sf">
        @if (editingId()) { <button type="button" class="btn ghost danger" (click)="deleteEditing()">Delete</button> }
        <span class="grow"></span>
        <button type="button" class="btn" (click)="tradeOpen.set(false)">Cancel</button>
        <button type="button" class="btn primary" [disabled]="!canSave()" (click)="saveTrade()">Save trade</button>
      </div>
    </app-sheet>

    <!-- ===================================================== update prices -->
    <app-sheet [open]="pricesOpen()" title="Update prices" (closed)="pricesOpen.set(false)">
      <div class="form">
        <div class="pr-actions">
          <button type="button" class="btn sm" [disabled]="fetching() || !pRows().length" (click)="fetchQuotes()"><app-icon name="cloud" [size]="14" /> {{ fetching() ? 'Fetching…' : 'Fetch latest quotes' }}</button>
          <span class="hint">Date format {{ store.settings().dateFormat }}</span>
        </div>
        @if (!pRows().length) { <p class="muted">No held symbols yet. Paste prices below to add some.</p> }
        <div class="prows">
          @for (r of pRows(); track r.symbol; let i = $index) {
            <div class="prow">
              <div class="pn"><b>{{ r.symbol }}</b><span class="muted">{{ r.name }}</span></div>
              <input class="input amount" inputmode="decimal" [attr.aria-label]="r.symbol + ' price'" [value]="r.price" (input)="setRow(i, 'price', $any($event.target).value)" placeholder="0,00" />
              <input class="input pd" [attr.aria-label]="r.symbol + ' date'" [value]="r.date" (input)="setRow(i, 'date', $any($event.target).value)" />
            </div>
          }
        </div>
        <label class="field"><span>Paste prices</span>
          <textarea class="input" rows="3" placeholder="IAM 118,50&#10;ATW;520" [value]="pPaste()" (input)="pPaste.set($any($event.target).value)"></textarea>
        </label>
        <div><button type="button" class="btn sm" [disabled]="!pPaste().trim()" (click)="applyPaste()">Apply pasted prices</button></div>
      </div>
      <div footer class="sf">
        <span class="grow"></span>
        <button type="button" class="btn" (click)="pricesOpen.set(false)">Cancel</button>
        <button type="button" class="btn primary" [disabled]="!pRows().length" (click)="savePrices()">Save prices</button>
      </div>
    </app-sheet>
  `,
  styles: `
    :host {
      display: block;
      --g0: #2f7d6d; --g1: #d08a3c; --g2: #5b7fc7; --g3: #c4627a; --g4: #8a6bbf;
      --g5: #6aa84f; --g6: #c9a227; --g7: #3f9ab5; --g8: #b5683e; --g9: #7b8794;
    }
    :host-context([data-theme='dark']) {
      --g0: #4cc2a8; --g1: #f0b04f; --g2: #7fa2ea; --g3: #e88aa1; --g4: #b093e0;
      --g5: #8fcd72; --g6: #e6c750; --g7: #6dc2dc; --g8: #e0916a; --g9: #a3adb8;
    }
    @media (prefers-color-scheme: dark) {
      :host-context(:root:not([data-theme='light'])) {
        --g0: #4cc2a8; --g1: #f0b04f; --g2: #7fa2ea; --g3: #e88aa1; --g4: #b093e0;
        --g5: #8fcd72; --g6: #e6c750; --g7: #6dc2dc; --g8: #e0916a; --g9: #a3adb8;
      }
    }
    .page { max-width: 1100px; margin: 0 auto; padding: 24px 20px 56px; display: flex; flex-direction: column; gap: 18px; min-width: 0; }
    .head { display: flex; align-items: center; justify-content: space-between; gap: 12px 16px; flex-wrap: wrap; }
    .head h1 { font-size: 1.625rem; }
    .actions { display: flex; gap: 8px; flex-wrap: wrap; align-items: center; }
    .acct { width: auto; min-width: 180px; height: 28px; font-size: 0.8125rem; }
    .card { animation: rise .35s var(--ease) both; min-width: 0; }
    @keyframes rise { from { opacity: 0; transform: translateY(6px); } to { opacity: 1; transform: none; } }
    .card-pad { padding: 22px; }
    .card-head { display: flex; align-items: center; justify-content: space-between; gap: 8px; min-height: 28px; margin-bottom: 4px; }
    .pad { padding: 18px 0; }
    .inline { display: flex; gap: 8px; justify-content: center; flex-wrap: wrap; max-width: 520px; margin: 0 auto; }
    .inline .input { flex: 1; min-width: 180px; }

    .summary { display: grid; grid-template-columns: minmax(240px, 1fr) 2fr; gap: 24px; align-items: center; }
    .big { font: 700 2.125rem/1.1 var(--display); letter-spacing: -.02em; margin: 2px 0 6px; }
    .sub { font-size: 0.7812rem; }
    .stats { display: grid; grid-template-columns: repeat(4, minmax(0, 1fr)); gap: 14px; }
    .stat { min-width: 0; padding-left: 14px; border-left: 1px solid var(--line); }
    .stat .v { font: 650 1.125rem/1.2 var(--display); margin-bottom: 3px; }
    .stat .sub { white-space: normal; overflow-wrap: anywhere; font-size: 0.75rem; line-height: 1.35; }
    .stat .section-title { margin-bottom: 6px; }

    .holdings { overflow: hidden; }
    .thead, .hrow { display: grid; grid-template-columns: minmax(150px, 1.7fr) 70px 96px minmax(110px, 1fr) 118px 118px 110px; column-gap: 12px; align-items: center; padding: 0 16px; }
    .thead { height: 38px; font: 650 0.6875rem/1 var(--font); text-transform: uppercase; letter-spacing: .07em; color: var(--ink-3); background: var(--surface-2); border-bottom: 1px solid var(--line); }
    .r { text-align: right; }
    .hrow { min-height: 58px; border-top: 1px solid var(--line); cursor: pointer; transition: background .12s; font-size: 0.875rem; }
    .hrow:first-of-type { border-top: 0; }
    .hrow:hover, .hrow:focus-visible { background: var(--surface-2); outline: none; }
    .c-name { display: flex; flex-direction: column; min-width: 0; padding: 8px 0; }
    .sym { font-size: 0.9062rem; letter-spacing: .01em; }
    .cname { font-size: 0.75rem; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
    .lbl { display: none; }
    .c-last small, .c-pl small { display: block; font-size: 0.7188rem; line-height: 1.2; }
    .c-pl small { color: inherit; opacity: .85; }
    .c-val { font-weight: 600; }
    .stale { display: inline-flex; align-items: center; height: 17px; padding: 0 6px; margin-left: 4px; border-radius: 999px; font-size: 0.6562rem; font-weight: 650; background: var(--warn-soft); color: var(--warn); }
    .c-w { display: flex; align-items: center; gap: 8px; }
    .bar { flex: 1; height: 6px; border-radius: 6px; background: var(--sunken); overflow: hidden; }
    .bar i { display: block; height: 100%; border-radius: 6px; transition: width .4s var(--ease); }
    .wp { width: 36px; text-align: right; font-size: 0.7812rem; color: var(--ink-2); }

    .grid2 { display: grid; grid-template-columns: minmax(0, 1fr) minmax(0, 1.3fr); gap: 18px; align-items: start; }
    .donut-wrap { display: flex; flex-direction: column; align-items: center; gap: 12px; }
    .donut { width: 100%; max-width: 200px; flex: none; }
    .donut .track { fill: none; stroke: var(--sunken); stroke-width: 24; }
    .slice { fill: none; stroke-width: 24; transition: opacity .15s; cursor: default; }
    .slice.dim, .lg-row.dim { opacity: .35; }
    .d-total { font: 700 1.25rem var(--display); fill: var(--ink); }
    .d-sub { font-size: 0.6875rem; fill: var(--ink-3); }
    .legend { list-style: none; margin: 0; padding: 0; width: 100%; display: grid; gap: 2px; }
    .lg-row { display: flex; align-items: center; gap: 8px; padding: 4px 6px; border-radius: 8px; font-size: 0.8438rem; transition: opacity .15s; }
    .lg-name { flex: 1; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
    .dot { width: 10px; height: 10px; border-radius: 50%; flex: none; display: inline-block; }
    @media (min-width: 640px) { .donut-wrap { flex-direction: row; align-items: center; } .legend { flex: 1; min-width: 0; } }

    .chips { display: flex; gap: 6px; }
    .chart { width: 100%; height: auto; display: block; margin-top: 6px; touch-action: pan-y; }
    .chart .grid { stroke: var(--line); stroke-width: 1; }
    .chart .ax { fill: var(--ink-3); font-size: 0.6875rem; font-variant-numeric: tabular-nums; }
    .chart .line { fill: none; stroke: var(--accent); stroke-width: 2.2; stroke-linejoin: round; stroke-linecap: round; }
    .chart .cost { fill: none; stroke: var(--ink-3); stroke-width: 1.4; stroke-dasharray: 4 4; }
    .chart .area { fill: var(--accent-soft); opacity: .55; stroke: none; }
    .chart .guide { stroke: var(--line-2); stroke-width: 1; }
    .chart .dotp { fill: var(--accent); stroke: var(--surface); stroke-width: 2; }
    .chart .hit { fill: transparent; }
    .key { display: flex; gap: 14px; font-size: 0.75rem; color: var(--ink-2); margin: 4px 0 0; }
    .key .sw { display: inline-block; width: 14px; height: 3px; border-radius: 2px; background: var(--accent); margin-right: 6px; vertical-align: middle; }
    .key .sw.dash { background: repeating-linear-gradient(90deg, var(--ink-3) 0 4px, transparent 4px 8px); }

    .tip { position: fixed; z-index: 1000; pointer-events: none; background: var(--ink); color: var(--bg); padding: 8px 11px; border-radius: 9px; font-size: 0.7812rem; box-shadow: var(--shadow-2); min-width: 120px; }
    .tip-title { font-weight: 650; margin-bottom: 3px; }
    .tip-row { display: flex; align-items: center; gap: 7px; }
    .tip-row span { flex: 1; opacity: .8; }
    .tip-row .dot { width: 8px; height: 8px; }

    /* detail sheet */
    .d-stats { display: grid; grid-template-columns: repeat(auto-fit, minmax(110px, 1fr)); gap: 10px 14px; margin-bottom: 14px; }
    .d-stats div { display: flex; flex-direction: column; gap: 2px; font-size: 0.75rem; }
    .d-stats b { font-size: 0.9375rem; }
    .trades { list-style: none; margin: 0; padding: 0; }
    .trades li { display: grid; grid-template-columns: 84px 74px minmax(0, 1fr) auto 68px; gap: 8px; align-items: center; padding: 6px 0; border-top: 1px solid var(--line); font-size: 0.8438rem; }
    .tq { text-align: right; }
    .tf { text-align: right; font-size: 0.75rem; min-width: 60px; }
    .tb { display: flex; justify-content: flex-end; }
    .side { text-transform: capitalize; font-weight: 600; font-size: 0.7812rem; }
    .side.buy { color: var(--pos); } .side.sell { color: var(--neg); } .side.dividend { color: var(--accent-ink); }

    /* forms */
    .form { display: flex; flex-direction: column; gap: 14px; }
    .row2 { display: grid; grid-template-columns: repeat(auto-fit, minmax(150px, 1fr)); gap: 12px; }
    .hint { font-size: 0.75rem; color: var(--ink-3); font-weight: 450; margin: 0; }
    .input.bad { border-color: var(--neg); }
    .preview { display: flex; justify-content: space-between; align-items: center; padding: 10px 14px; border-radius: 10px; background: var(--sunken); font-size: 0.875rem; }
    .preview b { font-size: 1.0625rem; }
    .error { margin: 0; padding: 8px 12px; border-radius: 8px; background: var(--neg-soft); color: var(--neg); font-size: 0.8125rem; font-weight: 550; }
    .sf { display: flex; align-items: center; gap: 8px; padding: 12px 20px 16px; border-top: 1px solid var(--line); }
    .sf .grow { flex: 1; }
    .btn.danger { color: var(--neg); }
    .pr-actions { display: flex; align-items: center; gap: 12px; justify-content: space-between; }
    .prows { display: grid; gap: 8px; }
    .prow { display: grid; grid-template-columns: minmax(0, 1fr) 110px 110px; gap: 8px; align-items: center; }
    .pn { display: flex; flex-direction: column; min-width: 0; line-height: 1.25; }
    .pn span { font-size: 0.75rem; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }

    @media (max-width: 860px) {
      .summary { grid-template-columns: minmax(0, 1fr); gap: 16px; }
      .stats { grid-template-columns: repeat(2, minmax(0, 1fr)); }
      .stat:nth-child(odd) { padding-left: 0; border-left: 0; }
      .grid2 { grid-template-columns: minmax(0, 1fr); }
    }
    @media (max-width: 719px) {
      .page { padding: 16px 16px 40px; }
      .card-pad { padding: 16px; }
      .big { font-size: 1.8125rem; }
      .actions { width: 100%; } .acct { width: 100%; }
      .thead { display: none; }
      .holdings { background: transparent; border: 0; box-shadow: none; display: grid; gap: 10px; overflow: visible; }
      .hrow { grid-template-columns: minmax(0, 1fr) auto; grid-template-areas: 'name val' 'name pl' 'sh sh' 'w w'; row-gap: 4px; padding: 12px 14px;
        background: var(--surface); border: 1px solid var(--line); border-radius: 14px; box-shadow: var(--shadow-1); }
      .hrow:first-of-type { border-top: 1px solid var(--line); }
      .c-name { grid-area: name; padding: 0; }
      .c-val { grid-area: val; font-size: 0.9375rem; }
      .c-pl { grid-area: pl; }
      .c-pl small { display: inline; margin-left: 6px; }
      .c-sh, .c-avg, .c-last { display: none; }
      .c-w { grid-area: w; margin-top: 4px; }
      .hrow::after { content: none; }
      .trades li { grid-template-columns: 74px 64px minmax(0, 1fr) 64px; }
      .trades .tf { display: none; }
      .prow { grid-template-columns: minmax(0, 1fr) 96px 96px; }
    }
  `,
})
export class Portfolio {
  protected readonly store = inject(Store);
  private readonly actions = inject(Actions);
  private readonly toasts = inject(Toasts);

  protected readonly year = new Date().getFullYear();
  protected readonly sides: { key: Side; label: string }[] = [{ key: 'buy', label: 'Buy' }, { key: 'sell', label: 'Sell' }, { key: 'dividend', label: 'Dividend' }];
  protected readonly chartRanges = CHART_RANGES;

  // ------------------------------------------------------------ state
  protected readonly filter = signal('');
  protected readonly newName = signal('Brokerage');
  protected readonly range = signal('1y');
  protected readonly hover = signal<string | null>(null);
  protected readonly tip = signal<Tip | null>(null);
  protected readonly valueHover = signal<number | null>(null);
  protected readonly priceHover = signal<number | null>(null);
  protected readonly detailSym = signal<string | null>(null);

  protected readonly tradeOpen = signal(false);
  protected readonly editingId = signal<string | null>(null);
  protected readonly tSide = signal<Side>('buy');
  protected readonly tAccount = signal('');
  protected readonly tDate = signal('');
  protected readonly tSym = signal<string | null>(null);
  protected readonly tSymText = signal('');
  protected readonly tQty = signal('');
  protected readonly tPrice = signal('');
  protected readonly tFees = signal('');
  protected readonly feesTouched = signal(false);

  protected readonly pricesOpen = signal(false);
  protected readonly pRows = signal<PriceRow[]>([]);
  protected readonly pPaste = signal('');
  protected readonly fetching = signal(false);

  // ------------------------------------------------------------ data
  protected readonly invAccounts = computed<Account[]>(() => this.store.accounts().filter((a) => a.type === 'investment' && !a.closed));
  private readonly scope = computed(() => {
    const f = this.filter();
    return new Set(f && this.invAccounts().some((a) => a.id === f) ? [f] : this.invAccounts().map((a) => a.id));
  });
  private readonly allTrades = computed(() => {
    const ids = new Set(this.invAccounts().map((a) => a.id));
    return (this.store.trades() as TradeX[]).filter((t) => ids.has(t.accountId));
  });
  private readonly trades = computed(() => this.allTrades().filter((t) => this.scope().has(t.accountId)));
  private readonly positions = computed(() => computePositions(this.trades()));
  private readonly valued = computed(() => valuePositions([...this.positions().values()], this.store.prices()));
  protected readonly tot = computed(() => totals(this.valued(), [...this.positions().values()]));
  protected readonly dividendsYear = computed(() => dividendsInYear(this.trades(), this.year));

  protected readonly cash = computed(() => {
    const adj = new Set(this.store.payees().filter((p) => p.name === ADJ_PAYEE).map((p) => p.id));
    let c = 0;
    for (const t of this.store.txns()) {
      if (!this.scope().has(t.accountId)) continue;
      if (t.payeeId && adj.has(t.payeeId) && t.memo === ADJ_MEMO) continue;
      c += t.amount;
    }
    return c;
  });

  protected readonly rows = computed(() => {
    const total = this.tot().marketValue || 1;
    const prices = this.store.prices();
    const t = today();
    return this.valued().map((v, i) => ({
      ...v,
      name: prices.get(v.symbol)?.name ?? TICKER_NAMES.get(v.symbol) ?? '',
      weight: v.marketValue / total,
      color: `var(--g${Math.min(i, 9)})`,
      stale: !!v.lastDate && dayDiff(v.lastDate, t) > 3,
    }));
  });

  protected readonly slices = computed(() => {
    const rows = this.rows();
    const total = this.tot().marketValue;
    if (!rows.length || total <= 0) return [];
    const top = rows.slice(0, 9).map((r, i) => ({ key: r.symbol, label: r.symbol, value: r.marketValue, color: `var(--g${i})` }));
    const rest = rows.slice(9).reduce((s, r) => s + r.marketValue, 0);
    if (rest > 0) top.push({ key: '_other', label: 'Other', value: rest, color: 'var(--g9)' });
    let acc = 0;
    return top.map((s) => {
      const pct = s.value / total;
      const d = arcPath(acc, acc + pct, 100, 100, 76);
      acc += pct;
      return { ...s, pct, d };
    });
  });

  protected readonly valueChart = computed(() => {
    const series = valueSeries(this.trades(), this.store.prices(), today());
    const days = CHART_RANGES.find((r) => r.key === this.range())?.days ?? 0;
    const cut = days ? new Date(Date.now() - days * 86400000).toISOString().slice(0, 10) : '';
    let pts = series.filter((p) => p.date >= cut);
    // keep one point before the window so the line enters from the left edge
    if (cut && pts.length < series.length && pts.length) pts = [series[series.length - pts.length - 1], ...pts];
    return lineChart(pts.map((p) => ({ date: p.date, v: p.value, c: p.cost })), BOX);
  });

  protected readonly detail = computed(() => this.rows().find((r) => r.symbol === this.detailSym()) ?? null);
  protected readonly detailTrades = computed(() => this.trades().filter((t) => t.symbol === this.detailSym()).sort((a, b) => b.date.localeCompare(a.date)));
  protected readonly priceChart = computed(() => {
    const pts = pricePoints(this.store.prices().get(this.detailSym() ?? ''));
    return lineChart(pts.map(([date, v]) => ({ date, v })), BOX);
  });

  // ------------------------------------------------------------ format helpers
  protected fmt = (v: number) => formatMoney(v, this.store.format());
  protected compact = (v: number) => formatCompact(v, this.store.format());
  protected abs = Math.abs;
  protected qty(q: number) { return formatNumber(Math.round(q * 100), this.store.format(), !Number.isInteger(q)); }
  protected pct(x: number, sign = true) {
    const s = (x * 100).toFixed(2).replace('.', this.store.settings().decimal);
    return (sign && x > 0 ? '+' : '') + s + ' %';
  }
  protected pct0(x: number) { return Math.round(x * 100) + '%'; }
  protected priceTick(v: number) { return formatMoney(v, this.store.format(), { currency: false, decimals: false }); }

  // ------------------------------------------------------------ account
  protected createAccount() {
    const name = this.newName().trim();
    if (!name) return;
    this.actions.addAccount(name, 'investment', 0);
    this.toasts.show('Brokerage account added');
  }

  // ------------------------------------------------------------ tooltip + charts
  protected showTip(ev: PointerEvent, title: string, rows: Tip['rows'], sheet: boolean) { this.tip.set({ ...this.place(ev), title, rows, sheet }); }
  protected moveTip(ev: PointerEvent) { const t = this.tip(); if (t) this.tip.set({ ...t, ...this.place(ev) }); }
  protected hideTip() { this.tip.set(null); }
  private place(ev: PointerEvent) {
    const vw = typeof window !== 'undefined' ? window.innerWidth : 1000;
    return { x: Math.max(8, Math.min(ev.clientX + 14, vw - 210)), y: Math.max(8, ev.clientY - 56) };
  }

  protected chartMove(ev: PointerEvent, chart: { pts: { date: string; v: number; c?: number; x: number }[] }, which: 'value' | 'price', sheet: boolean) {
    const rect = (ev.currentTarget as Element).getBoundingClientRect();
    if (!rect.width || !chart.pts.length) return;
    const x = ((ev.clientX - rect.left) / rect.width) * BOX.w;
    let best = 0;
    for (let i = 1; i < chart.pts.length; i++) if (Math.abs(chart.pts[i].x - x) < Math.abs(chart.pts[best].x - x)) best = i;
    const p = chart.pts[best];
    (which === 'value' ? this.valueHover : this.priceHover).set(best);
    const rows = which === 'value'
      ? [{ label: 'Value', value: this.fmt(p.v), color: 'var(--accent)' }, { label: 'Cost', value: this.fmt(p.c ?? 0), color: 'var(--ink-3)' }]
      : [{ label: 'Price', value: this.fmt(p.v), color: 'var(--accent)' }];
    this.showTip(ev, formatDate(p.date, this.store.settings().dateFormat), rows, sheet);
  }

  // ------------------------------------------------------------ trade form
  protected readonly tDateIso = computed(() => parseDate(this.tDate(), this.store.settings().dateFormat));
  protected readonly tSymbol = computed(() => (this.tSym() ?? this.tSymText()).trim().toUpperCase());
  private readonly tQtyN = computed(() => {
    const s = this.tQty().trim().replace(/\s/g, '').replace(',', '.');
    const n = Number(s);
    return s && isFinite(n) && n > 0 ? n : null;
  });
  private readonly tPriceC = computed(() => parseMoney(this.tPrice()));
  private readonly tFeesC = computed(() => (this.tFees().trim() ? parseMoney(this.tFees()) : 0));

  protected readonly symbolItems = computed<ComboItem[]>(() => {
    const items: ComboItem[] = CASABLANCA_TICKERS.map((t) => ({ id: t.symbol, label: `${t.symbol} · ${t.name}`, keywords: t.symbol + ' ' + t.name }));
    const known = new Set(items.map((i) => i.id));
    for (const s of this.positions().keys()) if (!known.has(s)) items.push({ id: s, label: s, keywords: s });
    return items;
  });

  private others() {
    const id = this.editingId();
    return this.allTrades().filter((t) => t.id !== id);
  }
  protected readonly heldShares = computed(() => {
    const sym = this.tSymbol();
    return sharesHeld(this.others().filter((t) => t.accountId === this.tAccount()), sym);
  });

  protected readonly tradeCashValue = computed(() => {
    const side = this.tSide(), p = this.tPriceC(), f = this.tFeesC();
    if (p === null || f === null) return null;
    if (side === 'dividend') return tradeCash(side, 0, p, f);
    const q = this.tQtyN();
    return q === null ? null : tradeCash(side, q, p, f);
  });

  protected readonly tradeError = computed<string | null>(() => {
    const side = this.tSide();
    if (this.tSide() !== 'sell') return null;
    const q = this.tQtyN(), sym = this.tSymbol();
    if (q === null || !sym) return null;
    const cand: TradeIn = { accountId: this.tAccount(), date: this.tDateIso() ?? today(), symbol: sym, side, quantity: q, price: 0, fees: 0 };
    return firstOversell([...this.others(), cand]) ? `You cannot sell more than you hold (${this.qty(this.heldShares())} ${sym}).` : null;
  });

  protected readonly canSave = computed(() => {
    if (!this.tAccount() || !this.tDateIso() || !this.tSymbol() || /\s/.test(this.tSymbol())) return false;
    if (this.tPriceC() === null || this.tPriceC()! <= 0 || this.tFeesC() === null || this.tFeesC()! < 0) return false;
    if (this.tSide() !== 'dividend' && this.tQtyN() === null) return false;
    return !this.tradeError();
  });

  protected openTrade(opts: { edit?: TradeX; symbol?: string } = {}) {
    const f = this.store.format();
    const e = opts.edit;
    this.detailSym.set(null);
    this.editingId.set(e?.id ?? null);
    this.tSide.set(e?.side ?? 'buy');
    this.tAccount.set(e?.accountId ?? (this.filter() || this.invAccounts()[0]?.id || ''));
    this.tDate.set(formatDate(e?.date ?? today(), this.store.settings().dateFormat));
    const sym = e?.symbol ?? opts.symbol ?? '';
    const listed = this.symbolItems().some((i) => i.id === sym);
    this.tSym.set(listed ? sym : null);
    this.tSymText.set(listed ? '' : sym);
    this.tQty.set(e && e.side !== 'dividend' ? String(e.quantity).replace('.', f.decimal) : '');
    this.tPrice.set(e ? formatMoney(e.price, f, { currency: false }) : opts.symbol ? this.lastPriceText(sym) : '');
    this.tFees.set(e ? (e.fees ? formatMoney(e.fees, f, { currency: false }) : '') : '');
    this.feesTouched.set(!!e);
    this.tradeOpen.set(true);
  }

  private lastPriceText(sym: string) {
    const p = this.store.prices().get(sym);
    return p ? formatMoney(p.price, this.store.format(), { currency: false }) : '';
  }

  protected setSide(s: Side) {
    this.tSide.set(s);
    if (s === 'dividend') { this.tQty.set(''); if (!this.feesTouched()) this.tFees.set(''); }
    this.recalcFee();
  }

  protected onPicked(it: ComboItem) {
    if (!this.tPrice().trim() && this.tSide() !== 'dividend') {
      this.tPrice.set(this.lastPriceText(it.id));
      this.recalcFee();
    }
  }

  protected recalcFee() {
    if (this.feesTouched() || this.tSide() === 'dividend') return;
    const q = this.tQtyN(), p = this.tPriceC();
    if (q === null || p === null) { this.tFees.set(''); return; }
    const fee = suggestFee(Math.round(q * p));
    this.tFees.set(fee ? formatMoney(fee, this.store.format(), { currency: false }) : '');
  }

  protected saveTrade() {
    if (!this.canSave()) return;
    const side = this.tSide();
    const sym = this.tSymbol();
    const date = this.tDateIso()!;
    const quantity = side === 'dividend' ? 0 : this.tQtyN()!;
    const price = this.tPriceC()!;
    const fees = this.tFeesC()!;
    const accountId = this.tAccount();
    const editing = this.editingId();
    const f = this.store.format();
    const verb = side === 'buy' ? 'Buy' : side === 'sell' ? 'Sell' : 'Dividend';
    const memo = side === 'dividend' ? `Dividend ${sym}` : `${verb} ${String(quantity).replace('.', f.decimal)} ${sym} @ ${formatMoney(price, f, { currency: false })}`;
    this.store.transact(editing ? 'Edit trade' : 'Record trade', () => {
      const prev = editing ? this.store.get<TradeX>(editing) : undefined;
      const txn = this.actions.saveTxn({
        id: prev?.txnId && this.store.get<Txn>(prev.txnId) ? prev.txnId : undefined,
        accountId, date, amount: tradeCash(side, quantity, price, fees), payeeName: sym, categoryId: null,
        memo, cleared: 'cleared', approved: true, source: 'manual',
      });
      this.store.put<TradeX>({ id: prev?.id ?? uid(), kind: 'trade', accountId, date, symbol: sym, side, quantity, price, fees, txnId: txn.id });
      this.syncValue();
    });
    this.tradeOpen.set(false);
    this.toasts.show(editing ? 'Trade updated' : 'Trade recorded');
  }

  protected deleteEditing() {
    const t = this.store.get<TradeX>(this.editingId());
    if (t && this.deleteTrade(t)) this.tradeOpen.set(false);
  }

  protected deleteTrade(t: TradeX): boolean {
    if (t.side === 'buy' && firstOversell(this.allTrades().filter((x) => x.id !== t.id))) {
      this.toasts.show('Cannot delete: later sells depend on this buy. Delete or edit those first.', undefined, 5500, 'error');
      return false;
    }
    this.store.transact('Delete trade', () => {
      if (t.txnId) this.actions.deleteTxns([t.txnId]);
      this.store.remove(t.id);
      this.syncValue();
    });
    this.toasts.show('Trade deleted', { label: 'Undo', run: () => this.store.undo() });
    return true;
  }

  // ------------------------------------------------------------ account value
  protected updateValue() {
    const n = this.store.transact('Update account value', () => this.syncValue());
    this.toasts.show(n ? 'Account value updated' : 'Account value is already up to date');
  }

  /**
   * Post ONE adjustment per investment account per day so that balance = cash + market value.
   * Works on live entities (store.allRaw) so it can run inside the same undoable step as the change that triggered it.
   */
  private syncValue(): number {
    const raw = this.store.allRaw().filter((e) => !e.deleted);
    const accounts = raw.filter((e): e is Account => e.kind === 'account' && e.type === 'investment' && !e.closed);
    const adjPayees = new Set(raw.filter((e): e is Payee => e.kind === 'payee' && e.name === ADJ_PAYEE).map((p) => p.id));
    const prices = new Map(raw.filter((e): e is Price => e.kind === 'price').map((p) => [p.symbol, p]));
    const trades = raw.filter((e): e is TradeX => e.kind === 'trade');
    const txns = raw.filter((e): e is Txn => e.kind === 'txn');
    const day = today();
    let changed = 0;
    for (const a of accounts) {
      const mine = txns.filter((t) => t.accountId === a.id);
      const adj = mine.filter((t) => isAdjustment({ payeeName: t.payeeId && adjPayees.has(t.payeeId) ? ADJ_PAYEE : null, memo: t.memo }));
      const cash = mine.filter((t) => !adj.includes(t)).reduce((s, t) => s + t.amount, 0);
      const working = mine.reduce((s, t) => s + t.amount, 0);
      const positions = computePositions(trades.filter((t) => t.accountId === a.id));
      const mv = valuePositions([...positions.values()], prices).reduce((s, v) => s + v.marketValue, 0);
      const existing = adj.find((t) => t.date === day);
      const next = todaysAdjustment(cash, mv, working, existing?.amount ?? 0);
      if (existing) {
        if (next === existing.amount) continue;
        if (next === 0) this.store.remove(existing.id);
        else this.actions.saveTxn({ id: existing.id, accountId: a.id, date: day, amount: next, payeeName: ADJ_PAYEE, categoryId: null, memo: ADJ_MEMO, cleared: 'cleared', approved: true, source: 'reconcile' });
        changed++;
      } else if (next !== 0) {
        this.actions.saveTxn({ accountId: a.id, date: day, amount: next, payeeName: ADJ_PAYEE, categoryId: null, memo: ADJ_MEMO, cleared: 'cleared', approved: true, source: 'reconcile' });
        changed++;
      }
    }
    return changed;
  }

  // ------------------------------------------------------------ prices
  protected openPrices() {
    const held = new Set<string>();
    for (const [s, p] of computePositions(this.allTrades())) if (p.quantity > 0) held.add(s);
    const fmt = this.store.settings().dateFormat;
    const prices = this.store.prices();
    this.pRows.set([...held].sort().map((symbol) => {
      const p = prices.get(symbol);
      return {
        symbol, name: p?.name ?? TICKER_NAMES.get(symbol) ?? '',
        price: p ? formatMoney(p.price, this.store.format(), { currency: false }) : '',
        date: formatDate(today(), fmt),
      };
    }));
    this.pPaste.set('');
    this.pricesOpen.set(true);
  }

  protected setRow(i: number, key: 'price' | 'date', value: string) {
    this.pRows.update((rows) => rows.map((r, j) => (j === i ? { ...r, [key]: value } : r)));
  }

  private upsertRow(symbol: string, cents: number, isoDate?: string) {
    const f = this.store.format();
    const date = formatDate(isoDate ?? today(), this.store.settings().dateFormat);
    const price = formatMoney(cents, f, { currency: false });
    this.pRows.update((rows) => {
      const i = rows.findIndex((r) => r.symbol === symbol);
      if (i >= 0) return rows.map((r, j) => (j === i ? { ...r, price, date: isoDate ? date : r.date } : r));
      return [...rows, { symbol, name: TICKER_NAMES.get(symbol) ?? '', price, date }];
    });
  }

  protected applyPaste() {
    const { rows, bad } = parsePastedPrices(this.pPaste());
    for (const r of rows) this.upsertRow(r.symbol, r.price);
    this.pPaste.set('');
    this.toasts.show(`Applied ${rows.length} price${rows.length === 1 ? '' : 's'}${bad ? `, ${bad} line${bad === 1 ? '' : 's'} not understood` : ''}`, undefined, 4500, bad ? 'error' : 'default');
  }

  protected async fetchQuotes() {
    const symbols = this.pRows().map((r) => r.symbol);
    if (!symbols.length) return;
    this.fetching.set(true);
    try {
      const res = await fetch('api/quotes?symbols=' + symbols.map(encodeURIComponent).join(','));
      if (!res.ok) throw new Error(String(res.status));
      const body = (await res.json()) as { quotes?: { symbol: string; price: number; date?: string; name?: string }[] };
      let n = 0;
      for (const q of body.quotes ?? []) {
        const sym = String(q.symbol ?? '').toUpperCase();
        if (!symbols.includes(sym) || !(q.price > 0)) continue;
        this.upsertRow(sym, Math.round(q.price * 100), q.date && /^\d{4}-\d{2}-\d{2}$/.test(q.date) ? q.date : today());
        if (q.name) this.pRows.update((rows) => rows.map((r) => (r.symbol === sym && !r.name ? { ...r, name: q.name! } : r)));
        n++;
      }
      this.toasts.show(n ? `Fetched ${n} quote${n === 1 ? '' : 's'}. Review and save.` : 'No quotes returned for your symbols');
    } catch {
      this.toasts.show("Automatic quotes aren't set up yet — enter prices manually", undefined, 5000, 'error');
    } finally {
      this.fetching.set(false);
    }
  }

  protected savePrices() {
    if (this.pPaste().trim()) this.applyPaste();
    const fmt = this.store.settings().dateFormat;
    const todo: { symbol: string; name: string; price: number; date: string }[] = [];
    for (const r of this.pRows()) {
      if (!r.price.trim()) continue;
      const price = parseMoney(r.price);
      const date = parseDate(r.date, fmt);
      if (price === null || price <= 0 || !date) {
        this.toasts.show(`Check the price or date for ${r.symbol}`, undefined, 4500, 'error');
        return;
      }
      todo.push({ symbol: r.symbol, name: r.name, price, date });
    }
    if (!todo.length) { this.pricesOpen.set(false); return; }
    this.store.transact('Update prices', () => {
      for (const q of todo) {
        const id = `p:${q.symbol}`;
        const cur = this.store.get<Price>(id);
        const merged = applyQuote(cur, q.price, q.date);
        this.store.put<Price>({ id, kind: 'price', symbol: q.symbol, name: q.name || cur?.name || undefined, ...merged });
      }
      this.syncValue();
    });
    this.pricesOpen.set(false);
    this.toasts.show(`Prices saved (${todo.length}). Account value updated.`);
  }
}
