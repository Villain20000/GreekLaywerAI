import { Component, ElementRef, inject, OnDestroy, OnInit, ViewChild } from '@angular/core';
import { CommonModule } from '@angular/common';
import { FormsModule } from '@angular/forms';
import { ActivatedRoute, Router } from '@angular/router';
import { Subscription } from 'rxjs';
import { TranslatePipe, TranslateService } from '@ngx-translate/core';
import {
  AiAnswer,
  AiService,
  AnswerSource,
  RESPONSE_TIMEOUT_NOTICE
} from '../../services/ai.service';
import { AuthService } from '../../services/auth.service';
import { BillingService } from '../../services/billing.service';
import { Conversation, ConversationsService, Message as StoredMessage } from '../../services/conversations.service';
import { DocumentService, LegalDocument } from '../../services/document.service';
import { consumedQuotaUsed, QuotaExceededError } from '../../services/quota.service';
import DOMPurify from 'dompurify';
import { marked } from 'marked';
import gsap from 'gsap';

/** Messages fetched per conversation page (initial load and "load older"). */
const CONVERSATION_PAGE_SIZE = 50;

interface Message {
  role: 'user' | 'assistant';
  content: string;
  sources: AnswerSource[];
  confidence: number | null;
  messageId: number | null;
  feedback: boolean | null;
  feedbackSaving?: boolean;
  feedbackSubmitted?: boolean;
  feedbackReason?: string;
  sourcesOpen?: boolean;
  createdAt: string;
  copied?: boolean;
}

