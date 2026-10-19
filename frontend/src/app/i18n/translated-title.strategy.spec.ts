import { TestBed, fakeAsync, tick } from '@angular/core/testing';
import { RouterStateSnapshot, TitleStrategy } from '@angular/router';
import { Title } from '@angular/platform-browser';
import { TranslateService } from '@ngx-translate/core';
import { TranslatedTitleStrategy } from './translated-title.strategy';
import { lookupTranslation, provideTestTranslate } from './testing';
/**
 * Greek copy for a dictionary key. Throws when the key is missing so a
 * dictionary regression fails the spec loudly instead of silently
 * comparing against `undefined`.
 */
function elCopy(key: string): string {
  const raw = lookupTranslation('el', key);
  if (raw === undefined) {
    throw new Error(`Missing i18n key: ${key}`);
  }
  return raw;
}


/**
 * The routes keep their visible Greek `title` (no-JS fallback) and declare
 * a `data.titleKey`; this strategy resolves that key so the tab title
 * re-renders on navigation AND on a language switch.
 */
describe('TranslatedTitleStrategy', () => {
  let strategy: TranslatedTitleStrategy;
  let translate: TranslateService;

  /**
   * Minimal RouterStateSnapshot: the strategy only walks `root` and its
   * `firstChild` chain, reading `data.titleKey` on every level.
   */
  const snapshotOf = (
    ...titleKeys: (string | null)[]
  ): RouterStateSnapshot => {
    let node: unknown = null;
    for (let i = titleKeys.length - 1; i >= 0; i--) {
      const key = titleKeys[i];
      node = { data: key ? { titleKey: key } : {}, firstChild: node };
    }
    return { root: node } as unknown as RouterStateSnapshot;
  };

  beforeEach(() => {
    TestBed.configureTestingModule({
      providers: [...provideTestTranslate()]
    });
    strategy = TestBed.inject(TranslatedTitleStrategy);
    translate = TestBed.inject(TranslateService);
    TestBed.inject(Title).setTitle('');
  });

  it('should be created', () => {
    expect(strategy).toBeTruthy();
    expect(strategy instanceof TitleStrategy).toBeTrue();
  });

  it('sets the document title to the translated copy of the route titleKey', fakeAsync(() => {
    strategy.updateTitle(snapshotOf('routes.login'));
    tick();

    expect(TestBed.inject(Title).getTitle()).toBe(
      elCopy('routes.login')
    );
  }));

  it('the deepest route declaring a titleKey wins', fakeAsync(() => {
    strategy.updateTitle(snapshotOf('routes.landing', 'routes.login'));
    tick();

    expect(TestBed.inject(Title).getTitle()).toBe(
      elCopy('routes.login')
    );
  }));

  it('leaves the title untouched when no route declares a titleKey', fakeAsync(() => {
    strategy.updateTitle(snapshotOf(null));
    tick();

    expect(TestBed.inject(Title).getTitle()).toBe('');
  }));

  it('re-renders the title when the user switches language', fakeAsync(() => {
    strategy.updateTitle(snapshotOf('routes.login'));
    tick();
    expect(TestBed.inject(Title).getTitle()).toBe(
      elCopy('routes.login')
    );

    translate.use('en');
    tick();
    tick();

    expect(TestBed.inject(Title).getTitle()).toBe(
      (lookupTranslation('en', 'routes.login') as string)
    );
  }));

  it('re-renders the title when the same route is navigated to again', fakeAsync(() => {
    strategy.updateTitle(snapshotOf('routes.login'));
    tick();

    strategy.updateTitle(snapshotOf('routes.register'));
    tick();

    expect(TestBed.inject(Title).getTitle()).toBe(
      elCopy('routes.register')
    );
  }));
});
