import { Injectable } from '@angular/core';
import { environment } from '../../environments/environment';

export const AB_CLIENT_STORAGE_KEY = 'nomos_ab_client';
export const CONTROL_VARIANT = 'control';

export interface ExperimentDefinition {
  variants: Record<string, number>;
}

export type ExperimentConfig = Record<string, ExperimentDefinition>;

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

/** FNV-1a 32-bit hash; stable across browsers and sessions. */
export function hashString(value: string): number {
  let hash = 0x811c9dc5;
  for (let index = 0; index < value.length; index += 1) {
    hash ^= value.charCodeAt(index);
    hash = Math.imul(hash, 0x01000193);
  }
  return hash >>> 0;
}

/** Deterministic weighted pick from a 0..99 bucket derived from client + name. */
export function pickVariant(
  clientId: string,
  experimentName: string,
  definition: ExperimentDefinition
): string {
  const variants = Object.entries(definition.variants).filter(
    ([name, weight]) => name.length > 0 && Number.isFinite(weight) && weight > 0
  );
  if (variants.length === 0) return CONTROL_VARIANT;

  const total = variants.reduce((sum, [, weight]) => sum + weight, 0);
  const bucket = hashString(`${clientId}:${experimentName}`) % 100;
  const point = (bucket / 100) * total;

  let cumulative = 0;
  for (const [name, weight] of variants) {
    cumulative += weight;
    if (point < cumulative) return name;
  }
  return variants[variants.length - 1][0];
}

/** Drops malformed experiments/weights instead of trusting the server blindly. */
export function sanitizeExperiments(raw: unknown): ExperimentConfig {
  if (!isRecord(raw)) return {};

  const result: ExperimentConfig = {};
  for (const [name, definition] of Object.entries(raw)) {
    if (!isRecord(definition)) continue;
    const rawVariants = definition['variants'];
    if (!isRecord(rawVariants)) continue;

    const variants: Record<string, number> = {};
    for (const [variant, weight] of Object.entries(rawVariants)) {
      if (
        variant.length > 0 &&
        typeof weight === 'number' &&
        Number.isFinite(weight) &&
        weight > 0
      ) {
        variants[variant] = weight;
      }
    }
    if (Object.keys(variants).length > 0) {
      result[name] = { variants };
    }
  }
  return result;
}

/**
 * Lightweight client-side A/B assignment.
 *
 * GET /api/config is fetched once on demand and cached; any failure leaves the
 * experiment map empty, so callers deterministically get `control`. The
 * anonymous client id is persisted in localStorage and guarded for SSR.
 */
@Injectable({ providedIn: 'root' })
export class ExperimentService {
  private config: ExperimentConfig = {};
  private readyPromise: Promise<void> | null = null;
  private clientId: string | null = null;

  ready(): Promise<void> {
    if (!this.readyPromise) {
      this.readyPromise = this.loadConfig();
    }
    return this.readyPromise;
  }

  getVariant(name: string): string {
    const definition = this.config[name];
    if (!definition) return CONTROL_VARIANT;
    return pickVariant(this.getClientId(), name, definition);
  }

  getClientId(): string {
    if (this.clientId) return this.clientId;

    const stored = this.readStoredClientId();
    if (stored) {
      this.clientId = stored;
      return stored;
    }

    const generated = this.generateClientId();
    this.clientId = generated;
    this.writeStoredClientId(generated);
    return generated;
  }

  private async loadConfig(): Promise<void> {
    try {
      if (typeof fetch !== 'function') {
        this.config = {};
        return;
      }

      const response = await fetch(`${environment.apiBaseUrl}/api/config`, {
        headers: { Accept: 'application/json' }
      });
      if (!response.ok) {
        this.config = {};
        return;
      }

      const payload: unknown = await response.json();
      this.config = isRecord(payload)
        ? sanitizeExperiments(payload['experiments'])
        : {};
    } catch {
      this.config = {};
    }
  }

  private generateClientId(): string {
    try {
      if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') {
        return crypto.randomUUID();
      }
    } catch {
      // Fall through to the timestamp/random fallback.
    }
    return `ab-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 12)}`;
  }

  private readStoredClientId(): string | null {
    try {
      if (typeof localStorage === 'undefined') return null;
      const stored = localStorage.getItem(AB_CLIENT_STORAGE_KEY);
      return stored ? stored : null;
    } catch {
      return null;
    }
  }

  private writeStoredClientId(clientId: string): void {
    try {
      if (typeof localStorage === 'undefined') return;
      localStorage.setItem(AB_CLIENT_STORAGE_KEY, clientId);
    } catch {
      // Private browsing / SSR: the in-memory id still keeps assignment stable.
    }
  }
}
