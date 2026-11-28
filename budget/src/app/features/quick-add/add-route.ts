import { ChangeDetectionStrategy, Component, inject, OnInit } from '@angular/core';
import { ActivatedRoute, Router } from '@angular/router';
import { formatMoney, parseMoney } from '../../core/money';
import { Store } from '../../core/store';
import { UiState } from '../../ui/ui-state';

/**
 * Deep link for iOS Shortcuts / home-screen bookmarks:
 *   /budget/#/add?amount=45,50&payee=Carrefour&category=groceries&account=cash
 * Opens Quick add pre-filled, on top of the budget.
 */
@Component({ selector: 'app-add-route', template: '', changeDetection: ChangeDetectionStrategy.OnPush })
export class AddRoute implements OnInit {
  private route = inject(ActivatedRoute);
  private router = inject(Router);
  private ui = inject(UiState);
  private store = inject(Store);

  ngOnInit() {
    const p = this.route.snapshot.queryParamMap;
    const parts: string[] = [];
    if (p.get('payee')) parts.push(p.get('payee')!);
    const amt = parseMoney(p.get('amount') ?? '');
    if (amt) {
      const s = formatMoney(Math.abs(amt), this.store.format(), { currency: false }).replace(/\s| /g, '');
      parts.push((p.get('type') === 'in' ? '+' : '') + s);
    }
    if (p.get('category')) parts.push('#' + p.get('category')!.replace(/\s+/g, ''));
    if (p.get('account')) parts.push('@' + p.get('account')!.replace(/\s+/g, ''));
    this.ui.quickAddText.set(parts.join(' '));
    this.router.navigate(['/budget'], { replaceUrl: true }).then(() => this.ui.quickAdd.set(true));
  }
}
