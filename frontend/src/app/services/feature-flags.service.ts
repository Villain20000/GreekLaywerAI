import { Injectable, Signal, signal } from '@angular/core';
import { environment } from '../../environments/environment';

export interface FeatureFlags {
  billing: boolean;
  documents: boolean;
  audio: boolean;
  adminDocuments: boolean;
  [flag: string]: boolean;
}

const DEFAULT_FLAGS: FeatureFlags = {
  billing: true,
  documents: true,
  audio: true,
  adminDocuments: true
};

/**
 * Public runtime feature flags (GET /api/config).
 *
 * The request is unauthenticated and fired once per app lifetime. Whenever
 * it fails the defaults stay enabled: a config outage must not hide core
 * navigation from signed-in users.
 */
@Injectable({ providedIn: 'root' })
export class FeatureFlagsService {
  private readonly state = signal<FeatureFlags>({ ...DEFAULT_FLAGS });
  readonly flags: Signal<FeatureFlags> = this.state.asReadonly();
  private loadPromise: Promise<void> | null = null;

  constructor() {
    void this.ensureLoaded();
  }

  /** Resolves once the first (and only) config request settles. */
  ensureLoaded(): Promise<void> {
    if (!this.loadPromise) {
      this.loadPromise = this.fetchFlags();
    }
    return this.loadPromise;
  }

  /** Unknown flags default to enabled. */
  isEnabled(flag: string): boolean {
    const value = this.state()[flag];
    return value === undefined ? true : value;
  }

  private async fetchFlags(): Promise<void> {
    try {
      const res = await fetch(`${environment.apiBaseUrl}/api/config`, {
        headers: { Accept: 'application/json' }
      });
      if (!res.ok) return;

      const payload = (await res.json()) as { features?: Record<string, unknown> };
      const features = payload && payload.features;
      if (!features || typeof features !== 'object') return;

      const next: FeatureFlags = { ...this.state() };
      for (const [name, value] of Object.entries(features)) {
        if (typeof value === 'boolean') next[name] = value;
      }
      this.state.set(next);
    } catch {
      // Keep the enabled defaults on network/parse failures.
    }
  }
}
