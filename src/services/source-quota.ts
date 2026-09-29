/**
 * SourceQuota — best-effort demotion for third-party indexers.
 *
 * Strategic directive: every third-party indexer (GMGN, DexPaprika, Gecko,
 * Routescan, CMC, SolanaTracker, …) is an ENRICHMENT source, never a blocker.
 * When one fails it must NOT spam logs or stall the funnel. SourceQuota does
 * the "demote to best-effort" half:
 *
 *   - Classify HTTP failures: `quota` (400/402/429 → paywall/rate-limit),
 *     `transient` (5xx / network), `unknown`.
 *   - After a quota hit, the source enters a cooling-off window during which
 *     its collector is short-circuited (return empty) instead of hammering a
 *     dead endpoint and re-logging. Only the first failure is logged.
 *
 * Pure, deterministic, injectable `now` for hermetic tests.
 */

export type FailureClass = 'quota' | 'transient' | 'unknown';

export function classifyHttpFailure(status: number | undefined, err?: unknown): FailureClass {
  if (status === 400 || status === 402 || status === 429) return 'quota';
  if (status !== undefined && status >= 500) return 'transient';
  if (status !== undefined) return 'unknown';
  // No HTTP status → transport/parse error; treat as transient (retry later).
  if (err === undefined) return 'unknown';
  return 'transient';
}

/** Best-effort pull of an HTTP status from a thrown error (provider-specific). */
export function statusOf(err: unknown): number | undefined {
  if (err && typeof err === 'object') {
    const e = err as { status?: unknown; response?: { status?: unknown } };
    const s = e.status ?? e.response?.status;
    if (typeof s === 'number') return s;
    if (typeof s === 'string') {
      const n = Number(s);
      if (Number.isFinite(n)) return n;
    }
  }
  return undefined;
}

export class SourceQuota {
  private coolingUntil = new Map<string, number>();
  private lastLogged = new Map<string, FailureClass>();
  private readonly cooldownMs: number;
  private readonly now: () => number;

  constructor(cooldownMs = 60_000, now?: () => number) {
    this.cooldownMs = cooldownMs;
    this.now = now ?? (() => Date.now());
  }

  /** True when the source is cooling off and should be short-circuited. */
  public isCooling(source: string, nowMs: number = this.now()): boolean {
    return (this.coolingUntil.get(source) ?? 0) > nowMs;
  }

  /**
   * Register a failure and return true when this is the first (log-worthy)
   * hit for the source during the current window — callers log once, not on
   * every short-circuit.
   */
  public backoff(source: string, cls: FailureClass, nowMs: number = this.now()): boolean {
    const until = nowMs + (cls === 'quota' ? this.cooldownMs : this.cooldownMs / 4);
    this.coolingUntil.set(source, until);
    const first = this.lastLogged.get(source) !== cls;
    this.lastLogged.set(source, cls);
    return first;
  }

  public clear(): void {
    this.coolingUntil.clear();
    this.lastLogged.clear();
  }
}

export const globalSourceQuota = new SourceQuota();
