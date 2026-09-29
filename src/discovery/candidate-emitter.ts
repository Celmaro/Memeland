/**
 * DiscoveryCoordinator (provider-architecture v3 — Phase 3).
 *
 * The plan's P0: stop `RobinhoodScreeningAgent` from knowing how every provider
 * works. DiscoveryCoordinator owns the funnel mechanics that used to live
 * inline in the agent:
 *
 *   - a named set of `CandidateEmitter`s (source → discover(chain)),
 *   - running them in a fixed PRIORITY order (keyless-DEX first, indexers
 *     last) and merging by address — later source overwrites earlier, with the
 *     fresh-pair lane surviving any overwrite,
 *   - per-source fail-soft (an emitter throwing returns empty; its cooldown is
 *     registered so it degrades silently, not blocking the funnel).
 *
 * The agent constructs the coordinator with its feeds and calls ONE method —
 * `discoverAll(chain): GMGNRawToken[]` — instead of 11 `collectXxxCandidates`
 * calls plus an inline dedupe merge.
 */

import type { Chain, GMGNRawToken } from '../adapters/gmgn-adapter.js';
import { globalSourceQuota, classifyHttpFailure, statusOf } from '../services/source-quota.js';
import type { DiscoveryObservation } from './discovery-registry.js';

/** A discovery source that yields normalized candidate tokens for a chain. */
export interface CandidateEmitter {
  /** Source name — must match a DiscoverySource tag on GMGNRawToken.source. */
  id: string;
  /**
   * Canonical source name when this emitter promotes under a different
   * DISCOVERY_INTRODUCERS id than its own `id` (e.g. the WS tape's pump.fun
   * mints promote under the solana-rpc introducer). Informational — the
   * allowlist gate itself lives inside discover(), not the coordinator.
   */
  allowlistSource?: string;
  /** Env gate: is this source permitted to produce candidates at all? */
  enabled(): boolean;
  /** Produce candidates for a chain. Must be fail-soft. */
  discover(chain: Chain): Promise<GMGNRawToken[]>;
}

/**
 * Honor-roll order for candidate introduction. Lower index = higher prefilter
 * priority (keyless budgets first, indexers last). This is the single source
 * of truth for "who feeds the funnel first" — replacing the inline array.
 */
export const DISCOVERY_PRIORITY = [
  'dexpaprika',
  'gecko',
  'dexscreener',
  'tape',
  'track',
  'ankr',
  'routescan',
  'cmc',
  'solana-rpc',
  'ws-tape',
  'solanatracker',
  'fomo',
] as const;

export interface DiscoveryCoordinatorOptions {
  now?: () => number;
}

export interface DiscoverAllOptions {
  /**
   * Externally-collected candidate lists keyed by source id (e.g. tape/track,
   * which need per-pass dynamic state). Inserted at their priority slot; these
   * sources were never allowlist/cooldown gated, so they bypass those gates.
   */
  extras?: Partial<Record<(typeof DISCOVERY_PRIORITY)[number], GMGNRawToken[]>>;
  /** GMGN overlay rows — upgrade EXISTING addresses only (enrichment). */
  overlay?: GMGNRawToken[];
  /** Clock for observation timestamps (determinism in tests). Defaults to Date.now. */
  observeAt?: () => number;
}

/**
 * P5 — discovery output carries BOTH the merged candidates and the raw
 * per-source observations captured BEFORE the merge. The merged list is what
 * the decision needs; the observations are the evidence the decision consumes —
 * "how many tokens did Gecko find?", "which source saw it first, and how much
 * later?" — which is answerable only if per-source sightings survive.
 */
export interface DiscoverAllResult {
  /** Merged candidate list (Phase 3 merge semantics unchanged). */
  candidates: GMGNRawToken[];
  /** One observation per (source × token) sighting, in priority order. */
  observations: DiscoveryObservation[];
}

export class DiscoveryCoordinator {
  private readonly emitters = new Map<string, CandidateEmitter>();
  private readonly now: () => number;

  constructor(opts: DiscoveryCoordinatorOptions = {}) {
    this.now = opts.now ?? (() => Date.now());
  }

  /** Register a named emitter (idempotent by id). */
  public add(emitter: CandidateEmitter): this {
    this.emitters.set(emitter.id, emitter);
    return this;
  }

  public has(id: string): boolean {
    return this.emitters.has(id);
  }

  public ids(): string[] {
    return [...this.emitters.keys()];
  }

  /**
   * Run all registered emitters in discovery priority, then merge by address
   * (later source overwrites, freshLane survives). Per-source gates (enable /
   * DISCOVERY_INTRODUCERS allowlist / cooldown) live inside each emitter's
   * discover() — the coordinator does NOT re-apply them, so a spied/mocked
   * emitter (as in tests) flows exactly as its method returns. GMGN overlay
   * rows that were never surfaced by an introducer are dropped here (GMGN is
   * enrichment, not discovery).
   *
   * P5 — alongside the merged candidates, ONE DiscoveryObservation is emitted
   * per (source × token) BEFORE the merge, so per-source coverage, first-seen
   * and latency stay answerable. Observation source is the emitter id (or its
   * allowlistSource), NOT the token's normalized `source` tag (tape rows are
   * tagged `dexscreener` internally).
   */
  public async discoverAll(chain: Chain, opts: DiscoverAllOptions = {}): Promise<DiscoverAllResult> {
    const merged = new Map<string, GMGNRawToken>();
    const observations: DiscoveryObservation[] = [];
    const observeAt = opts.observeAt ?? (() => Date.now());

    for (const id of DISCOVERY_PRIORITY) {
      const extra = opts.extras?.[id];
      const emitter = this.emitters.get(id);
      let tokens: GMGNRawToken[] | undefined;
      if (extra) {
        tokens = extra; // externally collected, already gated (tape/track)
      } else if (emitter) {
        if (!emitter.enabled()) continue;
        try {
          tokens = await emitter.discover(chain);
        } catch (err: unknown) {
          const cls = classifyHttpFailure(statusOf(err), err);
          if (globalSourceQuota.backoff(emitter.id, cls, this.now())) {
            console.warn(`[DISCOVERY] ${emitter.id} failed (skipped) [${cls}]: ${err instanceof Error ? err.message : String(err)}`);
          }
          continue;
        }
      } else {
        continue;
      }
      // P5 — snapshot the sighting time per source so first-seen/latency are honest.
      const at = observeAt();
      const obsSource = emitter?.allowlistSource ?? id;
      for (const t of tokens ?? []) {
        if (!t || !t.address) continue;
        const key = t.address.toLowerCase();
        const prev = merged.get(key);
        const fresh = prev?.freshLane || t.freshLane ? true : undefined;
        merged.set(key, fresh ? { ...t, freshLane: true } : t);
        observations.push({ chain, tokenAddress: t.address, source: obsSource as DiscoveryObservation['source'], at });
      }
    }

    // GMGN overlay: upgrade EXISTING addresses only; preserve who FOUND it.
    for (const g of opts.overlay ?? []) {
      const key = g.address?.toLowerCase();
      if (!key) continue;
      const existing = merged.get(key);
      if (!existing) continue;
      const fresh = existing.freshLane || g.freshLane ? true : undefined;
      merged.set(key, { ...g, freshLane: fresh ? true : undefined, discoveredBy: existing.source });
    }

    return { candidates: [...merged.values()], observations };
  }
}