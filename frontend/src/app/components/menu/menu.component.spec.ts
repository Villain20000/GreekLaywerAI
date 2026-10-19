import { ComponentFixture, TestBed, fakeAsync, tick } from '@angular/core/testing';
import { RouterTestingModule } from '@angular/router/testing';
import { BehaviorSubject } from 'rxjs';
import { MenuComponent } from './menu.component';
import { AuthService, AuthUser } from '../../services/auth.service';
import { ThemeService } from '../../services/theme.service';
import { FeatureFlagsService } from '../../services/feature-flags.service';
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

describe('MenuComponent (responsive + keyboard)', () => {
  let fixture: ComponentFixture<MenuComponent>;
  let component: MenuComponent;
  let authStub: {
    user$: BehaviorSubject<AuthUser | null>;
    isAdmin: boolean;
    logout: jasmine.Spy;
  };
  let themeStub: { current: 'dark' | 'light'; toggle: jasmine.Spy };
  let flags: Record<string, boolean>;
  let featureFlagsStub: { ensureLoaded: jasmine.Spy; isEnabled: jasmine.Spy };

  const user: AuthUser = {
    id: 7,
    email: 'lawyer@nomos.ai',
    role: 'user',
    subscription_tier: 'pro'
  };

  beforeEach(async () => {
    authStub = {
      user$: new BehaviorSubject<AuthUser | null>(user),
      isAdmin: false,
      logout: jasmine.createSpy('logout')
    };
    themeStub = { current: 'dark', toggle: jasmine.createSpy('toggle') };
    flags = { billing: true, documents: true, audio: true, adminDocuments: true };
    featureFlagsStub = {
      ensureLoaded: jasmine.createSpy('ensureLoaded').and.returnValue(Promise.resolve()),
      isEnabled: jasmine.createSpy('isEnabled').and.callFake(
        (flag: string) => flags[flag] !== false
      )
    };

    await TestBed.configureTestingModule({
      imports: [MenuComponent, RouterTestingModule],
      providers: [
        { provide: AuthService, useValue: authStub },
        { provide: ThemeService, useValue: themeStub },
        { provide: FeatureFlagsService, useValue: featureFlagsStub },
        // 2-8 (i18n): the nav template (and the embedded language switcher)
        // use the `translate` pipe, so the spec needs the ngx-translate
        // providers (TranslateStore is not `providedIn: 'root'` in
        // @ngx-translate/core@16).
        ...provideTestTranslate()
      ]
    }).compileComponents();

    fixture = TestBed.createComponent(MenuComponent);
    component = fixture.componentInstance;
    fixture.detectChanges();
  });

  it('renders a real hamburger with aria-expanded and aria-controls', () => {
    const hamburger = fixture.nativeElement.querySelector('.nl-menu-hamburger') as HTMLButtonElement;
    expect(hamburger).not.toBeNull();
    expect(hamburger.tagName).toBe('BUTTON');
    expect(hamburger.getAttribute('aria-expanded')).toBe('false');
    expect(hamburger.getAttribute('aria-controls')).toBe('nl-menu-links');
    // The hamburger's accessible name is the translated "open" copy; the
    // key lookup pins both the key and the Greek wording.
    expect(hamburger.getAttribute('aria-label')).toBe(elCopy('nav.openMenu'));

    hamburger.click();
    fixture.detectChanges();

    expect(component.mobileMenuOpen()).toBeTrue();
    expect(hamburger.getAttribute('aria-expanded')).toBe('true');
    expect(hamburger.getAttribute('aria-label')).toBe(elCopy('nav.closeMenu'));
    expect(fixture.nativeElement.querySelector('#nl-menu-links').classList).toContain('open');
  });

  it('keeps every navigation link inside the controlled mobile panel', () => {
    const links = fixture.nativeElement.querySelectorAll('#nl-menu-links .nl-menu-link');
    expect(links.length).toBeGreaterThan(0);
  });

  it('closes the mobile panel on Escape and returns focus to the toggle', fakeAsync(() => {
    const hamburger = fixture.nativeElement.querySelector('.nl-menu-hamburger') as HTMLButtonElement;
    hamburger.focus();
    hamburger.click();
    fixture.detectChanges();

    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
    fixture.detectChanges();
    tick();

    expect(component.mobileMenuOpen()).toBeFalse();
    expect(document.activeElement).toBe(hamburger);
  }));

  it('closes the mobile panel when a navigation link is used', () => {
    const hamburger = fixture.nativeElement.querySelector('.nl-menu-hamburger') as HTMLButtonElement;
    hamburger.click();
    fixture.detectChanges();

    const firstLink = fixture.nativeElement.querySelector('#nl-menu-links .nl-menu-link') as HTMLAnchorElement;
    firstLink.click();
    fixture.detectChanges();

    expect(component.mobileMenuOpen()).toBeFalse();
  });

  it('opens the user menu from a keyboard-operable button and ticks aria-expanded', fakeAsync(() => {
    const trigger = fixture.nativeElement.querySelector('.nl-menu-user-trigger') as HTMLButtonElement;
    expect(trigger).not.toBeNull();
    expect(trigger.tagName).toBe('BUTTON');
    expect(trigger.getAttribute('aria-expanded')).toBe('false');
    expect(trigger.getAttribute('aria-controls')).toBe('nl-menu-dropdown');

    // Native buttons activate on Enter/Space; a click is the same activation
    // path the browser uses for those keys.
    trigger.click();
    fixture.detectChanges();
    tick();

    expect(component.userMenuOpen()).toBeTrue();
    expect(trigger.getAttribute('aria-expanded')).toBe('true');
    expect(fixture.nativeElement.querySelector('#nl-menu-dropdown')).not.toBeNull();
    // Focus lands on the first dropdown item (the profile link), whose label
    // is the translated copy of `nav.profile`.
    expect(document.activeElement?.textContent).toContain(elCopy('nav.profile'));

    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
    fixture.detectChanges();
    tick();

    expect(component.userMenuOpen()).toBeFalse();
    expect(trigger.getAttribute('aria-expanded')).toBe('false');
    expect(document.activeElement).toBe(trigger);
  }));

  it('logout closes the menu and delegates to AuthService', () => {
    component.toggleUserMenu();
    component.logout();

    expect(component.userMenuOpen()).toBeFalse();
    expect(authStub.logout).toHaveBeenCalled();
  });

  describe('feature-flag gating', () => {
    function menuLinkLabels(): string[] {
      const links = fixture.nativeElement.querySelectorAll(
        '#nl-menu-links .nl-menu-link'
      ) as NodeListOf<Element>;
      return Array.from(links).map((el) => (el.textContent || '').trim());
    }

    function dropdownLabels(): string[] {
      component.toggleUserMenu();
      fixture.detectChanges();
      const links = fixture.nativeElement.querySelectorAll(
        '#nl-menu-dropdown a'
      ) as NodeListOf<Element>;
      return Array.from(links).map((el) => (el.textContent || '').trim());
    }

    it('shows documents and billing by default while keeping chat visible', () => {
      const labels = menuLinkLabels();

      expect(labels).toContain(elCopy('nav.chat'));
      expect(labels).toContain(elCopy('nav.documents'));
      expect(labels).toContain(elCopy('nav.plans'));
      expect(dropdownLabels()).toContain(elCopy('nav.subscription'));
    });

    it('hides the Documents link when documents is disabled', () => {
      flags['documents'] = false;
      fixture.detectChanges();

      const labels = menuLinkLabels();
      expect(labels).not.toContain(elCopy('nav.documents'));
      expect(labels).toContain(elCopy('nav.chat'));
      expect(labels).toContain(elCopy('nav.conversations'));
    });

    it('hides Billing and Subscriptions when billing is disabled', () => {
      flags['billing'] = false;
      fixture.detectChanges();

      expect(menuLinkLabels()).not.toContain(elCopy('nav.plans'));
      const dropdown = dropdownLabels();
      expect(dropdown).not.toContain(elCopy('nav.subscription'));
      expect(dropdown).toContain(elCopy('nav.profile'));
    });

    it('hides admin-documents when adminDocuments is disabled but keeps admin', () => {
      authStub.isAdmin = true;
      flags['adminDocuments'] = false;
      fixture.detectChanges();

      const labels = menuLinkLabels();
      expect(labels).toContain(elCopy('nav.admin'));
      expect(labels).not.toContain(elCopy('nav.adminDocuments'));
    });
  });
});
