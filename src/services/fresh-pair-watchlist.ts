/**
 * #3 — Fresh-pair promotion watchlist.
 *
 * Fresh-lane pairs (ankr PairCreated / gecko new_pools) bypass the volume floor
 * because they are younger than the measurement window. This tracker remembers
 * them between cycles and reports when they have matured (volume/liquidity
 * accumulated) — so the operator can SEE fresh discoveries becoming eligible,
 * instead of fresh pairs silently sitting in the lane forever.
 *
 * In-memory per process (no new persistence): the 5-min cycle cadence means a
 * pair typically needs 1-3 cycles to accumulate data, which fits comfortably in
 * process memory. The dedup window already prevents re-firing.
 */

import type { GMGNRawToken } from '../adapters/gmgn-adapter.js';

export interface FreshPairState {
  address: string;
  chain: string;
  symbol: string;
  firstSeenAt: number;
  lastSeenAt: number;
  matured: boolean;
  maturedAt?: number;
  volume1hUsd?: number;
  liquidityUsd?: number;
}

const MATURE_VOLUME_USD = 25_000;
const MATURE_LIQUIDITY_USD = 10_000;
const MAX_ENTRIES = 2_000;
const MAX_AGE_MS = 48 * 60 * 60 * 1000; // forget after 48h

export class FreshPairWatchlist {
  private pairs = new Map<string, FreshPairState>();

  /** Register fresh-lane candidates from a pass; returns pairs that JUST matured. */
  track(candidates: GMGNRawToken[]): { matured: FreshPairState[]; active: number } {
    const now = Date.now();
    const matured: FreshPairState[] = [];
    for (const t of candidates) {
      if (t.freshLane !== true) continue;
      const key = `${t.chain}:${t.address.toLowerCase()}`;
      const prev = this.pairs.get(key);
      const state: FreshPairState = {
        address: t.address,
        chain: t.chain,
        symbol: t.symbol || (t.address.slice(0, 6) || 'TOKEN'),
        firstSeenAt: prev?.firstSeenAt ?? now,
        lastSeenAt: now,
        matured: prev?.matured ?? false,
        maturedAt: prev?.maturedAt,
        volume1hUsd: t.volume1hUsd ?? 0,
        liquidityUsd: t.liquidityUsd ?? 0,
      };
      if (!state.matured && ((state.volume1hUsd ?? 0) >= MATURE_VOLUME_USD || (state.liquidityUsd ?? 0) >= MATURE_LIQUIDITY_USD)) {
        state.matured = true;
        state.maturedAt = now;
        matured.push(state);
      }
      this.pairs.set(key, state);
    }
    // Forget stale entries and cap size (memory hygiene).
    for (const [key, p] of this.pairs) {
      if (now - p.lastSeenAt > MAX_AGE_MS) this.pairs.delete(key);
    }
    if (this.pairs.size > MAX_ENTRIES) {
      const oldest = [...this.pairs.entries()].sort((a, b) => a[1].lastSeenAt - b[1].lastSeenAt).slice(0, this.pairs.size - MAX_ENTRIES);
      for (const [k] of oldest) this.pairs.delete(k);
    }
    return { matured, active: this.pairs.size };
  }

  size(): number {
    return this.pairs.size;
  }
}

/** Process-wide singleton for the screening cycle. */
export const globalFreshPairWatchlist = new FreshPairWatchlist();