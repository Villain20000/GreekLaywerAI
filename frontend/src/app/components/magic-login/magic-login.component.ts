import { Component, OnInit, inject } from '@angular/core';
import { CommonModule } from '@angular/common';
import { ActivatedRoute, Router, RouterLink } from '@angular/router';
import { TranslatePipe, TranslateService } from '@ngx-translate/core';
import { AuthService, authErrorMessage } from '../../services/auth.service';

/**
 * Phase 25 (admin bypass): MagicLoginComponent.
 *
 * Mirrors VerifyEmailComponent's shape so the team can grep both files
 * side-by-side, but its destination route is /admin instead of /chat
 * (only admins can mint a magic link) and the surface API is
 * /api/auth/admin-magic-link/redeem (the JWT kind claim is `admin_magic`,
 * which /verify-email's 32-byte-hex validator rejects).
 *
 * Flow:
 *  1. Operator runs `node src/scripts/create-admin-magic-link.js admin@nomos.ai`
 *     — script prints `http://localhost:4200/admin-login?token=<jwt>`.
 *  2. Operator pastes URL into a browser.
 *  3. This component reads ?token=, AuthService.verifyMagicLink() POSTs to
 *     the redeem endpoint. On success AuthService swaps the freshly-minted
 *     session JWT into localStorage + BehaviorSubjects; we then route to
 *     /admin. The brief 600 ms pause gives the success message time to be
 *     readable before navigation tears the route down.
 */
@Component({
  selector: 'app-magic-login',
  standalone: true,
  imports: [CommonModule, RouterLink, TranslatePipe],  templateUrl: './magic-login.component.html',
  // Phase 27 — zero per-component CSS. All chrome lives in
  // src/styles.scss via legacy-name aliases; templates untouched.
  styles: [] 
})
export class MagicLoginComponent implements OnInit {
  private readonly translate = inject(TranslateService);

  finished = false;
  success = false;
  error = '';

  constructor(
    private authService: AuthService,
    private route: ActivatedRoute,
    private router: Router
  ) {}

  async ngOnInit() {
    // One-shot snapshot read is fine for the simple ?token= case; matches
    // VerifyEmailComponent's pattern.
    const token = this.route.snapshot.queryParamMap.get('token');
    if (!token) {
      this.finished = true;
      this.error = this.translate.instant('auth.magic.noToken');
      return;
    }

    const result = await this.authService.verifyMagicLink(token);
    this.finished = true;
    if (result.ok) {
      this.success = true;
      // AuthService has already swapped the freshly-minted session JWT
      // into localStorage + tokenSubject/userSubject. The role in the
      // response is sourced from the LIVE users row — if the admin was
      // demoted between mint and redeem the redeem would have 403'd.
      // We extra-defensively route based on userValue.role so /admin
      // never renders for a non-admin (adminGuard backs this up too).
      setTimeout(() => {
        const role = this.authService.userValue?.role;
        this.router.navigate([role === 'admin' ? '/admin' : '/chat']);
      }, 600);
    } else {
      // The backend's `code` picks the translated copy (e.g.
      // `invalid_token` → auth.errors.invalidToken, `admin_role_required`
      // → auth.errors.adminRoleRequired); the raw English server prose is
      // never shown to the user.
      this.error = authErrorMessage(this.translate, result);
    }
  }
}
