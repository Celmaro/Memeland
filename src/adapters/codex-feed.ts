/**
 * PR 7 — A15 Codex.io unified keyless GraphQL feed (Standalone #1).
 * Keyless public GraphQL endpoint normalized to the shared MarketToken shape,
 * behind a TTL cache so GMGN stays interchangeable. Deliberately NOT merged
 * with dexpaprika-feed.ts (different auth/schema/rate limits).
 */

import {
  chainIdFor,
  type MarketDataProvider,
  type MarketDiscoveryOptions,
  type MarketToken,
} from './market-data-provider.js';

export const CODEX_DEFAULT_ENDPOINT = 'https://api.codex.io/graphql';

type FetchLike = (url: string, init?: unknown) => Promise<Pick<Response, 'ok' | 'json'>>;

interface RawMarket {
  baseToken?: { address?: string; symbol?: string; name?: string };
  chainId?: string;
  priceUsd?: string;
  liquidityUsd?: string;
  volumeUsd?: string;
  fdvUsd?: string;
  pairAddress?: string;
}

export interface CodexFeedOptions {
  fetch?: FetchLike;
  endpoint?: string;
  /** TTL for the in-memory discovery cache in ms. Default 60s. */
  ttlMs?: number;
  supportedChains?: string[];
}

export class CodexFeed implements MarketDataProvider {
  readonly id = 'codex';
  private readonly fetch: FetchLike;
  private readonly endpoint: string;
  private readonly ttlMs: number;
  private readonly supportedChains: Set<string>;
  private cache = new Map<string, { at: number; data: MarketToken[] }>();

  constructor(opts: CodexFeedOptions = {}) {
    const f = opts.fetch ?? ((globalThis as { fetch?: FetchLike }).fetch as FetchLike);
    this.fetch = f;
    this.endpoint = opts.endpoint ?? CODEX_DEFAULT_ENDPOINT;
    this.ttlMs = opts.ttlMs ?? 60_000;
    this.supportedChains = new Set(
      (opts.supportedChains ?? ['robinhood', 'bsc', 'base', 'solana']).map((c) => c.toLowerCase())
    );
  }

  async discover(options: MarketDiscoveryOptions = {}): Promise<MarketToken[]> {
    const base = await this.baseTokens();
    return this.applyOptions(base, options);
  }

  private async baseTokens(): Promise<MarketToken[]> {
    const key = 'base';
    const hit = this.cache.get(key);
    if (hit && Date.now() - hit.at <= this.ttlMs) return hit.data;
    const tokens = await this.fetchMarkets();
    this.cache.set(key, { at: Date.now(), data: tokens });
    return tokens;
  }

  private async fetchMarkets(): Promise<MarketToken[]> {
    const query = `{ markets { baseToken { address symbol name } chainId priceUsd liquidityUsd volumeUsd fdvUsd pairAddress } }`;
    const res = await this.fetch(this.endpoint, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ query }),
    });
    if (!res.ok) throw new Error('codex feed fetch failed');
    const body = (await res.json()) as { data?: { markets?: RawMarket[] } };
    const markets = Array.isArray(body?.data?.markets) ? body.data.markets : [];
    const tokens: MarketToken[] = [];
    for (const m of markets) {
      const t = this.normalizeMarket(m);
      if (t) tokens.push(t);
    }
    return tokens;
  }

  private normalizeMarket(m: RawMarket): MarketToken | undefined {
    const chainId = chainIdFor(m.chainId);
    if (chainId === undefined || !this.supportedChains.has(String(m.chainId).toLowerCase())) return undefined;
    if (!m.baseToken?.address || !m.baseToken.symbol) return undefined;
    return {
      address: m.baseToken.address,
      chainId,
      symbol: m.baseToken.symbol,
      ...(m.baseToken.name ? { name: m.baseToken.name } : {}),
      priceUsd: this.num(m.priceUsd),
      liquidityUsd: this.num(m.liquidityUsd),
      volume24hUsd: this.num(m.volumeUsd),
      ...(m.fdvUsd !== undefined ? { fdvUsd: this.num(m.fdvUsd) } : {}),
      ...(m.pairAddress ? { pairAddress: m.pairAddress } : {}),
    };
  }

  private num(raw: string | undefined): number {
    const n = Number(raw);
    return Number.isFinite(n) ? n : 0;
  }

  private applyOptions(base: MarketToken[], options: MarketDiscoveryOptions): MarketToken[] {
    let out = base;
    if (options.chainIds && options.chainIds.length > 0) {
      out = out.filter((t) => options.chainIds!.includes(t.chainId));
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
}
