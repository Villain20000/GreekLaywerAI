import { Injectable } from '@angular/core';
import { environment } from '../../environments/environment';
import { apiFetch } from './api-client';

/**
 * Quota vocabulary for the frontend.
 *
 * The backend enforces two independent caps:
 *   - the daily AI-query quota  → HTTP 429 (+ `Retry-After`)
 *   - the uploaded-document cap → HTTP 403 (no reset; it counts rows)
 *
 * Both responses carry the same envelope (`error`, `limit`, `used`, `tier`,
 * optionally `resetAt`). Until now the frontend threw the body away and
 * rendered a generic "communication error with the model", which made a
 * perfectly predictable billing state look like an outage.
 *
 * This module owns the single place where that envelope is understood:
 * `parseQuotaError` turns a response body into a typed `QuotaExceededError`
 * (or `null` when the body does not match the contract), and `QuotaService`
 * exposes the read-only usage projection for the profile page.
 */

/** Which cap was hit. */
export type QuotaKind = 'ai' | 'documents';

/** Subscription tier reported by the server. `null` = not reported. */
export type QuotaTier = 'basic' | 'pro' | 'enterprise' | null;

export interface QuotaExceededErrorInit {
  kind: QuotaKind;
  /** `null` means "unlimited" (enterprise tier / admin). */
  limit: number | null;
  /** Units already consumed. `null` means "not reported". */
  used: number | null;
  tier: QuotaTier;
  /** ISO timestamp of the next reset. Only the AI quota has one. */
  resetAt: string | null;
  /** Raw server `error` string (English, for logs — never for display). */
  serverError: string;
}

/**
 * Thrown when the server rejects a request because a plan cap was reached.
 *
 * It extends `Error` so existing `err instanceof Error` handling keeps
 * working, but carries the structured quota payload so the UI can render a
 * precise message (used/limit/reset time) plus an upgrade affordance.
 */
export class QuotaExceededError extends Error {
  readonly kind: QuotaKind;
  readonly limit: number | null;
  readonly used: number | null;
  readonly tier: QuotaTier;
  readonly resetAt: string | null;
  readonly serverError: string;

  constructor(init: QuotaExceededErrorInit) {
    super(init.serverError || 'Quota exceeded');
    this.name = 'QuotaExceededError';
    this.kind = init.kind;
    this.limit = init.limit;
    this.used = init.used;
    this.tier = init.tier;
    this.resetAt = init.resetAt;
    this.serverError = init.serverError;
    // Keeps `instanceof` working even when the class is down-levelled.
    Object.setPrototypeOf(this, QuotaExceededError.prototype);
  }

  /**
   * Enterprise is unlimited, so there is nothing to upgrade to. An unknown
   * tier still gets the affordance — better to offer it than to hide it.
   */
  get canUpgrade(): boolean {
    return this.tier !== 'enterprise';
  }

  /** True when the payload carries the numbers needed for a precise message. */
  get hasCounts(): boolean {
    return typeof this.used === 'number' && typeof this.limit === 'number';
  }
}

/**
 * A usage limit as reported by the server.
 *
 *   - `number`    → the concrete cap (e.g. 20).
 *   - `null`      → explicitly UNLIMITED. This is the backend's marker for
 *                   the enterprise tier / admins (`getAiDailyLimit()` returns
 *                   null for them) and must keep rendering as "unlimited".
 *   - `undefined` → the field was ABSENT or malformed. The number is
 *                   UNKNOWN — it is emphatically not "unlimited". Rendering
 *                   it as unlimited would be a reassuring-but-wrong claim,
 *                   so the UI shows the unknown state instead.
 */
export type QuotaLimit = number | null | undefined;

/** `ai` projection of GET /api/subscriptions/usage. */
export interface QuotaUsageAi {
  used: number;
  /** `null` = unlimited (enterprise tier / admin); `undefined` = not reported. */
  limit: QuotaLimit;
  /** ISO timestamp of the next daily reset. */
  resetAt: string | null;
}

/** `documents` projection of GET /api/subscriptions/usage. */
export interface QuotaUsageDocuments {
  used: number;
  /** `null` = unlimited (enterprise tier / admin); `undefined` = not reported. */
  limit: QuotaLimit;
}

/** Body of GET /api/subscriptions/usage. */
export interface QuotaUsage {
  tier: string;
  ai: QuotaUsageAi;
  documents: QuotaUsageDocuments;
}

/**
 * Reads a number-or-null field. Returns `undefined` when the field is
 * absent or not a finite number, which marks the body as malformed.
 */
function readNumberOrNull(value: unknown): number | null | undefined {
  if (value === null) return null;
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  return undefined;
}

