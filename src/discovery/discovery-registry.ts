/**
 * P3.1 — Candidate Registry (ae395c §3, ad0e47 Phase 1).
 *
 * The durable per-candidate record: which provider FIRST saw each token, at
 * what time, the per-source discovery latency vs the on-chain first sighting,
 * and a lifecycle. This is the "measure, don't hand-pick" layer — after 2-4
 * weeks of observations the primary/secondary discovery providers are chosen
 * by measured latency + coverage, never by docs.
 */

export type DiscoverySource =
  | 'rpc'
  | 'dexpaprika'
  | 'gecko'
  | 'dexscreener'
  | 'gmgn'
  | 'routescan'
  | 'ankr'
  | 'cmc'
  | 'birdeye'
  | 'fomo'
  | 'pons'
  | 'solanatracker'
  | 'pumpdev'
  | 'solana-rpc'
  // P5: per-pass dynamic emitters and the WS tape also feed the funnel.
  | 'tape'
  | 'track'
  | 'ws-tape';

/**
 * DISCOVERY_INTRODUCERS allowlist gate. When the env var is set it is a
 * comma-separated list of active introducers (coarse names like `dexpaprika`
 * OR provider-architecture style `solana-rpc-sol` / `ankr-eth`); a source is
 * enabled if it equals a token or matches a `<source>-*` token (so `solana-rpc-sol`
 * enables `solana-rpc`). Unset → every enabled feed participates (back-compat).
 */
export function isIntroducerEnabled(source: string, list?: string): boolean {
  if (!list) return true;
  const tokens = list.split(',').map((s) => s.trim().toLowerCase()).filter(Boolean);
  if (tokens.length === 0) return true;
  return tokens.some((tok) => tok === source || tok.startsWith(`${source}-`));
}

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
  /** Optional discovery credit/call cost for this sighting (for spend metrics). */
  costCredits?: number;
  /**
   * P10 — source-reported event time (ms epoch) when the provider timestamps the
   * token (e.g. GMGN `creationTimestamp`). `at` stays the LOCAL ingest time so
   * first-seen/latency can distinguish provider freshness (this field) from the
   * polling-schedule artifact (the local snapshot time).
   */
  providerEventTime?: number;
  /**
   * P4 — DEX pair/pool identity retained at the observation boundary so market
   * evidence can be attributed to a SPECIFIC pool rather than the token alone
   * (token vs pool separation). Populated from `GMGNRawToken.pairAddress` /
   * `.dex`, which keyless feeds (ankr/dexscreener/dexpaprika/cmc) already carry.
   */
  poolAddress?: string;
  dexId?: string;
}

/** Registry-level aggregate metrics (coverage / dup-rate / spend / first-seen). */
export interface DiscoveryStats {
  totalCandidates: number;
  /** Candidates where each source was the FIRST sighting (empirical primary). */
  firstSeenBySource: Partial<Record<DiscoverySource, number>>;
  /** Distinct candidates each source surfaced at least once (coverage). */
  coverage: Partial<Record<DiscoverySource, number>>;
  /** Per-source duplicate rate 0..1 : share of sightings that were repeats. */
  dupRate: Partial<Record<DiscoverySource, number>>;
  /** Cumulative discovery credits/calls spent per source (costCredits). */
  spend: Partial<Record<DiscoverySource, number>>;
  /** Candidates later marked dead whose firstSource was this source. */
  falsePositive: Partial<Record<DiscoverySource, number>>;
  /** 6.3 — source-health availability: ok/total probes and a rolling 0..1 score. */
  availability: Partial<Record<DiscoverySource, { ok: number; total: number; score: number }>>;
}

