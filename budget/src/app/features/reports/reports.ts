import { ChangeDetectionStrategy, Component, computed, inject, signal } from '@angular/core';
import { Store } from '../../core/store';
import { formatCompact, formatMoney } from '../../core/money';
import { addMonths, daysInMonth, monthDiff, monthName, monthOf, thisMonth, today, addDays } from '../../core/util';
import { Icon } from '../../ui/icon';
import { MoneyPipe } from '../../ui/money.pipe';
import { ageOfMoney, balancesAt, buildLines, niceScale, UNCAT } from './report-calc';
import { isCreditType } from '../../core/models';

type Tab = 'spending' | 'income' | 'networth' | 'trends';
type RangeKey = 'this' | '3' | '6' | 'ytd' | '12' | 'all';

interface TipRow { label: string; value: string; color?: string }
interface Tip { x: number; y: number; title: string; rows: TipRow[] }
interface Slice { key: string; label: string; value: number; pct: number; color: string; opacity: number; d: string; drillable: boolean }
interface IeRow {
  key: string; kind: 'head' | 'payee' | 'group' | 'cat' | 'sum' | 'net'; label: string; gid?: string;
  cells: number[]; total: number; avg: number; color?: string; expandable?: boolean;
}

const W = 640, H = 240, PL = 48, PR = 10, PT = 12, PB = 26;
const CX = 100, CY = 100, R = 78;

