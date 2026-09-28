/**
 * P1.5 — DeFiLlama regime feed (provider-architecture v2: regime/enricher).
 *
 * Regime/CONTEXT, explicitly NOT a token-score voter (research report §2/§3).
 * Free, no auth, 31+ endpoints. Used to tell the screening engine whether the
 * DEX/chain environment is hot (its own "is now a meme season?" prior), cached
 * hourly so we never hammer the free API. Fail-soft: any error → a neutral
 * regime, so a DeFiLlama outage never blocks or biases screening.
 */

export interface RegimeSnapshot {
  /** Requested chain id (or undefined for aggregate). */
  chainId?: number;
  /** Total value locked USD across the chain (or all tracked chains). */
  tvlUsd: number;
  /** 24h DEX volume USD across the chain (or aggregate). */
  dexVolume24hUsd: number;
  /** Chain TVL change % (1 hlyd window, tolerant of `change` & `change_7d`). */
  change24hPct: number;
  /** Sample of top chains by TVL for context. */
  topChains: Array<{ name: string; tvlUsd: number }>;
  /** True when the provider was reachable; false on failure (neutral regime). */
  healthy: boolean;
  at: number;
}

export interface DeFiLlamaRegimeOptions {
  chainName?: string;
  fetch?: typeof fetch;
  baseUrl?: string;
}

export const DEFILLAMA_BASE = 'https://api.llama.fi';

const num = (v: unknown): number => (typeof v === 'number' && Number.isFinite(v) ? v : 0);

export class DeFiLlamaRegimeFeed {
  private readonly fetch: typeof fetch;
  private readonly baseUrl: string;
  /** Hourly cache so the free API is only hit ~24×/day. */
  private cache: { at: number; snapshot: RegimeSnapshot } | null = null;

  constructor(opts: DeFiLlamaRegimeOptions = {}) {
    this.fetch = opts.fetch ?? (globalThis.fetch as typeof fetch);
    this.baseUrl = (opts.baseUrl ?? DEFILLAMA_BASE).replace(/\/$/, '');
  }

  /** Regime snapshot, served from a 1-hour cache; fail-soft to a neutral regime. */
  public async regime(opts: DeFiLlamaRegimeOptions = {}): Promise<RegimeSnapshot> {
    const chainName = opts.chainName;
    const cacheKey = chainName ?? '__all__';
    if (this.cache && this.cache.at > Date.now() - 60 * 60 * 1000 && (this.cache.snapshot.chainId !== undefined || cacheKey === '__all__')) {
      return this.cache.snapshot;
    }

    const snapshot = await this.fetchSnapshot(chainName);
    this.cache = { at: Date.now(), snapshot };
    return snapshot;
  }

  private async fetchSnapshot(chainName?: string): Promise<RegimeSnapshot> {
    const at = Date.now();
    try {
      if (chainName) {
        const tvl = (await this.get(`/v2/chains`)) as Array<Record<string, unknown>>;
        const row = Array.isArray(tvl) ? tvl.find((c) => String(c?.name).toLowerCase() === chainName.toLowerCase()) : undefined;
        if (row) {
          return {
            tvlUsd: num(row.tvl),
            dexVolume24hUsd: 0,
            change24hPct: num(row.change_1d ?? row.change),
            topChains: [],
            healthy: true,
            at,
          };
        }
      }
      // Aggregate regime: top chains by TVL + TVL-weighted USD change.
      const tvlChains = (await this.get('/v2/chains')) as Array<Record<string, unknown>>;
      const topChains = (Array.isArray(tvlChains) ? tvlChains : [])
        .sort((a, b) => num(b.tvl) - num(a.tvl))
        .slice(0, 10)
        .map((c) => ({
          name: String(c.name),
          tvlUsd: num(c.tvl),
          change24hPct: num(c.change_1d ?? c.change),
        }));
      const totalTvl = topChains.reduce((s, c) => s + c.tvlUsd, 0);
      const change24hPct = totalTvl > 0
        ? topChains.reduce((s, c) => s + c.tvlUsd * c.change24hPct, 0) / totalTvl
        : 0;
      return {
        tvlUsd: totalTvl,
        dexVolume24hUsd: 0,
        change24hPct,
        topChains,
        healthy: true,
        at,
      };
    } catch {
      // Fail-soft: a neutral regime (healthy:false) so screening is unaffected.
      return { tvlUsd: 0, dexVolume24hUsd: 0, change24hPct: 0, topChains: [], healthy: false, at };
    }
  }

  private async get(path: string): Promise<unknown> {
    const res = await this.fetch(`${this.baseUrl}${path}`);
    if (!res.ok) throw new Error(`defillama ${path} HTTP ${res.status}`);
    return res.json();
  }
}