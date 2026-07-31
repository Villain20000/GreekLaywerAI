import { Injectable } from '@angular/core';
import { Observable } from 'rxjs';
import { environment } from '../../environments/environment';

/**
 * Phase 29: /api/ai/query/stream and /api/ai/audio-query no longer stream
 * SSE directly — the backend enqueues a BullMQ inference job and returns
 * `{ jobId }`. These methods poll GET /api/ai/query/stream/:jobId until the
 * worker completes, then emit the full answer. The Observable<string>
 * contract is preserved so ChatComponent is untouched.
 */
@Injectable({
  providedIn: 'root'
})
export class AiService {
  private apiUrl = `${environment.apiBaseUrl}/api/ai`;
  private pollIntervalMs = 1000;

  constructor() { }

  streamQuery(prompt: string): Observable<string> {
    return this.enqueueThenPoll('/query/stream', { prompt, useRag: true });
  }

  uploadAudio(audioBlob: Blob): Observable<string> {
    const formData = new FormData();
    formData.append('audio', audioBlob, 'recording.webm');
    return this.enqueueThenPoll('/audio-query', formData);
  }

  private enqueueThenPoll(path: string, body: BodyInit | Record<string, unknown>): Observable<string> {
    return new Observable(observer => {
      let cancelled = false;
      let timer: ReturnType<typeof setInterval> | undefined;

      const stop = () => {
        if (timer) clearInterval(timer);
      };

      const isForm = body instanceof FormData;
      fetch(`${this.apiUrl}${path}`, {
        method: 'POST',
        headers: isForm ? {} : { 'Content-Type': 'application/json' },
        body: isForm ? body : JSON.stringify(body)
      })
        .then(async response => {
          if (!response.ok) throw new Error(`Enqueue failed (HTTP ${response.status})`);
          const data = await response.json().catch(() => ({}));
          if (!data.jobId) throw new Error('Backend did not return a jobId');
          return data.jobId as string;
        })
        .then(jobId => {
          if (cancelled) return;
          const poll = () => {
            if (cancelled) return;
            fetch(`${this.apiUrl}/query/stream/${jobId}`)
              .then(async pollResponse => {
                if (!pollResponse.ok) throw new Error(`Poll failed (HTTP ${pollResponse.status})`);
                const state = await pollResponse.json().catch(() => ({}));
                if (state.status === 'completed') {
                  stop();
                  if (typeof state.result === 'string' && state.result) {
                    observer.next(state.result);
                  }
                  observer.complete();
                } else if (state.status === 'failed') {
                  stop();
                  observer.error(state.error || 'Inference job failed');
                } else {
                  // waiting | active — keep polling
                  timer = setTimeout(poll, this.pollIntervalMs);
                }
              })
              .catch(err => {
                stop();
                observer.error(err);
              });
          };
          poll();
        })
        .catch(err => {
          observer.error(err);
        });

      return () => {
        cancelled = true;
        stop();
      };
    });
  }
}
