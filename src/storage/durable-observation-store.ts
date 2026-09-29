/**
 * P2 — Postgres at the observation boundary (durable observation store).
 *
 * The discovery boundary (`discoverAll`) already emits a `DiscoveryObservation`
 * per (source × token) sighting and feeds `globalCandidateRegistry`. That map is
 * process-local: a restart loses the first-seen/latency/false-positive history
 * the registry exists to accumulate. P2 makes the observation boundary DURABLE:
 *
 *   - `ObservationStore` — the read/write contract (append + page queries).
 *   - `InMemoryObservationStore` — the DEFAULT backend; fully exercised by CI so
 *     the funnel never depends on a live DB being reachable. Fail-open by design.
 *   - `PostgresObservationStore` — the production backend, activated only when
 *     `DATABASE_URL` is present. Real, env-gated SQL; runs in cloud where Zeabur
 *     allowlists the deployment egress. Any transport failure degrades to the
 *     in-memory path (never blocks the funnel).
 *
 * Activation rule: no `DATABASE_URL` (tests, local dev) → in-memory. Present →
 * Postgres, TIERED so a transient DB failure keeps the pass moving and the
 * in-memory mirror survives for the current process.
 */

import type { DiscoveryObservation, DiscoverySource } from '../discovery/discovery-registry.js';

/** Persisted observation row — superset of the in-memory sighting for durable queries. */
export interface StoredObservation {
  chain: string;
  tokenAddress: string;
  source: DiscoverySource;
  at: number;
  costCredits?: number;
}

/** Read/write contract for the durable observation boundary. */
export interface ObservationStore {
  /** Append one sighting. Synchronous contract so the hot loop never awaits a DB. */
  append(obs: DiscoveryObservation): void;
  /** Count observations for a candidate since a cutoff (dedup / first-seen auditing). */
  countFor(chain: string, tokenAddress: string, since?: number): number;
  /** All distinct sources that saw a candidate (coverage audit). */
  sourcesFor(chain: string, tokenAddress: string): DiscoverySource[];
  /** Page over stored observations, newest-first. */
  recent(limit?: number): StoredObservation[];
  /**
   * Durable (Postgres) read path — serves cross-restart history that the
   * in-process mirror no longer holds. Backends without a durable store
   * (in-memory) return the current-process mirror instead. Fail-open: a DB
   * failure degrades to the mirror, never blocks or changes a decision.
   */
  recentDurable?(limit?: number): Promise<StoredObservation[]>;
  countDurable?(chain: string, tokenAddress: string, since?: number): Promise<number>;
  sourcesForDurable?(chain: string, tokenAddress: string): Promise<DiscoverySource[]>;
  /** Approximate durable row count (for a [DURABLE] telemetry line). */
  size(): number;
  /**
   * Best-effort durable row count directly from Postgres (returns null when the
   * store is not armed or the query fails). Used for [DURABLE] telemetry so the
   * operator can see observation rows actually landing in the DB, not just the
   * in-process mirror.
   */
  durableRowCount?(): Promise<number | null>;
  /** Best-effort startup connectivity probe (in-memory impls report armed=false). */
  probe?(): Promise<{ armed: boolean; ok: boolean; detail: string }>;
}

export class InMemoryObservationStore implements ObservationStore {
  private rows: StoredObservation[] = [];

  append(obs: DiscoveryObservation): void {
    this.rows.push({ ...obs });
  }

  countFor(chain: string, tokenAddress: string, since?: number): number {
    const addr = tokenAddress.toLowerCase();
    return this.rows.filter(
      (r) => r.chain === chain && r.tokenAddress.toLowerCase() === addr && (since === undefined || r.at >= since),
    ).length;
  }

  sourcesFor(chain: string, tokenAddress: string): DiscoverySource[] {
    const addr = tokenAddress.toLowerCase();
    const seen = new Set<DiscoverySource>();
    for (const r of this.rows) {
      if (r.chain === chain && r.tokenAddress.toLowerCase() === addr) seen.add(r.source);
    }
    return [...seen];
  }

  recent(limit = 100): StoredObservation[] {
    return this.rows.slice(-limit).reverse();
  }

