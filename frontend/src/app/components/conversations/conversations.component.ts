import { Component, inject, OnInit } from '@angular/core';
import { CommonModule } from '@angular/common';
import { FormsModule } from '@angular/forms';
import { Router, RouterLink } from '@angular/router';
import { TranslatePipe, TranslateService } from '@ngx-translate/core';
import { ConversationsService, Conversation } from '../../services/conversations.service';
import { ConfirmService } from '../../services/confirm.service';

@Component({
  selector: 'app-conversations',
  standalone: true,
  imports: [CommonModule, FormsModule, RouterLink, TranslatePipe],
  template: `
    <div class="nl-page-container">
      <h1>{{ 'conversations.title' | translate }}</h1>

      <div class="nl-form-group">
        <button class="nl-btn-primary" (click)="newConversation()">{{ 'conversations.new' | translate }}</button>
      </div>

      <section class="nl-admin-card">
        <div class="nl-conversation-search">
          <input
            class="nl-input"
            [(ngModel)]="query"
            (keyup.enter)="applySearch()"
            [attr.placeholder]="'conversations.searchPlaceholder' | translate"
            [attr.aria-label]="'conversations.searchAria' | translate"
          />
          <button class="nl-btn-primary" (click)="applySearch()">{{ 'conversations.search' | translate }}</button>
          <button class="nl-btn-secondary" *ngIf="query.trim()" (click)="clearSearch()">{{ 'conversations.clear' | translate }}</button>
        </div>

        <div class="nl-table-scroll" tabindex="0" role="region" [attr.aria-label]="'conversations.tableAria' | translate">
          <table class="nl-admin-table">
            <thead>
              <tr>
                <th>{{ 'conversations.colTitle' | translate }}</th>
                <th>{{ 'conversations.colUpdated' | translate }}</th>
                <th></th>
                <th></th>
              </tr>
            </thead>
            <tbody>
              <tr *ngFor="let conv of conversations">
                <td>
                  <a [routerLink]="['/chat']" [queryParams]="{ conversation: conv.id }">{{ conv.title }}</a>
                </td>
                <td>{{ conv.updated_at | date: 'short' }}</td>
                <td>
                  <button class="nl-btn-secondary" (click)="startRename(conv)">{{ 'conversations.rename' | translate }}</button>
                </td>
                <td>
                  <button class="nl-btn-secondary" (click)="deleteConversation(conv)">{{ 'conversations.delete' | translate }}</button>
                </td>
              </tr>
              <tr *ngIf="!conversations.length && !loading">
                <td colspan="4" class="nl-empty-row">
                  {{ (query.trim() ? 'conversations.emptySearch' : 'conversations.empty') | translate }}
                </td>
              </tr>
            </tbody>
          </table>
        </div>

        <div class="nl-pagination" *ngIf="total > 0">
          <button class="nl-btn-secondary" (click)="previousPage()" [disabled]="page === 1 || loading">{{ 'conversations.previous' | translate }}</button>
          <span class="nl-pagination-info">{{ 'conversations.page' | translate: { page: page, totalPages: totalPages, total: total } }}</span>
          <button class="nl-btn-secondary" (click)="nextPage()" [disabled]="page >= totalPages || loading">{{ 'conversations.next' | translate }}</button>
        </div>
      </section>

      <section *ngIf="renaming" class="nl-admin-card">
        <h2>{{ 'conversations.renameSection' | translate }}</h2>
        <div class="nl-form-group">
          <input
            class="nl-input"
            [(ngModel)]="renameTitle"
            [attr.placeholder]="'conversations.newTitlePlaceholder' | translate"
            [attr.aria-label]="'conversations.newTitleAria' | translate"
          />
          <button class="nl-btn-primary" (click)="confirmRename()" [disabled]="!renameTitle.trim()">{{ 'conversations.save' | translate }}</button>
          <button class="nl-btn-secondary" (click)="renaming = null">{{ 'conversations.cancel' | translate }}</button>
        </div>
      </section>

      <p class="nl-error-msg" *ngIf="error">{{ error }}</p>
    </div>
  `,
  styles: []
})
export class ConversationsComponent implements OnInit {
  private readonly translate = inject(TranslateService);

  conversations: Conversation[] = [];
  renaming: Conversation | null = null;
  renameTitle = '';
  error = '';

  query = '';
  pageSize = 20;
  offset = 0;
  total = 0;
  loading = false;

  constructor(
    private conversationsService: ConversationsService,
    private router: Router,
    private confirm: ConfirmService
  ) {}

  ngOnInit(): void {
    void this.load();
  }

  get page(): number {
    return Math.floor(this.offset / this.pageSize) + 1;
  }

  get totalPages(): number {
    return Math.max(1, Math.ceil(this.total / this.pageSize));
  }

  private async load(): Promise<void> {
    this.loading = true;
    try {
      const result = await this.conversationsService.listPage(this.pageSize, this.offset, this.query);
      this.conversations = result.conversations;
      this.total = result.total;
    } catch (err) {
      // The server's prose is English ("List conversations failed (HTTP 500)")
      // and the UI is Greek: it is logged, never rendered. The user gets the
      // translated copy for this channel.
      console.warn('Unable to load the conversations', err);
      this.error = this.translate.instant('conversations.loadError');
    } finally {
      this.loading = false;
    }
  }

  applySearch(): void {
    this.offset = 0;
    void this.load();
  }

  clearSearch(): void {
    this.query = '';
    this.applySearch();
  }

  nextPage(): void {
    if (this.page >= this.totalPages) return;
    this.offset += this.pageSize;
    void this.load();
  }

  previousPage(): void {
    if (this.page <= 1) return;
    this.offset = Math.max(0, this.offset - this.pageSize);
    void this.load();
  }

  async newConversation(): Promise<void> {
    try {
      const created = await this.conversationsService.create();
      await this.router.navigate(['/chat'], { queryParams: { conversation: created.id } });
    } catch (err) {
      console.warn('Unable to create the conversation', err);
      this.error = this.translate.instant('conversations.createError');
    }
  }

  startRename(conv: Conversation): void {
    this.renaming = conv;
    this.renameTitle = conv.title;
  }

  async confirmRename(): Promise<void> {
    if (!this.renaming || !this.renameTitle.trim()) return;
    try {
      await this.conversationsService.rename(this.renaming.id, this.renameTitle.trim());
      this.renaming = null;
      await this.load();
    } catch (err) {
      console.warn('Unable to rename the conversation', err);
      this.error = this.translate.instant('conversations.renameError');
    }
  }

  async deleteConversation(conv: Conversation): Promise<void> {
    const confirmed = await this.confirm.ask({
      title: this.translate.instant('conversations.deleteTitle'),
      message: this.translate.instant('conversations.deleteMessage', { title: conv.title }),
      confirmLabel: this.translate.instant('conversations.delete'),
      cancelLabel: this.translate.instant('conversations.cancel')
    });
    if (!confirmed) return;
    try {
      await this.conversationsService.remove(conv.id);
      await this.load();
    } catch (err) {
      console.warn('Unable to delete the conversation', err);
      this.error = this.translate.instant('conversations.deleteError');
    }
  }
}
