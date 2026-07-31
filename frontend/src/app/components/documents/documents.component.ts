import { Component, OnInit } from '@angular/core';
import { CommonModule } from '@angular/common';
import { FormsModule } from '@angular/forms';
import { DocumentService, LegalDocument, SearchResult } from '../../services/document.service';

@Component({
  selector: 'app-documents',
  standalone: true,
  imports: [CommonModule, FormsModule],
  template: `
    <div class="nl-page-container">
      <h1>Έγγραφα</h1>

      <section class="nl-admin-card">
        <h2>Ανέβασμα εγγράφου</h2>
        <input
          type="file"
          accept=".pdf,.docx,.txt,application/pdf,text/plain"
          (change)="onFileSelected($event)"
          aria-label="Choose a document to upload"
        />
        <p class="nl-prompt-text" *ngIf="uploading">Ανέβασμα και επεξεργασία…</p>
        <p class="nl-error-msg" *ngIf="uploadError">{{ uploadError }}</p>
        <p class="nl-success-msg" *ngIf="uploadOk">{{ uploadOk }}</p>
      </section>

      <section class="nl-admin-card">
        <h2>Αναζήτηση</h2>
        <div class="nl-form-group">
          <input
            class="nl-input"
            [(ngModel)]="searchQuery"
            (keyup.enter)="doSearch()"
            placeholder="Αναζήτηση στα έγγραφά σας…"
            aria-label="Search your documents"
          />
          <button class="nl-btn-primary" (click)="doSearch()" [disabled]="!searchQuery.trim()">Αναζήτηση</button>
        </div>
        <ul *ngIf="searchResults.length">
          <li *ngFor="let r of searchResults" class="nl-search-hit">
            <strong>{{ r.filename }}</strong> — ομοιότητα {{ (r.similarity * 100).toFixed(1) }}%
            <p class="nl-prompt-text">{{ r.content.slice(0, 300) }}</p>
          </li>
        </ul>
      </section>

      <section class="nl-admin-card">
        <h2>Τα έγγραφά σας</h2>
        <table class="nl-admin-table">
          <thead>
            <tr><th>Αρχείο</th><th>Τύπος</th><th>Μέγεθος</th><th>Ανέβηκε</th><th></th></tr>
          </thead>
          <tbody>
            <tr *ngFor="let doc of documents">
              <td>{{ doc.filename }}</td>
              <td>{{ doc.content_type }}</td>
              <td>{{ formatSize(doc.metadata?.['size_bytes']) }}</td>
              <td>{{ doc.created_at | date: 'short' }}</td>
              <td>
                <button class="nl-btn-secondary" (click)="deleteDoc(doc)">Διαγραφή</button>
              </td>
            </tr>
            <tr *ngIf="!documents.length">
              <td colspan="5" class="nl-empty-row">Κανένα έγγραφο ακόμα.</td>
            </tr>
          </tbody>
        </table>
      </section>
    </div>
  `,
  styles: []
})
export class DocumentsComponent implements OnInit {
  documents: LegalDocument[] = [];
  searchResults: SearchResult[] = [];
  searchQuery = '';
  uploading = false;
  uploadError = '';
  uploadOk = '';

  constructor(private documentService: DocumentService) {}

  ngOnInit(): void {
    this.load();
  }

  private async load(): Promise<void> {
    try {
      this.documents = await this.documentService.list();
    } catch (err) {
      this.uploadError = err instanceof Error ? err.message : 'Αποτυχία φόρτωσης';
    }
  }

  onFileSelected(event: Event): void {
    const input = event.target as HTMLInputElement;
    const file = input.files?.[0];
    if (!file) return;
    this.uploading = true;
    this.uploadError = '';
    this.uploadOk = '';
    this.documentService
      .upload(file)
      .then(({ document }) => {
        this.uploadOk = `Το έγγραφο "${document.filename}" ανέβηκε με επιτυχία.`;
        this.load();
      })
      .catch((err) => {
        this.uploadError = err instanceof Error ? err.message : 'Αποτυχία ανεβάσματος';
      })
      .finally(() => {
        this.uploading = false;
        input.value = '';
      });
  }

  async doSearch(): Promise<void> {
    if (!this.searchQuery.trim()) return;
    try {
      this.searchResults = await this.documentService.search(this.searchQuery.trim());
    } catch (err) {
      this.uploadError = err instanceof Error ? err.message : 'Αποτυχία αναζήτησης';
    }
  }

  async deleteDoc(doc: LegalDocument): Promise<void> {
    if (!confirm(`Διαγραφή του εγγράφου "${doc.filename}"; Αυτή η ενέργεια δεν αναστρέφεται.`)) return;
    try {
      await this.documentService.remove(doc.id);
      this.documents = this.documents.filter((d) => d.id !== doc.id);
    } catch (err) {
      this.uploadError = err instanceof Error ? err.message : 'Αποτυχία διαγραφής';
    }
  }

  formatSize(bytes: unknown): string {
    if (typeof bytes !== 'number') return '—';
    if (bytes < 1024) return `${bytes} B`;
    if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
    return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
  }
}
