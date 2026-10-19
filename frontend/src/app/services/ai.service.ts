import { Injectable } from '@angular/core';
import { Observable } from 'rxjs';
import { environment } from '../../environments/environment';
import { apiFetch } from './api-client';
import { parseQuotaError, QuotaExceededError } from './quota.service';

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
  /**
   * Intermediate notification emitted while a job is still running for
   * longer than expected. Consumers should show a "slow" hint instead of
   * appending `content`.
   */
  pending?: boolean;
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

/**
 * Language-neutral sentinel for the poll loop's timeout.
 *
 * The service throws it as the error message and the chat compares the
 * message against it to decide that the translated `chat.notices.timeout`
 * copy must be shown. The sentinel is deliberately NOT a Greek sentence:
 * a service layer must not hard-code one language, and the user-visible
 * wording comes from the translation dictionary anyway.
 */
export const RESPONSE_TIMEOUT_NOTICE = 'nomos:response-timeout';

@Injectable({ providedIn: 'root' })
export class AiService {
  private apiUrl = `${environment.apiBaseUrl}/api/ai`;

  // Poll tuning. The defaults keep a worst-case wait close to the backend's
  // 120 s inference cap while backing off so a busy queue isn't hammered.
  // Public so tests (and future settings UI) can shorten the cycle.
  pollIntervalMs = 1000;
  pollMaxIntervalMs = 5000;
  pollMaxAttempts = 120;
  pollTimeoutMs = 120000;
  slowAfterMs = 15000;

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

  /**
   * Best-effort cancellation for a queued inference job. The backend removes
   * waiting jobs; work already running on the local model cannot be
   * interrupted safely.
   */
  async cancelJob(jobId: string): Promise<void> {
    const response = await apiFetch(`${this.apiUrl}/query/stream/${jobId}`, { method: 'DELETE' });
    if (!response.ok) throw new Error(`Cancel failed (HTTP ${response.status})`);
  }

  /**
   * Reads a quota rejection body (HTTP 429) and turns it into a typed
   * `QuotaExceededError`. Returns `null` for every other status code and
   * for bodies that do not match the documented contract, so the caller can
   * fall back to its generic error handling.
   */
  private async readQuotaError(response: Response, kind: 'ai'): Promise<QuotaExceededError | null> {
    if (response.status !== 429) return null;
    const body = await response.json().catch(() => null);
    return parseQuotaError(body, kind);
  }

  private enqueueThenPoll(path: string, body: BodyInit | Record<string, unknown>): Observable<AiAnswer> {
    return new Observable(observer => {
      let cancelled = false;
      let settled = false;
      let jobId: string | undefined;
      let timer: ReturnType<typeof setTimeout> | undefined;
      let attempts = 0;
      let slowNotified = false;
      const startedAt = Date.now();
      const controller = new AbortController();

      const stop = () => {
        if (timer) {
          clearTimeout(timer);
          timer = undefined;
        }
      };

      const fail = (error: unknown, stage: 'enqueue' | 'poll' = 'poll') => {
        if (cancelled || settled) return;
        settled = true;
        stop();
        if (error instanceof Error) (error as InferenceRequestError).stage = stage;
        observer.error(error);
      };

      const scheduleNext = () => {
        if (cancelled || settled) return;
        if (attempts >= this.pollMaxAttempts || Date.now() - startedAt >= this.pollTimeoutMs) {
          fail(new Error(RESPONSE_TIMEOUT_NOTICE), 'poll');
          return;
        }
        if (!slowNotified && Date.now() - startedAt >= this.slowAfterMs) {
          slowNotified = true;
          observer.next({ content: '', messageId: null, sources: [], confidence: 0, pending: true });
        }
        const delay = Math.min(
          this.pollIntervalMs * Math.pow(1.5, Math.max(attempts - 1, 0)),
          this.pollMaxIntervalMs
        );
        timer = setTimeout(poll, delay);
      };

      const poll = () => {
        if (cancelled || settled) return;
        if (attempts >= this.pollMaxAttempts || Date.now() - startedAt >= this.pollTimeoutMs) {
          fail(new Error(RESPONSE_TIMEOUT_NOTICE), 'poll');
          return;
        }
        attempts += 1;
        apiFetch(`${this.apiUrl}/query/stream/${jobId}`, { signal: controller.signal })
          .then(async pollResponse => {
            if (!pollResponse.ok) {
              // The poll route (GET /api/ai/query/stream/:jobId) has NO
              // quota middleware today: `enforceAiQuota` is mounted on
              // /query, /query/stream, /audio-query and /multimodal only.
              // A mid-poll 429 is therefore a plain rate-limit rejection.
              // The quota-shaped body is still handled defensively — if the
              // backend ever mounts the quota middleware on the poll route,
              // the client reports the exhausted allowance instead of a
              // generic failure.
              const quotaError = await this.readQuotaError(pollResponse, 'ai');
              if (quotaError) throw quotaError;
              throw new Error(`Poll failed (HTTP ${pollResponse.status})`);
            }
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
              scheduleNext();
            }
          })
          .catch(error => fail(error, 'poll'));
      };

      const isForm = body instanceof FormData;
      apiFetch(`${this.apiUrl}${path}`, {
        method: 'POST',
        headers: isForm ? {} : { 'Content-Type': 'application/json' },
        body: isForm ? body : JSON.stringify(body),
        signal: controller.signal
      })
        .then(async response => {
          if (!response.ok) {
            // 429 = the daily AI allowance is exhausted. Keep the payload so
            // the chat can show the quota message instead of a generic
            // "communication error with the model".
            const quotaError = await this.readQuotaError(response, 'ai');
            if (quotaError) throw quotaError;
            throw new Error(`Enqueue failed (HTTP ${response.status})`);
          }
          const data = await response.json().catch(() => ({}));
          if (!data.jobId) throw new Error('Backend did not return a jobId');
          return data.jobId as string;
        })
        .then(id => {
          if (cancelled) return;
          jobId = id;
          poll();
        })
        .catch(error => fail(error, 'enqueue'));

      // Tearing down the subscription stops the timer, aborts the in-flight
      // request and asks the backend to drop the queued job. Exposed to the
      // chat's stop button through Subscription.unsubscribe().
      return () => {
        cancelled = true;
        stop();
        controller.abort();
        if (jobId && !settled) {
          void this.cancelJob(jobId).catch(() => undefined);
        }
      };
    });
  }
}