  // P9 — no separate durable backend; the in-memory store IS the mirror, so the
  // dual-path reads resolve to the same rows. Kept for a uniform ObservationStore
  // contract even though there is no cross-restart history to serve.
  async recentDurable(limit = 100): Promise<StoredObservation[]> {
    return this.recent(limit);
  }
  async countDurable(chain: string, tokenAddress: string, since?: number): Promise<number> {
    return this.countFor(chain, tokenAddress, since);
  }
  async sourcesForDurable(chain: string, tokenAddress: string): Promise<DiscoverySource[]> {
    return this.sourcesFor(chain, tokenAddress);
  }

  size(): number {
    return this.rows.length;
  }
}

/**
 * Postgres-backed store. Activated only when DATABASE_URL is present; a live pool
 * is created lazily so a missing env var never throws at import time. All methods
 * are wired to a synchronous in-memory mirror as well — the Postgres write is
 * fire-and-forget (async, fail-open) so the observation loop is never serialized
 * on a DB round-trip. Queries that need durability (recent/count) prefer the mirror
 * for the current process and Postgres for cross-restart history.
 */
export class PostgresObservationStore implements ObservationStore {
  private mirror = new InMemoryObservationStore();
  private readonly url: string | null;
  private pool: any = null;
  private ready = false;

  constructor(url?: string) {
    // Resolution order: explicit URL arg > DATABASE_URL > Zeabur-injected
    // POSTGRES_URI / POSTGRES_CONNECTION_STRING. Zeabur does NOT set
    // DATABASE_URL; it provides POSTGRES_URI/POSTGRES_CONNECTION_STRING
    // pointing at the internal service hostname, which is reachable only from
    // inside the deployment.
    this.url =
      url ??
      process.env.DATABASE_URL ??
      process.env.POSTGRES_URI ??
      process.env.POSTGRES_CONNECTION_STRING ??
      null;
    if (!this.url) {
      console.warn('[DURABLE] PostgresObservationStore constructed without a Postgres URL — falling back to in-memory only.');
    }
  }

  append(obs: DiscoveryObservation): void {
    // Mirror always: the in-process source of truth for queries this pass.
    this.mirror.append(obs);
    if (this.url) {
      // Fire-and-forget durable write. Failure degrades silently to the mirror.
      void this.ensurePool()
        .then((pool) =>
          pool.query(
            `INSERT INTO discovery_observations (chain, token_address, source, at, cost_credits)
             VALUES ($1, $2, $3, $4, $5)
             ON CONFLICT DO NOTHING`,
            [obs.chain, obs.tokenAddress.toLowerCase(), obs.source, obs.at, obs.costCredits ?? 0],
          ),
        )
        .catch((err: unknown) => {
          if (this.isVerbose()) {
            console.warn(`[DURABLE] observation write skipped (fail-open): ${err instanceof Error ? err.message : String(err)}`);
          }
        });
    }
  }

  countFor(chain: string, tokenAddress: string, since?: number): number {
    return this.mirror.countFor(chain, tokenAddress, since);
  }

  sourcesFor(chain: string, tokenAddress: string): DiscoverySource[] {
    return this.mirror.sourcesFor(chain, tokenAddress);
  }

  recent(limit = 100): StoredObservation[] {
    return this.mirror.recent(limit);
  }

  size(): number {
    return this.mirror.size();
  }

  // P9 — durable read path. The mirror serves only the current process; these
  // query Postgres so cross-restart history is actually readable. Fail-open to
  // the mirror (never blocks, never changes a decision). When unarmed (no URL),
  // they resolve straight to the in-process mirror.
  public async recentDurable(limit = 100): Promise<StoredObservation[]> {
    if (!this.url) return this.mirror.recent(limit);
    try {
      const pool = await this.ensurePool();
      const res = await pool.query(
        `SELECT chain, token_address AS "tokenAddress", source, at, cost_credits AS "costCredits"
           FROM discovery_observations ORDER BY at DESC LIMIT $1`,
        [limit],
      );
      return (res.rows ?? []).map((r: any) => ({
        chain: r.chain,
        tokenAddress: r.tokenAddress,
        source: r.source as DiscoverySource,
        at: Number(r.at),
        costCredits: r.costCredits !== null && r.costCredits !== undefined ? Number(r.costCredits) : undefined,
      }));
    } catch {
      return this.mirror.recent(limit);
    }
  }