export class CandidateRegistry {
  private candidates = new Map<string, CandidateRecord>();
  /** Distinct candidates each source surfaced at least once (coverage). */
  private coverage = new Map<DiscoverySource, number>();
  /** Total sightings per source (repeats + firsts, for dup-rate). */
  private sightings = new Map<DiscoverySource, number>();
  /** Cumulative discovery credits/calls spent per source. */
  private spendBySource = new Map<DiscoverySource, number>();
  /** Candidates marked dead whose firstSource was this source. */
  private fpBySource = new Map<DiscoverySource, number>();
  /** 6.3 — rolling availability probes per source (ok/total). */
  private availability = new Map<DiscoverySource, { ok: number; total: number }>();

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
    if (prev === undefined) {
      // First this source has seen this candidate → counts toward coverage.
      this.coverage.set(key, (this.coverage.get(key) ?? 0) + 1);
    }
    this.sightings.set(key, (this.sightings.get(key) ?? 0) + 1);
    if (obs.costCredits && obs.costCredits > 0) {
      this.spendBySource.set(key, (this.spendBySource.get(key) ?? 0) + obs.costCredits);
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
    if (!c || c.lifecycle === 'dead') return;
    c.lifecycle = 'dead';
    // False positive is attributed to whatever listed it first — the empirical
    // signal for demoting an introducer whose fresh candidates die on arrival.
    if (c.firstSource) {
      this.fpBySource.set(c.firstSource, (this.fpBySource.get(c.firstSource) ?? 0) + 1);
    }
  }

  /** Registry-level metrics for the [DISCOVERY STATS] line & introducer tuning. */
  public stats(): DiscoveryStats {
    const firstSeenBySource: Partial<Record<DiscoverySource, number>> = {};
    const totalCandidates = this.candidates.size;
    for (const c of this.candidates.values()) {
      if (c.firstSource) firstSeenBySource[c.firstSource] = (firstSeenBySource[c.firstSource] ?? 0) + 1;
    }
    const sources = new Set<DiscoverySource>([
      ...this.coverage.keys(), ...this.sightings.keys(), ...this.spendBySource.keys(),
      ...this.fpBySource.keys(), ...this.availability.keys(), ...Object.keys(firstSeenBySource) as DiscoverySource[],
    ]);
    const coverage: Partial<Record<DiscoverySource, number>> = {};
    const dupRate: Partial<Record<DiscoverySource, number>> = {};
    const spend: Partial<Record<DiscoverySource, number>> = {};
    const falsePositive: Partial<Record<DiscoverySource, number>> = {};
    const availability: Partial<Record<DiscoverySource, { ok: number; total: number; score: number }>> = {};
    for (const src of sources) {
      const cov = this.coverage.get(src) ?? 0;
      const sig = this.sightings.get(src) ?? 0;
      coverage[src] = cov;
      dupRate[src] = sig > 0 ? (sig - cov) / sig : 0;
      spend[src] = this.spendBySource.get(src) ?? 0;
      falsePositive[src] = this.fpBySource.get(src) ?? 0;
      const a = this.availability.get(src);
      availability[src] = a
        ? { ok: a.ok, total: a.total, score: a.total > 0 ? a.ok / a.total : 0 }
        : { ok: 0, total: 0, score: 0 };
    }
    return { totalCandidates, firstSeenBySource, coverage, dupRate, spend, falsePositive, availability };
  }

  /**
   * 6.3 — record one source-health probe. `ok=true` for an endpoint that
   * responded, false for a failure/degradation. Rolls into the availability score
   * so promote/demote is robust to "source was down this week," not only
   * "source was first-seen early."
   */
  public recordAvailability(source: DiscoverySource, ok: boolean): void {
    const a = this.availability.get(source) ?? { ok: 0, total: 0 };
    a.total += 1;
    if (ok) a.ok += 1;
    this.availability.set(source, a);
  }

  /** 6.3 — rolling availability score 0..1 for a source, or null when no probes yet. */
  public availabilityOf(source: DiscoverySource): number | null {
    const a = this.availability.get(source);
    if (!a || a.total === 0) return null;
    return a.ok / a.total;
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
