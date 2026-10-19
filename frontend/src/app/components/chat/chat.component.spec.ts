import { ComponentFixture, TestBed } from '@angular/core/testing';
import { BehaviorSubject, of, Subject, throwError } from 'rxjs';
import { convertToParamMap, ParamMap } from '@angular/router';
import { ChatComponent } from './chat.component';
import { AuthService, AuthUser } from '../../services/auth.service';
import { AiService, AiAnswer, RESPONSE_TIMEOUT_NOTICE } from '../../services/ai.service';
import { BillingService } from '../../services/billing.service';
import { Conversation, ConversationsService } from '../../services/conversations.service';
import { DocumentService } from '../../services/document.service';
import { QuotaExceededError } from '../../services/quota.service';
import { ActivatedRoute, Router } from '@angular/router';
import { lookupTranslation, provideTestTranslate } from '../../i18n/testing';

/**
 * Phase 29: the header (admin link / email chip) moved to the menu
 * component in Phase 27; these specs verify what the chat component
 * actually owns: the message list, input handling, the typing indicator,
 * and logout delegation.
 */
function buildAiStub(): Partial<AiService> {
  return {
    streamQuery: jasmine.createSpy('streamQuery').and.returnValue(of({ content: 'απάντηση', messageId: 42, sources: [], confidence: 0 })),
    uploadAudio: jasmine.createSpy('uploadAudio').and.returnValue(of({ content: 'ήχος', messageId: 43, sources: [], confidence: 0 })),
    submitFeedback: jasmine.createSpy('submitFeedback').and.resolveTo({ id: 1, message_id: 42, user_id: 7, helpful: true, reason: null, created_at: '2026-01-01', updated_at: '2026-01-01' })
  };
}

function conversationStub(id: number, title: string): Conversation {
  return { id, title, created_at: '2026-01-01', updated_at: '2026-01-01' };
}

