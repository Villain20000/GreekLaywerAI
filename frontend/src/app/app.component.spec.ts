import { TestBed } from '@angular/core/testing';
import { AppComponent } from './app.component';
import { RouterTestingModule } from '@angular/router/testing';
import { By } from '@angular/platform-browser';
import { provideTestTranslate } from './i18n/testing';
import { ErrorNotifierService } from './services/error-notifier.service';

describe('AppComponent', () => {
  beforeEach(async () => {
    await TestBed.configureTestingModule({
      imports: [AppComponent, RouterTestingModule],
      // 2-8 (i18n): the shell renders <app-menu>, whose template uses the
      // `translate` pipe. TranslateStore is NOT `providedIn: 'root'` in
      // @ngx-translate/core@16, so the spec has to supply the ngx-translate
      // providers explicitly or every component instantiation throws
      // "No provider for TranslateStore!".
      providers: [...provideTestTranslate()]
    }).compileComponents();
  });

  it('should create the app', () => {
    const fixture = TestBed.createComponent(AppComponent);
    const app = fixture.componentInstance;
    expect(app).toBeTruthy();
  });

  it('renders the menu shell by default (non-auth routes)', () => {
    const fixture = TestBed.createComponent(AppComponent);
    fixture.detectChanges();
    const menu = fixture.debugElement.query(By.css('app-menu'));
    expect(menu).not.toBeNull();
  });

  it('shows and dismisses the global error banner', () => {
    const fixture = TestBed.createComponent(AppComponent);
    const notifier = TestBed.inject(ErrorNotifierService);
    fixture.detectChanges();

    expect(fixture.debugElement.query(By.css('.nl-error-banner'))).toBeNull();

    notifier.notify({ message: 'boom', timestamp: '2026-01-01T00:00:00.000Z' });
    fixture.detectChanges();

    const banner = fixture.debugElement.query(By.css('.nl-error-banner'));
    expect(banner).not.toBeNull();
    expect(banner.nativeElement.getAttribute('role')).toBe('alert');
    expect(banner.nativeElement.getAttribute('aria-live')).toBe('assertive');
    expect(banner.nativeElement.getAttribute('aria-atomic')).toBe('true');

    const dismiss = banner.query(By.css('button.nl-error-banner-dismiss'));
    expect(dismiss).not.toBeNull();
    dismiss.nativeElement.click();
    fixture.detectChanges();

    expect(fixture.debugElement.query(By.css('.nl-error-banner'))).toBeNull();
  });
});
