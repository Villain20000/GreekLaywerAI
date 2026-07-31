import { ComponentFixture, TestBed } from '@angular/core/testing';
import { BehaviorSubject, of } from 'rxjs';
import { ChatComponent } from './chat.component';
import { AuthService, AuthUser } from '../../services/auth.service';
import { AiService } from '../../services/ai.service';
import { provideRouter, Router } from '@angular/router';

/**
 * Phase 29: the header (admin link / email chip) moved to the menu
 * component in Phase 27; these specs verify what the chat component
 * actually owns: the message list, input handling, the typing indicator,
 * and logout delegation.
 */
function buildAiStub(): Partial<AiService> {
  return {
    streamQuery: jasmine.createSpy('streamQuery').and.returnValue(of('απάντηση')),
    uploadAudio: jasmine.createSpy('uploadAudio').and.returnValue(of('ήχος'))
  };
}

describe('ChatComponent (message rendering + input handling)', () => {
  let fixture: ComponentFixture<ChatComponent>;
  let userSub: BehaviorSubject<AuthUser | null>;
  let mockAuth: Pick<AuthService, 'tokenValue' | 'ready$' | 'user$' | 'logout'>;
  let mockAi: Partial<AiService>;

  beforeEach(async () => {
    userSub = new BehaviorSubject<AuthUser | null>(null);
    mockAuth = {
      tokenValue: 'jwt-test',
      ready$: new BehaviorSubject<boolean>(true).asObservable(),
      user$: userSub.asObservable(),
      logout: jasmine.createSpy('logout')
    };
    mockAi = buildAiStub();

    await TestBed.configureTestingModule({
      imports: [ChatComponent],
      providers: [
        { provide: AuthService, useValue: mockAuth },
        { provide: AiService, useValue: mockAi },
        { provide: Router, useValue: { navigate: jasmine.createSpy('navigate') } },
        provideRouter([])
      ]
    }).compileComponents();

    fixture = TestBed.createComponent(ChatComponent);
  });

  it('starts with an empty message list and disabled send state', () => {
    fixture.detectChanges();
    const bubbles = fixture.nativeElement.querySelectorAll('.nl-chat-bubble');
    expect(bubbles.length).toBe(0);
    const sendBtn = fixture.nativeElement.querySelector('.nl-chat-input-area button[type="button"]');
    expect(sendBtn.disabled).toBeTrue();
  });

  it('renders the user and assistant messages after sendMessage()', async () => {
    const component = fixture.componentInstance;
    component.currentInput = 'Τι προβλέπει ο Αστικός Κώδικας;';
    component.sendMessage();
    fixture.detectChanges();
    await fixture.whenStable();

    const bubbles = fixture.nativeElement.querySelectorAll('.nl-chat-bubble');
    expect(bubbles.length).toBe(2);
    expect(bubbles[0].textContent.trim()).toBe('Τι προβλέπει ο Αστικός Κώδικας;');
    expect(bubbles[1].textContent.trim()).toBe('απάντηση');
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
  });

  it('shows the typing indicator while an answer is pending', () => {
    const component = fixture.componentInstance;
    component.currentInput = 'ερώτηση';
    component.sendMessage();
    fixture.detectChanges();
    const indicator = fixture.nativeElement.querySelector('.nl-typing-indicator');
    expect(indicator).not.toBeNull();
  });

  it('logout() delegates to AuthService.logout', () => {
    const component = fixture.componentInstance;
    component.logout();
    expect(mockAuth.logout).toHaveBeenCalled();
  });
});
