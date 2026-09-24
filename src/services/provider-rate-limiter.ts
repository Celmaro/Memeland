/**
 * I1-1 — Provider rate-limit budget + 429 circuit breaker.
 *
 * The structural rate-limit fix (review-revised): before building a full durable
 * queue, add a small control layer that stops the hammering at the source.
 *
 * - Per-provider cycle budget + concurrency limit + min refresh interval.
 * - A 429/rate-limit circuit breaker: on repeated 429s the provider is opened
 *   (paused) for a backoff window WITHOUT counting the failure against individual
 *   tokens — a provider outage must not look like "all these tokens failed".
 * - Exponential backoff with jitter; honors Retry-After when present.
 *
 * Dependency-free (no node:sqlite — Node >=20 compatibility). Consumers:
 *   - globalRPCFailoverManager probes (pause a host that returns 429).
 *   - Screening cycle batches (pause a whole provider feed on open circuit).
 */

/** Circuit state for a single provider/host. */
export interface CircuitState {
  closed: boolean;
  failures: number;
  openedAt: number;
  retryAfterMs: number;
  consecutive: number;
}

export type CircuitBreakerKind = '429' | 'network' | 'hard';

export interface RateLimitOptions {
  /** Max requests per cycle window. Default 300. */
  maxRequests?: number;
  /** Cycle window ms. Default 5 min. */
  windowMs?: number;
  /** Max concurrent in-flight requests. Default 5. */
  maxConcurrent?: number;
  /** Min ms between two requests (pacing). Default 200. */
  minIntervalMs?: number;
  /** Failures before opening the circuit. Default 3. */
  failureThreshold?: number;
  /** Base backoff ms, doubled per consecutive open. Default 10_000. */
  baseBackoffMs?: number;
  /** Max backoff ms. Default 120_000. */
  maxBackoffMs?: number;
}

const DEFAULTS: Required<RateLimitOptions> = {
  maxRequests: 300,
  windowMs: 5 * 60_000,
  maxConcurrent: 5,
  minIntervalMs: 200,
  failureThreshold: 3,
  baseBackoffMs: 10_000,
  maxBackoffMs: 120_000,
};

export class ProviderRateLimiter {
  private readonly opts: Required<RateLimitOptions>;
  private readonly circuits = new Map<string, CircuitState>();
  private requestTimes: number[] = [];
  private inFlight = 0;
  private lastRequestAt = 0;

  constructor(opts: RateLimitOptions = {}) {
    this.opts = { ...DEFAULTS, ...opts };
  }

  /** Whether a request may start now (budget + pacing + concurrency). */
  canRequest(now = Date.now()): { ok: boolean; reason?: string } {
    if (this.inFlight >= this.opts.maxConcurrent) return { ok: false, reason: `concurrency ${this.inFlight}/${this.opts.maxConcurrent}` };
    const windowStart = now - this.opts.windowMs;
    this.requestTimes = this.requestTimes.filter((t) => t > windowStart);
    if (this.requestTimes.length >= this.opts.maxRequests) return { ok: false, reason: `cycle budget ${this.opts.maxRequests} reached` };
    if (now - this.lastRequestAt < this.opts.minIntervalMs) return { ok: false, reason: 'pacing' };
    return { ok: true };
  }

  /** Call before starting a request. Throws when the budget/concurrency denies it. */
  acquire(now = Date.now()): void {
    const check = this.canRequest(now);
    if (!check.ok) throw new Error(`rate-limit: ${check.reason}`);
    this.inFlight += 1;
    this.lastRequestAt = now;
    this.requestTimes.push(now);
  }

  release(): void {
    this.inFlight = Math.max(0, this.inFlight - 1);
  }

  /** Per-host circuit state. */
  circuitFor(id: string): CircuitState {
    let c = this.circuits.get(id);
    if (!c) {
      c = { closed: true, failures: 0, openedAt: 0, retryAfterMs: 0, consecutive: 0 };
      this.circuits.set(id, c);
    }
    return c;
  }

  /** Is the host open (paused)? If a backoff has elapsed, it half-opens. */
  isOpen(id: string, now = Date.now()): boolean {
    const c = this.circuitFor(id);
    if (!c.closed && now - c.openedAt >= c.retryAfterMs) {
      // half-open: allow one probe to test recovery
      c.closed = true;
      c.failures = 0;
      return false;
    }
    return !c.closed;
  }

  /** Record a failure of kind. A 429 opens the circuit with backoff. */
  recordFailure(id: string, kind: CircuitBreakerKind, retryAfterMs?: number): void {
    const c = this.circuitFor(id);
    if (kind === 'hard') {
      c.closed = false;
      c.openedAt = Date.now();
      c.retryAfterMs = retryAfterMs ?? 0;
      c.consecutive += 1;
      return;
    }
    c.failures += 1;
    // A 429 counts toward the open threshold WITHOUT being a per-token failure.
    if (c.failures >= this.opts.failureThreshold) {
      c.closed = false;
      c.openedAt = Date.now();
      c.consecutive += 1;
      const backoff = Math.min(this.opts.maxBackoffMs, this.opts.baseBackoffMs * 2 ** (c.consecutive - 1));
      // jitter: 80-100% of the computed backoff
      c.retryAfterMs = retryAfterMs ?? Math.round(backoff * (0.8 + Math.random() * 0.2));
      c.failures = 0;
    }
  }

  /** Record a success — closes a half-open circuit / resets a soft count. */
  recordSuccess(id: string): void {
    const c = this.circuitFor(id);
    c.failures = 0;
    if (c.consecutive > 0) c.consecutive = 0;
    c.closed = true;
  }

  /** Seconds until an open circuit retries (for logs / Retry-After surfaces). */
  retryInSec(id: string, now = Date.now()): number {
    const c = this.circuitFor(id);
    if (c.closed) return 0;
    const elapsed = now - c.openedAt;
    return c.retryAfterMs > elapsed ? Math.ceil((c.retryAfterMs - elapsed) / 1000) : 0;
  }
}

/** Shared singleton used across the screening cycle + RPC probes. */
export const globalRateLimiter = new ProviderRateLimiter();
