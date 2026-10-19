import { Component, inject, OnInit } from '@angular/core';
import { CommonModule } from '@angular/common';
import { TranslatePipe, TranslateService } from '@ngx-translate/core';
import { environment } from '../../../environments/environment';
import { apiFetch } from '../../services/api-client';
import { ConfirmService } from '../../services/confirm.service';

interface AdminDocument {
  id: number;
  user_id: number;
  user_email?: string;
  filename: string;
  content_type: string;
  chunk_count?: number;
  created_at: string;
}

@Component({
  selector: 'app-admin-documents',
  standalone: true,
  imports: [CommonModule, TranslatePipe],
  template: `
    <div class="nl-page-container">
      <h1>{{ 'adminDocuments.title' | translate }}</h1>

      <section class="nl-admin-card">
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
              <tr *ngIf="!documents.length">
                <td colspan="6" class="nl-empty-row">{{ 'adminDocuments.empty' | translate }}</td>
              </tr>
            </tbody>
          </table>
        </div>
      </section>

      <p class="nl-error-msg" *ngIf="error">{{ error }}</p>
    </div>
  `,
  styles: []
})
export class AdminDocumentsComponent implements OnInit {
  private readonly translate = inject(TranslateService);

  documents: AdminDocument[] = [];
  error = '';
  private apiUrl = `${environment.apiBaseUrl}/api/admin/documents`;

  constructor(private confirm: ConfirmService) {}

  async ngOnInit(): Promise<void> {
    await this.load();
  }

  private async load(): Promise<void> {
    try {
      const res = await apiFetch(`${this.apiUrl}?limit=100`, {
        headers: { Authorization: `Bearer ${localStorage.getItem('nomos_token') || ''}` }
      });
      if (!res.ok) throw new Error(`List failed (HTTP ${res.status})`);
      const data = await res.json();
      this.documents = data.documents || [];
    } catch (err) {
      // The server's prose is English ("List failed (HTTP 500)", "Access
      // denied.") and the UI is Greek: it is logged, never rendered. The user
      // gets the translated copy for this channel.
      console.warn('Unable to load the user documents', err);
      this.error = this.translate.instant('adminDocuments.loadError');
    }
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
      this.documents = this.documents.filter((d) => d.id !== doc.id);
    } catch (err) {
      console.warn('Unable to delete the user document', err);
      this.error = this.translate.instant('adminDocuments.deleteError');
    }
  }
}
