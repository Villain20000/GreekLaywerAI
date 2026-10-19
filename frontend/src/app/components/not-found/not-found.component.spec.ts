import { TestBed } from '@angular/core/testing';
import { provideRouter } from '@angular/router';
import { By } from '@angular/platform-browser';
import { NotFoundComponent } from './not-found.component';
import { lookupTranslation, provideTestTranslate } from '../../i18n/testing';

/**
 * Greek copy for a dictionary key.
 *
 * Throws when the key is missing so a dictionary regression fails the spec
 * loudly instead of silently comparing against `undefined`.
 */
function elCopy(key: string): string {
  const raw = lookupTranslation('el', key);
  if (raw === undefined) {
    throw new Error(`Missing i18n key: ${key}`);
  }
  return raw;
}

describe('NotFoundComponent', () => {
  beforeEach(async () => {
    await TestBed.configureTestingModule({
      imports: [NotFoundComponent],
      // 2-8 (i18n): the 404 template uses the `translate` pipe, so the spec
      // needs the ngx-translate providers (TranslateStore is not
      // `providedIn: 'root'` in @ngx-translate/core@16).
      providers: [provideRouter([]), ...provideTestTranslate()]
    }).compileComponents();
  });

  it('renders the Greek not-found heading and explanation', () => {
    const fixture = TestBed.createComponent(NotFoundComponent);
    fixture.detectChanges();

    const heading = fixture.debugElement.query(By.css('h1'));
    // The 404 surface is Greek-only: pin both the dictionary copy AND the
    // key the template renders, so the page can never regress to the
    // pre-i18n English strings.
    expect(elCopy('notFound.title')).toBe('Η σελίδα δεν βρέθηκε');
    expect(heading.nativeElement.textContent).toContain(elCopy('notFound.title'));
    expect(fixture.nativeElement.textContent).toContain(elCopy('notFound.text'));
    expect(fixture.nativeElement.textContent).toContain('404');
  });

  it('offers a link back to the home page', () => {
    const fixture = TestBed.createComponent(NotFoundComponent);
    fixture.detectChanges();

    const homeLink = fixture.debugElement.query(By.css('a[routerLink]'));
    expect(homeLink).not.toBeNull();
    expect(homeLink.nativeElement.getAttribute('href')).toBe('/');
    expect(elCopy('notFound.home')).toBe('Επιστροφή στην αρχική');
    expect(homeLink.nativeElement.textContent).toContain(elCopy('notFound.home'));
  });

  it('exposes only one level-one heading for assistive tech', () => {
    const fixture = TestBed.createComponent(NotFoundComponent);
    fixture.detectChanges();

    expect(fixture.debugElement.queryAll(By.css('h1')).length).toBe(1);
    expect(
      fixture.debugElement.query(By.css('h1')).nativeElement.getAttribute('id')
    ).toBe('not-found-title');
  });
});
