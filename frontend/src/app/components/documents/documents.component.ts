import { Component, inject, OnInit } from '@angular/core';
import { CommonModule } from '@angular/common';
import { FormsModule } from '@angular/forms';
import { Router } from '@angular/router';
import { TranslatePipe, TranslateService } from '@ngx-translate/core';
import { DocumentService, LegalDocument, SearchResult } from '../../services/document.service';
import { ConfirmService } from '../../services/confirm.service';
import { consumedQuotaUsed, QuotaExceededError } from '../../services/quota.service';

const MAX_FILE_SIZE_BYTES = 25 * 1024 * 1024;

@Component({
  selector: 'app-documents',
  standalone: true,
  imports: [CommonModule, FormsModule, TranslatePipe],
  template: `
    <div class="nl-page-container">
      <h1>{{ 'documents.title' | translate }}</h1>

      <section class="nl-admin-card">
        <h2>{{ 'documents.uploadSection' | translate }}</h2>
        <input
          class="nl-input"
          [(ngModel)]="uploadTitle"
          [attr.placeholder]="'documents.titlePlaceholder' | translate"
          [attr.aria-label]="'documents.titleAria' | translate"
        />
        <div
          class="nl-dropzone"
          [class.dragging]="dragging"
          (dragover)="onDragOver($event)"
          (dragleave)="onDragLeave($event)"
          (drop)="onDrop($event)"
        >
          <p>{{ 'documents.dropText' | translate }}</p>
          <input
            type="file"
            accept=".pdf,.docx,.txt,application/pdf,text/plain"
            (change)="onFileSelected($event)"
            [attr.aria-label]="'documents.chooseAria' | translate"
          />
          <p class="nl-upload-hint">{{ 'documents.hint' | translate }}</p>
        </div>
        <div *ngIf="uploading" class="nl-upload-progress" role="progressbar" [attr.aria-valuenow]="uploadProgress">
          <div class="nl-upload-progress-bar" [style.width.%]="uploadProgress"></div>
          <span>{{ uploadProgress }}%</span>
        </div>
        <p class="nl-prompt-text" *ngIf="uploading && uploadProgress === 0">{{ 'documents.processing' | translate }}</p>
        <p class="nl-error-msg" *ngIf="uploadError">{{ uploadError }}</p>
        <p class="nl-quota-upgrade" *ngIf="capError && capError.canUpgrade">
          <a
            class="nl-quota-upgrade-link"
            [attr.href]="'/subscriptions'"
            (click)="openUpgrade($event)"
          >{{ 'common.upgradePlan' | translate }}</a>
        </p>
        <p class="nl-success-msg" *ngIf="uploadOk">{{ uploadOk }}</p>
      </section>

      <section class="nl-admin-card">
        <h2>{{ 'documents.searchSection' | translate }}</h2>
        <div class="nl-form-group">
          <input
            class="nl-input"
            [(ngModel)]="searchQuery"
            (keyup.enter)="doSearch()"
            [attr.placeholder]="'documents.searchPlaceholder' | translate"
            [attr.aria-label]="'documents.searchAria' | translate"
          />
          <button class="nl-btn-primary" (click)="doSearch()" [disabled]="!searchQuery.trim()">{{ 'common.search' | translate }}</button>
        </div>
        <p class="nl-error-msg" *ngIf="searchError">{{ searchError }}</p>
        <ul *ngIf="searchResults.length" class="nl-search-results">
          <li *ngFor="let r of searchResults" class="nl-search-hit">
            <div class="nl-search-hit-heading">
              <strong>{{ r.title || r.filename }}</strong>
              <span class="nl-search-hit-score">{{ 'documents.similarity' | translate: { percent: (r.similarity * 100).toFixed(1) } }}</span>
            </div>
            <p class="nl-prompt-text">{{ r.content.slice(0, 300) }}</p>
          </li>
        </ul>
      </section>

      <section class="nl-admin-card">
        <h2>{{ 'documents.yourDocuments' | translate }}</h2>
        <p class="nl-error-msg" *ngIf="loadError">{{ loadError }}</p>
        <p class="nl-error-msg" *ngIf="downloadError">{{ downloadError }}</p>
        <p class="nl-error-msg" *ngIf="deleteError">{{ deleteError }}</p>
        <div class="nl-table-scroll" tabindex="0" role="region" [attr.aria-label]="'documents.tableAria' | translate">
          <table class="nl-admin-table">
            <thead>
              <tr>
                <th>{{ 'documents.colFile' | translate }}</th>
                <th>{{ 'documents.colType' | translate }}</th>
                <th>{{ 'documents.colSize' | translate }}</th>
                <th>{{ 'documents.colUploaded' | translate }}</th>
                <th></th>
              </tr>
            </thead>
            <tbody>
              <tr *ngFor="let doc of documents">
                <td>{{ doc.title || doc.filename }}</td>
                <td>{{ doc.content_type }}</td>
                <td>{{ formatSize(doc.metadata['size_bytes']) }}</td>
                <td>{{ doc.created_at | date: 'short' }}</td>
                <td class="nl-document-actions">
                  <button class="nl-btn-secondary" (click)="previewDocument(doc)">{{ 'documents.preview' | translate }}</button>
                  <button class="nl-btn-secondary" (click)="downloadDocument(doc)">{{ 'documents.download' | translate }}</button>
                  <button class="nl-btn-secondary" (click)="deleteDoc(doc)">{{ 'documents.delete' | translate }}</button>
                </td>
              </tr>
              <tr *ngIf="!documents.length">
                <td colspan="5" class="nl-empty-row">{{ 'documents.empty' | translate }}</td>
              </tr>
            </tbody>
          </table>
        </div>
        <div *ngIf="hasMore" class="nl-load-more">
          <button class="nl-btn-secondary" (click)="loadMore()" [disabled]="loadingMore">
            {{ (loadingMore ? 'common.loading' : 'documents.loadMore') | translate }}
          </button>
        </div>
      </section>

      <section *ngIf="previewDoc" class="nl-admin-card nl-document-preview" [attr.aria-label]="'documents.previewAria' | translate">
        <div class="nl-document-preview-heading">
          <h2>{{ 'documents.previewTitle' | translate: { name: previewDoc.title || previewDoc.filename } }}</h2>
          <button class="nl-btn-secondary" (click)="closePreview()">{{ 'common.close' | translate }}</button>
        </div>
        <p class="nl-prompt-text" *ngIf="previewLoading">{{ 'documents.loadingContent' | translate }}</p>
        <p class="nl-error-msg" *ngIf="previewError">{{ previewError }}</p>
        <pre *ngIf="!previewLoading && !previewError" class="nl-document-text">{{ previewContent }}</pre>
      </section>
    </div>
  `,
  styles: [`
    .nl-quota-upgrade { margin: 0 0 var(--nl-space-4); }
    .nl-quota-upgrade-link { color: var(--nl-fg); font-weight: 600; text-decoration: underline; cursor: pointer; }
  `]
})
export class DocumentsComponent implements OnInit {
  private readonly translate = inject(TranslateService);