@Component({
  selector: 'app-chat',
  standalone: true,
  imports: [CommonModule, FormsModule, TranslatePipe],
  template: `
    <div class="nl-chat-shell">
      <aside class="nl-chat-side" [attr.aria-label]="'chat.recentAria' | translate">
        <button type="button" class="nl-btn-primary nl-chat-new" (click)="startNewChat()">
          {{ 'chat.newConversation' | translate }}
        </button>
        <div class="nl-chat-side-list">
          <button
            *ngFor="let conv of recentConversations"
            type="button"
            class="nl-chat-side-item"
            [class.active]="conv.id === conversationId"
            (click)="openConversation(conv.id)"
          >
            <span class="nl-chat-side-title">{{ conv.title}}</span>
            <small>{{ conv.updated_at | date: 'short' }}</small>
          </button>
          <p *ngIf="!recentConversations.length" class="nl-chat-side-empty">
            {{ 'chat.noConversations' | translate }}
          </p>
        </div>
      </aside>

      <div class="nl-chat-layout">
        <!-- aria-live stays off for the answer currently being produced and
             flips to polite once it is complete, so screen readers do not
             announce every streaming chunk. Coarse status changes (slow,
             stop, error, completion) use the sr-only status region below. -->
        <div class="nl-chat-messages" #scrollMe [attr.aria-label]="'chat.messagesAria' | translate">
          <button
            *ngIf="hasMoreMessages && !isLoading"
            type="button"
            class="nl-btn-secondary nl-load-older"
            [disabled]="isLoadingOlder"
            (click)="loadOlderMessages()"
          >{{ 'chat.loadOlder' | translate }}</button>
          <p class="nl-success-msg" *ngIf="checkoutNotice">{{ checkoutNotice }}</p>
          <div
            *ngFor="let msg of messages; let i = index"
            class="nl-chat-message"
            [ngClass]="msg.role"
            [id]="'msg-' + i"
          >
            <div
              class="nl-chat-bubble"
              [attr.aria-live]="msg.role === 'assistant' ? (isLoading && i === messages.length - 1 ? 'off' : 'polite') : null"
              [attr.aria-busy]="msg.role === 'assistant' && isLoading && i === messages.length - 1 ? 'true' : null"
              [attr.aria-atomic]="msg.role === 'assistant' ? 'true' : null"
            >
              <div
                *ngIf="msg.role === 'assistant'; else userContent"
                class="nl-markdown"
                [innerHTML]="renderMarkdown(msg.content)"
              ></div>
              <ng-template #userContent>
                <div>{{ msg.content }}</div>
              </ng-template>
              <button
                *ngIf="msg.role === 'assistant' && msg.sources.length"
                type="button"
                class="nl-source-toggle"
                (click)="msg.sourcesOpen = !msg.sourcesOpen"
                [attr.aria-expanded]="msg.sourcesOpen"
                [attr.aria-controls]="'sources-' + i"
              >
                {{ (msg.sourcesOpen ? 'chat.sourcesHide' : 'chat.sourcesShow') | translate }} · {{ msg.sources.length }}
                <span *ngIf="msg.confidence !== null"> · {{ 'chat.confidence' | translate: { percent: (msg.confidence * 100).toFixed(0) } }}</span>
              </button>
              <div *ngIf="msg.sourcesOpen" class="nl-source-list" [id]="'sources-' + i">
                <div *ngFor="let source of msg.sources; let sourceIndex = index" class="nl-source-item">
                  <span class="nl-source-index">{{ sourceIndex + 1 }}</span>
                  <span>
                    <strong>{{ source.title || source.filename || ('chat.legalSource' | translate) }}</strong>
                    <small *ngIf="source.type === 'legislation' && source.articleNumber">
                      {{ source.sourceType || ('chat.legislation' | translate) }} · {{ 'chat.article' | translate: { number: source.articleNumber } }}
                    </small>
                    <small *ngIf="source.type === 'document' && source.chunkIndex !== null && source.chunkIndex !== undefined">
                      {{ 'chat.personalDocument' | translate: { number: source.chunkIndex + 1 } }}
                    </small>
                  </span>
                </div>
              </div>
              <div *ngIf="msg.role === 'assistant' && msg.messageId" class="nl-feedback" [attr.aria-label]="'chat.feedbackAria' | translate">
                <span class="nl-feedback-label">{{ 'chat.feedbackWasHelpful' | translate }}</span>
                <button
                  type="button"
                  class="nl-feedback-button"
                  [class.selected]="msg.feedback === true"
                  [disabled]="msg.feedbackSaving"
                  (click)="submitFeedback(msg, true)"
                  [attr.aria-label]="'chat.feedbackHelpfulAria' | translate"
                >👍</button>
                <button
                  type="button"
                  class="nl-feedback-button"
                  [class.selected]="msg.feedback === false"
                  [disabled]="msg.feedbackSaving"
                  (click)="submitFeedback(msg, false)"
                  [attr.aria-label]="'chat.feedbackUnhelpfulAria' | translate"
                >👎</button>
                <small *ngIf="msg.feedbackSubmitted" class="nl-feedback-thanks">{{ 'chat.feedbackThanks' | translate }}</small>
              </div>
              <div *ngIf="msg.role === 'assistant' && msg.messageId && msg.feedback !== null" class="nl-feedback-reason">
                <input
                  class="nl-input"
                  [(ngModel)]="msg.feedbackReason"
                  [attr.placeholder]="'chat.feedbackReasonPlaceholder' | translate"
                  [attr.aria-label]="'chat.feedbackReasonAria' | translate"
                  maxlength="500"
                />
                <button
                  type="button"
                  class="nl-btn-secondary"
                  [disabled]="msg.feedbackSaving || !msg.feedbackReason?.trim()"
                  (click)="submitFeedbackReason(msg)"
                >{{ 'chat.submitReason' | translate }}</button>
              </div>
            </div>
            <div class="nl-message-meta">
              <time *ngIf="msg.createdAt" [attr.datetime]="msg.createdAt">{{ msg.createdAt | date: 'shortTime' }}</time>
              <button
                type="button"
                class="nl-message-action"
                (click)="copyMessage(msg)"
                [attr.aria-label]="(msg.copied ? 'chat.copiedAria' : 'chat.copyAria') | translate"
              >
                {{ (msg.copied ? 'chat.copied' : 'chat.copy') | translate }}
              </button>
              <button
                *ngIf="msg.role === 'assistant' && i === messages.length - 1 && !isLoading"
                type="button"
                class="nl-message-action"
                (click)="regenerate(msg)"
                [attr.aria-label]="'chat.regenerateAria' | translate"
              >{{ 'chat.regenerate' | translate }}</button>
            </div>
          </div>
          <div *ngIf="isLoading" class="nl-typing-indicator" role="status" aria-live="polite">
            {{ (isSlow ? 'chat.notices.slow' : 'chat.typing') | translate }}
          </div>
          <p *ngIf="quotaError && quotaError.canUpgrade" class="nl-quota-upgrade">
            <a
              class="nl-quota-upgrade-link"
              [attr.href]="'/subscriptions'"
              (click)="openUpgrade($event)"
            >{{ 'common.upgradePlan' | translate }}</a>
          </p>
          <p *ngIf="loadError" class="nl-error-msg">{{ loadError }}</p>
          <div class="nl-sr-only" role="status" aria-live="polite" aria-atomic="true">
            {{ screenReaderStatus }}
          </div>
        </div>

        <div *ngIf="documents.length" class="nl-document-picker">
          <div class="nl-document-picker-heading">
            <span>{{ 'chat.documentsForQuestion' | translate }}</span>
            <button type="button" class="nl-document-clear" *ngIf="selectedDocumentIds.length" (click)="selectedDocumentIds = []">{{ 'common.clear' | translate }}</button>
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
            [attr.aria-label]="(isRecording ? 'chat.voiceStop' : 'chat.voiceStart') | translate"
            (click)="toggleRecording()"
          >🎤</button>
          <textarea
            #chatInput
            [(ngModel)]="currentInput"
            (keydown.enter)="onEnterKey($event)"
            (input)="autoGrow($event)"
            [attr.placeholder]="'chat.inputPlaceholder' | translate"
            [attr.aria-label]="'chat.inputAria' | translate"
            rows="1"
          ></textarea>
          <button
            type="button"
            (click)="sendMessage()"
            [disabled]="!currentInput.trim() || isLoading"
            [attr.aria-label]="'chat.sendAria' | translate"
          >{{ 'chat.send' | translate }}</button>
          <button
            *ngIf="isLoading"
            type="button"
            class="nl-chat-stop-btn"
            (click)="stopGeneration()"
            [attr.aria-label]="'chat.stopAria' | translate"
          >{{ 'chat.stop' | translate }}</button>
        </div>
      </div>
    </div>
  `,
  styles: [`
    .nl-quota-upgrade { margin: 0 0 var(--nl-space-4); }
    .nl-quota-upgrade-link { color: var(--nl-fg); font-weight: 600; text-decoration: underline; cursor: pointer; }
    .nl-load-older { display: block; margin: 0 auto var(--nl-space-4); }
  `]
})
export class ChatComponent implements OnInit, OnDestroy {
  private readonly translate = inject(TranslateService);

