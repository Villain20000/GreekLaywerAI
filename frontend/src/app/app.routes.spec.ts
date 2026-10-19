import { routes } from './app.routes';
import { authGuard } from './guards/auth.guard';
import { adminGuard } from './guards/admin.guard';
import { guestGuard } from './guards/guest.guard';

const GREEK = /[\u0370-\u03ff]/;

describe('app routes (2-7 route table)', () => {
  it('keeps the wildcard last and routes it to the 404 component', () => {
    const last = routes[routes.length - 1];
    expect(last.path).toBe('**');
    expect(last.loadComponent).toBeDefined();
    expect(last.title).toBe('Η σελίδα δεν βρέθηκε | NomosAI');
  });

  it('gives every route a non-empty Greek title', () => {
    for (const route of routes) {
      expect(typeof route.title).toBe('string');
      expect((route.title as string).length).toBeGreaterThan(0);
      expect(GREEK.test(route.title as string)).toBeTrue();
    }
  });

  it('lazy-loads every route (no eager component references)', () => {
    for (const route of routes) {
      expect(typeof route.loadComponent).toBe('function');
      expect(route.component).toBeUndefined();
    }
  });

  it('keeps authGuard on the protected feature routes', () => {
    for (const path of [
      'chat',
      'change-password',
      'documents',
      'conversations',
      'billing',
      'subscriptions',
      'profile'
    ]) {
      const route = routes.find((r) => r.path === path);
      expect(route).withContext(path).toBeDefined();
      expect(route?.canActivate).withContext(path).toContain(authGuard);
    }
  });

  it('keeps adminGuard on the admin routes', () => {
    for (const path of ['admin', 'admin/documents']) {
      const route = routes.find((r) => r.path === path);
      expect(route).withContext(path).toBeDefined();
      expect(route?.canActivate).withContext(path).toContain(adminGuard);
    }
  });

  it('guest-guards the login and register pages', () => {
    for (const path of ['login', 'register']) {
      const route = routes.find((r) => r.path === path);
      expect(route).withContext(path).toBeDefined();
      expect(route?.canActivate).withContext(path).toContain(guestGuard);
    }
  });

  it('marks only the public surfaces as menu-less', () => {
    const publicPaths = [
      '',
      'login',
      'register',
      'forgot-password',
      'reset-password',
      'verify-email',
      'admin-login'
    ];
    for (const route of routes) {
      expect(route.data?.['hideMenu'] === true).withContext(String(route.path)).toBe(
        publicPaths.includes(route.path as string)
      );
    }
  });
});
