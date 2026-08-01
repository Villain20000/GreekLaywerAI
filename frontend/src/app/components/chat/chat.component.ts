import { Component, ElementRef, OnDestroy, OnInit, ViewChild } from '@angular/core';
import { CommonModule } from '@angular/common';
import { FormsModule } from '@angular/forms';
import { ActivatedRoute } from '@angular/router';
import { Subscription } from 'rxjs';
import { AiAnswer, AiService, AnswerSource } from '../../services/ai.service';
import { AuthService } from '../../services/auth.service';
import { Conversation, ConversationsService, Message as StoredMessage } from '../../services/conversations.service';
import { DocumentService, LegalDocument } from '../../services/document.service';
import gsap from 'gsap';

interface Message {
  role: 'user' | 'assistant';
  content: string;
  sources: AnswerSource[];
  confidence: number | null;
  messageId: number | null;
  feedback: boolean | null;
  feedbackSaving?: boolean;
  feedbackSubmitted?: boolean;
  sourcesOpen?: boolean;
}

@Component({
  selector: 'app-chat',
  standalone: true,
  imports: [CommonModule, FormsModule],
  template: `
    <div class="nl-chat-layout">
      <div class="nl-chat-messages" #scrollMe>
        <div
          *ngFor="let msg of messages; let i = index"
          class="nl-chat-message"
          [ngClass]="msg.role"
          [id]="'msg-' + i"
        >
          <div class="nl-chat-bubble">
            <div>{{ msg.content }}</div>
            <button
              *ngIf="msg.role === 'assistant' && msg.sources.length"
              type="button"
              class="nl-source-toggle"
              (click)="msg.sourcesOpen = !msg.sourcesOpen"
              [attr.aria-expanded]="msg.sourcesOpen"
            >
              {{ msg.sourcesOpen ? 'Απόκρυψη πηγών' : 'Πηγές' }} · {{ msg.sources.length }}
              <span *ngIf="msg.confidence !== null"> · {{ (msg.confidence * 100).toFixed(0) }}% βεβαιότητα</span>
            </button>
            <div *ngIf="msg.sourcesOpen" class="nl-source-list">
              <div *ngFor="let source of msg.sources; let sourceIndex = index" class="nl-source-item">
                <span class="nl-source-index">{{ sourceIndex + 1 }}</span>
                <span>
                  <strong>{{ source.title || source.filename || 'Νομική πηγή' }}</strong>
                  <small *ngIf="source.type === 'legislation' && source.articleNumber">
                    {{ source.sourceType || 'Νομοθεσία' }} · Άρθρο {{ source.articleNumber }}
                  </small>
                  <small *ngIf="source.type === 'document' && source.chunkIndex !== null && source.chunkIndex !== undefined">
                    Προσωπικό έγγραφο · Τμήμα {{ source.chunkIndex + 1 }}
                  </small>
                </span>
              </div>
            </div>
            <div *ngIf="msg.role === 'assistant' && msg.messageId" class="nl-feedback" aria-label="Αξιολόγηση απάντησης">
              <span class="nl-feedback-label">Ήταν χρήσιμη;</span>
              <button
                type="button"
                class="nl-feedback-button"
                [class.selected]="msg.feedback === true"
                [disabled]="msg.feedbackSaving"
                (click)="submitFeedback(msg, true)"
                aria-label="Χρήσιμη απάντηση"
              >👍</button>
              <button
                type="button"
                class="nl-feedback-button"
                [class.selected]="msg.feedback === false"
                [disabled]="msg.feedbackSaving"
                (click)="submitFeedback(msg, false)"
                aria-label="Μη χρήσιμη απάντηση"
              >👎</button>
              <small *ngIf="msg.feedbackSubmitted" class="nl-feedback-thanks">Ευχαριστούμε</small>
            </div>
          </div>
        </div>
        <div *ngIf="isLoading" class="nl-typing-indicator">
          Ο δικηγόρος γράφει…
        </div>
        <p *ngIf="loadError" class="nl-error-msg">{{ loadError }}</p>
      </div>

      <div *ngIf="documents.length" class="nl-document-picker">
        <div class="nl-document-picker-heading">
          <span>Έγγραφα για αυτή την ερώτηση</span>
          <button type="button" class="nl-document-clear" *ngIf="selectedDocumentIds.length" (click)="selectedDocumentIds = []">Καθαρισμός</button>
        </div>
        <label *ngFor="let doc of documents" class="nl-document-option">
          <input type="checkbox" [checked]="selectedDocumentIds.includes(doc.id)" (change)="toggleDocument(doc.id)" />
          <span>{{ doc.title || doc.filename }}</span>
        </label>
      </div>

      <div class="nl-chat-input-area">
        <button
          class="nl-chat-voice-btn"
          type="button"
          [class.recording]="isRecording"
          [attr.aria-label]="isRecording ? 'Stop recording' : 'Start recording'"
          (click)="toggleRecording()"
        >🎤</button>
        <textarea
          [(ngModel)]="currentInput"
          (keyup.enter)="sendMessage()"
          placeholder="Ask a legal question…"
          rows="1"
        ></textarea>
        <button
          type="button"
          (click)="sendMessage()"
          [disabled]="!currentInput.trim() || isLoading"
        >Send</button>
      </div>
    </div>
  `,
  styles: []
})
export class ChatComponent implements OnInit, OnDestroy {
  @ViewChild('scrollMe') private myScrollContainer!: ElementRef;

