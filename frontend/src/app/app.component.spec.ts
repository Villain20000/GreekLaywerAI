import { TestBed } from '@angular/core/testing';
import { AppComponent } from './app.component';
import { RouterTestingModule } from '@angular/router/testing';
import { By } from '@angular/platform-browser';
import { provideTestTranslate } from './i18n/testing';

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
});