  @ViewChild('scrollMe') private myScrollContainer!: ElementRef;
  @ViewChild('chatInput') private chatInputRef?: ElementRef<HTMLTextAreaElement>;

  messages: Message[] = [];
  /** Cursor pagination state for the loaded conversation. */
  hasMoreMessages = false;
  olderMessagesCursor: number | null = null;
  isLoadingOlder = false;
  documents: LegalDocument[] = [];
  selectedDocumentIds: number[] = [];
  recentConversations: Conversation[] = [];
  currentInput = '';
  isLoading = false;
  isSlow = false;
  isRecording = false;
  conversationId: number | null = null;
  conversation: Conversation | null = null;
  loadError = '';
  /** Checkout-return banner (mock payment success / Stripe success). */
  checkoutNotice = '';
  /**
   * Set when the last inference failed because the plan's daily AI quota is
   * exhausted. Drives the quota copy and the upgrade affordance.
   */
  quotaError: QuotaExceededError | null = null;
  /** Coarse, polite screen-reader announcements (never per-token). */
  screenReaderStatus = '';

  private mediaRecorder: MediaRecorder | null = null;
  private audioChunks: Blob[] = [];
  private responseSubscription: Subscription | null = null;
  private queryParamsSub: Subscription | null = null;
  private paramConversationId: number | null = null;
  private pendingConversationId: number | null = null;
  private initialized = false;
  private destroyed = false;

