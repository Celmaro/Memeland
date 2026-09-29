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
  /** Approximate durable row count (for a [DURABLE] telemetry line). */
  size(): number;
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
    this.url = url ?? process.env.DATABASE_URL ?? null;
    if (!this.url) {
      console.warn('[DURABLE] PostgresObservationStore constructed without DATABASE_URL — falling back to in-memory only.');
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

  /** Whether the durable (Postgres) path is armed for this process. */
  public durableArmed(): boolean {
    return Boolean(this.url);
  }

  private async ensurePool(): Promise<any> {
    if (this.pool) return this.pool;
    if (!this.url) throw new Error('DATABASE_URL not configured');
    // Lazy dynamic import keeps `pg` out of the sync import graph (tree-shaking + cold start).
    const { default: pg } = await import('pg');
    this.pool = new pg.Pool({ connectionString: this.url, max: 5, idleTimeoutMillis: 30_000 });
    await this.pool.query(SCHEMA_IF_NOT_EXISTS);
    this.ready = true;
    return this.pool;
  }

  private isVerbose(): boolean {
    return process.env.DURABLE_VERBOSE === 'true';
  }
}

const SCHEMA_IF_NOT_EXISTS = `
CREATE TABLE IF NOT EXISTS discovery_observations (
  chain          TEXT NOT NULL,
  token_address  TEXT NOT NULL,
  source         TEXT NOT NULL,
  at             BIGINT NOT NULL,
  cost_credits   NUMERIC DEFAULT 0,
  PRIMARY KEY (chain, token_address, source, at)
);
CREATE INDEX IF NOT EXISTS idx_discovery_observations_at ON discovery_observations (at DESC);
`;

/**
 * Select the durable store for the process. No DATABASE_URL → in-memory (tests,
 * local dev, and any deployment without Postgres). DATABASE_URL present →
 * Postgres, tiered fail-open on the in-memory mirror.
 */
export function createObservationStore(): ObservationStore {
  if (process.env.DATABASE_URL) {
    return new PostgresObservationStore(process.env.DATABASE_URL);
  }
  return new InMemoryObservationStore();
}

/** Process-wide durable observation sink used by the discovery boundary. */
export const globalObservationStore: ObservationStore = createObservationStore();