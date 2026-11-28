import { ChangeDetectionStrategy, Component, computed, input } from '@angular/core';
import { DomSanitizer } from '@angular/platform-browser';
import { inject } from '@angular/core';
import {
  ArrowDownLeft, ArrowLeftRight, ArrowUpRight, Banknote, ChartPie, Check, ChevronDown, ChevronLeft, ChevronRight, CircleAlert,
  CircleCheck, Cloud, CloudOff, Command, Copy, CreditCard, Download, EllipsisVertical, Eye, EyeOff, FileUp, Flag, GripVertical,
  House, Landmark, LayoutGrid, Lock, Menu, Moon, PiggyBank, Plus, Redo2, RefreshCw, Repeat, Search, Settings, Smartphone,
  Sparkles, SplitSquareVertical, Sun, Target, Trash2, Undo2, Upload, Wallet, X, Zap, Calendar, TrendingUp, Pencil, Lightbulb,
  CircleDollarSign, ListChecks, Scale,
} from 'lucide';

type IconNode = [string, Record<string, string | number>][];

// Icons from Lucide (ISC licence, https://lucide.dev).
const ICONS: Record<string, IconNode> = {
  'arrow-in': ArrowDownLeft, 'arrow-out': ArrowUpRight, transfer: ArrowLeftRight, cash: Banknote, chart: ChartPie, check: Check,
  'chevron-down': ChevronDown, 'chevron-left': ChevronLeft, 'chevron-right': ChevronRight, alert: CircleAlert, 'check-circle': CircleCheck,
  cloud: Cloud, 'cloud-off': CloudOff, command: Command, copy: Copy, card: CreditCard, download: Download, more: EllipsisVertical,
  eye: Eye, 'eye-off': EyeOff, import: FileUp, flag: Flag, grip: GripVertical, home: House, bank: Landmark, grid: LayoutGrid,
  lock: Lock, menu: Menu, moon: Moon, piggy: PiggyBank, plus: Plus, redo: Redo2, sync: RefreshCw, repeat: Repeat, search: Search,
  settings: Settings, phone: Smartphone, sparkles: Sparkles, split: SplitSquareVertical, sun: Sun, target: Target, trash: Trash2,
  undo: Undo2, upload: Upload, wallet: Wallet, x: X, zap: Zap, calendar: Calendar, trend: TrendingUp, edit: Pencil, idea: Lightbulb,
  money: CircleDollarSign, list: ListChecks, scale: Scale,
} as unknown as Record<string, IconNode>;

const esc = (v: string | number) => String(v).replace(/"/g, '&quot;');

@Component({
  selector: 'app-icon',
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `<span class="icon" [innerHTML]="svg()"></span>`,
  styles: `:host { display: inline-flex; flex: none; line-height: 0; } .icon { display: inline-flex; }`,
})
export class Icon {
  private san = inject(DomSanitizer);
  readonly name = input.required<string>();
  readonly size = input(18);
  readonly stroke = input(2);
  readonly svg = computed(() => {
    const node = ICONS[this.name()] ?? [];
    const inner = node.map(([tag, attrs]) => `<${tag} ${Object.entries(attrs).map(([k, v]) => `${k}="${esc(v)}"`).join(' ')}/>`).join('');
    const s = this.size();
    return this.san.bypassSecurityTrustHtml(
      `<svg xmlns="http://www.w3.org/2000/svg" width="${s}" height="${s}" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="${this.stroke()}" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${inner}</svg>`,
    );
  });
}
