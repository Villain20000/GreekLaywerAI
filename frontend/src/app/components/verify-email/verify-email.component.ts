import { Component, OnInit } from '@angular/core';
import { CommonModule } from '@angular/common';
import { ActivatedRoute, Router, RouterLink } from '@angular/router';
import { AuthService } from '../../services/auth.service';

@Component({
  selector: 'app-verify-email',
  standalone: true,
  imports: [CommonModule, RouterLink],  templateUrl: './verify-email.component.html',
  // Phase 27 — zero per-component CSS. All chrome lives in
  // src/styles.scss via legacy-name aliases; templates untouched.
  styles: [] 
})
export class VerifyEmailComponent implements OnInit {
  finished = false;
  success = false;
  error = '';

  constructor(
    private authService: AuthService,
    private route: ActivatedRoute,
    private router: Router
  ) {}

  async ngOnInit() {
    // ActivatedRoute.snapshot is fine for a one-shot ?token= read.
    const token = this.route.snapshot.queryParamMap.get('token');
    if (!token || !/^[a-f0-9]{64}$/i.test(token)) {
      this.finished = true;
      this.success = false;
      this.error = 'Invalid or expired verification link. Please request a new one.';
      return;
    }

    const result = await this.authService.verifyEmail(token);
    this.finished = true;
    if (result.ok) {
      this.success = true;
      // AuthService has already swapped the rotated JWT into localStorage
      // + tokenSubject/userSubject. Move to /chat after a brief pause so
      // the success message reads before navigation.
      setTimeout(() => this.router.navigate(['/chat']), 600);
    } else {
      this.success = false;
      this.error = result.error;
    }
  }
}
