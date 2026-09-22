/**
 * KC4 / Kernel O — pure-clock staleness utility. Replaces ad-hoc
 * `Date.now() - this.lastFetchTime > this.cacheDurationMs` patterns and the
 * bare `timestamp` bookkeeping in swarm-consensus intent tracking.
 *
 * Pure utility, no I/O, injectable clock for tests.
 */

export interface StalenessClockOptions {
  /** Time after which isStale() returns true. */
  ttlMs: number;
  /** Injectable clock (defaults to Date.now). */
  now?: () => number;
}

export class StalenessClock {
  private readonly ttlMs: number;
  private readonly now: () => number;
  private lastTouchedAt: number | null = null;

  constructor(opts: StalenessClockOptions) {
    if (!(opts.ttlMs > 0)) throw new Error('StalenessClock: ttlMs must be > 0');
    this.ttlMs = opts.ttlMs;
    this.now = opts.now ?? Date.now;
  }

  /** Mark a fresh touch — resets the staleness window. */
  public touch(at?: number): void {
    this.lastTouchedAt = at ?? this.now();
  }

  /** Has the window elapsed since the last touch? (Untouched → stale.) */
  public isStale(at?: number): boolean {
    if (this.lastTouchedAt === null) return true;
    const t = at ?? this.now();
    return t - this.lastTouchedAt > this.ttlMs;
  }

  /** Milliseconds since the last touch (or null if untouched). */
  public ageMs(at?: number): number | null {
    if (this.lastTouchedAt === null) return null;
    return (at ?? this.now()) - this.lastTouchedAt;
  }

  /** Read the last-touch timestamp; null if untouched. */
  public get lastTouched(): number | null {
    return this.lastTouchedAt;
  }
}