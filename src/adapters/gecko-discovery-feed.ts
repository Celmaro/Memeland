/**
 * GeckoTerminal discovery feed (SRC-153 — keyless, 30/min budget, no API key).
 *
 * Covers all five Memeland chains (solana/bsc/base/eth/robinhood) with two
 * discovery endpoints that are the exact rank/trenches analog:
 *   - /networks/{network}/new_pools     -> freshest pools (discovery tier)
 *   - /networks/{network}/trending_pools -> pools climbing in volume (trending tier)
 *
 * Deliberately keyless and dependency-free: plain fetch, TTL cache, no SDK.
 * The 30/min budget is respected with a per-instance min-interval pacing
 * (default 2s) so a 5-chain pass never blows the shared budget.
 *
 * Normalizes pool rows into the shared `MarketToken` shape (address/chainId/
 * price/liquidity/volume24h/fdv). Symbol comes from the pool name (base side,
 * e.g. "PEPE / WETH" -> "PEPE"); the screening agent re-derives the canonical
 * symbol via GMGN enrichment when available.
 */

import {
  chainIdFor,
  type MarketDataProvider,
  type MarketDiscoveryOptions,
  type MarketToken,
} from './market-data-provider.js';
import { TtlCache } from '../cache/ttl-cache.js';
import { geckoNetworkIdFor } from '../agents/shared/ml-predictor.js';

export const GECKOTERMINAL_DEFAULT_BASE = 'https://api.geckoterminal.com/api/v2';
/** Pacing — 30/min public budget shared across all chains. 2s default = <=30/min. */
export const GECKO_DEFAULT_MIN_INTERVAL_MS = 2_000;

type FetchLike = (url: string, init?: unknown) => Promise<Pick<Response, 'ok' | 'json' | 'status'>>;

interface GeckoPoolRow {
  id?: string;
  attributes?: {
    address?: string;
    name?: string;
    base_token_price_usd?: string;
    quote_token_price_usd?: string;
    reserve_in_usd?: string;
    volume_usd?: string;
    fdv_usd?: string;
    price_change_percentage_h24?: string;
  };
  relationships?: {
    base_token?: { data?: { id?: string } };
  };
}

export interface GeckoDiscoveryFeedOptions {
  fetch?: FetchLike;
  baseUrl?: string;
  /** TTL for the in-memory discovery cache in ms. Default 60s. */
  ttlMs?: number;
  /** Min ms between two HTTP calls (pacing the shared 30/min budget). Default 2000. */
  minIntervalMs?: number;
  /** Per-endpoint limit. Default 50. */
  limit?: number;
  now?: () => number;
}

export class GeckoDiscoveryFeed implements MarketDataProvider {
  readonly id = 'gecko';
  private readonly fetch: FetchLike;
  private readonly baseUrl: string;
  private readonly ttlMs: number;
  private readonly minIntervalMs: number;
  private readonly limit: number;
  private readonly now: () => number;
  /** Per-chain + endpoint cache so new_pools and trending_pools stay distinct. */
  private readonly newPoolsCache: TtlCache<MarketToken[]>;
  private readonly trendingCache: TtlCache<MarketToken[]>;
  private lastRequestAt = 0;

  constructor(opts: GeckoDiscoveryFeedOptions = {}) {
    const f = opts.fetch ?? ((globalThis as { fetch?: FetchLike }).fetch as FetchLike);
    this.fetch = f;
    this.baseUrl = opts.baseUrl ?? GECKOTERMINAL_DEFAULT_BASE;
    this.ttlMs = opts.ttlMs ?? 60_000;
    this.minIntervalMs = opts.minIntervalMs ?? GECKO_DEFAULT_MIN_INTERVAL_MS;
    this.limit = opts.limit ?? 50;
    this.now = opts.now ?? Date.now;
    this.newPoolsCache = new TtlCache<MarketToken[]>({ ttlMs: this.ttlMs, now: this.now });
    this.trendingCache = new TtlCache<MarketToken[]>({ ttlMs: this.ttlMs, now: this.now });
  }

  async discover(options: MarketDiscoveryOptions = {}): Promise<MarketToken[]> {
    // GeckoDiscovery merges the two discovery surfaces the operator asked for:
    // fresh pools (new_pools) + rising pools (trending_pools). Dedupe by address,
    // then apply the standard options (chain filter, min liquidity, sort, limit).
    // NOTE: freshPools/trendingPools run SEQUENTIALLY (not Promise.all) — they
    // share one pacing guard, and concurrent loops both read lastRequestAt at
    // the same instant, compute the same wait, and fire together — collapsing
    // the 2s pacing and tripping Gecko's 30/min budget (observed live: HTTP 429
    // on trending_pools). Serializing restores the real 2s-apart cadence.
    const fresh = await this.freshPools();
    const trending = await this.trendingPools();
    const byAddress = new Map<string, MarketToken>();
    for (const t of [...fresh, ...trending]) byAddress.set(`${t.chainId}:${t.address.toLowerCase()}`, t);
    let out = [...byAddress.values()];
    if (options.chainIds && options.chainIds.length > 0) {
      const wanted = new Set(options.chainIds);
      out = out.filter((t) => wanted.has(t.chainId));
    }
    if (options.minLiquidityUsd !== undefined) {
      out = out.filter((t) => t.liquidityUsd >= options.minLiquidityUsd!);
    }
    if (options.sort) {
      out = [...out].sort((a, b) => (b[options.sort!] ?? 0) - (a[options.sort!] ?? 0));
    }
    if (options.limit !== undefined && options.limit > 0) out = out.slice(0, options.limit);
    return out;
  }