describe('ChatComponent (message rendering + input handling)', () => {
  let fixture: ComponentFixture<ChatComponent>;
  let userSub: BehaviorSubject<AuthUser | null>;
  let mockAuth: Pick<AuthService, 'tokenValue' | 'ready$' | 'user$' | 'logout' | 'refreshUser'>;
  let mockAi: Partial<AiService>;
  let mockConversations: Pick<ConversationsService, 'create' | 'get' | 'remove' | 'list'>;
  let mockDocuments: Pick<DocumentService, 'list'>;
  let routeGetSpy: jasmine.Spy;
  let queryParamSubject: BehaviorSubject<ParamMap>;
  let mockBilling: { completeMockCheckout: jasmine.Spy };

  beforeEach(async () => {
    userSub = new BehaviorSubject<AuthUser | null>(null);
    mockAuth = {
      tokenValue: 'jwt-test',
      ready$: new BehaviorSubject<boolean>(true).asObservable(),
      user$: userSub.asObservable(),
      logout: jasmine.createSpy('logout'),
      refreshUser: jasmine.createSpy('refreshUser').and.resolveTo(undefined)
    };
    mockAi = buildAiStub();
    mockDocuments = {
      list: jasmine.createSpy('list').and.resolveTo([])
    };
    queryParamSubject = new BehaviorSubject<ParamMap>(convertToParamMap({}));
    routeGetSpy = jasmine.createSpy('routeGet').and.callFake((key: string) => queryParamSubject.value.get(key));
    mockBilling = {
      completeMockCheckout: jasmine.createSpy('completeMockCheckout').and.resolveTo({ tier: 'pro', status: 'active' })
    };
    mockConversations = {
      create: jasmine.createSpy('create').and.resolveTo({
        id: 7,
        title: 'Τι προβλέπει ο Αστικός Κώδικας;',
        created_at: '2026-01-01',
        updated_at: '2026-01-01'
      }),
      get: jasmine.createSpy('get').and.callFake((id: number) => Promise.resolve({
        conversation: conversationStub(id, 'Υπάρχουσα συνομιλία'),
        messages: []
      })),
      remove: jasmine.createSpy('remove').and.resolveTo(undefined),
      list: jasmine.createSpy('list').and.resolveTo([])
    };

    await TestBed.configureTestingModule({
      imports: [ChatComponent],
      providers: [
        // 2-8: the chat template renders through the translate pipe and the
        // component resolves runtime strings via TranslateService.instant();
        // the in-memory loader keeps the Greek copy under the default `el`.
        ...provideTestTranslate(),
        { provide: AuthService, useValue: mockAuth },
        { provide: AiService, useValue: mockAi },
        { provide: ConversationsService, useValue: mockConversations },
        { provide: DocumentService, useValue: mockDocuments },
        { provide: BillingService, useValue: mockBilling },
        {
          provide: ActivatedRoute,
          useValue: {
            snapshot: { queryParamMap: { get: routeGetSpy } },
            queryParamMap: queryParamSubject.asObservable()
          }
        },
        {
          provide: Router,
          useValue: { navigate: jasmine.createSpy('navigate').and.resolveTo(true) }
        }
      ]
    }).compileComponents();

    fixture = TestBed.createComponent(ChatComponent);
  });

  it('starts with an empty message list and disabled send state', () => {
    fixture.detectChanges();
    const bubbles = fixture.nativeElement.querySelectorAll('.nl-chat-bubble');
    expect(bubbles.length).toBe(0);
    const sendBtn = fixture.nativeElement.querySelector('.nl-chat-input-area textarea + button');
    expect(sendBtn.disabled).toBeTrue();
  });

  it('renders the user and assistant messages after sendMessage()', async () => {
    const component = fixture.componentInstance;
    component.currentInput = 'Τι προβλέπει ο Αστικός Κώδικας;';
    await component.sendMessage();
    fixture.detectChanges();
    await fixture.whenStable();

    const bubbles = fixture.nativeElement.querySelectorAll('.nl-chat-bubble');
    expect(bubbles.length).toBe(2);
    expect(bubbles[0].textContent.trim()).toBe('Τι προβλέπει ο Αστικός Κώδικας;');
    expect((bubbles[1].firstElementChild as HTMLElement).textContent?.trim()).toBe('απάντηση');
    // Input is cleared after send.
    expect(component.currentInput).toBe('');
    // Assistant message arrives with role marker on the host row.
    const rows = fixture.nativeElement.querySelectorAll('.nl-chat-message');
    expect(rows[0].classList).toContain('user');
    expect(rows[1].classList).toContain('assistant');
  });

  it('does nothing on sendMessage with empty/whitespace input', () => {
    const component = fixture.componentInstance;
    component.currentInput = '   ';
    component.sendMessage();
    fixture.detectChanges();
    expect(component.messages.length).toBe(0);
    expect(mockAi.streamQuery).not.toHaveBeenCalled();
    expect(mockConversations.create).not.toHaveBeenCalled();
  });

  it('shows the typing indicator while an answer is pending', async () => {
    const component = fixture.componentInstance;
    component.currentInput = 'ερώτηση';
    const sendPromise = component.sendMessage();
    fixture.detectChanges();
    const indicator = fixture.nativeElement.querySelector('.nl-typing-indicator');
    await sendPromise;
    expect(indicator).not.toBeNull();
  });

  it('creates a conversation and passes its id to the AI request', async () => {
    const component = fixture.componentInstance;
    component.currentInput = 'ερώτηση';
    await component.sendMessage();
    await fixture.whenStable();

    expect(mockConversations.create).toHaveBeenCalledWith('ερώτηση');
    expect(mockAi.streamQuery).toHaveBeenCalledWith('ερώτηση', 7, []);
  });

  it('loads a conversation referenced by the query string', async () => {
    const route = TestBed.inject(ActivatedRoute) as unknown as { snapshot: { queryParamMap: { get: () => string } } };
    route.snapshot.queryParamMap.get = () => '7';
    const secondFixture = TestBed.createComponent(ChatComponent);
    await secondFixture.componentInstance.ngOnInit();
    await secondFixture.whenStable();

    expect(mockConversations.get).toHaveBeenCalledWith(7);
    expect(secondFixture.componentInstance.conversationId).toBe(7);
  });

  it('reacts to later ?conversation= query-param changes', async () => {
    fixture.detectChanges();
    await fixture.whenStable();

    queryParamSubject.next(convertToParamMap({ conversation: '9' }));
    await fixture.whenStable();

    expect(mockConversations.get).toHaveBeenCalledWith(9);
    expect(fixture.componentInstance.conversationId).toBe(9);
  });

  it('submits feedback for an assistant answer and marks it as acknowledged', async () => {
    const component = fixture.componentInstance;
    component.currentInput = 'ερώτηση';
    await component.sendMessage();
    fixture.detectChanges();

    const assistant = component.messages[1];
    component.submitFeedback(assistant, true);
    await fixture.whenStable();

    expect(mockAi.submitFeedback).toHaveBeenCalledWith(42, true);
    expect(assistant.feedback).toBeTrue();
    expect(assistant.feedbackSubmitted).toBeTrue();
  });

  it('sends a feedback reason when the user supplies one', async () => {
    const component = fixture.componentInstance;
    component.currentInput = 'ερώτηση';
    await component.sendMessage();
    fixture.detectChanges();

    const assistant = component.messages[1];
    component.submitFeedback(assistant, false);
    await fixture.whenStable();
    assistant.feedbackReason = '  Λείπουν οι πηγές  ';
    component.submitFeedbackReason(assistant);
    await fixture.whenStable();

    expect(mockAi.submitFeedback).toHaveBeenCalledWith(42, false, 'Λείπουν οι πηγές');
  });

  it('renders structured sources with an expandable source panel', async () => {
    (mockAi.streamQuery as jasmine.Spy).and.returnValue(of({
      content: 'τεκμηριωμένη απάντηση',
      messageId: 44,
      confidence: 0.87,
      sources: [{ type: 'legislation', id: 12, title: 'Αστικός Κώδικας', sourceType: 'ΑΚ', articleNumber: '57', similarity: 0.87 }]
    }));
    fixture.componentInstance.currentInput = 'ερώτηση';
    await fixture.componentInstance.sendMessage();
    fixture.detectChanges();

    const sourceToggle = fixture.nativeElement.querySelector('.nl-source-toggle');
    expect(sourceToggle).not.toBeNull();
    expect(sourceToggle.textContent).toContain('Πηγές');
    expect(sourceToggle.getAttribute('aria-expanded')).toBe('false');
    const controls = sourceToggle.getAttribute('aria-controls');
    expect(controls).toBe('sources-1');
    expect(fixture.nativeElement.querySelector(`#${controls}`)).toBeNull();
    sourceToggle.click();
    fixture.detectChanges();
    expect(sourceToggle.getAttribute('aria-expanded')).toBe('true');
    expect(fixture.nativeElement.querySelector(`#${controls}`).textContent).toContain('Αστικός Κώδικας');
  });

  it('applies a mock checkout return, refreshes the user and shows a notice', async () => {
    routeGetSpy.and.callFake((key: string) => {
      if (key === 'mock_payment') return 'success';
      if (key === 'tier') return 'pro';
      return null;
    });

    await fixture.componentInstance.ngOnInit();
    fixture.detectChanges();

    expect(mockBilling.completeMockCheckout).toHaveBeenCalledWith('pro');
    expect(mockAuth.refreshUser).toHaveBeenCalled();
    expect(fixture.componentInstance.checkoutNotice).toContain('pro');
    const notice = fixture.nativeElement.querySelector('.nl-success-msg');
    expect(notice?.textContent).toContain('pro');
  });

  it('shows a notice for a real Stripe checkout return without mocking payment', async () => {
    routeGetSpy.and.callFake((key: string) => (key === 'checkout' ? 'success' : null));

    await fixture.componentInstance.ngOnInit();
    fixture.detectChanges();

    expect(mockBilling.completeMockCheckout).not.toHaveBeenCalled();
    expect(mockAuth.refreshUser).toHaveBeenCalled();
    expect(fixture.componentInstance.checkoutNotice).toContain('πληρωμή');
  });

  it('shows the translated checkout failure copy — never the server prose', async () => {
    routeGetSpy.and.callFake((key: string) => {
      if (key === 'mock_payment') return 'success';
      if (key === 'tier') return 'pro';
      return null;
    });
    mockBilling.completeMockCheckout.and.rejectWith(new Error('Payment service unavailable'));

    await fixture.componentInstance.ngOnInit();
    fixture.detectChanges();

    expect(fixture.componentInstance.checkoutNotice)
      .toBe(lookupTranslation('el', 'chat.checkoutFailed')!);
    expect(fixture.componentInstance.checkoutNotice).not.toContain('Payment service unavailable');
    expect(fixture.nativeElement.textContent).not.toContain('Payment service unavailable');
  });

  it('logout() delegates to AuthService.logout', () => {
    const component = fixture.componentInstance;
    component.logout();
    expect(mockAuth.logout).toHaveBeenCalled();
  });

  it('renders assistant markdown sanitized (no scripts or event handlers)', async () => {
    const component = fixture.componentInstance;
    component.currentInput = 'ερώτηση';
    (mockAi.streamQuery as jasmine.Spy).and.returnValue(of({
      content: '**Έντονο** <script>alert(1)</script> <img src="x" onerror="alert(2)">',
      messageId: 50,
      sources: [],
      confidence: 0
    }));
    await component.sendMessage();
    fixture.detectChanges();

    const markdown = fixture.nativeElement.querySelector('.nl-markdown') as HTMLElement;
    expect(markdown.querySelector('strong')?.textContent).toBe('Έντονο');
    expect(markdown.querySelector('script')).toBeNull();
    expect(markdown.querySelector('img')?.getAttribute('onerror')).toBeNull();
    expect(component.renderMarkdown('<script>alert(1)</script>')).not.toContain('<script');
  });

  it('sends on Enter but keeps Shift+Enter for a newline', async () => {
    fixture.detectChanges();
    const textarea = fixture.nativeElement.querySelector('textarea') as HTMLTextAreaElement;
    const component = fixture.componentInstance;
    component.currentInput = 'πρώτη γραμμή';

    const shiftEnter = new KeyboardEvent('keydown', { key: 'Enter', shiftKey: true, bubbles: true, cancelable: true });
    textarea.dispatchEvent(shiftEnter);
    fixture.detectChanges();
    expect(shiftEnter.defaultPrevented).toBeFalse();
    expect(component.messages.length).toBe(0);

    const enter = new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true });
    textarea.dispatchEvent(enter);
    expect(enter.defaultPrevented).toBeTrue();
    await new Promise(resolve => setTimeout(resolve, 0));
    fixture.detectChanges();
    expect(component.messages.length).toBe(2);
  });

  it('auto-grows the textarea on input', () => {
    fixture.detectChanges();
    const textarea = fixture.nativeElement.querySelector('textarea') as HTMLTextAreaElement;
    textarea.value = 'γραμμή\n'.repeat(5);
    textarea.dispatchEvent(new Event('input'));
    expect(textarea.style.height).toMatch(/px$/);
  });

  it('stops generation when the stop button is clicked', async () => {
    const stream = new Subject<AiAnswer>();
    (mockAi.streamQuery as jasmine.Spy).and.returnValue(stream.asObservable());
    fixture.detectChanges();

    const component = fixture.componentInstance;
    component.currentInput = 'ερώτηση';
    await component.sendMessage();
    fixture.detectChanges();

    expect(component.isLoading).toBeTrue();
    const stopButton = fixture.nativeElement.querySelector('.nl-chat-stop-btn') as HTMLButtonElement;
    expect(stopButton).not.toBeNull();
    stopButton.click();
    fixture.detectChanges();

    expect(component.isLoading).toBeFalse();
    expect(stream.observed).toBeFalse();
    expect(component.messages[1].content).toContain('διακόπηκε');
  });

  it('shows the slow-response hint while a job keeps polling', async () => {
    const stream = new Subject<AiAnswer>();
    (mockAi.streamQuery as jasmine.Spy).and.returnValue(stream.asObservable());
    fixture.detectChanges();

    const component = fixture.componentInstance;
    component.currentInput = 'ερώτηση';
    await component.sendMessage();
    stream.next({ content: '', messageId: null, sources: [], confidence: 0, pending: true });
    fixture.detectChanges();

    expect(component.isSlow).toBeTrue();
    expect(fixture.nativeElement.querySelector('.nl-typing-indicator').textContent).toContain('Αργεί');
    component.stopGeneration();
  });

  it('copies a message to the clipboard', async () => {
    const originalClipboard = Object.getOwnPropertyDescriptor(navigator, 'clipboard');
    const writeText = jasmine.createSpy('writeText').and.resolveTo();
    Object.defineProperty(navigator, 'clipboard', { value: { writeText }, configurable: true });

    const component = fixture.componentInstance;
    const message = { role: 'user' as const, content: 'αντίγραφο', sources: [], confidence: null, messageId: null, feedback: null, createdAt: '2026-01-01T10:00:00Z', copied: false };
    await component.copyMessage(message);

    expect(writeText).toHaveBeenCalledWith('αντίγραφο');
    expect(message.copied).toBeTrue();

    if (originalClipboard) Object.defineProperty(navigator, 'clipboard', originalClipboard);
    else delete (navigator as { clipboard?: unknown }).clipboard;
  });

  it('regenerates the last assistant answer', async () => {
    const component = fixture.componentInstance;
    component.currentInput = 'ερώτηση';
    await component.sendMessage();
    fixture.detectChanges();

    await component.regenerate(component.messages[1]);
    await fixture.whenStable();

    expect((mockAi.streamQuery as jasmine.Spy).calls.count()).toBe(2);
    expect((mockAi.streamQuery as jasmine.Spy).calls.mostRecent().args).toEqual(['ερώτηση', 7, []]);
    expect(component.messages.length).toBe(2);
    expect(component.messages[1].content).toBe('απάντηση');
  });

  it('renders timestamps for messages', async () => {
    const component = fixture.componentInstance;
    component.currentInput = 'ερώτηση';
    await component.sendMessage();
    fixture.detectChanges();

    const times = fixture.nativeElement.querySelectorAll('.nl-message-meta time');
    expect(times.length).toBe(2);
    expect(times[0].textContent.trim().length).toBeGreaterThan(0);
  });

  it('lists recent conversations and navigates from the side panel', async () => {
    (mockConversations.list as jasmine.Spy).and.resolveTo([
      conversationStub(3, 'Παλιά συνομιλία'),
      conversationStub(4, 'Άλλη συνομιλία')
    ]);
    fixture.detectChanges();
    await fixture.whenStable();
    fixture.detectChanges();

    const items = fixture.nativeElement.querySelectorAll('.nl-chat-side-item');
    expect(items.length).toBe(2);

    const router = TestBed.inject(Router) as unknown as { navigate: jasmine.Spy };
    items[0].click();
    expect(router.navigate).toHaveBeenCalledWith(['/chat'], { queryParams: { conversation: 3 } });

    const component = fixture.componentInstance;
    component.messages.push({
      role: 'user', content: 'κάτι', sources: [], confidence: null,
      messageId: null, feedback: null, createdAt: '2026-01-01T10:00:00Z'
    });
    await component.startNewChat();
    expect(component.messages.length).toBe(0);
    expect(router.navigate).toHaveBeenCalledWith(['/chat'], { queryParams: {} });
  });

  // ------------------------------------------------------------------
  // 2-9: streaming / source-toggle accessibility.
  // ------------------------------------------------------------------

  it('marks the streaming answer busy and announces completion politely', async () => {
    const stream = new Subject<AiAnswer>();
    (mockAi.streamQuery as jasmine.Spy).and.returnValue(stream.asObservable());
    fixture.detectChanges();

    const component = fixture.componentInstance;
    component.currentInput = 'ερώτηση';
    await component.sendMessage();
    fixture.detectChanges();

    const assistantBubble = fixture.nativeElement.querySelectorAll('.nl-chat-bubble')[1] as HTMLElement;
    expect(assistantBubble.getAttribute('aria-live')).toBe('off');
    expect(assistantBubble.getAttribute('aria-busy')).toBe('true');
    const indicator = fixture.nativeElement.querySelector('.nl-typing-indicator') as HTMLElement;
    expect(indicator.getAttribute('role')).toBe('status');
    expect(indicator.getAttribute('aria-live')).toBe('polite');

    stream.next({ content: 'τελική απάντηση', messageId: 61, sources: [], confidence: 0 });
    stream.complete();
    fixture.detectChanges();

    expect(assistantBubble.textContent).toContain('τελική απάντηση');
    expect(assistantBubble.getAttribute('aria-live')).toBe('polite');
    expect(assistantBubble.getAttribute('aria-busy')).toBeNull();
    const live = fixture.nativeElement.querySelector('.nl-sr-only[role="status"]') as HTMLElement;
    expect(live.textContent).toContain('ολοκληρώθηκε');
  });

  it('announces a cancelled generation politely', async () => {
    const stream = new Subject<AiAnswer>();
    (mockAi.streamQuery as jasmine.Spy).and.returnValue(stream.asObservable());
    fixture.detectChanges();

    const component = fixture.componentInstance;
    component.currentInput = 'ερώτηση';
    await component.sendMessage();

    component.stopGeneration();
    fixture.detectChanges();

    const live = fixture.nativeElement.querySelector('.nl-sr-only[role="status"]') as HTMLElement;
    expect(live.textContent).toContain('διακόπηκε');
  });

  it('labels icon-only and action-only chat buttons for assistive tech', async () => {
    const component = fixture.componentInstance;
    component.currentInput = 'ερώτηση';
    await component.sendMessage();
    fixture.detectChanges();

    const send = fixture.nativeElement.querySelector('.nl-chat-input-area button[aria-label="Αποστολή μηνύματος"]');
    expect(send).not.toBeNull();
    const copy = fixture.nativeElement.querySelector('.nl-message-action[aria-label="Αντιγραφή μηνύματος"]');
    expect(copy).not.toBeNull();
    const regenerate = fixture.nativeElement.querySelector('.nl-message-action[aria-label="Αναδημιουργία απάντησης"]');
    expect(regenerate).not.toBeNull();
    expect(fixture.nativeElement.querySelector('.nl-chat-voice-btn').getAttribute('aria-label'))
      .toContain('ηχογράφησης');
  });

  // ------------------------------------------------------------------
  // Quota UX: an exhausted daily allowance must not look like an outage.
  // ------------------------------------------------------------------

  it('renders the quota message with the used/limit counts and the reset time', async () => {
    const quotaError = new QuotaExceededError({
      kind: 'ai',
      limit: 20,
      used: 20,
      tier: 'basic',
      resetAt: '2026-01-02T00:00:00.000Z',
      serverError: 'Daily AI query limit reached for your plan'
    });
    (mockAi.streamQuery as jasmine.Spy).and.returnValue(throwError(() => quotaError));

    const component = fixture.componentInstance;
    component.currentInput = 'ερώτηση';
    await component.sendMessage();
    fixture.detectChanges();

    const expected = (lookupTranslation('el', 'chat.errors.quota') || '')
      .replace('{{used}}', '20')
      .replace('{{limit}}', '20')
      .replace('{{resetAt}}', component.formatResetAt('2026-01-02T00:00:00.000Z'));
    const bubble = fixture.nativeElement.querySelectorAll('.nl-chat-bubble')[1] as HTMLElement;
    expect(bubble.textContent).toContain(expected);
    // It must NOT be reported as a model communication failure.
    expect(bubble.textContent).not.toContain(lookupTranslation('el', 'chat.errors.model')!);
    expect(component.quotaError).toBe(quotaError);
  });

  it('offers the upgrade affordance for a non-enterprise tier', async () => {
    const quotaError = new QuotaExceededError({
      kind: 'ai',
      limit: 20,
      used: 20,
      tier: 'basic',
      resetAt: '2026-01-02T00:00:00.000Z',
      serverError: 'Daily AI query limit reached for your plan'
    });
    (mockAi.streamQuery as jasmine.Spy).and.returnValue(throwError(() => quotaError));

    const component = fixture.componentInstance;
    component.currentInput = 'ερώτηση';
    await component.sendMessage();
    fixture.detectChanges();

    const upgrade = fixture.nativeElement.querySelector('.nl-quota-upgrade-link') as HTMLAnchorElement;
    expect(upgrade).not.toBeNull();
    expect(upgrade.textContent?.trim()).toBe(lookupTranslation('el', 'common.upgradePlan'));

    const router = TestBed.inject(Router) as unknown as { navigate: jasmine.Spy };
    upgrade.click();
    expect(router.navigate).toHaveBeenCalledWith(['/subscriptions']);
  });

  it('hides the upgrade affordance for the unlimited enterprise tier', async () => {
    const quotaError = new QuotaExceededError({
      kind: 'ai',
      limit: null,
      used: 12,
      tier: 'enterprise',
      resetAt: null,
      serverError: 'Daily AI query limit reached for your plan'
    });
    (mockAi.streamQuery as jasmine.Spy).and.returnValue(throwError(() => quotaError));

    const component = fixture.componentInstance;
    component.currentInput = 'ερώτηση';
    await component.sendMessage();
    fixture.detectChanges();

    const bubble = fixture.nativeElement.querySelectorAll('.nl-chat-bubble')[1] as HTMLElement;
    expect(bubble.textContent).toContain(lookupTranslation('el', 'chat.errors.quotaGeneric')!);
    expect(fixture.nativeElement.querySelector('.nl-quota-upgrade-link')).toBeNull();
  });

  it('still renders the generic model error for a non-quota failure', async () => {
    (mockAi.streamQuery as jasmine.Spy).and.returnValue(
      throwError(() => new Error('Enqueue failed (HTTP 500)'))
    );

    const component = fixture.componentInstance;
    component.currentInput = 'ερώτηση';
    await component.sendMessage();
    fixture.detectChanges();

    const bubble = fixture.nativeElement.querySelectorAll('.nl-chat-bubble')[1] as HTMLElement;
    expect(bubble.textContent).toContain(lookupTranslation('el', 'chat.errors.model')!);
    expect(component.quotaError).toBeNull();
    expect(fixture.nativeElement.querySelector('.nl-quota-upgrade-link')).toBeNull();
  });

  it('renders the consumed allowance ("20/20"), never the over-count ("21/20")', async () => {
    // The backend counts the rejected attempt too, so the refusal reports
    // `used: 21` against `limit: 20`.
    const quotaError = new QuotaExceededError({
      kind: 'ai',
      limit: 20,
      used: 21,
      tier: 'basic',
      resetAt: '2026-01-02T00:00:00.000Z',
      serverError: 'Daily AI query limit reached for your plan'
    });
    (mockAi.streamQuery as jasmine.Spy).and.returnValue(throwError(() => quotaError));

    const component = fixture.componentInstance;
    component.currentInput = 'ερώτηση';
    await component.sendMessage();
    fixture.detectChanges();

    const bubble = fixture.nativeElement.querySelectorAll('.nl-chat-bubble')[1] as HTMLElement;
    expect(bubble.textContent).toContain('20/20');
    expect(bubble.textContent).not.toContain('21/20');
  });

  it('keeps a real usage below the limit untouched ("5/20")', async () => {
    const quotaError = new QuotaExceededError({
      kind: 'ai',
      limit: 20,
      used: 5,
      tier: 'basic',
      resetAt: '2026-01-02T00:00:00.000Z',
      serverError: 'Daily AI query limit reached for your plan'
    });
    (mockAi.streamQuery as jasmine.Spy).and.returnValue(throwError(() => quotaError));

    const component = fixture.componentInstance;
    component.currentInput = 'ερώτηση';
    await component.sendMessage();
    fixture.detectChanges();

    const bubble = fixture.nativeElement.querySelectorAll('.nl-chat-bubble')[1] as HTMLElement;
    expect(bubble.textContent).toContain('5/20');
    expect(bubble.textContent).not.toContain('20/20');
  });

  it('renders the translated timeout notice for the service timeout sentinel', async () => {
    (mockAi.streamQuery as jasmine.Spy).and.returnValue(
      throwError(() => new Error(RESPONSE_TIMEOUT_NOTICE))
    );

    const component = fixture.componentInstance;
    component.currentInput = 'ερώτηση';
    await component.sendMessage();
    fixture.detectChanges();

    const bubble = fixture.nativeElement.querySelectorAll('.nl-chat-bubble')[1] as HTMLElement;
    expect(bubble.textContent).toContain(lookupTranslation('el', 'chat.notices.timeout')!);
    // The language-neutral sentinel itself never reaches the user.
    expect(bubble.textContent).not.toContain(RESPONSE_TIMEOUT_NOTICE);
  });
});
