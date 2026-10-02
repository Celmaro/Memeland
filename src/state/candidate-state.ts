/**
 * T1 — Distributed candidate state registry (causal state transition matrix +
 * optimistic-locking state reducer).
 *
 * Asynchronous ingestion events (RPC block log, DexScreener batch, Helius/WS
 * webhook, GMGN smart-money alerts) can arrive OUT OF ORDER. A naive reducer
 * lets an early enricher report $0 volume (evaluated before liquidity was
 * injected) register a false negative, or lets a stale update clobber a fresher
 * one. This module models each candidate as an explicit state record governed by
 * a MONOTONIC causal transition matrix that rejects retrograde updates, and
 * persists transitions through an optimistic-locking (version-tagged) CAS store
 * so concurrent workers cannot lose updates.
 *
 * Fail-open contract (same as every third-party sink in this codebase): an
 * unreachable Redis backend MUST NOT change a decision or block a funnel. The
 * in-memory backend is the synchronous source of truth for the process; Redis
 * is authoritative for cross-process atomicity when reachable, with a fail-open
 * fallback to the in-memory mirror on transport error (never a throw into the
 * caller, never a fabricated success).
 */

/** Causal states, ordered roughly along the funnel (see matrix below). */
export type CandidateState =
  | 'UNINITIALIZED'
  | 'PENDING_DISCOVERY'
  | 'DISCOVERED'
  | 'SCREENED_L1'
  | 'SEC_PASSED'
  | 'HYDRATED'
  | 'P42_GATED'
  | 'DISPATCH_READY'
  | 'IN_FLIGHT'
  | 'FILLED'
  | 'DROPPED'
  | 'EVICTED';

/** Inbound causal events that drive the transition matrix. */
export type CandidateEvent =
  | 'DISCOVERY_EVENT'
  | 'ENRICHMENT_UPDATE'
  | 'RESERVE_INJECTED'
  | 'SECURITY_VERIFIED'
  | 'ENRICHMENT_SETTLED'
  | 'ML_SCORE_EVALUATED'
  | 'ARKHAM_CLEARED'
  | 'TX_BROADCASTED'
  | 'RECEIPT_CONFIRMED'
  | 'DROP'
  | 'TTL_EXPIRED';

export interface CandidateStateRecord {
  /** chain:address */
  id: string;
  version: number;
  state: CandidateState;
  baseReserveUsd: number;
  volume1hUsd: number;
  score: number;
  updatedAt: number;
}

/** TTL for a live candidate (seconds). Aligned with the spec's 900s. */
export const CANDIDATE_TTL_SECONDS = 900;
export const CANDIDATE_TTL_MS = CANDIDATE_TTL_SECONDS * 1000;

const CANDIDATE_KEY_PREFIX = 'candidate:';

export function candidateKey(id: string): string {
  return `${CANDIDATE_KEY_PREFIX}${id}`;
}

/** Condition evaluation context — operator-supplied predicates for matrix rows. */
export interface TransitionContext {
  baseReserveUsd: number;
  volume1hUsd: number;
  score: number;
  /** Deployer historical rug count (Arkham/Blockscout), for ARKHAM_CLEARED. */
  deployerRugCount?: number;
  /** ML pass threshold, for ML_SCORE_EVALUATED. */
  scoreThreshold?: number;
  /** $1k liquidity gate, for RESERVE_INJECTED. */
  liquidityGateUsd?: number;
}

export type TransitionCondition = (ctx: TransitionContext) => boolean;

interface MatrixRow {
  to: CandidateState;
  condition?: TransitionCondition;
}

/**
 * The causal state transition matrix. A transition NOT present here is a
 * RETROGRADE / out-of-order update and is rejected. `DROP` and `TTL_EXPIRED`
 * are the monotonic exits (drop when flagged malicious/blacklisted; evict on
 * TTL expiry) and are permitted from any active state.
 */
