import { Component } from '@angular/core';
import { RouterLink } from '@angular/router';
import { TranslatePipe } from '@ngx-translate/core';

/**
 * 2-7: friendly 404 surface rendered by the `**` route. Before this the
 * wildcard silently redirected to the landing page, which hid broken links
 * and made the address bar lie about where the user was.
 */
@Component({
  selector: 'app-not-found',
  standalone: true,
  imports: [RouterLink, TranslatePipe],
  template: `
    <section class="not-found-page" aria-labelledby="not-found-title">
      <div class="not-found-card">
        <p class="not-found-code" aria-hidden="true">404</p>
        <h1 id="not-found-title">{{ 'notFound.title' | translate }}</h1>
        <p class="not-found-text">
          {{ 'notFound.text' | translate }}
        </p>
        <a routerLink="/" class="nl-btn-primary">{{ 'notFound.home' | translate }}</a>
      </div>
    </section>
  `,
  styles: [`
    :host { display: block; }
    .not-found-page {
      display: flex;
      align-items: center;
      justify-content: center;
      min-height: 60vh;
      padding: var(--nl-space-8) var(--nl-space-4);
      background: var(--nl-bg);
      color: var(--nl-fg);
    }
    .not-found-card {
      width: 100%;
      max-width: 520px;
      padding: var(--nl-space-12) var(--nl-space-8);
      text-align: center;
      background: var(--nl-bg-card);
      border: 1px solid var(--nl-border);
      border-radius: var(--nl-radius-lg);
      box-shadow: var(--nl-shadow-lg);
    }
    .not-found-code {
      margin: 0 0 var(--nl-space-3);
      color: var(--nl-fg-subtle);
      font-size: 3.5rem;
      font-weight: 700;
      line-height: 1;
      letter-spacing: -0.04em;
    }
    .not-found-card h1 {
      margin: 0 0 var(--nl-space-3);
      font-size: 1.6rem;
      font-weight: 500;
    }
    .not-found-text {
      margin: 0 0 var(--nl-space-6);
      color: var(--nl-fg-muted);
      font-size: 0.95rem;
      line-height: 1.6;
    }
  `]
})
export class NotFoundComponent {}
