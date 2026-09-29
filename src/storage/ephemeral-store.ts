/**
 * P5 — Redis ephemeral queues / locks / cache, gated on REDIS_URL.
 *
 * The held roadmap flagged Redis for "ephemeral queues, locks and cache" once
 * research/enrichment call volume justifies it. Like every third-party sink in
 * this codebase, Redis is a best-effort accelerator: an unreachable cache must
 * NEVER change a decision, block a funnel, or resurrect a cooldown the process
 * already enforces.
 *
 * Abstraction keeps callers transport-agnostic:
 *
 *  - `EphemeralStore` — the lean contract (TTL cache, advisory lock, fifo queue).
 *  - `InMemoryEphemeralStore` — DEFAULT. Fully verified in CI (TTL via a clock,
 *    locks vs a map+deadline, queues as arrays). Runs whenever REDIS_URL is
 *    absent (tests, local dev, deployment without Redis).
 *  - `RedisEphemeralStore` — production backend, activated only when REDIS_URL
 *    is present. An in-memory mirror is ALWAYS the synchronous source of truth
 *    for this process (so get/lock/queue stay correct and testable), and Redis
 *    mirrors writes fire-and-forget for cross-process sharing near real-time.
 *    Every Redis op is fail-open: transport error → mirror-only, never a throw
 *    into the caller, never a different decision.
 */

/** In-memory ephemeral backend — the default, CI-verified transport. */
export class InMemoryEphemeralStore {
  private cache = new Map<string, { value: unknown; expiresAt: number }>();
  private locks = new Map<string, number>();
  private queues = new Map<string, string[]>();
  private readonly now: () => number;

  constructor(now?: () => number) {
    this.now = now ?? (() => Date.now());
  }

  get<T>(key: string): T | undefined {
    const e = this.cache.get(key);
    if (!e) return undefined;
    if (this.now() >= e.expiresAt) {
      this.cache.delete(key);
      return undefined;
    }
    return e.value as T;
  }

  set<T>(key: string, value: T, ttlMs: number): void {
    if (ttlMs <= 0) return;
    this.cache.set(key, { value, expiresAt: this.now() + ttlMs });
  }

  del(key: string): boolean {
    return this.cache.delete(key);
  }

  acquireLock(key: string, ttlMs: number): boolean {
    const now = this.now();
    const existing = this.locks.get(key);
    if (existing !== undefined && existing > now) return false; // held
    this.locks.set(key, now + ttlMs);
    return true;
  }

  releaseLock(key: string): void {
    this.locks.delete(key);
  }

  enqueue(key: string, value: string): number {
    const q = this.queues.get(key) ?? [];
    q.push(value);
    this.queues.set(key, q);
    return q.length;
  }

  dequeue(key: string): string | undefined {
    const q = this.queues.get(key);
    if (!q || q.length === 0) return undefined;
    const v = q.shift();
    if (q.length === 0) this.queues.delete(key);
    return v;
  }
}

/** Shared contract — both backends implement it, so callers see one surface. */
export interface EphemeralStore {
  get<T>(key: string): T | undefined;
  set<T>(key: string, value: T, ttlMs: number): void;
  del(key: string): boolean;
  acquireLock(key: string, ttlMs: number): boolean;
  releaseLock(key: string): void;
  enqueue(key: string, value: string): number;
  dequeue(key: string): string | undefined;
  /** Best-effort startup connectivity probe (in-memory impl reports armed=false). */
  probe?(): Promise<{ armed: boolean; ok: boolean; detail: string }>;
}

/**
 * Redis + in-memory mirror. The mirror is the synchronous source of truth for
 * the current process; writes are ALSO pushed to Redis fire-and-forget so
 * other processes/restarts observe them. Every Redis op is wrapped in a
 * catch → mirror-only (never throws, never changes a decision).
 */
export class RedisEphemeralStore implements EphemeralStore {
  private mirror = new InMemoryEphemeralStore();
  private readonly url: string | null;
  private client: any = null;

