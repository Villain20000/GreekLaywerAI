import { DestroyRef, Injectable, inject } from '@angular/core';
import { takeUntilDestroyed } from '@angular/core/rxjs-interop';
import { Title } from '@angular/platform-browser';
import {
  ActivatedRouteSnapshot,
  RouterStateSnapshot,
  TitleStrategy
} from '@angular/router';
import { TranslateService } from '@ngx-translate/core';
import { Subject, switchMap } from 'rxjs';

/**
 * 2-8 (i18n): translated document titles.
 *
 * Routes keep their visible Greek `title` (used as a no-JS fallback and
 * pinned by `app.routes.spec.ts`) and additionally declare a
 * `data.titleKey` pointing at `routes.*` in the translation files. This
 * strategy resolves that key with `TranslateService.stream`, so the tab
 * title re-renders both on navigation and when the user switches
 * language — without touching lazy loading or guards.
 */
@Injectable({ providedIn: 'root' })
export class TranslatedTitleStrategy extends TitleStrategy {
  private readonly title = inject(Title);
  private readonly translate = inject(TranslateService);
  private readonly destroyRef = inject(DestroyRef);
  private readonly titleKey$ = new Subject<string>();

  constructor() {
    super();
    this.titleKey$
      .pipe(
        switchMap((key) => this.translate.stream(key)),
        takeUntilDestroyed(this.destroyRef)
      )
      .subscribe((translated: string) => this.title.setTitle(translated));
  }

  override updateTitle(snapshot: RouterStateSnapshot): void {
    const key = this.findTitleKey(snapshot.root);
    if (key) this.titleKey$.next(key);
  }

  /** Deepest route declaring `data.titleKey` wins. */
  private findTitleKey(root: ActivatedRouteSnapshot): string | null {
    let node: ActivatedRouteSnapshot | null = root;
    let key: string | null = null;
    while (node) {
      const candidate = node.data?.['titleKey'];
      if (typeof candidate === 'string' && candidate.length > 0) {
        key = candidate;
      }
      node = node.firstChild;
    }
    return key;
  }
}
