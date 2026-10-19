import { Injectable } from '@angular/core';
import { Observable, Subscription } from 'rxjs';
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
  /**
   * True for a token chunk from the live SSE stream. `content` is a delta:
   * consumers must append it. The final emission has no `partial` flag and
   * carries the authoritative content plus metadata.
   */
  partial?: boolean;
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

  /**
   * Live token streaming over SSE.
   *
   * The POST is a normal authenticated fetch (EventSource cannot attach the
   * Authorization header), and the events endpoint is consumed with a
   * ReadableStream so partial chunks arrive as the model produces them.
   *
   * Fallbacks keep the chat usable during a rolling deploy or a flaky
   * connection:
   *   - live enqueue unavailable (non-quota failure) → existing polling pair
   *     (`/query/stream` + GET poll) is used instead;
   *   - events connection fails before any content arrives → the already
   *     enqueued job is polled through the existing GET endpoint.
   * Once content has been emitted a broken stream surfaces an error, so the
   * final answer is never silently duplicated by a second delivery path.
   */
  streamQueryLive(
    prompt: string,
    conversationId?: number,
    documentIds: number[] = []
  ): Observable<AiAnswer> {
    const body = {
      prompt,
      useRag: true,
      ...(conversationId ? { conversationId } : {}),
      ...(documentIds.length ? { documentIds } : {})
    };

    return new Observable<AiAnswer>(observer => {
      let cancelled = false;
      let settled = false;
      let jobId: string | undefined;
      let receivedContent = false;
      let reader: ReadableStreamDefaultReader<Uint8Array> | null = null;
      let fallbackSub: Subscription | null = null;
      let pollingStarted = false;
      let slowTimer: ReturnType<typeof setTimeout> | undefined;
      const controller = new AbortController();

      const clearSlowTimer = () => {
        if (slowTimer) {
          clearTimeout(slowTimer);
          slowTimer = undefined;
        }
      };

      const releaseReader = () => {
        const current = reader;
        reader = null;
        if (current) void current.cancel().catch(() => undefined);
      };

      const stopFallback = () => {
        fallbackSub?.unsubscribe();
        fallbackSub = null;
      };

      const finish = (error?: unknown) => {
        if (settled) return;
        settled = true;
        clearSlowTimer();
        stopFallback();
        releaseReader();
        if (error !== undefined) observer.error(error);
        else observer.complete();
      };

      const failWithStage = (error: unknown, stage: 'enqueue' | 'poll') => {
        if (error instanceof Error) (error as InferenceRequestError).stage = stage;
        finish(error);
      };

      const emit = (answer: AiAnswer) => {
        if (cancelled || settled) return;
        if (answer.content) {
          receivedContent = true;
          clearSlowTimer();
        }
        observer.next(answer);
      };

      const pollExistingJob = () => {
        if (cancelled || settled || !jobId || pollingStarted) return;
        pollingStarted = true;
        releaseReader();
        const id = jobId;
        fallbackSub = this.pollJob(id).subscribe({
          next: answer => emit(answer),
          error: err => finish(err),
          complete: () => finish()
        });
      };

      const fallBackToPollingPipeline = () => {
        if (cancelled || settled) return;
        fallbackSub = this.streamQuery(prompt, conversationId, documentIds).subscribe({
          next: answer => emit(answer),
          error: err => finish(err),
          complete: () => finish()
        });
      };

      const applyEvent = (eventName: string, rawData: string) => {
        let payload: Record<string, unknown>;
        try {
          payload = JSON.parse(rawData) as Record<string, unknown>;
        } catch {
          return;
        }
        if (eventName === 'chunk') {
          const content = typeof payload['content'] === 'string' ? payload['content'] : '';
          if (!content) return;
          emit({ content, messageId: null, sources: [], confidence: 0, partial: true });
          return;
        }
        if (eventName === 'done') {
          emit({
            content: typeof payload['result'] === 'string' ? payload['result'] : '',
            messageId: Number.isInteger(Number(payload['messageId']))
              ? Number(payload['messageId'])
              : null,
            sources: Array.isArray(payload['sources']) ? payload['sources'] as AnswerSource[] : [],
            confidence: Number.isFinite(Number(payload['confidence']))
              ? Number(payload['confidence'])
              : 0
          });
          finish();
          return;
        }
        if (eventName === 'error') {
          // Before any content the polling endpoint is authoritative on the
          // job's real state (a failed job still fails there). This also
          // recovers when only the live fan-out is broken.
          if (!receivedContent && jobId) {
            pollExistingJob();
            return;
          }
          failWithStage(
            new Error(typeof payload['error'] === 'string' ? payload['error'] : 'Stream failed'),
            'poll'
          );
        }
      };

      // SSE frames are separated by a blank line. `data:` may appear on
      // multiple lines (joined with \n), and comment/heartbeat frames carry
      // no data at all.
      const parseBlock = (block: string): { eventName: string; data: string } | null => {
        let eventName = 'message';
        const dataLines: string[] = [];
        for (const line of block.split(/\r?\n/)) {
          if (!line || line.startsWith(':')) continue;
          const separator = line.indexOf(':');
          const field = separator === -1 ? line : line.slice(0, separator);
          let value = separator === -1 ? '' : line.slice(separator + 1);
          if (value.startsWith(' ')) value = value.slice(1);
          if (field === 'event') eventName = value;
          else if (field === 'data') dataLines.push(value);
        }
        if (dataLines.length === 0) return null;
        return { eventName, data: dataLines.join('\n') };
      };

      const consume = async (response: Response): Promise<void> => {
        if (!response.body) {
          pollExistingJob();
          return;
        }
        const streamReader = response.body.getReader();
        reader = streamReader;
        const decoder = new TextDecoder();
        let buffer = '';

        while (!cancelled && !settled) {
          const { value, done } = await streamReader.read();
          if (done) break;
          buffer += decoder.decode(value, { stream: true });
          const blocks = buffer.split(/\r?\n\r?\n/);
          buffer = blocks.pop() ?? '';
          for (const block of blocks) {
            const parsed = parseBlock(block);
            if (parsed) applyEvent(parsed.eventName, parsed.data);
            if (cancelled || settled) break;
          }
        }

        if (reader === streamReader) reader = null;
        if (cancelled || settled) return;
        if (receivedContent) {
          failWithStage(new Error('Stream ended before completion'), 'poll');
        } else {
          pollExistingJob();
        }
      };

      slowTimer = setTimeout(() => {
        if (cancelled || settled || receivedContent) return;
        observer.next({ content: '', messageId: null, sources: [], confidence: 0, pending: true });
      }, this.slowAfterMs);

      const connect = async (): Promise<void> => {
        let enqueueResponse: Response;
        try {
          enqueueResponse = await apiFetch(`${this.apiUrl}/query/live`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(body),
            signal: controller.signal
          });
        } catch {
          if (!cancelled) fallBackToPollingPipeline();
          return;
        }
        if (cancelled) return;

        if (!enqueueResponse.ok) {
          const quotaError = await this.readQuotaError(enqueueResponse, 'ai');
          if (cancelled) return;
          if (quotaError) {
            failWithStage(quotaError, 'enqueue');
            return;
          }
          if (enqueueResponse.status === 429) {
            // Plain rate-limit rejection: same wording as the legacy path,
            // and retrying through it would only burn the limiter further.
            failWithStage(new Error('Enqueue failed (HTTP 429)'), 'enqueue');
            return;
          }
          // Live endpoint missing/failing (e.g. a backend that predates the
          // route): use the legacy enqueue + poll pair.
          fallBackToPollingPipeline();
          return;
        }

        let data: { jobId?: string } = {};
        try {
          data = (await enqueueResponse.json()) as { jobId?: string };
        } catch {
          data = {};
        }
        if (cancelled) return;
        if (!data.jobId) {
          fallBackToPollingPipeline();
          return;
        }
        jobId = data.jobId;

        let eventsResponse: Response;
        try {
          eventsResponse = await apiFetch(
            `${this.apiUrl}/query/live/${encodeURIComponent(jobId)}/events`,
            {
              headers: { Accept: 'text/event-stream' },
              signal: controller.signal
            }
          );
        } catch {
          if (!cancelled) pollExistingJob();
          return;
        }
        if (cancelled) return;
        if (!eventsResponse.ok) {
          pollExistingJob();
          return;
        }
        await consume(eventsResponse);
      };

      void connect().catch(error => {
        if (cancelled || settled) return;
        if (receivedContent || !jobId) failWithStage(error, 'poll');
        else pollExistingJob();
      });

      return () => {
        cancelled = true;
        clearSlowTimer();
        controller.abort();
        releaseReader();
        stopFallback();
        if (jobId && !settled) {
          void this.cancelJob(jobId).catch(() => undefined);
        }
      };
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

  /**
   * Poll an already-enqueued job through the unchanged GET endpoint. Shared
   * by the legacy enqueue+poll path and the live-stream fallback.
   */
  private pollJob(jobId: string): Observable<AiAnswer> {
    return new Observable<AiAnswer>(observer => {
      let cancelled = false;
      let settled = false;
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

      const fail = (error: unknown) => {
        if (cancelled || settled) return;
        settled = true;
        stop();
        if (error instanceof Error) (error as InferenceRequestError).stage = 'poll';
        observer.error(error);
      };

      const scheduleNext = () => {
        if (cancelled || settled) return;
        if (attempts >= this.pollMaxAttempts || Date.now() - startedAt >= this.pollTimeoutMs) {
          fail(new Error(RESPONSE_TIMEOUT_NOTICE));
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
          fail(new Error(RESPONSE_TIMEOUT_NOTICE));
          return;
        }
        attempts += 1;
        apiFetch(`${this.apiUrl}/query/stream/${encodeURIComponent(jobId)}`, {
          signal: controller.signal
        })
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
          .catch(error => fail(error));
      };

      poll();

      return () => {
        cancelled = true;
        stop();
        controller.abort();
      };
    });
  }

  private enqueueThenPoll(path: string, body: BodyInit | Record<string, unknown>): Observable<AiAnswer> {
    return new Observable(observer => {
      let cancelled = false;
      let settled = false;
      let jobId: string | undefined;
      let pollSub: Subscription | null = null;
      const controller = new AbortController();

      const fail = (error: unknown, stage: 'enqueue' | 'poll' = 'enqueue') => {
        if (cancelled || settled) return;
        settled = true;
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
          if (cancelled || settled) return;
          jobId = id;
          pollSub = this.pollJob(id).subscribe({
            next: answer => {
              if (!cancelled && !settled) observer.next(answer);
            },
            error: error => fail(error, 'poll'),
            complete: () => {
              if (cancelled || settled) return;
              settled = true;
              observer.complete();
            }
          });
        })
        .catch(error => fail(error, 'enqueue'));

      // Tearing down the subscription stops the timer, aborts the in-flight
      // request and asks the backend to drop the queued job. Exposed to the
      // chat's stop button through Subscription.unsubscribe().
      return () => {
        cancelled = true;
        controller.abort();
        pollSub?.unsubscribe();
        pollSub = null;
        if (jobId && !settled) {
          void this.cancelJob(jobId).catch(() => undefined);
        }
      };
    });
  }
}