export const CAUSAL_TRANSITION_MATRIX: Record<CandidateState, Partial<Record<CandidateEvent, MatrixRow>>> = {
  UNINITIALIZED: {
    DISCOVERY_EVENT: { to: 'DISCOVERED', condition: (c) => c.baseReserveUsd >= 0 },
    ENRICHMENT_UPDATE: { to: 'PENDING_DISCOVERY' },
  },
  PENDING_DISCOVERY: {
    DISCOVERY_EVENT: { to: 'DISCOVERED', condition: (c) => c.baseReserveUsd >= 0 },
  },
  DISCOVERED: {
    RESERVE_INJECTED: { to: 'SCREENED_L1', condition: (c) => c.baseReserveUsd >= (c.liquidityGateUsd ?? 1000) },
    DROP: { to: 'DROPPED' },
    TTL_EXPIRED: { to: 'EVICTED' },
  },
  SCREENED_L1: {
    SECURITY_VERIFIED: { to: 'SEC_PASSED' },
    DROP: { to: 'DROPPED' },
    TTL_EXPIRED: { to: 'EVICTED' },
  },
  SEC_PASSED: {
    ENRICHMENT_SETTLED: { to: 'HYDRATED' },
    DROP: { to: 'DROPPED' },
    TTL_EXPIRED: { to: 'EVICTED' },
  },
  HYDRATED: {
    ML_SCORE_EVALUATED: {
      to: 'P42_GATED',
      condition: (c) => c.score >= (c.scoreThreshold ?? 0),
    },
    DROP: { to: 'DROPPED' },
    TTL_EXPIRED: { to: 'EVICTED' },
  },
  P42_GATED: {
    ARKHAM_CLEARED: {
      to: 'DISPATCH_READY',
      condition: (c) => (c.deployerRugCount ?? 0) <= 1,
    },
    DROP: { to: 'DROPPED' },
    TTL_EXPIRED: { to: 'EVICTED' },
  },
  DISPATCH_READY: {
    TX_BROADCASTED: { to: 'IN_FLIGHT' },
    DROP: { to: 'DROPPED' },
    TTL_EXPIRED: { to: 'EVICTED' },
  },
  IN_FLIGHT: {
    RECEIPT_CONFIRMED: { to: 'FILLED' },
    DROP: { to: 'DROPPED' },
    TTL_EXPIRED: { to: 'EVICTED' },
  },
  FILLED: {
    TTL_EXPIRED: { to: 'EVICTED' },
  },
  DROPPED: {},
  EVICTED: {},
};

export interface TransitionResult {
  ok: boolean;
  next?: CandidateState;
  reason?: string;
}

/**
 * Pure causal-transition evaluation (no IO). Rejects unknown / retrograde
 * transitions and condition failures. `scoreThreshold` / `liquidityGateUsd`
 * come through the context.
 */
export function evaluateCausalTransition(
  current: CandidateState,
  event: CandidateEvent,
  ctx: TransitionContext,
): TransitionResult {
  const row = CAUSAL_TRANSITION_MATRIX[current]?.[event];
  if (!row) {
    return { ok: false, reason: `no causal transition '${current}' + '${event}' (retrograde or unknown)` };
  }
  if (row.condition && !row.condition(ctx)) {
    return { ok: false, reason: `causal condition failed for '${current}' + '${event}'` };
  }
  return { ok: true, next: row.to };
}

export function initialState(id: string): CandidateStateRecord {
  return {
    id,
    version: 0,
    state: 'UNINITIALIZED',
    baseReserveUsd: 0,
    volume1hUsd: 0,
    score: 0,
    updatedAt: Date.now(),
  };
}

/**
 * Optimistic-locking backend. `cas` writes `next` atomically ONLY if the stored
 * version still equals `expectedVersion`; returns true on success, false on a
 * concurrent collision. Redis uses WATCH/MULTI/EXEC; in-memory uses a write
 * counter to detect the same races. TTL is applied at write time.
 */
export interface CandidateBackend {
  read(key: string): Promise<CandidateStateRecord | null>;
  cas(key: string, expectedVersion: number, next: CandidateStateRecord, ttlMs: number): Promise<boolean>;
  evict(key: string): Promise<void>;
  /** Best-effort connectivity/armed report for probes. */
  probe?(): Promise<{ armed: boolean; ok: boolean; detail: string }>;
}

/** In-memory optimistic-locking backend — the default / test / local transport. */
export class InMemoryCandidateBackend implements CandidateBackend {
  private records = new Map<string, CandidateStateRecord>();
  /** Monotonic per-key write counter used to emulate WATCH/MULTI collisions. */
  private writeSeq = new Map<string, number>();
  private readonly now: () => number;

  constructor(now?: () => number) {
    this.now = now ?? (() => Date.now());
  }

  public async probe(): Promise<{ armed: boolean; ok: boolean; detail: string }> {
    return { armed: false, ok: false, detail: 'in-memory candidate backend (no Redis)' };
  }

