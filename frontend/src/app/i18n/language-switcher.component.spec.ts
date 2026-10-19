import { ComponentFixture, TestBed } from '@angular/core/testing';
import { By } from '@angular/platform-browser';
import { signal } from '@angular/core';
import { LanguageSwitcherComponent } from './language-switcher.component';
import { AppLanguage, LanguageService } from './language.service';
import { lookupTranslation, provideTestTranslate } from './testing';

/**
 * The EL/EN toggle rendered inside <app-menu> and by AppComponent on the
 * public (menu-less) routes. It must stay keyboard-operable and expose the
 * active language through `aria-pressed`.
 */
describe('LanguageSwitcherComponent', () => {
  let component: LanguageSwitcherComponent;
  let fixture: ComponentFixture<LanguageSwitcherComponent>;
  let languageStub: {
    current: ReturnType<typeof signal<AppLanguage>>;
    setLanguage: jasmine.Spy;
    toggle: jasmine.Spy;
  };

  beforeEach(async () => {
    languageStub = {
      current: signal<AppLanguage>('el'),
      setLanguage: jasmine
        .createSpy('setLanguage')
        .and.returnValue(Promise.resolve()),
      toggle: jasmine.createSpy('toggle').and.returnValue(Promise.resolve())
    };

    await TestBed.configureTestingModule({
      imports: [LanguageSwitcherComponent],
      providers: [
        { provide: LanguageService, useValue: languageStub },
        // The template uses the `translate` pipe → the ngx-translate
        // providers are mandatory (TranslateStore is not
        // `providedIn: 'root'` in @ngx-translate/core@16).
        ...provideTestTranslate()
      ]
    }).compileComponents();

    fixture = TestBed.createComponent(LanguageSwitcherComponent);
    component = fixture.componentInstance;
    fixture.detectChanges();
  });

  it('should create', () => {
    expect(component).toBeTruthy();
  });

  it('renders one button per shipped language', () => {
    const buttons = fixture.debugElement.queryAll(By.css('button.nl-lang-btn'));

    expect(buttons.length).toBe(2);
    expect(buttons[0].nativeElement.textContent.trim()).toBe(
      lookupTranslation('el', 'language.el')
    );
    expect(buttons[1].nativeElement.textContent.trim()).toBe(
      lookupTranslation('el', 'language.en')
    );
  });

  it('labels the group with the translated copy', () => {
    const group = fixture.debugElement.query(By.css('.nl-language-switcher'));

    expect(group.nativeElement.getAttribute('aria-label')).toBe(
      lookupTranslation('el', 'language.label')
    );
  });

  it('marks the active language with aria-pressed', () => {
    const buttons = fixture.debugElement.queryAll(By.css('button.nl-lang-btn'));

    expect(buttons[0].nativeElement.getAttribute('aria-pressed')).toBe('true');
    expect(buttons[1].nativeElement.getAttribute('aria-pressed')).toBe('false');

    languageStub.current.set('en');
    fixture.detectChanges();

    expect(buttons[0].nativeElement.getAttribute('aria-pressed')).toBe('false');
    expect(buttons[1].nativeElement.getAttribute('aria-pressed')).toBe('true');
  });

  it('switching to English calls setLanguage("en")', () => {
    const buttons = fixture.debugElement.queryAll(By.css('button.nl-lang-btn'));

    buttons[1].nativeElement.click();

    expect(languageStub.setLanguage).toHaveBeenCalledWith('en');
    expect(languageStub.setLanguage).not.toHaveBeenCalledWith('el');
  });

  it('switching to Greek calls setLanguage("el")', () => {
    const buttons = fixture.debugElement.queryAll(By.css('button.nl-lang-btn'));

    buttons[0].nativeElement.click();

    expect(languageStub.setLanguage).toHaveBeenCalledWith('el');
  });

  it('titles the buttons with the translated language names', () => {
    const buttons = fixture.debugElement.queryAll(By.css('button.nl-lang-btn'));

    expect(buttons[0].nativeElement.getAttribute('title')).toBe(
      lookupTranslation('el', 'language.greek')
    );
    expect(buttons[1].nativeElement.getAttribute('title')).toBe(
      lookupTranslation('el', 'language.english')
    );
  });
});
