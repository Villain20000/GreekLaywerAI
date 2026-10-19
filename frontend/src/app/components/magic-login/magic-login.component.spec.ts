import { ComponentFixture, TestBed, fakeAsync, tick } from '@angular/core/testing';
import { By } from '@angular/platform-browser';
import { ActivatedRoute, Router, convertToParamMap, provideRouter } from '@angular/router';
import { MagicLoginComponent } from './magic-login.component';
import { AuthService, AuthUser, TokenAuthResult } from '../../services/auth.service';
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


const ADMIN_USER: AuthUser = {
  id: 1,
  email: 'admin@nomos.ai',
  role: 'admin',
  subscription_tier: 'enterprise'
};

const USER_USER: AuthUser = {
  id: 2,
  email: 'user@nomos.ai',
  role: 'user',
  subscription_tier: 'basic'
};

/**
 * /admin-login redeems the operator-minted magic link. The server answers
 * `invalid_token` / `admin_role_required` / `not_found`; the component must
 * show the TRANSLATED copy of that code, not the raw English server prose.
 */
describe('MagicLoginComponent', () => {
  let component: MagicLoginComponent;
  let fixture: ComponentFixture<MagicLoginComponent>;
  let mockAuthService: { verifyMagicLink: jasmine.Spy; userValue: AuthUser | null };
  let mockRouter: Router;
  let queryParams: Record<string, string>;

  beforeEach(async () => {
    queryParams = { token: 'magic-token' };
    mockAuthService = {
      verifyMagicLink: jasmine
        .createSpy<(token: string) => Promise<TokenAuthResult>>('verifyMagicLink')
        .and.returnValue(
          Promise.resolve({ ok: true, token: 'jwt-abc', user: ADMIN_USER })
        ),
      userValue: ADMIN_USER
    };

    await TestBed.configureTestingModule({
      imports: [MagicLoginComponent],
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

    fixture = TestBed.createComponent(MagicLoginComponent);
    component = fixture.componentInstance;
  });

  it('should create', () => {
    fixture.detectChanges();
    expect(component).toBeTruthy();
  });

  it('redeems the token and routes an admin to /admin', fakeAsync(() => {
    fixture.detectChanges();
    tick();
    tick(600);

    expect(mockAuthService.verifyMagicLink).toHaveBeenCalledWith('magic-token');
    expect(component.finished).toBeTrue();
    expect(component.success).toBeTrue();
    expect(component.error).toBe('');
    expect(mockRouter.navigate).toHaveBeenCalledWith(['/admin']);
  }));

  it('routes a non-admin account to /chat instead of /admin', fakeAsync(() => {
    mockAuthService.userValue = USER_USER;

    fixture.detectChanges();
    tick();
    tick(600);

    expect(mockRouter.navigate).toHaveBeenCalledWith(['/chat']);
  }));

  it('rejects a missing token without calling the server', async () => {
    queryParams = {};

    fixture.detectChanges();
    await fixture.whenStable();

    expect(mockAuthService.verifyMagicLink).not.toHaveBeenCalled();
    expect(component.finished).toBeTrue();
    expect(component.success).toBeFalse();
    expect(component.error).toBe(elCopy('auth.magic.noToken'));
  });

  it('shows the translated copy for code=invalid_token, never the raw English prose', async () => {
    mockAuthService.verifyMagicLink.and.returnValue(
      Promise.resolve({
        ok: false,
        kind: 'invalid_token',
        code: 'invalid_token',
        error: 'Invalid or expired magic link',
        status: 400
      })
    );

    fixture.detectChanges();
    await fixture.whenStable();
    fixture.detectChanges();

    expect(component.finished).toBeTrue();
    expect(component.success).toBeFalse();
    expect(component.error).toBe(elCopy('auth.errors.invalidToken'));
    expect(component.error).not.toContain('Invalid or expired magic link');

    const banner = fixture.debugElement.query(By.css('.error-msg'));
    expect(banner.nativeElement.textContent).toContain(
      elCopy('auth.errors.invalidToken')
    );
  });

  it('shows the translated copy for code=admin_role_required', async () => {
    mockAuthService.verifyMagicLink.and.returnValue(
      Promise.resolve({
        ok: false,
        kind: 'admin_role_required',
        code: 'admin_role_required',
        error: 'Administrator role required',
        status: 403
      })
    );

    fixture.detectChanges();
    await fixture.whenStable();
    fixture.detectChanges();

    expect(component.error).toBe(
      elCopy('auth.errors.adminRoleRequired')
    );
    expect(component.error).not.toContain('Administrator role required');
  });

  it('shows the translated copy for code=not_found (endpoint disabled)', async () => {
    mockAuthService.verifyMagicLink.and.returnValue(
      Promise.resolve({
        ok: false,
        kind: 'not_found',
        code: 'not_found',
        error: 'Not found',
        status: 404
      })
    );

    fixture.detectChanges();
    await fixture.whenStable();
    fixture.detectChanges();

    expect(component.error).toBe(elCopy('auth.errors.notFound'));
  });

  it('does NOT navigate when the redemption failed', fakeAsync(() => {
    mockAuthService.verifyMagicLink.and.returnValue(
      Promise.resolve({
        ok: false,
        kind: 'invalid_token',
        code: 'invalid_token',
        error: 'Invalid or expired magic link',
        status: 400
      })
    );

    fixture.detectChanges();
    tick();
    tick(600);

    expect(mockRouter.navigate).not.toHaveBeenCalled();
  }));

  it('offers a link back to the sign-in page on failure', async () => {
    mockAuthService.verifyMagicLink.and.returnValue(
      Promise.resolve({
        ok: false,
        kind: 'invalid_token',
        code: 'invalid_token',
        error: 'Invalid or expired magic link',
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
});