  constructor(url?: string) {
    // Resolution order: explicit URL arg > REDIS_URL > Zeabur-injected
    // REDIS_URI / REDIS_CONNECTION_STRING (internal service hostname reachable
    // only from inside the deployment). Zeabur does NOT set REDIS_URL.
    this.url =
      url ??
      process.env.REDIS_URL ??
      process.env.REDIS_URI ??
      process.env.REDIS_CONNECTION_STRING ??
      null;
    if (!this.url) {
      console.warn('[EPHEMERAL] RedisEphemeralStore without a Redis URL — mirror-only (fail-open).');
    }
  }

  public redisArmed(): boolean {
    return Boolean(this.url);
  }

  /**
   * Best-effort startup connectivity probe. Logs whether the Redis path armed
   * and whether the client actually connected — used to confirm the backend in
   * cloud (Zeabur injects REDIS_URI). Never throws.
   */
  public async probe(): Promise<{ armed: boolean; ok: boolean; detail: string }> {
    if (!this.url) return { armed: false, ok: false, detail: 'no Redis URL configured — in-memory mirror only' };
    try {
      const c = await this.ensureClient();
      const pong = await c.ping();
      return { armed: true, ok: pong === 'PONG', detail: `ping=${String(pong)}` };
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      console.warn(`[EPHEMERAL] Redis probe failed (fail-open to mirror): ${msg}`);
      return { armed: true, ok: false, detail: msg };
    }
  }

  get<T>(key: string): T | undefined {
    return this.mirror.get<T>(key);
  }

  set<T>(key: string, value: T, ttlMs: number): void {
    this.mirror.set(key, value, ttlMs);
    if (this.url && ttlMs > 0) {
      void this.ensureClient()
        .then((c) => c.set(key, JSON.stringify(value), 'PX', ttlMs))
        .catch(() => undefined);
    }
  }

  del(key: string): boolean {
    const mirrored = this.mirror.del(key);
    if (this.url) {
      void this.ensureClient()
        .then((c) => c.del(key))
        .catch(() => undefined);
    }
    return mirrored;
  }

  acquireLock(key: string, ttlMs: number): boolean {
    const mirrored = this.mirror.acquireLock(key, ttlMs);
    if (this.url && mirrored && ttlMs > 0) {
      // Best-effort distributed lock; the mirror is already authoritative here.
      void this.ensureClient()
        .then((c) => c.set(key, String(Date.now()), 'PX', ttlMs, 'NX'))
        .catch(() => undefined);
    }
    return mirrored;
  }

  releaseLock(key: string): void {
    this.mirror.releaseLock(key);
    if (this.url) {
      void this.ensureClient()
        .then((c) => c.del(key))
        .catch(() => undefined);
    }
  }

  enqueue(key: string, value: string): number {
    const n = this.mirror.enqueue(key, value);
    if (this.url) {
      void this.ensureClient()
        .then((c) => c.rpush(key, value))
        .catch(() => undefined);
    }
    return n;
  }

  dequeue(key: string): string | undefined {
    const v = this.mirror.dequeue(key);
    // Fire-and-forget LPop keeps Redis roughly consistent; the mirror is the
    // authoritative read for this process.
    if (this.url && v !== undefined) {
      void this.ensureClient()
        .then((c) => c.lpop(key))
        .catch(() => undefined);
    }
    return v;
  }

  private async ensureClient(): Promise<any> {
    if (this.client) return this.client;
    if (!this.url) throw new Error('REDIS_URL not configured');
    // Lazy dynamic import keeps `ioredis` out of the sync import graph.
    const { Redis } = await import('ioredis');
    this.client = new Redis(this.url, { maxRetriesPerRequest: 1, connectTimeout: 3000 });
    return this.client;
  }
}

/**
 * Select the ephemeral store. A Redis URL (REDIS_URL or Zeabur's
 * REDIS_URI/REDIS_CONNECTION_STRING) present → Redis (mirror + fire-and-forget,
 * fail-open). Absent → pure in-memory (tests, local, and deployments without Redis).
 */
export function createEphemeralStore(): EphemeralStore {
  if (process.env.REDIS_URL || process.env.REDIS_URI || process.env.REDIS_CONNECTION_STRING) {
    return new RedisEphemeralStore();
  }
  return new InMemoryEphemeralStore();
}

/** Process-wide ephemeral store for cache/locks/queues. */
export const globalEphemeralStore: EphemeralStore = createEphemeralStore();