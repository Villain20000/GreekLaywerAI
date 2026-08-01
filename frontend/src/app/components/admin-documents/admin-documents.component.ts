import { Component, OnInit } from '@angular/core';
import { CommonModule } from '@angular/common';
import { environment } from '../../../environments/environment';
import { apiFetch } from '../../services/api-client';

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
  imports: [CommonModule],
  template: `
    <div class="nl-page-container">
      <h1>Διαχείριση εγγράφων</h1>

      <section class="nl-admin-card">
        <table class="nl-admin-table">
          <thead>
            <tr><th>Αρχείο</th><th>Χρήστης</th><th>Τύπος</th><th>Κομμάτια</th><th>Ανέβηκε</th><th></th></tr>
          </thead>
          <tbody>
            <tr *ngFor="let doc of documents">
              <td>{{ doc.filename }}</td>
              <td>{{ doc.user_email }}</td>
              <td>{{ doc.content_type }}</td>
              <td>{{ doc.chunk_count ?? '—' }}</td>
              <td>{{ doc.created_at | date: 'short' }}</td>
              <td>
                <button class="nl-btn-secondary" (click)="deleteDoc(doc)">Διαγραφή</button>
              </td>
            </tr>
            <tr *ngIf="!documents.length">
              <td colspan="6" class="nl-empty-row">Κανένα έγγραφο.</td>
            </tr>
          </tbody>
        </table>
      </section>

      <p class="nl-error-msg" *ngIf="error">{{ error }}</p>
    </div>
  `,
  styles: []
})
export class AdminDocumentsComponent implements OnInit {
  documents: AdminDocument[] = [];
  error = '';
  private apiUrl = `${environment.apiBaseUrl}/api/admin/documents`;

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
      this.error = err instanceof Error ? err.message : 'Αποτυχία φόρτωσης';
    }
  }

  async deleteDoc(doc: AdminDocument): Promise<void> {
    if (!confirm(`Διαγραφή του εγγράφου "${doc.filename}" του χρήστη ${doc.user_email}?`)) return;
    try {
      const res = await apiFetch(`${this.apiUrl}/${doc.id}`, {
        method: 'DELETE',
        headers: { Authorization: `Bearer ${localStorage.getItem('nomos_token') || ''}` }
      });
      if (!res.ok) throw new Error(`Delete failed (HTTP ${res.status})`);
      this.documents = this.documents.filter((d) => d.id !== doc.id);
    } catch (err) {
      this.error = err instanceof Error ? err.message : 'Αποτυχία διαγραφής';
    }
  }
}