  constructor(
    private aiService: AiService,
    public auth: AuthService,
    private conversationsService: ConversationsService,
    private documentService: DocumentService,
    private billingService: BillingService,
    private route: ActivatedRoute,
    private router: Router
  ) {}

  async ngOnInit(): Promise<void> {
    if (this.initialized) return;
    this.initialized = true;

    const rawId = this.route.snapshot.queryParamMap.get('conversation');
    const id = this.parseConversationId(rawId);
    this.paramConversationId = id;

    await Promise.all([
      id !== null ? this.loadConversation(id) : Promise.resolve(),
      this.loadDocuments(),
      this.loadRecentConversations(),
      this.handleCheckoutReturn()
    ]);

    // React to later ?conversation= changes (side panel, browser back/forward).
    // The first emission mirrors the snapshot already handled above, so skip
    // it: re-applying it during in-flight conversation creation could clear
    // the just-started chat.
    let firstEmission = true;
    this.queryParamsSub = this.route.queryParamMap.subscribe(params => {
      if (firstEmission) {
        firstEmission = false;
        return;
      }
      this.skipQueryParamUpdate(params.get('conversation'));
    });
  }

  private skipQueryParamUpdate(rawId: string | null): void {
    const id = this.parseConversationId(rawId);
    const previous = this.paramConversationId;
    this.paramConversationId = id;
    if (id === null) {
      if (previous !== null) this.resetChatState();
      return;
    }
    if (id === this.conversationId || id === this.pendingConversationId) return;
    void this.loadConversation(id);
  }

  private parseConversationId(rawId: string | null): number | null {
    if (!rawId) return null;
    const id = Number.parseInt(rawId, 10);
    return Number.isInteger(id) && id > 0 ? id : null;
  }

  /**
   * Checkout-return handling:
   *   - `?mock_payment=success&tier=…` (dev mock checkout): confirm via
   *     POST /api/billing/mock-complete so the tier actually flips;
   *   - `?checkout=success` (real Stripe): the webhook applies the tier
   *     asynchronously — refresh the user snapshot and show a notice.
   * Query params are stripped afterwards so a page refresh can't replay.
   */
  private async handleCheckoutReturn(): Promise<void> {
    const params = this.route.snapshot.queryParamMap;
    const mockPayment = params.get('mock_payment');
    const checkout = params.get('checkout');
    const tier = params.get('tier');

    if (!mockPayment && !checkout) return;

    void this.router.navigate([], { queryParams: {}, replaceUrl: true });

    if (mockPayment === 'success') {
      if (tier && ['basic', 'pro', 'enterprise'].includes(tier)) {
        try {
          await this.billingService.completeMockCheckout(tier);
          await this.auth.refreshUser();
          this.checkoutNotice = this.translate.instant('chat.checkoutActivated', { tier });
        } catch (err) {
          // The billing backend's prose is English; log it and show the
          // translated copy for this channel instead of the raw message.
          console.warn('Unable to activate the subscription after checkout', err);
          this.checkoutNotice = this.translate.instant('chat.checkoutFailed');
        }
      }
      return;
    }

    if (checkout === 'success') {
      await this.auth.refreshUser();
      this.checkoutNotice = this.translate.instant('chat.checkoutSuccess');
    }
  }

  ngOnDestroy(): void {
    this.destroyed = true;
    this.responseSubscription?.unsubscribe();
    this.responseSubscription = null;
    this.queryParamsSub?.unsubscribe();
    this.queryParamsSub = null;
    if (this.mediaRecorder && this.mediaRecorder.state !== 'inactive') {
      this.mediaRecorder.stop();
    }
    this.mediaRecorder?.stream.getTracks().forEach(track => track.stop());
  }

  logout(): void {
    this.auth.logout();
  }

  /** Renders assistant markdown and strips anything DOMPurify considers unsafe. */
  renderMarkdown(content: string): string {
    if (!content) return '';
    const html = marked.parse(content, { async: false, gfm: true, breaks: true });
    return DOMPurify.sanitize(html);
  }

