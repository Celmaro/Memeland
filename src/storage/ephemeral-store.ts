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

  async acquireLock(key: string, ttlMs: number): Promise<boolean> {
    const now = this.now();
    const existing = this.locks.get(key);
    if (existing !== undefined && existing > now) return false; // held
    this.locks.set(key, now + ttlMs);
    return true;
  }

  async releaseLock(key: string): Promise<void> {
    this.locks.delete(key);
  }

  async enqueue(key: string, value: string): Promise<number> {
    const q = this.queues.get(key) ?? [];
    q.push(value);
    this.queues.set(key, q);
    return q.length;
  }

  async dequeue(key: string): Promise<string | undefined> {
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
  /**
   * Acquire an advisory lock. P8: the Redis backend makes this AUTHORITATIVE —
   * it awaits the Redis `SET NX` and returns ITS result, so two processes cannot
   * both proceed; the in-memory mirror is only a fail-open fallback when Redis
   * is unavailable (never a throw, never a fabricated grant). In-memory backend
   * resolves from its process-local lock map.
   */
  acquireLock(key: string, ttlMs: number): Promise<boolean>;
  releaseLock(key: string): Promise<void>;
  enqueue(key: string, value: string): Promise<number>;
  dequeue(key: string): Promise<string | undefined>;
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

  async acquireLock(key: string, ttlMs: number): Promise<boolean> {
    // P8 — Redis is AUTHORITATIVE for the lock. Await the `SET NX` and return ITS
    // result, so two processes cannot both proceed (the old mirror-first path
    // returned `true` before the async NX, even when another process held it).
    // The mirror is only a fail-open fallback when Redis is unreachable.
    if (!this.url || ttlMs <= 0) return this.mirror.acquireLock(key, ttlMs);
    try {
      const c = await this.ensureClient();
      // ioredis `set(..., 'NX')` resolves "OK" when acquired, null when held.
      const res = await c.set(key, String(Date.now()), 'PX', ttlMs, 'NX');
      return res === 'OK';
    } catch {
      return this.mirror.acquireLock(key, ttlMs);
    }
  }

  async releaseLock(key: string): Promise<void> {
    if (!this.url) { this.mirror.releaseLock(key); return; }
    try {
      const c = await this.ensureClient();
      await c.del(key);
    } catch {
      this.mirror.releaseLock(key);
    }
  }

  async enqueue(key: string, value: string): Promise<number> {
    if (!this.url) return this.mirror.enqueue(key, value);
    try {
      const c = await this.ensureClient();
      // rpush returns the list length (authoritative cross-process queue depth).
      const n = await c.rpush(key, value);
      return typeof n === 'number' ? n : this.mirror.enqueue(key, value);
    } catch {
      return this.mirror.enqueue(key, value);
    }
  }

  async dequeue(key: string): Promise<string | undefined> {
    if (!this.url) return this.mirror.dequeue(key);
    try {
      const c = await this.ensureClient();
      const v = await c.lpop(key);
      return v ?? undefined;
    } catch {
      return this.mirror.dequeue(key);
    }
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