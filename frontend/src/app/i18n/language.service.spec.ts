import { TestBed } from '@angular/core/testing';
import { TranslateService } from '@ngx-translate/core';
import {
  DEFAULT_LANGUAGE,
  LANGUAGE_STORAGE_KEY,
  LanguageService,
  SUPPORTED_LANGUAGES
} from './language.service';
import { provideTestTranslate, resetLanguageStorage } from './testing';

/**
 * LanguageService wraps TranslateService.use() so every switch also
 * updates `<html lang>` (a11y / spell-check), persists the choice in
 * localStorage and exposes the active language as a signal.
 */
describe('LanguageService', () => {
  let service: LanguageService;
  let translate: TranslateService;

  beforeEach(() => {
    resetLanguageStorage();
    TestBed.configureTestingModule({
      providers: [...provideTestTranslate()]
    });
    service = TestBed.inject(LanguageService);
    translate = TestBed.inject(TranslateService);
  });

  afterEach(() => {
    resetLanguageStorage();
  });

  it('should be created', () => {
    expect(service).toBeTruthy();
  });

  it('starts on Greek with no persisted choice', () => {
    expect(service.current()).toBe(DEFAULT_LANGUAGE);
    expect(DEFAULT_LANGUAGE).toBe('el');
    expect(SUPPORTED_LANGUAGES).toEqual(['el', 'en']);
  });

  it('init() applies Greek when nothing is stored', async () => {
    await service.init();

    expect(service.current()).toBe('el');
    expect(document.documentElement.lang).toBe('el');
  });

  it('init() restores the persisted language', async () => {
    localStorage.setItem(LANGUAGE_STORAGE_KEY, 'en');

    await service.init();

    expect(service.current()).toBe('en');
    expect(document.documentElement.lang).toBe('en');
  });

  it('init() ignores a corrupted persisted value and falls back to Greek', async () => {
    localStorage.setItem(LANGUAGE_STORAGE_KEY, 'de');

    await service.init();

    expect(service.current()).toBe('el');
    expect(document.documentElement.lang).toBe('el');
  });

  it('setLanguage() switches the active language, the <html lang> attribute and the persisted choice', async () => {
    await service.setLanguage('en');

    expect(service.current()).toBe('en');
    expect(document.documentElement.lang).toBe('en');
    expect(localStorage.getItem(LANGUAGE_STORAGE_KEY)).toBe('en');
    expect(translate.currentLang).toBe('en');
  });

  it('setLanguage() actually swaps the dictionary in use', async () => {
    expect(translate.instant('auth.login.title')).toBe('Σύνδεση');

    await service.setLanguage('en');

    expect(translate.instant('auth.login.title')).toBe('Sign in');
  });

  it('toggle() flips Greek → English → Greek', async () => {
    await service.toggle();
    expect(service.current()).toBe('en');
    expect(localStorage.getItem(LANGUAGE_STORAGE_KEY)).toBe('en');

    await service.toggle();
    expect(service.current()).toBe('el');
    expect(localStorage.getItem(LANGUAGE_STORAGE_KEY)).toBe('el');
  });

  it('keeps the choice across a re-initialisation', async () => {
    await service.setLanguage('en');

    await service.init();

    expect(service.current()).toBe('en');
    expect(translate.currentLang).toBe('en');
    expect(document.documentElement.lang).toBe('en');
  });
});
