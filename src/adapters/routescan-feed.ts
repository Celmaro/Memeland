/**
 * Routescan — free keyless multi-chain explorer API (Memeland 2.0 ingestion).
 *
 * Live-verified 2026-09-27: no API key required; the ONLY free source that
 * gives new-token discovery sorted by creation time across 30+ EVM chains
 * incl. Robinhood (4663), plus ranked holders and ERC-20 transfer history with
 * USD values.
 *
 *   GET /v2/network/mainnet/evm/{chainId}/erc20?sort=createdAt,desc
 *        (chainId 'all' aggregates every indexed chain)
 *   GET /v2/network/mainnet/evm/{chainId}/erc20/{address}/holders
 *   GET /v2/network/mainnet/evm/{chainId}/erc20-transfers?tokenAddress=...
 *
 * The erc20 list carries createOperation{timestamp,txHash}, price, marketCap,
 * holdersCount — so created_at-ordered discovery is the fresh-pair lane input
 * (freshLane=true: zero liquidity at birth by construction, prefilter uses the
 * fresh floor).
 */

import {
  chainIdFor,
  type MarketDataProvider,
  type MarketDiscoveryOptions,
  type MarketToken,
} from './market-data-provider.js';
import { TtlCache } from '../cache/ttl-cache.js';

export const ROUTESCAN_DEFAULT_BASE = 'https://api.routescan.io';

export type FetchLike = (url: string) => Promise<Pick<Response, 'ok' | 'json' | 'status'>>;

/** ERC-20 list row (routescan /v2/.../erc20). */
interface RawErc20Row {
  address?: string;
  name?: string;
  symbol?: string;
  decimals?: number;
  totalSupply?: string;
  price?: number | string;
  marketCap?: number | string;
  holdersCount?: number;
  createOperation?: { timestamp?: string; txHash?: string };
}

/** Ranked holder row (routescan /v2/.../erc20/{address}/holders). */
export interface TokenHolder {
  address: string;
  balance: string;
  percentage: number;
}

export interface RoutescanFeedOptions {
  fetch?: FetchLike;
  baseUrl?: string;
  /** TTL for the in-memory discovery cache in ms. Default 60s. */
  ttlMs?: number;
}

export class RoutescanFeed implements MarketDataProvider {
  readonly id = 'routescan';
  private readonly fetch: FetchLike;
  private readonly baseUrl: string;
  private readonly ttlMs: number;
  private readonly cache: TtlCache<MarketToken[]>;

  constructor(opts: RoutescanFeedOptions = {}) {
    const f = opts.fetch ?? ((globalThis as { fetch?: FetchLike }).fetch as FetchLike);
    this.fetch = f;
    this.baseUrl = opts.baseUrl ?? ROUTESCAN_DEFAULT_BASE;
    this.ttlMs = opts.ttlMs ?? 60_000;
    this.cache = new TtlCache<MarketToken[]>({ ttlMs: this.ttlMs });
  }

  async discover(options: MarketDiscoveryOptions = {}): Promise<MarketToken[]> {
    const base = await this.baseTokens(options);
    return this.applyOptions(base, options);
  }

  /**
   * Fetch newest ERC-20 tokens, sorted by creation time descending. When the
   * caller restricts to concrete chainIds, query each chain's endpoint so rows
   * carry a real chainId; otherwise use the cross-chain `/all` aggregate
   * (chainId=0 sentinel, attributed downstream by enrichment). One keyless call
   * per chain; covers eth/bsc/base/robinhood.
   */
  private async baseTokens(options: MarketDiscoveryOptions): Promise<MarketToken[]> {
    const wanted = (options.chainIds ?? []).filter((id) => id > 0);
    const key = wanted.length > 0 ? `base:${wanted.sort().join(',')}` : 'base';
    const cached = this.cache.get(key);
    if (cached) return cached;

    const chains = wanted.length > 0 ? wanted : [];
    const tokens: MarketToken[] = [];
    for (const chainId of chains.length > 0 ? chains : [0]) {
      const path = chainId > 0 ? String(chainId) : 'all';
      const url = `${this.baseUrl}/v2/network/mainnet/evm/${path}/erc20?sort=createdAt,desc&limit=100`;
      const res = await this.fetch(url);
      if (!res.ok) throw new Error(`routescan erc20 fetch failed (HTTP ${res.status})`);
      const body = (await res.json()) as { items?: RawErc20Row[] };
      const rows = Array.isArray(body?.items) ? body.items : [];
      for (const row of rows) {
        const t = this.normalizeRow(row, chainId > 0 ? chainId : undefined);
        if (t) tokens.push(t);
      }
    }
    this.cache.set(key, tokens);
    return tokens;
  }

  /** Ranked holders for a token on an EVM chain — whale/concentration checks. */
  public async fetchHolders(chainId: number, address: string, limit = 100): Promise<TokenHolder[]> {
    const url = `${this.baseUrl}/v2/network/mainnet/evm/${chainId}/erc20/${encodeURIComponent(address)}/holders?limit=${limit}`;
    const res = await this.fetch(url);
    if (!res.ok) return [];
    const body = (await res.json()) as { items?: Array<{ holderAddress?: string; balance?: string; percentage?: number | string }> };
    const rows = Array.isArray(body?.items) ? body.items : [];
    const out: TokenHolder[] = [];
    for (const r of rows) {
      if (!r.holderAddress) continue;
      out.push({ address: r.holderAddress, balance: String(r.balance ?? '0'), percentage: Number(r.percentage) || 0 });
    }
    return out;
  }

  private normalizeRow(row: RawErc20Row, chainId?: number): MarketToken | undefined {
    const address = row.address;
    if (!address) return undefined;
    const priceUsd = Number(row.price) || 0;
    const mcapUsd = Number(row.marketCap) || 0;
    return {
      address,
      chainId: chainId ?? 0, // 0 = cross-chain aggregate; per-chain attribution downstream
      symbol: row.symbol || address.slice(0, 6).toUpperCase(),
      ...(row.name ? { name: row.name } : {}),
      priceUsd,
      liquidityUsd: 0, // list rows carry no liquidity; enrichment fills it
      volume24hUsd: 0,
      mcapUsd: mcapUsd > 0 ? mcapUsd : undefined,
      freshLane: true, // created_at-ordered discovery = new tokens, zero market data at birth
    };
  }

  private applyOptions(tokens: MarketToken[], options: MarketDiscoveryOptions): MarketToken[] {
    let out = tokens;
    if (options.chainIds?.length) {
      const wanted = new Set(options.chainIds);
      // chainId=0 rows are cross-chain; keep them unless a concrete chain is
      // asked AND the row can't match — but Routescan aggregate rows are kept
      // for the fresh lane regardless (chain attribution downstream).
      out = out.filter((t) => t.chainId === 0 || wanted.has(t.chainId));
    }
    const minLiquidity = options.minLiquidityUsd ?? 0;
    if (minLiquidity > 0) out = out.filter((t) => t.liquidityUsd >= minLiquidity);
    if (typeof options.limit === 'number' && options.limit > 0) out = out.slice(0, options.limit);
    return out;
  }
}
