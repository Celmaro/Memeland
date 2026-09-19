/**
 * Q06 - Keyless DexScreener multi-chain feed (SRC-222 dexscraper, SRC-025 docs).
 * Zero-API-key REST client over the public DexScreener endpoints, behind a TTL
 * cache and a small provider interface so GMGN is interchangeable. Normalizes
 * listed pairs for RH/BSC/Base/Solana; unknown chains are dropped. Fetch is
 * injectable for tests.
 */

import {
  chainIdFor,
  type MarketDataProvider,
  type MarketDiscoveryOptions,
  type MarketToken,
} from './market-data-provider.js';

export const DEXSCREENER_DEFAULT_BASE = 'https://api.dexscreener.com';
export const DEXSCREENER_PROFILES_PATH = '/token-profiles/latest/v1';

type FetchLike = (url: string) => Promise<Pick<Response, 'ok' | 'json'>>;

interface RawProfile {
  url?: string;
  chainId?: string;
  tokenAddress?: string;
  symbol?: string;
}

export interface DexScreenerFeedOptions {
  fetch?: FetchLike;
  baseUrl?: string;
  /** TTL for the in-memory discovery cache in ms. Default 60s. */
  ttlMs?: number;
  /** Supported chain names (mapped via CHAIN_NAME_TO_ID). */
  supportedChains?: string[];
}

export class DexScreenerFeed implements MarketDataProvider {
  readonly id = 'dexscreener';
  private readonly fetch: FetchLike;
  private readonly baseUrl: string;
  private readonly ttlMs: number;
  private readonly supportedChains: Set<string>;
  private cache = new Map<string, { at: number; data: MarketToken[] }>();

  constructor(opts: DexScreenerFeedOptions = {}) {
    const f = opts.fetch ?? ((globalThis as { fetch?: FetchLike }).fetch as FetchLike);
    this.fetch = f;
    this.baseUrl = opts.baseUrl ?? DEXSCREENER_DEFAULT_BASE;
    this.ttlMs = opts.ttlMs ?? 60_000;
    this.supportedChains = new Set(
      (opts.supportedChains ?? ['robinhood', 'bsc', 'base', 'solana']).map((c) => c.toLowerCase())
    );
  }

  async discover(options: MarketDiscoveryOptions = {}): Promise<MarketToken[]> {
    // Cache the base (all supported chains) set; options are applied after
    // retrieval so the cache stays correct across differing filters.
    const base = await this.baseTokens();
    return this.applyOptions(base, options);
  }

  private async baseTokens(): Promise<MarketToken[]> {
    const key = 'base';
    const hit = this.cache.get(key);
    if (hit && Date.now() - hit.at <= this.ttlMs) return hit.data;
    const tokens = await this.fetchProfiles();
    this.cache.set(key, { at: Date.now(), data: tokens });
    return tokens;
  }

  private async fetchProfiles(): Promise<MarketToken[]> {
    const res = await this.fetch(this.baseUrl + DEXSCREENER_PROFILES_PATH);
    if (!res.ok) throw new Error('dexscreener profile fetch failed');
    const body = (await res.json()) as { tokenProfiles?: RawProfile[] };
    const profiles = Array.isArray(body?.tokenProfiles) ? body.tokenProfiles : [];
    const tokens: MarketToken[] = [];
    for (const p of profiles) {
      const t = this.normalizeProfile(p);
      if (t) tokens.push(t);
    }
    return tokens;
  }

  private normalizeProfile(p: RawProfile): MarketToken | undefined {
    const chainId = chainIdFor(p.chainId);
    if (chainId === undefined || !this.supportedChains.has(String(p.chainId).toLowerCase())) return undefined;
    if (!p.tokenAddress || !p.symbol) return undefined;
    return {
      address: p.tokenAddress,
      chainId,
      symbol: p.symbol,
      priceUsd: 0,
      liquidityUsd: 0,
      volume24hUsd: 0,
    };
  }

  private applyOptions(tokens: MarketToken[], options: MarketDiscoveryOptions): MarketToken[] {
    let out = tokens;
    if (options.chainIds?.length) {
      const wanted = new Set(options.chainIds);
      out = out.filter((t) => wanted.has(t.chainId));
    }
    const minLiquidity = options.minLiquidityUsd ?? 0;
    if (minLiquidity > 0) out = out.filter((t) => t.liquidityUsd >= minLiquidity);
    const sort = options.sort;
    if (sort) out = [...out].sort((a, b) => (b[sort] ?? 0) - (a[sort] ?? 0));
    if (typeof options.limit === 'number' && options.limit > 0) out = out.slice(0, options.limit);
    return out;
  }
}