@Component({
  selector: 'app-reports',
  imports: [Icon, MoneyPipe],
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <div class="page">
      <header class="head">
        <h1>Reports</h1>
        <div class="seg tabs" role="tablist">
          @for (t of tabs; track t.key) {
            <button type="button" role="tab" [class.on]="tab() === t.key" [attr.aria-selected]="tab() === t.key" (click)="tab.set(t.key)">{{ t.label }}</button>
          }
        </div>
      </header>

      <div class="filters">
        <div class="chips" role="group" aria-label="Date range">
          @for (r of ranges; track r.key) {
            <button type="button" class="chip" [class.on]="range() === r.key" (click)="range.set(r.key)">{{ r.label }}</button>
          }
        </div>
        <select class="select acct" aria-label="Account" [value]="account()" (change)="account.set($any($event.target).value)">
          <option value="" [selected]="account() === ''">All budget accounts</option>
          @for (a of accountOptions(); track a.id) {
            <option [value]="a.id" [selected]="account() === a.id">{{ a.name }}{{ a.onBudget ? '' : ' (tracking)' }}</option>
          }
        </select>
      </div>

      @if (!hasData()) {
        <div class="card empty">
          <app-icon name="chart" [size]="32" />
          <h3>No data to report yet</h3>
          <p>Add a few transactions and your spending, income and net worth reports will appear here.</p>
        </div>
      } @else {
        @switch (tab()) {
          @case ('spending') {
            <div class="grid2">
              <section class="card card-pad">
                <div class="card-head">
                  <h2 class="section-title">{{ drillGroup() ? drillGroup()!.label : 'Spending by group' }}</h2>
                  @if (drillGroup()) {
                    <button type="button" class="btn sm ghost" (click)="drill.set(null)"><app-icon name="chevron-left" [size]="14" /> All groups</button>
                  }
                </div>
                @if (!slices().length) {
                  <p class="muted pad">No spending in this range.</p>
                } @else {
                  <div class="donut-wrap">
                    <svg viewBox="0 0 200 200" class="donut" role="img" [attr.aria-label]="'Spending ' + fmt(spendTotal())">
                      <circle class="track" [attr.cx]="cx" [attr.cy]="cy" [attr.r]="r" />
                      @for (s of slices(); track s.key) {
                        <path class="slice" [class.dim]="hover() !== null && hover() !== s.key" [class.click]="s.drillable"
                          [attr.d]="s.d" [style.stroke]="s.color" [style.stroke-opacity]="s.opacity"
                          (pointerenter)="hover.set(s.key); showTip($event, s.label, [{ label: pctText(s.pct), value: fmt(s.value), color: s.color }])"
                          (pointermove)="moveTip($event)" (pointerleave)="hover.set(null); hideTip()"
                          (click)="s.drillable && drill.set(s.key)" />
                      }
                      <text x="100" y="96" text-anchor="middle" class="d-total">{{ compact(spendTotal()) }}</text>
                      <text x="100" y="114" text-anchor="middle" class="d-sub">{{ drillGroup() ? 'in group' : 'spent' }}</text>
                    </svg>
                    <ul class="legend">
                      @for (s of slices(); track s.key) {
                        <li>
                          <button type="button" class="lg-row" [class.dim]="hover() !== null && hover() !== s.key" [disabled]="!s.drillable"
                            (click)="drill.set(s.key)" (pointerenter)="hover.set(s.key)" (pointerleave)="hover.set(null)">
                            <i class="dot" [style.background]="s.color" [style.opacity]="s.opacity"></i>
                            <span class="lg-name">{{ s.label }}</span>
                            <span class="lg-pct muted">{{ pctText(s.pct) }}</span>
                            <span class="num lg-amt">{{ s.value | money:'plain' }}</span>
                          </button>
                        </li>
                      }
                    </ul>
                  </div>
                  <p class="foot muted">Total <b class="num">{{ spendTotal() | money }}</b>, net of refunds.@if (!drillGroup()) { Click a group to see its categories. }</p>
                }
              </section>

              <section class="card card-pad">
                <h2 class="section-title">Spending per month</h2>
                <svg viewBox="0 0 640 240" class="chart" role="img" aria-label="Spending per month">
                  @for (t of spendBars().ticks; track t.y) {
                    <line class="grid" [attr.x1]="pl" [attr.x2]="640 - 10" [attr.y1]="t.y" [attr.y2]="t.y" />
                    <text class="ax" [attr.x]="pl - 6" [attr.y]="t.y + 3.5" text-anchor="end">{{ t.label }}</text>
                  }
                  @for (b of spendBars().bars; track b.key) {
                    <rect class="hit" [attr.x]="b.hx" [attr.y]="12" [attr.width]="b.hw" [attr.height]="202"
                      (pointerenter)="showTip($event, b.title, [{ label: 'Spent', value: fmt(b.value), color: 'var(--accent)' }])"
                      (pointermove)="moveTip($event)" (pointerleave)="hideTip()" />
                    <rect class="bar" [attr.x]="b.x" [attr.y]="b.y" [attr.width]="b.w" [attr.height]="b.h" rx="5" />
                    <text class="ax" [attr.x]="b.x + b.w / 2" [attr.y]="236" text-anchor="middle">{{ b.label }}</text>
                  }
                </svg>
              </section>
            </div>
          }

          @case ('income') {
            <section class="card card-pad">
              <h2 class="section-title">Income vs expense</h2>
              <div class="scroll">
                <table class="ie">
                  <thead>
                    <tr>
                      <th class="sticky"></th>
                      @for (m of monthCols(); track m.key) { <th class="num">{{ m.label }}</th> }
                      <th class="num strong">Average</th>
                      <th class="num strong">Total</th>
                    </tr>
                  </thead>
                  <tbody>
                    @for (row of visibleRows(); track row.key) {
                      <tr [class]="'r-' + row.kind">
                        <td class="sticky name" [style.padding-left.px]="row.kind === 'cat' ? 34 : row.kind === 'payee' ? 22 : 12">
                          @if (row.expandable) {
                            <button type="button" class="tog" [attr.aria-expanded]="openGroups().has(row.gid!)" (click)="toggleGroup(row.gid!)">
                              <span class="chev" [class.open]="openGroups().has(row.gid!)"><app-icon name="chevron-right" [size]="14" /></span>
                              <i class="dot" [style.background]="row.color"></i>{{ row.label }}
                            </button>
                          } @else { {{ row.label }} }
                        </td>
                        @if (row.kind === 'head') {
                          <td [attr.colspan]="monthCols().length + 2"></td>
                        } @else {
                          @for (v of row.cells; track $index) { <td class="num" [class]="cls(v)">{{ v ? (v | money:'plain') : '–' }}</td> }
                          <td class="num strong" [class]="cls(row.avg)">{{ row.avg ? (row.avg | money:'plain') : '–' }}</td>
                          <td class="num strong" [class]="cls(row.total)">{{ row.total ? (row.total | money:'plain') : '–' }}</td>
                        }
                      </tr>
                    }
                  </tbody>
                </table>
              </div>
            </section>
          }

          @case ('networth') {
            <section class="card card-pad">
              <div class="nw-head">
                <div>
                  <h2 class="section-title">Net worth</h2>
                  <div class="big num" [class.amt-neg]="nw().current < 0">{{ nw().current | money }}</div>
                </div>
                <div class="delta" [class.up]="nw().change >= 0" [class.down]="nw().change < 0">
                  <app-icon [name]="nw().change >= 0 ? 'trend' : 'arrow-out'" [size]="16" />
                  <span class="num">{{ nw().change | money:'sign' }}</span>
                  <span class="muted">since {{ nw().since }}</span>
                </div>
              </div>
              <div class="key">
                <span><i class="sw" style="background: var(--pos)"></i>Assets</span>
                <span><i class="sw" style="background: var(--neg)"></i>Debts</span>
                <span><i class="sw line"></i>Net worth</span>
              </div>
              <svg viewBox="0 0 640 240" class="chart" role="img" aria-label="Net worth over time">
                @for (t of nwChart().ticks; track t.y) {
                  <line class="grid" [class.zero]="t.v === 0" [attr.x1]="pl" [attr.x2]="640 - 10" [attr.y1]="t.y" [attr.y2]="t.y" />
                  <text class="ax" [attr.x]="pl - 6" [attr.y]="t.y + 3.5" text-anchor="end">{{ t.label }}</text>
                }
                @for (c of nwChart().cols; track c.key) {
                  <rect class="bar pos" [attr.x]="c.x" [attr.y]="c.ay" [attr.width]="c.w" [attr.height]="c.ah" rx="4" />
                  <rect class="bar neg" [attr.x]="c.x" [attr.y]="c.dy" [attr.width]="c.w" [attr.height]="c.dh" rx="4" />
                  <text class="ax" [attr.x]="c.x + c.w / 2" [attr.y]="236" text-anchor="middle">{{ c.label }}</text>
                }
                <path class="nwline" [attr.d]="nwChart().path" />
                @for (c of nwChart().cols; track c.key) {
                  <circle class="nwdot" [attr.cx]="c.x + c.w / 2" [attr.cy]="c.ny" r="3.5" />
                  <rect class="hit" [attr.x]="c.hx" [attr.y]="12" [attr.width]="c.hw" [attr.height]="202"
                    (pointerenter)="showTip($event, c.title, [{ label: 'Assets', value: fmt(c.assets), color: 'var(--pos)' }, { label: 'Debts', value: fmt(c.debts), color: 'var(--neg)' }, { label: 'Net worth', value: fmt(c.net), color: 'var(--ink)' }])"
                    (pointermove)="moveTip($event)" (pointerleave)="hideTip()" />
                }
              </svg>
            </section>
          }

          @case ('trends') {
            <div class="insights">
              <section class="card card-pad stat">
                <h2 class="section-title">Age of money</h2>
                @if (age() === null) { <div class="big">–</div><p class="muted">Not enough outflows yet.</p> }
                @else { <div class="big num">{{ age() }} <small>days</small></div><p class="muted">Average age of the cash behind your last 10 outflows (oldest money spent first).</p> }
              </section>
              <section class="card card-pad stat">
                <h2 class="section-title">Days of buffer</h2>
                @if (buffer() === null) { <div class="big">–</div><p class="muted">No spending in the last 90 days.</p> }
                @else { <div class="big num">{{ buffer() }} <small>days</small></div><p class="muted">{{ cash() | money }} in budget cash at your 90-day average of {{ dailySpend() | money }} a day.</p> }
              </section>
              <section class="card card-pad">
                <h2 class="section-title">Top 5 payees</h2>
                @if (!topPayees().length) { <p class="muted">No spending in this range.</p> }
                @for (p of topPayees(); track p.key) {
                  <div class="pr">
                    <div class="pr-top"><span class="pr-name">{{ p.label }}</span><span class="num">{{ p.value | money }}</span></div>
                    <div class="meter"><i [style.width.%]="p.share * 100"></i></div>
                  </div>
                }
              </section>
              <section class="card card-pad">
                <h2 class="section-title">On pace to overspend this month</h2>
                @if (!pace().length) { <p class="muted"><app-icon name="check-circle" [size]="16" /> Nothing is trending over budget. Nicely done.</p> }
                @for (p of pace(); track p.key) {
                  <div class="pr">
                    <div class="pr-top"><span class="pr-name">{{ p.label }}</span><span class="num amt-neg">+{{ p.over | money }}</span></div>
                    <div class="meter warn"><i [style.width.%]="p.spentPct"></i><b [style.left.%]="p.availPct"></b></div>
                    <div class="pr-sub muted">Spent {{ p.spent | money }} of {{ p.avail | money }}; pacing to {{ p.projected | money }}</div>
                  </div>
                }
              </section>
            </div>
          }
        }
      }

      @if (tip(); as t) {
        <div class="tip" [style.left.px]="t.x" [style.top.px]="t.y" role="tooltip">
          <div class="tip-title">{{ t.title }}</div>
          @for (r of t.rows; track r.label) {
            <div class="tip-row">@if (r.color) { <i class="dot" [style.background]="r.color"></i> }<span>{{ r.label }}</span><b class="num">{{ r.value }}</b></div>
          }
        </div>
      }
    </div>
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
    .page { max-width: 1100px; margin: 0 auto; padding: 24px 20px 48px; display: flex; flex-direction: column; gap: 18px; min-width: 0; }
    .head { display: flex; align-items: center; justify-content: space-between; gap: 12px 16px; flex-wrap: wrap; }
    .head h1 { font-size: 1.625rem; }
    .tabs { max-width: 100%; overflow-x: auto; scrollbar-width: none; }
    .tabs button { white-space: nowrap; transition: background .2s var(--ease), color .2s; }
    .filters { display: flex; gap: 10px 14px; align-items: center; justify-content: space-between; flex-wrap: wrap; }
    .chips { display: flex; gap: 6px; overflow-x: auto; max-width: 100%; padding: 2px; scrollbar-width: none; }
    .chip { flex: none; transition: background .2s var(--ease), color .2s, border-color .2s; }
    .chip:not(.on):hover { border-color: var(--ink-3); }
    .acct { width: auto; min-width: 190px; max-width: 100%; }
    .grid2 { display: grid; grid-template-columns: minmax(0, 1.25fr) minmax(0, 1fr); gap: 18px; align-items: start; }
    .card { animation: rise .35s var(--ease) both; min-width: 0; }
    .card-pad { padding: 22px; }
    @keyframes rise { from { opacity: 0; transform: translateY(6px); } to { opacity: 1; transform: none; } }
    .card-head { display: flex; align-items: center; justify-content: space-between; min-height: 28px; margin-bottom: 4px; }
    .card-head .section-title { margin: 0; }
    .pad { padding: 28px 0; text-align: center; }
    .foot { margin: 14px 0 0; font-size: 0.8125rem; }

    .donut-wrap { display: flex; flex-direction: column; align-items: center; gap: 18px; }
    .donut { width: 100%; max-width: 230px; height: auto; flex: none; overflow: visible; }
    .track { fill: none; stroke: var(--sunken); stroke-width: 26; }
    .slice { fill: none; stroke-width: 26; transition: opacity .2s, stroke-width .2s var(--ease), stroke-opacity .2s; }
    .slice.click { cursor: pointer; }
    .slice:hover { stroke-width: 31; }
    .slice.dim { opacity: .35; }
    .d-total { font: 650 1.25rem var(--display); fill: var(--ink); }
    .d-sub { font: 500 0.625rem var(--font); fill: var(--ink-3); text-transform: uppercase; letter-spacing: .08em; }
    .legend { list-style: none; margin: 0; padding: 0; width: 100%; display: flex; flex-direction: column; gap: 2px; }
    .lg-row { width: 100%; display: grid; grid-template-columns: 10px minmax(0, 1fr) auto auto; align-items: center; gap: 10px; border: 0; background: transparent; padding: 8px 10px; border-radius: 8px; cursor: pointer; text-align: left; transition: background .15s, opacity .2s; }
    .lg-row:hover:not(:disabled) { background: var(--sunken); }
    .lg-row:disabled { cursor: default; }
    .lg-row.dim .dot { opacity: .3; }
    .lg-name { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; font-weight: 550; }
    .lg-pct { font-size: 0.75rem; min-width: 34px; text-align: right; }
    .lg-amt { font-weight: 600; min-width: 64px; text-align: right; }
    .lg-row { gap: 8px; padding: 7px 8px; }
    .dot { display: inline-block; width: 10px; height: 10px; border-radius: 50%; flex: none; }

    .chart { width: 100%; height: auto; display: block; margin-top: 10px; overflow: visible; }
    .grid { stroke: var(--line); stroke-width: 1; }
    .grid.zero { stroke: var(--line-2); }
    .ax { font: 500 0.6562rem var(--font); fill: var(--ink-3); }
    .bar { fill: var(--accent); opacity: .85; transition: opacity .2s, filter .2s; }
    .bar.pos { fill: var(--pos); }
    .bar.neg { fill: var(--neg); }
    .hit { fill: transparent; cursor: default; }
    .hit:hover + .bar, .hit:hover ~ .bar { opacity: 1; }
    .nwline { fill: none; stroke: var(--ink); stroke-width: 2; stroke-linejoin: round; stroke-linecap: round; }
    .nwdot { fill: var(--surface); stroke: var(--ink); stroke-width: 2; }

    .nw-head { display: flex; justify-content: space-between; align-items: flex-end; gap: 12px; flex-wrap: wrap; }
    .big { font: 650 2rem/1.1 var(--display); letter-spacing: -.02em; }
    .big small { font-size: 0.9375rem; font-weight: 500; color: var(--ink-2); }
    .delta { display: inline-flex; align-items: center; gap: 6px; font-weight: 600; padding: 6px 12px; border-radius: 999px; background: var(--zero-soft); }
    .delta.up { background: var(--pos-soft); color: var(--pos); }
    .delta.down { background: var(--neg-soft); color: var(--neg); }
    .delta .muted { font-weight: 450; }
    .key { display: flex; gap: 16px; flex-wrap: wrap; margin-top: 14px; font-size: 0.7812rem; color: var(--ink-2); }
    .key span { display: inline-flex; align-items: center; gap: 6px; }
    .sw { width: 10px; height: 10px; border-radius: 3px; display: inline-block; }
    .sw.line { height: 2px; width: 14px; background: var(--ink); border-radius: 2px; }

    .scroll { overflow-x: auto; margin: 0 -22px; padding: 0 22px; }
    table.ie { border-collapse: separate; border-spacing: 0; width: 100%; font-size: 0.8438rem; }
    .ie th, .ie td { padding: 9px 12px; border-bottom: 1px solid var(--line); text-align: right; white-space: nowrap; }
    .ie th { font: 650 0.6875rem var(--font); text-transform: uppercase; letter-spacing: .06em; color: var(--ink-3); border-bottom-color: var(--line-2); }
    .ie td.name, .ie th.sticky { text-align: left; }
    .ie .sticky { position: sticky; left: 0; background: var(--surface); z-index: 1; min-width: 170px; max-width: 220px; overflow: hidden; text-overflow: ellipsis; }
    .ie .strong { font-weight: 650; }
    .ie tbody tr { transition: background .15s; }
    .ie tbody tr:hover td, .ie tbody tr:hover .sticky { background: var(--surface-2); }
    .r-head td { padding-top: 18px; font: 650 0.6875rem var(--font); text-transform: uppercase; letter-spacing: .08em; color: var(--ink-3); border-bottom: 0; }
    .r-sum td { font-weight: 650; background: var(--surface-2); }
    .r-sum .sticky { background: var(--surface-2); }
    .r-net td { font-weight: 700; border-top: 2px solid var(--line-2); border-bottom: 0; font-size: 0.9062rem; }
    .r-group td { font-weight: 600; }
    .r-cat td { color: var(--ink-2); }
    .tog { display: inline-flex; align-items: center; gap: 8px; border: 0; background: transparent; cursor: pointer; padding: 0; font-weight: 600; }
    .chev { display: inline-flex; transition: transform .2s var(--ease); color: var(--ink-3); }
    .chev.open { transform: rotate(90deg); }
    .pos { color: var(--pos); }
    .neg { color: var(--neg); }
    .zero { color: var(--ink-3); }

    .insights { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: 18px; align-items: start; }
    .stat p { margin: 10px 0 0; font-size: 0.8438rem; }
    .pr { margin-top: 14px; }
    .pr:first-of-type { margin-top: 4px; }
    .pr-top { display: flex; justify-content: space-between; gap: 12px; font-weight: 550; margin-bottom: 6px; }
    .pr-name { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
    .pr-sub { font-size: 0.75rem; margin-top: 5px; }
    .meter { position: relative; height: 8px; background: var(--sunken); border-radius: 99px; overflow: visible; }
    .meter i { display: block; height: 100%; background: var(--accent); border-radius: 99px; transition: width .5s var(--ease); }
    .meter.warn i { background: var(--warn); }
    .meter b { position: absolute; top: -3px; width: 2px; height: 14px; background: var(--ink-2); border-radius: 2px; }

    .tip { position: fixed; z-index: 50; pointer-events: none; background: var(--ink); color: var(--bg); padding: 8px 11px; border-radius: 9px; font-size: 0.7812rem; box-shadow: var(--shadow-2); min-width: 120px; animation: rise .12s var(--ease); }
    .tip-title { font-weight: 650; margin-bottom: 3px; }
    .tip-row { display: flex; align-items: center; gap: 7px; }
    .tip-row span { flex: 1; opacity: .8; }
    .tip-row .dot { width: 8px; height: 8px; }

    @media (max-width: 860px) {
      .grid2, .insights { grid-template-columns: minmax(0, 1fr); }
    }
    @media (min-width: 640px) {
      .donut-wrap { flex-direction: row; align-items: center; }
      .legend { flex: 1; min-width: 0; }
    }
    @media (max-width: 639px) {
      .page { padding: 16px 16px 40px; }
      .card-pad { padding: 16px; }
      .scroll { margin: 0 -16px; padding: 0 16px; }
      .acct { width: 100%; }
      .big { font-size: 1.6875rem; }
    }
  `,
})
export class Reports {
  protected readonly store = inject(Store);

  protected readonly tabs: { key: Tab; label: string }[] = [
    { key: 'spending', label: 'Spending' },
    { key: 'income', label: 'Income vs expense' },
    { key: 'networth', label: 'Net worth' },
    { key: 'trends', label: 'Insights' },
  ];
  protected readonly ranges: { key: RangeKey; label: string }[] = [
    { key: 'this', label: 'This month' },
    { key: '3', label: 'Last 3 months' },
    { key: '6', label: 'Last 6 months' },
    { key: 'ytd', label: 'This year' },
    { key: '12', label: 'Last 12 months' },
    { key: 'all', label: 'All time' },
  ];
  protected readonly pl = PL;
  protected readonly cx = CX;
  protected readonly cy = CY;
  protected readonly r = R;

  protected readonly tab = signal<Tab>('spending');
  protected readonly range = signal<RangeKey>('6');
  protected readonly account = signal('');
  protected readonly drill = signal<string | null>(null);
  protected readonly hover = signal<string | null>(null);
  protected readonly tip = signal<Tip | null>(null);
  protected readonly openGroups = signal<Set<string>>(new Set());

  protected readonly hasData = computed(() => this.store.txns().length > 0);
  protected readonly accountOptions = computed(() => this.store.accounts().filter((a) => !a.closed));
  private readonly acctFilter = computed(() => this.account() || null);

  // ------------------------------------------------------------ shared data
  private readonly lines = computed(() => buildLines(this.store.txns(), this.store.accountMap(), this.acctFilter()));

  protected readonly months = computed<string[]>(() => {
    const cur = thisMonth();
    let first: string;
    switch (this.range()) {
      case 'this': first = cur; break;
      case '3': first = addMonths(cur, -2); break;
      case '6': first = addMonths(cur, -5); break;
      case '12': first = addMonths(cur, -11); break;
      case 'ytd': first = cur.slice(0, 4) + '-01'; break;
      default: {
        let min = cur;
        for (const t of this.store.txns()) { const m = monthOf(t.date); if (m < min) min = m; }
        first = min;
      }
    }
    const n = Math.max(1, monthDiff(first, cur) + 1);
    return Array.from({ length: n }, (_, i) => addMonths(first, i));
  });
  private readonly monthIdx = computed(() => new Map(this.months().map((m, i) => [m, i])));
  protected readonly monthCols = computed(() => {
    const ms = this.months();
    const multiYear = ms[0].slice(0, 4) !== ms[ms.length - 1].slice(0, 4);
    return ms.map((m) => ({ key: m, label: monthName(m, true) + (multiYear ? ` ’${m.slice(2, 4)}` : '') }));
  });

  // ------------------------------------------------------------ names + colours
  private readonly groupIndex = computed(() => {
    const idx = new Map<string, number>();
    let i = 0;
    for (const g of this.store.groups()) idx.set(g.id, i++ % 9);
    return idx;
  });
  private groupOf(categoryId: string): string {
    return this.store.categoryMap().get(categoryId)?.groupId ?? UNCAT;
  }
  private groupName(gid: string) { return gid === UNCAT ? 'Uncategorized' : this.store.groupMap().get(gid)?.name ?? 'Other'; }
  private groupColor(gid: string) { const i = this.groupIndex().get(gid); return i === undefined ? 'var(--g9)' : `var(--g${i})`; }
  private catName(id: string) { return id === UNCAT ? 'Uncategorized' : this.store.categoryMap().get(id)?.name ?? 'Unknown'; }
  private payeeName(id: string | null) { return (id && this.store.payeeMap().get(id)?.name) || 'No payee'; }

  protected fmt = (v: number) => formatMoney(v, this.store.format());
  protected compact = (v: number) => formatCompact(v, this.store.format());
  protected pctText(p: number) { return p > 0 && p < 0.01 ? '<1%' : Math.round(p * 100) + '%'; }
  protected cls(v: number) { return v > 0 ? 'pos' : v < 0 ? 'neg' : 'zero'; }

  // ------------------------------------------------------------ tooltip
  protected showTip(ev: PointerEvent, title: string, rows: TipRow[]) {
    this.tip.set({ ...this.place(ev), title, rows });
  }
  protected moveTip(ev: PointerEvent) {
    const t = this.tip();
    if (t) this.tip.set({ ...t, ...this.place(ev) });
  }
  protected hideTip() { this.tip.set(null); }
  private place(ev: PointerEvent) {
    const vw = typeof window !== 'undefined' ? window.innerWidth : 1000;
    return { x: Math.max(8, Math.min(ev.clientX + 14, vw - 210)), y: Math.max(8, ev.clientY - 56) };
  }

  // ------------------------------------------------------------ spending
  private readonly rangeSpend = computed(() => {
    const idx = this.monthIdx();
    return this.lines().spend.filter((l) => idx.has(l.month));
  });

  /** group id -> { total, cats } for the range, net of refunds */
  private readonly byGroup = computed(() => {
    const out = new Map<string, { total: number; cats: Map<string, number> }>();
    for (const l of this.rangeSpend()) {
      const gid = this.groupOf(l.categoryId);
      const g = out.get(gid) ?? { total: 0, cats: new Map() };
      g.total += l.amount;
      g.cats.set(l.categoryId, (g.cats.get(l.categoryId) ?? 0) + l.amount);
      out.set(gid, g);
    }
    return out;
  });

  protected readonly drillGroup = computed(() => {
    const id = this.drill();
    return id && this.byGroup().has(id) ? { id, label: this.groupName(id) } : null;
  });

  protected readonly slices = computed<Slice[]>(() => {
    const dg = this.drillGroup();
    let items: { key: string; label: string; value: number; color: string; opacity: number; drillable: boolean }[];
    if (dg) {
      const g = this.byGroup().get(dg.id)!;
      const cats = [...g.cats].filter(([, v]) => v > 0).sort((a, b) => b[1] - a[1]);
      items = cats.map(([id, v], i) => ({
        key: id, label: this.catName(id), value: v, color: this.groupColor(dg.id),
        opacity: cats.length > 1 ? 1 - (i / (cats.length - 1)) * 0.6 : 1, drillable: false,
      }));
    } else {
      items = [...this.byGroup()].filter(([, g]) => g.total > 0).sort((a, b) => b[1].total - a[1].total)
        .map(([id, g]) => ({ key: id, label: this.groupName(id), value: g.total, color: this.groupColor(id), opacity: 1, drillable: true }));
    }
    const total = items.reduce((a, b) => a + b.value, 0);
    if (!total) return [];
    let angle = -Math.PI / 2;
    const gap = items.length > 1 ? 0.025 : 0;
    return items.map((it) => {
      const frac = it.value / total;
      const sweep = frac * Math.PI * 2;
      const a0 = angle + gap / 2, a1 = angle + sweep - gap / 2;
      angle += sweep;
      return { ...it, pct: frac, d: this.arc(a0, Math.max(a0 + 0.001, a1), frac) };
    });
  });
  protected readonly spendTotal = computed(() => this.slices().reduce((a, s) => a + s.value, 0));

  private arc(a0: number, a1: number, frac: number) {
    const pt = (a: number) => `${(CX + R * Math.cos(a)).toFixed(2)} ${(CY + R * Math.sin(a)).toFixed(2)}`;
    if (frac > 0.9995) {
      return `M ${pt(-Math.PI / 2)} A ${R} ${R} 0 1 1 ${pt(Math.PI / 2)} A ${R} ${R} 0 1 1 ${pt(-Math.PI / 2)}`;
    }
    return `M ${pt(a0)} A ${R} ${R} 0 ${a1 - a0 > Math.PI ? 1 : 0} 1 ${pt(a1)}`;
  }

  private xLabel(m: string, n: number) {
    return monthName(m, true) + (n > 12 && m.endsWith('-01') ? ` ’${m.slice(2, 4)}` : '');
  }
  private labelStep(n: number) { return n > 24 ? 4 : n > 14 ? 2 : 1; }

  protected readonly spendBars = computed(() => {
    const ms = this.months();
    const vals = ms.map(() => 0);
    const idx = this.monthIdx();
    for (const l of this.rangeSpend()) vals[idx.get(l.month)!] += l.amount;
    const sc = niceScale(0, Math.max(...vals, 0));
    const innerW = W - PL - PR, innerH = H - PT - PB;
    const y = (v: number) => PT + innerH - ((v - sc.lo) / (sc.hi - sc.lo)) * innerH;
    const band = innerW / ms.length;
    const bw = Math.min(band * 0.62, 46);
    const step = this.labelStep(ms.length);
    return {
      ticks: sc.ticks.map((v) => ({ y: y(v), label: this.compact(v) })),
      bars: ms.map((m, i) => {
        const v = Math.max(0, vals[i]);
        const x = PL + band * i + (band - bw) / 2;
        const top = y(v);
        return {
          key: m, x, w: bw, y: v ? top : y(0) - 1, h: v ? y(0) - top : 1, value: vals[i],
          hx: PL + band * i, hw: band, title: `${monthName(m)} ${m.slice(0, 4)}`,
          label: i % step === 0 ? this.xLabel(m, ms.length) : '',
        };
      }),
    };
  });

  // ------------------------------------------------------------ income vs expense
  private readonly ieRows = computed<IeRow[]>(() => {
    const n = this.months().length;
    const idx = this.monthIdx();
    const zeros = () => new Array<number>(n).fill(0);
    const mk = (key: string, kind: IeRow['kind'], label: string, cells: number[], extra: Partial<IeRow> = {}): IeRow => {
      const total = cells.reduce((a, b) => a + b, 0);
      return { key, kind, label, cells, total, avg: total / n, ...extra };
    };
    const rows: IeRow[] = [];

    const payees = new Map<string, number[]>();
    for (const l of this.lines().income) {
      const i = idx.get(l.month);
      if (i === undefined) continue;
      const k = l.payeeId ?? '';
      const arr = payees.get(k) ?? zeros();
      arr[i] += l.amount;
      payees.set(k, arr);
    }
    const sumArr = (arrs: number[][]) => arrs.reduce((acc, a) => acc.map((v, i) => v + a[i]), zeros());
    const sorted = <T>(m: Map<string, T>, tot: (v: T) => number) => [...m].sort((a, b) => tot(b[1]) - tot(a[1]));
    const incomeRows = sorted(payees, (a) => a.reduce((x, y) => x + y, 0))
      .map(([k, cells]) => mk('p:' + k, 'payee', this.payeeName(k || null), cells));
    rows.push(mk('h-in', 'head', 'Income', zeros()));
    rows.push(...incomeRows);
    const incomeTotal = sumArr(incomeRows.map((r) => r.cells));
    rows.push(mk('t-in', 'sum', 'Total income', incomeTotal));

    const groups = new Map<string, Map<string, number[]>>();
    for (const l of this.lines().spend) {
      const i = idx.get(l.month);
      if (i === undefined) continue;
      const gid = this.groupOf(l.categoryId);
      const cats = groups.get(gid) ?? new Map<string, number[]>();
      const arr = cats.get(l.categoryId) ?? zeros();
      arr[i] -= l.amount; // expenses shown negative
      cats.set(l.categoryId, arr);
      groups.set(gid, cats);
    }
    rows.push(mk('h-ex', 'head', 'Expenses', zeros()));
    const gSorted = sorted(groups, (cats) => [...cats.values()].reduce((a, c) => a + c.reduce((x, y) => x + y, 0), 0)).reverse();
    const groupCells: number[][] = [];
    for (const [gid, cats] of gSorted.reverse().reverse()) {
      const cSorted = [...cats].sort((a, b) => a[1].reduce((x, y) => x + y, 0) - b[1].reduce((x, y) => x + y, 0));
      const cells = sumArr(cSorted.map(([, c]) => c));
      groupCells.push(cells);
      rows.push(mk('g:' + gid, 'group', this.groupName(gid), cells, { gid, color: this.groupColor(gid), expandable: true }));
      for (const [cid, c] of cSorted) rows.push(mk(`c:${gid}:${cid}`, 'cat', this.catName(cid), c, { gid }));
    }
    const expenseTotal = sumArr(groupCells);
    rows.push(mk('t-ex', 'sum', 'Total expenses', expenseTotal));
    rows.push(mk('net', 'net', 'Net income', incomeTotal.map((v, i) => v + expenseTotal[i])));
    return rows;
  });
  protected readonly visibleRows = computed(() => {
    const open = this.openGroups();
    return this.ieRows().filter((r) => r.kind !== 'cat' || open.has(r.gid!));
  });
  protected toggleGroup(gid: string) {
    this.openGroups.update((s) => { const n = new Set(s); n.has(gid) ? n.delete(gid) : n.add(gid); return n; });
  }

  // ------------------------------------------------------------ net worth
  private readonly nwAccounts = computed(() => {
    const f = this.acctFilter();
    return this.store.accounts().filter((a) => !f || a.id === f);
  });
  private netAt(date: string) {
    const bal = balancesAt(this.store.txns(), date);
    let assets = 0, debts = 0;
    for (const a of this.nwAccounts()) {
      const v = bal.get(a.id) ?? 0;
      if (v >= 0) assets += v; else debts += v;
    }
    return { assets, debts, net: assets + debts };
  }

  protected readonly nw = computed(() => {
    const ms = this.months();
    const last = this.netAt(ms[ms.length - 1] + '-31');
    const before = this.netAt(addDays(ms[0] + '-01', -1));
    return { current: last.net, change: last.net - before.net, since: this.sinceLabel(ms[0]) };
  });
  private sinceLabel(m: string) { return `${monthName(m, true)} ${m.slice(0, 4)}`; }

  protected readonly nwChart = computed(() => {
    const ms = this.months();
    const pts = ms.map((m) => ({ m, ...this.netAt(m + '-31') }));
    const sc = niceScale(Math.min(0, ...pts.map((p) => Math.min(p.debts, p.net))), Math.max(0, ...pts.map((p) => Math.max(p.assets, p.net))));
    const innerW = W - PL - PR, innerH = H - PT - PB;
    const y = (v: number) => PT + innerH - ((v - sc.lo) / (sc.hi - sc.lo)) * innerH;
    const band = innerW / ms.length;
    const bw = Math.min(band * 0.6, 44);
    const step = this.labelStep(ms.length);
    const zero = y(0);
    const cols = pts.map((p, i) => {
      const x = PL + band * i + (band - bw) / 2;
      const ay = y(p.assets), dy2 = y(p.debts);
      return {
        key: p.m, x, w: bw, ay, ah: Math.max(0, zero - ay), dy: zero, dh: Math.max(0, dy2 - zero), ny: y(p.net),
        assets: p.assets, debts: p.debts, net: p.net, hx: PL + band * i, hw: band,
        title: `End of ${monthName(p.m)} ${p.m.slice(0, 4)}`, label: i % step === 0 ? this.xLabel(p.m, ms.length) : '',
      };
    });
    const path = cols.map((c, i) => `${i ? 'L' : 'M'} ${(c.x + c.w / 2).toFixed(1)} ${c.ny.toFixed(1)}`).join(' ');
    return { ticks: sc.ticks.map((v) => ({ v, y: y(v), label: this.compact(v) })), cols, path };
  });

  // ------------------------------------------------------------ insights
  private readonly allLines = computed(() => buildLines(this.store.txns(), this.store.accountMap(), null));

  protected readonly age = computed(() => ageOfMoney(this.store.txns(), this.store.accountMap()));

  protected readonly cash = computed(() => {
    const am = this.store.accountMap();
    let s = 0;
    for (const t of this.store.txns()) {
      const a = am.get(t.accountId);
      if (a && a.onBudget && !isCreditType(a.type)) s += t.amount;
    }
    return s;
  });
  protected readonly dailySpend = computed(() => {
    const since = addDays(today(), -90);
    let s = 0;
    for (const l of this.allLines().spend) if (l.date > since) s += l.amount;
    return Math.max(0, s / 90);
  });
  protected readonly buffer = computed(() => {
    const d = this.dailySpend();
    return d > 0 ? Math.max(0, Math.round(this.cash() / d)) : null;
  });

  protected readonly topPayees = computed(() => {
    const m = new Map<string, number>();
    for (const l of this.rangeSpend()) m.set(l.payeeId ?? '', (m.get(l.payeeId ?? '') ?? 0) + l.amount);
    const top = [...m].filter(([, v]) => v > 0).sort((a, b) => b[1] - a[1]).slice(0, 5);
    const max = top[0]?.[1] || 1;
    return top.map(([k, v]) => ({ key: k, label: this.payeeName(k || null), value: v, share: v / max }));
  });

  protected readonly pace = computed(() => {
    const cm = thisMonth();
    const day = Math.max(1, Number(today().slice(8, 10)));
    const dim = daysInMonth(cm);
    const snap = this.store.budget();
    const out: { key: string; label: string; spent: number; avail: number; projected: number; over: number; spentPct: number; availPct: number }[] = [];
    for (const c of this.store.categories()) {
      if (c.hidden || c.ccAccountId || this.store.groupMap().get(c.groupId)?.system) continue;
      const cat = snap.cat(cm, c.id);
      const spent = Math.max(0, -cat.activity);
      const avail = cat.assigned + cat.carry;
      if (spent <= 0) continue;
      const projected = Math.round((spent / day) * dim);
      if (projected <= Math.max(0, avail)) continue;
      const scale = Math.max(projected, 1);
      out.push({
        key: c.id, label: c.name, spent, avail: Math.max(0, avail), projected, over: projected - Math.max(0, avail),
        spentPct: Math.min(100, (spent / scale) * 100), availPct: Math.min(100, (Math.max(0, avail) / scale) * 100),
      });
    }
    return out.sort((a, b) => b.over - a.over).slice(0, 8);
  });
}
