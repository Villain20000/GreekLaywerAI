import { ComponentFixture, TestBed, fakeAsync, tick } from '@angular/core/testing';
import { RegisterComponent } from './register.component';
import { AuthService } from '../../services/auth.service';
import { Router } from '@angular/router';
import { provideRouter } from '@angular/router';
import { By } from '@angular/platform-browser';

describe('RegisterComponent', () => {
  let component: RegisterComponent;
  let fixture: ComponentFixture<RegisterComponent>;
  let mockAuthService: { register: jasmine.Spy; resendVerification: jasmine.Spy };
  let mockRouter: { navigate: jasmine.Spy };

  beforeEach(async () => {
    mockAuthService = {
      register: jasmine.createSpy('register').and.resolveTo({ ok: true }),
      resendVerification: jasmine
        .createSpy('resendVerification')
        .and.resolveTo({ ok: true })
    };
    mockRouter = { navigate: jasmine.createSpy('navigate') };

    await TestBed.configureTestingModule({
      imports: [RegisterComponent],
      providers: [
        { provide: AuthService, useValue: mockAuthService },
        { provide: Router, useValue: mockRouter },
        provideRouter([])
      ]
    }).compileComponents();

    fixture = TestBed.createComponent(RegisterComponent);
    component = fixture.componentInstance;
    fixture.detectChanges();
  });

  it('should create', () => {
    expect(component).toBeTruthy();
  });

  it('should reject empty fields', async () => {
    component.email = '';
    component.password = '';
    component.confirmPassword = '';
    await component.onSubmit();
    expect(component.error).toBe('Please fill in all fields');
    expect(component.showPassword).toBeFalse();
    expect(component.showConfirmPassword).toBeFalse();
    expect(mockAuthService.register).not.toHaveBeenCalled();
  });

  it('should reject malformed email addresses', async () => {
    component.email = 'not-an-email';
    component.password = 'password123';
    component.confirmPassword = 'password123';
    await component.onSubmit();
    expect(component.error).toBe('Please enter a valid email address');
    expect(mockAuthService.register).not.toHaveBeenCalled();
  });

  it('should reject passwords shorter than 8 chars', async () => {
    component.email = 'test@nomos.ai';
    component.password = 'short';
    component.confirmPassword = 'short';
    await component.onSubmit();
    expect(component.error).toBe('Password must be at least 8 characters');
  });

  it('should reject mismatched confirmation', async () => {
    component.email = 'test@nomos.ai';
    component.password = 'password123';
    component.confirmPassword = 'password456';
    await component.onSubmit();
    expect(component.error).toBe('Passwords do not match');
  });

  it('should reveal the verify-panel after a successful register', fakeAsync(() => {
    mockAuthService.register.and.resolveTo({
      ok: true,
      requires_verification: true,
      user: { email: 'test@nomos.ai' }
    });

    component.email = 'test@nomos.ai';
    component.password = 'password123';
    component.confirmPassword = 'password123';
    component.onSubmit();
    tick();
    fixture.detectChanges();

    expect(component.submitted).toBeTrue();
    expect(component.submittedEmail).toBe('test@nomos.ai');
    expect(mockRouter.navigate).not.toHaveBeenCalled();

    const verifyPanel = fixture.debugElement.query(By.css('.verify-panel'));
    expect(verifyPanel).not.toBeNull();
    expect(verifyPanel.nativeElement.textContent).toContain('Check your email');
    expect(verifyPanel.nativeElement.textContent).toContain('test@nomos.ai');
  }));

  it('should surface server error and stop loading on failure', fakeAsync(() => {
    mockAuthService.register.and.resolveTo({
      ok: false,
      error: 'User already exists',
      status: 400
    });

    component.email = 'taken@nomos.ai';
    component.password = 'password123';
    component.confirmPassword = 'password123';
    component.onSubmit();
    tick();

    expect(component.error).toBe('User already exists');
    expect(component.isLoading).toBeFalse();
    expect(component.submitted).toBeFalse();
    expect(mockRouter.navigate).not.toHaveBeenCalled();
  }));

  // ── DOM-driven affordance tests (polish parity with LoginComponent) ───

  it('renders the brand-row wordmark on the create-account form', () => {
    const brand = fixture.debugElement.query(By.css('.brand-row'));
    expect(brand).not.toBeNull();
    expect(brand.nativeElement.textContent).toContain('NomosAI');
  });

  it('renders the auth-links footer routing back to /login', () => {
    const links = fixture.debugElement.queryAll(By.css('.auth-links a.auth-link'));
    expect(links.length).toBe(1);
    expect(links[0].nativeElement.getAttribute('href')).toBe('/login');
    expect(links[0].nativeElement.textContent).toContain('Already have an account? Sign in');
  });

  it('starts with both password peek toggles hidden', () => {
    expect(component.showPassword).toBeFalse();
    expect(component.showConfirmPassword).toBeFalse();
  });

  it('peek-btn clicks toggle showPassword and showConfirmPassword independently', () => {
    const peekBtns = fixture.debugElement.queryAll(By.css('.peek-btn'));
    expect(peekBtns.length).toBe(2);

    peekBtns[0].nativeElement.click();
    expect(component.showPassword).toBeTrue();
    expect(component.showConfirmPassword).toBeFalse();

    peekBtns[1].nativeElement.click();
    expect(component.showConfirmPassword).toBeTrue();

    peekBtns[0].nativeElement.click();
    expect(component.showPassword).toBeFalse();
    expect(component.showConfirmPassword).toBeTrue();
  });

  it('updates password input type in lockstep with showPassword', () => {
    component.togglePasswordVisibility();
    fixture.detectChanges();
    const pwInput = fixture.debugElement.query(By.css('#register-password'));
    expect(pwInput.nativeElement.getAttribute('type')).toBe('text');

    component.togglePasswordVisibility();
    fixture.detectChanges();
    expect(pwInput.nativeElement.getAttribute('type')).toBe('password');
  });

  it('updates confirm-password input type in lockstep with showConfirmPassword', () => {
    component.toggleConfirmPasswordVisibility();
    fixture.detectChanges();
    const confirm = fixture.debugElement.query(By.css('#register-confirm-password'));
    expect(confirm.nativeElement.getAttribute('type')).toBe('text');

    component.toggleConfirmPasswordVisibility();
    fixture.detectChanges();
    expect(confirm.nativeElement.getAttribute('type')).toBe('password');
  });

  it('dispatches a synthetic Enter on email field → onSubmit fires', fakeAsync(() => {
    component.email = 'a@b.com';
    component.password = '';
    component.confirmPassword = '';

    const emailInput = fixture.debugElement.query(By.css('#register-email'));
    emailInput.nativeElement.dispatchEvent(
      new KeyboardEvent('keyup', { key: 'Enter', bubbles: true })
    );
    tick();

    // Empty fields short-circuit → no AuthService.register call,
    // error reads 'Please fill in all fields'.
    expect(component.error).toBe('Please fill in all fields');
    expect(mockAuthService.register).not.toHaveBeenCalled();
  }));

  it('dispatches a synthetic Enter on password field → onSubmit fires', fakeAsync(() => {
    component.email = 'a@b.com';
    component.password = 'a@b.com';
    component.confirmPassword = '';

    const pwInput = fixture.debugElement.query(By.css('#register-password'));
    pwInput.nativeElement.dispatchEvent(
      new KeyboardEvent('keyup', { key: 'Enter', bubbles: true })
    );
    tick();

    expect(component.error).toBe('Please fill in all fields');
    expect(mockAuthService.register).not.toHaveBeenCalled();
  }));

  it('verify-panel renders the resend CTA calling authService.resendVerification', fakeAsync(() => {
    mockAuthService.register.and.resolveTo({
      ok: true,
      requires_verification: true,
      user: { email: 'test@nomos.ai' }
    });
    component.email = 'test@nomos.ai';
    component.password = 'password123';
    component.confirmPassword = 'password123';
    component.onSubmit();
    tick();
    fixture.detectChanges();

    const verifyPanel = fixture.debugElement.query(By.css('.verify-panel'));
    const resendBtn = verifyPanel.query(By.css('button.secondary'));
    expect(resendBtn).not.toBeNull();
    resendBtn.nativeElement.click();
    tick();

    expect(mockAuthService.resendVerification).toHaveBeenCalledWith('test@nomos.ai');
    expect(component.resendIsLoading).toBeFalse();
    expect(component.resendMessage).toContain('If that email is registered');
  }));
});