  messages: Message[] = [];
  documents: LegalDocument[] = [];
  selectedDocumentIds: number[] = [];
  currentInput = '';
  isLoading = false;
  isRecording = false;
  conversationId: number | null = null;
  conversation: Conversation | null = null;
  loadError = '';

  private mediaRecorder: MediaRecorder | null = null;
  private audioChunks: Blob[] = [];
  private responseSubscription: Subscription | null = null;
  private destroyed = false;

  constructor(
    private aiService: AiService,
    public auth: AuthService,
    private conversationsService: ConversationsService,
    private documentService: DocumentService,
    private route: ActivatedRoute
  ) {}

  async ngOnInit(): Promise<void> {
    const rawId = this.route.snapshot.queryParamMap.get('conversation');
    const id = rawId ? Number.parseInt(rawId, 10) : NaN;
    await Promise.all([
      Number.isInteger(id) && id > 0 ? this.loadConversation(id) : Promise.resolve(),
      this.loadDocuments()
    ]);
  }

  ngOnDestroy(): void {
    this.destroyed = true;
    this.responseSubscription?.unsubscribe();
    this.responseSubscription = null;
    if (this.mediaRecorder && this.mediaRecorder.state !== 'inactive') {
      this.mediaRecorder.stop();
    }
    this.mediaRecorder?.stream.getTracks().forEach(track => track.stop());
  }

  logout(): void {
    this.auth.logout();
  }

  async sendMessage(): Promise<void> {
    const userMsg = this.currentInput.trim();
    if (!userMsg || this.isLoading || this.destroyed) return;

    this.messages.push({ role: 'user', content: userMsg, sources: [], confidence: null, messageId: null, feedback: null });
    this.currentInput = '';
    this.isLoading = true;
    this.scrollToBottom();

    const userMessageIndex = this.messages.length - 1;
    setTimeout(() => {
      if (!this.destroyed) {
        gsap.from(`#msg-${userMessageIndex}`, {
          opacity: 0,
          y: 20,
          duration: 0.5
        });
      }
    }, 0);

    const assistantMsgIndex = this.messages.push({
      role: 'assistant', content: '', sources: [], confidence: null, messageId: null, feedback: null
    }) - 1;
    await this.runTextQuery(userMsg, assistantMsgIndex);
  }

  private async runTextQuery(prompt: string, assistantMsgIndex: number): Promise<void> {
    try {
      const hadConversation = this.conversationId !== null;
      const conversationId = await this.ensureConversation(prompt);
      if (this.destroyed) return;

      this.responseSubscription = this.aiService.streamQuery(prompt, conversationId, this.selectedDocumentIds).subscribe({
        next: (answer: AiAnswer) => {
          this.isLoading = false;
          this.messages[assistantMsgIndex].content += answer.content;
          this.messages[assistantMsgIndex].sources = answer.sources;
          this.messages[assistantMsgIndex].confidence = answer.confidence;
          this.messages[assistantMsgIndex].messageId = answer.messageId;
          this.scrollToBottom();
        },
        error: (err) => {
          console.error(err);
          this.messages[assistantMsgIndex].content = 'Σφάλμα επικοινωνίας με το μοντέλο.';
          this.isLoading = false;
          if (!hadConversation && (err as { stage?: string })?.stage === 'enqueue') {
            void this.removeEmptyConversation(conversationId);
          }
        },
        complete: () => {
          this.isLoading = false;
          this.responseSubscription = null;
        }
      });
    } catch (err) {
      console.error(err);
      this.messages[assistantMsgIndex].content = 'Αδυναμία δημιουργίας συνομιλίας.';
      this.isLoading = false;
    }
  }

  private async removeEmptyConversation(id: number): Promise<void> {
    try {
      await this.conversationsService.remove(id);
      if (this.conversationId === id) {
        this.conversationId = null;
        this.conversation = null;
      }
    } catch (cleanupError) {
      // Cleanup is best effort; the original inference error is more useful
      // to the user than a secondary deletion failure.
      console.warn('Unable to remove empty conversation', cleanupError);
    }
  }

  private async ensureConversation(prompt: string): Promise<number> {
    if (this.conversationId !== null) return this.conversationId;
    const title = prompt.length > 72 ? `${prompt.slice(0, 69)}…` : prompt;
    const created = await this.conversationsService.create(title);
    this.conversationId = created.id;
    this.conversation = created;
    return created.id;
  }

