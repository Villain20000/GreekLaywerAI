import { Component, inject, OnInit } from '@angular/core';
import { CommonModule } from '@angular/common';
import { FormsModule } from '@angular/forms';
import { TranslatePipe, TranslateService } from '@ngx-translate/core';
import { environment } from '../../../environments/environment';
import { apiFetch } from '../../services/api-client';
import { ConfirmService } from '../../services/confirm.service';

interface AdminDocument {
  id: number;
  user_id: number;
  user_email?: string;
  filename: string;
  title?: string;
  content_type: string;
  file_size?: number;
  chunk_count?: number;
  created_at: string;
}

@Component({
  selector: 'app-admin-documents',
  standalone: true,
  imports: [CommonModule, FormsModule, TranslatePipe],
  template: `
    <div class="nl-page-container">
      <h1>{{ 'adminDocuments.title' | translate }}</h1>

      <section class="nl-admin-card">
        <form class="nl-admin-filters" (ngSubmit)="applyFilters()">
          <input
            class="nl-input"
            type="search"
            name="q"
            [(ngModel)]="q"
            [attr.placeholder]="'adminDocuments.searchPlaceholder' | translate"
            [attr.aria-label]="'adminDocuments.searchPlaceholder' | translate"
          />
          <input
            class="nl-input nl-input-narrow"
            type="number"
            min="1"
            name="userId"
            [(ngModel)]="userId"
            [attr.placeholder]="'adminDocuments.userIdPlaceholder' | translate"
            [attr.aria-label]="'adminDocuments.userIdAria' | translate"
          />
          <button class="refresh-btn" type="submit" [disabled]="isLoading">
            {{ (isLoading ? 'adminDocuments.loading' : 'adminDocuments.search') | translate }}
          </button>
          <button class="nl-btn-secondary" type="button" (click)="clearFilters()" [disabled]="isLoading">
            {{ 'adminDocuments.clear' | translate }}
          </button>
        </form>

        <div class="nl-table-scroll" tabindex="0" role="region" [attr.aria-label]="'adminDocuments.tableAria' | translate">
          <table class="nl-admin-table">
            <thead>
              <tr>
                <th>{{ 'adminDocuments.colFile' | translate }}</th>
                <th>{{ 'adminDocuments.colUser' | translate }}</th>
                <th>{{ 'adminDocuments.colType' | translate }}</th>
                <th>{{ 'adminDocuments.colChunks' | translate }}</th>
                <th>{{ 'adminDocuments.colUploaded' | translate }}</th>
                <th></th>
              </tr>
            </thead>
            <tbody>
              <tr *ngFor="let doc of documents">
                <td>{{ doc.filename }}</td>
                <td>{{ doc.user_email }}</td>
                <td>{{ doc.content_type }}</td>
                <td>{{ doc.chunk_count ?? '—' }}</td>
                <td>{{ doc.created_at | date: 'short' }}</td>
                <td>
                  <button class="nl-btn-secondary" (click)="deleteDoc(doc)">{{ 'adminDocuments.delete' | translate }}</button>
                </td>
              </tr>
              <tr *ngIf="isLoading && !documents.length">
                <td colspan="6" class="nl-empty-row">{{ 'adminDocuments.loading' | translate }}</td>
              </tr>
              <tr *ngIf="!isLoading && !documents.length">
                <td colspan="6" class="nl-empty-row">{{ 'adminDocuments.empty' | translate }}</td>
              </tr>
            </tbody>
          </table>
        </div>

        <div class="nl-pager" *ngIf="total > 0">
          <button
            class="nl-btn-secondary"
            type="button"
            (click)="prevPage()"
            [disabled]="offset === 0 || isLoading"
          >{{ 'adminDocuments.previous' | translate }}</button>
          <span class="nl-pager-label">
            {{ 'adminDocuments.pager' | translate: { start: pageStart(), end: pageEnd(), total: total } }}
          </span>
          <button
            class="nl-btn-secondary"
            type="button"
            (click)="nextPage()"
            [disabled]="offset + limit >= total || isLoading"
          >{{ 'adminDocuments.next' | translate }}</button>
        </div>
      </section>

      <p class="nl-error-msg" *ngIf="error">{{ error }}</p>
    </div>
  `,
  styles: [`
    .nl-admin-filters { display: flex; align-items: center; gap: 0.75rem; flex-wrap: wrap; padding-bottom: var(--nl-space-4); }
    .nl-admin-filters > button { width: auto; flex: 0 0 auto; }
    .nl-input-narrow { max-width: 7.5rem; }
    .nl-pager { display: flex; align-items: center; justify-content: flex-end; gap: 0.75rem; margin-top: var(--nl-space-4); }
    .nl-pager-label { font-size: 0.8rem; color: var(--nl-fg-subtle); }
  `]
})
export class AdminDocumentsComponent implements OnInit {
  private readonly translate = inject(TranslateService);