function readTier(value: unknown): QuotaTier {
  return value === 'basic' || value === 'pro' || value === 'enterprise' ? value : null;
}

/**
 * Turns a 429/403 quota body into a `QuotaExceededError`.
 *
 * Returns `null` when the body does not match the documented contract
 * (not an object, no `error` string, or a non-numeric `limit`/`used`), so
 * callers can fall back to their generic error handling.
 */
export function parseQuotaError(body: unknown, kind: QuotaKind): QuotaExceededError | null {
  if (!body || typeof body !== 'object' || Array.isArray(body)) return null;

  const raw = body as Record<string, unknown>;
  const serverError = typeof raw['error'] === 'string' ? raw['error'] : '';
  if (!serverError) return null;

  const limit = readNumberOrNull(raw['limit']);
  const used = readNumberOrNull(raw['used']);
  if (limit === undefined || used === undefined) return null;

  const resetAt = typeof raw['resetAt'] === 'string' ? raw['resetAt'] : null;

  return new QuotaExceededError({
    kind,
    limit,
    used,
    tier: readTier(raw['tier']),
    resetAt,
    serverError
  });
}

/**
 * The consumed allowance, never the over-count.
 *
 * The backend increments the usage counter BEFORE it decides whether the
 * request is allowed (`backend/src/services/quotaService.js`: "it
 * intentionally keeps incrementing past the limit so the response reports
 * the true attempt count"), so a rejected request reports `used: 21`
 * against `limit: 20`. Rendering that verbatim reads as "21/20", which
 * looks like a broken number. The user really did consume the whole
 * allowance (20 of 20) and had one request rejected, so the rendered
 * figure is clamped to the limit.
 *
 * Returns `null` when the consumed count is unknown, and leaves the count
 * untouched when the limit is unknown (an unlimited allowance has no cap
 * to clamp against).
 */
export function consumedQuotaUsed(
  used: number | null,
  limit: number | null
): number | null {
  if (typeof used !== 'number' || !Number.isFinite(used)) return null;
  if (typeof limit !== 'number' || !Number.isFinite(limit)) return used;
  return Math.min(used, limit);
}

/** Defensive normalisation of the usage payload (the endpoint always 200s).
 *
 * The three states of a limit are kept apart on purpose:
 *   - a finite number → the concrete cap;
 *   - an explicit `null` → unlimited (enterprise tier / admin);
 *   - absent / malformed → `undefined` = UNKNOWN, which must never be
 *     rendered as unlimited.
 */
function normalizeUsage(data: unknown): QuotaUsage {
  const raw = (data && typeof data === 'object' ? data : {}) as Record<string, unknown>;
  const ai = (raw['ai'] && typeof raw['ai'] === 'object' ? raw['ai'] : {}) as Record<string, unknown>;
  const documents = (raw['documents'] && typeof raw['documents'] === 'object'
    ? raw['documents']
    : {}) as Record<string, unknown>;

  const used = (value: unknown): number => (typeof value === 'number' && Number.isFinite(value) ? value : 0);
  // `readNumberOrNull` already encodes the three states: number → number,
  // null → null (unlimited), anything else → undefined (unknown).
  const limit = (value: unknown): QuotaLimit => readNumberOrNull(value);

  return {
    tier: typeof raw['tier'] === 'string' ? raw['tier'] : 'basic',
    ai: {
      used: used(ai['used']),
      limit: limit(ai['limit']),
      resetAt: typeof ai['resetAt'] === 'string' ? ai['resetAt'] : null
    },
    documents: {
      used: used(documents['used']),
      limit: limit(documents['limit'])
    }
  };
}

@Injectable({
  providedIn: 'root'
})
export class QuotaService {
  private apiUrl = `${environment.apiBaseUrl}/api/subscriptions`;

  /**
   * Instance accessor for the standalone parser, so consumers that already
   * inject the service do not need a second import.
   */
  parseError(body: unknown, kind: QuotaKind): QuotaExceededError | null {
    return parseQuotaError(body, kind);
  }

  /**
   * GET /api/subscriptions/usage — today's consumption for the caller.
   *
   * Read-only on the server (it never burns quota), so the profile page can
   * call it freely. Throws when the request fails; callers are expected to
   * degrade gracefully instead of blocking the page.
   */
  async getUsage(): Promise<QuotaUsage> {
    const response = await apiFetch(`${this.apiUrl}/usage`, { method: 'GET' });
    const data = await response.json().catch(() => null);
    if (!response.ok) {
      const serverError = data && typeof data === 'object'
        ? (data as Record<string, unknown>)['error']
        : undefined;
      throw new Error(
        (typeof serverError === 'string' && serverError) || `Usage failed (HTTP ${response.status})`
      );
    }
    return normalizeUsage(data);
  }
}