  documents: LegalDocument[] = [];
  searchResults: SearchResult[] = [];
  searchQuery = '';
  uploading = false;
  /** Upload failures only (rejected file, server error, plan cap). */
  uploadError = '';
  /** Listing failures — kept apart from the upload channel. */
  loadError = '';
  /** Search failures — kept apart from the upload channel. */
  searchError = '';
  /** Download failures — kept apart from the upload channel. */
  downloadError = '';
  /** Delete failures — kept apart from the upload channel. */
  deleteError = '';
  /**
   * Set when the last upload was rejected because the plan's document cap is
   * exhausted. Drives the cap copy and the upgrade affordance.
   */
  capError: QuotaExceededError | null = null;
  uploadOk = '';
  uploadTitle = '';
  uploadProgress = 0;
  dragging = false;

  pageSize = 20;
  private offset = 0;
  hasMore = false;
  loadingMore = false;

  previewDoc: LegalDocument | null = null;
  previewContent = '';
  previewLoading = false;
  previewError = '';

  constructor(
    private documentService: DocumentService,
    private confirm: ConfirmService,
    private router: Router
  ) {}

  ngOnInit(): void {
    void this.load();
  }

  private async load(): Promise<void> {
    this.offset = 0;
    try {
      this.documents = await this.documentService.list(this.pageSize, 0);
      this.hasMore = this.documents.length === this.pageSize;
    } catch (err) {
      // The server's prose is English ("Access denied.", "No file uploaded",
      // …) and the UI is Greek: it is logged, never rendered. The user gets
      // the translated copy for this channel.
      console.warn('Unable to load documents', err);
      this.loadError = this.translate.instant('documents.loadError');
    }
  }

  async loadMore(): Promise<void> {
    if (this.loadingMore || !this.hasMore) return;
    this.loadingMore = true;
    try {
      this.offset += this.pageSize;
      const more = await this.documentService.list(this.pageSize, this.offset);
      this.documents = [...this.documents, ...more];
      this.hasMore = more.length === this.pageSize;
    } catch (err) {
      this.offset -= this.pageSize;
      console.warn('Unable to load more documents', err);
      this.loadError = this.translate.instant('documents.loadError');
    } finally {
      this.loadingMore = false;
    }
  }

  onFileSelected(event: Event): void {
    const input = event.target as HTMLInputElement;
    const file = input.files?.[0];
    if (!file) return;
    void this.uploadFile(file).finally(() => {
      input.value = '';
    });
  }

