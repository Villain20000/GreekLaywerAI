import { ComponentFixture, TestBed } from '@angular/core/testing';
import { BehaviorSubject, of } from 'rxjs';
import { ChatComponent } from './chat.component';
import { AuthService, AuthUser } from '../../services/auth.service';
import { AiService } from '../../services/ai.service';
import { ConversationsService } from '../../services/conversations.service';
import { DocumentService } from '../../services/document.service';
import { ActivatedRoute } from '@angular/router';

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

describe('ChatComponent (message rendering + input handling)', () => {
  let fixture: ComponentFixture<ChatComponent>;
  let userSub: BehaviorSubject<AuthUser | null>;
  let mockAuth: Pick<AuthService, 'tokenValue' | 'ready$' | 'user$' | 'logout'>;
  let mockAi: Partial<AiService>;
  let mockConversations: Pick<ConversationsService, 'create' | 'get' | 'remove'>;
  let mockDocuments: Pick<DocumentService, 'list'>;

  beforeEach(async () => {
    userSub = new BehaviorSubject<AuthUser | null>(null);
    mockAuth = {
      tokenValue: 'jwt-test',
      ready$: new BehaviorSubject<boolean>(true).asObservable(),
      user$: userSub.asObservable(),
      logout: jasmine.createSpy('logout')
    };
    mockAi = buildAiStub();
    mockDocuments = {
      list: jasmine.createSpy('list').and.resolveTo([])
    };
    mockConversations = {
      create: jasmine.createSpy('create').and.resolveTo({
        id: 7,
        title: 'Τι προβλέπει ο Αστικός Κώδικας;',
        created_at: '2026-01-01',
        updated_at: '2026-01-01'
      }),
      get: jasmine.createSpy('get').and.resolveTo({
        conversation: {
          id: 7,
          title: 'Υπάρχουσα συνομιλία',
          created_at: '2026-01-01',
          updated_at: '2026-01-01'
        },
        messages: []
      }),
      remove: jasmine.createSpy('remove').and.resolveTo(undefined)
    };

    await TestBed.configureTestingModule({
      imports: [ChatComponent],
      providers: [
        { provide: AuthService, useValue: mockAuth },
        { provide: AiService, useValue: mockAi },
        { provide: ConversationsService, useValue: mockConversations },
        { provide: DocumentService, useValue: mockDocuments },
        {
          provide: ActivatedRoute,
          useValue: { snapshot: { queryParamMap: { get: () => null } } }
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
    sourceToggle.click();
    fixture.detectChanges();
    expect(fixture.nativeElement.querySelector('.nl-source-list').textContent).toContain('Αστικός Κώδικας');
  });

  it('logout() delegates to AuthService.logout', () => {
    const component = fixture.componentInstance;
    component.logout();
    expect(mockAuth.logout).toHaveBeenCalled();
  });
});
