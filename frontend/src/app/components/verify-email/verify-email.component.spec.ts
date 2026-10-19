import { ComponentFixture, TestBed, fakeAsync, tick } from '@angular/core/testing';
import { By } from '@angular/platform-browser';
import { ActivatedRoute, Router, convertToParamMap, provideRouter } from '@angular/router';
import { VerifyEmailComponent } from './verify-email.component';
import { AuthService, TokenAuthResult } from '../../services/auth.service';
import { lookupTranslation, provideTestTranslate } from '../../i18n/testing';
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


const VALID_TOKEN = 'a'.repeat(64);

/**
 * /verify-email consumes the one-time token from `?token=…`. The server
 * answers `invalid_token` for every flavour of bad token; the component
 * must show the TRANSLATED copy of that code, not the raw English server
 * prose.
 */
describe('VerifyEmailComponent', () => {
  let component: VerifyEmailComponent;
  let fixture: ComponentFixture<VerifyEmailComponent>;
  let mockAuthService: { verifyEmail: jasmine.Spy };
  let mockRouter: Router;
  let queryParams: Record<string, string>;

  beforeEach(async () => {
    queryParams = { token: VALID_TOKEN };
    mockAuthService = {
      verifyEmail: jasmine
        .createSpy<(token: string) => Promise<TokenAuthResult>>('verifyEmail')
        .and.returnValue(
          Promise.resolve({
            ok: true,
            token: 'jwt-abc',
            user: { id: 1, email: 'user@nomos.ai', role: 'user', subscription_tier: 'basic' }
          })
        )
    };

    await TestBed.configureTestingModule({
      imports: [VerifyEmailComponent],
      providers: [
        { provide: AuthService, useValue: mockAuthService },
        // provideRouter() provides an ActivatedRoute of its own, so it has
        // to come FIRST — the stub below has to win.
        provideRouter([]),
        {
          provide: ActivatedRoute,
          useValue: {
            snapshot: {
              get queryParamMap() {
                return convertToParamMap(queryParams);
              }
            }
          }
        },
        // The template uses the `translate` pipe → the ngx-translate
        // providers are mandatory (TranslateStore is not
        // `providedIn: 'root'` in @ngx-translate/core@16).
        ...provideTestTranslate()
      ]
    }).compileComponents();

    mockRouter = TestBed.inject(Router);
    spyOn(mockRouter, 'navigate');

    fixture = TestBed.createComponent(VerifyEmailComponent);
    component = fixture.componentInstance;
  });

  it('should create', () => {
    fixture.detectChanges();
    expect(component).toBeTruthy();
  });

  it('verifies the token and navigates to /chat on success', async () => {
    fixture.detectChanges();
    await fixture.whenStable();
    fixture.detectChanges();

    expect(mockAuthService.verifyEmail).toHaveBeenCalledWith(VALID_TOKEN);
    expect(component.finished).toBeTrue();
    expect(component.success).toBeTrue();
    expect(component.error).toBe('');

    const banner = fixture.debugElement.query(By.css('.success-msg'));
    expect(banner.nativeElement.textContent).toContain(
      elCopy('auth.verify.success')
    );
  });

  it('rejects a missing token without calling the server', async () => {
    queryParams = {};
    fixture.detectChanges();
    await fixture.whenStable();

    expect(mockAuthService.verifyEmail).not.toHaveBeenCalled();
    expect(component.finished).toBeTrue();
    expect(component.success).toBeFalse();
    expect(component.error).toBe(elCopy('auth.verify.invalid'));
  });

  it('rejects a malformed token without calling the server', async () => {
    queryParams = { token: 'not-a-64-hex-token' };
    fixture.detectChanges();
    await fixture.whenStable();

    expect(mockAuthService.verifyEmail).not.toHaveBeenCalled();
    expect(component.finished).toBeTrue();
    expect(component.success).toBeFalse();
    expect(component.error).toBe(elCopy('auth.verify.invalid'));
  });

  it('shows the translated copy for code=invalid_token, never the raw English prose', async () => {
    mockAuthService.verifyEmail.and.returnValue(
      Promise.resolve({
        ok: false,
        kind: 'invalid_token',
        code: 'invalid_token',
        error: 'Invalid or expired verification link',
        status: 400
      })
    );

    fixture.detectChanges();
    await fixture.whenStable();
    fixture.detectChanges();

    expect(component.finished).toBeTrue();
    expect(component.success).toBeFalse();
    expect(component.error).toBe(elCopy('auth.errors.invalidToken'));
    expect(component.error).not.toContain('Invalid or expired verification link');

    const banner = fixture.debugElement.query(By.css('.error-msg'));
    expect(banner.nativeElement.textContent).toContain(
      elCopy('auth.errors.invalidToken')
    );
  });

  it('offers a link back to the sign-in page on failure', async () => {
    mockAuthService.verifyEmail.and.returnValue(
      Promise.resolve({
        ok: false,
        kind: 'invalid_token',
        code: 'invalid_token',
        error: 'Invalid or expired verification link',
        status: 400
      })
    );

    fixture.detectChanges();
    await fixture.whenStable();
    fixture.detectChanges();

    const link = fixture.debugElement.query(By.css('.footer-link a'));
    expect(link).not.toBeNull();
    expect(link.nativeElement.getAttribute('href')).toBe('/login');
  });

  it('navigates to /chat shortly after a successful verification', fakeAsync(() => {
    fixture.detectChanges();
    tick();
    tick(600);

    expect(mockRouter.navigate).toHaveBeenCalledWith(['/chat']);
  }));

  it('does NOT navigate when the verification failed', fakeAsync(() => {
    mockAuthService.verifyEmail.and.returnValue(
      Promise.resolve({
        ok: false,
        kind: 'invalid_token',
        code: 'invalid_token',
        error: 'Invalid or expired verification link',
        status: 400
      })
    );

    fixture.detectChanges();
    tick();
    tick(600);

    expect(mockRouter.navigate).not.toHaveBeenCalled();
  }));
});
