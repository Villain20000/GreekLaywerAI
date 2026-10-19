import { ErrorHandler, Injectable } from '@angular/core';
import { HttpClient } from '@angular/common/http';
import * as Sentry from '@sentry/browser';
import { EMPTY } from 'rxjs';
import { catchError, timeout } from 'rxjs/operators';
import { environment } from '../../environments/environment';
import { ErrorNotifierService } from './error-notifier.service';

export const ERROR_THROTTLE_WINDOW_MS = 5000;
export const ERROR_REPORT_TIMEOUT_MS = 5000;

interface ErrorReportPayload {
  message: string;
  stack: string;
  url: string;
  timestamp: string;
}

/**
 * Last-resort handler for errors that escaped application code (change
 * detection, unhandled promises, etc.). It never rethrows: the default
 * Angular behaviour of logging and continuing is preserved and extended with
 * a user-visible notification and an optional fire-and-forget report.
 */
@Injectable()
export class GlobalErrorHandler implements ErrorHandler {
  /** Fingerprint -> last notification time, used to suppress error storms. */
  private readonly lastNotified = new Map<string, number>();

  constructor(
    private readonly notifier: ErrorNotifierService,
    private readonly http: HttpClient
  ) {}

  handleError(error: unknown): void {
    try {
      const timestamp = new Date().toISOString();
      const message = this.extractMessage(error);
      const stack = this.extractStack(error);

      // Keep the original error object for the devtools stack, but always
      // include a timestamp in the log line.
      console.error(`[NomosAI][${timestamp}] Unhandled error:`, error);
      this.captureWithSentry(error);

      const fingerprint = `${message}\u0000${stack}`;
      const now = Date.now();
      const last = this.lastNotified.get(fingerprint);
      if (last !== undefined && now - last < ERROR_THROTTLE_WINDOW_MS) {
        return;
      }

      this.pruneThrottleMap(now);
      this.lastNotified.set(fingerprint, now);
      this.notifier.notify({ message, timestamp });

      if (environment.errorReportingUrl) {
        this.report({
          message: message.slice(0, 1000),
          stack: stack.slice(0, 4000),
          url: this.currentUrl(),
          timestamp
        });
      }
    } catch (handlerFailure) {
      // A failing error handler must never crash the application.
      try {
        console.error('[NomosAI] GlobalErrorHandler failed', handlerFailure);
      } catch {
        // Console unavailable; nothing else to do.
      }
    }
  }

  /** Best-effort Sentry capture; never allowed to disturb error handling. */
  private captureWithSentry(error: unknown): void {
    try {
      if (environment.sentryDsn) {
        Sentry.captureException(error);
      }
    } catch {
      // Reporting failures must not escape the global error handler.
    }
  }

  /** Fire-and-forget POST; failures and timeouts are intentionally ignored. */
  private report(payload: ErrorReportPayload): void {
    try {
      this.http
        .post<void>(environment.errorReportingUrl, payload)
        .pipe(
          timeout(ERROR_REPORT_TIMEOUT_MS),
          catchError(() => EMPTY)
        )
        .subscribe({ error: () => undefined });
    } catch {
      // Never propagate reporting failures back into the error handler.
    }
  }

  private extractMessage(error: unknown): string {
    if (typeof error === 'string') {
      return error;
    }
    if (error instanceof Error) {
      return error.message || error.name;
    }
    if (error !== null && typeof error === 'object') {
      const candidate = (error as { message?: unknown }).message;
      if (typeof candidate === 'string' && candidate.length > 0) {
        return candidate;
      }
      const reason = (error as { reason?: unknown }).reason;
      if (typeof reason === 'string' && reason.length > 0) {
        return reason;
      }
    }
    try {
      return String(error);
    } catch {
      return 'Unknown error';
    }
  }

  private extractStack(error: unknown): string {
    if (error instanceof Error && typeof error.stack === 'string') {
      return error.stack;
    }
    if (error !== null && typeof error === 'object') {
      const stack = (error as { stack?: unknown }).stack;
      if (typeof stack === 'string') {
        return stack;
      }
    }
    return '';
  }

  private currentUrl(): string {
    try {
      return typeof location !== 'undefined' ? location.href : '';
    } catch {
      return '';
    }
  }

  private pruneThrottleMap(now: number): void {
    if (this.lastNotified.size < 100) {
      return;
    }
    const cutoff = now - ERROR_THROTTLE_WINDOW_MS;
    this.lastNotified.forEach((seenAt, fingerprint) => {
      if (seenAt < cutoff) {
        this.lastNotified.delete(fingerprint);
      }
    });
    // Hard cap: never let a storm of unique errors grow the map unbounded.
    while (this.lastNotified.size >= 100) {
      const oldest = this.lastNotified.keys().next().value;
      if (oldest === undefined || !this.lastNotified.delete(oldest)) {
        break;
      }
    }
  }
}
