import {
  Component,
  ElementRef,
  HostListener,
  OnDestroy,
  ViewChild
} from '@angular/core';
import { CommonModule } from '@angular/common';
import { Subscription } from 'rxjs';
import { ConfirmRequest, ConfirmService } from '../../services/confirm.service';

/**
 * Accessible replacement for native `window.confirm()`.
 *
 * Rendered exactly once in AppComponent so every caller of ConfirmService
 * shares the same modal. Behaviour:
 *   - role="dialog" + aria-modal="true", labelled by the title and described
 *     by the optional message;
 *   - initial focus lands on the least-destructive action (cancel);
 *   - Tab / Shift+Tab are trapped between the two action buttons;
 *   - Escape and a backdrop click cancel;
 *   - focus returns to the element that triggered the confirmation on close.
 */
@Component({
  selector: 'app-confirm-dialog',
  standalone: true,
  imports: [CommonModule],
  template: `
    <div
      *ngIf="confirm.request$ | async as request"
      class="nl-confirm-backdrop"
      (click)="onBackdropClick($event)"
    >
      <div
        #dialog
        class="nl-confirm-dialog"
        role="dialog"
        aria-modal="true"
        [attr.aria-labelledby]="titleId"
        [attr.aria-describedby]="request.message ? descriptionId : null"
        (keydown)="onDialogKeydown($event)"
      >
        <h2 class="nl-confirm-title" [id]="titleId">{{ request.title }}</h2>
        <p *ngIf="request.message" class="nl-confirm-message" [id]="descriptionId">
          {{ request.message }}
        </p>
        <div class="nl-confirm-actions">
          <button
            #cancelButton
            type="button"
            class="nl-btn-secondary"
            (click)="cancel()"
          >{{ request.cancelLabel }}</button>
          <button
            #confirmButton
            type="button"
            class="nl-btn-primary nl-confirm-danger"
            (click)="accept()"
          >{{ request.confirmLabel }}</button>
        </div>
      </div>
    </div>
  `,
  styles: []
})
export class ConfirmDialogComponent implements OnDestroy {
  @ViewChild('dialog') private dialog?: ElementRef<HTMLElement>;
  @ViewChild('cancelButton') private cancelButton?: ElementRef<HTMLButtonElement>;
  @ViewChild('confirmButton') private confirmButton?: ElementRef<HTMLButtonElement>;

  readonly titleId = 'nl-confirm-title';
  readonly descriptionId = 'nl-confirm-description';

  private readonly subscription: Subscription;
  private previouslyFocused: HTMLElement | null = null;
  private hasOpenRequest = false;

  constructor(public readonly confirm: ConfirmService) {
    this.subscription = this.confirm.request$.subscribe((request) => {
      if (request && !this.hasOpenRequest) {
        this.hasOpenRequest = true;
        this.previouslyFocused = this.activeElement();
        // Let Angular render the dialog before moving focus into it.
        setTimeout(() => this.focusInitialAction());
      } else if (!request && this.hasOpenRequest) {
        this.hasOpenRequest = false;
        const target = this.previouslyFocused;
        this.previouslyFocused = null;
        setTimeout(() => this.restoreFocus(target));
      }
    });
  }

  ngOnDestroy(): void {
    this.subscription.unsubscribe();
  }

  /** Backdrop clicks cancel; clicks inside the panel must not. */
  onBackdropClick(event: MouseEvent): void {
    if (event.target === event.currentTarget) this.cancel();
  }

  onDialogKeydown(event: KeyboardEvent): void {
    if (event.key === 'Escape') {
      event.preventDefault();
      event.stopPropagation();
      this.cancel();
      return;
    }
    if (event.key !== 'Tab') return;

    const focusable = this.focusableButtons();
    if (focusable.length === 0) return;

    const first = focusable[0];
    const last = focusable[focusable.length - 1];
    const active = document.activeElement as HTMLElement | null;
    const inside = !!active && !!this.dialog?.nativeElement.contains(active);

    if (event.shiftKey && (!inside || active === first)) {
      event.preventDefault();
      last.focus();
    } else if (!event.shiftKey && (!inside || active === last)) {
      event.preventDefault();
      first.focus();
    }
  }

  /**
   * Escape is handled at document level too so the dialog can be dismissed
   * even if focus was moved programmatically. The dialog-local handler stops
   * propagation, so this only fires for stray Escape presses while open.
   */
  @HostListener('document:keydown.escape')
  onDocumentEscape(): void {
    if (this.hasOpenRequest) this.cancel();
  }

  accept(): void {
    this.confirm.respond(true);
  }

  cancel(): void {
    this.confirm.respond(false);
  }

  private focusInitialAction(): void {
    if (!this.hasOpenRequest) return;
    const cancel = this.cancelButton?.nativeElement;
    if (cancel) {
      cancel.focus();
      return;
    }
    const fallback = this.dialog?.nativeElement.querySelector<HTMLElement>('button');
    fallback?.focus();
  }

  private focusableButtons(): HTMLElement[] {
    const dialog = this.dialog?.nativeElement;
    if (!dialog) return [];
    return Array.from(
      dialog.querySelectorAll<HTMLElement>('button:not([disabled])')
    );
  }

  private activeElement(): HTMLElement | null {
    const active = document.activeElement;
    return active instanceof HTMLElement ? active : null;
  }

  private restoreFocus(target: HTMLElement | null): void {
    if (target && target.isConnected && typeof target.focus === 'function') {
      target.focus();
    }
  }
}