  public async countDurable(chain: string, tokenAddress: string, since?: number): Promise<number> {
    if (!this.url) return this.mirror.countFor(chain, tokenAddress, since);
    try {
      const pool = await this.ensurePool();
      const args: Array<string | number> = [chain, tokenAddress.toLowerCase()];
      let sql = 'SELECT COUNT(*) AS n FROM discovery_observations WHERE chain = $1 AND token_address = $2';
      if (since !== undefined) {
        args.push(since);
        sql += ' AND at >= $3';
      }
      const res = await pool.query(sql, args);
      return Number(res.rows[0]?.n ?? 0);
    } catch {
      return this.mirror.countFor(chain, tokenAddress, since);
    }
  }

  public async sourcesForDurable(chain: string, tokenAddress: string): Promise<DiscoverySource[]> {
    if (!this.url) return this.mirror.sourcesFor(chain, tokenAddress);
    try {
      const pool = await this.ensurePool();
      const res = await pool.query(
        'SELECT DISTINCT source FROM discovery_observations WHERE chain = $1 AND token_address = $2',
        [chain, tokenAddress.toLowerCase()],
      );
      return (res.rows ?? []).map((r: any) => r.source as DiscoverySource);
    } catch {
      return this.mirror.sourcesFor(chain, tokenAddress);
    }
  }

  /** Whether the durable (Postgres) path is armed for this process. */
  public durableArmed(): boolean {
    return Boolean(this.url);
  }

  /** Durable row count from Postgres; null when unarmed or the query fails. */
  public async durableRowCount(): Promise<number | null> {
    if (!this.url) return null;
    try {
      const pool = await this.ensurePool();
      const res = await pool.query('SELECT COUNT(*) AS n FROM discovery_observations');
      const n = Number(res.rows[0]?.n ?? 0);
      return Number.isFinite(n) ? n : null;
    } catch {
      return null;
    }
  }

  /**
   * Best-effort startup connectivity probe. Logs whether the Postgres path
   * armed and whether the pool/schema actually came up — used to confirm the
   * durable backend in cloud (Zeabur injects POSTGRES_URI). Never throws.
   */
  public async probe(): Promise<{ armed: boolean; ok: boolean; detail: string }> {
    if (!this.url) return { armed: false, ok: false, detail: 'no Postgres URL configured — in-memory fallback' };
    try {
      const pool = await this.ensurePool();
      await pool.query('SELECT 1');
      return { armed: true, ok: true, detail: 'connected; schema ensured' };
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      console.warn(`[DURABLE] Postgres probe failed (fail-open to mirror): ${msg}`);
      return { armed: true, ok: false, detail: msg };
    }
  }

  private async ensurePool(): Promise<any> {
    if (this.pool) return this.pool;
    if (!this.url) throw new Error('DATABASE_URL not configured');
    // Lazy dynamic import keeps `pg` out of the sync import graph (tree-shaking + cold start).
    const { default: pg } = await import('pg');
    this.pool = new pg.Pool({ connectionString: this.url, max: 5, idleTimeoutMillis: 30_000 });
    // P12 — apply versioned schema migrations (tracked in schema_migrations),
    // replacing the inline CREATE-IF-NOT-EXISTS blob. Fail-open: a migration
    // error is logged below and the in-memory mirror keeps serving the pass.
    const { runMigrations } = await import('./migration-runner.js');
    await runMigrations(this.pool);
    this.ready = true;
    return this.pool;
  }

  private isVerbose(): boolean {
    return process.env.DURABLE_VERBOSE === 'true';
  }
}

/**
 * Select the durable store for the process. No Postgres URL (DATABASE_URL or
 * Zeabur's POSTGRES_URI/POSTGRES_CONNECTION_STRING) → in-memory (tests, local
 * dev, and any deployment without Postgres). A URL present → Postgres, tiered
 * fail-open on the in-memory mirror.
 */
export function createObservationStore(): ObservationStore {
  if (process.env.DATABASE_URL || process.env.POSTGRES_URI || process.env.POSTGRES_CONNECTION_STRING) {
    return new PostgresObservationStore();
  }
  return new InMemoryObservationStore();
}

/** Process-wide durable observation sink used by the discovery boundary. */
export const globalObservationStore: ObservationStore = createObservationStore();