  async read(key: string): Promise<CandidateStateRecord | null> {
    return this.records.get(key) ?? null;
  }

  async cas(key: string, expectedVersion: number, next: CandidateStateRecord, ttlMs: number): Promise<boolean> {
    const existing = this.records.get(key);
    if (existing && existing.version !== expectedVersion) return false; // collision
    if (!existing && expectedVersion !== 0) return false; // deleted concurrently
    this.records.set(key, { ...next, version: next.version, updatedAt: next.updatedAt });
    this.writeSeq.set(key, (this.writeSeq.get(key) ?? 0) + 1);
    // TTL: schedule eviction in the background (in-memory best-effort).
    if (ttlMs > 0 && ttlMs !== Infinity) {
      setTimeout(() => {
        const cur = this.records.get(key);
        if (cur && cur.version === next.version) this.records.delete(key);
      }, ttlMs);
    }
    return true;
  }

  async evict(key: string): Promise<void> {
    this.records.delete(key);
    this.writeSeq.set(key, (this.writeSeq.get(key) ?? 0) + 1);
  }
}

/**
 * Redis optimistic-locking backend. Authoritative for cross-process atomicity
 * (WATCH/MULTI/EXEC, 900s EX TTL) when a URL is configured; on transport error
 * falls back to an in-memory mirror (fail-open) rather than throwing.
 */
export class RedisCandidateBackend implements CandidateBackend {
  private mirror = new InMemoryCandidateBackend();
  private readonly url: string | null;
  private client: any = null;

  constructor(url?: string) {
    this.url =
      url ??
      process.env.REDIS_URL ??
      process.env.REDIS_URI ??
      process.env.REDIS_CONNECTION_STRING ??
      null;
  }

  public redisArmed(): boolean {
    return Boolean(this.url);
  }

  public async probe(): Promise<{ armed: boolean; ok: boolean; detail: string }> {
    if (!this.url) return { armed: false, ok: false, detail: 'no Redis URL — in-memory mirror only' };
    try {
      const c = await this.ensureClient();
      const pong = await c.ping();
      return { armed: true, ok: pong === 'PONG', detail: `ping=${String(pong)}` };
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      return { armed: true, ok: false, detail: msg };
    }
  }

  async read(key: string): Promise<CandidateStateRecord | null> {
    if (!this.url) return this.mirror.read(key);
    try {
      const c = await this.ensureClient();
      const raw = await c.get(key);
      if (!raw) return null;
      return JSON.parse(raw as string) as CandidateStateRecord;
    } catch {
      return this.mirror.read(key);
    }
  }

  async cas(key: string, expectedVersion: number, next: CandidateStateRecord, ttlMs: number): Promise<boolean> {
    if (!this.url || ttlMs <= 0) return this.mirror.cas(key, expectedVersion, next, ttlMs);
    try {
      const c = await this.ensureClient();
      for (let attempt = 0; attempt < 3; attempt += 1) {
        await c.watch(key);
        const raw: string | null = await c.get(key);
        const current: CandidateStateRecord | null = raw ? (JSON.parse(raw) as CandidateStateRecord) : null;
        const currentVersion = current ? current.version : 0;
        if (currentVersion !== expectedVersion) {
          await c.unwatch();
          return false; // collision — caller retries with a fresh read
        }
        const multi = c.multi();
        multi.set(key, JSON.stringify(next), 'EX', Math.floor(ttlMs / 1000));
        const result = await multi.exec();
        if (result !== null) return true; // CAS succeeded
        // WATCH conflict — retry with backoff
        await new Promise((r) => setTimeout(r, Math.random() * 20));
      }
      return false;
    } catch {
      // Fail-open: Redis transport error → in-memory mirror (never a throw).
      return this.mirror.cas(key, expectedVersion, next, ttlMs);
    }
  }

  async evict(key: string): Promise<void> {
    if (!this.url) { await this.mirror.evict(key); return; }
    try {
      const c = await this.ensureClient();
      await c.del(key);
      await this.mirror.evict(key);
    } catch {
      await this.mirror.evict(key);
    }
  }

  private async ensureClient(): Promise<any> {
    if (this.client) return this.client;
    if (!this.url) throw new Error('REDIS_URL not configured');
    const { Redis } = await import('ioredis');
    this.client = new Redis(this.url, { maxRetriesPerRequest: 1, connectTimeout: 3000 });
    return this.client;
  }
}

