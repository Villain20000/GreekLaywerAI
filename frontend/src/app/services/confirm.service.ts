import { Injectable } from '@angular/core';
import { BehaviorSubject, Observable } from 'rxjs';

/**
 * Copy rendered by the shared <app-confirm-dialog>. Every destructive action
 * keeps the same Greek wording it used with the native `confirm()` prompt;
 * only the presentation changed.
 */
export interface ConfirmOptions {
  title: string;
  message?: string;
  confirmLabel?: string;
  cancelLabel?: string;
}

export interface ConfirmRequest extends Required<Pick<ConfirmOptions, 'title'>> {
  message: string;
  confirmLabel: string;
  cancelLabel: string;
}

interface PendingConfirm extends ConfirmRequest {
  resolve: (confirmed: boolean) => void;
}

/**
 * Single source of truth for in-app confirmations. A request is rendered once
 * by ConfirmDialogComponent in the app shell, so callers can simply
 * `await confirm.ask({...})` instead of blocking the browser with the native
 * (and inaccessible) `window.confirm()`.
 */
@Injectable({ providedIn: 'root' })
export class ConfirmService {
  private readonly requestSubject = new BehaviorSubject<ConfirmRequest | null>(null);
  /** Observable consumed by the one dialog instance in the app shell. */
  public readonly request$: Observable<ConfirmRequest | null> =
    this.requestSubject.asObservable();

  private pending: PendingConfirm | null = null;

  ask(options: ConfirmOptions): Promise<boolean> {
    // Only one confirmation can be on screen at a time. A second request
    // safely dismisses the first as "cancelled" rather than leaking a promise.
    this.pending?.resolve(false);

    return new Promise<boolean>((resolve) => {
      const request: PendingConfirm = {
        title: options.title,
        message: options.message ?? '',
        confirmLabel: options.confirmLabel ?? 'Επιβεβαίωση',
        cancelLabel: options.cancelLabel ?? 'Άκυρο',
        resolve
      };
      this.pending = request;
      this.requestSubject.next(this.toPublic(request));
    });
  }

  /** Resolve the open request. No-op when nothing is showing. */
  respond(confirmed: boolean): void {
    const request = this.pending;
    if (!request) return;
    this.pending = null;
    this.requestSubject.next(null);
    request.resolve(confirmed);
  }

  private toPublic(request: PendingConfirm): ConfirmRequest {
    return {
      title: request.title,
      message: request.message,
      confirmLabel: request.confirmLabel,
      cancelLabel: request.cancelLabel
    };
  }
}