  onEnterKey(event: Event): void {
    const keyboardEvent = event as KeyboardEvent;
    // Shift+Enter keeps the browser's default newline; plain Enter sends.
    if (keyboardEvent.key !== 'Enter' || keyboardEvent.shiftKey) return;
    keyboardEvent.preventDefault();
    void this.sendMessage();
  }

  autoGrow(event: Event): void {
    const textarea = event.target as HTMLTextAreaElement | null;
    if (!textarea) return;
    textarea.style.height = 'auto';
    textarea.style.height = `${Math.min(textarea.scrollHeight, 200)}px`;
  }

  private resetInputHeight(): void {
    const textarea = this.chatInputRef?.nativeElement;
    if (textarea) textarea.style.height = 'auto';
  }

  async sendMessage(): Promise<void> {
    const userMsg = this.currentInput.trim();
    if (!userMsg || this.isLoading || this.destroyed) return;

    this.messages.push(this.createMessage('user', userMsg));
    this.currentInput = '';
    this.resetInputHeight();
    this.isLoading = true;
    this.isSlow = false;
    this.quotaError = null;
    this.screenReaderStatus = '';
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

    const assistantMsgIndex = this.messages.push(this.createMessage('assistant', '')) - 1;
    await this.runTextQuery(userMsg, assistantMsgIndex);
  }

  /** Cancels polling + in-flight requests; the service DELETEs the queued job. */
  stopGeneration(): void {
    if (!this.isLoading) return;
    this.responseSubscription?.unsubscribe();
    this.responseSubscription = null;
    this.isLoading = false;
    this.isSlow = false;
    const last = this.messages[this.messages.length - 1];
    if (last && last.role === 'assistant' && !last.content) {
      last.content = this.translate.instant('chat.stopped');
    }
    this.screenReaderStatus = this.translate.instant('chat.stopped');
  }

  async copyMessage(message: Message): Promise<void> {
    try {
      await this.writeClipboard(message.content);
      message.copied = true;
      setTimeout(() => { message.copied = false; }, 1500);
    } catch (error) {
      console.warn('Unable to copy message', error);
    }
  }

  private async writeClipboard(text: string): Promise<void> {
    if (navigator.clipboard && typeof navigator.clipboard.writeText === 'function') {
      await navigator.clipboard.writeText(text);
      return;
    }
    const textarea = document.createElement('textarea');
    textarea.value = text;
    textarea.setAttribute('readonly', '');
    textarea.style.position = 'fixed';
    textarea.style.opacity = '0';
    document.body.appendChild(textarea);
    textarea.select();
    document.execCommand('copy');
    document.body.removeChild(textarea);
  }

  async regenerate(message: Message): Promise<void> {
    if (this.isLoading || this.destroyed) return;
    const index = this.messages.indexOf(message);
    if (index < 1) return;
    const previousUser = [...this.messages.slice(0, index)].reverse().find(m => m.role === 'user');
    if (!previousUser) return;

    this.messages = this.messages.slice(0, index);
    this.isLoading = true;
    this.isSlow = false;
    this.quotaError = null;
    const assistantIndex = this.messages.push(this.createMessage('assistant', '')) - 1;
    await this.runTextQuery(previousUser.content, assistantIndex);
  }

  async startNewChat(): Promise<void> {
    this.resetChatState();
    await this.router.navigate(['/chat'], { queryParams: {} });
  }

  openConversation(id: number): void {
    if (id === this.conversationId) return;
    void this.router.navigate(['/chat'], { queryParams: { conversation: id } });
  }

  private resetChatState(): void {
    this.responseSubscription?.unsubscribe();
    this.responseSubscription = null;
    this.conversationId = null;
    this.conversation = null;
    this.messages = [];
    this.hasMoreMessages = false;
    this.olderMessagesCursor = null;
    this.isLoadingOlder = false;
    this.loadError = '';
    this.quotaError = null;
    this.isLoading = false;
    this.isSlow = false;
    this.screenReaderStatus = '';
  }

