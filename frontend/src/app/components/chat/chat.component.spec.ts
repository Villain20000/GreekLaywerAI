import { ComponentFixture, TestBed } from '@angular/core/testing';
import { BehaviorSubject } from 'rxjs';
import { ChatComponent } from './chat.component';
import { AuthService, AuthUser } from '../../services/auth.service';
import { AiService } from '../../services/ai.service';
import { provideRouter, Router } from '@angular/router';

/**
 * Stub AiService that hands out observables no-ops for streamQuery/uploadAudio.
 * ChatComponent.onSubmit and sendAudioQuery both subscribe to those streams;
 * if the stubs were missing or threw synchronously, sendMessage would crash
 * before the spec could observe the header.
 */
function buildAiStub(): Partial<AiService> {
  const emptyStream = {
    subscribe: () => ({ unsubscribe: () => undefined })
  };
  return {
    streamQuery: jasmine.createSpy('streamQuery').and.returnValue(emptyStream),
    uploadAudio: jasmine.createSpy('uploadAudio').and.returnValue(emptyStream)
  };
}

describe('ChatComponent (reactive user$ wiring)', () => {
  let fixture: ComponentFixture<ChatComponent>;
  let userSub: BehaviorSubject<AuthUser | null>;
  let mockAuth: Pick<AuthService, 'tokenValue' | 'ready$' | 'user$' | 'logout'>;
  let mockAi: Partial<AiService>;

  function findAdminLink(): HTMLAnchorElement | null {
    return fixture.nativeElement.querySelector('a.admin-link');
  }

  function findEmailChip(): HTMLElement | null {
    return fixture.nativeElement.querySelector('.user-email');
  }

  beforeEach(async () => {
    userSub = new BehaviorSubject<AuthUser | null>(null);
    mockAuth = {
      tokenValue: 'jwt-test',
      ready$: new BehaviorSubject<boolean>(true).asObservable(),
      user$: userSub.asObservable(),
      logout: jasmine.createSpy('logout')
    };
    mockAi = buildAiStub();

    await TestBed.configureTestingModule({
      imports: [ChatComponent],
      providers: [
        { provide: AuthService, useValue: mockAuth },
        { provide: AiService, useValue: mockAi },
        { provide: Router, useValue: { navigate: jasmine.createSpy('navigate') } },
        provideRouter([])
      ]
    }).compileComponents();

    fixture = TestBed.createComponent(ChatComponent);
  });

  it('hides the admin link and email chip when user$ is null', () => {
    userSub.next(null);
    fixture.detectChanges();
    expect(findAdminLink()).toBeNull();
    expect(findEmailChip()).toBeNull();
  });

  it('renders email chip but hides admin link for non-admin users', () => {
    userSub.next({
      id: 2,
      email: 'user@nomos.ai',
      role: 'user',
      subscription_tier: 'basic'
    });
    fixture.detectChanges();
    expect(findAdminLink()).toBeNull();
    expect(findEmailChip()?.textContent?.trim()).toBe('user@nomos.ai');
  });

  it('renders both admin link and email chip for admin users', () => {
    userSub.next({
      id: 1,
      email: 'admin@nomos.ai',
      role: 'admin',
      subscription_tier: 'enterprise'
    });
    fixture.detectChanges();
    const link = findAdminLink();
    expect(link).not.toBeNull();
    expect(link?.textContent?.trim()).toBe('⚙ Admin');
    expect(link?.getAttribute('href')).toBe('/admin');
    expect(findEmailChip()?.textContent?.trim()).toBe('admin@nomos.ai');
  });

  it('reacts to a role promotion pushed via user$ without a page refresh', () => {
    // Initial state: regular user.
    userSub.next({
      id: 1,
      email: 'u@nomos.ai',
      role: 'user',
      subscription_tier: 'basic'
    });
    fixture.detectChanges();
    expect(findAdminLink()).toBeNull();

    // /me refresh populates user$ with an admin role — e.g. another tab
    // promoted this user. The header must light up automatically.
    userSub.next({
      id: 1,
      email: 'u@nomos.ai',
      role: 'admin',
      subscription_tier: 'enterprise'
    });
    fixture.detectChanges();
    expect(findAdminLink()).not.toBeNull();
    expect(findEmailChip()?.textContent?.trim()).toBe('u@nomos.ai');
  });

  it('reacts to a role demotion pushed via user$', () => {
    userSub.next({
      id: 1,
      email: 'u@nomos.ai',
      role: 'admin',
      subscription_tier: 'enterprise'
    });
    fixture.detectChanges();
    expect(findAdminLink()).not.toBeNull();

    userSub.next({
      id: 1,
      email: 'u@nomos.ai',
      role: 'user',
      subscription_tier: 'basic'
    });
    fixture.detectChanges();
    expect(findAdminLink()).toBeNull();
  });

  it('logout() delegates to AuthService.logout', () => {
    const component = fixture.componentInstance;
    component.logout();
    expect(mockAuth.logout).toHaveBeenCalled();
  });
});