  /** Fresh (new) pools — ALL networks in ONE call (item 3: 5 calls → 1). */
  private async freshPools(): Promise<MarketToken[]> {
    const key = 'new:all';
    const cached = this.newPoolsCache.get(key);
    if (cached) return cached;
    const tokens = await this.fetchNetworkPools('new_pools');
    this.newPoolsCache.set(key, tokens);
    return tokens;
  }

  /** Trending pools — ALL networks in ONE call (item 3: 5 calls → 1). */
  private async trendingPools(): Promise<MarketToken[]> {
    const key = 'trending:all';
    const cached = this.trendingCache.get(key);
    if (cached) return cached;
    const tokens = await this.fetchNetworkPools('trending_pools');
    this.trendingCache.set(key, tokens);
    return tokens;
  }

  // Item 3: fetch ALL supported networks in a single call. Gecko row ids are
  // "network:0xADDR" — the network prefix maps back to our chain, so one
  // request per kind yields every chain's pools. This cuts the 5-chain×2-kind
  // fan-out (10 calls) to 2 calls, keeping well under the 30/min budget and
  // removing the burst that 429'd trending_pools.
  private async fetchNetworkPools(kind: 'new_pools' | 'trending_pools'): Promise<MarketToken[]> {
    const url = `${this.baseUrl}/networks/${kind}?limit=${this.limit}`;
    const tokens = await this.pacedGetPoolRows(url);
    // Filter to our supported chains only (the all-networks endpoint includes
    // chains we don't trade — 30% of rows are noise otherwise).
    const supported = new Set(['solana', 'bsc', 'base', 'eth', 'robinhood']);
    return tokens.filter((t) => supported.has(t.dex ?? ''));
  }

  private async pacedGetPoolRows(url: string): Promise<MarketToken[]> {
    // Pace to the shared 30/min budget: sleep until minIntervalMs has elapsed
    // since the last request, then fetch. Fail-open (empty) on any error.
    const wait = Math.max(0, this.lastRequestAt + this.minIntervalMs - this.now());
    if (wait > 0) await new Promise((r) => setTimeout(r, wait));
    this.lastRequestAt = this.now();
    try {
      const res = await this.fetch(url, {
        headers: { Accept: 'application/json;version=20230203' },
      });
      if (!res.ok) {
        console.warn(`[GECKO FEED] ${kindLabel(url)} fetch failed (HTTP ${res.status}) — skipped`);
        return [];
      }
      const body = (await res.json()) as { data?: GeckoPoolRow[] };
      const rows = Array.isArray(body?.data) ? body.data : [];
      const tokens: MarketToken[] = [];
      for (const row of rows) {
        const t = this.normalizePool(row);
        if (t) tokens.push(t);
      }
      return tokens;
    } catch (err: any) {
      console.warn(`[GECKO FEED] ${kindLabel(url)} failed (skipped): ${err.message}`);
      return [];
    }
  }

  private normalizePool(row: GeckoPoolRow): MarketToken | undefined {
    const attrs = row?.attributes;
    if (!attrs?.address) return undefined;
    const baseTokenId = row?.relationships?.base_token?.data?.id;
    // id looks like "base:0xADDR" (EVM) or "solana:ADDR" (non-EVM). The FIRST
    // segment is the Gecko network name → our chainId (item 3: all-networks
    // rows carry their own network, no per-chain fetch needed).
    let address = attrs.address;
    let chainId: number | undefined;
    if (baseTokenId) {
      const parts = String(baseTokenId).split(':');
      if (parts.length >= 2) {
        address = parts.slice(1).join(':');
        const network = parts[0]!.toLowerCase();
        chainId = chainIdFor(network === 'ethereum' ? 'eth' : network);
      }
    }
    if (!address || chainId === undefined) return undefined;
    const name = attrs.name || '';
    const symbol = name.split('/')[0]?.trim() || '???';
    const num = (v: string | undefined): number => {
      const n = Number(v);
      return Number.isFinite(n) ? n : 0;
    };
    return {
      address,
      chainId,
      symbol,
      name: name || undefined,
      priceUsd: num(attrs.base_token_price_usd) || num(attrs.quote_token_price_usd) || 0,
      liquidityUsd: num(attrs.reserve_in_usd),
      volume24hUsd: num(attrs.volume_usd),
      fdvUsd: num(attrs.fdv_usd) || undefined,
      dex: baseTokenId?.split(':')[0]?.toLowerCase(), // network prefix (chain filter)
      ...(attrs.price_change_percentage_h24 ? { change24hPct: num(attrs.price_change_percentage_h24) } : {}),
    };
  }
}

function kindLabel(url: string): string {
  return url.includes('trending_pools') ? 'trending_pools' : 'new_pools';
}