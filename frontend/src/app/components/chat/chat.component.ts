import { Component, ElementRef, ViewChild } from '@angular/core';
import { CommonModule } from '@angular/common';
import { FormsModule } from '@angular/forms';
import { AiService } from '../../services/ai.service';
import { AuthService } from '../../services/auth.service';
import gsap from 'gsap';

interface Message {
  role: 'user' | 'assistant';
  content: string;
}

/**
 * Phase 27 — ChatComponent.
 *
 * Stripped its piecemeal header (Logout / change-password link / admin
 * link / shield indicator / email line) because the new top
 * `<app-menu>` handles identity + navigation for every authenticated
 * route. Login state + sound-effect buttons now live behind an
 * authGuard and a sticky menu — the chat surface itself is focused on
 * the conversation.
 *
 * Visual layout:
 *   - .nl-chat-layout      page shell (height calc(100vh - 64px) so it
 *                           sits cleanly below the fixed menu)
 *   - .nl-chat-messages    scrollable message column
 *   - .nl-chat-message     flex host per row (with .user or .assistant
 *                           modifier — both keyed in styles.scss)
 *   - .nl-chat-bubble      individual bubble, max-width 75%, .user vs
 *                           .assistant color variant via combined
 *                           selector on the modifier
 *   - .nl-typing-indicator italic hint while streaming
 *   - .nl-chat-input-area  bottom input row (.textarea + voice + send)
 *   - .nl-chat-voice-btn   the 🎤 button, with .recording modifier and a
 *                           CSS pulse animation while recording
 *
 * Zero per-component CSS — Angular's 4 kB `anyComponentStyle` budget
 * is trivially satisfied.
 */
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
          <div class="nl-chat-bubble">{{ msg.content }}</div>
        </div>
        <div *ngIf="isLoading" class="nl-typing-indicator">
          Ο δικηγόρος γράφει…
        </div>
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
  // Phase 27 — zero per-component CSS. All visual surface (layout,
  // bubble chrome, input bar, voice button, recording pulse) is
  // composed from src/styles.scss utility classes.
  styles: []
})
export class ChatComponent {
  @ViewChild('scrollMe') private myScrollContainer!: ElementRef;

  messages: Message[] = [];
  currentInput = '';
  isLoading = false;
  isRecording = false;
  private mediaRecorder: MediaRecorder | null = null;
  private audioChunks: Blob[] = [];

  constructor(private aiService: AiService, public auth: AuthService) {}

  /**
   * Phase 27: logout button moved into the top menu. Method retained so
   * any future direct-call site (e.g., "Disconnect" in a settings panel)
   * doesn't have to rewire — it just calls AuthService.logout() which
   * already navigates to /login and clears localStorage / sessionStorage.
   */
  logout() {
    this.auth.logout();
  }

  sendMessage() {
    if (!this.currentInput.trim()) return;

    const userMsg = this.currentInput;
    this.messages.push({ role: 'user', content: userMsg });
    this.currentInput = '';
    this.isLoading = true;

    this.scrollToBottom();

    // Animate the user message bubble after Angular has stamped the
    // `#msg-N` id onto the DOM element.
    setTimeout(() => {
      gsap.from(`#msg-${this.messages.length - 1}`, {
        opacity: 0,
        y: 20,
        duration: 0.5
      });
    }, 0);

    const assistantMsgIndex = this.messages.push({ role: 'assistant', content: '' }) - 1;

    this.aiService.streamQuery(userMsg).subscribe({
      next: (chunk) => {
        this.isLoading = false;
        this.messages[assistantMsgIndex].content += chunk;
        this.scrollToBottom();
      },
      error: (err) => {
        console.error(err);
        this.messages[assistantMsgIndex].content = "Σφάλμα επικοινωνίας με το μοντέλο.";
        this.isLoading = false;
      },
      complete: () => {
        this.isLoading = false;
      }
    });
  }

  async toggleRecording() {
    if (this.isRecording) {
      this.stopRecording();
    } else {
      this.startRecording();
    }
  }

  private async startRecording() {
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      this.mediaRecorder = new MediaRecorder(stream);
      this.audioChunks = [];

      this.mediaRecorder.ondataavailable = (event) => {
        this.audioChunks.push(event.data);
      };

      this.mediaRecorder.onstop = () => {
        const audioBlob = new Blob(this.audioChunks, { type: 'audio/webm' });
        this.sendAudioQuery(audioBlob);
      };

      this.mediaRecorder.start();
      this.isRecording = true;
    } catch (err) {
      console.error("Microphone access denied", err);
    }
  }

  private stopRecording() {
    if (this.mediaRecorder) {
      this.mediaRecorder.stop();
      this.mediaRecorder.stream.getTracks().forEach(track => track.stop());
    }
    this.isRecording = false;
  }

  private sendAudioQuery(blob: Blob) {
    this.messages.push({ role: 'user', content: '🎤 (Audio input)' });
    this.isLoading = true;

    const assistantMsgIndex = this.messages.push({ role: 'assistant', content: '' }) - 1;

    this.aiService.uploadAudio(blob).subscribe({
      next: (chunk) => {
        this.isLoading = false;
        this.messages[assistantMsgIndex].content += chunk;
        this.scrollToBottom();
      },
      error: (err) => {
        console.error(err);
        this.messages[assistantMsgIndex].content = "Σφάλμα ήχου.";
        this.isLoading = false;
      },
      complete: () => {
        this.isLoading = false;
      }
    });
  }

  private scrollToBottom(): void {
    setTimeout(() => {
      try {
        if (this.myScrollContainer) {
          this.myScrollContainer.nativeElement.scrollTop =
            this.myScrollContainer.nativeElement.scrollHeight;
        }
      } catch (err) { }
    }, 100);
  }
}
