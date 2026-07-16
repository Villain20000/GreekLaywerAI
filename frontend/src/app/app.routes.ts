import { Routes } from '@angular/router';
import { LandingComponent } from './components/landing/landing.component';
import { ChatComponent } from './components/chat/chat.component';
import { LoginComponent } from './components/login/login.component';
import { RegisterComponent } from './components/register/register.component';
import { ChangePasswordComponent } from './components/change-password/change-password.component';
import { AdminComponent } from './components/admin/admin.component';
import { ForgotPasswordComponent } from './components/forgot-password/forgot-password.component';
import { ResetPasswordComponent } from './components/reset-password/reset-password.component';
import { VerifyEmailComponent } from './components/verify-email/verify-email.component';
import { MagicLoginComponent } from './components/magic-login/magic-login.component';
import { authGuard } from './guards/auth.guard';
import { adminGuard } from './guards/admin.guard';

export const routes: Routes = [
  // Phase 27: every public route carries `data: { hideMenu: true }` so the
  // AppComponent shell renders only the menu-less auth surface here. The auth-
  // guarded routes below deliberately do NOT set hideMenu — the menu shows by
  // default on every authenticated page, including any future ones.
  { path: '', component: LandingComponent, data: { hideMenu: true } },
  { path: 'login', component: LoginComponent, data: { hideMenu: true } },
  { path: 'register', component: RegisterComponent, data: { hideMenu: true } },
  // Phase 23: password-recovery flow. Public routes — neither requires a
  // JWT. /reset-password reads its one-time token from ?token=… in the URL.
  { path: 'forgot-password', component: ForgotPasswordComponent, data: { hideMenu: true } },
  { path: 'reset-password', component: ResetPasswordComponent, data: { hideMenu: true } },
  // Phase 24: email-verification flow. Public route; the link in the
  // verification email lands here with ?token=… appended. The component
  // POSTs to /api/auth/verify-email and on success swaps the freshly minted
  // JWT into the AuthService before routing to /chat.
  { path: 'verify-email', component: VerifyEmailComponent, data: { hideMenu: true } },
  // Phase 25 (admin bypass): magic-link redeem. Public route; the URL is
  // minted by `scripts/create-admin-magic-link.js` and pasted into a
  // browser. Redeems for a session JWT, then routes to /admin. Hard-gated
  // server-side by NODE_ENV + ADMIN_MAGIC_LINK_ENABLED.
  { path: 'admin-login', component: MagicLoginComponent, data: { hideMenu: true } },
  { path: 'chat', component: ChatComponent, canActivate: [authGuard] },
  {
    path: 'change-password',
    component: ChangePasswordComponent,
    canActivate: [authGuard]
  },
  { path: 'admin', component: AdminComponent, canActivate: [adminGuard] },
  { path: '**', redirectTo: '' }
];
