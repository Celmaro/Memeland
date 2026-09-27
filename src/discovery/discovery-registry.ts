/**
 * P3.1 — Candidate Registry (ae395c §3, ad0e47 Phase 1).
 *
 * The durable per-candidate record: which provider FIRST saw each token, at
 * what time, the per-source discovery latency vs the on-chain first sighting,
 * and a lifecycle. This is the "measure, don't hand-pick" layer — after 2-4
 * weeks of observations the primary/secondary discovery providers are chosen
 * by measured latency + coverage, never by docs.
 */

export type DiscoverySource = 'rpc' | 'dexpaprika' | 'gecko' | 'dexscreener' | 'gmgn' | 'routescan' | 'ankr' | 'cmc' | 'birdeye';

export type CandidateLifecycle = 'fresh' | 'enriching' | 'revalidated' | 'eligible' | 'dead';

export interface CandidateRecord {
  /** `${chain}:${tokenAddress.toLowerCase()}` */
  id: string;
  chain: string;
  tokenAddress: string;
  /** First-seen epoch ms per discovery source (first sighting wins). */
  firstSeen: Partial<Record<DiscoverySource, number>>;
  /** Discovery latency ms per source vs the earliest sighting (0 = first). */
  latencyMs: Partial<Record<DiscoverySource, number>>;
  /** The source that saw this candidate first. */
  firstSource: DiscoverySource | null;
  lifecycle: CandidateLifecycle;
}

export interface DiscoveryObservation {
  chain: string;
  tokenAddress: string;
  source: DiscoverySource;
  at: number;
}

export class CandidateRegistry {
  private candidates = new Map<string, CandidateRecord>();

  private id(chain: string, tokenAddress: string): string {
    return `${chain}:${tokenAddress.toLowerCase()}`;
  }

  /** Record a provider sighting. First sighting per source wins; latency vs
   *  the earliest sighting is recomputed on each new source. */
  public observe(obs: DiscoveryObservation): CandidateRecord {
    const id = this.id(obs.chain, obs.tokenAddress);
    let c = this.candidates.get(id);
    if (!c) {
      c = { id, chain: obs.chain, tokenAddress: obs.tokenAddress, firstSeen: {}, latencyMs: {}, firstSource: null, lifecycle: 'fresh' };
      this.candidates.set(id, c);
    }
    const key = obs.source;
    const prev = c.firstSeen[key];
    if (prev === undefined || obs.at < prev) {
      c.firstSeen[key] = obs.at;
    }
    // Earliest sighting across all sources → firstSource + latency baseline.
    let earliest = Infinity;
    let firstSource: DiscoverySource | null = null;
    for (const [src, at] of Object.entries(c.firstSeen) as Array<[DiscoverySource, number]>) {
      if (at < earliest) { earliest = at; firstSource = src; }
    }
    c.firstSource = firstSource;
    for (const [src, at] of Object.entries(c.firstSeen) as Array<[DiscoverySource, number]>) {
      c.latencyMs[src] = Math.max(0, at - earliest);
    }
    return c;
  }

  public get(id: string): CandidateRecord | undefined {
    return this.candidates.get(id);
  }

  public markRevalidated(id: string): void {
    const c = this.candidates.get(id);
    if (c && c.lifecycle !== 'dead') c.lifecycle = 'eligible';
  }

  public markDead(id: string): void {
    const c = this.candidates.get(id);
    if (c) c.lifecycle = 'dead';
  }

  /** Empirical primary discovery source across all candidates (first-seen counts). */
  public primaryDiscoverySource(): { primary: DiscoverySource | null; bySource: Partial<Record<DiscoverySource, number>> } {
    const bySource: Partial<Record<DiscoverySource, number>> = {};
    for (const c of this.candidates.values()) {
      if (c.firstSource) bySource[c.firstSource] = (bySource[c.firstSource] ?? 0) + 1;
    }
    let primary: DiscoverySource | null = null;
    let max = 0;
    for (const [src, n] of Object.entries(bySource) as Array<[DiscoverySource, number]>) {
      if (n > max) { max = n; primary = src; }
    }
    return { primary, bySource };
  }

  public size(): number {
    return this.candidates.size;
  }
}

/** Process-wide singleton for the screening cycle. */
export const globalCandidateRegistry = new CandidateRegistry();
