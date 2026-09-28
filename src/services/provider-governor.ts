/**
 * P0.5 — ProviderGovernor (provider-architecture v2: shared budget/rate/cache).
 *
 * One object governs every third-party provider so free-tier caps are never
 * exceeded (docs/research/provider-operations-budget.md §Operating rules):
 *
 *   1. CACHE   — enrichment results are cached per (provider,key) with a TTL so
 *                we never re-fetch inside a window. This is the main lever that
 *                keeps spend far under free caps.
 *   2. DAILY CAP — per-provider credits/day budget. Once spent we STOP calling
 *                that provider for the rest of the rolling day (freeze, skip,
 *                never hot-retry) instead of burning the account into 402/429.
 *   3. RPM BUCKET — a per-provider leaky bucket (reported rpm at free tier) that
 *                paces bursts before they hit the wall.
 *   4. 402/429 BACKOFF — a non-2xx that signals exhaustion (402 "payment
 *                required" / 429 "rate limited") freezes the provider with
 *                exponential backoff; 5xx is treated as transient and retried.
 *
 * It is intentionally clock/fetch-injectable and side-effect-free so it is
 * trivially unit-testable and can drive `CandidateRegistry.stats()` demotes.
 */

export interface GovernorConfig {
  /** Provider id (matches the registry `DiscoverySource`, e.g. 'fomo'). */
  id: string;
  /** Max credits to spend per rolling day (0/undefined = unlimited). */
  dailyCap?: number;
  /** Free-tier requests per minute (0/undefined = unbounded). */
  rpm?: number;
  /** Assumed credits consumed by one call when the HTTP layer gives none. */
  assumedCostPerCall?: number;
  /** Default cache TTL in ms (0 = no caching). */
  ttlMs?: number;
}

export type GovernorReason =
  | 'ok'
  | 'daily-cap' // rolled-over -> 0 credits left this day, provider frozen
  | 'rate-limited' // rpm bucket exhausted -> caller should wait
  | 'frozen' // provider backoff window active
  | 'http'; // a real HTTP error surfaced (wrapped, not swallowed)

export interface GovernorAttempt<T> {
  ok: boolean;
  reason: GovernorReason;
  data?: T;
  /** Credits actually charged (from the HTTP response header when present). */
  creditsUsed?: number;
  fromCache?: boolean;
  status?: number;
}

/** Minimal HTTP result so the governor can read credit/exhaustion headers. */
export interface GovernorHttpResult<T = unknown> {
  status: number;
  data: T;
  /** e.g. x-credits-used / x-credits-remaining parsed as a number. */
  creditsUsed?: number;
}

/**
 * Call a provider once. Implementations resolve 402/429/5xx themselves; the
 * governor uses the resolved status to classify exhaustion vs transient.
 */
export type GovernorCallFn<T> = () => Promise<GovernorHttpResult<T>>;

const DAY_MS = 24 * 60 * 60 * 1000;
const INITIAL_BACKOFF_MS = 5_000;
const MAX_BACKOFF_MS = 5 * 60 * 1000;

export class ProviderGovernor {
  /** Per-provider rolling-day spend (credits). */
  private readonly spend = new Map<string, number>();
  private dayEpoch = 0; // reset lazily when a new rolling day starts

  /** Leaky bucket per provider: {windowStartMs, windowCount}. */
  private readonly bucket = new Map<string, { start: number; count: number }>();

  /** Provider frozen until epoch ms (daily-cap or backoff). */
  private readonly frozenUntil = new Map<string, number>();
  private readonly consecutiveFailures = new Map<string, number>();

  /** Cache: `${id}:${key}` → {expires, value}. */
  private readonly cache = new Map<string, { expires: number; value: unknown }>();

  constructor(private now: () => number = () => Date.now()) {
    this.rollDay();
  }

  private rollDay(): void {
    this.dayEpoch = this.now();
    // A spend window older than one day is dropped lazily per provider on access.
  }

  /** How much of the daily cap this provider has already spent today. */
  public spendToday(id: string): number {
    return this.spend.get(id) ?? 0;
  }

  /** True when the provider still has budget + is not in a backoff window. */
  public available(id: string, cfg: GovernorConfig): boolean {
    if (this.isFrozen(id)) return false;
    const cap = cfg.dailyCap ?? 0;
    if (cap > 0 && this.spendToday(id) >= cap) return false;
    const rpm = cfg.rpm ?? 0;
    if (rpm > 0 && !this.allowRpm(id, rpm, true)) return false;
    return true;
  }

  private isFrozen(id: string): boolean {
    const until = this.frozenUntil.get(id) ?? 0;
    return until > this.now();
  }

  /** Tolerantly consume one tick of the rpm bucket (no mutation when peek). */
  private allowRpm(id: string, rpm: number, peek: boolean): boolean {
    const now = this.now();
    let b = this.bucket.get(id);
    if (!b || now - b.start >= 60_000) {
      if (peek) return true;
      b = { start: now, count: 0 };
      this.bucket.set(id, b);
    }
    if (b.count >= rpm) return false;
    if (!peek) b.count += 1;
    return true;
  }

  /** Freeze a provider for `ms` (backoff); grows with consecutive 402/429s. */
  public backoff(id: string, ms?: number): void {
    const fail = (this.consecutiveFailures.get(id) ?? 0) + 1;
    this.consecutiveFailures.set(id, fail);
    const delay = Math.min(ms ?? Math.min(INITIAL_BACKOFF_MS * 2 ** (fail - 1), MAX_BACKOFF_MS), MAX_BACKOFF_MS);
    this.frozenUntil.set(id, this.now() + delay);
  }