  private createMessage(role: 'user' | 'assistant', content: string): Message {
    return {
      role,
      content,
      sources: [],
      confidence: null,
      messageId: null,
      feedback: null,
      sourcesOpen: false,
      createdAt: new Date().toISOString()
    };
  }

  private async runTextQuery(prompt: string, assistantMsgIndex: number): Promise<void> {
    try {
      const hadConversation = this.conversationId !== null;
      const conversationId = await this.ensureConversation(prompt);
      if (this.destroyed) return;

      this.responseSubscription = this.aiService.streamQueryLive(prompt, conversationId, this.selectedDocumentIds).subscribe({
        next: (answer: AiAnswer) => {
          const assistant = this.messages[assistantMsgIndex];
          if (!assistant) return;
          if (answer.pending) {
            this.isSlow = true;
            return;
          }
          this.isSlow = false;
          this.quotaError = null;

          if (answer.partial) {
            // Token delta: append, never replace what was already shown.
            assistant.content += answer.content;
            this.scrollToBottom();
            return;
          }

          // Final answer (live `done` or polling fallback): metadata is only
          // trusted here. The final text is authoritative, but it must not be
          // appended again on top of the chunks that already rendered it.
          this.isLoading = false;
          if (answer.content) {
            // Prefer the authoritative final text when it contains what the
            // chunks already rendered (covers chunks missed before attach).
            if (!assistant.content || answer.content.includes(assistant.content)) {
              assistant.content = answer.content;
            }
          }
          assistant.sources = answer.sources;
          assistant.confidence = answer.confidence;
          assistant.messageId = answer.messageId;
          this.scrollToBottom();
        },
        error: (err) => {
          console.error(err);
          const assistant = this.messages[assistantMsgIndex];
          if (assistant) {
            const errorText = this.describeError(err, 'chat.errors.model');
            assistant.content = assistant.content
              ? `${assistant.content}\n\n${errorText}`
              : errorText;
            this.screenReaderStatus = errorText;
          }
          this.isLoading = false;
          this.isSlow = false;
          if (!hadConversation && (err as { stage?: string })?.stage === 'enqueue') {
            void this.removeEmptyConversation(conversationId);
          }
        },
        complete: () => {
          this.isLoading = false;
          this.isSlow = false;
          this.screenReaderStatus = this.translate.instant('chat.completed');
          this.responseSubscription = null;
        }
      });
    } catch (err) {
      console.error(err);
      this.messages[assistantMsgIndex].content = this.translate.instant('chat.errors.conversationCreate');
      this.isLoading = false;
      this.isSlow = false;
    }
  }

  /**
   * Maps an inference failure onto the copy the user reads.
   *
   * A quota rejection (HTTP 429) is explicit: the daily AI allowance is
   * exhausted and it resets at a known time. It must NOT be reported as a
   * communication error with the model. The timeout notice keeps its own
   * copy; everything else falls back to the generic message.
   */
  private describeError(err: unknown, fallbackKey: string): string {
    if (err instanceof QuotaExceededError) {
      this.quotaError = err;
      if (err.kind === 'ai' && err.hasCounts && err.resetAt) {
        // The backend counts the rejected attempt too, so a refusal arrives
        // as `used: 21` against `limit: 20`. Show the consumed allowance
        // ("20/20"), never the over-count ("21/20").
        return this.translate.instant('chat.errors.quota', {
          used: consumedQuotaUsed(err.used, err.limit) ?? 0,
          limit: err.limit,
          resetAt: this.formatResetAt(err.resetAt)
        });
      }
      return this.translate.instant('chat.errors.quotaGeneric');
    }
    this.quotaError = null;
    const detail = err instanceof Error ? err.message : '';
    // The service signals its own timeout with a language-neutral sentinel;
    // the wording shown to the user comes from the dictionary.
    if (detail === RESPONSE_TIMEOUT_NOTICE) return this.translate.instant('chat.notices.timeout');
    return this.translate.instant(fallbackKey);
  }