  private async loadConversation(id: number): Promise<void> {
    this.isLoading = true;
    this.loadError = '';
    try {
      const result = await this.conversationsService.get(id);
      if (this.destroyed) return;
      this.conversationId = result.conversation.id;
      this.conversation = result.conversation;
      this.messages = result.messages
        .filter((message: StoredMessage) => message.role !== 'system')
        .map((message: StoredMessage) => ({
          role: message.role === 'user' ? 'user' : 'assistant',
          content: message.content,
          messageId: message.id,
          feedback: typeof message.feedback_helpful === 'boolean' ? message.feedback_helpful : null,
          feedbackSubmitted: typeof message.feedback_helpful === 'boolean',
          sources: message.citation_metadata?.sources || [],
          confidence: typeof message.citation_metadata?.confidence === 'number'
            ? message.citation_metadata.confidence
            : null
        }));
      this.scrollToBottom();
    } catch (err) {
      console.error(err);
      this.loadError = 'Αδυναμία φόρτωσης της συνομιλίας.';
    } finally {
      if (!this.destroyed) this.isLoading = false;
    }
  }

  private async loadDocuments(): Promise<void> {
    try {
      this.documents = await this.documentService.list(50, 0);
    } catch (err) {
      // Document-aware chat is an enhancement; legislation chat remains usable
      // if the document list is temporarily unavailable.
      console.warn('Unable to load documents for chat', err);
    }
  }

  toggleDocument(id: number): void {
    this.selectedDocumentIds = this.selectedDocumentIds.includes(id)
      ? this.selectedDocumentIds.filter((selectedId) => selectedId !== id)
      : [...this.selectedDocumentIds, id];
  }

  async toggleRecording(): Promise<void> {
    if (this.isRecording) {
      this.stopRecording();
    } else {
      await this.startRecording();
    }
  }

  private async startRecording(): Promise<void> {
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      if (this.destroyed) {
        stream.getTracks().forEach(track => track.stop());
        return;
      }
      this.mediaRecorder = new MediaRecorder(stream);
      this.audioChunks = [];

      this.mediaRecorder.ondataavailable = (event) => {
        this.audioChunks.push(event.data);
      };

      this.mediaRecorder.onstop = () => {
        const audioBlob = new Blob(this.audioChunks, { type: 'audio/webm' });
        if (!this.destroyed && audioBlob.size > 0) void this.sendAudioQuery(audioBlob);
      };

      this.mediaRecorder.start();
      this.isRecording = true;
    } catch (err) {
      console.error('Microphone access denied', err);
    }
  }

  private stopRecording(): void {
    if (this.mediaRecorder && this.mediaRecorder.state !== 'inactive') {
      this.mediaRecorder.stop();
      this.mediaRecorder.stream.getTracks().forEach(track => track.stop());
    }
    this.isRecording = false;
  }

  submitFeedback(message: Message, helpful: boolean): void {
    if (!message.messageId || message.feedbackSaving) return;
    const previous = message.feedback;
    message.feedback = helpful;
    message.feedbackSaving = true;
    this.aiService.submitFeedback(message.messageId, helpful).then(() => {
      message.feedbackSubmitted = true;
    }).catch((error) => {
      console.error('Unable to submit answer feedback', error);
      message.feedback = previous;
    }).finally(() => {
      message.feedbackSaving = false;
    });
  }

  private async sendAudioQuery(blob: Blob): Promise<void> {
    if (this.destroyed || this.isLoading) return;
    this.messages.push({ role: 'user', content: '🎤 (Audio input)', sources: [], confidence: null, messageId: null, feedback: null });
    this.isLoading = true;
    const assistantMsgIndex = this.messages.push({
      role: 'assistant', content: '', sources: [], confidence: null, messageId: null, feedback: null
    }) - 1;

    try {
      const conversationId = await this.ensureConversation('Ηχητική ερώτηση');
      if (this.destroyed) return;
      this.responseSubscription = this.aiService.uploadAudio(blob, conversationId).subscribe({
        next: (answer: AiAnswer) => {
          this.isLoading = false;
          this.messages[assistantMsgIndex].content += answer.content;
          this.messages[assistantMsgIndex].sources = answer.sources;
          this.messages[assistantMsgIndex].confidence = answer.confidence;
          this.messages[assistantMsgIndex].messageId = answer.messageId;
          this.scrollToBottom();
        },
        error: (err) => {
          console.error(err);
          this.messages[assistantMsgIndex].content = 'Σφάλμα ήχου.';
          this.isLoading = false;
        },
        complete: () => {
          this.isLoading = false;
          this.responseSubscription = null;
        }
      });
    } catch (err) {
      console.error(err);
      this.messages[assistantMsgIndex].content = 'Αδυναμία δημιουργίας συνομιλίας.';
      this.isLoading = false;
    }
  }

  private scrollToBottom(): void {
    setTimeout(() => {
      if (this.destroyed) return;
      if (this.myScrollContainer) {
        this.myScrollContainer.nativeElement.scrollTop =
          this.myScrollContainer.nativeElement.scrollHeight;
      }
    }, 100);
  }
}
