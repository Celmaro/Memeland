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

export type FetchLike = (url: string, init?: { headers?: Record<string, string> }) => Promise<Pick<Response, 'ok' | 'json' | 'status'>>;

/** ERC-20 list row (routescan /v2/.../erc20). */
interface RawErc20Row {
  chainId?: string;
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

export interface RoutescanFeedOptions {
  fetch?: FetchLike;
  baseUrl?: string;
  /** TTL for the in-memory discovery cache in ms. Default 60s. */
  ttlMs?: number;
  /** Registered Routescan API key (raises free 2RPS/10k-day → 5RPS/100k-day). */
  apiKey?: string;
}

/** Registered-tier key from env; keyless tier applies when absent. */
const apiKeyFromEnv = (): string | undefined =>
  process.env.ROUTESCAN_API_KEY?.trim() || undefined;

export class RoutescanFeed implements MarketDataProvider {
  readonly id = 'routescan';
  private readonly fetch: FetchLike;
  private readonly baseUrl: string;
  private readonly ttlMs: number;
  private readonly apiKey?: string;
  private readonly cache: TtlCache<MarketToken[]>;

  constructor(opts: RoutescanFeedOptions = {}) {
    const f = opts.fetch ?? ((globalThis as { fetch?: FetchLike }).fetch as FetchLike);
    this.fetch = f;
    this.baseUrl = opts.baseUrl ?? ROUTESCAN_DEFAULT_BASE;
    this.ttlMs = opts.ttlMs ?? 60_000;
    this.apiKey = opts.apiKey ?? apiKeyFromEnv();
    this.cache = new TtlCache<MarketToken[]>({ ttlMs: this.ttlMs });
  }

  /** `apikey` header when a registered key is set (keyless tier otherwise). */
  private auth(): { headers?: Record<string, string> } {
    return this.apiKey ? { headers: { apikey: this.apiKey } } : {};
  }

  async discover(options: MarketDiscoveryOptions = {}): Promise<MarketToken[]> {
    const base = await this.baseTokens(options);
    return this.applyOptions(base, options);
  }

  /**
   * Fetch the newest ERC-20 tokens via the cross-chain `/all` aggregate, sorted
   * by creation time descending. Each row carries a real `chainId`, so we
   * attribute per-chain downstream and filter by the caller's requested chains.
   *
   * 400-fix (live probe 2026-09-29): querying per-chain endpoints 400s on any
   * chain Routescan does NOT index (e.g. Robinhood 4663) — which killed the whole
   * feed whenever a concrete chainId set included one. The `/all` aggregate
   * works and returns per-row chainIds, so we ALWAYS use it and fail-soft on
   * unsupported chains (they're simply absent). One keyless call, no 400s.
   */
  private async baseTokens(options: MarketDiscoveryOptions): Promise<MarketToken[]> {
    const wanted = (options.chainIds ?? []).filter((id) => id > 0);
    const key = wanted.length > 0 ? `base:${wanted.sort().join(',')}` : 'base';
    const cached = this.cache.get(key);
    if (cached) return cached;

    const url = `${this.baseUrl}/v2/network/mainnet/evm/all/erc20?sort=createdAt,desc&limit=100`;
    const res = await this.fetch(url, this.auth());
    if (!res.ok) throw new Error(`routescan erc20 fetch failed (HTTP ${res.status})`);
    const body = (await res.json()) as { items?: RawErc20Row[] };
    const rows = Array.isArray(body?.items) ? body.items : [];
    const tokens: MarketToken[] = [];
    for (const row of rows) {
      const chainId = row.chainId ? Number(row.chainId) : undefined;
      if (wanted.length > 0 && (chainId === undefined || !wanted.includes(chainId))) continue;
      const t = this.normalizeRow(row, chainId);
      if (t) tokens.push(t);
    }
    this.cache.set(key, tokens);
    return tokens;
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