  /** Local wall-clock HH:MM for the quota reset timestamp. */
  formatResetAt(resetAt: string): string {
    const date = new Date(resetAt);
    if (Number.isNaN(date.getTime())) return resetAt;
    const hours = String(date.getHours()).padStart(2, '0');
    const minutes = String(date.getMinutes()).padStart(2, '0');
    return `${hours}:${minutes}`;
  }

  /** Sends the user to the plans page (upgrade affordance). */
  openUpgrade(event: Event): void {
    event.preventDefault();
    void this.router.navigate(['/subscriptions']);
  }

  private async removeEmptyConversation(id: number): Promise<void> {
    try {
      await this.conversationsService.remove(id);
      if (this.conversationId === id) {
        this.conversationId = null;
        this.conversation = null;
      }
      void this.loadRecentConversations();
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
    this.paramConversationId = created.id;
    void this.loadRecentConversations();
    // Keep the URL shareable/refresh-safe without adding a history entry.
    void this.router.navigate(['/chat'], {
      queryParams: { conversation: created.id },
      replaceUrl: true
    });
    return created.id;
  }

  private async loadRecentConversations(): Promise<void> {
    try {
      this.recentConversations = await this.conversationsService.list(20, 0);
    } catch (err) {
      // The side panel is an enhancement; chat stays usable without it.
      console.warn('Unable to load recent conversations', err);
    }
  }

  private async loadConversation(id: number): Promise<void> {
    if (this.pendingConversationId === id || this.conversationId === id) return;
    // Switching conversations abandons any in-flight answer; unsubscribing
    // also asks the backend to drop the queued job.
    this.responseSubscription?.unsubscribe();
    this.responseSubscription = null;
    this.pendingConversationId = id;
    this.hasMoreMessages = false;
    this.olderMessagesCursor = null;
    this.isLoadingOlder = false;
    this.isLoading = true;
    this.isSlow = false;
    this.loadError = '';
    try {
      const result = await this.conversationsService.get(id, { messageLimit: CONVERSATION_PAGE_SIZE });
      if (this.destroyed) return;
      this.conversationId = result.conversation.id;
      this.conversation = result.conversation;
      this.messages = this.mapStoredMessages(result.messages);
      this.hasMoreMessages = result.hasMore === true;
      this.olderMessagesCursor = typeof result.nextCursor === 'number'
        ? result.nextCursor
        : this.oldestStoredMessageId(result.messages);
      this.scrollToBottom();
    } catch (err) {
      console.error(err);
      this.loadError = this.translate.instant('chat.errors.loadConversation');
    } finally {
      this.pendingConversationId = null;
      if (!this.destroyed) this.isLoading = false;
    }
  }

  /**
   * Prepends the page older than the current cursor, de-duplicating ids and
   * compensating the scroll offset so the reading position does not jump.
   */
  async loadOlderMessages(): Promise<void> {
    const conversationId = this.conversationId;
    const cursor = this.olderMessagesCursor;
    if (this.isLoading || this.isLoadingOlder || !this.hasMoreMessages ||
        conversationId === null || cursor === null) {
      return;
    }

    const container = this.myScrollContainer?.nativeElement as HTMLElement | undefined;
    const previousScrollHeight = container?.scrollHeight ?? 0;
    const previousScrollTop = container?.scrollTop ?? 0;
    this.isLoadingOlder = true;
    try {
      const result = await this.conversationsService.get(conversationId, {
        messageLimit: CONVERSATION_PAGE_SIZE,
        before: cursor
      });
      if (this.destroyed || this.conversationId !== conversationId) return;

      const older = this.mapStoredMessages(result.messages);
      const existingIds = new Set(
        this.messages
          .map(message => message.messageId)
          .filter((messageId): messageId is number => typeof messageId === 'number')
      );
      const fresh = older.filter(
        message => message.messageId === null || !existingIds.has(message.messageId)
      );
      this.messages = [...fresh, ...this.messages];
      this.hasMoreMessages = result.hasMore === true;
      this.olderMessagesCursor = typeof result.nextCursor === 'number'
        ? result.nextCursor
        : this.oldestStoredMessageId(result.messages) ?? cursor;
      this.restoreScrollPosition(previousScrollHeight, previousScrollTop);
    } catch (err) {
      console.error('Unable to load older messages', err);
    } finally {
      this.isLoadingOlder = false;
    }
  }

  private mapStoredMessages(stored: StoredMessage[]): Message[] {
    return stored
      .filter((message: StoredMessage) => message.role !== 'system')
      .map((message: StoredMessage) => ({
        role: message.role === 'user' ? 'user' : 'assistant',
        content: message.content,
        messageId: message.id,
        feedback: typeof message.feedback_helpful === 'boolean' ? message.feedback_helpful : null,
        feedbackSubmitted: typeof message.feedback_helpful === 'boolean',
        sources: message.citation_metadata?.sources || [],
        sourcesOpen: false,
        confidence: typeof message.citation_metadata?.confidence === 'number'
          ? message.citation_metadata.confidence
          : null,
        createdAt: message.created_at
      }));
  }

  private oldestStoredMessageId(stored: StoredMessage[]): number | null {
    return stored.length > 0 ? stored[0].id : null;
  }

  private restoreScrollPosition(previousScrollHeight: number, previousScrollTop: number): void {
    setTimeout(() => {
      if (this.destroyed || !this.myScrollContainer) return;
      const element = this.myScrollContainer.nativeElement as HTMLElement;
      element.scrollTop = previousScrollTop + (element.scrollHeight - previousScrollHeight);
    });
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

  submitFeedback(message: Message, helpful: boolean, reason?: string): void {
    if (!message.messageId || message.feedbackSaving) return;
    const previous = message.feedback;
    const trimmedReason = reason?.trim();
    message.feedback = helpful;
    message.feedbackSaving = true;
    const request = trimmedReason
      ? this.aiService.submitFeedback(message.messageId, helpful, trimmedReason)
      : this.aiService.submitFeedback(message.messageId, helpful);
    request.then(() => {
      message.feedbackSubmitted = true;
    }).catch((error) => {
      console.error('Unable to submit answer feedback', error);
      message.feedback = previous;
    }).finally(() => {
      message.feedbackSaving = false;
    });
  }

  submitFeedbackReason(message: Message): void {
    const reason = (message.feedbackReason || '').trim();
    if (!message.messageId || message.feedback === null || !reason) return;
    this.submitFeedback(message, message.feedback, reason);
  }

  private async sendAudioQuery(blob: Blob): Promise<void> {
    if (this.destroyed || this.isLoading) return;
    this.messages.push(this.createMessage('user', this.translate.instant('chat.audioQuestion')));
    this.isLoading = true;
    this.isSlow = false;
    const assistantMsgIndex = this.messages.push(this.createMessage('assistant', '')) - 1;

    try {
      const conversationId = await this.ensureConversation(this.translate.instant('chat.audioQuestionTitle'));
      if (this.destroyed) return;
      this.responseSubscription = this.aiService.uploadAudio(blob, conversationId).subscribe({
        next: (answer: AiAnswer) => {
          if (answer.pending) {
            this.isSlow = true;
            return;
          }
          this.isSlow = false;
          this.isLoading = false;
          this.quotaError = null;
          this.messages[assistantMsgIndex].content += answer.content;
          this.messages[assistantMsgIndex].sources = answer.sources;
          this.messages[assistantMsgIndex].confidence = answer.confidence;
          this.messages[assistantMsgIndex].messageId = answer.messageId;
          this.scrollToBottom();
        },
        error: (err) => {
          console.error(err);
          this.messages[assistantMsgIndex].content = this.describeError(err, 'chat.errors.audio');
          this.isLoading = false;
          this.isSlow = false;
          this.screenReaderStatus = this.messages[assistantMsgIndex].content;
        },
        complete: () => {
          this.isLoading = false;
          this.isSlow = false;
          this.screenReaderStatus = this.translate.instant('chat.completed');
          this.responseSubscription = null;
        }
      });
    } catch (err) {
      console.error(err);
      this.messages[assistantMsgIndex].content = this.translate.instant('chat.errors.conversationCreate');
      this.isLoading = false;
      this.isSlow = false;
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
