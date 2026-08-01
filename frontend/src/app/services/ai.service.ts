import { Injectable } from '@angular/core';
import { Observable } from 'rxjs';
import { environment } from '../../environments/environment';
import { apiFetch } from './api-client';

export interface AnswerSource {
  type: 'legislation' | 'document';
  id: number | null;
  title: string | null;
  sourceType?: string | null;
  articleNumber?: string | null;
  filename?: string | null;
  chunkIndex?: number | null;
  similarity?: number | null;
}

export interface AiAnswer {
  content: string;
  messageId: number | null;
  sources: AnswerSource[];
  confidence: number;
}

export interface AnswerFeedback {
  id: number;
  message_id: number;
  user_id: number;
  helpful: boolean;
  reason: string | null;
  created_at: string;
  updated_at: string;
}

export interface InferenceRequestError extends Error {
  stage?: 'enqueue' | 'poll';
}

@Injectable({ providedIn: 'root' })
export class AiService {
  private apiUrl = `${environment.apiBaseUrl}/api/ai`;
  private pollIntervalMs = 1000;

  streamQuery(prompt: string, conversationId?: number, documentIds: number[] = []): Observable<AiAnswer> {
    return this.enqueueThenPoll('/query/stream', {
      prompt,
      useRag: true,
      ...(conversationId ? { conversationId } : {}),
      ...(documentIds.length ? { documentIds } : {})
    });
  }

  uploadAudio(audioBlob: Blob, conversationId?: number): Observable<AiAnswer> {
    const formData = new FormData();
    formData.append('audio', audioBlob, 'recording.webm');
    if (conversationId) formData.append('conversationId', String(conversationId));
    return this.enqueueThenPoll('/audio-query', formData);
  }

  async submitFeedback(messageId: number, helpful: boolean, reason?: string): Promise<AnswerFeedback> {
    const response = await apiFetch(`${this.apiUrl}/messages/${messageId}/feedback`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${localStorage.getItem('nomos_token') || ''}`
      },
      body: JSON.stringify({ helpful, ...(reason?.trim() ? { reason: reason.trim() } : {}) })
    });
    const body = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(body?.error || `Feedback failed (HTTP ${response.status})`);
    return body.feedback;
  }

  private enqueueThenPoll(path: string, body: BodyInit | Record<string, unknown>): Observable<AiAnswer> {
    return new Observable(observer => {
      let cancelled = false;
      let settled = false;
      let jobId: string | undefined;
      let timer: ReturnType<typeof setTimeout> | undefined;
      const controller = new AbortController();

      const stop = () => {
        if (timer) clearTimeout(timer);
      };

      const fail = (error: unknown, stage: 'enqueue' | 'poll' = 'poll') => {
        if (cancelled || settled) return;
        settled = true;
        stop();
        if (error instanceof Error) (error as InferenceRequestError).stage = stage;
        observer.error(error);
      };

      const isForm = body instanceof FormData;
      apiFetch(`${this.apiUrl}${path}`, {
        method: 'POST',
        headers: isForm ? {} : { 'Content-Type': 'application/json' },
        body: isForm ? body : JSON.stringify(body),
        signal: controller.signal
      })
        .then(async response => {
          if (!response.ok) throw new Error(`Enqueue failed (HTTP ${response.status})`);
          const data = await response.json().catch(() => ({}));
          if (!data.jobId) throw new Error('Backend did not return a jobId');
          return data.jobId as string;
        })
        .then(id => {
          if (cancelled) return;
          jobId = id;
          const poll = () => {
            if (cancelled) return;
            apiFetch(`${this.apiUrl}/query/stream/${jobId}`, { signal: controller.signal })
              .then(async pollResponse => {
                if (!pollResponse.ok) throw new Error(`Poll failed (HTTP ${pollResponse.status})`);
                const state = await pollResponse.json().catch(() => ({}));
                if (state.status === 'completed') {
                  settled = true;
                  stop();
                  observer.next({
                    content: typeof state.result === 'string' ? state.result : '',
                    messageId: Number.isInteger(Number(state.messageId)) ? Number(state.messageId) : null,
                    sources: Array.isArray(state.sources) ? state.sources : [],
                    confidence: Number.isFinite(Number(state.confidence)) ? Number(state.confidence) : 0
                  });
                  observer.complete();
                } else if (state.status === 'failed') {
                  fail(new Error(state.error || 'Inference job failed'));
                } else {
                  timer = setTimeout(poll, this.pollIntervalMs);
                }
              })
              .catch(error => fail(error, 'poll'));
          };
          poll();
        })
        .catch(error => fail(error, 'enqueue'));

      return () => {
        cancelled = true;
        stop();
        controller.abort();
        if (jobId && !settled) {
          apiFetch(`${this.apiUrl}/query/stream/${jobId}`, { method: 'DELETE' }).catch(() => undefined);
        }
      };
    });
  }
}
