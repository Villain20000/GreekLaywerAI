import { TestBed } from '@angular/core/testing';
import { ThemeService } from './theme.service';

/**
 * ThemeService owns the `<html data-theme="…">` attribute that drives every
 * CSS custom property, and persists the choice in localStorage so a cold
 * start keeps the same surface.
 */
describe('ThemeService', () => {
  const STORAGE_KEY = 'nomos_theme';

  beforeEach(() => {
    localStorage.removeItem(STORAGE_KEY);
    document.documentElement.removeAttribute('data-theme');
    TestBed.configureTestingModule({});
  });

  afterEach(() => {
    localStorage.removeItem(STORAGE_KEY);
    document.documentElement.removeAttribute('data-theme');
  });

  it('should be created', () => {
    expect(TestBed.inject(ThemeService)).toBeTruthy();
  });

  it('defaults to dark when the document carries no data-theme attribute', () => {
    const service = TestBed.inject(ThemeService);

    expect(service.current).toBe('dark');
  });

  it('adopts the data-theme attribute that the bootstrap script already set', () => {
    document.documentElement.setAttribute('data-theme', 'light');

    const service = TestBed.inject(ThemeService);

    expect(service.current).toBe('light');
  });

  it('ignores an unknown data-theme value and falls back to dark', () => {
    document.documentElement.setAttribute('data-theme', 'neon');

    const service = TestBed.inject(ThemeService);

    expect(service.current).toBe('dark');
  });

  it('toggle() flips dark → light and persists the choice', () => {
    const service = TestBed.inject(ThemeService);
    expect(service.current).toBe('dark');

    service.toggle();

    expect(service.current).toBe('light');
    expect(document.documentElement.getAttribute('data-theme')).toBe('light');
    expect(localStorage.getItem(STORAGE_KEY)).toBe('light');
  });

  it('toggle() flips light → dark and persists the choice', () => {
    document.documentElement.setAttribute('data-theme', 'light');
    const service = TestBed.inject(ThemeService);

    service.toggle();

    expect(service.current).toBe('dark');
    expect(document.documentElement.getAttribute('data-theme')).toBe('dark');
    expect(localStorage.getItem(STORAGE_KEY)).toBe('dark');
  });

  it('set() writes both the attribute and the persisted choice', () => {
    const service = TestBed.inject(ThemeService);

    service.set('light');

    expect(service.current).toBe('light');
    expect(document.documentElement.getAttribute('data-theme')).toBe('light');
    expect(localStorage.getItem(STORAGE_KEY)).toBe('light');
  });

  it('theme$ emits the active theme and every subsequent change', () => {
    const service = TestBed.inject(ThemeService);
    const seen: string[] = [];
    service.theme$.subscribe((theme) => seen.push(theme));

    service.set('light');
    service.toggle();

    expect(seen).toEqual(['dark', 'light', 'dark']);
  });
});
