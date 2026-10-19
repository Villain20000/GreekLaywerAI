import { Injectable } from '@angular/core';
import { BehaviorSubject, Observable } from 'rxjs';

export interface AppErrorNotification {
  message: string;
  timestamp: string;
}

/**
 * Holds the most recent unhandled error so the application shell can show a
 * dismissible banner without navigating away from the current page.
 */
@Injectable({ providedIn: 'root' })
export class ErrorNotifierService {
  private readonly errorSubject = new BehaviorSubject<AppErrorNotification | null>(null);

  readonly error$: Observable<AppErrorNotification | null> =
    this.errorSubject.asObservable();

  notify(error: AppErrorNotification): void {
    this.errorSubject.next(error);
  }

  dismiss(): void {
    if (this.errorSubject.value !== null) {
      this.errorSubject.next(null);
    }
  }
}