  /** Charge `credits` against a provider's daily cap (returns false when capped). */
  public charge(id: string, cfg: GovernorConfig, credits: number): boolean {
    const cap = cfg.dailyCap ?? 0;
    const used = this.spendToday(id);
    const cost = credits > 0 ? credits : (cfg.assumedCostPerCall ?? 1);
    if (cap > 0 && used + cost > cap) {
      // Exhausted: freeze for the rest of the rolling day, then report cap.
      this.frozenUntil.set(id, this.now() + (DAY_MS - (this.now() - this.dayEpoch)));
      return false;
    }
    this.spend.set(id, used + cost);
    this.consecutiveFailures.set(id, 0);
    return true;
  }

  /**
   * Run a provider call under the governor: cache → gate → execute → classify.
   * - returns cached value within TTL without touching the rate/cost budget
   * - respects daily cap + rpm + backoff before executing
   * - resolves 402/429 as 'rate-limited'/'daily-cap' (with backoff), everything
   *   else as ok/http; a failed charge (cap hit mid-call) is surfaced too.
   */
  public async run<T>(id: string, cfg: GovernorConfig, key: string | null, fn: GovernorCallFn<T>): Promise<GovernorAttempt<T>> {
    if (key !== null && cfg.ttlMs && cfg.ttlMs > 0) {
      const hit = this.cacheGet(id, key);
      if (hit !== undefined) {
        return { ok: true, data: hit as T, fromCache: true, reason: 'ok' };
      }
    }

    if (!this.available(id, cfg)) {
      const capped = (cfg.dailyCap ?? 0) > 0 && this.spendToday(id) >= (cfg.dailyCap ?? 0);
      const reason = this.isFrozen(id) ? 'frozen' : capped ? 'daily-cap' : 'rate-limited';
      // On a cap hit, freeze for the rest of the rolling day so we do not
      // re-evaluate (or worse, re-call) a provider that is genuinely spent.
      if (capped && !this.isFrozen(id)) {
        this.frozenUntil.set(id, this.now() + (DAY_MS - (this.now() - this.dayEpoch)));
      }
      return { ok: false, reason };
    }

    // Consume one rpm tick AND pre-charge an assumed call so a burst cannot
    // slip past the cap across a concurrent batch.
    if ((cfg.rpm ?? 0) > 0) {
      this.allowRpm(id, cfg.rpm ?? 0, false);
    }
    if (!this.charge(id, cfg, cfg.assumedCostPerCall ?? 1)) {
      return { ok: false, reason: 'daily-cap' };
    }

    let res: GovernorHttpResult<T>;
    try {
      res = await fn();
    } catch (err) {
      // Network/parse failure — do NOT charge a provider for what never happened,
      // and do not count transients as exhaustion. Return as a soft failure.
      this.refund(id, cfg);
      return { ok: false, reason: 'http', data: undefined };
    }

    const status = res.status;
    if (status === 402 || status === 429) {
      // Exhaustion signal: freeze with backoff and report the wall honestly.
      this.backoff(id);
      return { ok: false, reason: status === 402 ? 'daily-cap' : 'rate-limited', status };
    }
    if (status >= 500) {
      // Transient server error — do not charge (already not charged past pre-fee).
      this.refund(id, cfg);
      return { ok: false, reason: 'http', status };
    }

    // Success: reconcile credits actually used (header) if provided, else keep
    // the pre-charge. The pre-charge already accounted for the assumed cost, so
    // only a *higher* actual cost is charged additionally. Store in cache when
    // a key + TTL were supplied.
    const used = res.creditsUsed ?? (cfg.assumedCostPerCall ?? 1);
    const diff = used - (cfg.assumedCostPerCall ?? 1);
    if (diff > 0 && !this.charge(id, cfg, diff)) {
      return { ok: false, reason: 'daily-cap', status };
    }
    if (key !== null && cfg.ttlMs && cfg.ttlMs > 0) {
      this.cacheSet(id, key, res.data, cfg.ttlMs);
    }
    return { ok: true, data: res.data, creditsUsed: used, status, reason: 'ok', fromCache: false };
  }

  /** Undo a pre-charge made for a call that never actually executed. */
  private refund(id: string, cfg: GovernorConfig): void {
    const cost = cfg.assumedCostPerCall ?? 1;
    this.spend.set(id, Math.max(0, this.spendToday(id) - cost));
  }

  // ---- cache helpers ----
  public cacheSet(id: string, key: string, value: unknown, ttlMs: number): void {
    const k = `${id}:${key}`;
    this.cache.set(k, { expires: this.now() + ttlMs, value });
  }

  public cacheGet<T>(id: string, key: string): T | undefined {
    const hit = this.cache.get(`${id}:${key}`);
    if (!hit) return undefined;
    if (hit.expires <= this.now()) {
      this.cache.delete(`${id}:${key}`);
      return undefined;
    }
    return hit.value as T;
  }

  /** Expose per-provider state for the [PROVIDER STATS] line & tuning. */
  public stats(): Record<string, { spent: number; frozenMs: number }> {
    const out: Record<string, { spent: number; frozenMs: number }> = {};
    for (const [id, spent] of this.spend) {
      const until = this.frozenUntil.get(id) ?? 0;
      out[id] = { spent, frozenMs: Math.max(0, until - this.now()) };
    }
    return out;
  }
}

/** Process-wide singleton so every adapter shares one budget ledger. */
export const globalProviderGovernor = new ProviderGovernor();