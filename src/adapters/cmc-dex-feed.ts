/**
 * P4.1 — CMC keyless DEX stack (verified 2026-09-27: free at pro-api.coinmarketcap.com/public-api,
 * no key required). The classic trending/new/meme endpoints are PAID, but the
 * DEX family is free:
 *
 *   /v4/dex/spot-pairs/latest?network_id=...&sort=volume_24h&limit=...  (pool_created aux)
 *   /v1/dex/token/pools?platform=...&address=...                         (RH pools — no factory)
 *   /v1/dex/security/detail?platform=...&address=...                     (GoPlus honeypot 2nd opinion)
 *   /v1/dex/holders/count?platform=...&address=...                       (holder count incl. Solana)
 *   /v1/dex/tokens/transactions?platform=...&address=...                 (first-buy/swap history)
 *   /v1/dex/liquidity-change/list?platform=...&address=...               (LP add/remove = rug detection)
 *
 * Fills what nothing else free covers: RH pools (no PairCreated factory),
 * Solana holder counts (publicnode blocks indexed RPCs), and GoPlus-backed
 * security detail as a second opinion.
 */

import {
  chainIdFor,
  type MarketDataProvider,
  type MarketDiscoveryOptions,
  type MarketToken,
} from './market-data-provider.js';
import { TtlCache } from '../cache/ttl-cache.js';

export const CMC_PRO_BASE = 'https://pro-api.coinmarketcap.com';
export const CMC_PUBLIC_BASE = 'https://pro-api.coinmarketcap.com/public-api';

export type FetchLike = (url: string) => Promise<Pick<Response, 'ok' | 'json'>>;

/** Platform name ↔ our chain key. */
const PLATFORM_BY_CHAIN: Record<string, string> = {
  sol: 'solana',
  bsc: 'bsc',
  base: 'base',
  eth: 'ethereum',
  robinhood: 'robinhood',
};
const NETWORK_BY_CHAINID: Record<number, string> = {
  101: 'solana', 56: 'bsc', 8453: 'base', 1: 'ethereum', 4663: 'robinhood',
};

interface RawSpotPair {
  pool_id?: string;
  network_id?: string;
  base_asset?: { contract_address?: string; name?: string; symbol?: string };
  price?: number | string;
  liquidity?: number | string;
  volume_24h?: number | string;
  pool_created?: string;
}

export interface CmcDexFeedOptions {
  fetch?: FetchLike;
  baseUrl?: string;
  ttlMs?: number;
}

export class CmcDexFeed implements MarketDataProvider {
  readonly id = 'cmc-dex';
  private readonly fetch: FetchLike;
  private readonly baseUrl: string;
  private readonly ttlMs: number;
  private readonly cache: TtlCache<MarketToken[]>;

  constructor(opts: CmcDexFeedOptions = {}) {
    const f = opts.fetch ?? ((globalThis as { fetch?: FetchLike }).fetch as FetchLike);
    this.fetch = f;
    this.baseUrl = opts.baseUrl ?? CMC_PUBLIC_BASE;
    this.ttlMs = opts.ttlMs ?? 120_000;
    this.cache = new TtlCache<MarketToken[]>({ ttlMs: this.ttlMs });
  }

  async discover(options: MarketDiscoveryOptions = {}): Promise<MarketToken[]> {
    const wanted = (options.chainIds ?? []).filter((id) => id > 0);
    const key = wanted.length > 0 ? `base:${wanted.sort().join(',')}` : 'base';
    const cached = this.cache.get(key);
    if (cached) return cached;

    const out: MarketToken[] = [];
    for (const chainId of wanted.length > 0 ? wanted : [0]) {
      try {
        const network = chainId > 0 ? NETWORK_BY_CHAINID[chainId] : undefined;
        const qs = network ? `network_id=${encodeURIComponent(network)}&` : '';
        const url = `${this.baseUrl}/v4/dex/spot-pairs/latest?${qs}sort=volume_24h&sort_dir=desc&limit=50`;
        const res = await this.fetch(url);
        if (!res.ok) continue;
        const body = (await res.json()) as { data?: RawSpotPair[] };
        const rows = Array.isArray(body?.data) ? body.data : [];
        for (const row of rows) {
          const t = this.normalize(row, chainId);
          if (t) out.push(t);
        }
      } catch {
        // fail-soft: skip this chain
      }
    }
    this.cache.set(key, out);
    return out;
  }

  /** Holder count + top-10 concentration (works on Solana, free). */
  public async fetchHolders(platform: string, address: string): Promise<{ count: number; top10Percent: number } | null> {
    try {
      const url = `${this.baseUrl}/v1/dex/holders/count?platform=${encodeURIComponent(platform)}&address=${encodeURIComponent(address)}`;
      const res = await this.fetch(url);
      if (!res.ok) return null;
      const body = (await res.json()) as { data?: { holder_count?: number | string; distribution?: { top_10_percent?: number | string } } };
      const count = Number(body?.data?.holder_count);
      const top10 = Number(body?.data?.distribution?.top_10_percent);
      if (!Number.isFinite(count) || count <= 0) return null;
      return { count, top10Percent: Number.isFinite(top10) ? top10 : 0 };
    } catch {
      return null;
    }
  }

  private normalize(row: RawSpotPair, chainId: number): MarketToken | undefined {
    const addr = row.base_asset?.contract_address;
    if (!addr) return undefined;
    const network = row.network_id ?? NETWORK_BY_CHAINID[chainId];
    const cid = chainId > 0 ? chainId : (network ? chainIdFor(Object.keys(PLATFORM_BY_CHAIN).find((k) => PLATFORM_BY_CHAIN[k] === network) ?? network) : undefined);
    if (cid === undefined) return undefined;
    return {
      address: addr,
      chainId: cid,
      symbol: row.base_asset?.symbol || addr.slice(0, 6).toUpperCase(),
      ...(row.base_asset?.name ? { name: row.base_asset.name } : {}),
      priceUsd: Number(row.price) || 0,
      liquidityUsd: Number(row.liquidity) || 0,
      volume24hUsd: Number(row.volume_24h) || 0,
      freshLane: !!row.pool_created, // pool_created-ordered = fresh
      ...(row.pool_id ? { pairAddress: row.pool_id } : {}),
    };
  }
}