  documents: AdminDocument[] = [];
  error = '';
  isLoading = false;
  q = '';
  userId: number | null = null;
  readonly limit = 20;
  offset = 0;
  total = 0;
  private apiUrl = `${environment.apiBaseUrl}/api/admin/documents`;

  constructor(private confirm: ConfirmService) {}

  async ngOnInit(): Promise<void> {
    await this.load();
  }

  private buildQuery(): string {
    const params = new URLSearchParams({
      limit: String(this.limit),
      offset: String(this.offset)
    });
    const q = this.q.trim();
    if (q) params.set('q', q);
    const userId = Number(this.userId);
    if (this.userId !== null && Number.isInteger(userId) && userId > 0) {
      params.set('userId', String(userId));
    }
    return params.toString();
  }

  private async load(): Promise<void> {
    this.isLoading = true;
    this.error = '';
    try {
      const res = await apiFetch(`${this.apiUrl}?${this.buildQuery()}`, {
        headers: { Authorization: `Bearer ${localStorage.getItem('nomos_token') || ''}` }
      });
      if (!res.ok) throw new Error(`List failed (HTTP ${res.status})`);
      const data = await res.json();
      this.documents = data.documents || [];
      this.total = Number(data.total) || 0;
    } catch (err) {
      // The server's prose is English ("List failed (HTTP 500)", "Access
      // denied.") and the UI is Greek: it is logged, never rendered. The user
      // gets the translated copy for this channel.
      console.warn('Unable to load the user documents', err);
      this.error = this.translate.instant('adminDocuments.loadError');
      this.documents = [];
      this.total = 0;
    } finally {
      this.isLoading = false;
    }
  }

  async applyFilters(): Promise<void> {
    this.offset = 0;
    await this.load();
  }

  async clearFilters(): Promise<void> {
    this.q = '';
    this.userId = null;
    this.offset = 0;
    await this.load();
  }

  async prevPage(): Promise<void> {
    if (this.offset === 0) return;
    this.offset = Math.max(0, this.offset - this.limit);
    await this.load();
  }

  async nextPage(): Promise<void> {
    if (this.offset + this.limit >= this.total) return;
    this.offset += this.limit;
    await this.load();
  }

  pageStart(): number {
    return this.total === 0 ? 0 : this.offset + 1;
  }

  pageEnd(): number {
    return this.offset + this.documents.length;
  }

  async deleteDoc(doc: AdminDocument): Promise<void> {
    const confirmed = await this.confirm.ask({
      title: this.translate.instant('adminDocuments.deleteTitle'),
      message: this.translate.instant('adminDocuments.deleteMessage', {
        filename: doc.filename,
        email: doc.user_email
      }),
      confirmLabel: this.translate.instant('adminDocuments.delete'),
      cancelLabel: this.translate.instant('common.cancel')
    });
    if (!confirmed) return;
    try {
      const res = await apiFetch(`${this.apiUrl}/${doc.id}`, {
        method: 'DELETE',
        headers: { Authorization: `Bearer ${localStorage.getItem('nomos_token') || ''}` }
      });
      if (!res.ok) throw new Error(`Delete failed (HTTP ${res.status})`);
    } catch (err) {
      console.warn('Unable to delete the user document', err);
      this.error = this.translate.instant('adminDocuments.deleteError');
      return;
    }
    this.documents = this.documents.filter((d) => d.id !== doc.id);
    this.total = Math.max(0, this.total - 1);
    // An empty last page would otherwise show while earlier rows exist.
    if (this.offset > 0 && this.documents.length === 0) {
      this.offset = Math.max(0, this.offset - this.limit);
    }
    await this.load();
  }
}
