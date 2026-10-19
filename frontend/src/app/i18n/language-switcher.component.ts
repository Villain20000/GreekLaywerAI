import { Component, inject } from '@angular/core';
import { TranslatePipe } from '@ngx-translate/core';
import { AppLanguage, LanguageService } from './language.service';

/**
 * 2-8 (i18n): accessible EL/EN toggle.
 *
 * Rendered inside <app-menu> for authenticated surfaces and once more by
 * AppComponent on menu-less (public) routes, so language switching works
 * logged-out too. Native <button> elements keep it keyboard-operable;
 * `aria-pressed` exposes the active language.
 */
@Component({
  selector: 'app-language-switcher',
  standalone: true,
  imports: [TranslatePipe],
  template: `
    <div
      class="nl-language-switcher"
      role="group"
      [attr.aria-label]="'language.label' | translate"
    >
      <button
        type="button"
        class="nl-lang-btn"
        [class.active]="language.current() === 'el'"
        [attr.aria-pressed]="language.current() === 'el'"
        [attr.title]="'language.greek' | translate"
        (click)="select('el')"
      >{{ 'language.el' | translate }}</button>
      <button
        type="button"
        class="nl-lang-btn"
        [class.active]="language.current() === 'en'"
        [attr.aria-pressed]="language.current() === 'en'"
        [attr.title]="'language.english' | translate"
        (click)="select('en')"
      >{{ 'language.en' | translate }}</button>
    </div>
  `,
  // 2-8: visual surface lives in src/styles.scss (.nl-language-switcher /
  // .nl-lang-btn) so the anyComponentStyle budget stays untouched.
  styles: []
})
export class LanguageSwitcherComponent {
  public readonly language = inject(LanguageService);

  public select(lang: AppLanguage): void {
    void this.language.setLanguage(lang);
  }
}