export interface CandidateTransitionOptions {
  /** Field-level mutation applied to the current record before writing the next version. */
  mutation?: (current: CandidateStateRecord) => Partial<CandidateStateRecord>;
  /** Extra context for matrix conditions. */
  context?: Partial<TransitionContext>;
  /** Max optimistic-lock retries. */
  maxRetries?: number;
}

export interface CandidateTransitionOutcome {
  ok: boolean;
  record?: CandidateStateRecord;
  reason?: string;
}

/**
 * The atomic state reducer: validates the causal transition, applies the
 * mutation, then persists via optimistic locking (version bump + TTL). Collisions
 * are retried with a fresh read. Returns a structured outcome — never throws.
 */
export class CandidateStateStore {
  constructor(
    private readonly backend: CandidateBackend,
    private readonly now: () => number = () => Date.now(),
  ) {}

  public async get(id: string): Promise<CandidateStateRecord | null> {
    return this.backend.read(candidateKey(id));
  }

  /** Best-effort backend arming probe (fail-open, mirrors the pg/redis probes). */
  public async probe(): Promise<{ armed: boolean; ok: boolean; detail: string }> {
    if (!this.backend.probe) return { armed: false, ok: false, detail: 'probe N/A' };
    return this.backend.probe();
  }

  public async transition(
    id: string,
    event: CandidateEvent,
    opts: CandidateTransitionOptions = {},
  ): Promise<CandidateTransitionOutcome> {
    const key = candidateKey(id);
    const maxRetries = opts.maxRetries ?? 3;
    for (let attempt = 0; attempt < maxRetries; attempt += 1) {
      const current = await this.backend.read(key);
      if (!current) {
        // Allocate a record on first touch (UNINITIALIZED → DISCOVERED / PENDING_DISCOVERY).
        if (event === 'DISCOVERY_EVENT' || event === 'ENRICHMENT_UPDATE' || event === 'DROP' || event === 'TTL_EXPIRED') {
          const fresh = initialState(id);
          const prospective = { ...fresh, ...opts.mutation?.(fresh) };
          const check = evaluateCausalTransition(fresh.state, event, this.ctx(prospective, opts));
          if (!check.ok) return { ok: false, reason: check.reason };
          const next: CandidateStateRecord = {
            ...prospective,
            state: check.next!,
            version: fresh.version + 1,
            updatedAt: this.now(),
          };
          const written = await this.backend.cas(key, 0, next, CANDIDATE_TTL_MS);
          if (written) return { ok: true, record: next };
          continue; // collision on the empty slot — retry
        }
        return { ok: false, reason: `no candidate '${id}' for event '${event}'` };
      }

      // Conditions must see the PROSPECTIVE (post-mutation) record — a mutation
      // that sets `score` is what the ML gate evaluates, not the stale current.
      const prospective = { ...current, ...opts.mutation?.(current) };
      const check = evaluateCausalTransition(current.state, event, this.ctx(prospective, opts));
      if (!check.ok) return { ok: false, reason: check.reason };

      const next: CandidateStateRecord = {
        ...prospective,
        state: check.next!,
        version: current.version + 1,
        updatedAt: this.now(),
      };
      const written = await this.backend.cas(key, current.version, next, CANDIDATE_TTL_MS);
      if (written) return { ok: true, record: next };
      // Optimistic collision — back off and re-read.
      await new Promise((r) => setTimeout(r, Math.random() * 20));
    }
    return { ok: false, reason: 'optimistic-lock contention exceeded max retries' };
  }

  public async evict(id: string): Promise<void> {
    await this.backend.evict(candidateKey(id));
  }

  private ctx(record: CandidateStateRecord, opts: CandidateTransitionOptions): TransitionContext {
    return {
      baseReserveUsd: record.baseReserveUsd,
      volume1hUsd: record.volume1hUsd,
      score: record.score,
      ...opts.context,
    };
  }
}

/** Process-wide candidate store. In-memory unless a Redis URL is configured. */
export function createCandidateStateStore(): CandidateStateStore {
  const url = process.env.REDIS_URL || process.env.REDIS_URI || process.env.REDIS_CONNECTION_STRING;
  const backend = url ? new RedisCandidateBackend(url) : new InMemoryCandidateBackend();
  return new CandidateStateStore(backend);
}

export const globalCandidateStateStore: CandidateStateStore = createCandidateStateStore();