  onDragOver(event: DragEvent): void {
    event.preventDefault();
    this.dragging = true;
  }

  onDragLeave(event: DragEvent): void {
    event.preventDefault();
    this.dragging = false;
  }

  onDrop(event: DragEvent): void {
    event.preventDefault();
    this.dragging = false;
    const file = event.dataTransfer?.files?.[0];
    if (file) void this.uploadFile(file);
  }

  private async uploadFile(file: File): Promise<void> {
    this.uploadError = '';
    this.uploadOk = '';
    this.capError = null;
    if (file.size > MAX_FILE_SIZE_BYTES) {
      this.uploadError = this.translate.instant('documents.tooLarge');
      return;
    }

    this.uploading = true;
    this.uploadProgress = 0;
    try {
      const { document } = await this.documentService.upload(
        file,
        this.uploadTitle.trim() || undefined,
        (percent) => { this.uploadProgress = percent; }
      );
      this.uploadOk = this.translate.instant('documents.uploadedOk', { filename: document.filename });
      this.uploadTitle = '';
      await this.load();
    } catch (err) {
      // A cap rejection is a billing state, not a transport failure: it gets
      // its own translated copy with the used/limit counts.
      if (err instanceof QuotaExceededError && err.kind === 'documents') {
        this.capError = err;
        this.uploadError = this.translate.instant(
          err.hasCounts ? 'documents.capReached' : 'documents.capGeneric',
          {
            // Clamp the over-count: the backend counts the rejected upload
            // too, so a refusal can report `used: 11` against `limit: 10`.
            used: consumedQuotaUsed(err.used, err.limit) ?? '',
            limit: err.limit ?? ''
          }
        );
      } else {
        // A generic failure (403 "Access denied.", 400 "No file uploaded",
        // 400 "Unsupported file type. Allowed: …") is English prose from
        // the server. Log it, show the translated upload copy. The
        // client-side size check above already produced the specific
        // `documents.tooLarge` copy.
        console.warn('Unable to upload the document', err);
        this.uploadError = this.translate.instant('documents.uploadError');
      }
    } finally {
      this.uploading = false;
      this.uploadProgress = 0;
    }
  }

  async doSearch(): Promise<void> {
    if (!this.searchQuery.trim()) return;
    this.searchError = '';
    try {
      this.searchResults = await this.documentService.search(this.searchQuery.trim());
    } catch (err) {
      console.warn('Unable to search the documents', err);
      this.searchError = this.translate.instant('documents.searchError');
    }
  }

  async previewDocument(doc: LegalDocument): Promise<void> {
    this.previewDoc = doc;
    this.previewContent = '';
    this.previewError = '';
    this.previewLoading = true;
    try {
      this.previewContent = await this.documentService.getContent(doc.id);
    } catch (err) {
      console.warn('Unable to load the document content', err);
      this.previewError = this.translate.instant('documents.previewError');
    } finally {
      this.previewLoading = false;
    }
  }

  closePreview(): void {
    this.previewDoc = null;
    this.previewContent = '';
    this.previewError = '';
    this.previewLoading = false;
  }

  async downloadDocument(doc: LegalDocument): Promise<void> {
    try {
      const content = await this.documentService.getContent(doc.id);
      const blob = new Blob([content], { type: 'text/plain;charset=utf-8' });
      const url = URL.createObjectURL(blob);
      const anchor = document.createElement('a');
      anchor.href = url;
      anchor.download = `${doc.title || doc.filename}.txt`;
      document.body.appendChild(anchor);
      anchor.click();
      document.body.removeChild(anchor);
      URL.revokeObjectURL(url);
    } catch (err) {
      console.warn('Unable to download the document', err);
      this.downloadError = this.translate.instant('documents.downloadError');
    }
  }

  async deleteDoc(doc: LegalDocument): Promise<void> {
    const confirmed = await this.confirm.ask({
      title: this.translate.instant('documents.deleteTitle'),
      message: this.translate.instant('documents.deleteMessage', { filename: doc.filename }),
      confirmLabel: this.translate.instant('documents.delete'),
      cancelLabel: this.translate.instant('common.cancel')
    });
    if (!confirmed) return;
    try {
      await this.documentService.remove(doc.id);
      this.documents = this.documents.filter((d) => d.id !== doc.id);
      if (this.previewDoc?.id === doc.id) this.closePreview();
    } catch (err) {
      console.warn('Unable to delete the document', err);
      this.deleteError = this.translate.instant('documents.deleteError');
    }
  }

  /** Sends the user to the plans page (upgrade affordance). */
  openUpgrade(event: Event): void {
    event.preventDefault();
    void this.router.navigate(['/subscriptions']);
  }

  formatSize(bytes: unknown): string {
    if (typeof bytes !== 'number') return '—';
    if (bytes < 1024) return `${bytes} B`;
    if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
    return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
  }
}
