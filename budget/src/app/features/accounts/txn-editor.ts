import { ChangeDetectionStrategy, Component, computed, inject } from '@angular/core';
import { Actions } from '../../core/actions';
import { Store } from '../../core/store';
import { Icon } from '../../ui/icon';
import { Sheet } from '../../ui/sheet';
import { Toasts } from '../../ui/toast';
import { UiState } from '../../ui/ui-state';
import { TxnForm } from './txn-form';

/** Full transaction form in a sheet (used on phones and from search/quick add "more options"). */
@Component({
  selector: 'app-txn-editor',
  imports: [Sheet, TxnForm, Icon],
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <app-sheet [open]="!!ui.txnEditor()" [title]="ui.txnEditor()?.id ? 'Edit transaction' : 'New transaction'" (closed)="ui.txnEditor.set(null)">
      @if (ui.txnEditor(); as e) {
        <app-txn-form layout="stack" [txnId]="e.id ?? null" [accountId]="e.accountId ?? null" (saved)="saved()" (cancelled)="ui.txnEditor.set(null)" />
        @if (e.id) {
          <button class="btn ghost danger del" type="button" (click)="remove(e.id)"><app-icon name="trash" [size]="15" /> Delete transaction</button>
        }
      }
    </app-sheet>`,
  styles: `.del { margin-top: 12px; width: 100%; }`,
})
export class TxnEditor {
  readonly ui = inject(UiState);
  private actions = inject(Actions);
  private store = inject(Store);
  private toasts = inject(Toasts);
  readonly isNew = computed(() => !this.ui.txnEditor()?.id);

  saved() {
    const wasNew = this.isNew();
    this.ui.txnEditor.set(null);
    if (wasNew) this.toasts.show('Transaction added', { label: 'Undo', run: () => this.store.undo() });
  }
  remove(id: string) {
    this.actions.deleteTxns([id]);
    this.ui.txnEditor.set(null);
    this.toasts.show('Transaction deleted', { label: 'Undo', run: () => this.store.undo() });
  }
}
