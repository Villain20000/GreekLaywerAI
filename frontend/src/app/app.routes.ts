import { Routes } from '@angular/router';
import { authGuard } from './guards/auth.guard';
import { adminGuard } from './guards/admin.guard';
import { guestGuard } from './guards/guest.guard';

/**
 * 2-7 — route table.
 *
 * Every feature page is lazy-loaded via `loadComponent` so heavy
 * dependencies (notably three.js + GSAP in the landing page, plus the
 * markdown/sanitizer stack in chat) stay out of the initial `main` bundle.
 * Route paths and guard wiring are unchanged from the eager version.
 *
 * Public routes keep `data: { hideMenu: true }` (Phase 27) so the
 * AppComponent shell renders only the menu-less auth surface there. Auth-
 * guarded routes deliberately omit the flag — the menu shows by default.
 *
 * 2-8 (i18n): every route also carries `data.titleKey`, resolved by
 * `TranslatedTitleStrategy` against `assets/i18n/*.json`. The `title`
 * string stays as the no-JS fallback and is pinned by app.routes.spec.ts.
 */
export const routes: Routes = [
  {
    path: '',
    loadComponent: () =>
      import('./components/landing/landing.component').then(
        (m) => m.LandingComponent
      ),
    title: 'NomosAI — Ο Έλληνας AI Νομικός σας',
    data: { hideMenu: true, titleKey: 'routes.landing' }
  },
  {
    path: 'login',
    loadComponent: () =>
      import('./components/login/login.component').then(
        (m) => m.LoginComponent
      ),
    canActivate: [guestGuard],
    title: 'Σύνδεση | NomosAI',
    data: { hideMenu: true, titleKey: 'routes.login' }
  },
  {
    path: 'register',
    loadComponent: () =>
      import('./components/register/register.component').then(
        (m) => m.RegisterComponent
      ),
    canActivate: [guestGuard],
    title: 'Εγγραφή | NomosAI',
    data: { hideMenu: true, titleKey: 'routes.register' }
  },
  // Phase 23: password-recovery flow. Public routes — neither requires a
  // JWT. /reset-password reads its one-time token from ?token=… in the URL.
  {
    path: 'forgot-password',
    loadComponent: () =>
      import('./components/forgot-password/forgot-password.component').then(
        (m) => m.ForgotPasswordComponent
      ),
    title: 'Ανάκτηση κωδικού | NomosAI',
    data: { hideMenu: true, titleKey: 'routes.forgotPassword' }
  },
  {
    path: 'reset-password',
    loadComponent: () =>
      import('./components/reset-password/reset-password.component').then(
        (m) => m.ResetPasswordComponent
      ),
    title: 'Επαναφορά κωδικού | NomosAI',
    data: { hideMenu: true, titleKey: 'routes.resetPassword' }
  },
  // Phase 24: email-verification flow. Public route; the link in the
  // verification email lands here with ?token=… appended. The component
  // POSTs to /api/auth/verify-email and on success swaps the freshly minted
  // JWT into the AuthService before routing to /chat.
  {
    path: 'verify-email',
    loadComponent: () =>
      import('./components/verify-email/verify-email.component').then(
        (m) => m.VerifyEmailComponent
      ),
    title: 'Επαλήθευση email | NomosAI',
    data: { hideMenu: true, titleKey: 'routes.verifyEmail' }
  },
  // Phase 25 (admin bypass): magic-link redeem. Public route; the URL is
  // minted by `scripts/create-admin-magic-link.js` and pasted into a
  // browser. Redeems for a session JWT, then routes to /admin. Hard-gated
  // server-side by NODE_ENV + ADMIN_MAGIC_LINK_ENABLED.
  {
    path: 'admin-login',
    loadComponent: () =>
      import('./components/magic-login/magic-login.component').then(
        (m) => m.MagicLoginComponent
      ),
    title: 'Σύνδεση διαχειριστή | NomosAI',
    data: { hideMenu: true, titleKey: 'routes.magicLogin' }
  },
  {
    path: 'chat',
    loadComponent: () =>
      import('./components/chat/chat.component').then((m) => m.ChatComponent),
    canActivate: [authGuard],
    title: 'Συνομιλία | NomosAI',
    data: { titleKey: 'routes.chat' }
  },
  {
    path: 'change-password',
    loadComponent: () =>
      import('./components/change-password/change-password.component').then(
        (m) => m.ChangePasswordComponent
      ),
    canActivate: [authGuard],
    title: 'Αλλαγή κωδικού | NomosAI',
    data: { titleKey: 'routes.changePassword' }
  },
  {
    path: 'documents',
    loadComponent: () =>
      import('./components/documents/documents.component').then(
        (m) => m.DocumentsComponent
      ),
    canActivate: [authGuard],
    title: 'Έγγραφα | NomosAI',
    data: { titleKey: 'routes.documents' }
  },
  {
    path: 'conversations',
    loadComponent: () =>
      import('./components/conversations/conversations.component').then(
        (m) => m.ConversationsComponent
      ),
    canActivate: [authGuard],
    title: 'Συνομιλίες | NomosAI',
    data: { titleKey: 'routes.conversations' }
  },
  {
    path: 'billing',
    loadComponent: () =>
      import('./components/billing/billing.component').then(
        (m) => m.BillingComponent
      ),
    canActivate: [authGuard],
    title: 'Συνδρομή | NomosAI',
    data: { titleKey: 'routes.billing' }
  },
  {
    path: 'subscriptions',
    loadComponent: () =>
      import('./components/subscriptions/subscriptions.component').then(
        (m) => m.SubscriptionsComponent
      ),
    canActivate: [authGuard],
    title: 'Συνδρομές | NomosAI',
    data: { titleKey: 'routes.subscriptions' }
  },
  {
    path: 'profile',
    loadComponent: () =>
      import('./components/profile/profile.component').then(
        (m) => m.ProfileComponent
      ),
    canActivate: [authGuard],
    title: 'Προφίλ | NomosAI',
    data: { titleKey: 'routes.profile' }
  },
  {
    path: 'admin',
    loadComponent: () =>
      import('./components/admin/admin.component').then(
        (m) => m.AdminComponent
      ),
    canActivate: [adminGuard],
    title: 'Διαχείριση | NomosAI',
    data: { titleKey: 'routes.admin' }
  },
  {
    path: 'admin/documents',
    loadComponent: () =>
      import('./components/admin-documents/admin-documents.component').then(
        (m) => m.AdminDocumentsComponent
      ),
    canActivate: [adminGuard],
    title: 'Διαχείριση εγγράφων | NomosAI',
    data: { titleKey: 'routes.adminDocuments' }
  },
  // 2-7: wildcard MUST stay last. It renders the Greek 404 surface instead
  // of silently redirecting to the landing page.
  {
    path: '**',
    loadComponent: () =>
      import('./components/not-found/not-found.component').then(
        (m) => m.NotFoundComponent
      ),
    title: 'Η σελίδα δεν βρέθηκε | NomosAI',
    data: { titleKey: 'routes.notFound' }
  }
];
