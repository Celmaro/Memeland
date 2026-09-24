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
import { TtlCache } from '../cache/ttl-cache.js';

export const DEXSCREENER_DEFAULT_BASE = 'https://api.dexscreener.com';
export const DEXSCREENER_PROFILES_PATH = '/token-profiles/latest/v1';
// Token-lookup endpoint returns real market fields (priceUsd, liquidityUsd,
// volume24hUsd, fdv) for a known address — the same address the profile listed.
export const DEXSCREENER_TOKEN_PATH = '/latest/dex/tokens';

type FetchLike = (url: string) => Promise<Pick<Response, 'ok' | 'json'>>;

interface RawProfile {
  url?: string;
  chainId?: string;
  tokenAddress?: string;
  symbol?: string;
}

/**
 * DexScreener pair object returned by /latest/dex/tokens/{address} — carries the
 * market fields the profile listing lacks. One pair per listed pair on a chain.
 */
interface RawPair {
  chainId?: string;
  pairAddress?: string;
  dexId?: string;
  baseToken?: { address?: string; symbol?: string; name?: string };
  priceUsd?: string;
  liquidity?: { usd?: number };
  volume?: { h24?: number };
  fdv?: number;
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
  private readonly supportedChainIds: Set<number>;
  private readonly cache: TtlCache<MarketToken[]>;

    constructor(opts: DexScreenerFeedOptions = {}) {
    const f = opts.fetch ?? ((globalThis as { fetch?: FetchLike }).fetch as FetchLike);
    this.fetch = f;
    this.baseUrl = opts.baseUrl ?? DEXSCREENER_DEFAULT_BASE;
    this.ttlMs = opts.ttlMs ?? 60_000;
    this.cache = new TtlCache<MarketToken[]>({ ttlMs: this.ttlMs });
    this.supportedChainIds = new Set(
      // Resolve each supported name to its canonical id; unknown names are dropped.
      (opts.supportedChains ?? ['robinhood', 'bsc', 'base', 'solana', 'eth'])
        .map((c) => chainIdFor(c))
        .filter((id): id is number => id !== undefined)
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
    const cached = this.cache.get(key);
    if (cached) return cached;
    const tokens = await this.fetchProfiles();
    // I0-2: enrich listed addresses with real market fields (price/liquidity/
    // volume/fdv) via /latest/dex/tokens — profiles alone carry none, so every
    // candidate hit the prefilter with volume1hUsd=0 and died at the floor.
    const enriched = await this.enrichProfiles(tokens);
    this.cache.set(key, enriched);
    return enriched;
  }

  /**
   * Batch-enrich discovered addresses with market data. The /latest/dex/tokens
   * endpoint accepts up to 30 comma-separated addresses per call and returns
   * the pair list with price/liquidity/volume/fdv. Fail-soft: a batch that fails
   * leaves that slice with its zero fields (the prefilter then rejects them),
   * never throws and never drops the whole discovery pass.
   */
  private async enrichProfiles(profiles: MarketToken[]): Promise<MarketToken[]> {
    if (profiles.length === 0) return profiles;
    const out: MarketToken[] = [...profiles];
    const byAddress = new Map<string, number>();
    profiles.forEach((p, i) => byAddress.set(p.address.toLowerCase(), i));
    const addresses = [...byAddress.keys()];
    const BATCH = 30;
    for (let s = 0; s < addresses.length; s += BATCH) {
      const slice = addresses.slice(s, s + BATCH);
      try {
        const url = `${this.baseUrl}${DEXSCREENER_TOKEN_PATH}/${slice.join(',')}`;
        const res = await this.fetch(url);
        if (!res.ok) {
          // I1-4: transport failure — mark this batch's tokens sourceUnavailable
          // so the prefilter sees "feed down", not "these tokens have no volume".
          this.markBatchUnavailable(out, slice, byAddress);
          continue;
        }
        const body = (await res.json()) as { pairs?: RawPair[] };
        const pairs = Array.isArray(body?.pairs) ? body.pairs : [];
        // Track which slice addresses were actually enriched; the rest stay
        // zero AND unavailable (the provider had no data for them this cycle).
        const enriched = new Set<string>();
        for (const p of pairs) {
          const addr = (p.baseToken?.address ?? '').toLowerCase();
          const idx = byAddress.get(addr);
          if (idx === undefined) continue;
          const chainId = chainIdFor(p.chainId);
          if (chainId === undefined) continue;
          enriched.add(addr);
          // Pick the reported pair's best fields (already provider-ranked).
          out[idx] = {
            ...out[idx]!,
            chainId,
            priceUsd: Number(p.priceUsd) || 0,
            liquidityUsd: p.liquidity?.usd || 0,
            volume24hUsd: p.volume?.h24 || 0,
            fdvUsd: p.fdv || 0,
            pairAddress: p.pairAddress,
            dex: p.dexId,
            sourceUnavailable: undefined, // got real data
          };
        }
        for (const addr of slice) {
          if (!enriched.has(addr)) {
            const idx = byAddress.get(addr);
            if (idx !== undefined) out[idx] = { ...out[idx]!, sourceUnavailable: true };
          }
        }
      } catch {
        // I1-4: exception — mark the whole batch unavailable, never a real zero.
        this.markBatchUnavailable(out, slice, byAddress);
      }
    }
    return out;
  }

  private markBatchUnavailable(out: MarketToken[], slice: string[], byAddress: Map<string, number>): void {
    for (const addr of slice) {
      const idx = byAddress.get(addr);
      if (idx !== undefined) out[idx] = { ...out[idx]!, sourceUnavailable: true };
    }
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
    // Fix (I0-2 review): compare against the CANONICAL chain-id, not the raw
    // DexScreener chainId string. chainIdFor('ethereum')→1, chainIdFor('base')→8453,
    // but supportedChains held raw names ('bsc','base','solana','robinhood') — so
    // 'ethereum' candidates (and often RH) were silently DROPPED. Now we test the
    // resolved id against the supported set by chain-id.
    if (chainId === undefined) return undefined;
    if (!this.supportedChainIds.has(chainId)) return undefined;
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
