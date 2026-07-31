import { Component, OnInit } from '@angular/core';
import { CommonModule } from '@angular/common';
import { FormsModule } from '@angular/forms';
import { RouterLink } from '@angular/router';
import { ConversationsService, Conversation } from '../../services/conversations.service';

@Component({
  selector: 'app-conversations',
  standalone: true,
  imports: [CommonModule, FormsModule, RouterLink],
  template: `
    <div class="nl-page-container">
      <h1>Συνομιλίες</h1>

      <div class="nl-form-group">
        <button class="nl-btn-primary" (click)="newConversation()">Νέα συνομιλία</button>
      </div>

      <section class="nl-admin-card">
        <table class="nl-admin-table">
          <thead>
            <tr><th>Τίτλος</th><th>Τελευταία ενημέρωση</th><th></th><th></th></tr>
          </thead>
          <tbody>
            <tr *ngFor="let conv of conversations">
              <td>
                <a [routerLink]="['/chat']" [queryParams]="{ conversation: conv.id }">{{ conv.title }}</a>
              </td>
              <td>{{ conv.updated_at | date: 'short' }}</td>
              <td>
                <button class="nl-btn-secondary" (click)="startRename(conv)">Μετονομασία</button>
              </td>
              <td>
                <button class="nl-btn-secondary" (click)="deleteConversation(conv)">Διαγραφή</button>
              </td>
            </tr>
            <tr *ngIf="!conversations.length">
              <td colspan="4" class="nl-empty-row">Καμία συνομιλία ακόμα.</td>
            </tr>
          </tbody>
        </table>
      </section>

      <section *ngIf="renaming" class="nl-admin-card">
        <h2>Μετονομασία</h2>
        <div class="nl-form-group">
          <input class="nl-input" [(ngModel)]="renameTitle" placeholder="Νέος τίτλος" aria-label="New conversation title" />
          <button class="nl-btn-primary" (click)="confirmRename()" [disabled]="!renameTitle.trim()">Αποθήκευση</button>
          <button class="nl-btn-secondary" (click)="renaming = null">Άκυρο</button>
        </div>
      </section>

      <p class="nl-error-msg" *ngIf="error">{{ error }}</p>
    </div>
  `,
  styles: []
})
export class ConversationsComponent implements OnInit {
  conversations: Conversation[] = [];
  renaming: Conversation | null = null;
  renameTitle = '';
  error = '';

  constructor(private conversationsService: ConversationsService) {}

  ngOnInit(): void {
    this.load();
  }

  private async load(): Promise<void> {
    try {
      this.conversations = await this.conversationsService.list();
    } catch (err) {
      this.error = err instanceof Error ? err.message : 'Αποτυχία φόρτωσης συνομιλιών';
    }
  }

  async newConversation(): Promise<void> {
    try {
      await this.conversationsService.create();
      this.load();
    } catch (err) {
      this.error = err instanceof Error ? err.message : 'Αποτυχία δημιουργίας';
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
      this.load();
    } catch (err) {
      this.error = err instanceof Error ? err.message : 'Αποτυχία μετονομασίας';
    }
  }

  async deleteConversation(conv: Conversation): Promise<void> {
    if (!confirm(`Διαγραφή της συνομιλίας "${conv.title}";`)) return;
    try {
      await this.conversationsService.remove(conv.id);
      this.load();
    } catch (err) {
      this.error = err instanceof Error ? err.message : 'Αποτυχία διαγραφής';
    }
  }
}
